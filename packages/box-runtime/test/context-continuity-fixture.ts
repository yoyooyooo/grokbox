/**
 * Owned Host-contract fixture for managed context continuity.
 *
 * Independent oracles live here. Do not import production context-codec,
 * openai-prompt-adapter, or compact algorithms to generate expected values.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { computeSelectionRevision, parseModelsFile, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { writeRuntimeArtifact } from "../src/internal/io/artifacts.node.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { asHostPromptSession, createStreamingPromptSession, type HostPromptSession } from "./packed-host-session.ts";
import { createModeldProduce } from "../src/internal/host/modeld-produce.node.ts";
import type { HostBinding } from "../src/internal/host/host-binding.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

export const HEX = (ch: string) => ch.repeat(64);

export const CONTINUITY_ROOT = "root-from-host";
export const EARLY_SENTINEL = "E03-EARLY-SENTINEL";
export const MID_SENTINEL = "E03-MID-SENTINEL";
export const END_SENTINEL = "E03-END-SENTINEL";
export const UNICODE_SENTINEL = "中文哨兵αβγ";
export const UI_DECOY = "UI-DECOY-NEVER-SEND";
export const FACT_ALPHA = "FACT-ALPHA-ONLY-IN-EARLY";
export const TAIL_KEEP = "TAIL-KEEP-AFTER-COMPACT";
export const ARCHIVED_ONLY = "ARCHIVED-ORIGINAL-MUST-NOT-RETURN";
export const TOOL_BODY = `TOOLTAIL-${"K".repeat(64 * 1024)}`;
export const PAD_BODY = `PAD-${"Q".repeat(200 * 1024)}`;
export const LOOKUP_TOOL = {
  name: "lookup",
  description: "lookup schema",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

export const TEST_BINDING: HostBinding = {
  generationId: HEX("a"),
  activationId: "op-1",
  pid: 1,
  start: 1,
  sourceSha: HEX("b"),
  identitySha: HEX("c"),
};

export const SYNTHETIC_W = 200000;
export const HOST_S_USED = 180000;
export const HOST_P_USED = 190000;

export const SYNTHETIC_OPENAI: ModelRecord = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://ccs.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
  contextWindowTokens: SYNTHETIC_W,
};

export const SYNTHETIC_OPENAI_NO_WINDOW: ModelRecord = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://ccs.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};

export type ProviderUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type HostUsagePhase = "mid-loop" | "turn-tail";

/** Threshold oracle only. Accept/commit live in createHostSummaryControl. */
export function hostObserveExtendedUsage(
  extended: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number },
  phase: HostUsagePhase,
) {
  const W = extended.maxTokens;
  const U = extended.inputTokens + extended.outputTokens;
  const started = W > 0 && U >= HOST_S_USED;
  const persist = W > 0 && U >= HOST_P_USED;
  return {
    W,
    U,
    cacheReadTokens: extended.cacheReadTokens,
    cacheWriteTokens: extended.cacheWriteTokens,
    started,
    persist,
    eligible: phase === "mid-loop" ? started : persist,
  };
}

/** Host-owned summary candidate/accept/checkpoint. Not grokbox T32 compact. */
export function createHostSummaryControl(window: HostWindowMessage[]) {
  let released = false;
  let started = false;
  let persist = false;
  let accepted = false;
  const waiters: Array<() => void> = [];
  return {
    get released() { return released; },
    get started() { return started; },
    get persist() { return persist; },
    get accepted() { return accepted; },
    observe(extended: { inputTokens: number; outputTokens: number; maxTokens: number }) {
      const W = extended.maxTokens;
      const U = extended.inputTokens + extended.outputTokens;
      started = W > 0 && U >= HOST_S_USED;
      persist = W > 0 && U >= HOST_P_USED;
      return { W, U, started, persist };
    },
    release() {
      released = true;
      for (const wait of waiters) wait();
      waiters.length = 0;
    },
    wait() {
      if (released) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    accept(phase: HostUsagePhase): HostWindowMessage[] {
      if (!released) throw new Error("summary-incomplete");
      const ok = phase === "mid-loop" ? started : persist;
      if (!ok) throw new Error("summary-not-acceptable");
      accepted = true;
      return hostAcceptSummary(window).window;
    },
    async checkpoint(path: string) {
      if (!accepted) throw new Error("summary-not-accepted");
      const compacted = hostAcceptSummary(window);
      return writeHostRoot(path, compacted.window as unknown[], compacted.archive);
    },
  };
}

export type HostWindowMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  id?: string;
  providerOptions?: Record<string, unknown>;
  isSummary?: boolean;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
};

