import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureVerificationSource } from "./verification-source.mjs";
import { expandTests, partitionTests } from "./verification-shards.mjs";
import { verificationChild, verificationSignals } from "./verification-child.mjs";
import { HOST_CORE_RISK_TESTS } from "./host-core-risk-manifest.mjs";
import { CORE_OBSERVATION_TESTS } from "./core-observation-manifest.mjs";
import { captureHostSourceWindow } from "../packages/box-runtime/src/internal/io/host-source-window.node.mjs";
import { sourceDigest } from "../packages/box-runtime/src/internal/io/stable-source-set.node.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const group=process.argv[2]??"core",listOnly=process.argv[3]==="--list";
const groups=["core","core-risk","core-observation","integration","integration-host","integration-domains","integration-web","product-management","native-pair","native-runtime","native-host"];
const nativeGroup=group.startsWith("native-")||["core-risk","core-observation"].includes(group);
if(process.argv.length>4||(process.argv[3]!==undefined&&!listOnly)||!groups.includes(group))throw Error("usage: verify-host-health.mjs [core|core-risk|core-observation|integration|integration-host|integration-domains|integration-web|product-management|native-pair|native-runtime|native-host] [--list]");
if(!listOnly&&["native-pair","native-runtime","core-risk","core-observation"].includes(group)&&(process.env.GROKBOX_TEST_NATIVE_CONTINUITY!=="1"||process.env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR!==undefined||!process.env.GROKBOX_TEST_NATIVE_NODE))
 throw Error(`${group} requires explicit native continuity opt-in and native Node executable; retired pair selectors are not supported and tests never authorize adoption.`);
if(!listOnly&&["native-runtime","native-host","core-risk","core-observation"].includes(group)&&process.env.GROKBOX_TEST_NATIVE_HOST!=="1")
 throw Error(`${group} requires explicit native Host opt-in as well as the original worker qualification where required.`);
