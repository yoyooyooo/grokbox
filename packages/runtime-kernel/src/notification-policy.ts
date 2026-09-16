/** Notification choices are facts of a policy version, not an execution verdict.
 * No external delivery is configured by this module. */
export const NOTIFICATION_POLICY_VERSION="monitor-local-v1";
export type NotificationChoice={decision:"emit"|"suppress";reason:"new_occurrence"|"acknowledged"|"snoozed"|"aggregated";channel:"local_only";ruleVersion:typeof NOTIFICATION_POLICY_VERSION};
export function chooseNotification(input:{acknowledged:boolean;snoozeUntilMs:number|null;nowMs:number;parentIncidentId?:string|null}):NotificationChoice{
 const reason=input.parentIncidentId?"aggregated":input.snoozeUntilMs!==null&&input.snoozeUntilMs>input.nowMs?"snoozed":input.acknowledged?"acknowledged":"new_occurrence";
 return {decision:reason==="new_occurrence"?"emit":"suppress",reason,channel:"local_only",ruleVersion:NOTIFICATION_POLICY_VERSION};
}
export function projectNotification(value:unknown){
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 const ids=["eventId","incidentId","deliveryKey"] as const;
 if(ids.some(k=>typeof v[k]!=="string"||!(/^[A-Za-z0-9_.:-]{1,128}$/).test(v[k] as string)))return null;
 if(v.ruleVersion!==NOTIFICATION_POLICY_VERSION||v.channel!=="local_only"||!["emit","suppress"].includes(String(v.decision))||!["new_occurrence","acknowledged","snoozed","aggregated"].includes(String(v.reason)))return null;
 return {eventId:String(v.eventId),incidentId:String(v.incidentId),deliveryKey:String(v.deliveryKey),ruleVersion:NOTIFICATION_POLICY_VERSION,channel:"local_only" as const,decision:v.decision as "emit"|"suppress",reason:v.reason as NotificationChoice["reason"],
 ...(v.exportEvidence==="callback_returned"||v.exportEvidence==="callback_threw"?{exportEvidence:v.exportEvidence}:{}),remoteReceipt:"not_configured",appRendered:"not_observed"};
}
