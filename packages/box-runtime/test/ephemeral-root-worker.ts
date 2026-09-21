import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../src/internal/io/authority.node.ts";
import { recoverControllerOperationState, liveMutationAttempts, resetLiveMutationAttempts } from "../src/internal/roots/controller-program.node.ts";
import { ephemeralRuntimeRoot } from "../src/internal/io/ephemeral.ts";
import type { ModelsFile } from "@grokbox/runtime-kernel/selection";
import { projectLiveStatus } from "../src/internal/io/observe.ts";
import { operationLockPath } from "../src/internal/io/operation-lease.node.ts";
import type { ProcessIdentity, ProcessPort } from "../src/internal/process/process-port.ts";
import { SHA } from "./admission-fixture.ts";

const models: ModelsFile = { version: 3, models: {}, assignments: { main: null, agents: {} } };
if (!process.env.HOME || homedir() !== process.env.HOME) throw Error("isolated_HOME_required");
const runRoot = join(homedir(), ".grokbox", "run"), xdg = process.env.XDG_RUNTIME_DIR;
if (!xdg || runRoot === "/home/box/.grokbox/run" || ephemeralRuntimeRoot() !== runRoot) throw Error("unowned_run_root");
async function snapshot(dir: string): Promise<string> {
  let names: string[];
  try { names = (await readdir(dir, { recursive: true })).map(String).sort(); } catch { return ""; }
  return (await Promise.all(names.map(async name => {
    try { return `${name}:${await readFile(join(dir, name), "utf8")}`; } catch { return `${name}:`; }
  }))).join("\n");
}
function officialChain() {
  const ident = (value: Partial<ProcessIdentity> & Pick<ProcessIdentity, "pid" | "cmdline">): ProcessIdentity => ({ uid: 1000, start: 1, exe: "/exec-daemon/node", ppid: 1, ancestry: [1], ...value });
  const wrapper = ident({ pid: 11, exe: "/usr/local/bin/supervise-sand-supervisor", cmdline: ["/usr/local/bin/supervise-sand-supervisor"] });
  const supervisor = ident({ pid: 22, cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"], ppid: 11, ancestry: [11, 1] });
  const host = ident({ pid: 33, start: 100, cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"], ppid: 22, ancestry: [22, 11, 1] });
  const processes: ProcessPort = { inspect: pid => [wrapper, supervisor, host].find(p => p.pid === pid) ?? null, list: () => [wrapper, supervisor, host],
    signal: () => { throw Error("read_must_not_signal"); } };
  return { host, processes };
}
function attFor(host: ProcessIdentity, diskSha = SHA): CoverageAttestation {
  return { mode: "identity", coverage: "attested", diskSha, pid: host.pid, start: host.start, identity: host,
    at: "2026-09-05T00:00:00.000Z", modeld: false, windowMs: 12, launchMode: "direct-launch" };
}
async function status(root: string, chain: ReturnType<typeof officialChain>) {
  return projectLiveStatus({ root, desired: { version: 1, mode: "identity" }, models, processes: chain.processes,
    diskSha: SHA, envHas: (pid, key) => pid === chain.host.pid && key === "GROKBOX_PRELOAD_MODE" });
}
async function statusCanonical() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-root-status-")), chain = officialChain(), decoy = join(xdg!, "grokbox");
  await writeAttestation(runRoot, attFor(chain.host)); await writeAttestation(decoy, attFor(chain.host, "xdg-decoy-sha"));
  const beforeHome = await snapshot(runRoot), beforeXdg = await snapshot(decoy), observed = await status(root, chain);
  return { defaultRoot: ephemeralRuntimeRoot(), runRoot, origin: observed.facets.bridge.value?.origin, reason: observed.facets.bridge.value?.reason,
    coverage: observed.facets.bridge.value?.coverage, homeUnchanged: await snapshot(runRoot) === beforeHome, xdgUnchanged: await snapshot(decoy) === beforeXdg };
}
async function controllerRecoveryRoots() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-root-controller-")), override = await mkdtemp(join(tmpdir(), "grokbox-root-override-"));
  const beforeHome = await snapshot(runRoot), beforeXdg = await snapshot(xdg!), beforeOverride = await snapshot(override);
  resetLiveMutationAttempts();
  const normal = await recoverControllerOperationState({ boxRoot: root });
  const explicit = await recoverControllerOperationState({ boxRoot: root, ephemeralRoot: override });
  return { defaultRoot: ephemeralRuntimeRoot(), overrideRoot: ephemeralRuntimeRoot(override), normal, explicit, mutations: { ...liveMutationAttempts },
    lockPath: operationLockPath(runRoot),
    homeUnchanged: await snapshot(runRoot) === beforeHome, xdgUnchanged: await snapshot(xdg!) === beforeXdg, overrideUnchanged: await snapshot(override) === beforeOverride };
}
async function noImport() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-root-decoy-")), decoy = await mkdtemp(join(tmpdir(), "grokbox-unselected-")), chain = officialChain();
  await writeAttestation(join(xdg!, "grokbox"), attFor(chain.host)); await writeAttestation(decoy, attFor(chain.host));
  const before = await snapshot(runRoot), observed = await status(root, chain);
  resetLiveMutationAttempts(); const recovery = await recoverControllerOperationState({ boxRoot: root });
  return { origin: observed.facets.bridge.value?.origin, coverage: observed.facets.bridge.value?.coverage, recovery, mutations: { ...liveMutationAttempts },
    homeAtt: await readAttestation(runRoot), homeUnchangedAfterStatus: await snapshot(runRoot) === before,
    xdgStillThere: (await readFile(join(xdg!, "grokbox", "attestation.json"), "utf8")).includes("attested"),
    tmpStillThere: (await readFile(join(decoy, "attestation.json"), "utf8")).includes("attested") };
}
const scenario = process.argv[2];
const run = scenario === "status-canonical" ? statusCanonical : scenario === "controller-recovery-roots" ? controllerRecoveryRoots : scenario === "no-import" ? noImport : null;
if (!run) throw Error("unknown_isolated_scenario");
console.log(JSON.stringify(await run()));