const bun=spawnSync("bun",["--version"],{encoding:"utf8"});
if(!listOnly&&(bun.status!==0||bun.stdout.trim()!=="1.3.14"))throw Error("Use the repository-declared Bun 1.3.14 on PATH for verification and nested builds.");
const suites={
 "native-host":["packages/box-runtime/test/live-copy.test.ts","packages/box-runtime/test/host-harness-emit.test.ts","packages/box-runtime/test/host-managed-turn-retry.test.ts","packages/box-runtime/test/host-compact.test.ts","packages/box-runtime/test/transform.test.ts","packages/box-runtime/test/native-auxiliary-noop.test.ts"],
 core:["test/verification-shards.test.ts","test/verification-child.test.ts","test/preload-artifact.test.ts","test/host-source-evolution.test.ts","test/host-source-window.test.ts","packages/runtime-kernel/test/compaction-contract.test.ts","packages/box-runtime/test/journal-settlement.test.ts","packages/client/test","packages/runtime-kernel/test/bot-lifecycle-contract.test.ts","packages/runtime-kernel/test/agent-routines.test.ts",
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
  "test/jobs.test.ts","test/job-safety-store.test.ts","test/filesystem.test.ts","test/filesystem-mutations.test.ts","test/detail-absorb.test.ts","test/events.test.ts","test/desktop.test.ts","test/desktop-deletion-race.test.ts","test/capabilities_desktop_probe.test.ts",
  "test/network-boundary.test.ts","test/ssh-recovery.test.ts","test/profile.test.ts","test/operator.test.ts","test/recovery.test.ts","test/daemon.test.ts",
  "packages/runtime-kernel/test/unified-config.test.ts","packages/box-runtime/test/config-bootstrap.test.ts","test/config-cli.test.ts","test/config-application-receipt.test.ts","test/config-packed.test.ts",
  "packages/box-runtime/test/architecture.test.ts","packages/box-runtime/test/legacy-executor-removed.test.ts",
  "packages/box-runtime/test/model-management.test.ts","packages/box-runtime/test/model-publication-check.test.ts","packages/box-runtime/test/management-gateway.test.ts",
  "packages/box-runtime/test/current-model-schema.test.ts","packages/box-runtime/test/continuity-model.test.ts","packages/box-runtime/test/model-selection.test.ts",
  "packages/box-runtime/test/model-switch-pipeline.test.ts","packages/box-runtime/test/reasoning-command.test.ts","packages/box-runtime/test/reasoning-packed.test.ts",
  "packages/box-runtime/test/config-migration.test.ts","test/title-sync.test.ts", "packages/runtime-kernel/test/model-relationships.test.ts","packages/runtime-kernel/test/reasoning-selection.test.ts","packages/runtime-kernel/test/selection.test.ts",
  "packages/box-runtime/test/context-maintenance-host.test.ts","packages/box-runtime/test/host-lease-runtime.test.ts","packages/box-runtime/test/host-compact-lifetime.test.ts","packages/box-runtime/test/host-compact-coordination.test.ts",
  "packages/box-runtime/test/host-ownership-read.test.ts","packages/box-runtime/test/hcr-capabilities.test.ts","packages/box-runtime/test/hcr-profile-upgrade.test.ts",
  "test/verification-source.test.js","test/host-health-shards.test.ts","test/browser-groups.test.ts","test/capabilities_local_server_url.test.ts","test/cli.test.ts","test/skills.test.ts"],
 integration:["test/sqlite-read-scheduling.test.ts","test/host-witness.test.ts","test/host-compilation.test.ts","test/host-health-management.test.ts","test/host-verifier.test.ts","test/host-verifier-boundaries.test.ts",
  "test/file-management.test.ts","test/job-management.test.ts","test/desktop-management.test.ts","test/observation-management.test.ts","test/incident-actions.test.ts","test/notification-management.test.ts","test/notification-setup.test.ts",
  "./test/handover-management.test.ts","./test/compaction-management.test.ts","test/context-management.test.ts","test/lifecycle-management.test.ts","test/materials-management.test.ts","test/protection-management.test.ts",
  "packages/server/test/server.test.ts","test/model-authorization-management.test.ts","packages/server/test/messages.test.ts","test/web-bridge.test.ts","test/web-browser.test.ts","test/packaging.test.ts"],
 // Full Bot/Group management is opt-in product qualification, not a new core gate.
 "product-management":["packages/server/test/products.test.ts"],
 "native-runtime":["packages/box-runtime/test/context-native-qualification.test.ts","packages/box-runtime/test/native-checkpoint-process.test.ts",
  "packages/box-runtime/test/native-model-switch-pipeline.test.ts","packages/box-runtime/test/native-worker-binding.test.ts",
  "packages/box-runtime/test/host-compact.test.ts","packages/box-runtime/test/native-auxiliary-noop.test.ts",
  "packages/box-runtime/test/host-compact-pipeline.test.ts","packages/box-runtime/test/context-continuity-e2e.test.ts",
  "packages/box-runtime/test/e07-host-purpose-e2e.test.ts","packages/box-runtime/test/tool-contract-integration.test.ts",
  "test/context-management.test.ts","test/compaction-management.test.ts","test/ownership-model-selection.test.ts","packages/box-runtime/test/compaction-management.test.ts"],
 "core-risk":[...HOST_CORE_RISK_TESTS],
 "core-observation":[...CORE_OBSERVATION_TESTS],
 "native-pair":["packages/box-runtime/test/native-message-qualification.test.ts","packages/box-runtime/test/native-current-candidate.test.ts","packages/box-runtime/test/native-checkpoint-qualification.test.ts","packages/box-runtime/test/native-worker-binding.test.ts","packages/box-runtime/test/native-startup-seams.test.ts","packages/box-runtime/test/native-duplicate-qualification.test.ts","packages/box-runtime/test/native-disposal-qualification.test.ts"]
};
// Partition the same integration inventory, not a reduced acceptance set. The
// previous single Bun invocation exhausted its 270s aggregate budget before
// the browser/package suites finished; per-scenario deadlines stay unchanged.
const hostIntegration=new Set(["test/sqlite-read-scheduling.test.ts","test/host-witness.test.ts","test/host-compilation.test.ts","test/host-health-management.test.ts","test/host-verifier.test.ts","test/host-verifier-boundaries.test.ts"]);
const webIntegration=new Set(["test/web-browser.test.ts","test/packaging.test.ts"]);
suites["integration-host"]=suites.integration.filter(path=>hostIntegration.has(path));
suites["integration-domains"]=suites.integration.filter(path=>!hostIntegration.has(path)&&!webIntegration.has(path));
suites["integration-web"]=suites.integration.filter(path=>webIntegration.has(path));
const testCommand=(paths,timeout="220000")=>["bun","test","--timeout",timeout,...paths];
// Native declaration parsing and independently packaged HTTP consumers have
// separate process lifetimes. Keep every case and its scenario deadline; do not
// accumulate full native ASTs and client test state in one long-lived Bun VM.
const runtimeShards=[
 suites["native-runtime"].filter(path=>path.endsWith("/context-native-qualification.test.ts")),
 suites["native-runtime"].filter(path=>["native-checkpoint-process.test.ts","native-model-switch-pipeline.test.ts","native-worker-binding.test.ts"].some(name=>path.endsWith("/"+name))),
 suites["native-runtime"].filter(path=>path.startsWith("test/")),
 suites["native-runtime"].filter(path=>!path.startsWith("test/")&&!path.endsWith("/context-native-qualification.test.ts")
   &&!["native-checkpoint-process.test.ts","native-model-switch-pipeline.test.ts","native-worker-binding.test.ts"].some(name=>path.endsWith("/"+name)))
];

