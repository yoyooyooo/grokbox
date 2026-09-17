/** Owned contract double, not copied native application code. The same native
 * methods (partition/generate/carrier/assemble/accept/checkpoint) are exercised.
 * Fault controls stay in this test capability, never in the business program. */
export function ownedNativeSummary(options: {
  beforeAccept?: () => void | Promise<void>;
  afterAccept?: () => void | Promise<void>;
} = {}) {
  class Summary {
    partitionMessages(messages: any[]) { return { systemMessage: messages[0], messagesToSummarize: messages.slice(1), preservedTailMessages: [], skillBlocks: [] }; }
    async generateSummary(): Promise<any> { throw new Error("native_external_inference_forbidden"); }
    buildSummaryMessage(raw: any) { return { message: { role: "user", content: `Archived context:\n${raw.text}\nDURABLE=NATIVE_CARRIER`, providerOptions: { cursor: { isSummary: true } } } }; }
    assembleFinalMessages(partition: any, summary: any) { return [partition.systemMessage, summary, ...partition.preservedTailMessages]; }
    getMetricsModelLabel() { return "native-summary"; }
    async summarize(_ctx: any, messages: any[], _options: any) {
      const p = this.partitionMessages(messages), raw = await this.generateSummary();
      const built = this.buildSummaryMessage(raw);
      return { messagesActuallySummarized: p.messagesToSummarize, preservedOriginalTailMessages: p.preservedTailMessages,
        newSummaryMessage: built.message, fullReplacementMessages: this.assembleFinalMessages(p, built.message), rawSummary: raw, summary: { summary: raw.text } };
    }
  }
  const state: any = { backgroundSummarizationPromiseInfo: null, archive: [],
    clearBackgroundSummarizationState() { this.backgroundSummarizationPromiseInfo = null; } };
  const orchestrator = {
    getSummarizer() { return new Summary(); },
    async handleSummarization(ctx: any, handler: any, root: any, _listener: any, _config: any, _request: any, options: any) {
      const source = root.getMessages();
      const promise = this.getSummarizer().summarize(ctx, source, options);
      handler.backgroundSummarizationPromiseInfo = { promise, startInvocationId: options.currentInvocationId };
      try {
        const result = await promise;
        await options.beforeAccept?.();
        await this.beforeAccept?.();
        handler.archive.push(result.messagesActuallySummarized);
        root.clearMessages(); root.appendMessages(result.fullReplacementMessages); root.appendMessages([]);
        await this.afterAccept?.();
        handler.clearBackgroundSummarizationState();
        return result.summary.summary;
      } catch (error) { handler.clearBackgroundSummarizationState(); throw error; }
    },
    beforeAccept: options.beforeAccept,
    afterAccept: options.afterAccept,
  };
  return { state, orchestrator };
}
