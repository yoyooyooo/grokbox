import type { SlicePatch } from "./profile.ts";
import { HOST_RECEIVER_MODEL_SYMBOL } from "./receiver-model.node.ts";

/** Register a read-only closure next to the native session factory. Selection
 * functions stay native and no model/session is instantiated by the inspector.
 * The default automation preview intentionally excludes child/session overrides. */
export const RECEIVER_MODEL_SLICES: readonly SlicePatch[] = [{
  id: "receiver-native-model-preview",
  startAnchor: "function createHostInference(options2) {",
  endAnchor: "// src/host/extensions/inference/transcribe-service.ts\ninit_scheduling();",
  find: "  const { auth: auth2, experiments, settings } = options2;\n",
  replacement: `  const { auth: auth2, experiments, settings } = options2;
  try {
    const __grokbox_receiver = globalThis[Symbol.for("${HOST_RECEIVER_MODEL_SYMBOL}")];
    if (typeof __grokbox_receiver?.capture === "function") __grokbox_receiver.capture(() => {
      if (options2.environment.agentMockResponse != null) return { mockConfigured: true };
      const experimentModelOverride = selectSandExperimentTurnModel({
        state: experiments.getSandModelExperimentState(), requestSource: "automation",
        readConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
        readConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel()
      });
      return { mockConfigured: false, requestedModel: resolveSandRequestedModel({
        sessionOptions: { requestSource: "automation" }, envModelOverride: options2.environment.agentModelOverride,
        storedDefaultModel: settings.getAgentDefaultModel(), experimentModelOverride
      }) };
    });
  } catch {}
`,
}];
