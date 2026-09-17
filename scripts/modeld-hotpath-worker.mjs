import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

/** Same workload for two source trees, in separate processes. This imports the
 * real source root/Unix/Host fixture; only native registration and model HTTP are
 * synthetic. It never builds, writes configuration or starts services in either
 * checkout. All mutable execution state is fixture-owned under the OS temp dir. */
export async function runModeldHotPath(root, options = {}) {
  root = resolve(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.packageManager !== `bun@${process.versions.bun}`) throw new Error("benchmark_toolchain_mismatch");
  const load = path => import(pathToFileURL(join(root, path)).href);
  const { providerRuntimeFixture, waitFixtureRows } = await load("packages/box-runtime/test/provider-runtime-fixture.ts");
  const { bindHostOwnershipRead } = await load("packages/box-runtime/src/internal/host/ownership-read.ts");
  const { failureSummaryOf } = await load("packages/runtime-kernel/src/contract.ts");
  const { buildProvenance } = await load("scripts/build-provenance.mjs");
  const identity = buildProvenance(root);
  const cases = [];
  const runCase = async (fragments, initialDelayMs, steps) => {
    let nativeReads = 0, fullReads = 0, localReads = 0, modelCalls = 0;
    const sourceTimes = [], localTimes = [], stepTimes = [], outcomes = [];
    const gateSamples = [], resourceSamples = [];
    let executionTiming = null;
    const native = bindHostOwnershipRead({ cacheMs: 2000 });
    const read = async (ids, localOnly = false) => {
      const start = performance.now();
      if (localOnly) localReads++; else fullReads++;
      try {
        return { gateway: { pid: process.pid, startedAt: 1 }, snapshot: await native({ agentIds: ids, localOnly,
          readScope: () => ({ backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "synthetic" }),
          readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
          readLocal: () => ({ harness: "box", serverId: "server" }),
          listServer: async signal => {
            nativeReads++;
            // Fixed delays, not inferred from production traffic. Timer belongs
            // to this one bounded synthetic request and honors cancellation.
            const delay = nativeReads === 1 ? initialDelayMs : 2;
            await new Promise((accept, reject) => {
              const abort = () => { clearTimeout(timer); reject(new Error("fixture_aborted")); };
              const timer = setTimeout(() => { signal.removeEventListener("abort", abort); accept(); }, delay);
              if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
            });
            return { agents: ids.map(agentId => ({ agentId, id: "server", harness: "box" })) };
          },
        }) };
      } finally { (localOnly ? localTimes : sourceTimes).push(performance.now() - start); }
    };
    const source = ids => read(ids);
    source.local = ids => read(ids, true);
    const fetch = Object.assign(async input => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://fixture.invalid/v1/chat/completions") throw new Error("benchmark_external_network_forbidden");
      modelCalls++;
      const rows = Array.from({ length: fragments }, () => ({ id: "fixture", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }));
      rows.push({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: fragments, total_tokens: fragments + 1 } });
      return new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }, { preconnect: async () => undefined });
    const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
    let f, cleaned = false;
    try {
      f = await providerRuntimeFixture(fetch, { ownershipRead: source });
      for (let index = 0; index < steps; index++) {
        const stepId = randomUUID(), start = performance.now();
        const handle = f.session.getExecutor([{ role: "system", content: "synthetic root" }, { role: "user", content: "synthetic request" }]).stream({}, stepId);
        let code = "ok", category = null;
        try { await handle.response; }
        catch (error) { const failure = failureSummaryOf(error); code = failure?.code ?? "fixture_failed"; category = failure?.category ?? "unknown"; }
        stepTimes.push(performance.now() - start);
        const rows = await waitFixtureRows(f, stepId);
        const terminal = rows.filter(row => row.name === "model_step_terminal" && row.stepId === stepId);
        if (terminal.length !== 1) throw new Error("benchmark_terminal_not_unique");
        executionTiming = terminal[0].execution?.timing ?? null;
        if (terminal[0].execution) resourceSamples.push({ activeSteps: terminal[0].execution.activeSteps,
          hotTurns: terminal[0].execution.hotTurns, pinnedTurns: terminal[0].execution.pinnedTurns });
        const checks = new Map();
        for (const row of rows) if (row.stepId === stepId && row.name === "model_authority_progress"
          && row.authority?.phase !== "waiting") checks.set(row.authority.check, row.authority);
        for (const check of checks.values()) if (check.diagnostic?.ownershipWait) gateSamples.push(check.diagnostic.ownershipWait);
        outcomes.push({ code, category, backendAttempts: terminal[0].backendAttempts,
          authorityRetries: terminal[0].authority?.retries ?? null, terminalCount: terminal.length });
        if (code !== "ok") break;
      }
    } finally {
      if (f) { await f.stop(); cleaned = true; }
      histogram.disable();
    }
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b);
      const round = value => Number(value.toFixed(3));
      return { count: sorted.length, total: round(sorted.reduce((sum, n) => sum + n, 0)),
        p50: sorted.length ? round(sorted[Math.floor((sorted.length - 1) * .5)]) : null,
        p95: sorted.length ? round(sorted[Math.floor((sorted.length - 1) * .95)]) : null,
        max: sorted.length ? round(sorted.at(-1)) : null };
    };
    return { fragments, initialDelayMs, requestedSteps: steps, completedSteps: outcomes.length, nativeReads, fullReads, localReads,
      modelCalls, outcomes, milliseconds: { step: stats(stepTimes), fullRead: stats(sourceTimes), localRead: stats(localTimes),
        eventLoopMean: Number.isFinite(histogram.mean) ? Number((histogram.mean / 1e6).toFixed(3)) : null,
        eventLoopMax: Number((histogram.max / 1e6).toFixed(3)),
        authorityQueue: stats(gateSamples.flatMap(s => typeof s.queueMs === "number" ? [s.queueMs] : [])),
        authoritySourceWait: stats(gateSamples.flatMap(s => typeof s.sourceWaitMs === "number" ? [s.sourceWaitMs] : [])),
        authorityLocalWitness: stats(gateSamples.flatMap(s => typeof s.localWitnessMs === "number" ? [s.localWitnessMs] : [])),
      }, fixtureCleanupCompleted: cleaned, sampledResources: resourceSamples,
      executionTiming, missingMetrics: [...(executionTiming ? [] : ["separate_lock_and_storage_timing"]),
        ...(gateSamples.length ? [] : ["source_waiter_queue_timing"]), "native_server_processing", "production_sla"] };
  };
  const cancellationCase = async () => {
    const native = bindHostOwnershipRead();
    let modelCalls = 0, sourceCalls = 0, sourceAbortObserved = false, entered, settled;
    const entry = new Promise(resolve => { entered = resolve; });
    const settlement = new Promise(resolve => { settled = resolve; });
    const source = (_ids, signal) => {
      sourceCalls++; entered();
      return new Promise((_resolve, reject) => {
        const abort = () => { sourceAbortObserved = true; reject(new Error("synthetic_read_cancelled")); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      }).finally(() => settled());
    };
    source.local = async ids => ({ gateway: { pid: process.pid, startedAt: 1 }, snapshot: await native({
      agentIds: ids, localOnly: true,
      readScope: () => ({ backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "synthetic" }),
      readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
      readLocal: () => ({ harness: "box", serverId: "server" }), listServer: async () => { throw Error("local_only_started_network"); },
    }) });
    const fetch = Object.assign(async () => { modelCalls++; throw Error("cancelled_step_dispatched_model"); }, { preconnect: async () => undefined });
    const abort = new AbortController();
    let f, timer;
    try {
      f = await providerRuntimeFixture(fetch, { ownershipRead: source });
      const stepId = randomUUID();
      const handle = f.session.getExecutor([{ role: "system", content: "synthetic root" }, { role: "user", content: "synthetic cancellation" }])
        .stream({ abortSignal: abort.signal }, stepId);
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("cancellation_probe_deadline")), 15000); });
      await Promise.race([entry, deadline]);
      const started = performance.now(); abort.abort();
      await handle.response.catch(() => undefined);
      const clientSettledMs = performance.now() - started;
      await Promise.race([settlement, deadline]);
      const sourceSettledMs = performance.now() - started;
      const rows = await waitFixtureRows(f, stepId);
      const terminalCount = rows.filter(row => row.name === "model_step_terminal" && row.stepId === stepId).length;
      await f.stop(); f = undefined;
      return { modelCalls, sourceCalls, sourceAbortObserved, terminalCount, fixtureCleanupCompleted: true,
        milliseconds: { clientSettled: Number(clientSettledMs.toFixed(3)), sourceSettled: Number(sourceSettledMs.toFixed(3)) } };
    } finally { clearTimeout(timer); abort.abort(); await f?.stop(); }
  };
  for (const fragments of [1, 2048]) cases.push(await runCase(fragments, 2, 4));
  if (options.latencyCases === true) for (const delay of [5500, 7750, 9000]) cases.push(await runCase(1, delay, 1));
  const cancellation = await cancellationCase();
  if (buildProvenance(root).sourceDigest !== identity.sourceDigest) throw new Error("benchmark_source_changed");
  return { version: 1, sourceDigest: identity.sourceDigest, toolchain: { bun: process.versions.bun, node: process.versions.node,
    effect: pkg.workspaces.catalogs["effect-v4-beta"].effect, compilerVersion: identity.compilerVersion, sdkVersions: identity.sdkVersions }, dependencyReality: "production source / real Unix and LevelDB / synthetic native registration and model HTTP",
    nativeQualified: false, liveReleased: false, cases, cancellation };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, mode] = process.argv.slice(2);
  if (!root || !["fast", "latency"].includes(mode)) { console.error("Expected source root and fast|latency"); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(await runModeldHotPath(root, { latencyCases: mode === "latency" }))); }
    catch (error) { console.error(error instanceof Error ? error.message : "benchmark_failed"); process.exitCode = 1; }
  }
}
