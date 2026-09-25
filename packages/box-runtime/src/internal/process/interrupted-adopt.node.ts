import { mkdirSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { adoptionEvidencePath, adoptionOwnerPath, parseAdoptLaunch, preserveAdoptionMarker } from "./adopt-evidence.ts";
import { restorationSnapshot } from "./restoration-proof.ts";
import { operationOwnerState, parseOperationLeaseOwner } from "../io/operation-lease.node.ts";
import { findAdoptedHostState, type RoleClassifier } from "./official-chain.ts";
import type { ProcessIdentity, ProcessPort } from "./process-port.ts";
import type { IdentityMarker } from "./identity-op.ts";
import { reconcileMarkerCompilation } from "../io/host-compilation.node.ts";

/** Continue only the current physical generation with an original child birth
 * receipt. The interrupted operation stays unknown; no signal or spawn occurs.
 * This is not a way to discharge an absent or unrelated historical owner. */
export async function prepareInterruptedObservedCommit(input: {
  boxRoot: string; runRoot: string;
  snapshot: { host: ProcessIdentity; supervisor: ProcessIdentity; marker: IdentityMarker; gatewayPid: number | null };
  processes: ProcessPort; classify: RoleClassifier;
}): Promise<(() => void) | null> {
  try {
    const { snapshot: s, runRoot: root } = input, id = s.marker.operationId;
    const paths = [join(input.boxRoot, "state/controller-operations.json"), adoptionOwnerPath(root),
      join(root, "state/adopt-op.json"), adoptionEvidencePath(root, id, "journal"),
      join(root, "state/launch-env.json.child.json"), join(root, "state/preload-marker.json")];
    const files = paths.map(path => restorationSnapshot(path));
    if (files.some(file => !file.bytes || (file.identity![5]! & 0o077) !== 0)) return null;
    const [store, owner, journal, archived, child, marker] = files.map(file => JSON.parse(file.bytes!.toString()));
    const original = store[id], lease = parseOperationLeaseOwner(original?.leaseOwner);
    if (original?.state !== "unknown" || !lease || lease.operationId !== id || await operationOwnerState(lease) !== "stale"
      || owner.version !== 1 || owner.state !== "unresolved" || owner.operationId !== id
      || journal.operationId !== id || journal.phase !== "spawn-temp" || journal.compile || journal.failure
      || !journal.tempSupervisor || journal.host !== null || journal.adoptingSupervisor !== null
      || !isDeepStrictEqual(journal, archived) || !isDeepStrictEqual(marker, s.marker)
      || child.operationId !== id || child.pid !== s.host.pid || child.start !== s.host.start
      || child.supervisor?.pid !== journal.tempSupervisor.pid || child.supervisor?.start !== journal.tempSupervisor.start
      || child.exitCode !== null || child.signal !== null) return null;
    const launch = parseAdoptLaunch(child.launch), observation = reconcileMarkerCompilation(marker,
      { rootDigest: launch.rootDigest, targetDigest: launch.targetDigest, uid: launch.uid, now: Date.now() });
    if (!observation || launch.rootDigest !== sha256Text(resolve(input.boxRoot)) || launch.uid !== s.host.uid
      || launch.mode !== "route" || launch.targetDigest !== observation.targetDigest
      || launch.exeDigest !== sha256Text(s.host.exe) || launch.argvDigest !== sha256Text(JSON.stringify(s.host.cmdline))
      || observation.rootDigest !== launch.rootDigest || observation.pid !== s.host.pid || observation.start !== s.host.start
      || observation.exeDigest !== launch.exeDigest || observation.argvDigest !== launch.argvDigest) return null;
    const stable = () => {
      for (const before of files) {
        const now = restorationSnapshot(before.path);
        if (now.sha256 !== before.sha256 || !isDeepStrictEqual(now.identity, before.identity)) throw Error("interrupted-evidence-changed");
      }
      const rows = input.processes.list();
      if (rows.some(row => ["temp-supervisor", "guardian"].includes(input.classify(row) ?? "")
        || row.cmdline.some(arg => /(?:^|\/)(guardian-child|injector-hold)\.cjs$/.test(arg)))) throw Error("interrupted-owner-present");
      const old = input.processes.inspectLifetime?.(journal.tempSupervisor.pid) ?? input.processes.inspect(journal.tempSupervisor.pid);
      if (old && old.start === journal.tempSupervisor.start) throw Error("interrupted-owner-present");
      const adopted = findAdoptedHostState({ ...input.processes, list: () => rows }, input.classify,
        { gatewayPid: s.gatewayPid, expectedHost: s.host });
      if (!adopted.ok || !isDeepStrictEqual(adopted.state.host, s.host) || !isDeepStrictEqual(adopted.state.supervisor, s.supervisor))
        throw Error("interrupted-generation-changed");
    };
    stable();
    return () => {
      stable();
      // Preserve exact original evidence before the existing publisher advances
      // its mutable journal. Never reinterpret the original unknown as success.
      const path = join(root, "state/adoptions", id, "interrupted-before-commit.json");
      const bytes = JSON.stringify({ version: 1, operationId: id, original, owner, journal, child, marker,
        digests: files.map(file => file.sha256) }) + "\n";
      mkdirSync(join(root, "state/adoptions", id), { recursive: true, mode: 0o700 });
      const prior = restorationSnapshot(path, true);
      if (prior.bytes) { if (prior.bytes.toString() !== bytes) throw Error("interrupted-evidence-conflict"); }
      else {
        const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        linkSync(temporary, path);
      }
      preserveAdoptionMarker(root, id, paths[5]!);
      const directory = openSync(join(root, "state/adoptions", id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      stable();
    };
  } catch { return null; }
}
