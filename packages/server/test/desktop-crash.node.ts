import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "../../../apps/web/test/desktop-fixture.ts";
const stage=process.env.GROKBOX_DESKTOP_CRASH_STAGE;
const pause=async(phase:string)=>{process.send?.({phase});await new Promise<void>(()=>{});};
const f=await desktopFixture(undefined,{afterClaim:async()=>{if(stage==="claim")await pause("claim");},afterDispatchClaim:async()=>{if(stage==="dispatch")await pause("dispatch");}});
f.state.stop=async()=>{await writeFile(join(f.root,"helper-effect"),"one",{mode:0o600});await pause("effect");};
process.send?.({phase:"ready",directory:f.directory,root:f.root,url:f.server.url});
