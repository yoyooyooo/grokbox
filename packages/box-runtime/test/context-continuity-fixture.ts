/**
 * Owned Host-contract fixture for managed context continuity.
 *
 * Independent oracles live here. Do not import production context-codec,
 * ccs-codec, or compact algorithms to generate expected values.
 */
import { createHash, randomUUID } from "node:crypto";
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
import { asHostPromptSession, createStreamingPromptSession, type HostPromptSession } from "../src/internal/host/session.ts";
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

export const SYNTHETIC_OPENAI: ModelRecord = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://ccs.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
  contextWindowTokens: 200000,
};

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

/** Independent Chat/Responses content oracle. Must not call production encodeCcsMessages. */
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

function indexOfEncoded(blob: string, expected: string, pos: number): number {
  const escaped = JSON.stringify(expected).slice(1, -1);
  const raw = blob.indexOf(expected, pos);
  const enc = blob.indexOf(escaped, pos);
  const hits = [raw, enc].filter((index) => index >= 0);
  return hits.length > 0 ? Math.min(...hits) : -1;
}

export function assertIndependentGoldenInHttp(body: unknown, window: HostWindowMessage[], root = CONTINUITY_ROOT): void {
  const blob = extractHttpStringBlob(body);
  if (!blob.includes(root)) throw new Error("independent-golden: missing Host root");
  let pos = 0;
  for (const expected of independentProviderTexts(window)) {
    const next = indexOfEncoded(blob, expected, pos);
    if (next < 0) throw new Error(`independent-golden: missing ordered content at ${pos}`);
    pos = next + 1;
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

export function sseChatOk(text = "ok"): Response {
  const chunks = [
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
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

function dispatchLayer(generation: string, models: ReturnType<typeof parseModelsFile>, fetchImpl: typeof fetch, env: NodeJS.Dict<string>) {
  const config = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } });
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
  inspect?: (body: unknown, text: string) => void;
  fn: (ctx: {
    session: HostPromptSession;
    requests: CapturedRequest[];
    dir: string;
  }) => Promise<T>;
}): Promise<T> {
  const requests: CapturedRequest[] = [];
  const fetchImpl = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
    const body = JSON.parse(raw) as unknown;
    const text = JSON.stringify(body);
    input.inspect?.(body, text);
    requests.push({ body, text });
    return sseChatOk("ok");
  }, { preconnect: async () => undefined }) as typeof fetch;
  const models = parseModelsFile({
    version: 1,
    models: { [SYNTHETIC_OPENAI.id]: SYNTHETIC_OPENAI },
    assignments: { main: null, agents: { "agent-tom": SYNTHETIC_OPENAI.id } },
  });
  const dir = await mkdtemp(join(tmpdir(), "grokbox-ctx-cont-"));
  const generation = randomUUID();
  const stop = await serve(
    join(dir, "modeld.sock"),
    generation,
    dispatchLayer(generation, models, fetchImpl, { OPENAI_API_KEY: "sk-test" }) as Layer.Layer<unknown, never, never>,
  );
  try {
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id,
      vision: false,
      parallel: "fail-closed",
      produce: produceFor(dir, input.turnId, SYNTHETIC_OPENAI),
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: true, contextWindowTokens: 200000 });
    return await input.fn({ session, requests, dir });
  } finally {
    await stop();
  }
}
