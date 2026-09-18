import type { SlicePatch } from "./profile.ts";
import { HOST_ALERT_OBSERVATION_SYMBOL as SYMBOL } from "./alert-observation.ts";
const observer=`globalThis[Symbol.for("${SYMBOL}")]`;
/** Minimal source-backed interop anchors. Observe native policy and mutation;
 * never reinterpret errors as assistant messages or modify Tray retention. */
const main=`        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {\n          const description10 = describeAgentRunError(error41);\n          const requestId2 = session.db.getRequestIds().at(-1)?.id;\n          this.tm.trayErrors.pushError({\n            agentId: session.id,\n            requestId: requestId2,\n            ...description10,\n            ...hostTrayTitle({ kind: turnTrayTitleKind(description10.errorKind), description: description10 })\n          });\n        }\n`;
export const ALERT_OBSERVATION_SLICES: readonly SlicePatch[] = [
  { id:"alert-manager-observation", startAnchor:"var traysExtension = defineHostExtension({", endAnchor:"clearForAgent: (agentId) => trays.clearForAgent(agentId)",
    find:"    const trays = new TrayManager();\n",replacement:`    const trays = new TrayManager();\n    try { ${observer}?.attachManager(trays); } catch {}\n` },
  { id:"alert-main-decision", startAnchor:"\n        markTurnTraceError(turnTrace, error41);\n",endAnchor:"\n      } finally {\n        this.forgetTemplateSetupWriteHints(session.id, turnMessageIds);", 
    find:main, replacement:`        const __grokbox_alert = ${observer};\n        const __grokbox_emit = epoch === this.tm.sendPipeline.currentTurnEpoch(session);\n        const __grokbox_native_tray = () => {\n${main.replace("epoch === this.tm.sendPipeline.currentTurnEpoch(session)","__grokbox_emit")}        };\n        if (typeof __grokbox_alert?.decision === "function") __grokbox_alert.decision(error41, { agentId: session.id, clientNonce: options2.clientNonce }, __grokbox_emit, __grokbox_native_tray);\n        else __grokbox_native_tray();\n` },
  { id:"alert-input-cleanup",startAnchor:"function applySendRosterSideEffects(",endAnchor:"tm.trayErrors.clearForAgent(session.id);",
    find:"function applySendRosterSideEffects(tm, session, trimmedPrompt, readAddressedTranscript) {",replacement:`function applySendRosterSideEffects(tm, session, trimmedPrompt, readAddressedTranscript) {\n  const __grokbox_alert = ${observer};\n  if (typeof __grokbox_alert?.withRemovalReason === "function" && typeof __grokbox_alert?.removalReason === "function" && __grokbox_alert.removalReason() !== "new_input_cleanup") return __grokbox_alert.withRemovalReason("new_input_cleanup", () => applySendRosterSideEffects(tm, session, trimmedPrompt, readAddressedTranscript));` },
  { id:"alert-automation-decision",startAnchor:"  notifyAutomationFailure(session, automation, trigger2, description10) {", endAnchor:"  clearAutomationFailureState(agentId, automationId) {",
    find:"    if (isBackgroundAutomationTrigger(trigger2)) return;",
    replacement:`    if (isBackgroundAutomationTrigger(trigger2)) { try { ${observer}?.suppressed(session.id, "background_automation"); } catch {} return; }` },
  { id:"alert-automation-throttle",startAnchor:"  notifyAutomationFailure(session, automation, trigger2, description10) {", endAnchor:"  clearAutomationFailureState(agentId, automationId) {",
    find:"    if (!shouldNotifyAutomationFailure(occurrence)) return;",
    replacement:`    if (!shouldNotifyAutomationFailure(occurrence)) { try { ${observer}?.suppressed(session.id, "native_rate_limit"); } catch {} return; }` },
];
