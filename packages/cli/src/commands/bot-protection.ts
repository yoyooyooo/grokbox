import { openBotProtection } from "@grokbox/box-runtime/runtime";
import { isContinuityHash } from "@grokbox/runtime-kernel/continuity";
import { createGatewayBotProtection } from "../gateway-bot-protection.ts";
import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";

export async function runBotProtection(deps:CliDeps,action:"status"|"observe"|"advance",raw:{scopeId?:string;confirm?:boolean;json?:boolean}){
  if(!["auto","local"].includes(deps.transport)||deps.sshHost||deps.daemonServerUrl||deps.gatewayServerUrl)throw usage("Protection is Box-local.");
  if(!isContinuityHash(raw.scopeId))throw usage("An exact --scope-id is required.");
  if(action!=="status"&&raw.confirm!==true)throw usage("Explicit protection actions require --confirm; configured automatic policy still applies.");
  const controller=openBotProtection({durableRoot:deps.boxRuntimeRoot,scopeId:raw.scopeId,native:createGatewayBotProtection(deps,raw.scopeId)});
  const result=action==="status"?await controller.subjects():action==="observe"?await controller.observe(deps.signal):await controller.advance(deps.signal);
  writeSuccess(deps.stdout,result);
}
