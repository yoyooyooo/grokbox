import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { openRuntimeStore } from "@grokbox/box-runtime/runtime";
import { CAPABILITIES } from "@grokbox/client";
import { startManagementServer } from "../src/server.ts";
const root=resolve(process.argv[2]??"/not-owned");
if(process.argv[3]!=="owned-job-fixture"||!root.includes("managed-jobs-"))throw Error("owned_fixture_required");
const deny=async()=>{throw Error("native_access_not_authorized");};
const server=await startManagementServer({store:openRuntimeStore(root,{}),installationId:"11111111-1111-4111-8111-111111111111",native:{listBots:deny,ownershipRead:deny},env:{},
  readGrants:async()=>[{principalId:"owner",tokenSha256:createHash("sha256").update("synthetic-job-owner").digest("hex"),capabilities:[...CAPABILITIES]}]}, {hostHealth:{enabled:false}});
console.log(JSON.stringify({url:server.url}));
process.on("SIGTERM",()=>{void server.close().then(()=>process.exit(0));});
