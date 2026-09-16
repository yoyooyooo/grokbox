import { assertBoxLocal, openRuntimeStore, observeRuntimeEvents, openMonitorStore } from "@grokbox/box-runtime/runtime";
import { traceAlerts, observationId } from "@grokbox/runtime-kernel/alerts";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
/** Read-only diagnosis, never GetTrays mutation or monitor initialization. */
export async function runAlertTrace(deps:CliDeps,trayId:string,raw:{agent?:string;sourceInstance?:string;from?:string;includeUnrelatedObservers?:boolean}){
 assertBoxLocal({sshHost:deps.sshHost,daemonServerUrl:deps.daemonServerUrl,transport:deps.transport,profileName:deps.profileName});
 if(deps.gatewayServerUrl)throw new CliError("runtime_local_only","Alert history requires a box-local Profile.");
 if(!observationId(trayId)||(raw.agent!==undefined&&!observationId(raw.agent))||(raw.sourceInstance!==undefined&&!observationId(raw.sourceInstance)))throw usage("Invalid alert identity.");
 if(raw.from!==undefined&&!["journal","monitor"].includes(raw.from))throw usage("--from must be journal or monitor.");
 const root=openRuntimeStore(deps.boxRuntimeRoot,deps.env).root,selector={trayId,...(raw.agent?{agentId:raw.agent}:{}),...(raw.sourceInstance?{sourceInstanceId:raw.sourceInstance}:{}),...(raw.includeUnrelatedObservers?{includeUnrelatedObservers:true}:{})};
 if(raw.from==="monitor"){writeSuccess(deps.stdout,await openMonitorStore(root).alertTrace(selector));return;}
 const observed=await observeRuntimeEvents({durableRoot:root,runRoot:deps.env.GROKBOX_RUN_ROOT,source:"host",selector});
 writeSuccess(deps.stdout,{...traceAlerts(observed.events,selector,{complete:observed.state==="present"&&!observed.truncated,source:"host_journal"}),
   window:observed.window??null,readState:observed.state,root:observed.root});
}
