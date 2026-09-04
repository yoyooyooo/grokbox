import type { CliDeps } from "../deps.ts";
import type { EventSource, UnifiedEvent } from "../daemon/events.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, parseSse } from "../gateway.ts";
import { writeJsonLine } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { redactEventPayload } from "../redaction.ts";
import { ALLOWED_EVENT_CHANNELS, DEFAULT_EVENT_CHANNELS } from "../registry.ts";
import { asString, isRecord } from "../util.ts";

const ALLOWED_CHANNELS = new Set<string>(ALLOWED_EVENT_CHANNELS);
const ALLOWED_SOURCES = new Set<EventSource>(["gateway", "job", "daemon"]);
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CURSOR = new RegExp(`^(${UUID_V4}):(0|[1-9][0-9]*)$`, "i");
const GENERATION = new RegExp(`^${UUID_V4}$`, "i");
const INPUT_CURSOR = /^[A-Za-z0-9:.-]{1,160}$/;

function parseCsv<T extends string>(
  value: string | undefined,
  defaults: readonly T[],
  allowed: ReadonlySet<string>,
  label: string,
): T[] {
  if (value === undefined || value.trim().length === 0) return [...defaults];
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) throw usage(`${label} must list unique values.`);
  for (const item of values) {
    if (!allowed.has(item)) throw usage(`${label} contains unsupported value '${item}'.`);
  }
  return values as T[];
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 64;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 128) throw usage("--limit must be an integer from 1 to 128.");
  return parsed;
}