export type HostWindowRoot = {
  version: 1;
  refs: { sha256: string };
  state: unknown[];
  archive?: unknown[];
};

export function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function padWindow(label: string, padChars: number): HostWindowMessage[] {
  return [
    { role: "user", id: `${label}-head`, content: `E08-${label}-HEAD` },
    { role: "user", id: `${label}-pad`, content: "Q".repeat(padChars) },
    { role: "user", id: `${label}-tail`, content: `E08-${label}-TAIL` },
  ];
}

export type HostEffectRecord = {
  kind: "tool" | "delivery" | "error";
  stepId: string;
  id: string;
  late: boolean;
};

const LIVE_DELIVERY_REASONS = new Set(["stop", "tool-calls"]);

/** Host-owned tool/delivery sink. Delivery requires a successful completion reason, not abort/error. Stream errors propagate. */
export function createHostOutputConsumer() {
  const retired = new Set<string>();
  const effects: HostEffectRecord[] = [];
  return {
    retire(stepId: string) { retired.add(stepId); },
    effects,
    live(kind: HostEffectRecord["kind"]) {
      return effects.filter((row) => row.kind === kind && !row.late);
    },
    async consume(stepId: string, handle: { fullStream: AsyncIterable<{ type: string; reason?: string; finishReason?: string; toolCallId?: string; toolName?: string; textDelta?: string; text?: string }> }) {
      let delivered = false;
      try {
        for await (const part of handle.fullStream) {
          const late = retired.has(stepId);
          if (part.type === "tool-call" && typeof part.toolCallId === "string") {
            effects.push({ kind: "tool", stepId, id: part.toolCallId, late });
          }
          if (part.type === "finish") {
            const reason = part.reason ?? part.finishReason;
            if (typeof reason === "string" && LIVE_DELIVERY_REASONS.has(reason)) delivered = true;
          }
        }
      } catch (error) {
        effects.push({ kind: "error", stepId, id: `${stepId}:error`, late: retired.has(stepId) });
        throw error;
      }
      if (delivered) {
        effects.push({ kind: "delivery", stepId, id: `${stepId}:delivery`, late: retired.has(stepId) });
      }
    },
  };
}

export type HostMemoryRecord = { purpose: "memory-extraction" | "episode"; auxRequestId: string; text: string };

/** Host-owned Memory writer. grokbox must not replace this. */
export function createHostMemoryControl() {
  const memories: HostMemoryRecord[] = [];
  const evidence: Array<{ id: string; note: string }> = [];
  let turns = 0;
  return {
    memories,
    evidence,
    recordMemoryEvidence(note: string) {
      evidence.push({ id: `ev-${evidence.length + 1}`, note });
    },
    noteTurn() { turns += 1; return turns; },
    episodeDue(interval: number) {
      return interval > 0 && turns > 0 && turns % interval === 0;
    },
    commit(result: { kind: string; purpose?: string; auxRequestId?: string; text?: string }) {
      if (result.kind !== "ok" || (result.purpose !== "memory-extraction" && result.purpose !== "episode")) return;
      if (typeof result.auxRequestId !== "string" || typeof result.text !== "string" || result.text.length === 0) return;
      memories.push({ purpose: result.purpose, auxRequestId: result.auxRequestId, text: result.text });
    },
  };
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

export function metadataWindow(): HostWindowMessage[] {
  return [
    {
      role: "system",
      id: "sys-1",
      content: "root-once",
      providerOptions: { cursor: { inferenceReason: "system" } },
    },
    {
      role: "user",
      id: "u-1",
      isSummary: true,
      content: [{ type: "text", text: "summarized-intent", providerOptions: { cursor: { userInfoSummarizationEpoch: 3 } } }],
      providerOptions: { cursor: { isSummary: true, userInfoSummarizationEpoch: 3 } },
    },
    {
      role: "assistant",
      id: "a-1",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", args: { q: "seed" } }],
    },
    {
      role: "user",
      id: "tr-1",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "lookup", result: { rows: [1] }, isError: false }],
    },
  ];
}

