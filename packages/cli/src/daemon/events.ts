import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { GatewayClient, gatewayMeta, parseSse } from "../gateway.ts";
import { redactEventPayload } from "../redaction.ts";
import { ALLOWED_EVENT_CHANNELS } from "../registry.ts";
import { asString, isRecord } from "../util.ts";

const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/i;
const JOURNAL_LIMIT = 2048;
const JOURNAL_BYTES_MAX = 32 * 1024 * 1024;
const EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
const EVENT_WAITER_LIMIT = 128;

export type EventSource = "gateway" | "job" | "daemon";

export type UnifiedEvent = {
  source: EventSource;
  kind: string;
  sequence: number;
  observedAtMs: number;
  channel?: string;
  operationId?: string;
  gateway?: { pid: number; startedAt: number };
  payload: unknown;
};

type JournalEntry = UnifiedEvent & { privatePayload?: unknown; retainedBytes: number };

export type EventPage = {
  daemonGeneration: string;
  cursor: string;
  events: UnifiedEvent[];
  gap?: {
    reason: "daemon_generation_changed" | "history_evicted";
    requestedCursor: string;
    oldestAvailableSequence: number;
  };
};

function boundedPayload(payload: unknown): unknown {
  try {
    if (Buffer.byteLength(JSON.stringify(payload)) <= EVENT_PAYLOAD_MAX_BYTES) return payload;
  } catch {}
  return { redacted: true, reason: "payload_too_large" };
}