function validateEvent(value: unknown): UnifiedEvent {
  if (!isRecord(value)) throw new CliError("daemon_unreachable", "Daemon event projection is invalid.");
  const allowed = new Set(["channel", "gateway", "kind", "observedAtMs", "operationId", "payload", "sequence", "source"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !ALLOWED_SOURCES.has(value.source as EventSource) ||
    typeof value.kind !== "string" || value.kind.length === 0 || typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.observedAtMs !== "number" ||
    !Number.isSafeInteger(value.observedAtMs) || !("payload" in value) ||
    (value.channel !== undefined && (typeof value.channel !== "string" || !ALLOWED_CHANNELS.has(value.channel))) ||
    (value.operationId !== undefined && typeof value.operationId !== "string")) {
    throw new CliError("daemon_unreachable", "Daemon event projection is invalid.");
  }
  if (value.gateway !== undefined && (!isRecord(value.gateway) ||
    JSON.stringify(Object.keys(value.gateway).sort()) !== JSON.stringify(["pid", "startedAt"]) ||
    typeof value.gateway.pid !== "number" || !Number.isSafeInteger(value.gateway.pid) ||
    typeof value.gateway.startedAt !== "number" || !Number.isSafeInteger(value.gateway.startedAt))) {
    throw new CliError("daemon_unreachable", "Daemon event Gateway generation is invalid.");
  }
  return value as UnifiedEvent;
}

function emit(deps: CliDeps, event: UnifiedEvent, cursor: string, daemonGeneration?: string): void {
  writeJsonLine(deps.stdout, {
    ok: true,
    event,
    cursor,
    meta: { daemonGeneration: daemonGeneration ?? null },
  });
}

export async function runEvents(
  deps: CliDeps,
  raw: {
    json?: boolean;
    table?: boolean;
    timeoutMs?: string;
    channels?: string;
    sources?: string;
    cursor?: string;
    limit?: string;
    once?: boolean;
    includeMemoryContent?: boolean;
  },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("events does not support --table.");
  const channels = parseCsv<string>(raw.channels, DEFAULT_EVENT_CHANNELS, ALLOWED_CHANNELS, "--channels");
  const includeMemoryContent = Boolean(raw.includeMemoryContent);
  if (includeMemoryContent && !channels.includes("memory")) throw usage("--include-memory-content requires the memory channel.");
  if (raw.cursor !== undefined && !INPUT_CURSOR.test(raw.cursor)) throw usage("--cursor is invalid.");
  const limit = parseLimit(raw.limit);
  const once = Boolean(raw.once);
  const client = new GatewayClient(deps);
  const daemon = await client.eventDaemon(io.timeoutMs);
  if (daemon) {
    const sources = parseCsv<EventSource>(raw.sources, ["gateway", "job", "daemon"], ALLOWED_SOURCES, "--sources");
    let cursor = raw.cursor;
    while (!deps.signal?.aborted) {
      const response = await daemon.call("eventRead", {
        cursor: cursor ?? null,
        sources,
        channels,
        includeMemoryContent,
        limit,
        waitMs: Math.min(io.timeoutMs, 25_000),
      });
      const page = response.result;
      const pageKeys = isRecord(page) ? Object.keys(page) : [];
      const cursorMatch = isRecord(page) && typeof page.cursor === "string" ? CURSOR.exec(page.cursor) : null;
      if (!isRecord(page) || pageKeys.some((key) => !["cursor", "daemonGeneration", "events", "gap"].includes(key)) ||
        typeof page.daemonGeneration !== "string" || !GENERATION.test(page.daemonGeneration) ||
        !Array.isArray(page.events) || !cursorMatch || cursorMatch[1]?.toLowerCase() !== page.daemonGeneration.toLowerCase() ||
        (page.gap !== undefined && !isRecord(page.gap))) {
        throw new CliError("daemon_unreachable", "Daemon event page is invalid.");
      }
      const cursorSequence = Number(cursorMatch[2]);
      if (!Number.isSafeInteger(cursorSequence)) throw new CliError("daemon_unreachable", "Daemon event page cursor is invalid.");
      const requestedMatch = cursor === undefined ? null : CURSOR.exec(cursor);
      let lowerExclusive = 0;
      let gap: Record<string, unknown> | undefined;
      if (page.gap !== undefined) {
        gap = page.gap;
        if (JSON.stringify(Object.keys(gap).sort()) !== JSON.stringify(["oldestAvailableSequence", "reason", "requestedCursor"]) ||
          (gap.reason !== "daemon_generation_changed" && gap.reason !== "history_evicted") ||
          typeof gap.requestedCursor !== "string" || gap.requestedCursor !== cursor ||
          typeof gap.oldestAvailableSequence !== "number" || !Number.isSafeInteger(gap.oldestAvailableSequence) ||
          gap.oldestAvailableSequence < 1 || cursorSequence < gap.oldestAvailableSequence - 1 || !requestedMatch ||
          (gap.reason === "daemon_generation_changed") ===
            (requestedMatch[1]?.toLowerCase() === page.daemonGeneration.toLowerCase())) {
          throw new CliError("daemon_unreachable", "Daemon event gap is invalid.");
        }
        lowerExclusive = gap.oldestAvailableSequence - 1;
      } else if (requestedMatch !== null) {
        if (requestedMatch[1]?.toLowerCase() !== page.daemonGeneration.toLowerCase()) {
          throw new CliError("daemon_unreachable", "Daemon event page omitted a generation gap.");
        }
        lowerExclusive = Number(requestedMatch[2]);
        if (!Number.isSafeInteger(lowerExclusive) || cursorSequence < lowerExclusive) {
          throw new CliError("daemon_unreachable", "Daemon event page cursor regressed.");
        }
      }
      const events = page.events.map(validateEvent);
      let priorSequence = lowerExclusive;
      for (const event of events) {
        if (event.sequence <= priorSequence || event.sequence > cursorSequence) {
          throw new CliError("daemon_unreachable", "Daemon event page sequence is invalid.");
        }
        priorSequence = event.sequence;
      }
      let emitted = false;
      if (gap !== undefined) {
        const sequence = (gap.oldestAvailableSequence as number) - 1;
        emit(deps, {
          source: "daemon",
          kind: "gap",
          sequence,
          observedAtMs: deps.now(),
          payload: {
            reason: gap.reason,
            requestedCursor: gap.requestedCursor,
            oldestAvailableSequence: gap.oldestAvailableSequence,
          },
        }, `${page.daemonGeneration}:${sequence}`, page.daemonGeneration);
        emitted = true;
        if (once) return;
      }
      for (const event of events) {
        emit(deps, event, `${page.daemonGeneration}:${event.sequence}`, page.daemonGeneration);
        emitted = true;
        if (once) return;
      }
      cursor = `${page.daemonGeneration}:${cursorSequence}`;
      if (once && !emitted) throw new CliError("gateway_unreachable", "Event wait ended before the first event.");
    }
    return;
  }

  const sources = parseCsv<EventSource>(raw.sources, ["gateway"], ALLOWED_SOURCES, "--sources");
  if (sources.some((source) => source !== "gateway")) {
    throw new CliError("capability_unavailable", "Direct Gateway Profiles provide only Gateway events.");
  }
  const stop = deps.signal;
  let sequence = 0;
  let emitted = false;
  let first = true;
  let pendingGap = raw.cursor === undefined ? undefined : "direct_gateway_resume_unavailable";

  while (!stop?.aborted) {
    let opened: Awaited<ReturnType<GatewayClient["openEventStream"]>>;
    try {
      opened = await client.openEventStream(channels, io.timeoutMs);
    } catch (error) {
      if (stop?.aborted) return;
      if (first) throw error;
      pendingGap = "gateway_reconnect_failed";
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    first = false;
    if (!opened.response.body) throw new CliError("gateway_unreachable", "Gateway event stream had no body.");
    if (pendingGap) {
      const event: UnifiedEvent = {
        source: "gateway",
        kind: "gap",
        sequence: ++sequence,
        observedAtMs: deps.now(),
        gateway: { pid: opened.discovery.pid, startedAt: opened.discovery.startedAt },
        payload: { reason: pendingGap, resumable: false },
      };
      emit(deps, event, `direct:${sequence}`);
      emitted = true;
      pendingGap = undefined;
      if (once) return;
    }

    let lastChunk = deps.now();
    let streamGapEmitted = false;
    const watchdog = setInterval(() => {
      if (deps.now() - lastChunk > deps.idleWatchdogMs) void opened.response.body?.cancel();
    }, 1_000);
    try {
      for await (const frame of parseSse(opened.response.body, {
        onChunk: () => { lastChunk = deps.now(); },
        onGap: (reason) => {
          const event: UnifiedEvent = {
            source: "gateway",
            kind: "gap",
            sequence: ++sequence,
            observedAtMs: deps.now(),
            gateway: { pid: opened.discovery.pid, startedAt: opened.discovery.startedAt },
            payload: { reason, resumable: false },
          };
          emit(deps, event, `direct:${sequence}`);
          emitted = true;
          streamGapEmitted = true;
        },
        signal: stop,
      })) {
        if (stop?.aborted) return;
        if (once && streamGapEmitted) return;
        const record = isRecord(frame) ? frame : {};
        const channel = asString(record.channel);
        if (!channels.includes(channel)) continue;
        const event: UnifiedEvent = {
          source: "gateway",
          kind: "event",
          channel,
          sequence: ++sequence,
          observedAtMs: deps.now(),
          gateway: { pid: opened.discovery.pid, startedAt: opened.discovery.startedAt },
          payload: redactEventPayload(channel, record.payload, includeMemoryContent),
        };
        emit(deps, event, `direct:${sequence}`);
        emitted = true;
        if (once) return;
      }
    } finally {
      clearInterval(watchdog);
    }
    if (stop?.aborted) return;
    if (once && streamGapEmitted) return;
    if (once) {
      const event: UnifiedEvent = {
        source: "gateway",
        kind: "gap",
        sequence: ++sequence,
        observedAtMs: deps.now(),
        gateway: { pid: opened.discovery.pid, startedAt: opened.discovery.startedAt },
        payload: { reason: "stream_disconnected", resumable: false },
      };
      emit(deps, event, `direct:${sequence}`);
      return;
    }
    pendingGap = "stream_disconnected";
  }
  if (once && !emitted) throw new CliError("gateway_unreachable", "Event stream ended before the first allowed event.");
}
