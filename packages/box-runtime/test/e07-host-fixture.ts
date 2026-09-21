import { runInNewContext } from "node:vm";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostEventsPath } from "../src/internal/host/terminal-journal.node.ts";
import { SYNTHETIC_OPENAI } from "./context-continuity-fixture.ts";
import { applyPatchProfile, profileFromSource, HOST_AUX_SYMBOL, ROUTE_SESSION_SYMBOL, type SlicePatch } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { wrapHostAuxExecutor } from "../src/internal/host/aux-purpose.ts";
import type { HostPromptSession } from "../src/internal/host/session.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

export const E07_TURN = "inv-live-shaped";
export const E07_STEP = "step-host-parent";

/** Independently authored consumers. No native prompt/policy/store implementation. */
export const E07_HOST_SUPPORT = `
const requestIdKey = Symbol("fixture-turn");
function fixtureContext(turnId = "inv-live-shaped", signal = new AbortController().signal) {
  return { signal, get(key) { return key === requestIdKey ? turnId : undefined; } };
}
async function fixtureCollect(executor, ctx, text) {
  executor.appendMessages([
    { role: "system", content: "owned-fixture-aux-root" },
    { role: "user", content: text }
  ]);
  const result = executor.stream(ctx, undefined, undefined, {});
  let collected = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") collected += part.textDelta;
    if (part.type === "error") throw new Error("fixture inference failed");
  }
  return collected;
}
function extractMemories(args) { return fixtureCollect(args.executor, args.ctx, args.userMessage); }
function summarizeEpisode(args) { return fixtureCollect(args.executor, args.ctx, JSON.stringify(args.turns)); }
// Mirrors the required forwarding ABI, not the native usage algorithm.
function fixtureUsage(session) {
  const get = (state) => {
    const inner = session.getExecutor(state);
    const outer = {
      appendMessages(messages) { inner.appendMessages(messages); return outer; },
      getMessages: () => inner.getMessages(), getState: () => inner.getState(),
      clearMessages: () => inner.clearMessages(),
      stream(ctx, id, tools, options) { return inner.stream(ctx, id, tools, options); }
    };
    return outer;
  };
  return { getModelId: () => session.getModelId(), getExecutor: get, getExecutorWithoutResolvedModelTracking: get };
}
function createCursorInferencePromptSession() {
  return {
    getModelId: () => "official",
    getExecutor: () => ({
      appendMessages() { return this; }, getMessages: () => [], getState: () => [], clearMessages() {},
      stream(ctx, id, tools, options) {
        fixtureOfficial.push({ ctx, id, tools, options });
        return {
          response: Promise.resolve({ modelId: "official", messages: [], finishReason: "stop" }),
          usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
          extendedUsage: Promise.resolve({}), providerMetadata: Promise.resolve({}), invocationId: Promise.resolve(id),
          fullStream: { async *[Symbol.asyncIterator]() { yield { type: "text-delta", textDelta: "official-fixture" }; } }
        };
      }
    }),
    getExecutorWithoutResolvedModelTracking() { return this.getExecutor(); }
  };
}
const fixtureOfficial = [];
async function fixtureSession(agentId = "agent-tom") {
  return fixtureUsage(await runTurn({ getConversationId: () => agentId, subagentModelId: "official", inference: api }));
}
module.exports = { ...module.exports, fixtureContext, fixtureSession, fixtureOfficial };
`;

export type E07Context = { signal: AbortSignal; get: (key: unknown) => string | undefined };
export type E07Memory = { purpose: string; text: string };
export type E07Host = {
  fixtureSession: (agentId?: string) => Promise<HostPromptSession>;
  fixtureContext: (turnId?: string, signal?: AbortSignal) => E07Context;
  fixtureOfficial: Array<{ ctx: unknown; id: unknown; tools: unknown; options: unknown }>;
  runTurnMemory: (store: { addMemory?: (row: E07Memory) => void; recordMemoryEvidence?: (row: unknown) => void }, pending: unknown[], session: HostPromptSession, ctx: E07Context, ts: number, exchange: { user: string; agent: string }) => Promise<void>;
};

export function loadE07Host(input: {
  hook: (args: Parameters<ReturnType<typeof import("../src/internal/host/session-hook.ts").bindHostSessionHook>>[0]) => unknown;
  slices?: readonly SlicePatch[];
  auxHook?: typeof wrapHostAuxExecutor | null;
}): E07Host {
  const source = LIVE_SHAPED_HOST + E07_HOST_SUPPORT;
  const profile = profileFromSource(source, input.slices ?? LIVE_SLICE_PATCHES, "e07-shaped");
  const transformed = applyPatchProfile(source, profile);
  if (!transformed.ok) throw Error(transformed.code);
  const context = {
    module: { exports: {} }, AbortController,
    [Symbol.for(ROUTE_SESSION_SYMBOL)]: input.hook,
    [Symbol.for(HOST_AUX_SYMBOL)]: input.auxHook === null ? undefined : input.auxHook ?? wrapHostAuxExecutor,
  };
  runInNewContext(transformed.source, context);
  return context.module.exports as E07Host;
}

export async function writeE07Models(dir: string) {
  await writeFile(join(dir, "models.json"), JSON.stringify({
    version: 3, models: { [SYNTHETIC_OPENAI.id]: SYNTHETIC_OPENAI },
    assignments: { main: null, agents: { "agent-tom": { modelId: SYNTHETIC_OPENAI.id } } },
  }));
}

export async function auxiliaryEvents(dir: string, count: number) {
  const deadline = Date.now() + 3000;
  let rows: Array<Record<string, unknown>> = [];
  do {
    const text = await readFile(hostEventsPath(dir), "utf8").catch(() => "");
    rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.auxPurpose !== undefined);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw Error(`missing auxiliary event: expected ${count}, observed ${rows.length}`);
}