const riskFiles = expandTests(root, suites["core-risk"]);
const riskShards = partitionTests(riskFiles, path => {
 const name = path.split("/").at(-1);
 if (name === "core-risk-closure.test.ts" || name === "source-recipes.test.ts" || name === "capability-witness.test.ts") return "contract";
 if (name.startsWith("native-") || name === "context-native-qualification.test.ts") return "native";
 if (/^(host-compact|host-lease|host-managed|e07-|model-switch)/.test(name)) return "execution";
 if (/^(alert-|server-activity|host-activity|observation-)/.test(name)) return "observation";
 if (/^(host-ownership|host-resume|ownership-)/.test(name)) return "ownership";
 if (/^(context-|compaction-)/.test(name)) return "context";
 return "host";
});

// Compile-heavy artifact and CLI tests get fresh VMs. Other tests remain in
// bounded owner groups. This changes process lifetime, never case deadlines.
const observationFiles = expandTests(root, suites["core-observation"]);
const observationShards = partitionTests(observationFiles, path => {
 const name = path.split("/").at(-1);
 if (name === "core-observation-closure.test.ts") return "contract";
 if (name.startsWith("native-")) return "native";
 if (/^(monitor-|observation-closed|incident-evidence|authority-observation)/.test(name)) return "monitor";
 if (name === "ops-automatic-notification.test.ts") return "notification-auto";
 if (name === "ops-notification-outbox.test.ts") return "notification-outbox";
 if (name === "ops-native-notification.test.ts") return "notification-native";
 if (name === "notification-authorization-contract.test.ts") return "notification-contract";
 if (/^(diagnostic-admission|storage-maintenance)/.test(name)) return "maintenance";
 if (path.startsWith("test/") || path.startsWith("packages/client/")) return "management";
 return "host-health";
});

