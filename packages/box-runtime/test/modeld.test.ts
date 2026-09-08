import { describe, expect, test } from "bun:test";
import { createModeld, type AdmissionAuthority, type ModeldPorts, type ModelPin } from "../src/modeld.ts";
import { sha256Text } from "../src/hash.ts";
import { buildModelEnvelope } from "../src/envelope.ts";
import type { ModelsFile } from "../src/models.ts";
import { FAKE_BINDING, FAKE_COMPILE, FAKE_HOST, STUB_MODELS, fakeModels, submitRequest } from "./modeld-fixture.ts";
import { bindCompiledHost } from "../src/modeld-binding.ts";
import { within } from "./scripted-stream.ts";

const parts = [{ type: "text-delta" as const, textDelta: "fixture" }, { type: "finish" as const, reason: "stop" as const }];
const authority = (): AdmissionAuthority => ({ state: "committed", host: FAKE_BINDING });

describe("one modeld admission/pin kernel", () => {
  test("binding covers every compile field and stable identity but not transient re-parenting", () => {
    for (const field of ["profileId", "profileSha256", "sourceSha256", "transformedSha256"] as const) {
      const compile = { ...FAKE_COMPILE, [field]: field === "profileId" ? "other-profile" : "a".repeat(64) };
      expect(bindCompiledHost(FAKE_HOST, FAKE_BINDING.activationId, compile).generationId).not.toBe(FAKE_BINDING.generationId);
    }
    const reparented = { ...FAKE_HOST, ppid: 999, ancestry: [999] };
    expect(bindCompiledHost(reparented, FAKE_BINDING.activationId, FAKE_COMPILE)).toEqual(FAKE_BINDING);
    expect(bindCompiledHost({ ...FAKE_HOST, exe: "/fixture/other-node" }, FAKE_BINDING.activationId, FAKE_COMPILE).identitySha).not.toBe(FAKE_BINDING.identitySha);
    expect(JSON.stringify(FAKE_BINDING)).not.toMatch(/cmdline|\/fixture\/|uid|ppid/);
  });

  test("invalid limit overrides cannot unbound the ledger or admission lifetime", () => {
    for (const limits of [{ maxRecords: Infinity }, { maxRecords: 0 }, { idleTtlMs: NaN }, { budgetMs: 1e9 }]) {
      expect(() => createModeld({ ...limits, authority, loadModels: () => STUB_MODELS, driver: { accepts: () => true, complete: () => parts } })).toThrow(/limit/);
    }
  });
  test.each(["generationId", "activationId", "sourceSha", "pid", "start", "identitySha"] as const)("wrong %s precedes configuration, credentials and driver", async (field) => {
    const effects = { models: 0, credential: 0, driver: 0 };
    const kernel = createModeld({ authority, loadModels: () => { effects.models++; return STUB_MODELS; },
      credentialFingerprint: () => { effects.credential++; return sha256Text("fake"); },
      driver: { accepts: () => true, complete: () => { effects.driver++; return parts; } } });
    try {
      const wrong = { ...FAKE_BINDING, [field]: typeof FAKE_BINDING[field] === "number" ? 999 : field === "activationId" ? "other-operation" : "f".repeat(64) };
      expect(await kernel.admit(submitRequest(kernel, "inv", { host: wrong }))).toMatchObject({ ok: false });
      expect(effects).toEqual({ models: 0, credential: 0, driver: 0 });
    } finally { kernel.stop(); }
  });

  test("bounded pending wait succeeds only on matching commit, never last-resort official", async () => {
    let fact: AdmissionAuthority = { state: "pending" };
    const kernel = createModeld({ authority: () => fact, loadModels: () => STUB_MODELS, budgetMs: 35,
      driver: { accepts: () => true, complete: () => parts } });
    try {
      const timeout = await within(kernel.admit(submitRequest(kernel, "timeout")));
      expect(timeout).toMatchObject({ ok: false, code: "admission-timeout", userVisible: true });
      expect(JSON.stringify(timeout)).not.toMatch(/official|lastResort/);
      const pending = kernel.admit(submitRequest(kernel, "commits"));
      fact = authority();
      expect(await within(pending)).toMatchObject({ ok: true, dispatched: true });
      expect(kernel.stats().dispatches).toBe(1);
    } finally { kernel.stop(); }
  });

  test("per-bot resolve snapshots every config field before fingerprint awaits; active Tom is isolated from Jerry", async () => {
    let file = fakeModels();
    const pins: ModelPin[] = [];
    const releases: Array<() => void> = [];
    let fingerprints = 0;
    let releaseFingerprint!: () => void;
    const ports: ModeldPorts = { authority, loadModels: () => file, credentialFingerprint: async () => {
      fingerprints++;
      if (fingerprints === 1) await new Promise<void>((r) => { releaseFingerprint = r; });
      return sha256Text(`fake-credential-${fingerprints}`);
    } };
    const kernel = createModeld({ ...ports, driver: { accepts: () => true, complete: async ({ pin }) => {
      pins.push(pin); await new Promise<void>((r) => releases.push(r)); return parts;
    } } });
    try {
      const first = kernel.admit(submitRequest(kernel, "tom"));
      while (!releaseFingerprint) await Bun.sleep(1);
      file.models["fake/smart"]!.endpoint = "fake:changed";
      file.models["fake/smart"]!.dataTypes.push("changed");
      file.models["fake/smart"]!.capabilities.vision = true;
      file.assignments.agents["agent-tom"] = "fake/fast";
      releaseFingerprint();
      while (pins.length < 1) await Bun.sleep(1);
      const duplicate = kernel.admit(submitRequest(kernel, "tom"));
      const jerry = kernel.admit(submitRequest(kernel, "jerry", { agentId: "agent-jerry" }));
      while (pins.length < 2) await Bun.sleep(1);
      expect(pins[0]!.model).toMatchObject({ id: "fake/smart", endpoint: "fake:smart", dataTypes: ["text", "tools"], capabilities: { vision: false } });
      expect(pins[1]!.model.id).toBe("fake/fast");
      expect(Object.isFrozen(pins[0])).toBe(true);
      expect(Object.isFrozen(pins[0]!.model.capabilities)).toBe(true);
      expect(() => pins[0]!.model.dataTypes.push("mutation")).toThrow();
      releases.forEach((r) => r());
      expect(await first).toMatchObject({ ok: true, dispatched: true, assignment: "agent" });
      expect(await duplicate).toMatchObject({ ok: true, dispatched: false });
      expect(await jerry).toMatchObject({ ok: true, assignment: "main" });
      expect(fingerprints).toBe(2); expect(kernel.stats()).toMatchObject({ dispatches: 2, pins: 2 });
      kernel.disconnect(submitRequest(kernel, "tom"));
      kernel.disconnect(submitRequest(kernel, "jerry"));
      expect(kernel.stats().pins).toBe(0);
      file = { ...file, assignments: { main: null, agents: {} } };
      expect(await kernel.admit(submitRequest(kernel, "missing"))).toMatchObject({ ok: false, code: "missing-assignment" });
    } finally { kernel.stop(); }
  });

  test("rechecks authority after fingerprint await before any driver effect", async () => {
    let fact = authority(); let release!: () => void;
    const kernel = createModeld({ authority: () => fact, loadModels: fakeModels,
      credentialFingerprint: async () => { await new Promise<void>((r) => { release = r; }); return sha256Text("synthetic-only"); },
      driver: { accepts: () => true, complete: () => parts } });
    try {
      const pending = kernel.admit(submitRequest(kernel, "late-drift"));
      while (!release) await Bun.sleep(1);
      fact = { state: "disabled" }; release();
      expect(await pending).toMatchObject({ ok: false, code: "disabled" }); expect(kernel.stats().dispatches).toBe(0);
    } finally { kernel.stop(); }
  });

  test("same turn pin reservation is shared; envelope conflicts cannot mutate the original invocation", async () => {
    let fingerprints = 0; const ends: Array<() => void> = [];
    const kernel = createModeld({ authority, loadModels: fakeModels, credentialFingerprint: () => { fingerprints++; return sha256Text("fake"); },
      driver: { accepts: () => true, complete: async () => { await new Promise<void>((r) => ends.push(r)); return parts; } } });
    try {
      const one = kernel.admit(submitRequest(kernel, "one", { turnId: "same-turn" }));
      const two = kernel.admit(submitRequest(kernel, "two", { turnId: "same-turn" }));
      while (ends.length < 2) await Bun.sleep(1);
      expect(fingerprints).toBe(1); expect(kernel.stats().pins).toBe(1);
      expect(await kernel.admit(submitRequest(kernel, "one", { envelope: buildModelEnvelope([{ role: "user", content: "different" }]) }))).toMatchObject({ ok: false, code: "conflict" });
      ends.forEach((r) => r()); await Promise.all([one, two]); expect(kernel.stats().pins).toBe(1);
      kernel.disconnect(submitRequest(kernel, "one", { turnId: "same-turn" }));
      kernel.disconnect(submitRequest(kernel, "two", { turnId: "same-turn" }));
      expect(kernel.stats().pins).toBe(0);
    } finally { kernel.stop(); }
  });

  test("TTL releases heavy pins/results but keeps bounded refusal tombstones; generation retirement frees capacity", async () => {
    let clock = 0; let fact = authority();
    const kernel = createModeld({ authority: () => fact, loadModels: () => STUB_MODELS, now: () => clock, idleTtlMs: 1000, maxRecords: 1,
      driver: { accepts: () => true, complete: () => parts } });
    try {
      expect(await kernel.admit(submitRequest(kernel, "old"))).toMatchObject({ ok: true });
      clock = 1001; kernel.sweep();
      expect(await kernel.admit(submitRequest(kernel, "old"))).toMatchObject({ ok: false, code: "expired" });
      expect(await kernel.admit(submitRequest(kernel, "new"))).toMatchObject({ ok: false, code: "capacity" });
      expect(kernel.stats()).toEqual({ dispatches: 1, records: 1, pins: 0 });
      const next = { ...FAKE_BINDING, generationId: "b".repeat(64), activationId: "new-operation" };
      fact = { state: "committed", host: next };
      expect(await kernel.admit(submitRequest(kernel, "new", { host: next }))).toMatchObject({ ok: true });
      expect(kernel.stats()).toEqual({ dispatches: 2, records: 1, pins: 1 });
    } finally { kernel.stop(); }
  });

  test("disconnect/stop fence pending ports without waiting or late dispatch", async () => {
    let release!: () => void;
    const kernel = createModeld({ authority, loadModels: async () => { await new Promise<void>((r) => { release = r; }); return STUB_MODELS; },
      driver: { accepts: () => true, complete: () => parts } });
    try {
      const request = submitRequest(kernel, "pending"); const pending = kernel.admit(request);
      while (!release) await Bun.sleep(1);
      kernel.disconnect(request);
      expect(await within(pending)).toMatchObject({ ok: false, code: "disconnected" });
      release(); await Bun.sleep(1); expect(kernel.stats().dispatches).toBe(0);
      expect(await kernel.admit(request)).toMatchObject({ ok: false, code: "disconnected" });
      kernel.stop(); expect(await kernel.admit(submitRequest(kernel, "stopped"))).toMatchObject({ ok: false, code: "stopped" });
    } finally { kernel.stop(); }
  });
});
