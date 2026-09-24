import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { inferenceMemoryLayer, memoryExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { piCompactionAlgorithmLayer } from "../src/internal/context/pi-compaction.ts";
import { createHostContextControl, HOST_CONTEXT_CONTROL_SYMBOL } from "../src/internal/host/context-control.node.ts";
import { CONTEXT_MAINTENANCE_SLICES } from "../src/internal/host/context-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { CONTEXT_SHAPED_HOST } from "./context-shaped-host.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { ownedNativeSummary } from "./context-native-fixture.ts";

for (const addedField of [false, true]) for (const hooked of [false, true]) {
  test(`context shell patches only run and preserves native exports: added-field=${addedField} hook=${hooked}`, async () => {
    const recipe = CONTEXT_MAINTENANCE_SLICES.find(slice => slice.id === "context-manual-shell-owner")!;
    const source = addedField ? CONTEXT_SHAPED_HOST.replace("    run,\n    steer,", "    run,\n    activeTurnOriginatingFlow: () => host.flow,\n    steer,") : CONTEXT_SHAPED_HOST;
    const transformed = transformUnchecked(source, [recipe]);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;
    let wrapCalls = 0, busy: (() => boolean) | undefined, wrapped: unknown;
    const host = { flow: "owned-first", onRun: async () => { if (busy) expect(busy()).toBe(true); return "owned-result"; }, onSettled: () => undefined };
    const control = { wrapRun(actualHost: unknown, run: (...args: unknown[]) => Promise<unknown>, isBusy: () => boolean, interrupt: unknown) {
      expect(actualHost).toBe(host); expect(typeof interrupt).toBe("function");
      wrapCalls++; busy = isBusy; wrapped = (...args: unknown[]) => run(...args); return wrapped;
    } };
    const createShell = runInNewContext(`${transformed.source}\ncreateTurnRunShell;`, {
      Symbol, hostStatusArgs: {}, rpcBoolean: () => false,
      ...(hooked ? { [Symbol.for(HOST_CONTEXT_CONTROL_SYMBOL)]: control } : {}),
    });
    const shell = createShell(host);
    expect(Object.keys(shell)).toEqual(addedField ? ["run", "activeTurnOriginatingFlow", "steer", "interrupt", "interruptAll"] : ["run", "steer", "interrupt", "interruptAll"]);
    expect(wrapCalls).toBe(hooked ? 1 : 0);
    if (hooked) { expect(shell.run).toBe(wrapped); expect(busy?.()).toBe(false); }
    const value = {}; expect(shell.steer(value)).toBe(value); expect(shell.interruptAll).toBe(shell.interrupt);
    expect(await shell.run("owned-input")).toBe("owned-result");
    if (busy) expect(busy()).toBe(false);
    if (addedField) { expect(shell.activeTurnOriginatingFlow()).toBe("owned-first"); host.flow = "owned-second"; expect(shell.activeTurnOriginatingFlow()).toBe("owned-second"); }
  });
}

test("context shell run replacement still refuses ambiguous or absent exports", () => {
  const recipe = CONTEXT_MAINTENANCE_SLICES.find(slice => slice.id === "context-manual-shell-owner")!;
  for (const [source, code] of [
    [CONTEXT_SHAPED_HOST.replace("    run,\n", "    run: unavailableRun,\n"), "find-missing"],
    [CONTEXT_SHAPED_HOST.replace("  return {\n    run,\n", "  if (host.other) {\n  return {\n    run,\n  };\n  }\n  return {\n    run,\n"), "find-duplicate"],
  ]) expect(transformUnchecked(source!, [recipe])).toMatchObject({ ok: false, code, sliceId: recipe.id });
});

const AGENT = "00000000-0000-4000-8000-000000000919", MODEL = "owned/control";
const hex = (char: string) => char.repeat(64);
function ownedOwnership() {
  const at = new Date().toISOString(), local = { harness: "box", serverId: "owned-server" };
  return { grokboxOwnership: { schemaVersion: 3, source: "Host.official-client/ListGrokBotAgents", state: "observed",
    observedAt: at, completedAt: at, serverObservedAt: at, scope: { id: hex("a"), stable: true },
    localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } },
    localExecution: { before: { allowed: true, bound: true }, after: { allowed: true, bound: true } },
    agents: [{ agentId: AGENT, serverEvidence: "found", server: { agentId: AGENT, serverId: "owned-server", harness: "box", viewerIsOwner: true },
      local: { before: local, after: local, stable: true } }] } };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Actual manual facade, Host client, Unix kernel and SDK. Only the native shell,
 * summary methods and remote service are controlled doubles. This proves the
 * manual operation/queue boundary, not actual App input or native blob storage. */
