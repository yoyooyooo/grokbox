import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureVerificationSource } from "./verification-source.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const group=process.argv[2]??"core";
if(process.argv.length>3||!["core","integration"].includes(group))throw Error("usage: verify-host-health.mjs [core|integration]");
const bun=spawnSync("bun",["--version"],{encoding:"utf8"});
if(bun.status!==0||bun.stdout.trim()!=="1.3.14")throw Error("Use the repository-declared Bun 1.3.14 on PATH for verification and nested builds.");
const suites={
 core:["packages/client/test","packages/runtime-kernel/test/bot-lifecycle-contract.test.ts","packages/runtime-kernel/test/agent-routines.test.ts",
  "packages/box-runtime/test/host-health-source.test.ts","packages/box-runtime/test/monitor-service-lifetime.test.ts",
  "packages/box-runtime/test/monitor-store.test.ts","packages/box-runtime/test/monitor-source-lifecycle.test.ts",
  "packages/box-runtime/test/monitor-scheduling-review.test.ts","packages/box-runtime/test/monitor-durability-review.test.ts",
  "packages/box-runtime/test/monitor-correlation-review.test.ts","packages/box-runtime/test/monitor-commit-boundaries.test.ts",
  "packages/box-runtime/test/incident-evidence-store.test.ts","packages/box-runtime/test/host-root-provenance.test.ts",
  "packages/box-runtime/test/modeld-lifecycle.test.ts","packages/box-runtime/test/modeld-packaged-lifecycle.test.ts",
  "packages/box-runtime/test/compile-receipt.test.ts","packages/box-runtime/test/preload-marker.test.ts","packages/box-runtime/test/hook.test.ts",
  "packages/box-runtime/test/architecture.test.ts","packages/box-runtime/test/legacy-executor-removed.test.ts",
  "packages/box-runtime/test/model-management.test.ts","packages/box-runtime/test/management-gateway.test.ts",
  "test/verification-source.test.js","test/cli.test.ts","test/skills.test.ts"],
 integration:["test/host-compilation.test.ts","test/host-health-management.test.ts","test/host-verifier.test.ts","test/host-verifier-boundaries.test.ts",
  "test/observation-management.test.ts","test/incident-actions.test.ts","test/notification-management.test.ts","test/notification-setup.test.ts",
  "test/context-management.test.ts","test/lifecycle-management.test.ts","test/materials-management.test.ts","test/protection-management.test.ts",
  "packages/server/test/server.test.ts","test/web-bridge.test.ts","test/web-browser.test.ts","test/packaging.test.ts"]
};
const commands=group==="core"?[
 [process.execPath,"scripts/generate-host-verifier-protocol.mjs","--check"],
 ["cargo","test","--locked","-p","grokbox-host-verifier"],
 ["bun","run","typecheck"],["bun","run","typecheck:web"],
 ["bun","test","--timeout","220000",...suites.core]
]:[["bun","test","--timeout","220000",...suites.integration]];
const before=captureVerificationSource(root),receipts=[];
console.log(JSON.stringify({phase:`host-health-${group}-before`,...before}));
for(const command of commands){
 const result=spawnSync(command[0],command.slice(1),{cwd:root,encoding:"utf8",timeout:270000,maxBuffer:12*1024*1024,env:process.env});
 const output=`${result.stdout??""}\n${result.stderr??""}`;
 const summary=output.split("\n").filter(line=>/^\{|^test result:|^\s*\d+ (pass|fail|skip)|^Ran |^error|^\$/.test(line));
 console.log(summary.join("\n"));
 receipts.push({command:command.join(" "),code:result.status,error:result.error?.code??null,signal:result.signal,summary});
 if(result.error||result.status!==0){console.error(output.slice(-100000));break;}
}
const after=captureVerificationSource(root),stable=before.ok&&after.ok&&before.sha256===after.sha256;
const ok=stable&&receipts.length===commands.length&&receipts.every(r=>r.code===0&&r.error===null&&r.signal===null);
console.log(JSON.stringify({phase:`host-health-${group}-after`,ok,before,after,stable,receipts},null,2));
if(!ok)process.exitCode=1;
