import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { runRuntimeServiceCommand } from "../src/internal/roots/runtime-services.runtime.ts";
import type { ServiceManager, RuntimeServiceRequest } from "../src/internal/io/runtime-services.node.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "runtime-service-install-")), root = join(dir, "durable"), run = join(dir, "run"), home = join(dir, "home"), release = join(dir, "release with space");
  for (const p of [root, run, home, release, join(release, "dist")]) await mkdir(p, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify(defaultConfig()), { mode: 0o600 });
  await writeFile(join(release, "package.json"), JSON.stringify({ name: "grokbox", version: "0.0.0-fixture" }), { mode: 0o600 });
  await writeFile(join(release, "dist/index.js"), "// owned release fixture\n", { mode: 0o600 });
  await writeFile(join(release, "dist/preload.cjs"), "// owned preload fixture\n", { mode: 0o600 });
  const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 5000 }).trim();
  const calls: string[] = [], enabled = new Set<string>(); let active = false, supported = true, lose = false;
  const manager: ServiceManager = {
    probe: async () => ({ available: supported, bootPersistent: supported, reason: supported ? "ready" : "user_manager_unavailable" }),
    states: async names => names.map(name => ({ name, active: active ? "active" : "inactive", enabled: enabled.has(name), mainPid: active ? 1234 : 0 })),
    reload: async () => { calls.push("reload"); },
    enable: async (names, start) => { calls.push(start ? "enable-start" : "enable"); for (const n of names) enabled.add(n); if (start) active = true; if (lose) throw Error("owned_manager_ack_lost"); },
    disable: async names => { calls.push("disable"); for (const n of names) enabled.delete(n); },
  };
  const input = { durableRoot: root, runRoot: run, home, releaseRoot: release, nodeExecutable: node };
  const command = (action: RuntimeServiceRequest["action"], rest: Partial<RuntimeServiceRequest> = {}) => runRuntimeServiceCommand({ ...input, action, ...rest }, manager);
  return { dir, root, run, home, release, input, command, manager, calls, unitDir: join(home, ".config/systemd/user"),
    unsupported: () => { supported = false; }, active: (value: boolean) => { active = value; }, lose: (value: boolean) => { lose = value; },
    close: () => rm(dir, { recursive: true, force: true }) };
}
const digest = (v: Awaited<ReturnType<typeof runRuntimeServiceCommand>>) => {
  if (!("planDigest" in v)) throw Error("expected_plan"); return v.planDigest;
};

test("service preview and status do not create directories, units, activation or credentials", async () => {
  const f = await fixture();
  try {
    const before = await readdir(f.home), root = await readdir(f.root);
    expect(await f.command("status")).toMatchObject({ phase: "not_installed", createsServices: false, executionQualified: false });
    const plan = await f.command("install"); expect(plan).toMatchObject({ written: false, startsNow: false, affectsHost: false, importsShellCredentials: false });
    expect(f.calls).toEqual([]); expect(await readdir(f.home)).toEqual(before); expect(await readdir(f.root)).toEqual(root);
    await expect(f.command("install", { confirmed: true, expectedPlan: "0".repeat(64) })).rejects.toMatchObject({ reason: "plan_conflict" });
    expect(await readdir(f.home)).toEqual(before);
  } finally { await f.close(); }
});

