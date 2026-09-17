import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { openConfigStore } from "../src/internal/io/config-store.node.ts";
import { rootConfigLayout, readConfigLayout, publishLayoutAliases, publishConfigFile } from "../src/internal/io/config-layout.node.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-config2-"));
  return { root, store: openConfigStore(rootConfigLayout(root)) };
}
const request = (path: string, value: unknown) => ({ operationId: randomUUID(), scope: "box" as const, kind: "set" as const, path, value });

describe("unified physical configuration commit", () => {
  test("missing is read-only; invalid schema keeps exact original bytes", async () => {
    const { root, store } = await fixture();
    expect((await store.read()).exists).toBe(false);
    expect(await readFile(join(root, "config.json"), "utf8").catch(() => "missing")).toBe("missing");
    await Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", false)));
    const before = await readFile(join(root, "config.json"), "utf8");
    await expect(Effect.runPromise(store.change(request("desktop.idleReclaim.minIdleMs", 10)))).rejects.toThrow();
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
  });
  test("stale generic replacement fails without losing a domain keep update", async () => {
    const { store } = await fixture(); const before = await store.read();
    const id = "00000000-0000-4000-8000-000000000456";
    await Effect.runPromise(store.change({ operationId: randomUUID(), scope: "box", kind: "keep", action: "add", agentId: id }));
    await expect(Effect.runPromise(store.change({ ...request("ops.enabled", false), expectedRevision: before.revision }))).rejects.toThrow("changed");
    expect((await store.read()).document.desktop?.keepAgentIds).toEqual([id]);
    expect((await store.read()).document.ops).toBeUndefined();
  });
  test("same operation is idempotent; changed intent with the same ID conflicts", async () => {
    const { store } = await fixture(); const command = request("desktop.idleReclaim.enabled", true);
    const first = await Effect.runPromise(store.change(command));
    expect(first.commit).toBe("committed"); expect(first.application.state).toBe("pending");
    expect(await Effect.runPromise(store.change(command))).toEqual(first);
    await expect(Effect.runPromise(store.change({ ...command, value: false }))).rejects.toThrow("another configuration change");
    expect(await store.receipt(command.operationId)).toEqual(first);
  });
  test("same-document races never overwrite an unobserved successful write", async () => {
    const { store } = await fixture();
    const results = await Promise.allSettled([
      Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", true))),
      Effect.runPromise(store.change(request("runtime.desiredMode", "observe"))),
    ]);
    const successes = results.filter((item) => item.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const document = (await store.read()).document;
    if (results[0]!.status === "fulfilled") expect(document.desktop?.idleReclaim?.enabled).toBe(true);
    if (results[1]!.status === "fulfilled") expect(document.runtime?.desiredMode).toBe("observe");
  });
  test("legacy intent requires migration and a canonical symlink is refused", async () => {
    const { root, store } = await fixture(); await mkdir(join(root, "state"));
    await writeFile(join(root, "state", "desired.json"), '{"version":1,"mode":"route"}');
    await expect(store.read()).rejects.toThrow("migrate");
    const other = join(root, "other.json"); await writeFile(other, JSON.stringify(defaultConfig()));
    await symlink(other, join(root, "config.json"));
    await expect(store.read()).rejects.toThrow("symlink");
  });
  test("Box writes preserve the home alias; replacement with a regular file is detected", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-durable-"));
    const home = await mkdtemp(join(tmpdir(), "grokbox-home-")); const installationId = randomUUID();
    await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, role: "box", root, installationId });
    await publishConfigFile(join(root, "config.json"), defaultConfig());
    await publishLayoutAliases(home, root, installationId);
    const layout = await readConfigLayout(home, root); const store = openConfigStore(layout);
    await Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", true)));
    expect(await readlink(join(home, "config.json"))).toBe(join(root, "config.json"));
    expect(validateConfig(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).desktop?.idleReclaim?.enabled).toBe(true);
    await expect(readConfigLayout(home, join(root, "wrong-root"))).rejects.toThrow("match");
  });
  test("floor is a machine constraint even for the domain convenience mutation", async () => {
    const { root, store } = await fixture(); const id = "00000000-0000-4000-8000-000000000789";
    await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, role: "box", root, installationId: randomUUID(), desktop: { floorAgentIds: [id] } });
    await expect(Effect.runPromise(store.change({ operationId: randomUUID(), scope: "box", kind: "keep", action: "remove", agentId: id, confirm: true }))).rejects.toThrow("floor");
  });
  test("an uncertain prepared operation never rebases over a later committed preference", async () => {
    const { root, store } = await fixture();
    const command = request("desktop.idleReclaim.enabled", true);
    await Effect.runPromise(store.change(command));
    const { sha256Text } = await import("@grokbox/runtime-kernel/hash");
    const path = join(root, "state", "config-operations", `${sha256Text(command.operationId)}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.phase = "prepared";
    await publishConfigFile(path, record);
    await Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", false)));
    const before = await readFile(join(root, "config.json"), "utf8");
    await expect(Effect.runPromise(store.change(command))).rejects.toThrow("uncertain");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
    expect((await store.read()).document.desktop?.idleReclaim?.enabled).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).phase).toBe("prepared");
  });
  test("an A-to-B-to-A content hash cannot authorize replaying an uncertain operation", async () => {
    const { root, store } = await fixture();
    await Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", false)));
    const command = request("desktop.idleReclaim.enabled", true);
    await Effect.runPromise(store.change(command));
    const { sha256Text } = await import("@grokbox/runtime-kernel/hash");
    const path = join(root, "state", "config-operations", `${sha256Text(command.operationId)}.json`);
    const record = JSON.parse(await readFile(path, "utf8")); record.phase = "prepared";
    await publishConfigFile(path, record);
    await Effect.runPromise(store.change(request("desktop.idleReclaim.enabled", false)));
    expect((await store.read()).revision).toBe(record.beforeRevision);
    await expect(Effect.runPromise(store.change(command))).rejects.toThrow("uncertain");
    expect((await store.read()).document.desktop?.idleReclaim?.enabled).toBe(false);
  });
  test("prepared receipt reconciles a durable commit without publishing a second time", async () => {
    const { root, store } = await fixture(); const command = request("desktop.idleReclaim.enabled", true);
    const committed = await Effect.runPromise(store.change(command));
    const { sha256Text } = await import("@grokbox/runtime-kernel/hash");
    const path = join(root, "state", "config-operations", `${sha256Text(command.operationId)}.json`);
    const record = JSON.parse(await readFile(path, "utf8")); record.phase = "prepared";
    await publishConfigFile(path, record);
    expect(await store.receipt(command.operationId)).toEqual(committed);
    expect(await Effect.runPromise(store.change(command))).toEqual(committed);
  });
});
