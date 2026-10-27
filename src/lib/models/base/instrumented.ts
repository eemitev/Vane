import z from 'zod';
import BaseLLM from './llm';
import { CallContext, beginCall, completeCall } from '@/lib/telemetry';
import { getTokenCount } from '@/lib/utils/splitText';
import {
  GenerateObjectInput,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../types';

export type LLMCallContext = CallContext & {
  provider?: string;
  model?: string;
  role?: string;
  /* What the call ran with, e.g. the writer's answer style. */
  label?: string;
};
type Pending = {
  method: string;
  startedAt: string;
  start: number;
  firstChunkMs?: number;
  inputText: string;
  /* The open row, so finishing updates it rather than writing a second one.
   * A promise because begin() cannot await without delaying the call itself. */
  row: Promise<number | null>;
};

const serializeMessages = (messages: { role: string; content: string }[]) =>
  messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');

/* An orchestrator call answers entirely in tool calls, so recording only the
 * content would log it as having returned nothing. */
const serializeToolCalls = (toolCalls: ToolCall[]) =>
  toolCalls
    .map((tc) => `[tool] ${tc.name}(${JSON.stringify(tc.arguments ?? {})})`)
    .join('\n');

const serializeOutput = (content: string, toolCalls: ToolCall[]) =>
  [content, serializeToolCalls(toolCalls)].filter(Boolean).join('\n');

/**
 * Wraps a BaseLLM and records one row per call. Implemented as a decorator so
 * no provider has to be modified: the registry wraps whatever it loads, and
 * every provider is covered including ones added later.
 *
 * Recording never affects the call itself — a telemetry failure is logged and
 * swallowed, and errors from the underlying model are recorded then rethrown.
 */
class InstrumentedLLM<CONFIG> extends BaseLLM<CONFIG> {
  constructor(
    private inner: BaseLLM<CONFIG>,
    private ctx: LLMCallContext,
  ) {
    // The wrapper holds no config of its own; `inner` owns it.
    super(undefined as unknown as CONFIG);
  }

  /* Returns a wrapper around the same underlying model that tags its rows with
   * a role. Cheap -- no provider state is copied -- so call sites can do it
   * inline per call. */
  withRole(role: string, label?: string): InstrumentedLLM<CONFIG> {
    return new InstrumentedLLM(this.inner, { ...this.ctx, role, label });
  }

  private begin(method: string, inputText: string): Pending {
    const startedAt = new Date().toISOString();

    return {
      method,
      startedAt,
      start: Date.now(),
      inputText,
      /* Opened now, not awaited: the row exists so the call shows as running,
       * and nothing about the request waits on a database write. */
      row: beginCall(this.ctx, {
        kind: 'model',
        method,
        role: this.ctx.role,
        label: this.ctx.label,
        provider: this.ctx.provider,
        model: this.ctx.model,
        startedAt,
        inputText,
        inputTokens: getTokenCount(inputText),
      }),
    };
  }

  private async finish(p: Pending, outputText: string, error?: unknown) {
    await completeCall(await p.row, this.ctx, {
      durationMs: Date.now() - p.start,
      firstChunkMs: p.firstChunkMs,
      outputText,
      error,
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const p = this.begin('generateText', serializeMessages(input.messages));
    try {
      const out = await this.inner.generateText(input);
      await this.finish(p, serializeOutput(out.content ?? '', out.toolCalls));
      return out;
    } catch (err) {
      await this.finish(p, '', err);
      throw err;
    }
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const p = this.begin('streamText', serializeMessages(input.messages));
    let output = '';
    /* Each chunk carries the whole accumulated state of the tool calls it
     * touches, not a delta, so keep the latest per call rather than appending. */
    const toolCalls = new Map<string, ToolCall>();

    try {
      for await (const chunk of this.inner.streamText(input)) {
        if (p.firstChunkMs === undefined) p.firstChunkMs = Date.now() - p.start;
        output += chunk.contentChunk ?? '';
        chunk.toolCallChunk?.forEach((tc, index) =>
          toolCalls.set(tc.id || tc.name || String(index), tc),
        );
        yield chunk;
      }
      await this.finish(p, serializeOutput(output, [...toolCalls.values()]));
    } catch (err) {
      await this.finish(
        p,
        serializeOutput(output, [...toolCalls.values()]),
        err,
      );
      throw err;
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<z.infer<T>> {
    const p = this.begin('generateObject', serializeMessages(input.messages));
    try {
      const out = await this.inner.generateObject<T>(input);
      await this.finish(p, JSON.stringify(out ?? ''));
      return out;
    } catch (err) {
      await this.finish(p, '', err);
      throw err;
    }
  }

  async *streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<z.infer<T>>> {
    const p = this.begin('streamObject', serializeMessages(input.messages));
    let last: unknown = undefined;
    try {
      for await (const chunk of this.inner.streamObject<T>(input)) {
        if (p.firstChunkMs === undefined) p.firstChunkMs = Date.now() - p.start;
        last = chunk;
        yield chunk;
      }
      await this.finish(p, JSON.stringify(last ?? ''));
    } catch (err) {
      await this.finish(p, JSON.stringify(last ?? ''), err);
      throw err;
    }
  }
}

/**
 * Tags a model's telemetry with the job it is doing. A no-op when the model is
 * not instrumented, so call sites need no conditional.
 */
/* `label` records what the call ran with -- the writer's answer style, say --
 * so a stored run can be read back without inferring its settings from the
 * message row, which only ever holds the most recent value. */
export const withRole = <T extends BaseLLM<any>>(
  llm: T,
  role: string,
  label?: string,
): T =>
  llm instanceof InstrumentedLLM
    ? (llm.withRole(role, label) as unknown as T)
    : llm;

export default InstrumentedLLM;
