import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { pinLaunchProfile } from "../src/internal/process/profile.node.ts";
import { WATCHDOG_OPERATION_ID, type ManualReadoptInput } from "../src/internal/roots/controller.runtime.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import type { IdentityMarker } from "../src/internal/process/identity-op.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";
import { applyPatchProfile, type PatchProfile } from "../src/internal/host/profile.ts";
import { SOURCE, SHA, reviewed } from "./admission-fixture.ts";
import { FakeProcessTree } from "./fake-tree.ts";

/** Real isolated files + fake processes and modeld. No live ports, Host reads or provider effects. */
export async function receiptFixture(mode: "identity" | "route" = "route", refresh = false) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-receipt-"));
  const ephemeralRoot = join(root, "run");
  await mkdir(join(root, "profiles"));
  const sourcePath = join(root, "synthetic-host.cjs");
  await writeFile(sourcePath, SOURCE);
  await writeFile(reviewedProfilePath(root), JSON.stringify(reviewed));
  const tree = new FakeProcessTree();
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", refresh ? undefined : { parent: supervisor });
  const touched = new Set(refresh ? [host.pid] : []);
  const gateway = { pid: host.pid };
  const modeld = { ready: true };
  const counts = { launches: 0, prepares: 0, markers: 0 };
  const launch = { profilePath: "", marker: null as IdentityMarker | null };
  if (refresh) await writeAttestation(ephemeralRoot, {
    mode: "identity", coverage: "attested", modeld: false, diskSha: SHA,
    pid: host.pid, start: host.start, identity: host, launchMode: "transient-adopt", at: new Date(0).toISOString(),
    profileId: reviewed.profileId, transformedSha: reviewed.transformedSourceSha256,
  });
  const input: ManualReadoptInput = {
    root, ephemeralRoot, confirmed: true, now: () => 100,
    desired: { version: 1, mode }, models: { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } },
    diskSha: SHA, reviewedProfile: structuredClone(reviewed), processes: tree,
    classify: (ident) => {
      const role = tree.roles().find((row) => row.pid === ident.pid)?.role;
      return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null;
    },
    envHas: (pid) => touched.has(pid),
    modeldReady: () => modeld.ready,
    waitReplacement: async () => {
      const born = tree.spawn("host", { parent: supervisor });
      gateway.pid = born.pid;
      return born;
    },
    adopt: {
      target: { readSource: () => SOURCE, launchStrategy: () => "transient-adopt-candidate" },
      prepareTempLaunch: async (profile) => {
        counts.prepares += 1;
        launch.profilePath = await pinLaunchProfile(ephemeralRoot, profile);
      },
      spawnTempSupervisor: async () => {
        counts.launches += 1;
        const temp = tree.spawn("temp-supervisor");
        const born = tree.spawn("host", { parent: temp });
        touched.add(born.pid);
        gateway.pid = born.pid;
        return temp;
      },
      waitNewHost: async (old) => tree.roles().find((row) => row.role === "host" && row.pid !== old) ?? null,
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReady: async (pid) => {
        const bytes = await readFile(launch.profilePath);
        const profile = JSON.parse(bytes.toString("utf8")) as PatchProfile;
        const applied = applyPatchProfile(SOURCE, profile);
        if (!applied.ok) return null;
        counts.markers += 1;
        launch.marker = {
          operationId: WATCHDOG_OPERATION_ID, pid, start: tree.inspect(pid)!.start,
          mode, transformed: true, compiled: true, modeld: false,
          compile: { profileId: profile.profileId, profileSha256: sha256Bytes(bytes),
            sourceSha256: applied.sourceSha256, transformedSha256: applied.transformedSha256 },
        };
        return launch.marker;
      },
      armGuardian: async () => ({ ok: true, release: () => {
        tree.signal(wrapper, "SIGCONT");
        if (!tree.roles().some((row) => row.role === "supervisor")) tree.spawn("supervisor", { parent: wrapper });
      } }),
      readGatewayPid: () => gateway.pid,
      hasGrokboxPreload: (ident) => touched.has(ident.pid),
      adoptProveMs: 20,
    },
  };
  return { root, ephemeralRoot, sourcePath, tree, host, supervisor, wrapper, touched, gateway, modeld, counts, launch, input };
}