const coreFiles = expandTests(root, suites.core);
const coreShards = partitionTests(coreFiles, path => {
 const name = path.split("/").at(-1);
 if (name === "preload-artifact.test.ts") return "artifact";
 if (name === "cli.test.ts") return "cli";
 if (name === "verification-child.test.ts") return "child-lifetime";
 if (path.startsWith("packages/runtime-kernel/")) return "kernel";
 if (path.startsWith("packages/client/")) return "client";
 if (path.startsWith("apps/")) return "web-contract";
 if (path.startsWith("test/")) return "cli-integration";
 if (/^(host|native|source-recipes|capability|alert|preload|hook|hcr|reviewed-profile)/.test(name)) return "host";
 if (/^(context|compaction|continuity|current-ledger|routine|handover)/.test(name)) return "state";
 if (/^(monitor|journal|notification|diagnostic|storage|observation|incident|ops)/.test(name)) return "observation";
 return "runtime";
});
const commands=group==="core"?[
 [process.execPath,"scripts/generate-host-verifier-protocol.mjs","--check"],
 ["cargo","test","--locked","-p","grokbox-host-verifier"],
 ["bun","run","typecheck"],["bun","run","typecheck:web"],
 ...coreShards.map(shard=>testCommand(shard.files.map(path=>`./${path}`)))
]:group==="native-host"?suites["native-host"].map(path=>testCommand([path],"30000")):group==="native-runtime"?runtimeShards.map(paths=>testCommand(paths.map(path=>`./${path}`))):group==="core-risk"?riskShards.map(shard=>testCommand(shard.files.map(path=>`./${path}`))):group==="core-observation"?observationShards.map(shard=>testCommand(shard.files.map(path=>`./${path}`))):group==="integration"?["integration-host","integration-domains","integration-web"].map(shard=>testCommand(suites[shard])):[testCommand(suites[group])];
if(listOnly){console.log(JSON.stringify({group,files:group==="core"?coreFiles:group==="core-risk"?riskFiles:group==="core-observation"?observationFiles:suites[group],shards:group==="core"?coreShards:group==="core-risk"?riskShards:group==="core-observation"?observationShards:undefined,commands}));process.exit(0);}
const before=captureVerificationSource(root),receipts=[];
if(!before.ok)throw Error("verification_source_unavailable");
const cancellation=verificationSignals();
let window=null,windowStable=true,freshness=null;
try {
 if(nativeGroup){
  if(process.env.GROKBOX_TEST_NATIVE_WINDOW!==undefined||process.env.GROKBOX_TEST_NATIVE_WINDOW_KEY!==undefined)throw Error("native_window_owned_by_runner");
  const source=process.env.GROKBOX_TEST_NATIVE_SOURCE,worker=process.env.GROKBOX_TEST_NATIVE_WORKER;
  if(Boolean(source)!==Boolean(worker))throw Error("native_window_requires_both_source_paths");
  const nativeNode=process.env.GROKBOX_TEST_NATIVE_NODE??process.execPath;
  const nodeVersion=spawnSync(nativeNode,["--version"],{encoding:"utf8",timeout:10000});
  if(nodeVersion.status!==0)throw Error("native_node_unavailable");
  window=await captureHostSourceWindow({source:source??"/home/box/sand-host/host-main.cjs",worker:worker??"/home/box/sand-host/agent-isolation/agent-store-worker.cjs",profile:null},
   {verificationSource:before.sha256,testPlan:sourceDigest(JSON.stringify(commands)),toolchain:sourceDigest(JSON.stringify({bun:bun.stdout.trim(),node:nodeVersion.stdout.trim(),nativeNode}))},{signal:cancellation.signal});
 }
 console.log(JSON.stringify({phase:`host-health-${group}-before`,...before,nativeWindow:window?.receipt??null}));
 for(const command of commands){
 console.log(JSON.stringify({phase:"verification-command-start",index:receipts.length,total:commands.length}));
 const result=await verificationChild(command,{cwd:root,env:{...process.env,...window?.env,...(window?{TMPDIR:window.directory}:{})},timeoutMs:270000,signal:cancellation.signal});
 const output=`${result.stdout??""}\n${result.stderr??""}`;
 const summary=output.split("\n").filter(line=>/^\{|^test result:|^\s*\d+ (pass|fail|skip)|^Ran |^error|^\$|^\(fail\)/.test(line));
 console.log(summary.join("\n"));
 const skippedNative=nativeGroup&&/^\s*[1-9][0-9]* skip\b/m.test(output);
 receipts.push({command:command.join(" "),code:result.status,error:result.error?.code??(skippedNative?"native_qualification_skipped":null),signal:result.signal,settled:result.settled,elapsedMs:result.elapsedMs,summary});
 if(result.error||result.status!==0||!result.settled||skippedNative){console.error(nativeGroup?"native_qualification_failed: private diagnostic output withheld; scoped JSON receipts remain above":output.slice(-100000));break;}
 }
 if(window){windowStable=await window.current();freshness=await window.freshness();}
} finally { try { await window?.dispose(); } finally { cancellation.dispose(); } }
const after=captureVerificationSource(root),stable=before.ok&&after.ok&&before.sha256===after.sha256&&windowStable;
const ok=stable&&receipts.length===commands.length&&receipts.every(r=>r.code===0&&r.error===null&&r.signal===null&&r.settled);
console.log(JSON.stringify({phase:`host-health-${group}-after`,ok,before,after,stable,nativeWindow:window?.receipt??null,windowStable,freshness,nativeQualification:nativeGroup?{group,state:ok?"passed-in-selected-scope":"not-proven",failureAloneProvesAbiRegression:false}:null,qualified:false,receipts},null,2));
if(!ok)process.exitCode=1;
