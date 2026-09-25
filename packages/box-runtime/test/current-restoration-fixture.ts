import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { prepareOriginalRestoration, type RestorationPorts } from "../src/internal/process/adopt-restoration.ts";
import { restorationSnapshot } from "../src/internal/process/restoration-proof.ts";
import type { CurrentRestorationQualification, RetirementObservation } from "../src/internal/process/current-restoration.ts";
import { FakeProcessTree } from "./fake-tree.ts";

const hash = "a".repeat(64);
export async function currentRestorationFixture(replacement = false) {
  const root = await mkdtemp(join(tmpdir(), "current-retirement-")), runRoot = join(root, "run");
  await mkdir(join(root, "state")); await mkdir(join(runRoot, "state"), { recursive: true, mode: 0o700 });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }), host = tree.spawn("host", { parent: supervisor });
  const oldTemp = tree.spawn("temp-supervisor", { parent: wrapper }), markerHost = tree.spawn("extra"), candidate = tree.spawn("extra"), upper = tree.spawn("extra");
  tree.kill(oldTemp); tree.kill(markerHost); if (!replacement) tree.kill(candidate);
  const lease = await acquireOperationLease(join(root, "owned.lock"), "original"); if (!lease.ok) throw Error("lease");
  const leaseOwner = { ...lease.lock.owner, start: String(BigInt(lease.lock.owner.start) + 1n) }; await lease.lock.release();
  const original = { state: "unknown", fingerprint: "original", leaseOwner, prefix: { signaled: true, spawned: true, guardian: true } };
  const store = { original, older: { state: "unknown", fingerprint: "older" } };
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original", tempSupervisor: oldTemp, adoptingSupervisor: null, host: null };
  const marker = { operationId: "original", pid: markerHost.pid, start: markerHost.start, compiled: true, transformed: true, modeld: false,
    compile: { profileId: "fixture", profileSha256: hash, sourceSha256: hash, transformedSha256: hash }, preloadSha256: hash };
  const files = [join(root, "state", "controller-operations.json"), join(runRoot, "state", "adopt-op.json"), join(runRoot, "state", "preload-marker.json")];
  for (const [i, value] of [store, journal, marker].entries()) await writeFile(files[i]!, JSON.stringify(value), { mode: 0o600 });
  const ref = (row: { pid: number; start: number }) => ({ pid: row.pid, start: row.start });
  const q: CurrentRestorationQualification = { version: 1, kind: "maintainer-qualified-current-retirement", operationId: "original", qualifiedAt: new Date().toISOString(), qualifierUid: process.getuid!(),
    provenance: { supportedWriterSha256: hash, launchSha256: hash, inventorySha256: hash, pidViewSha256: hash, clockCalibrationSha256: hash, allocationSha256: hash },
    original: { operations: restorationSnapshot(files[0]!).sha256!, journal: restorationSnapshot(files[1]!).sha256!, marker: restorationSnapshot(files[2]!).sha256!, attestation: null, ownerClaim: null, archivedJournal: null, archivedMarker: null },
    launch: { rootDigest: sha256Text(root), targetDigest: hash, exeDigest: hash, argvDigest: hash, uid: process.getuid!(), mode: "route" },
    view: { bootId: leaseOwner.bootId, pid: "pid:[1]", time: "time:[1]", mnt: "mnt:[1]", anchor: ref(wrapper), clock: { anchor: ref(wrapper), originalStart: wrapper.start } },
    hostScope: { lowerInclusive: oldTemp.start - 1, upper: ref(upper), invariant: "detached-session-leader" },
    resources: { guardian: [], holder: [], delegatedNative: [], delegatedTools: [], restartOwners: [], independentOwners: [], scopes: [], roots: [root, runRoot], inodes: [], modeld: { kind: "absent", owners: [], socketPath: join(runRoot, "modeld.sock") } },
    replacements: replacement ? [{ lifetime: ref(candidate), imageSha256: hash, librarySha256: [hash], qualificationSha256: hash, descriptors: [{ fd: 0, digest: hash }] }] : [] };
  const observation: RetirementObservation = { version: 1, view: structuredClone(q.view), procMountSha256: hash, census: tree.list().map(row => ({ ...ref(row), pgid: row.pid === candidate.pid ? row.pid : wrapper.pid, sid: row.pid === candidate.pid ? row.pid : wrapper.pid, nspid: [row.pid], nstgid: [row.pid] })),
    candidates: replacement ? [{ lifetime: ref(candidate), relevantPreload: false, image: { sha256: hash, libraries: [hash], anchorSha256: hash }, descriptors: [{ fd: 0, digest: hash, relevant: false, locked: false }] }] : [], resourceHolders: [], modeld: null };
  const qualificationPath = join(root, "qualification.json");
  const save = async () => writeFile(qualificationPath, JSON.stringify(q), { mode: 0o600 }); await save();
  let reads = 0;
  const ports: RestorationPorts = { processes: tree, classify: row => { const role = tree.roles().find(item => item.pid === row.pid)?.role; return role === "extra" ? null : role as never; },
    gatewayPid: () => host.pid, hasRelevantPreload: () => false,
    current: { recoveryOwner: ref(wrapper), assertModeldAbsent: () => {}, observe: async () => { reads++; return structuredClone(observation); } } };
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original", restorationQualification: qualificationPath };
  const prepare = () => prepareOriginalRestoration({ operationId: "original", runRoot, storePath: files[0]!, expectedOperation: original, ports, qualificationPath });
  return { root, runRoot, files, q, observation, ports, input, save, prepare, reads: () => reads, candidate, markerHost, journal, tree, host };
}
