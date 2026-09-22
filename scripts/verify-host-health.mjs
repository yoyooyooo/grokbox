import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureVerificationSource } from "./verification-source.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const group=process.argv[2]??"core",listOnly=process.argv[3]==="--list";
const groups=["core","integration","integration-host","integration-domains","integration-web","native-pair"];
if(process.argv.length>4||(process.argv[3]!==undefined&&!listOnly)||!groups.includes(group))throw Error("usage: verify-host-health.mjs [core|integration|integration-host|integration-domains|integration-web|native-pair] [--list]");
if(!listOnly&&group==="native-pair"&&(process.env.GROKBOX_TEST_NATIVE_CONTINUITY!=="1"||process.env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR!==undefined||!process.env.GROKBOX_TEST_NATIVE_NODE))
 throw Error("native-pair requires explicit native continuity opt-in and native Node executable; retired pair selectors are not supported and tests never authorize adoption.");
const bun=spawnSync("bun",["--version"],{encoding:"utf8"});
if(!listOnly&&(bun.status!==0||bun.stdout.trim()!=="1.3.14"))throw Error("Use the repository-declared Bun 1.3.14 on PATH for verification and nested builds.");
const suites={
 core:["packages/runtime-kernel/test/compaction-contract.test.ts","packages/box-runtime/test/journal-settlement.test.ts","packages/client/test","packages/runtime-kernel/test/bot-lifecycle-contract.test.ts","packages/runtime-kernel/test/agent-routines.test.ts",
  "packages/box-runtime/test/host-health-source.test.ts","packages/box-runtime/test/source-recipes.test.ts","packages/box-runtime/test/capability-witness.test.ts",
  "packages/box-runtime/test/alert-slices.test.ts","packages/box-runtime/test/host-managed-retry.test.ts","packages/box-runtime/test/host-native-error-scope.test.ts",
  "packages/box-runtime/test/bot-lifecycle.test.ts","packages/box-runtime/test/handover-management.test.ts","packages/box-runtime/test/bot-convergence.test.ts","packages/box-runtime/test/bot-protection.test.ts","./test/bot-handover-cli.test.ts",
  "packages/box-runtime/test/context-maintenance-control.test.ts","packages/box-runtime/test/context-maintenance-lifetime.test.ts","packages/box-runtime/test/compaction-management.test.ts",
  "packages/runtime-kernel/test/context-policy.test.ts","packages/runtime-kernel/test/context-selection.test.ts","./test/context-commands.test.ts","apps/web/test/operations.test.ts",
  "packages/box-runtime/test/continuity-sidecar.test.ts",
  "packages/box-runtime/test/current-ledger-contract.test.ts","packages/box-runtime/test/continuity-state-migration.test.ts",
  "packages/box-runtime/test/continuity-store.test.ts","packages/box-runtime/test/continuity-current-state.test.ts","packages/box-runtime/test/continuity-workflow-retention.test.ts",
  "packages/box-runtime/test/monitor-migration-review.test.ts","packages/box-runtime/test/routine-provision.test.ts",
  "packages/box-runtime/test/ops-automatic-notification.test.ts","packages/runtime-kernel/test/notification-authorization-contract.test.ts",
  "packages/box-runtime/test/ops-notification-outbox.test.ts","packages/box-runtime/test/ops-native-notification.test.ts","test/ops-native-notification-cli.test.ts","test/ops-automatic-cli.test.ts",
  "packages/box-runtime/test/diagnostic-admission.test.ts","packages/box-runtime/test/storage-maintenance-lifetime.test.ts","test/monitor-cli.test.ts",
  "packages/box-runtime/test/host-seam-acorn.test.ts","packages/box-runtime/test/host-seam-contract.test.ts","packages/box-runtime/test/host-seam-iteration.test.ts",
  "packages/box-runtime/test/host-seam-propose.test.ts","packages/box-runtime/test/host-seam-replay.test.ts","packages/box-runtime/test/host-seam-shape.test.ts",
  "packages/box-runtime/test/host-seam-slice-emit.test.ts","packages/box-runtime/test/host-seam-two-slice.test.ts","packages/box-runtime/test/hcr-diagnostics.test.ts",
  "packages/box-runtime/test/host-activity-bridge.test.ts","packages/box-runtime/test/host-harness-stick.test.ts","packages/box-runtime/test/host-profile-title.test.ts",
  "packages/box-runtime/test/native-continuity-pair.test.ts","packages/box-runtime/test/native-checkpoint-worker.test.ts","packages/box-runtime/test/native-current-state-owner.test.ts",
  "packages/box-runtime/test/reviewed-profile-write.test.ts","packages/box-runtime/test/reviewed-profile-write-lineage.test.ts","packages/box-runtime/test/host-envelope.test.ts",
  "packages/box-runtime/test/monitor-service-lifetime.test.ts",
  "packages/box-runtime/test/monitor-store.test.ts","packages/box-runtime/test/monitor-source-lifecycle.test.ts",
  "packages/box-runtime/test/monitor-scheduling-review.test.ts","packages/box-runtime/test/monitor-durability-review.test.ts",
  "packages/box-runtime/test/monitor-correlation-review.test.ts","packages/box-runtime/test/monitor-commit-boundaries.test.ts",
  "packages/box-runtime/test/incident-evidence-store.test.ts","packages/box-runtime/test/host-root-provenance.test.ts",
  "packages/box-runtime/test/modeld-lifecycle.test.ts","packages/box-runtime/test/modeld-packaged-lifecycle.test.ts",
  "packages/box-runtime/test/preload-marker.test.ts","packages/box-runtime/test/hook.test.ts",
  "packages/box-runtime/test/packed-helpers.test.ts","packages/box-runtime/test/ephemeral-root.test.ts","packages/box-runtime/test/observation-closed-loop.test.ts",
  "test/runtime-cli.test.ts","test/host-seam-observe-cli.test.ts",
  "packages/box-runtime/test/controller-generation.test.ts","packages/box-runtime/test/controller-io.test.ts","packages/box-runtime/test/controller-lock.test.ts","packages/box-runtime/test/h3-live.test.ts",
  "packages/box-runtime/test/operation-lease.test.ts","packages/box-runtime/test/operation-lease-contract.test.ts","packages/box-runtime/test/hcr-operation-recovery.test.ts",
  "packages/box-runtime/test/hcr-operation-lifetime.test.ts","packages/box-runtime/test/identity-op.test.ts","test/hcr-cli.test.ts","test/admission-observation.test.ts","test/outcome.test.ts",
  "test/jobs.test.ts","test/job-safety-store.test.ts","test/filesystem.test.ts","test/filesystem-mutations.test.ts","test/detail-absorb.test.ts","test/events.test.ts","test/desktop.test.ts","test/capabilities_desktop_probe.test.ts",
  "test/network-boundary.test.ts","test/ssh-recovery.test.ts","test/profile.test.ts","test/operator.test.ts","test/recovery.test.ts","test/daemon.test.ts",
  "packages/runtime-kernel/test/unified-config.test.ts","packages/box-runtime/test/config-bootstrap.test.ts","test/config-cli.test.ts","test/config-application-receipt.test.ts","test/config-packed.test.ts",
  "packages/box-runtime/test/architecture.test.ts","packages/box-runtime/test/legacy-executor-removed.test.ts",
  "packages/box-runtime/test/model-management.test.ts","packages/box-runtime/test/management-gateway.test.ts",
  "packages/box-runtime/test/current-model-schema.test.ts","packages/box-runtime/test/continuity-model.test.ts","packages/box-runtime/test/model-selection.test.ts",
  "packages/box-runtime/test/model-switch-pipeline.test.ts","packages/box-runtime/test/reasoning-command.test.ts","packages/box-runtime/test/reasoning-packed.test.ts",
  "packages/box-runtime/test/config-migration.test.ts","test/title-sync.test.ts", "packages/runtime-kernel/test/model-relationships.test.ts","packages/runtime-kernel/test/reasoning-selection.test.ts","packages/runtime-kernel/test/selection.test.ts",
  "packages/box-runtime/test/context-maintenance-host.test.ts","packages/box-runtime/test/host-lease-runtime.test.ts","packages/box-runtime/test/host-compact-lifetime.test.ts","packages/box-runtime/test/host-compact-coordination.test.ts",
  "packages/box-runtime/test/host-ownership-read.test.ts","packages/box-runtime/test/hcr-capabilities.test.ts","packages/box-runtime/test/hcr-profile-upgrade.test.ts",
  "test/verification-source.test.js","test/host-health-shards.test.ts","test/browser-groups.test.ts","test/capabilities_local_server_url.test.ts","test/cli.test.ts","test/skills.test.ts"],
 integration:["test/sqlite-read-scheduling.test.ts","test/host-witness.test.ts","test/host-compilation.test.ts","test/host-health-management.test.ts","test/host-verifier.test.ts","test/host-verifier-boundaries.test.ts",
  "test/file-management.test.ts","test/job-management.test.ts","test/desktop-management.test.ts","test/observation-management.test.ts","test/incident-actions.test.ts","test/notification-management.test.ts","test/notification-setup.test.ts",
  "./test/handover-management.test.ts","./test/compaction-management.test.ts","test/context-management.test.ts","test/lifecycle-management.test.ts","test/materials-management.test.ts","test/protection-management.test.ts",
  "packages/server/test/server.test.ts","test/web-bridge.test.ts","test/web-browser.test.ts","test/packaging.test.ts"],
 "native-pair":["packages/box-runtime/test/native-current-candidate.test.ts","packages/box-runtime/test/native-checkpoint-qualification.test.ts","packages/box-runtime/test/native-worker-binding.test.ts","packages/box-runtime/test/native-startup-seams.test.ts","packages/box-runtime/test/native-duplicate-qualification.test.ts","packages/box-runtime/test/native-disposal-qualification.test.ts"]
};
// Partition the same integration inventory, not a reduced acceptance set. The
// previous single Bun invocation exhausted its 270s aggregate budget before
// the browser/package suites finished; per-scenario deadlines stay unchanged.
const hostIntegration=new Set(["test/sqlite-read-scheduling.test.ts","test/host-witness.test.ts","test/host-compilation.test.ts","test/host-health-management.test.ts","test/host-verifier.test.ts","test/host-verifier-boundaries.test.ts"]);
const webIntegration=new Set(["test/web-browser.test.ts","test/packaging.test.ts"]);
suites["integration-host"]=suites.integration.filter(path=>hostIntegration.has(path));
suites["integration-domains"]=suites.integration.filter(path=>!hostIntegration.has(path)&&!webIntegration.has(path));
suites["integration-web"]=suites.integration.filter(path=>webIntegration.has(path));
const testCommand=paths=>["bun","test","--timeout","220000",...paths];
const commands=group==="core"?[
 [process.execPath,"scripts/generate-host-verifier-protocol.mjs","--check"],
 ["cargo","test","--locked","-p","grokbox-host-verifier"],
 ["bun","run","typecheck"],["bun","run","typecheck:web"],
 ["bun","test","--timeout","220000",...suites.core]
]:group==="integration"?["integration-host","integration-domains","integration-web"].map(shard=>testCommand(suites[shard])):[testCommand(suites[group])];
if(listOnly){console.log(JSON.stringify({group,files:suites[group],commands}));process.exit(0);}
const before=captureVerificationSource(root),receipts=[];
console.log(JSON.stringify({phase:`host-health-${group}-before`,...before}));
for(const command of commands){
 const result=spawnSync(command[0],command.slice(1),{cwd:root,encoding:"utf8",timeout:270000,maxBuffer:12*1024*1024,env:process.env});
 const output=`${result.stdout??""}\n${result.stderr??""}`;
 const summary=output.split("\n").filter(line=>/^\{|^test result:|^\s*\d+ (pass|fail|skip)|^Ran |^error|^\$/.test(line));
 console.log(summary.join("\n"));
 const skippedNative=group==="native-pair"&&/^\s*[1-9][0-9]* skip\b/m.test(output);
 receipts.push({command:command.join(" "),code:result.status,error:result.error?.code??(skippedNative?"native_qualification_skipped":null),signal:result.signal,summary});
 if(result.error||result.status!==0||skippedNative){console.error(output.slice(-100000));break;}
}
const after=captureVerificationSource(root),stable=before.ok&&after.ok&&before.sha256===after.sha256;
const ok=stable&&receipts.length===commands.length&&receipts.every(r=>r.code===0&&r.error===null&&r.signal===null);
console.log(JSON.stringify({phase:`host-health-${group}-after`,ok,before,after,stable,receipts},null,2));
if(!ok)process.exitCode=1;
