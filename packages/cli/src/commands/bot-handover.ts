import { openContinuityControls } from "@grokbox/box-runtime/runtime";
import { isContinuityUuid,isContinuityHash,CurrentStateFailure,ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { createGatewayBotHandover } from "../gateway-bot-handover.ts";
import { createGatewayBotConvergence } from "../gateway-bot-convergence.ts";
import type { CliDeps } from "../deps.ts";
import { usage,CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";

type Options={operationId?:string;scopeId?:string;confirm?:boolean;itemId?:string;evidenceHash?:string;json?:boolean};
export async function runBotHandover(deps:CliDeps,action:"status"|"advance"|"observe"|"attest"|"retire",raw:Options){
  if(!["auto","local"].includes(deps.transport)||deps.sshHost||deps.daemonServerUrl||deps.gatewayServerUrl)throw usage("Handover is Box-local.");
  if(!isContinuityUuid(raw.operationId)||!isContinuityHash(raw.scopeId))throw usage("Exact --operation-id and --scope-id are required.");
  if(action!=="status"&&raw.confirm!==true)throw usage("This action requires --confirm.");
  if(action==="attest"&&(!isContinuityUuid(raw.itemId)||!isContinuityHash(raw.evidenceHash)))throw usage("Attestation requires --item-id and --evidence-hash for independently checked evidence.");
  if(action==="retire"&&!isContinuityHash(raw.evidenceHash))throw usage("Retirement requires the exact observed --evidence-hash.");
  const scopeId=raw.scopeId,operationId=raw.operationId;
  try{
    const controls=openContinuityControls({durableRoot:deps.boxRuntimeRoot,scopeId});
    if ((await controls.request(operationId)).management) throw usage("This workflow belongs to its original management principal; use the lifecycle management receipt and authorized continuation, not legacy local controls.");
    const handover=createGatewayBotHandover(deps,scopeId,30000),convergence=createGatewayBotConvergence(deps,scopeId);
    if(action==="status"){writeSuccess(deps.stdout,await handover.program.status(operationId));return;}
    if(action==="advance"){writeSuccess(deps.stdout,await handover.program.advance(operationId,16,deps.signal));return;}
    if(action==="observe"){writeSuccess(deps.stdout,await convergence.program.observe(operationId,deps.signal));return;}
    if(action==="attest"){
      const item=(await controls.items(operationId)).find(i=>i.itemId===raw.itemId);
      if(!item||item.kind!=="external-task")throw usage("Only external-dependency items accept operator evidence; message and native effect receipts cannot be fabricated.");
      await controls.resolveItem(operationId,item.itemId,item.state,raw.evidenceHash!);
      writeSuccess(deps.stdout,{operationId,itemId:item.itemId,state:"complete",proof:"operator_attestation",automaticDeletionGranted:false});return;
    }
    writeSuccess(deps.stdout,await convergence.program.retire(operationId,raw.evidenceHash!,deps.signal));
  }catch(error){
    if(error instanceof CliError)throw error;
    const reason=error instanceof CurrentStateFailure||error instanceof ContinuityFailure?error.code:"unavailable";
    throw new CliError(reason==="commit_unknown"?"operation_outcome_unknown":"capability_unavailable","Handover stopped; inspect the same operation.",{hostReason:reason,context:{operationId,phase:"handover"}});
  }
}
