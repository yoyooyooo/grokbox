import { describe, expect, test } from "bun:test";
import { lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { attestationPath, writeAttestation } from "../src/attestation.ts";
import { bindCompiledHost } from "../src/modeld-binding.ts";
import { modeldStorePorts } from "../src/modeld-store.ts";
import { callStubModeld, encodeModeldFrame, modeldSocketPath, probeStubModeld, startStubModeldServer, STUB_ECHO_PARTS } from "../src/modeld-ipc.ts";
import type { ModelPin } from "../src/modeld.ts";
import { adoptOpStatePath, readAdoptOpState, writeAdoptOpState } from "../src/transient-adopt.ts";
import { eventsPath, modelsPath, desiredPath } from "../src/paths.ts";
import { bindHostSessionHook, createModeldRouteDriver, createSessionSeam } from "../src/seam.ts";
import type { HostPromptSession, StreamPart } from "../src/session.ts";
import { buildModelEnvelope } from "../src/envelope.ts";
import { sha256Text } from "../src/hash.ts";
import { FAKE_ATTESTATION, FAKE_BINDING, fakeModels, modeldFixture, STUB_MODELS, submitRequest, writeModeldAuthority } from "./modeld-fixture.ts";
import { providerHardOff } from "./provider-hard-off.ts";
import { within } from "./scripted-stream.ts";
import { consumeHandle } from "./host-consumer.ts";
const original = { stream: () => { throw new Error("official hard-off"); } };
const hookArgs = (invocationId: string, agentId = "agent-tom") => ({ originalSession: original, agentId, sessionOptions: { invocationId, inferenceReason: "main" } });
async function until(check: () => boolean) { await within((async () => { while (!check()) await Bun.sleep(1); })()); }

// Every integration case uses the production Unix server and its one kernel. Only dependencies are fake/isolated.
describe("Host seam → Unix modeld → admitted stub/fake", () => {
  test.each(["generationId", "activationId", "sourceSha", "pid", "start", "identitySha"] as const)("wrong %s is refused at actual IPC before any driver or credential effect", async (field) => {
    const off = providerHardOff(); const f = await modeldFixture(); let credentials = 0;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable,
      ports: { ...modeldStorePorts(f.durable, f.runRoot), credentialFingerprint: () => { credentials++; throw new Error("credential hard-off"); } } });
    try {
      const host = { ...f.binding, [field]: typeof f.binding[field] === "number" ? 9999 : field === "activationId" ? "other" : "a".repeat(64) };
      const reply = await callStubModeld(f.runRoot, submitRequest(server, "wrong", { host }));
      expect(reply).toMatchObject({ ok: false, code: field === "generationId" ? "wrong-generation" : field === "activationId" ? "wrong-activation" : field === "sourceSha" ? "wrong-source" : "wrong-identity" });
      const driver = createModeldRouteDriver(f.runRoot, host);
      const seam = createSessionSeam({ mode: "route", root: f.durable, assignment: "main", modelId: "stub/echo", driver });
      const handle = (seam.hook(hookArgs("wrong-host")) as HostPromptSession).getExecutor().stream({}, "wrong-host");
      expect((await handle.response).error?.userVisible).toBe(true);
      expect((await consumeHandle(handle)).finalDeliveryCount).toBe(1);
      await seam.flush();
      expect(server.dispatches()).toBe(0); expect(driver.dispatches).toBe(0); expect(credentials).toBe(0);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test("per-Bot override is resolved by modeld, not a client-supplied model; production stub has zero credentials/egress", async () => {
    const off = providerHardOff(); const f = await modeldFixture();
    await f.store.saveModels({ ...STUB_MODELS, assignments: { main: "stub/echo", agents: { "agent-tom": "stub/echo" } } });
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      const hook = bindHostSessionHook({ mode: "route", runRoot: f.runRoot, durableRoot: f.durable, binding: f.binding });
      for (const [id, agent] of [["tom", "agent-tom"], ["jerry", "agent-jerry"]]) {
        const session = hook(hookArgs(id!, agent!)) as HostPromptSession;
        const handle = session.getExecutor([{ role: "user", content: "private-envelope-sentinel" }]).stream({}, id);
        expect((await handle.response).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "echo" }] }]);
      }
      // Terminal writes are asynchronous; wait for exactly two bounded rows, not model body persistence.
      await within((async () => { for (;;) { try { if ((await readFile(eventsPath(f.durable), "utf8")).trim().split("\n").length === 2) return; } catch {} await Bun.sleep(1); } })());
      const log = await readFile(eventsPath(f.durable), "utf8");
      expect(log).not.toContain("private-envelope-sentinel");
      expect(log.trim().split("\n").map((line) => JSON.parse(line).assignment)).toEqual(["agent", "main"]);
      expect(await callStubModeld(f.runRoot, { ...submitRequest(server, "spoof"), modelId: "stub/echo" })).toMatchObject({ ok: false, code: "excess-fields" });
      const models = fakeModels(); models.assignments.main = "stub/echo";
      await f.store.saveModels(models);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "unadmitted-tom"))).toMatchObject({ ok: false, code: "wrong-model" });
      expect(await callStubModeld(f.runRoot, submitRequest(server, "still-jerry", { agentId: "agent-jerry" }))).toMatchObject({ ok: true, assignment: "main" });
      expect(server.dispatches()).toBe(3);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test.each(["desired-disabled", "desired-invalid", "models-invalid", "models-symlink", "missing-main", "legacy-attestation", "bad-attestation", "journal-pending", "journal-recovery", "journal-identity", "journal-operation", "journal-compile"])("%s cannot use service health as admission", async (fault) => {
    const off = providerHardOff(); const f = await modeldFixture();
    if (fault === "desired-disabled") await f.store.saveDesired({ version: 1, mode: "disabled" });
    if (fault === "desired-invalid") await writeFile(desiredPath(f.durable), "{");
    if (fault === "models-invalid") await writeFile(modelsPath(f.durable), "{");
    if (fault === "models-symlink") { const path = modelsPath(f.durable); await rename(path, `${path}.saved`); await symlink(`${path}.saved`, path); }
    if (fault === "missing-main") await f.store.saveModels({ ...STUB_MODELS, assignments: { main: null, agents: {} } });
    if (fault === "legacy-attestation") { const { compile: _, ...legacy } = FAKE_ATTESTATION; await writeAttestation(f.runRoot, legacy); }
    if (fault === "bad-attestation") await writeFile(attestationPath(f.runRoot), "{");
    const journal = (await readAdoptOpState(f.runRoot))!;
    if (fault === "journal-pending") await writeAdoptOpState(f.runRoot, { ...journal, phase: "commit-attestation" });
    if (fault === "journal-recovery") await writeAdoptOpState(f.runRoot, { ...journal, phase: "recovery-required" });
    if (fault === "journal-identity") await writeAdoptOpState(f.runRoot, { ...journal, host: { ...FAKE_ATTESTATION.identity, start: 999 } });
    if (fault === "journal-operation") await writeAdoptOpState(f.runRoot, { ...journal, operationId: "wrong" });
    if (fault === "journal-compile") await writeAdoptOpState(f.runRoot, { ...journal, compile: { ...FAKE_ATTESTATION.compile!, profileSha256: "a".repeat(64) } });
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, budgetMs: 30 });
    try {
      expect(await probeStubModeld(f.runRoot)).toBe(true);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "refused"))).toMatchObject({ ok: false, userVisible: true });
      expect(server.dispatches()).toBe(0); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test("stalled configuration ports are cancelled by actual client loss without a late fingerprint or driver effect", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); let release!: () => void; let fingerprints = 0;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, ports: { ...modeldStorePorts(f.durable, f.runRoot),
      loadModels: async () => { await new Promise<void>((r) => { release = r; }); return fakeModels(); },
      credentialFingerprint: () => { fingerprints++; return sha256Text("fake"); } } });
    try {
      const controller = new AbortController();
      const pending = callStubModeld(f.runRoot, submitRequest(server, "lost-before-pin"), 1000, controller.signal).catch(() => "cancelled");
      await until(() => !!release); controller.abort(); expect(await within(pending)).toBe("cancelled");
      await until(() => server.admissionStats().pins === 0);
      release(); await Bun.sleep(5);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "lost-before-pin"))).toMatchObject({ ok: false, code: "disconnected" });
      expect(server.dispatches()).toBe(0); expect(fingerprints).toBe(0);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { release?.(); await server.stop(); off.restore(); }
  });

  test.each(["throw", "not-a-fingerprint"])("fake fingerprint hook %s is redacted and prevents dispatch on the actual transport", async (fault) => {
    const off = providerHardOff(); const f = await modeldFixture(); await f.store.saveModels(fakeModels());
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable,
      ports: { ...modeldStorePorts(f.durable, f.runRoot), credentialFingerprint: () => {
        if (fault === "throw") throw new Error("private-credential-sentinel"); return "private-credential-sentinel";
      } }, driver: { accepts: () => true, complete: () => STUB_ECHO_PARTS } });
    try {
      const reply = await callStubModeld(f.runRoot, submitRequest(server, "bad-fingerprint"));
      expect(reply).toMatchObject({ ok: false, code: "credential-unavailable" });
      expect(JSON.stringify(reply)).not.toMatch(/private-credential|apiKey|FAKE_/);
      expect(server.dispatches()).toBe(0); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test("late canonical drift after a fake fingerprint await is rechecked before dispatch", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); await f.store.saveModels(fakeModels()); let release!: () => void;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable,
      ports: { ...modeldStorePorts(f.durable, f.runRoot), credentialFingerprint: async () => {
        await new Promise<void>((r) => { release = r; }); return sha256Text("fake");
      } }, driver: { accepts: () => true, complete: () => STUB_ECHO_PARTS } });
    try {
      const pending = callStubModeld(f.runRoot, submitRequest(server, "late-drift")); await until(() => !!release);
      await f.store.saveDesired({ version: 1, mode: "disabled" }); release();
      expect(await pending).toMatchObject({ ok: false, code: "disabled" }); expect(server.dispatches()).toBe(0);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { release?.(); await server.stop(); off.restore(); }
  });

  test("IPC pending commit wait and duplicate concurrency share one effect; changed envelope is not a second request", async () => {
    const off = providerHardOff(); const f = await modeldFixture();
    for (const path of [attestationPath(f.runRoot), adoptOpStatePath(f.runRoot)]) await rename(path, `${path}.previous`);
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, budgetMs: 200 });
    try {
      const raw = submitRequest(server, "wait"); const a = callStubModeld(f.runRoot, raw); const b = callStubModeld(f.runRoot, raw);
      await until(() => server.admissionStats().records === 1); expect(server.dispatches()).toBe(0);
      await writeModeldAuthority(f.runRoot);
      const replies = await Promise.all([a, b]);
      expect(replies).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, dispatched: true }), expect.objectContaining({ ok: true, dispatched: false })]));
      expect(await callStubModeld(f.runRoot, { ...raw, envelope: buildModelEnvelope([{ role: "user", content: "changed" }]) })).toMatchObject({ ok: false, code: "conflict" });
      expect(server.dispatches()).toBe(1); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test("fake driver on the actual socket receives immutable per-Bot config/envelope/fingerprint pins; new turn sees edits", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); const file = fakeModels(); await f.store.saveModels(file);
    const pins: ModelPin[] = []; const releases: Array<() => void> = []; let fingerprints = 0;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable,
      ports: { ...modeldStorePorts(f.durable, f.runRoot), credentialFingerprint: () => sha256Text(`fake-fingerprint-${++fingerprints}`) },
      driver: { accepts: (model) => model.provider === "fake", complete: async ({ pin, envelope }) => {
        pins.push(pin); expect(Object.isFrozen(envelope.messages)).toBe(true);
        await new Promise<void>((r) => releases.push(r)); return STUB_ECHO_PARTS;
      } } });
    try {
      const tom = callStubModeld(f.runRoot, submitRequest(server, "tom")); await until(() => pins.length === 1);
      file.assignments.agents["agent-tom"] = "fake/fast"; file.models["fake/smart"]!.endpoint = "fake:changed"; await f.store.saveModels(file);
      const jerry = callStubModeld(f.runRoot, submitRequest(server, "jerry", { agentId: "agent-jerry" })); await until(() => pins.length === 2);
      expect(pins[0]!.model.endpoint).toBe("fake:smart"); expect(pins[1]!.model.id).toBe("fake/fast");
      expect(Object.isFrozen(pins[0]!.model.dataTypes)).toBe(true); expect(pins[0]!.credentialFingerprint).not.toBe(pins[1]!.credentialFingerprint);
      releases.forEach((r) => r()); const responses = await Promise.all([tom, jerry]);
      expect(JSON.stringify(responses)).not.toMatch(/FAKE_|apiKey|fake:|fake-fingerprint/);
      const next = callStubModeld(f.runRoot, submitRequest(server, "tom-next")); await until(() => pins.length === 3); releases[2]!();
      expect(await next).toMatchObject({ ok: true, modelId: "fake/fast" }); expect(server.admissionStats().pins).toBe(0);
      expect(fingerprints).toBe(3); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { releases.forEach((r) => r()); await server.stop(); off.restore(); }
  });

  test("canonical generation replacement cancels active old work, rejects old packets, and admits only the new compile binding", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); let oldSignal: AbortSignal | undefined;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, driver: { accepts: () => true, complete: async ({ invocationId, signal }) => {
      if (invocationId === "old") { oldSignal = signal; return await new Promise<StreamPart[]>(() => {}); } return STUB_ECHO_PARTS;
    } } });
    try {
      const old = callStubModeld(f.runRoot, submitRequest(server, "old")); await until(() => !!oldSignal);
      const att = { ...FAKE_ATTESTATION, pid: 5252, identity: { ...FAKE_ATTESTATION.identity, pid: 5252 }, operationId: "new-activation" };
      await writeModeldAuthority(f.runRoot, att);
      const host = bindCompiledHost(att.identity, att.operationId, att.compile!);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "new", { host }))).toMatchObject({ ok: true });
      expect(await within(old)).toMatchObject({ ok: false, code: "wrong-generation" }); expect(oldSignal!.aborted).toBe(true);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "late-old"))).toMatchObject({ ok: false, code: "wrong-generation" });
      expect(server.dispatches()).toBe(2); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });

  test("restart changes the server fence: same driver never re-handshakes a used invocation, a fresh invocation can proceed", async () => {
    const off = providerHardOff(); const f = await modeldFixture();
    const driver = createModeldRouteDriver(f.runRoot, f.binding);
    const request = { invocationId: "before-restart", turnId: "before-restart", agentId: "agent-tom", modelId: "stub/echo", envelope: buildModelEnvelope([]) };
    const first = await startStubModeldServer({ ...f, durableRoot: f.durable });
    await driver.submit!(request); const oldPacket = submitRequest(first, "stale-packet"); await first.stop();
    const next = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      expect(await callStubModeld(f.runRoot, oldPacket)).toMatchObject({ ok: false, code: "wrong-server-generation" });
      await expect(driver.submit!(request)).rejects.toThrow(); expect(next.dispatches()).toBe(0);
      expect(await driver.submit!({ ...request, invocationId: "fresh" })).toMatchObject({ dispatched: true });
      expect(next.dispatches()).toBe(1); expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await next.stop(); off.restore(); }
  });

  test("socket disconnect and active-client stop are bounded even with stalled ports/driver and partial idle clients", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); let active: AbortSignal | undefined;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, driver: { accepts: () => true, complete: async ({ signal }) => {
      active = signal; return await new Promise<StreamPart[]>(() => {});
    } } });
    const client = createConnection({ path: modeldSocketPath(f.runRoot) });
    try {
      await within(new Promise<void>((r, reject) => { client.on("error", reject); client.on("connect", r); }));
      client.write(encodeModeldFrame(submitRequest(server, "lost"))); await until(() => !!active); client.destroy();
      await until(() => active!.aborted);
      expect(await callStubModeld(f.runRoot, submitRequest(server, "lost"))).toMatchObject({ ok: false, code: "disconnected" });
      const pending = callStubModeld(f.runRoot, submitRequest(server, "stop-active")).catch(() => "disconnected");
      await until(() => server.dispatches() === 2);
      const idle = createConnection({ path: server.socketPath });
      await within(new Promise<void>((r, reject) => { idle.on("error", reject); idle.on("connect", r); })); idle.write(Buffer.from([0, 0]));
      await within(Promise.all([server.stop(), server.stop(), server.wait()]), 300);
      expect(await within(pending)).toBe("disconnected"); expect(active!.aborted).toBe(true);
      await expect(lstat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" }); idle.destroy();
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { client.destroy(); await server.stop(); off.restore(); }
  });

  test("old-protocol or stalled competitors and non-socket files are never unlinked as stale", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); const clients = new Set<Socket>();
    const other = createServer((socket) => { clients.add(socket); socket.on("error", () => {}); socket.on("close", () => clients.delete(socket)); });
    const path = modeldSocketPath(f.runRoot);
    await new Promise<void>((r) => other.listen(path, r));
    try {
      const inode = (await lstat(path)).ino;
      expect(await probeStubModeld(f.runRoot, 10)).toBe(false);
      await expect(startStubModeldServer({ ...f, durableRoot: f.durable })).rejects.toThrow(/competitor/);
      expect((await lstat(path)).ino).toBe(inode);
    } finally { for (const client of clients) client.destroy(); await new Promise<void>((r) => other.close(() => r())); }
    try {
      await writeFile(path, "owned-by-someone-else");
      await expect(startStubModeldServer({ ...f, durableRoot: f.durable })).rejects.toThrow(/stale socket/);
      expect(await readFile(path, "utf8")).toBe("owned-by-someone-else");
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { off.restore(); }
  });

  test("IPC TTL expires pending driver pins; duplicates keep a refusal tombstone instead of redispatching", async () => {
    const off = providerHardOff(); const f = await modeldFixture(); let signal: AbortSignal | undefined;
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable, idleTtlMs: 30, driver: { accepts: () => true, complete: async (request) => {
      signal = request.signal; return await new Promise<StreamPart[]>(() => {});
    } } });
    try {
      const raw = submitRequest(server, "expires");
      expect(await callStubModeld(f.runRoot, raw)).toMatchObject({ ok: false, code: "expired" }); expect(signal!.aborted).toBe(true);
      expect(await callStubModeld(f.runRoot, raw)).toMatchObject({ ok: false, code: "expired" });
      expect(server.admissionStats()).toEqual({ dispatches: 1, records: 1, pins: 0 });
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });
});
