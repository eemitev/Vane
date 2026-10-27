'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo } from 'react';

interface Call {
  id: number;
  kind: string | null;
  label: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  method: string;
  startedAt: string;
  durationMs: number | null;
  firstChunkMs: number | null;
  inputChars: number | null;
  inputTokens: number | null;
  outputChars: number | null;
  error: string | null;
  hasText: number;
}

interface CallDetail extends Omit<Call, 'hasText'> {
  messageId: string | null;
  chatId: string | null;
  inputText: string | null;
  outputText: string | null;
}

/* One colour per method so the shape of a run is readable at a glance: a
 * research run is a wall of generateObject with a single streamText at the end. */
/* The SDK method names are the mechanism, not the job: streamText is both the
 * orchestrator and the writer, and generateObject is both the classifier and
 * the chunk extractor. These label the call shape, which is all the stored row
 * can tell us. */
const methodLabel: Record<string, string> = {
  generateText: 'Text',
  streamText: 'Streamed text',
  generateObject: 'Structured data',
  streamObject: 'Streamed structured data',
};

const kindLabel: Record<string, string> = {
  search: 'Search',
  scrape: 'Page fetch',
  embed: 'Embedding',
  load: 'Model load',
};

const roleLabel: Record<string, string> = {
  classifier: 'Classifier',
  orchestrator: 'Orchestrator',
  picker: 'Result picker',
  extractor: 'Extractor',
  writer: 'Writer',
  widget: 'Widget',
};

/* Role first, because it is the only one of the three that says what the call
 * was for: the orchestrator and the writer are both streamText, and the
 * classifier and the extractor are both generateObject. Then kind, since a
 * search span's method is the engine rather than a model call shape. */
const label = (call: {
  role?: string | null;
  kind?: string | null;
  method: string;
}) =>
  (call.role && (roleLabel[call.role] ?? call.role)) ??
  (call.kind && kindLabel[call.kind]) ??
  methodLabel[call.method] ??
  call.method;

/* Polls after the run ends, waiting for in-flight rows to be closed by the
 * call that owns them. Five at 2s covers the write landing just after the
 * stream closed; past that the owning process is gone and will never close it. */
const SETTLE_POLLS = 5;

const kindColor: Record<string, string> = {
  search: 'bg-blue-400',
  scrape: 'bg-orange-400',
  embed: 'bg-teal-400',
  load: 'bg-fuchsia-400',
};

/* Coloured by role rather than by SDK method, matching the row labels. The
 * method is the mechanism -- streamText is both the orchestrator and the
 * writer -- so colouring by it made the two most distinct phases of a run the
 * same colour. A model call with no role falls back to grey rather than to the
 * method, so an untagged call is visible but never claims a role's colour. */
const roleColor: Record<string, string> = {
  classifier: 'bg-violet-500',
  orchestrator: 'bg-emerald-500',
  picker: 'bg-indigo-500',
  extractor: 'bg-amber-500',
  writer: 'bg-rose-500',
  widget: 'bg-lime-500',
};

const barColor = (call: Call) =>
  call.error
    ? 'bg-red-500'
    : ((call.role ? roleColor[call.role] : undefined) ??
      (call.kind ? kindColor[call.kind] : undefined) ??
      'bg-gray-500');

export const ms = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;
};

