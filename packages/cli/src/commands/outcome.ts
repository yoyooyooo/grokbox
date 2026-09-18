import type { CliDeps } from "../deps.ts";
import { openRuntimeStore, observeRuntimeEvents, observeJournalHealth, readJournalHealth, openMonitorStore } from "@grokbox/box-runtime/runtime";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";
import { projectAlert, projectSendOutcome, SETTLED_SEND_OUTCOME_STATES, type AlertObservation } from "../outcome.ts";
import { assertUuidV4, isRecord, parseInteger } from "../util.ts";
import { findRosterRow } from "./roster.ts";
import { observeRosterHarness } from "../transcript-route.ts";

function requestId(value: string | undefined): string | undefined {
  if (value !== undefined && (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))) throw usage("Invalid --request-id.");
  return value;
}

/** Incident diagnosis does not depend on a live Gateway, current Bot name, tray
 * or transcript route. Exact IDs only; no execution or recovery side effects. */
export async function runRuntimeIncident(deps: CliDeps, step: string, raw: { agent?: string; from?: string }) {
  const selectedStep = requestId(step);
  const agentId = requestId(raw.agent);
  if (!selectedStep || !agentId) throw usage("runtime incident requires <step-id> and --agent <id>.");
  if (deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl || (deps.transport !== "local" && deps.transport !== "auto")) {
    throw new CliError("runtime_local_only", "Incident evidence requires a box-local Profile.");
  }
  const durableRoot = openRuntimeStore(deps.boxRuntimeRoot, deps.env).root;
  if (raw.from !== undefined && raw.from !== "journal" && raw.from !== "monitor") throw usage("--from must be journal or monitor.");
  if (raw.from === "monitor") {
    const store = openMonitorStore(durableRoot);
    const evidence = await store.executionEvidence({ agentId, stepId: selectedStep });
    const gap = evidence.truncated ? "truncated" : evidence.summaryUsed ? "retained_summary" : evidence.events.length === 0 ? "not_in_retained_window" : undefined;
    const result = projectSendOutcome({ agentId, stepId: selectedStep, entries: [], alerts: [], truncated: false, runtimeEvents: evidence.events, runtimeGap: gap });
    writeSuccess(deps.stdout, { ...result, presentation: await store.alertTrace({ agentId, stepId: selectedStep }),
      evidence: { ...result.evidence, transcript: "not_checked", alerts: "not_checked", runtime: evidence.source,
        summaryUsed: evidence.summaryUsed, retentionFloor: evidence.retentionFloor, runtimeRoot: durableRoot },
      events: evidence.events, queryMode: "offline_step", replayAuthorized: false });
    return;
  }
  const read = await observeRuntimeEvents({ durableRoot, runRoot: deps.env.GROKBOX_RUN_ROOT, source: "host", selector: { agentId, stepId: selectedStep } });
  const writerHealth = await observeJournalHealth(read.root);
  const gap = read.state !== "present" ? read.state : read.truncated ? "truncated" : read.window?.selectorMatched === false ? "not_in_retained_window" : undefined;
  const result = projectSendOutcome({ agentId, stepId: selectedStep, entries: [], alerts: [], truncated: false, runtimeEvents: read.events, runtimeGap: gap,
    runtimeEvidence: { root: read.root, coverage: read.coverage, lookup: read.lookup, retention: read.retention, readFailure: read.readFailure,
      health: await readJournalHealth(read.root) } });
  writeSuccess(deps.stdout, { ...result, evidence: { ...result.evidence,
    transcript: "not_checked", alerts: "not_checked", runtimeRoot: read.root, runtimeWindow: read.window ?? null, writerHealth },
    events: read.events, queryMode: "offline_step", replayAuthorized: false,
    limits: "A bounded evidence window is not an execution ledger. Missing events, historical fields and native checkpoint/trigger linkage remain unobserved; no work is retried.",
  });
}