export function longZeroCapWindow(): { window: HostWindowMessage[]; bytes: number } {
  const window: HostWindowMessage[] = [];
  window.push({ role: "user", id: "u-early", content: EARLY_SENTINEL });
  for (let i = 1; i <= 597; i += 1) {
    window.push({
      role: "user",
      id: `u-${i}`,
      content: i === 300 ? MID_SENTINEL : `m-${i}`,
    });
  }
  window.push({ role: "user", id: "u-unicode", content: UNICODE_SENTINEL });
  window.push({ role: "user", id: "u-pad", content: PAD_BODY });
  window.push({
    role: "assistant",
    id: "a-tool",
    content: [{ type: "tool-call", toolCallId: "c-e03", toolName: "lookup", args: { q: "tail" } }],
  });
  window.push({
    role: "user",
    id: "u-tool",
    content: [
      { type: "text", text: "user-contained-result" },
      { type: "tool-result", toolCallId: "c-e03", toolName: "lookup", result: { blob: TOOL_BODY }, isError: false },
    ],
  });
  window.push({ role: "user", id: "u-end", content: END_SENTINEL });
  const bytes = Buffer.byteLength(JSON.stringify(window));
  return { window, bytes };
}

export function compactJourneyWindow(): HostWindowMessage[] {
  return [
    { role: "user", id: "u-arch", content: ARCHIVED_ONLY },
    { role: "user", id: "u-fact", content: FACT_ALPHA },
    { role: "assistant", id: "a-mid", content: "mid-turn" },
    { role: "user", id: "u-tail", content: TAIL_KEEP },
    {
      role: "assistant",
      id: "a-tail",
      content: [{ type: "tool-call", toolCallId: "c-e04", toolName: "lookup", args: { q: "tail" } }],
    },
    {
      role: "user",
      id: "u-result",
      content: [{ type: "tool-result", toolCallId: "c-e04", toolName: "lookup", result: { ok: true }, isError: false }],
    },
  ];
}

/** Host-owned compact policy. Not grokbox codec/compact. */
export function hostAcceptSummary(window: HostWindowMessage[], epoch = 1): {
  window: HostWindowMessage[];
  archive: HostWindowMessage[];
  summaryText: string;
  epoch: number;
} {
  const archive = window.slice(0, -3);
  const tail = window.slice(-3);
  const facts = window
    .flatMap((message) => typeof message.content === "string" ? [message.content] : [])
    .filter((text) => text.includes(FACT_ALPHA) && !text.includes(ARCHIVED_ONLY))
    .map((text) => (text.includes(FACT_ALPHA) ? FACT_ALPHA : text));
  const summaryText = `HOST_SUMMARY epoch=${epoch} facts=${[...new Set(facts)].join("|") || FACT_ALPHA}`;
  const carrier: HostWindowMessage = {
    role: "user",
    id: `sum-${epoch}`,
    isSummary: true,
    content: [{
      type: "text",
      text: summaryText,
      providerOptions: { cursor: { userInfoSummarizationEpoch: epoch } },
    }],
    providerOptions: { cursor: { isSummary: true, userInfoSummarizationEpoch: epoch } },
  };
  return { window: [carrier, ...tail], archive, summaryText, epoch };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Independent Chat/Responses content oracle. Must not call production encodeOpenaiPrompt. */
export function independentProviderTexts(window: HostWindowMessage[]): string[] {
  const out: string[] = [];
  for (const message of window) {
    if (typeof message.content === "string") {
      if (message.content.length > 0) out.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.type !== "string") continue;
      if (part.type === "text" && typeof part.text === "string") {
        out.push(part.text);
        continue;
      }
      if (part.type === "tool-call") {
        out.push(JSON.stringify({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
        }));
        continue;
      }
      if (part.type === "tool-result") {
        out.push(JSON.stringify({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result,
          isError: part.isError === true,
        }));
      }
    }
  }
  return out;
}

