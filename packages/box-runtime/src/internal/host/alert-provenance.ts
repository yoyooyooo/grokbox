import { observationId, own, safeAlertCode, type AlertCode } from "@grokbox/runtime-kernel/alerts";
import { projectFailureSummary, type FailureSummary } from "@grokbox/runtime-kernel/contract";
export type FailureLink = { failureId: string; agentId?: string; stepId?: string; code?: AlertCode; summary?: FailureSummary };
const links = new WeakMap<object, FailureLink>();
/** Only locally constructed managed errors are registered. Provider properties
 * and native error text never acquire execution authority through this map. */
export function attachFailureLink(error: object, input: { failureId?: unknown; agentId?: unknown; invocationId?: unknown; code?: unknown; failureSummary?: unknown }): void {
  if (!observationId(input.failureId)) return;
  const code=safeAlertCode(input.code), summary = projectFailureSummary(input.failureSummary);
  links.set(error, {failureId:input.failureId, ...(observationId(input.agentId)?{agentId:input.agentId}:{}),
    ...(observationId(input.invocationId)?{stepId:input.invocationId}:{}), ...(code?{code}:{}), ...(summary ? { summary } : {})});
}
export function readFailureLink(error: unknown): FailureLink | undefined {
  const seen=new Set<object>();
  for(let current=error,depth=0;depth<8&&current!==null&&typeof current==="object";depth++){
    if(seen.has(current))return;seen.add(current);
    const link=links.get(current);if(link)return {...link};current=own(current,"cause");
  }
}
