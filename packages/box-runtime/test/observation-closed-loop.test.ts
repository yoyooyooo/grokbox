import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { attestationPath, writeAttestation } from "../src/internal/io/authority.node.ts";
import { snapshotContracts, CONTRACT_OBSERVATION_LIMIT } from "../src/internal/io/contracts.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectLiveStatus, readContracts, readEvents } from "../src/internal/io/observe.ts";
import { coordinatorStatePath, runtimeConfigPath as desiredPath, eventsPath, modelsPath, reviewedProfilePath } from "../src/internal/io/paths.ts";
import { adoptOpStatePath, writeAdoptOpState } from "../src/internal/process/transient-adopt.ts";
import { SHA, SOURCE, reviewed } from "./admission-fixture.ts";
import { receiptFixture } from "./receipt-fixture.ts";
import { snapshotTree } from "./observation-fixture.ts";

const AT = "2026-01-01T00:00:00.000Z";

async function configuredFixture(adopt = true) {
  const f = await receiptFixture("route", adopt);
  await fs.mkdir(dirname(coordinatorStatePath(f.root)), { recursive: true, mode: 0o700 });
  if (adopt) {
    await writeAttestation(f.ephemeralRoot, {
      mode: "route",
      coverage: "attested",
      modeld: true,
      diskSha: SHA,
      pid: f.host.pid,
      start: f.host.start,
      identity: f.host,
      launchMode: "transient-adopt",
      at: new Date(0).toISOString(),
      profileId: reviewed.profileId,
      transformedSha: reviewed.transformedSourceSha256,
    });
    await fs.writeFile(coordinatorStatePath(f.root), JSON.stringify({
      version: 1, circuit: "closed", mutationCount: 0, attemptedKeys: [],
    }));
    await writeAdoptOpState(f.ephemeralRoot, {
      launchMode: "transient-adopt",
      phase: "attested",
      operationId: "observed-fixture-operation",
      tempSupervisor: null,
      adoptingSupervisor: f.supervisor,
      host: f.host,
    });
  }
  await fs.writeFile(desiredPath(f.root), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: f.input.desired.mode } }));
  await fs.writeFile(modelsPath(f.root), JSON.stringify(f.input.models));
  const status = () => projectLiveStatus({ root: f.root, ephemeralRoot: f.ephemeralRoot,
    processes: f.tree, classify: f.input.classify, diskSha: SHA, gatewayPid: f.gateway.pid,
    envHas: f.input.envHas, modeldReady: () => f.modeld.ready });
  return { ...f, status };
}