test("unsupported manager refuses before writing; desktop files or a binary alone never constitute boot registration", async () => {
  const f = await fixture();
  try {
    f.unsupported(); const plan = await f.command("install");
    expect(plan).toMatchObject({ environment: { available: false } });
    await expect(f.command("install", { confirmed: true, expectedPlan: digest(plan) })).rejects.toMatchObject({ reason: "user_manager_unavailable" });
    expect(await readdir(f.home)).toEqual([]); expect(await readdir(f.root)).toEqual(["config.json"]); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test("confirmed installation enables exact immutable-release units without starting them, and inactive removal is scoped", async () => {
  const f = await fixture();
  try {
    const plan = await f.command("install"), done = await f.command("install", { confirmed: true, expectedPlan: digest(plan) });
    expect(done).toMatchObject({ phase: "installed", written: true, startsNow: false, executionQualified: false }); expect(f.calls).toEqual(["reload", "enable"]);
    const names = (await readdir(f.unitDir)).sort(); expect(names).toHaveLength(2);
    for (const name of names) {
      const unit = await readFile(join(f.unitDir, name), "utf8");
      expect(unit).toContain("Type=exec"); expect(unit).toContain("WantedBy=default.target"); expect(unit).toContain("RestartSec=30"); expect(unit).toContain("SendSIGKILL=no");
      expect(unit).toContain(f.release); expect(unit).not.toContain("NODE_OPTIONS"); expect(unit).not.toContain("API_KEY"); expect(unit).not.toContain("nohup");
    }
    expect(await f.command("status")).toMatchObject({ phase: "installed", artifactsMatched: true, filesMatched: true });
    const remove = await f.command("uninstall"); f.active(true);
    await expect(f.command("uninstall", { confirmed: true, expectedPlan: digest(remove) })).rejects.toMatchObject({ reason: "services_must_be_stopped" });
    expect(await readdir(f.unitDir)).toHaveLength(2);
    f.active(false); const clean = await f.command("uninstall");
    expect(await f.command("uninstall", { confirmed: true, expectedPlan: digest(clean) })).toMatchObject({ phase: "retired", written: true });
    expect(await readdir(f.unitDir)).toEqual([]); expect(await readdir(f.root)).toContain("config.json");
    const again = await f.command("uninstall"); expect(await f.command("uninstall", { confirmed: true, expectedPlan: digest(again) })).toMatchObject({ phase: "retired", unchanged: true, written: false });
  } finally { await f.close(); }
});

test("manager acknowledgement loss remains preparing and can only resume the exact owned definition", async () => {
  const f = await fixture();
  try {
    f.lose(true); const plan = await f.command("install");
    await expect(f.command("install", { confirmed: true, expectedPlan: digest(plan) })).rejects.toMatchObject({ reason: "installation_outcome_unknown" });
    expect(await f.command("status")).toMatchObject({ phase: "preparing", filesMatched: true });
    f.lose(false); const resume = await f.command("install");
    expect(await f.command("install", { confirmed: true, expectedPlan: digest(resume) })).toMatchObject({ phase: "installed" });
    const name = (await readdir(f.unitDir))[0]!; await writeFile(join(f.unitDir, name), "USER_EDIT", { mode: 0o600 });
    await expect(f.command("uninstall")).rejects.toMatchObject({ reason: "unit_changed" });
    expect(await readFile(join(f.unitDir, name), "utf8")).toBe("USER_EDIT");
  } finally { await f.close(); }
});

test("the actual Node pre-start check refuses changed release bytes before the application entry can execute", async () => {
  const f = await fixture();
  try {
    const plan = await f.command("install"); await f.command("install", { confirmed: true, expectedPlan: digest(plan) });
    const names = await readdir(f.unitDir), text = await readFile(join(f.unitDir, names[0]!), "utf8");
    const line = text.split("\n").find(s => s.startsWith("ExecStartPre="))!;
    const args = line.slice("ExecStartPre=".length).match(/"(?:\\.|[^"\\])*"/g)!.map(part => JSON.parse(part) as string);
    expect(args[1]).toBe("--eval");
    const valid = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", timeout: 5000 }); expect(valid.status, valid.stderr).toBe(0);
    await writeFile(join(f.release, "dist/index.js"), "throw Error('must-not-run')", { mode: 0o600 });
    const changed = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", timeout: 5000 });
    expect(changed.status).toBe(78); expect(changed.stderr).not.toContain("must-not-run");
    expect(await f.command("status")).toMatchObject({ artifactsMatched: false, filesMatched: true });
  } finally { await f.close(); }
});

test.skipIf(process.env.GROKBOX_TEST_SERVICE_MANAGER !== "1")("installed systemd parser accepts the generated units without a service-manager mutation", async () => {
  const f = await fixture();
  try {
    const plan = await f.command("install"); await f.command("install", { confirmed: true, expectedPlan: digest(plan) });
    const names = (await readdir(f.unitDir)).map(name => join(f.unitDir, name));
    const checked = spawnSync("systemd-analyze", ["verify", "--man=no", "--generators=no", ...names], { encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, HOME: f.home, SYSTEMD_LOG_LEVEL: "warning" } });
    expect(checked.error).toBeUndefined(); expect(checked.status, checked.stderr).toBe(0);
    expect(f.calls).toEqual(["reload", "enable"]); // Calls are only to our fake manager; verify is a real offline parser.
  } finally { await f.close(); }
});

test("changed artifacts invalidate a captured plan and source checkouts cannot be registered", async () => {
  const f = await fixture();
  try {
    const plan = await f.command("install"); await writeFile(join(f.release, "dist/index.js"), "// changed\n", { mode: 0o600 });
    await expect(f.command("install", { confirmed: true, expectedPlan: digest(plan) })).rejects.toMatchObject({ reason: "plan_conflict" });
    expect(f.calls).toEqual([]);
    await writeFile(join(f.release, ".git"), "gitdir: owned-fixture");
    await expect(f.command("install")).rejects.toMatchObject({ reason: "source_checkout_not_release" });
    expect(await readdir(f.home)).toEqual([]);
  } finally { await f.close(); }
});
