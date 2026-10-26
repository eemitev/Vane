import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenAI-compatible server that can be told to misbehave.
 *
 * The expensive failures in this app were all model behaviour the code handled
 * badly: thinking that never became an answer, a model emitting one character
 * forever, llama.cpp returning 500 mid-generation, a stream that simply
 * stopped. None of those can be produced on demand from a real model, and all
 * of them are cheap to produce here.
 */

export type Scripted =
  /* Streamed deltas, sent in order as SSE. Each entry is a partial `delta`. */
  | { kind: 'stream'; deltas: Record<string, unknown>[]; finishReason?: string }
  /* A non-streamed chat completion. */
  | { kind: 'json'; content: string | null; reasoning?: string }
  /* An HTTP error, body shaped like llama.cpp's. */
  | { kind: 'error'; status: number; message: string }
  /* Headers and some deltas, then silence -- the stall case. */
  | { kind: 'stall'; deltas: Record<string, unknown>[] };

export type FakeProvider = {
  baseURL: string;
  /* Requests received, so tests can assert on what was sent. */
  requests: any[];
  script: (s: Scripted) => void;
  close: () => Promise<void>;
};

const sse = (res: http.ServerResponse, payload: unknown) =>
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

export const startFakeProvider = async (): Promise<FakeProvider> => {
  let scripted: Scripted = { kind: 'json', content: 'ok' };
  const requests: any[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));

    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* keep the raw text for assertions */
      }
      requests.push({ url: req.url, body, raw });

      if (scripted.kind === 'error') {
        res.writeHead(scripted.status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: scripted.status,
              message: scripted.message,
              type: 'server_error',
            },
          }),
        );
        return;
      }

      if (scripted.kind === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-fake',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: scripted.content,
                  ...(scripted.reasoning
                    ? { reasoning_content: scripted.reasoning }
                    : {}),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for (const delta of scripted.deltas) {
        sse(res, {
          id: 'cmpl-fake',
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      }

      if (scripted.kind === 'stall') {
        /* Headers sent, some data delivered, then nothing. The socket stays
         * open: this is the case the SDK's own timeout does not cover. */
        return;
      }

      sse(res, {
        id: 'cmpl-fake',
        choices: [
          { index: 0, delta: {}, finish_reason: scripted.finishReason ?? 'stop' },
        ],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (s) => {
      scripted = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};

/** Convenience: a stream of plain content deltas. */
export const contentDeltas = (...parts: string[]) =>
  parts.map((content) => ({ content }));