describe("desired/actual observation closed loop", () => {
  test("disabled intent observation remains pending and cannot stop the owned patched Host", async () => {
    const f = await configuredFixture();
    await fs.writeFile(desiredPath(f.root), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "disabled" } }));
    const signals = [...f.tree.signals];
    const before = await snapshotTree(f.root);
    const observed = await f.status();
    expect(observed.facets.bridge.value).toMatchObject({ desired: "disabled", actual: "route", coverage: "attested" });
    expect(await snapshotTree(f.root)).toEqual(before);
    expect(f.tree.signals).toEqual(signals);
    expect(f.tree.alive(f.gateway.pid)).toBe(true);
  });

  test("coordinator fields and last recorded heal are read, never invented as a heartbeat", async () => {
    const f = await configuredFixture();
    const key = `route:${f.gateway.pid}:2:${SHA}`;
    await fs.writeFile(coordinatorStatePath(f.root), JSON.stringify({ version: 1, circuit: "open", circuitReason: "mutation_budget",
      mutationCount: 9, attemptedKeys: [key], lastAttemptKey: key }));
    await fs.mkdir(dirname(eventsPath(f.root)), { recursive: true });
    await fs.writeFile(eventsPath(f.root), JSON.stringify({ name: "stale_patched_term", at: AT, outcome: "failed" }) + "\n");
    const before = await snapshotTree(f.root);
    const status = await f.status();
    expect(status.circuit.value).toEqual({ state: "open", reason: "mutation_budget" });
    expect(status.facets.mutation.value?.inhibited).toBe(true);
    expect(status).not.toHaveProperty("watchdog");
    expect(status).not.toHaveProperty("lastHeal");
    expect(status.facets.recovery.value?.pending).toBe(false);
    expect(JSON.stringify(status)).not.toContain("degraded");
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test("missing trees stay missing, defaults are disclosed, and missing evidence is not zero drift/closed circuit", async () => {
    const f = await configuredFixture(false);
    const root = join(f.root, "missing-durable");
    const ephemeralRoot = join(f.root, "missing-run");
    const before = await snapshotTree(f.root);
    const status = await projectLiveStatus({ ...f.input, desired: undefined, models: undefined, root, ephemeralRoot, gatewayPid: f.gateway.pid });
    expect(status.facets.bridge.value).toMatchObject({ desired: "disabled", actual: "official" });
    expect(status.circuit.gap).toBe("missing");
    expect(status.circuit.value).toBeNull();
    expect(status.facets.controller.value?.liveness).toBe("unknown");
    expect(status).not.toHaveProperty("watchdog");
    expect(await readContracts(root)).toMatchObject({ state: "missing", head: null, generations: [] });
    expect(await observeEvents(root)).toMatchObject({ state: "missing", events: [] });
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test.each(["desired", "models", "attestation", "profile", "coordinator", "journal"])("bad %s does not erase independent observations or repair files", async (kind) => {
    for (const malformed of ["{broken", "null", "[]", '{"version":99}']) {
      const f = await configuredFixture();
      const paths = { desired: desiredPath(f.root), models: modelsPath(f.root), attestation: attestationPath(f.ephemeralRoot),
        profile: reviewedProfilePath(f.root), coordinator: coordinatorStatePath(f.root), journal: adoptOpStatePath(f.ephemeralRoot) };
      await fs.writeFile(paths[kind as keyof typeof paths], malformed);
      const before = await snapshotTree(f.root);
      const status = await f.status();
      expect(status.facets.modeld.value?.ready).toBe(true);
      if (kind === "coordinator") {
        expect(status.circuit.gap).toBe("invalid");
        expect(status.facets.mutation.gap).toBe("invalid");
      } else if (kind === "journal") {
        expect(status.facets.recovery.gap).toBe("invalid");
        expect(status.facets.bridge.value?.coverage).not.toBe("attested");
      } else if (kind === "desired") {
        expect(status.facets.bridge.value?.desired).toBeNull();
      }
      if (kind === "attestation") {
        expect(status.facets.bridge.value?.actual).toBe("patched-unknown");
      }
      if (["models", "profile", "attestation"].includes(kind)) expect(status.facets.bridge.value?.coverage).not.toBe("attested");
      expect(await snapshotTree(f.root)).toEqual(before);
    }
  });

  test("identity ownership alone cannot prove invalid adopted topology or an unsettled commit", async () => {
    const f = await configuredFixture();
    const supervisor = f.tree.roles().find((row) => row.role === "supervisor")!;
    f.tree.procs.get(supervisor.pid)!.ident.ppid = 999;
    const invalid = await f.status();
    expect(invalid.facets.bridge.value).toMatchObject({ origin: "grokbox-attested", coverage: "window-open", reason: "bad_parentage" });
    f.tree.procs.get(supervisor.pid)!.ident.ppid = f.wrapper.pid;
    const journal = JSON.parse(await fs.readFile(adoptOpStatePath(f.ephemeralRoot), "utf8"));
    await fs.writeFile(adoptOpStatePath(f.ephemeralRoot), JSON.stringify({ ...journal, phase: "commit-attestation" }));
    const before = await snapshotTree(f.root);
    const pending = await f.status();
    expect(pending.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(pending.facets.bridge.value?.coverage).toBe("window-open");
    expect(pending.facets.recovery.value?.pending).toBe(true);
    expect(pending.facets.recovery.value?.state).toBe("recovery-required");
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test("unknown source and modeld probe failure retain the known process/circuit facts", async () => {
    const f = await configuredFixture();
    const status = await projectLiveStatus({ ...f.input, gatewayPid: f.gateway.pid, diskSha: null,
      modeldReady: () => { throw new Error("fixture probe unavailable"); } });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.modeld.value?.ready).toBeNull();
    expect(status.circuit.value?.state).toBe("closed");
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
  });

  test("unreadable coordinator and non-file evidence remain explicitly unknown without repair", async () => {
    const f = await configuredFixture();
    const before = await snapshotTree(f.root);
    const open = fs.open;
    const spy = spyOn(fs, "open").mockImplementation((async (path, ...args) => {
      if (path === coordinatorStatePath(f.root)) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
      return open(path, ...args);
    }) as typeof fs.open);
    try {
      const status = await f.status();
      expect(status.circuit.gap).toBe("unavailable");
      expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    } finally { spy.mockRestore(); }
    expect(await snapshotTree(f.root)).toEqual(before);
    await fs.rename(attestationPath(f.ephemeralRoot), join(f.root, "prior-fixture-attestation.json"));
    await fs.mkdir(attestationPath(f.ephemeralRoot));
    const directory = await snapshotTree(f.root);
    expect((await f.status()).facets.bridge.value?.actual).toBe("patched-unknown");
    expect(await snapshotTree(f.root)).toEqual(directory);
  });

  test("a settled journal for another generation is not completion evidence for this Host", async () => {
    const f = await configuredFixture();
    const journal = JSON.parse(await fs.readFile(adoptOpStatePath(f.ephemeralRoot), "utf8"));
    await fs.writeFile(adoptOpStatePath(f.ephemeralRoot), JSON.stringify({ ...journal, host: { ...journal.host, start: journal.host.start + 1 } }));
    const before = await snapshotTree(f.root);
    const status = await f.status();
    expect(status.facets.recovery.gap).toBe("invalid");
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(await snapshotTree(f.root)).toEqual(before);
    expect(f.tree.signals).toEqual([]);
  });

  test("models arrays cannot silently become empty valid objects", async () => {
    const f = await configuredFixture(false);
    for (const models of [[], { version: 3, models: [] }, { version: 3, assignments: [] }, { version: 3, assignments: { agents: [] } }]) {
      await fs.writeFile(modelsPath(f.root), JSON.stringify(models));
      const status = await f.status();
      expect(status.facets.bridge.value?.coverage).not.toBe("attested");
    }
  });

  test("undefined model assignment is invalid configuration, not route-ready merely because modeld runs", async () => {
    const f = await configuredFixture();
    await fs.writeFile(modelsPath(f.root), JSON.stringify({ version: 3, models: {}, assignments: { main: { modelId: "missing/model" }, agents: {} } }));
    const status = await f.status();
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
  });
});

describe("read-only contracts and logs", () => {
  test("canonical metadata contains real hashes/drift; source generation, not stale HEAD, owns status drift", async () => {
    const f = await configuredFixture(false);
    const previous = await snapshotContracts({ root: f.root, source: SOURCE, sourceSha: SHA, observedAt: AT });
    const source = SOURCE.replace("official-main", "official-next");
    const sha = sha256Text(source);
    const current = await snapshotContracts({ root: f.root, source, sourceSha: sha, observedAt: "2026-01-02T00:00:00.000Z", previous });
    expect(current.driftedSlices.length).toBeGreaterThan(0);
    const before = await snapshotTree(f.root);
    const open = fs.open;
    const reads: string[] = [];
    const spy = spyOn(fs, "open").mockImplementation((async (path, ...args) => {
      reads.push(String(path));
      if (String(path).includes("/slices/")) throw new Error("must not read contract bodies");
      return open(path, ...args);
    }) as typeof fs.open);
    try {
      const contracts = await readContracts(f.root);
      expect(contracts).toMatchObject({ state: "present", head: sha, truncated: false });
      expect(contracts.generations.map((row) => row.metadata)).toEqual([current, previous]);
      const status = await projectLiveStatus({ ...f.input, diskSha: sha, gatewayPid: f.gateway.pid });
      expect(status.schemaVersion).toBe(1);
      const unknown = await projectLiveStatus({ ...f.input, diskSha: "f".repeat(64), gatewayPid: f.gateway.pid });
      expect(unknown.schemaVersion).toBe(1);
      expect(reads.some((path) => path.includes("/slices/"))).toBe(false);
      expect(JSON.stringify(contracts)).not.toContain("function createSession");
    } finally { spy.mockRestore(); }
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test.each(["head", "json", "hash", "source", "symlink"])("bad contracts %s are explicit unknown metadata, never an empty successful snapshot", async (fault) => {
    const f = await configuredFixture(false);
    await snapshotContracts({ root: f.root, source: SOURCE, sourceSha: SHA, observedAt: AT });
    const dir = join(f.root, "contracts");
    const metaPath = join(dir, "generations", SHA, "meta.json");
    if (fault === "head") await fs.writeFile(join(dir, "HEAD"), "../../private-sentinel");
    else if (fault === "json") await fs.writeFile(metaPath, "{bad");
    else if (fault === "symlink") {
      await fs.rename(metaPath, join(f.root, "private-sentinel"));
      await fs.symlink(join(f.root, "private-sentinel"), metaPath);
    } else {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      await fs.writeFile(metaPath, JSON.stringify(fault === "hash" ? { ...meta, sliceHashes: { "agent-id": "bad hash" } } : { ...meta, sourceSha: "f".repeat(64) }));
    }
    const before = await snapshotTree(f.root);
    const result = await readContracts(f.root);
    expect(result.state).not.toBe("present");
    if (fault === "head") expect(result.head).toBeNull();
    else expect(result.generations[0]).toMatchObject({ state: "invalid", metadata: null });
    expect(JSON.stringify(result)).not.toContain("private-sentinel");
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test("contract enumeration is bounded and reports truncation", async () => {
    const f = await configuredFixture(false);
    for (let i = 0; i < CONTRACT_OBSERVATION_LIMIT + 1; i += 1) {
      const source = `${SOURCE}\n// generation ${i}`;
      await snapshotContracts({ root: f.root, source, sourceSha: sha256Text(source), observedAt: AT });
    }
    const before = await snapshotTree(f.root);
    const result = await readContracts(f.root);
    expect(result.truncated).toBe(true);
    expect(result.generations).toHaveLength(CONTRACT_OBSERVATION_LIMIT);
    expect(result.generations.some((row) => row.sourceSha === result.head)).toBe(true);
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test("oversized event files are unknown evidence, not a repaired or successful empty log", async () => {
    const f = await configuredFixture(false);
    await fs.mkdir(dirname(eventsPath(f.root)), { recursive: true });
    await fs.writeFile(eventsPath(f.root), "x".repeat(1024 * 1024 + 1));
    const before = await snapshotTree(f.root);
    expect(await observeEvents(f.root)).toMatchObject({ state: "partial", events: [], window: { trailingPartial: true, fileBytes: 1024 * 1024 + 1 } });
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  test("logs expose bounded schema-only snapshots, including malformed-line and missing-file states", async () => {
    const f = await configuredFixture(false);
    expect(await observeEvents(f.root)).toMatchObject({ state: "missing", events: [] });
    await fs.mkdir(dirname(eventsPath(f.root)), { recursive: true });
    const receipt = { name: "circuit_open", at: AT, reason: "mutation_budget", prompt: "private-prompt-sentinel", counts: { host: 1, token: "private-token-sentinel" } };
    await fs.writeFile(eventsPath(f.root), [JSON.stringify(receipt), "{bad private-sentinel", JSON.stringify({ name: "not-an-event", at: AT, text: "private-body" })].join("\n"));
    const before = await snapshotTree(f.root);
    const result = await observeEvents(f.root);
    expect(result.state).toBe("partial");
    expect(result.events).toEqual([{ name: "circuit_open", at: AT, reason: "mutation_budget", counts: { host: 1 } }, { invalid: true }]);
    expect(result.window?.trailingPartial).toBe(true);
    expect(await readEvents(f.root)).toEqual(result.events);
    expect((await observeEvents(f.root, 1)).truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(await snapshotTree(f.root)).toEqual(before);
  });
});