export function extractHttpStringBlob(body: unknown): string {
  return JSON.stringify(body ?? null);
}

/** Decode native protocol items independently. The earlier substring oracle
 * expected JSON-in-text tool history even though production sends native calls;
 * it failed on the unchanged baseline. Exact structural comparison kills
 * missing/reordered/duplicated calls and results, not just missing sentinels. */
export function assertIndependentGoldenInHttp(body: unknown, window: HostWindowMessage[], root = CONTINUITY_ROOT): void {
  if (!isRecord(body)) throw new Error("independent-golden: missing HTTP body");
  const expected: unknown[] = [], actual: unknown[] = [], roots: string[] = [];
  const text = (out: unknown[], role: unknown, value: unknown) => {
    if (typeof value === "string" && value.length) out.push({ kind: "text", role, text: value });
  };
  for (const message of window) {
    if (message.role === "system") continue;
    if (typeof message.content === "string") { text(expected, message.role, message.content); continue; }
    if (!Array.isArray(message.content)) throw Error("independent-golden: unsupported Host content");
    for (const part of message.content) {
      if (!isRecord(part)) throw Error("independent-golden: unsupported Host part");
      if (part.type === "text" || part.type === "reasoning") text(expected, message.role, part.text);
      else if (part.type === "tool-call") expected.push({ kind: "call", id: part.toolCallId, name: part.toolName, args: part.args });
      else if (part.type === "tool-result") expected.push({ kind: "result", id: part.toolCallId, result: part.result });
      else throw Error("independent-golden: unqualified Host part");
    }
  }
  const decode = (value: unknown) => { if (typeof value !== "string") throw Error("independent-golden: non-string wire JSON"); return JSON.parse(value); };
  if (typeof body.instructions === "string") roots.push(body.instructions);
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (const item of messages) {
    if (!isRecord(item)) throw Error("independent-golden: malformed wire item");
    if (item.role === "system") {
      if (typeof item.content === "string") roots.push(item.content);
      else if (Array.isArray(item.content)) roots.push(item.content.map(p => isRecord(p) && typeof p.text === "string" ? p.text : "").join(""));
      continue;
    }
    if (item.type === "function_call") { actual.push({ kind: "call", id: item.call_id, name: item.name, args: decode(item.arguments) }); continue; }
    if (item.type === "function_call_output" || item.role === "tool") { actual.push({ kind: "result", id: item.call_id ?? item.tool_call_id, result: decode(item.output ?? item.content) }); continue; }
    if (typeof item.content === "string") text(actual, item.role, item.content);
    else if (Array.isArray(item.content)) for (const part of item.content) {
      if (!isRecord(part) || typeof part.text !== "string") throw Error("independent-golden: unqualified wire content");
      text(actual, item.role, part.text);
    }
    if (Array.isArray(item.tool_calls)) for (const call of item.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) throw Error("independent-golden: malformed wire call");
      actual.push({ kind: "call", id: call.id, name: call.function.name, args: decode(call.function.arguments) });
    }
  }
  if (!isDeepStrictEqual(roots, [root])) throw Error("independent-golden: Host root must occur exactly once");
  if (!isDeepStrictEqual(actual, expected)) {
    const first = Math.max(0, expected.findIndex((part, i) => !isDeepStrictEqual(part, actual[i])));
    throw Error(`independent-golden: ordered native content differs at ${first}; expected=${expected.length}, observed=${actual.length}`);
  }
}