export async function runAlerts(deps: CliDeps, raw: { timeoutMs?: string; agent?: string; requestId?: string }) {
  const io = ioFromOpts(raw);
  const selected = requestId(raw.requestId);
  if (raw.agent !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.agent)) throw usage("Invalid --agent ID.");
  const { trays, discovery } = await new GatewayClient(deps).getTrays(io.timeoutMs);
  const projected = trays.map(projectAlert);
  const alerts = projected.filter((a): a is AlertObservation => a !== null)
    .filter(a => (!raw.agent || a.agentId === raw.agent) && (!selected || a.requestId === selected));
  writeSuccess(deps.stdout, {
    alerts, source: "Gateway.getTrays", persistence: "host-memory", snapshot: true,
    unsupportedEntries: projected.filter(a => a === null).length,
    limits: "Trays can be dismissed, deduplicated, evicted, cleared by a new turn, or lost on Host restart; absence does not prove success.",
  }, gatewayMeta(discovery));
}

export async function runSendOutcome(deps: CliDeps, target: string, raw: { timeoutMs?: string; nonce?: string; requestId?: string; stepId?: string; waitMs?: string; waitFor?: string; expectText?: string; expectHarness?: string; runtime?: boolean }) {
  const io = ioFromOpts(raw);
  if ([raw.nonce, raw.requestId, raw.stepId].filter(Boolean).length !== 1) throw usage("Specify exactly one of --nonce, --request-id or --step-id.");
  if (raw.stepId !== undefined && !raw.runtime) throw usage("--step-id requires --runtime; a STEP is not a transcript request ID.");
  if (raw.waitFor !== undefined && raw.waitFor !== "delivery" && raw.waitFor !== "execution") throw usage("--wait-for must be delivery or execution.");
  if (raw.waitFor === "execution" && !raw.runtime) throw usage("--wait-for execution requires --runtime.");
  if (raw.expectHarness !== undefined && raw.expectHarness !== "box" && raw.expectHarness !== "temporal") {
    throw usage("--expect-harness must be box or temporal.");
  }
  if (raw.runtime && raw.expectHarness === "temporal") throw usage("--runtime cannot qualify a temporal transcript with box-local logs.");
  const expectedHarness = raw.expectHarness ?? (raw.runtime ? "box" : undefined);
  const nonce = raw.nonce ? assertUuidV4(raw.nonce, "--nonce") : undefined;
  const selected = requestId(raw.requestId);
  const selectedStep = requestId(raw.stepId);
  const waitMs = parseInteger(raw.waitMs, { name: "--wait-ms", min: 0, max: 120000, defaultValue: 0 });
  if (raw.expectText !== undefined && (raw.expectText.length === 0 || raw.expectText.length > 4096)) throw usage("--expect-text must contain 1..4096 characters.");
  // This is an explicitly requested local evidence join, not a runtime mutation.
  // A named local Profile is fine; never join local logs to a remote Gateway.
  if (raw.runtime && (deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl
    || (deps.transport !== "local" && deps.transport !== "auto"))) {
    throw new CliError("runtime_local_only", "--runtime evidence requires a box-local Profile.");
  }
  const runtimeRoot = raw.runtime ? openRuntimeStore(deps.boxRuntimeRoot, deps.env).root : undefined;
  const started = performance.now();
  const deadline = started + (waitMs || io.timeoutMs);
  const timeout = () => Math.max(1, Math.min(io.timeoutMs, Math.floor(deadline - performance.now())));
  const client = new GatewayClient(deps);
  const roster = await client.listAgents(timeout());
  const row = findRosterRow(roster.agents, target);
  const agentId = String(row.id);
  const initialHarness = observeRosterHarness(row);
  const generation = `${roster.discovery.pid}:${roster.discovery.startedAt}`;
  const changed = (d: typeof roster.discovery) => `${d.pid}:${d.startedAt}` !== generation;
  let samples = 0;
  for (;;) {
    // Refresh at each sample: a switch need not restart the Gateway process.
    const beforeRoster = samples === 0 ? roster : await client.listAgents(timeout());
    const beforeHarness = observeRosterHarness(beforeRoster.agents.find(r => isRecord(r) && r.id === agentId));
    let beforeSeq: number | undefined;
    let truncated = false;
    let gatewayChanged = changed(beforeRoster.discovery);
    const entries: unknown[] = [];
    // At most 1000 entries per observation. Never infer not-found beyond this window.
    for (let page = 0; page < 5; page++) {
      const response = await client.getAgentTranscriptTail({ id: agentId, limit: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, timeout());
      gatewayChanged ||= changed(response.discovery);
      if (!isRecord(response.result) || !Array.isArray(response.result.entries)) throw usage("Unrecognized transcript response.");
      entries.push(...response.result.entries);
      const next = response.result.nextBeforeSeq;
      truncated = typeof next === "number" && Number.isSafeInteger(next) && next > 0;
      const found = entries.some(e => isRecord(e) && e.kind === "message" && e.role === "user" && (nonce ? e.clientNonce === nonce : e.requestId === selected));
      if (found || !truncated || gatewayChanged || performance.now() >= deadline) break;
      if (beforeSeq !== undefined && (next as number) >= beforeSeq) break;
      beforeSeq = next as number;
    }
    const trays = await client.getTrays(timeout());
    gatewayChanged ||= changed(trays.discovery);
    const lookupNonce = nonce ?? entries.filter(isRecord).find(e => e.kind === "message" && e.role === "user" && selected !== undefined && e.requestId === selected)?.clientNonce;
    const runtime = runtimeRoot ? await observeRuntimeEvents({ durableRoot: runtimeRoot, runRoot: deps.env.GROKBOX_RUN_ROOT, source: "host",
      selector: { agentId, ...(selectedStep ? { stepId: selectedStep } : typeof lookupNonce === "string" ? { nonce: lookupNonce } : selected ? { stepId: selected } : {}) },
    }) : undefined;
    const writerHealth = runtime ? await observeJournalHealth(runtime.root) : undefined;
    const health = runtime ? await readJournalHealth(runtime.root) : undefined;
    const projectedAlerts = trays.trays.map(projectAlert);
    const afterRoster = await client.listAgents(timeout());
    gatewayChanged ||= changed(afterRoster.discovery);
    const afterHarness = observeRosterHarness(afterRoster.agents.find(r => isRecord(r) && r.id === agentId));
    const runtimeGap = runtime ? (runtime.state !== "present" ? runtime.state
      : (runtime as { lookup?: { matched?: boolean } }).lookup?.matched === false ? "not_found_in_window"
      : (runtime as { coverage?: { partialLastLine?: boolean } }).coverage?.partialLastLine ? "partial_append"
      : (runtime as { retention?: { affectsWindow?: boolean } }).retention?.affectsWindow === true ? "retained_subset"
      : runtime.truncated ? "truncated"
      : runtime.window?.selectorMatched === false ? "not_in_retained_window" : undefined) : undefined;
    const result = projectSendOutcome({ agentId, nonce, requestId: selected, stepId: selectedStep, entries,
      alerts: projectedAlerts.filter((a): a is AlertObservation => a !== null), truncated, gatewayChanged,
      alertsIncomplete: projectedAlerts.some(a => a === null),
      transcriptRoute: { initial: initialHarness, before: beforeHarness, after: afterHarness, expected: expectedHarness },
      expectedText: raw.expectText, runtimeEvents: runtime?.events,
      runtimeEvidence: runtime ? { root: runtime.root, coverage: (runtime as any).coverage, lookup: (runtime as any).lookup, retention: (runtime as any).retention, readFailure: (runtime as any).readFailure, health } : undefined,
      runtimeGap });
    Object.assign(result.evidence, { runtimeWindow: runtime?.window ?? null, writerHealth: writerHealth ?? null });
    samples++;
    // There is no native full-run completion receipt yet. Execution waiting
    // settles on an observed failure, never on a progress SendToUser.
    const settled = raw.waitFor === "execution" ? result.state === "failed" : SETTLED_SEND_OUTCOME_STATES.has(result.state);
    if (!waitMs || settled || gatewayChanged || result.evidence.transcriptRoute?.usable === false || performance.now() >= deadline) {
      writeSuccess(deps.stdout, { ...result, samples, waitExpired: waitMs > 0 && !settled && performance.now() >= deadline,
        elapsedMs: Math.round(performance.now() - started) }, gatewayMeta(afterRoster.discovery));
      return;
    }
    // No send, retry, clear-tray, or runtime repair in this observation command.
    const remaining = deadline - performance.now();
    const lastWait = remaining <= 2000;
    await new Promise(resolve => setTimeout(resolve, Math.ceil(Math.min(2000, Math.max(1, remaining)))));
    // A fractional timer may wake just before the deadline. The final budget
    // wait is not permission for another four-RPC sample with a 1ms timeout.
    if (lastWait || performance.now() >= deadline) {
      writeSuccess(deps.stdout, { ...result, samples, waitExpired: true, elapsedMs: Math.round(performance.now() - started) }, gatewayMeta(afterRoster.discovery));
      return;
    }
  }
}