const chars = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v}`;
  return `${(v / 1000).toFixed(1)}k`;
};

/**
 * The call timeline for one message: one bar per model call on a wall-clock
 * axis, click a bar to inspect it.
 *
 * Rendered inside a chat's research panel. There was a standalone page for
 * this too; it was removed once the timeline was available where the run
 * actually happened.
 */
const LlmCallTimeline = ({
  messageId,
  isRunning = false,
}: {
  messageId: string;
  isRunning?: boolean;
}) => {
  const [calls, setCalls] = useState<Call[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [embedsOpen, setEmbedsOpen] = useState(false);
  /* Set when a row stayed open past the settle window -- the process that owned
   * it is gone, so it will never be closed. */
  const [gaveUp, setGaveUp] = useState(false);

  /* A message can hold more than one run: the original search, then a rewrite
   * at a different length, which re-runs only the writer under the same
   * messageId. Drawn together they share one time axis spanning the gap
   * between them, so the original compresses to a sliver.
   *
   * Split on structure rather than elapsed time. Every run ends with its
   * writer, and a rewrite is a lone writer call -- so a new run begins at the
   * first call after a writer. An earlier version split on a 90-second idle
   * gap and was wrong on real data: one rewrite started 23 seconds after the
   * answer it replaced, and would have been folded into the search.
   *
   * A long idle gap is kept as a secondary split, for a run that failed before
   * reaching its writer and so never closed. */
  const RUN_GAP_MS = 5 * 60_000;

  const runs = useMemo(() => {
    const sorted = [...calls].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );

    const grouped: Call[][] = [];
    let closed = true;

    for (const call of sorted) {
      const last = grouped[grouped.length - 1];
      const prev = last?.[last.length - 1];

      const idle = prev
        ? Date.parse(call.startedAt) -
          (Date.parse(prev.startedAt) + (prev.durationMs ?? 0))
        : 0;

      if (closed || !last || idle > RUN_GAP_MS) {
        grouped.push([call]);
      } else {
        last.push(call);
      }

      /* The writer is the last thing a run does. */
      closed = call.role === 'writer';
    }

    return grouped;
  }, [calls]);

  const [runIndex, setRunIndex] = useState(0);

  /* Follow the newest run as it arrives, but leave a deliberate choice alone. */
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!pinned && runs.length) setRunIndex(runs.length - 1);
  }, [runs.length, pinned]);

  const shown = runs[Math.min(runIndex, Math.max(0, runs.length - 1))] ?? [];

  /* Open rows have no duration yet, so their bars are measured against the
   * clock here rather than waiting for the server to tell us how long they
   * took -- which it cannot do until they finish. */
  const hasRunning = shown.some((c) => c.durationMs === null);

  useEffect(() => {
    if (!messageId) return;

    let cancelled = false;

    const load = () =>
      fetch(`/api/debug/llm-calls?messageId=${encodeURIComponent(messageId)}`)
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setCalls(data.calls ?? []);
        })
        .catch(() => undefined);

    load();

    /* While the run is live, new calls appear and open ones close, so re-read.
     *
     * Polling also has to outlive the run itself. A call's row is closed by
     * finish(), which commits just after the stream hands its last chunk to the
     * client -- so the single fetch triggered by the run ending can read the
     * writer as still open and then never look again, leaving its bar growing
     * until the page was refreshed. Keep polling until every row has closed. */
    if (!isRunning && !hasRunning) {
      return () => {
        cancelled = true;
      };
    }

    /* Bounded, because a row left open by a killed process never closes and
     * polling it forever would be a leak. On expiry the clock below freezes, so
     * the bar stops pretending the call is still running. */
    let settlePolls = 0;

    const poll = setInterval(() => {
      if (!isRunning) {
        settlePolls += 1;

        if (settlePolls > SETTLE_POLLS) {
          clearInterval(poll);
          if (!cancelled) setGaveUp(true);
          return;
        }
      }

      load();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [messageId, isRunning, hasRunning]);

  /* A new run gets a fresh grace window. */
  useEffect(() => {
    if (isRunning) setGaveUp(false);
  }, [isRunning, messageId]);

  useEffect(() => {
    if (!hasRunning || gaveUp) return;

    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [hasRunning, gaveUp]);

  const openCall = useCallback((id: number) => {
    fetch(`/api/debug/llm-calls?callId=${id}`)
      .then((res) => res.json())
      .then((data) => setDetail(data.call ?? null))
      .catch(() => undefined);
  }, []);

  /* The timeline is laid out against wall-clock time, not call order, so
   * overlapping bars are exactly the concurrent fan-out. */
  const t0 = shown.length ? Date.parse(shown[0].startedAt) : 0;
  const endOf = (c: Call) =>
    c.durationMs === null
      ? Math.max(now, Date.parse(c.startedAt))
      : Date.parse(c.startedAt) + c.durationMs;

  const tEnd = shown.reduce((max, c) => Math.max(max, endOf(c)), t0 + 1);
  const span = Math.max(tEnd - t0, 1);

  /* Usually one model for the whole run, but a reconnect or a settings change
   * mid-run can mix them, so show every distinct one rather than the first. */
  const models = Array.from(
    new Set(
      shown
        .map((c) => [c.provider, c.model].filter(Boolean).join(' / '))
        .filter(Boolean),
    ),
  );

  /* Embeddings are collapsed into one row. A speed-mode run makes about ninety
   * of them, which buries the handful of calls that explain the run's cost;
   * grouped, they still show when they happened and how much work they were. */
  type Row =
    | { type: 'call'; call: Call; nested?: boolean }
    | { type: 'embedGroup'; calls: Call[] };

  const embeds = shown.filter((c) => c.kind === 'embed');
  const rows: Row[] = [];
  let groupPlaced = false;

  for (const call of shown) {
    if (call.kind !== 'embed') {
      rows.push({ type: 'call', call });
      continue;
    }

    /* The group sits where the first embedding did, keeping the timeline in
     * chronological order, and expanding lists them all together underneath --
     * scattering them between later calls would read as orphaned rows. */
    if (!groupPlaced) {
      rows.push({ type: 'embedGroup', calls: embeds });
      groupPlaced = true;

      if (embedsOpen) {
        for (const embed of embeds) {
          rows.push({ type: 'call', call: embed, nested: true });
        }
      }
    }
  }

  /* Only what this run actually contains. Listing all six roles and all four
   * kinds unconditionally would put ten chips above a speed-mode run that used
   * four of them, and the legend is there to decode the bars, not to enumerate
   * the pipeline. Roles stay in pipeline order so the legend reads like the run. */
  const legend = [
    ...Object.keys(roleColor)
      .filter((role) => calls.some((c) => c.role === role))
      .map((role) => ({
        key: `role-${role}`,
        color: roleColor[role],
        text: roleLabel[role] ?? role,
      })),
    ...Object.keys(kindColor)
      .filter((kind) => calls.some((c) => c.kind === kind && !c.role))
      .map((kind) => ({
        key: `kind-${kind}`,
        color: kindColor[kind],
        text: kindLabel[kind],
      })),
    ...(calls.some((c) => c.error)
      ? [{ key: 'failed', color: 'bg-red-500', text: 'Failed' }]
      : []),
  ];

  if (shown.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {runs.length > 1 && (
        <div className="flex flex-row items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span>Run</span>
          <select
            value={runIndex}
            onChange={(e) => {
              setPinned(true);
              setRunIndex(Number(e.target.value));
            }}
            className="bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-lg px-2 py-1 text-xs text-black dark:text-white focus:outline-none"
          >
            {runs.map((run, i) => {
              /* Name a run by what it did: a rewrite is writer-only, the
               * original search is everything else. */
              const writerOnly = run.every((c) => c.role === 'writer');
              const at = new Date(run[0].startedAt).toLocaleTimeString();

              /* The writer records what it ran with -- "quality/brief" -- so a
               * run can be identified by its settings rather than by guessing
               * from the message row, which only holds the most recent value
               * and is overwritten by every rewrite. */
              const settings = run.find((c) => c.role === 'writer')?.label;
              const secs = Math.round(
                (Math.max(
                  ...run.map(
                    (c) => Date.parse(c.startedAt) + (c.durationMs ?? 0),
                  ),
                ) -
                  Date.parse(run[0].startedAt)) /
                  1000,
              );

              return (
                <option key={i} value={i}>
                  {[
                    writerOnly ? 'Rewrite' : 'Search',
                    settings,
                    at,
                    `${run.length} calls`,
                    `${secs}s`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </option>
              );
            })}
          </select>
          {runIndex !== runs.length - 1 && (
            <button
              type="button"
              onClick={() => {
                setPinned(false);
                setRunIndex(runs.length - 1);
              }}
              className="underline underline-offset-2 hover:text-black dark:hover:text-white"
            >
              latest
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-black/60 dark:text-white/60">
        {legend.map(({ key, color, text }) => (
          <span key={key} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
            {text}
          </span>
        ))}
        <span className="ml-auto text-black/70 dark:text-white/70">
          {models.join(', ')}
        </span>
        <span>
          {shown.length} calls over {ms(span)} wall clock
        </span>
      </div>

      <div className="flex flex-col gap-[3px]">
        {rows.map((row) => {
          if (row.type === 'embedGroup') {
            const first = Math.min(...row.calls.map((c) => Date.parse(c.startedAt)));
            const last = Math.max(...row.calls.map(endOf));
            const running = row.calls.filter((c) => c.durationMs === null).length;
            const cpu = row.calls.reduce((t, c) => t + (c.durationMs ?? 0), 0);

            return (
              <button
                key="embed-group"
                onClick={() => setEmbedsOpen(!embedsOpen)}
                title={`${row.calls.length} embeddings · ${ms(cpu)} of work in ${ms(last - first)} of wall clock`}
                className="relative h-5 w-full rounded-sm hover:bg-light-secondary dark:hover:bg-dark-secondary group flex items-center"
              >
                <span
                  className={`absolute top-1 h-3 rounded-sm bg-teal-400 dark:bg-teal-300 opacity-80 group-hover:opacity-100 ${
                    running && !gaveUp ? 'animate-pulse' : ''
                  }`}
                  style={{
                    left: `${((first - t0) / span) * 100}%`,
                    width: `${Math.max((last - first) / span, 0.004) * 100}%`,
                    minWidth: '2px',
                  }}
                />
                <span className="relative z-10 ml-auto pl-2 pr-1 text-[10px] font-mono text-black/50 dark:text-white/50">
                  {embedsOpen ? '▾' : '▸'} {row.calls.length} embeddings
                  {running > 0 && `, ${running} running`}
                </span>
              </button>
            );
          }

          const call = row.call;
          const start = Date.parse(call.startedAt);
          const offset = (start - t0) / span;
          const width = Math.max((endOf(call) - start) / span, 0.004);
          const open = call.durationMs === null;
          const ttfb =
            !open && call.firstChunkMs
              ? call.firstChunkMs / (call.durationMs || call.firstChunkMs)
              : 0;

          return (
            <button
              key={call.id}
              onClick={() => openCall(call.id)}
              title={`${label(call)} · ${call.label ?? call.model ?? ''} · ${
                !open
                  ? ms(call.durationMs)
                  : gaveUp
                    ? 'no result recorded'
                    : `running ${ms(now - start)}`
              }`}
              className={`relative h-5 w-full rounded-sm hover:bg-light-secondary dark:hover:bg-dark-secondary group ${row.nested ? 'pl-4' : ''}`}
            >
              <span
                className={`absolute top-1 h-3 rounded-sm overflow-hidden ${barColor(
                  call,
                )} opacity-80 group-hover:opacity-100 ${
                  open && !gaveUp ? 'animate-pulse' : ''
                }`}
                style={{
                  left: `${offset * 100}%`,
                  width: `${width * 100}%`,
                  minWidth: '2px',
                }}
              >
                {ttfb > 0 && (
                  <span
                    className="absolute inset-y-0 left-0 bg-white/50 dark:bg-black/40"
                    style={{ width: `${Math.min(ttfb, 1) * 100}%` }}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

    {detail && (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto"
        onClick={() => setDetail(null)}
      >
        <div
          className="bg-light-primary dark:bg-dark-primary rounded-lg max-w-4xl w-full mt-10 p-5 flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg">{label(detail)}</div>
              <div className="text-sm text-black/60 dark:text-white/60">
                {/* A search or scrape span has no provider or model; its label
                  * is the query or the URL. */}
                {detail.label ??
                  `${detail.provider ?? 'unknown provider'} / ${detail.model ?? 'unknown model'}`}{' '}
                · {new Date(detail.startedAt).toLocaleString()}
              </div>
            </div>
            <button onClick={() => setDetail(null)}>
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Duration
              </div>
              {ms(detail.durationMs)}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                First chunk
              </div>
              {ms(detail.firstChunkMs)}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Input
              </div>
              {detail.inputTokens
                ? `${chars(detail.inputTokens)} tokens`
                : `${chars(detail.inputChars)} chars`}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Output
              </div>
              {chars(detail.outputChars)} chars
            </div>
          </div>

          {detail.error && (
            <div className="text-sm text-red-500 border border-red-500/30 rounded-md p-3">
              {detail.error}
            </div>
          )}

          {detail.inputText === null && detail.outputText === null ? (
            <div className="text-sm text-black/60 dark:text-white/60 border border-light-200/20 dark:border-dark-200/20 rounded-md p-3">
              Text was not captured for this call. Turn on{' '}
              <span className="font-medium">
                Capture model prompts and responses
              </span>{' '}
              under Settings → Debug and re-run; it only applies to calls made
              after it is enabled.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-black/50 dark:text-white/50">
                  Prompt
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto bg-light-secondary dark:bg-dark-secondary rounded-md p-3">
                  {detail.inputText || '(empty)'}
                </pre>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-black/50 dark:text-white/50">
                  Response
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto bg-light-secondary dark:bg-dark-secondary rounded-md p-3">
                  {detail.outputText || '(empty)'}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    )}
    </div>
  );
};

export default LlmCallTimeline;
