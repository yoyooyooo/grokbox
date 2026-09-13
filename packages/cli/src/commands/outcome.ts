import type { CliDeps } from "../deps.ts";
import { openRuntimeStore, observeRuntimeEvents } from "@grokbox/box-runtime/runtime";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";
import { projectAlert, projectSendOutcome, type AlertObservation } from "../outcome.ts";
import { assertUuidV4, isRecord, parseInteger } from "../util.ts";
import { findRosterRow } from "./roster.ts";
import { observeRosterHarness } from "../transcript-route.ts";

function requestId(value: string | undefined): string | undefined {
  if (value !== undefined && (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))) throw usage("Invalid --request-id.");
  return value;
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

export async function runSendOutcome(deps: CliDeps, target: string, raw: { timeoutMs?: string; nonce?: string; requestId?: string; waitMs?: string; expectText?: string; expectHarness?: string; runtime?: boolean }) {
  const io = ioFromOpts(raw);
  if (Boolean(raw.nonce) === Boolean(raw.requestId)) throw usage("Specify exactly one of --nonce or --request-id.");
  if (raw.expectHarness !== undefined && raw.expectHarness !== "box" && raw.expectHarness !== "temporal") {
    throw usage("--expect-harness must be box or temporal.");
  }
  if (raw.runtime && raw.expectHarness === "temporal") throw usage("--runtime cannot qualify a temporal transcript with box-local logs.");
  const expectedHarness = raw.expectHarness ?? (raw.runtime ? "box" : undefined);
  const nonce = raw.nonce ? assertUuidV4(raw.nonce, "--nonce") : undefined;
  const selected = requestId(raw.requestId);
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
    const runtime = runtimeRoot ? await observeRuntimeEvents({ durableRoot: runtimeRoot, runRoot: deps.env.GROKBOX_RUN_ROOT, source: "host" }) : undefined;
    const projectedAlerts = trays.trays.map(projectAlert);
    const afterRoster = await client.listAgents(timeout());
    gatewayChanged ||= changed(afterRoster.discovery);
    const afterHarness = observeRosterHarness(afterRoster.agents.find(r => isRecord(r) && r.id === agentId));
    const result = projectSendOutcome({ agentId, nonce, requestId: selected, entries,
      alerts: projectedAlerts.filter((a): a is AlertObservation => a !== null), truncated, gatewayChanged,
      alertsIncomplete: projectedAlerts.some(a => a === null),
      transcriptRoute: { initial: initialHarness, before: beforeHarness, after: afterHarness, expected: expectedHarness },
      expectedText: raw.expectText, runtimeEvents: runtime?.events,
      runtimeGap: runtime ? (runtime.state !== "present" ? runtime.state : runtime.truncated ? "truncated" : undefined) : undefined });
    samples++;
    const settled = result.state === "failed" || result.state === "delivered" || result.state === "expected_result_observed";
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
