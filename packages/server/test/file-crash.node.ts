import { createHash } from "node:crypto";
import { openRuntimeStore } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { CAPABILITIES } from "@grokbox/client";
import { FILE_INSTALLATION, FILE_OWNER } from "../../../apps/web/test/file-fixture.ts";
const [root,phase]=process.argv.slice(2);
if(!root||!["claim","publication"].includes(phase!))throw Error("invalid-disposable-file-crash-input");
const stop=async()=>{
  await new Promise<void>((resolve,reject)=>process.stdout.write(`${JSON.stringify({phase})}\n`,e=>e?reject(e):resolve()));
  process.kill(process.pid,"SIGKILL");await new Promise<void>(()=>{});
};
const noNative=async()=>{throw Error("native-not-allowed");};
const server=await startManagementServer({store:openRuntimeStore(root,{}),installationId:FILE_INSTALLATION,native:{listBots:noNative,ownershipRead:noNative},
  readGrants:async()=>[{principalId:"owner",tokenSha256:createHash("sha256").update(FILE_OWNER).digest("hex"),capabilities:[...CAPABILITIES]}]},
  {hostHealth:{enabled:false},files:phase==="claim"?{afterClaim:stop}:{afterPublish:stop}});
process.stdout.write(`${JSON.stringify({phase:"ready",url:server.url})}\n`);
await server.finished;