export function assertNoCapStoreOrDecoy(body: unknown): void {
  const blob = extractHttpStringBlob(body);
  if (blob.includes(UI_DECOY)) throw new Error("decoy leaked into provider request");
  if (blob.includes("store.db")) throw new Error("store.db prepended into provider request");
  if (blob.includes("dropCount") || blob.includes("max_messages") || blob.includes("GROKBOX_CONTEXT_CAP")) {
    throw new Error("CAP/truncation field appeared in provider request");
  }
}

export function sseChatOk(text = "ok", usage: ProviderUsage | "omit" = {
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
}): Response {
  const usageObj = usage === "omit" ? undefined : {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    ...(usage.cache_read_tokens !== undefined || usage.cache_write_tokens !== undefined
      ? {
        prompt_tokens_details: {
          ...(usage.cache_read_tokens !== undefined ? { cached_tokens: usage.cache_read_tokens } : {}),
          ...(usage.cache_write_tokens !== undefined ? { cache_write_tokens: usage.cache_write_tokens } : {}),
        },
      }
      : {}),
  };
  const finish: Record<string, unknown> = {
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  if (usageObj) finish.usage = usageObj;
  const chunks = [
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify(finish)}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export async function writeHostRoot(path: string, state: unknown[], archive?: unknown[]): Promise<HostWindowRoot> {
  const payload: HostWindowRoot = {
    version: 1,
    refs: { sha256: sha256Json(state) },
    state,
    ...(archive ? { archive } : {}),
  };
  await writeRuntimeArtifact(path, payload);
  const readBack = JSON.parse(await readFile(path, "utf8")) as HostWindowRoot;
  if (readBack.refs.sha256 !== payload.refs.sha256) throw new Error("host-root-readback-mismatch");
  return payload;
}

export class OwnedRootFault extends Error {
  readonly kind: "before-publish" | "mirror";
  readonly committedSha?: string;
  constructor(kind: "before-publish" | "mirror", committedSha?: string) {
    super(kind === "before-publish" ? "owned-root-publish-fault" : "owned-mirror-fault");
    this.name = "OwnedRootFault";
    this.kind = kind;
    this.committedSha = committedSha;
  }
}

/** Host-owned root publisher. Mirror is a second ledger, not a rollback of committed bytes. */
export async function publishHostRoot(
  path: string,
  state: unknown[],
  archive?: unknown[],
  fault: "none" | "before-publish" | "mirror" = "none",
): Promise<HostWindowRoot> {
  if (fault === "before-publish") throw new OwnedRootFault("before-publish");
  const written = await writeHostRoot(path, state, archive);
  if (fault === "mirror") throw new OwnedRootFault("mirror", written.refs.sha256);
  return written;
}

export async function readHostRoot(path: string): Promise<HostWindowRoot> {
  const value = JSON.parse(await readFile(path, "utf8")) as HostWindowRoot;
  if (value.version !== 1 || !Array.isArray(value.state) || typeof value.refs?.sha256 !== "string") {
    throw new Error("invalid-host-root");
  }
  if (sha256Json(value.state) !== value.refs.sha256) throw new Error("host-root-sha-mismatch");
  return value;
}

export async function writeUiDecoy(dir: string): Promise<string> {
  const path = join(dir, "ui.jsonl");
  await writeFile(path, `${JSON.stringify({ role: "user", content: UI_DECOY })}\n`);
  return path;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function waitReady(runRoot: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (await probeModeldHealth(runRoot, 200)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("modeld not ready");
}

export function produceFor(runRoot: string, turnId: string, model: ModelRecord = SYNTHETIC_OPENAI) {
  return createModeldProduce({
    runRoot,
    agentId: "agent-tom",
    modelId: model.id,
    selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model }),
    binding: TEST_BINDING,
    bridgeDigest: HEX("d"),
    turnId,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    independentRoot: CONTINUITY_ROOT,
  }).produce;
}

function dispatchLayer(generation: string, models: () => ReturnType<typeof parseModelsFile>, fetchImpl: typeof fetch, env: NodeJS.Dict<string>, context?: { windowTokens: number }) {
  const config = fakeConfigurationReadLayer({ models, context, desired: { version: 1, mode: "route" } });
  const auth = createLiveBackendAuth(env);
  return config.pipe(
    Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(auth.layer),
    Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
}

async function serve(path: string, generation: string, layer: Layer.Layer<unknown, never, never>) {
  const fiber = Effect.runFork(Effect.scoped(
    serveModeld({ path, generation }).pipe(
      Effect.andThen(Effect.never),
      Effect.provide(layer),
    ) as Effect.Effect<never, unknown>,
  ));
  await waitReady(join(path, ".."));
  return () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
}

export type CapturedRequest = { body: unknown; text: string };

export async function withFakeHttpSession<T>(input: {
  turnId: string;
  context?: { windowTokens: number };
  model?: ModelRecord;
  contextWindowTokens?: number;
  usage?: ProviderUsage | "omit";
  hold?: Promise<void>;
  inspect?: (body: unknown, text: string) => void;
  respond?: (requestNumber: number) => Response | Promise<Response>;
  fn: (ctx: {
    session: HostPromptSession;
    requests: CapturedRequest[];
    dir: string;
    admitted: Promise<void>;
    updateCanonicalModel: (model: ModelRecord) => void;
    makeSession: (opts: { turnId: string; model: ModelRecord; contextWindowTokens?: number }) => HostPromptSession;
  }) => Promise<T>;
}): Promise<T> {
  const requests: CapturedRequest[] = [];
  const model = input.model ?? SYNTHETIC_OPENAI;
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  let first = true;
  const fetchImpl = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
    const body = JSON.parse(raw) as unknown;
    const text = JSON.stringify(body);
    input.inspect?.(body, text);
    requests.push({ body, text });
    if (first) {
      first = false;
      admit();
    }
    if (input.hold) await input.hold;
    return input.respond ? await input.respond(requests.length) : sseChatOk("ok", input.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  }, { preconnect: async () => undefined }) as typeof fetch;
  const fileOf = (row: ModelRecord) => parseModelsFile({
    version: 1,
    models: { [row.id]: row },
    assignments: { main: null, agents: { "agent-tom": row.id } },
  });
  let models = fileOf(model);
  const dir = await mkdtemp(join(tmpdir(), "grokbox-ctx-cont-"));
  const generation = randomUUID();
  const stop = await serve(
    join(dir, "modeld.sock"),
    generation,
    dispatchLayer(generation, () => models, fetchImpl, { OPENAI_API_KEY: "sk-test" }, input.context) as Layer.Layer<unknown, never, never>,
  );
  const makeSession = (opts: { turnId: string; model: ModelRecord; contextWindowTokens?: number }) => {
    const window = opts.contextWindowTokens ?? opts.model.contextWindowTokens;
    return asHostPromptSession(createStreamingPromptSession({
      modelId: opts.model.id,
      vision: false,
      parallel: "fail-closed",
      produce: produceFor(dir, opts.turnId, opts.model),
    }), opts.model.id, undefined, {
      requireStepId: true,
      ...(window !== undefined ? { contextWindowTokens: window } : {}),
    });
  };
  try {
    const session = makeSession({
      turnId: input.turnId,
      model,
      contextWindowTokens: input.contextWindowTokens ?? model.contextWindowTokens,
    });
    return await input.fn({
      session,
      requests,
      dir,
      admitted,
      updateCanonicalModel: (next) => { models = fileOf(next); },
      makeSession,
    });
  } finally {
    await stop();
  }
}
