import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import {
  defaultAnswerStyle,
  getWriterPrompt,
} from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';
import configManager from '@/lib/config';
import { withRole } from '@/lib/models/base/instrumented';
import { setCurrent } from './researcher/progress';

/* Per mode, because the modes ask for answers of genuinely different lengths
 * and one ceiling cannot fit them. The writer prompt tells quality mode its
 * answer "SHALL NOT BE LESS THAN AT LEAST 2000 WORDS" -- roughly 2,700 tokens
 * -- so a flat cap tuned for speed mode would truncate every quality answer
 * mid-sentence.
 *
 * Tightened from a flat 8,192 once thinking was disabled for this role. That
 * ceiling was generous because a reasoning model spends part of its budget
 * thinking before it answers, so a tight cap turned a slow answer into no
 * answer; with thinking off the whole budget is answer.
 *
 * Note what a cap can and cannot do. It truncates; it does not make a model
 * concise. It bounds the worst case -- the first run without thinking spent the
 * reclaimed budget on a 2,568-character answer rather than finishing sooner --
 * but a genuinely shorter answer has to come from the prompt. Each value sits
 * well above what that mode has been observed to produce, so normal output is
 * never cut. */
const WRITER_MAX_TOKENS: Record<'brief' | 'standard' | 'deep', number> = {
  /* Keyed on answer style rather than mode, because style is what decides how
   * long the answer is: a quality-mode run asked for a brief answer should not
   * carry an 8,192-token ceiling. Each value sits well above what that style
   * has been observed to produce, so normal output is never cut -- a cap
   * truncates, it does not make a model concise. */
  brief: 1024,
  standard: 3072,
  /* The deep prompt asks for a research report, ~2,000 words. */
  deep: 8192,
};

/* A quantised model can collapse into emitting one character forever. Observed
 * on 2026-10-21: 26,407 '?' characters streamed over 54 minutes, stored as the
 * answer. The idle timeout cannot catch it because tokens keep arriving, and
 * grammar-constrained calls fail loudly while free text like this does not. */
const MAX_REPEATED_CHARS = 300;

/* The trailing run of one repeated character in `text`, and whether the whole
 * chunk is that character -- which is what decides if a run carries over from
 * the previous chunk. */
export const trailingRun = (text: string) => {
  const char = text[text.length - 1];
  let run = 0;

  while (run < text.length && text[text.length - 1 - run] === char) run++;

  return { char, run, wholeChunk: run === text.length };
};

class SearchAgent {
  /**
   * Runs a search, and records a failure as a failure.
   *
   * Without this the row keeps the 'answering' it was given at the start, so a
   * run that died looks eternally in progress: the tab spins forever and
   * /api/reconnect keeps trying to resume a session that is gone. Seen on
   * 2026-10-21 when the model backend dropped a connection — only the browser
   * knew, and only until it was reloaded.
   *
   * A thin wrapper rather than a try block around the body, to keep the diff
   * off every line of it; upstream #1093 does the same thing by re-indenting.
   */
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    try {
      await this.run(session, input);
    } catch (err) {
      await this.markFailed(input);
      throw err;
    }
  }

  /* Partial results are kept deliberately: a run that failed at the writer may
   * still have gathered every source, and throwing that away makes the failure
   * worse than it was. */
  private async markFailed(input: SearchAgentInput) {
    try {
      await db
        .update(messages)
        .set({ status: 'error' })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    } catch (err) {
      console.error('Failed to record search failure:', err);
    }
  }

  private async run(session: SessionManager, input: SearchAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
        provider: input.config.chatModel?.provider,
        model: input.config.chatModel?.model,
        mode: input.config.mode,
        answerStyle: input.config.answerStyle ?? defaultAnswerStyle(input.config.mode),
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
          // A re-run may use a different model, or different settings, than
          // the original attempt.
          provider: input.config.chatModel?.provider,
          model: input.config.chatModel?.model,
          mode: input.config.mode,
          answerStyle:
            input.config.answerStyle ?? defaultAnswerStyle(input.config.mode),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    /* Created here rather than inside the researcher so the status line covers
     * the classifier too -- on a local model that call alone can run 30s, and
     * until now the UI could only say "Brainstorming...". */
    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
        progress: {
          startedAt: new Date().toISOString(),
          mode: input.config.mode,
          iteration: 0,
          maxIterations: 0,
          phase: 'planning',
          current: 'Working out what to search for',
          currentSince: new Date().toISOString(),
          scrape: {
            inFlight: 0,
            completed: 0,
            failed: 0,
            chunksDone: 0,
            chunksTotal: 0,
            chunksFailed: 0,
          },
        },
      },
    });

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
        researchBlockId,
        /* Same key the model registry reads when it wraps the chat model; read
         * here too rather than importing it through the telemetry module,
         * which everything else imports. */
        callContext: {
          messageId: input.messageId,
          chatId: input.chatId,
          captureText:
            configManager.getConfig('debug.captureLlmText', false) === true,
        },
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      finalContext = searchResults?.searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n');
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const answerStyle =
      input.config.answerStyle ?? defaultAnswerStyle(input.config.mode);

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
      answerStyle,
    );

    /* Kept so the answer can be rewritten at another length later without
     * repeating the research, which is the expensive part: the writer is
     * 25-80s against minutes of searching and extracting. */
    await db
      .update(messages)
      .set({ writerContext: finalContextWithWidgets })
      .where(eq(messages.messageId, input.messageId))
      .execute();

    setCurrent(session, researchBlockId, 'writing', 'Writing the answer');

    const answerStream = withRole(
      input.config.llm,
      'writer',
      `${input.config.mode}/${answerStyle}`,
    ).streamText({
      /* The writer composes from facts the extractor already pulled out, so
       * what it needs is citation discipline, not deliberation -- and thinking
       * costs it roughly double the wall time. The roles that actually choose
       * something, the classifier and the orchestrator, keep theirs. */
      options: {
        maxTokens: WRITER_MAX_TOKENS[answerStyle],
        disableThinking: true,
      },
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    let repeatRun = 0;
    let lastChar = '';
    let degenerated = false;

    for await (const chunk of answerStream) {
      const text = chunk.contentChunk ?? '';

      if (text) {
        const { char, run, wholeChunk } = trailingRun(text);

        repeatRun = wholeChunk && char === lastChar ? repeatRun + run : run;
        lastChar = char;

        if (repeatRun >= MAX_REPEATED_CHARS) {
          console.error(
            `Writer degenerated: ${repeatRun} repetitions of ${JSON.stringify(lastChar)}; stopping.`,
          );
          degenerated = true;
          break;
        }
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    setCurrent(session, researchBlockId, 'done', undefined);

    if (degenerated) {
      const block = session.getBlock(responseBlockId) as TextBlock | null;

      if (block) {
        block.data +=
          '\n\n_The model began repeating itself, so the answer was stopped here._';

        session.updateBlock(block.id, [
          { op: 'replace', path: '/data', value: block.data },
        ]);
      }
    }

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
