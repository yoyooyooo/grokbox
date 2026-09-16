/** Synthetic interoperability scaffold. No native implementation/state is copied.
 * Only the literal hook anchors model the supported Host admission surface. */
export const ALERT_SHAPED_HOST = `
(function syntheticAlertBoundary() {
function defineHostExtension(value) { return value; }
class TrayManager {
  getTrays() { return []; }
  emit() {}
  clearForAgent() {}
}
function applySendRosterSideEffects(tm, session, trimmedPrompt, readAddressedTranscript) {
  tm.trayErrors.clearForAgent(session.id);
}
var traysExtension = defineHostExtension({
  start: () => {
    const trays = new TrayManager();
    return { clearForAgent: (agentId) => trays.clearForAgent(agentId) };
  }
});
class SyntheticAlertRunner {
  async run(session, epoch, options2, error41) {
    const turnTrace = {}, turnMessageIds = [];
      try {
        markTurnTraceError(turnTrace, error41);
        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
          const description7 = describeAgentRunError(error41);
          const requestId2 = session.db.getRequestIds().at(-1)?.id;
          this.tm.trayErrors.pushError({
            agentId: session.id,
            requestId: requestId2,
            ...description7,
            ...hostTrayTitle({ kind: turnTrayTitleKind(description7.errorKind), description: description7 })
          });
        }
        await this.tm.roster.emitAgentUpdate(session.id);
      } finally {
        this.forgetTemplateSetupWriteHints(session.id, turnMessageIds);
      }
  }
  notifyAutomationFailure(session, automation, trigger2, description7) {
    if (isBackgroundAutomationTrigger(trigger2)) return;
    const occurrence = trigger2;
    if (!shouldNotifyAutomationFailure(occurrence)) return;
    this.tm.trayErrors.pushError({ agentId: session.id });
  }
  clearAutomationFailureState(agentId, automationId) {}
}
})();
`;
