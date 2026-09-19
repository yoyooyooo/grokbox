import { Effect } from "effect";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import type { ContinuityStoreInput } from "../io/continuity-store.node.ts";

/** Explicit operation metadata facade shared by protection and human controls.
 * Reads do not initialize storage; consumers still own the actual authority. */
export function openContinuityControls(input:ContinuityStoreInput) {
  const store=continuityWorkflowPrograms(input);
  return {initialize:()=>Effect.runPromise(store.initialize()),
    read:(id:string)=>Effect.runPromise(store.control(id)),
    reserve:(id:string,agentId:string,kind:string,value:unknown)=>Effect.runPromise(store.reserveControl(id,agentId,kind,value)),
    transition:(id:string,expected:string,next:string,value:unknown)=>Effect.runPromise(store.transitionControl(id,expected,next,value)),
    subject:(id:string)=>Effect.runPromise(store.subject(id)),
    updateSubject:(id:string,revision:number,currentId:string,generation:number,value:unknown)=>Effect.runPromise(store.updateSubject(id,revision,currentId,generation,value)),
    workflow:(id:string)=>Effect.runPromise(store.status(id)),
    request:(id:string)=>Effect.runPromise(store.request(id)),
    items:(id:string)=>Effect.runPromise(store.handoverItems(id)),
    resolveItem:(operationId:string,itemId:string,expected:string,evidenceHash:string)=>Effect.runPromise(store.settleHandover(operationId,itemId,expected,"complete",{state:"complete",evidence:evidenceHash,proof:"operator_attestation"})),
  };
}