for (const failure of ["none", "summary-503", "checkpoint-unknown", "append-unknown", "cancel", "cancel-after-publication"] as const) {
  test(`manual native action + queued ordinary input: ${failure}, exact operation dedupe and no fake STEP`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-context-control-"));
    const durableRoot = join(dir, "durable"), runRoot = join(dir, "run"); await mkdir(durableRoot);
    const started = gate(), unblock = gate(), checkpointEntered = gate(), checkpointRelease = gate();
    const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    const http = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      if (requests.length === 1) { started.release(); await unblock.promise; }
      if (response.destroyed) return;
      if (failure === "summary-503") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "api_error", message: "PRIVATE_CONTROL_ERROR" } })); return;
      }
      const facts = [...new Set(JSON.stringify(body.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
      const text = `## Critical Context\n${facts.join("\n")}\nContinue the next real user input.`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "control", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: "control", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); if (!address || typeof address === "string") throw Error("fixture unavailable");
    const models = parseModelsFile({ version: 3, models: { [MODEL]: { provider: "openai", model: "owned-control", endpoint: `http://127.0.0.1:${address.port}/v1`,
      apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000 } }, assignments: { main: null, agents: { [AGENT]: { modelId: MODEL } } } });
    await writeFile(join(durableRoot, "models.json"), JSON.stringify(models));
    const auth = createLiveBackendAuth({ OWNED_KEY: "synthetic-test-only" }), epoch = randomUUID(), history = memoryExecutionHistory();
    const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(Layer.merge(admitAllAuthorityLayer()), Layer.merge(auth.layer),
      Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)), Layer.merge(piCompactionAlgorithmLayer), Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch, history })));
    const listening = await Effect.runPromise(Deferred.make<void>());
    const server = Effect.runFork(Effect.scoped(serveModeld({ path: join(runRoot, "modeld.sock"), generation: epoch }).pipe(
      Effect.andThen(Deferred.succeed(listening, undefined)), Effect.andThen(Effect.never), Effect.provide(layer))));
    const signal = new AbortController();
    let manual: Promise<unknown> | undefined, pendingUser: Promise<unknown> | undefined;
    try {
      await Effect.runPromise(Deferred.await(listening).pipe(Effect.timeout("2 seconds")));
      const binding = { generationId: hex("a"), activationId: "owned", pid: 1, start: 1, sourceSha: hex("b"), identitySha: hex("c") };
      const compile = { profileId: "t21-state-root", profileSha256: hex("e"), sourceSha256: hex("b"), transformedSha256: hex("d") };
      const options = { mode: "route" as const, durableRoot, runRoot, binding, compile };
      const control = createHostContextControl(options), native = ownedNativeSummary();
      let current: unknown[] = [{ role: "system", content: "Preserve known facts." },
        ...Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `FACT_${index}=value${index}; ${"ordinary history ".repeat(700)}` })),
        { role: "user", content: "LATEST_ORIGINAL_INPUT: retain this exactly.", providerOptions: { owned: { nonce: "original" } } }];
      const original = structuredClone(current), realInputs: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
      const nativeCalls: Array<{ prompt: string; operationId: string }> = [];
      let checkpoints = 0, capturedSteps = 0;
      const host = { getConversationId: () => AGENT, getTranscriptId: () => AGENT,
        getConversationState: () => ({ rootPromptMessagesJson: current, pendingToolCalls: [] }) };
      const run = async (prompt: string, runOptions?: Record<string, unknown>) => {
        const operation = control.manualOptions(host, runOptions);
        if (!operation) { realInputs.push({ prompt, options: runOptions }); return { acceptedByOwnedShell: true }; }
        nativeCalls.push({ prompt, operationId: operation.operationId });
        const session = bindHostSessionHook(options)({ agentId: AGENT,
          sessionOptions: { agentId: AGENT, invocationId: operation.operationId }, originalSession: { getExecutor() { throw Error("official-fallback-forbidden"); } } });
        if (!isHostPromptSession(session)) throw Error("managed session unavailable");
        const executor = session.getExecutor(current);
        const root = { getMessages: () => executor.getMessages(), getState: () => executor.getState(), clearMessages: () => executor.clearMessages(),
          appendMessages: (messages: unknown[]) => {
            if (failure === "append-unknown") throw Error("PRIVATE_APPEND_FAILURE");
            return executor.appendMessages(messages);
          } };
        try {
          return await control.manualAction({ agentId: AGENT, turnId: operation.operationId, capture: () => ({
            ...native, stateHandler: native.state, rootPromptExecutor: root, ctx: { signal: signal.signal }, config: { agentSessionId: "" },
            agentId: AGENT, turnId: operation.operationId,
            normalizeContext: (messages: unknown[]) => messages, contextFixedMessages: () => [root.getMessages()[0]], contextTools: () => [],
            contextCheckpoint: async () => { checkpoints++;
              if (failure === "cancel-after-publication") { checkpointEntered.release(); await checkpointRelease.promise; }
              await writeFile(join(dir, "checkpoint.json"), JSON.stringify(root.getState()));
              if (failure === "checkpoint-unknown") throw Error("synthetic lost checkpoint acknowledgement"); },
          }) });
        } finally { current = root.getMessages(); }
      };
      const wrapped = control.wrapRun(host, run, () => false, () => signal.abort()) as typeof run;
      // Count any accidental main STEP storage separately from summary calls.
      const originalPutStep = history.putStep;
      history.putStep = (...args) => { capturedSteps++; return originalPutStep(...args); };
      const originalPutIdentity = history.putIdentity;
      history.putIdentity = (...args) => { capturedSteps++; return originalPutIdentity(...args); };
      const initial: any = await control.call({ action: "status", agentId: AGENT });
      expect(initial).toMatchObject({ ok: true, data: { nativeCapability: "ready", currentNativeRoot: "not-observed" } });
      expect(requests).toHaveLength(0); expect(checkpoints).toBe(0);
      expect(control.manualOptions(host, { operationId: "forged", hidden: true })).toBeUndefined();
      expect(await control.call({ action: "compact", agentId: AGENT, operationId: "unconfirmed" }, async () => ownedOwnership())).toMatchObject({ ok: false });
      const approval = { scopeId: hex("a"), hostGeneration: initial.data.hostGeneration, selectionRevision: initial.data.selectionRevision, policyRevision: initial.data.configured.policy.revision };
      const operationId = `manual-${failure}`, command = { action: "compact", agentId: AGENT, sessionId: "", operationId, confirm: true, approval: JSON.stringify(approval) };
      for (const changed of [{ scopeId: hex("f") }, { hostGeneration: hex("f") }, { selectionRevision: hex("f") }]) {
        expect(await control.call({ ...command, approval: JSON.stringify({ ...approval, ...changed }) }, async () => ownedOwnership())).toMatchObject({ ok: false });
      }
      expect(requests).toHaveLength(0); expect(nativeCalls).toHaveLength(0);
      manual = control.call(command, async () => ownedOwnership());
      await Promise.race([started.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("summary did not start")), 5000); timer.unref(); })]);
      expect(nativeCalls).toEqual([{ prompt: "", operationId }]);
      expect(capturedSteps).toBe(0); expect(realInputs).toHaveLength(0);
      const busy: any = await control.call({ action: "status", agentId: AGENT });
      expect(busy.data.nativeCapability).toBe("busy");
      expect(await control.call({ ...command, operationId: "competing" }, async () => ownedOwnership())).toMatchObject({ ok: false, error: { code: "maintenance_busy" } });
      const inputOptions = { nonce: "QUEUED_REAL_INPUT" };
      pendingUser = wrapped("A genuinely new ordinary input", inputOptions).then(
        value => ({ ok: true, value }), error => ({ ok: false, error }));
      await Promise.resolve();
      expect(realInputs).toHaveLength(0);
      if (failure === "cancel") signal.abort();
      unblock.release();
      if (failure === "cancel-after-publication") {
        await checkpointEntered.promise;
        signal.abort(); checkpointRelease.release();
      }
      const outcome: any = await manual;
      const userOutcome: any = await pendingUser;
      expect(outcome.ok).toBe(failure === "none");
      if (failure === "summary-503") expect(outcome.error.code).toBe("summary_unavailable");
      const uncertain = failure === "checkpoint-unknown" || failure === "append-unknown" || failure === "cancel-after-publication";
      if (uncertain) {
        expect(outcome.error.code).toBe("commit_unknown");
        expect(userOutcome).toMatchObject({ ok: false, error: { code: "commit_unknown" } });
        expect(realInputs).toHaveLength(0); // The native runner did not consume the queued user input.
      } else {
        expect(userOutcome.ok).toBe(true);
        expect(realInputs).toEqual([{ prompt: "A genuinely new ordinary input", options: inputOptions }]);
      }
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_CONTROL_ERROR");
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_APPEND_FAILURE");
      expect(capturedSteps).toBe(0);
      const committed = failure === "none" || failure === "checkpoint-unknown" || failure === "cancel-after-publication";
      expect(checkpoints).toBe(committed ? 1 : 0);
      if (failure === "append-unknown") expect(current).toEqual([]); // A partial native clear is not a rollback.
      else {
        expect(current.at(-1)).toEqual(original.at(-1));
        if (!committed) expect(current).toEqual(original);
        else { expect(JSON.stringify(current)).toContain("FACT_0=value0"); expect(current.length).toBeLessThan(original.length); }
      }
      const httpBeforeDuplicate = requests.length, nativeBeforeDuplicate = nativeCalls.length;
      await control.call(command, async () => ownedOwnership());
      expect(requests).toHaveLength(httpBeforeDuplicate); expect(nativeCalls).toHaveLength(nativeBeforeDuplicate);
      const final: any = await control.call({ action: "status", agentId: AGENT });
      expect(final.data.nativeCapability).toBe(uncertain ? "blocked" : "ready");
      expect(final.data.nativeBlockReason).toBe(uncertain ? "commit_unknown" : null);
      if (uncertain) {
        await expect(wrapped("Later input must not bypass the uncertain root", { nonce: "LATER" })).rejects.toMatchObject({ code: "commit_unknown" });
        expect(await control.call({ ...command, operationId: "different-id-not-a-recovery" }, async () => ownedOwnership()))
          .toMatchObject({ ok: false, error: { code: "commit_unknown" } });
        expect(realInputs).toHaveLength(0);
        expect(requests).toHaveLength(httpBeforeDuplicate); expect(nativeCalls).toHaveLength(nativeBeforeDuplicate);
      }
      expect(requests.every(body => body.messages[0]?.content.includes("context summarization assistant"))).toBe(true);
    } finally {
      signal.abort(); unblock.release(); checkpointRelease.release();
      await Promise.allSettled([manual, pendingUser].filter((value): value is Promise<unknown> => value !== undefined));
      await Effect.runPromise(Fiber.interrupt(server));
      await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
}
