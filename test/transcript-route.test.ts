import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeRosterHarness } from "../packages/cli/src/transcript-route.ts";
import { compactRosterRow, detailRosterRow, redactEventPayload } from "../packages/cli/src/redaction.ts";
import { projectSendOutcome } from "../packages/cli/src/outcome.ts";
import { captureCli, parseJson, writeDiscovery } from "./helpers.ts";

const agentId = "route-fixture-agent";
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "route-fixture-request";
const marker = "ROUTE_FIXTURE_DONE";
const entries = [
  { kind: "message", role: "user", id: "t0u", requestId, clientNonce: nonce },
  { kind: "send-message", id: "t0s0", requestId, message: { type: "text", content: marker } },
];
const input = { agentId, nonce, entries, alerts: [], truncated: false, expectedText: marker };

test("roster harness is an explicit finite observation, never inferred from omission or serverId", () => {
  expect(observeRosterHarness({ harness: "box" })).toBe("box");
  expect(observeRosterHarness({ harness: "temporal" })).toBe("temporal");
  for (const row of [{}, { serverId: "123" }, { harness: null }, { harness: "PRIVATE_SENTINEL" }, Object.create({ harness: "box" })]) {
    expect(observeRosterHarness(row)).toBe("unknown");
  }
  let reads = 0;
  expect(observeRosterHarness({ get harness() { reads++; return "box"; } })).toBe("unknown");
  expect(reads).toBe(0);
  for (const harness of ["box", "temporal", "unknown"] as const) {
    const row = { id: agentId, harness, secret: "PRIVATE_SENTINEL" };
    expect(compactRosterRow(row).harness).toBe(harness);
    expect(detailRosterRow(row).harness).toBe(harness);
    expect(redactEventPayload("agent-upserted", { agent: row }, false)).toMatchObject({ agent: { harness } });
    expect(JSON.stringify(redactEventPayload("agents", { agents: [row] }, false))).not.toContain("PRIVATE_SENTINEL");
  }
});

test("identical entry ids and expected text cannot turn a sampled harness switch into success", () => {
  for (const route of [
    { initial: "box", before: "box", after: "temporal", expected: "box" },
    { initial: "box", before: "temporal", after: "box", expected: "box" },
    { initial: "temporal", before: "box", after: "box", expected: "box" },
  ] as const) {
    const result = projectSendOutcome({ ...input, transcriptRoute: route });
    expect(result.state).toBe("unknown");
    expect(result.expectedMatched).toBe(false);
    expect(result.delivery).toEqual([]);
    expect(result.gaps).toContain("harness_changed_during_observation");
  }
});

test("constant but wrong or missing harness refuses production source qualification", () => {
  for (const harness of ["temporal", "unknown"] as const) {
    const result = projectSendOutcome({ ...input, transcriptRoute: { initial: harness, before: harness, after: harness, expected: "box" } });
    expect(result.state).toBe("unknown");
    expect(result.gaps).toContain(harness === "unknown" ? "harness_unavailable" : "unexpected_harness");
  }
  const stable = projectSendOutcome({ ...input, transcriptRoute: { initial: "box", before: "box", after: "box", expected: "box" } });
  expect(stable.state).toBe("expected_result_observed");
  expect(stable.evidence.transcriptRoute).toMatchObject({ beforeHarness: "box", afterHarness: "box", consistent: true, declaredTranscriptSource: "box" });
  expect(stable.executionCompleted).toBe("not_proven");
  expect(stable.gaps).toContain("desktop_replica_not_observed");
});

async function gatewayFixture(harnesses: Array<string | undefined>, transcriptSamples: unknown[][] = [entries]) {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-route-test-"));
  const methods: string[] = [];
  let lists = 0;
  let tails = 0;
  const token = "owned-route-token";
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    methods.push(path);
    if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1700000000000 });
    if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({}, { status: 401 });
    if (path === "/api/listAgents") {
      const harness = harnesses[Math.min(lists++, harnesses.length - 1)];
      return Response.json([{ id: agentId, name: "route-fixture", isGroup: false, ...(harness === undefined ? {} : { harness }) }]);
    }
    if (path === "/api/getAgentTranscriptTail") return Response.json({ entries: transcriptSamples[Math.min(tails++, transcriptSamples.length - 1)] });
    if (path === "/api/getTrays") return Response.json([]);
    return Response.json({}, { status: 404 });
  } });
  const discoveryPath = await writeDiscovery({ port: gateway.port!, pid: 4242, startedAt: 1700000000000, token });
  return { dir, methods, gateway, discoveryPath, listCount: () => lists };
}

for (const [harnesses, state] of [
  [["box", "box"], "expected_result_observed"],
  [["box", "temporal"], "unknown"],
  [["temporal", "temporal"], "unknown"],
  [[undefined, undefined], "unknown"],
] as const) {
  test(`outcome brackets reads without send or mutation: ${harnesses.join("/")} -> ${state}`, async () => {
    const f = await gatewayFixture([...harnesses]);
    try {
      const result = await captureCli(["history", "outcome", agentId, "--nonce", nonce, "--expect-text", marker, "--expect-harness", "box", "--wait-ms", "1000"], {
        configDir: f.dir, discoveryPath: f.discoveryPath, env: {}, transport: "local", daemonSocket: join(f.dir, "missing.sock"),
      });
      expect(result.code).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({ data: { state, samples: 1 } });
      expect(f.listCount()).toBe(2);
      const api = f.methods.filter(p => p.startsWith("/api/"));
      expect(api[0]).toBe("/api/listAgents");
      expect(api.at(-1)).toBe("/api/listAgents");
      expect(api.every(p => ["/api/listAgents", "/api/getAgentTranscriptTail", "/api/getTrays"].includes(p))).toBe(true);
    } finally { f.gateway.stop(true); await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("wait refreshes harness between samples even when Gateway generation stays unchanged", async () => {
  const f = await gatewayFixture(["box", "box", "temporal", "temporal"], [[entries[0]], entries]);
  try {
    const result = await captureCli(["history", "outcome", agentId, "--nonce", nonce, "--expect-text", marker, "--expect-harness", "box", "--wait-ms", "3500"], {
      configDir: f.dir, discoveryPath: f.discoveryPath, env: {}, transport: "local", daemonSocket: join(f.dir, "missing.sock"),
    });
    expect(result.code).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { state: "unknown", samples: 2, expectedMatched: false,
      evidence: { transcriptRoute: { initialHarness: "box", beforeHarness: "temporal", afterHarness: "temporal" } } } });
    expect(f.listCount()).toBe(4);
    expect(f.methods).not.toContain("/api/sendPrompt");
  } finally { f.gateway.stop(true); await rm(f.dir, { recursive: true, force: true }); }
});

test("incompatible runtime/temporal and invalid harness are rejected before Gateway", async () => {
  let requests = 0;
  const deny = Object.assign(async () => { requests++; throw new Error("network_forbidden"); }, { preconnect: async () => undefined }) as typeof fetch;
  for (const flags of [["--expect-harness", "wrong"], ["--runtime", "--expect-harness", "temporal"]]) {
    const result = await captureCli(["history", "outcome", agentId, "--nonce", nonce, ...flags], { fetch: deny });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  }
  expect(requests).toBe(0);
});
