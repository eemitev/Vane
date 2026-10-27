import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import ModelRegistry from '@/lib/models/registry';
import { withRole } from '@/lib/models/base/instrumented';
import {
  AnswerStyle,
  defaultAnswerStyle,
  getWriterPrompt,
} from '@/lib/prompts/search/writer';
import configManager from '@/lib/config';
import { TextBlock } from '@/lib/types';
import z from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* Same ceilings as a first-pass answer: the style decides the length, not
 * whether this is a rewrite. */
const MAX_TOKENS: Record<AnswerStyle, number> = {
  brief: 1024,
  standard: 3072,
  deep: 8192,
};

const bodySchema = z.object({
  messageId: z.string(),
  answerStyle: z.enum(['brief', 'standard', 'deep']),
  chatModel: z.object({ providerId: z.string(), key: z.string() }),
});

/**
 * Rewrites an existing answer at a different length.
 *
 * Re-runs only the writer, against the context stored when the answer was
 * first produced. The research -- searching, scraping, extracting -- is what
 * costs minutes; the writer is 25-80s. Rewriting therefore reuses the same
 * sources and the same citations rather than retrieving anything new.
 */
export const POST = async (req: Request) => {
  try {
    const body = bodySchema.parse(await req.json());

    const [row] = await db
      .select()
      .from(messages)
      .where(eq(messages.messageId, body.messageId))
      .limit(1);

    if (!row) {
      return Response.json({ message: 'Message not found' }, { status: 404 });
    }

    /* Answers written before writerContext existed cannot be rewritten: the
     * material is gone. Say so rather than silently producing an answer from
     * nothing. */
    if (!row.writerContext) {
      return Response.json(
        {
          message:
            'This answer was produced before rewriting was available, so its sources were not kept. Ask the question again to rewrite it.',
        },
        { status: 409 },
      );
    }

    const registry = new ModelRegistry();
    const llm = await registry.loadChatModel(
      body.chatModel.providerId,
      body.chatModel.key,
      { messageId: body.messageId, chatId: row.chatId },
    );

    /* The answer being rewritten, so this is a rewrite rather than a second
     * independent answer.
     *
     * Without it the model re-read the same context from scratch and reached a
     * different conclusion -- observed: a standard answer saying "the newest
     * release is v2.11.6" became a brief answer saying "version 2.11.4", from
     * the identical 12,393 characters of context. Sharing sources is not the
     * same as agreeing with yourself. */
    const previous = (row.responseBlocks ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.data)
      .join('\n\n');

    const prompt =
      getWriterPrompt(
        row.writerContext,
        configManager.getConfig('personalization.systemInstructions', '') ?? '',
        (row.mode as 'speed' | 'balanced' | 'quality') ?? 'speed',
        body.answerStyle,
      ) +
      `

    ### You are rewriting an existing answer
    The answer below was already given to this question from the same sources.
    Rewrite it to the answer style above -- change the length, structure and
    wording as that style requires.

    **Do not change what it says.** Keep the same facts, the same version
    numbers, the same dates and the same citation numbers. If the style calls
    for a shorter answer, drop whole points rather than replacing them with
    different ones. Do not introduce any fact that is not already in the answer
    below.

    <previous_answer>
    ${previous}
    </previous_answer>`;

    const stream = withRole(
      llm,
      'writer',
      `${row.mode ?? 'speed'}/${body.answerStyle}`,
    ).streamText({
      options: {
        maxTokens: MAX_TOKENS[body.answerStyle],
        disableThinking: true,
      },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: row.query },
      ],
    });

    let answer = '';

    const encoder = new TextEncoder();
    const body$ = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const text = chunk.contentChunk ?? '';
            if (!text) continue;

            answer += text;
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ type: 'chunk', data: text }) + '\n',
              ),
            );
          }

          /* Replace the answer in place: the text block keeps its id, so the
           * sources and the research panel stay attached to it. */
          const blocks = (row.responseBlocks ?? []) as TextBlock[];
          const updated = blocks.map((b) =>
            b.type === 'text' ? { ...b, data: answer } : b,
          );

          await db
            .update(messages)
            .set({
              responseBlocks: updated as any,
              answerStyle: body.answerStyle,
            })
            .where(eq(messages.messageId, body.messageId))
            .execute();

          controller.enqueue(
            encoder.encode(JSON.stringify({ type: 'done' }) + '\n'),
          );
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'error',
                data: err instanceof Error ? err.message : String(err),
              }) + '\n',
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body$, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err) {
    console.error('Rewrite failed:', err);
    return Response.json({ message: 'Rewrite failed' }, { status: 500 });
  }
};