export class EventJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly waiters = new Set<() => void>();
  private sequence = 0;
  private retainedBytes = 0;

  constructor(
    readonly generation: string,
    private readonly now: () => number,
  ) {}

  cursor(): string {
    return `${this.generation}:${this.sequence}`;
  }

  publish(input: {
    source: EventSource;
    kind: string;
    channel?: string;
    operationId?: string;
    gateway?: { pid: number; startedAt: number };
    payload: unknown;
    privatePayload?: unknown;
  }): UnifiedEvent {
    const payload = boundedPayload(input.payload);
    const privatePayload = input.privatePayload === undefined ? undefined : boundedPayload(input.privatePayload);
    const retainedBytes = Buffer.byteLength(JSON.stringify(payload)) +
      (privatePayload === undefined ? 0 : Buffer.byteLength(JSON.stringify(privatePayload)));
    const entry: JournalEntry = {
      source: input.source,
      kind: input.kind,
      sequence: ++this.sequence,
      observedAtMs: this.now(),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.gateway === undefined ? {} : { gateway: input.gateway }),
      payload,
      ...(privatePayload === undefined ? {} : { privatePayload }),
      retainedBytes,
    };
    this.entries.push(entry);
    this.retainedBytes += retainedBytes;
    while (this.entries.length > JOURNAL_LIMIT || this.retainedBytes > JOURNAL_BYTES_MAX) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.retainedBytes -= removed.retainedBytes;
    }
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
    return this.project(entry, false);
  }

  async read(input: {
    cursor?: string;
    sources: readonly EventSource[];
    channels: readonly string[];
    includeMemoryContent: boolean;
    limit: number;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<EventPage> {
    const parsed = input.cursor === undefined ? undefined : CURSOR.exec(input.cursor);
    if (input.cursor !== undefined && !parsed) {
      throw new CliError("event_cursor_invalid", "Event cursor is invalid.");
    }
    const requestedGeneration = parsed?.[1];
    const requestedSequence = parsed
      ? Number(parsed[2])
      : Math.max(0, (this.entries[0]?.sequence ?? 1) - 1);
    if (!Number.isSafeInteger(requestedSequence)) {
      throw new CliError("event_cursor_invalid", "Event cursor is invalid.");
    }

    let after = requestedSequence;
    let gap: EventPage["gap"];
    const oldest = this.entries[0]?.sequence ?? this.sequence + 1;
    if (requestedGeneration !== undefined && requestedGeneration !== this.generation) {
      gap = {
        reason: "daemon_generation_changed",
        requestedCursor: input.cursor!,
        oldestAvailableSequence: oldest,
      };
      after = oldest - 1;
    } else if (after < oldest - 1) {
      gap = {
        reason: "history_evicted",
        requestedCursor: input.cursor!,
        oldestAvailableSequence: oldest,
      };
      after = oldest - 1;
    } else if (after > this.sequence) {
      throw new CliError("event_cursor_invalid", "Event cursor is ahead of the daemon journal.");
    }

    let page = this.page(after, input, gap);
    if (page.events.length === 0 && page.gap === undefined && page.cursor === `${this.generation}:${after}` && input.waitMs > 0) {
      await this.wait(input.waitMs, input.signal);
      page = this.page(after, input, undefined);
    }
    return page;
  }

  close(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private page(
    after: number,
    input: { sources: readonly EventSource[]; channels: readonly string[]; includeMemoryContent: boolean; limit: number },
    gap: EventPage["gap"],
  ): EventPage {
    const sources = new Set(input.sources);
    const channels = new Set(input.channels);
    const events: UnifiedEvent[] = [];
    let examined = after;
    for (const entry of this.entries) {
      if (entry.sequence <= after) continue;
      examined = entry.sequence;
      const allowed = sources.has(entry.source) &&
        (entry.source !== "gateway" || entry.channel === undefined || channels.has(entry.channel));
      if (allowed) events.push(this.project(entry, input.includeMemoryContent));
      if (events.length >= input.limit) break;
    }
    return {
      daemonGeneration: this.generation,
      cursor: `${this.generation}:${examined}`,
      events,
      ...(gap === undefined ? {} : { gap }),
    };
  }

  private project(entry: JournalEntry, includeMemoryContent: boolean): UnifiedEvent {
    const { privatePayload, retainedBytes: _retainedBytes, ...event } = entry;
    if (includeMemoryContent && entry.channel === "memory" && privatePayload !== undefined) {
      return { ...event, payload: privatePayload };
    }
    return event;
  }

  private async wait(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (this.waiters.size >= EVENT_WAITER_LIMIT) {
      throw new CliError("event_subscriber_limit", "Event subscriber limit is reached.");
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, waitMs);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }
}

export class DaemonEventManager {
  readonly journal: EventJournal;
  private readonly controller = new AbortController();
  private gatewayLoop?: Promise<void>;
  private closed = false;

  constructor(
    generation: string,
    private readonly deps: CliDeps,
    private readonly startedAt: number,
  ) {
    this.journal = new EventJournal(generation, deps.now);
    this.journal.publish({
      source: "daemon",
      kind: "started",
      payload: { daemonPid: process.pid, startedAt },
    });
  }

  read(input: {
    cursor?: string;
    sources: readonly EventSource[];
    channels: readonly string[];
    includeMemoryContent: boolean;
    limit: number;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<EventPage> {
    this.startGatewayLoop();
    return this.journal.read(input);
  }

  publishJob(input: { jobId: string; state: string; reason?: string; cancelOperationId?: string }): void {
    this.journal.publish({
      source: "job",
      kind: "state",
      operationId: input.cancelOperationId ?? input.jobId,
      payload: {
        jobId: input.jobId,
        state: input.state,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.cancelOperationId === undefined ? {} : { cancelOperationId: input.cancelOperationId }),
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.journal.publish({ source: "daemon", kind: "stopping", payload: { startedAt: this.startedAt } });
    this.controller.abort();
    await this.gatewayLoop?.catch(() => undefined);
    this.journal.close();
  }

  private startGatewayLoop(): void {
    if (this.gatewayLoop || this.closed) return;
    this.gatewayLoop = this.runGatewayLoop();
  }

  private async runGatewayLoop(): Promise<void> {
    const client = new GatewayClient({ ...this.deps, transport: "local", signal: this.controller.signal });
    let priorGateway: { pid: number; startedAt: number } | undefined;
    while (!this.controller.signal.aborted) {
      try {
        const opened = await client.openEventStream([...ALLOWED_EVENT_CHANNELS], 25_000);
        const currentGateway = gatewayMeta(opened.discovery);
        if (priorGateway && (priorGateway.pid !== currentGateway.pid || priorGateway.startedAt !== currentGateway.startedAt)) {
          this.journal.publish({
            source: "gateway",
            kind: "generation-changed",
            gateway: currentGateway,
            payload: { previous: priorGateway, current: currentGateway },
          });
        }
        priorGateway = currentGateway;
        if (!opened.response.body) throw new CliError("gateway_unreachable", "Gateway event stream had no body.");
        for await (const frame of parseSse(opened.response.body, {
          signal: this.controller.signal,
          onGap: (reason) => {
            this.journal.publish({
              source: "gateway",
              kind: "gap",
              gateway: currentGateway,
              payload: { reason, resumable: false },
            });
          },
        })) {
          if (this.controller.signal.aborted) return;
          const record = isRecord(frame) ? frame : {};
          const channel = asString(record.channel);
          if (!ALLOWED_EVENT_CHANNELS.includes(channel as (typeof ALLOWED_EVENT_CHANNELS)[number])) continue;
          this.journal.publish({
            source: "gateway",
            kind: "event",
            channel,
            gateway: currentGateway,
            payload: redactEventPayload(channel, record.payload, false),
            ...(channel === "memory" ? { privatePayload: redactEventPayload(channel, record.payload, true) } : {}),
          });
        }
        if (!this.controller.signal.aborted) {
          this.journal.publish({
            source: "gateway",
            kind: "gap",
            gateway: currentGateway,
            payload: { reason: "stream_disconnected", resumable: false },
          });
        }
      } catch (error) {
        if (this.controller.signal.aborted) return;
        this.journal.publish({
          source: "gateway",
          kind: "gap",
          ...(priorGateway === undefined ? {} : { gateway: priorGateway }),
          payload: {
            reason: error instanceof CliError && error.code === "gateway_unauthorized"
              ? "gateway_unauthorized"
              : "gateway_unreachable",
            resumable: false,
          },
        });
      }
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const done = () => {
          clearTimeout(timer);
          this.controller.signal.removeEventListener("abort", done);
          resolve();
        };
        timer = setTimeout(done, 1_000);
        this.controller.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
