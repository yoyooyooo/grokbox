import type { SlicePatch } from "./profile.ts";
import { HOST_OWNERSHIP_READ_SYMBOL } from "./ownership-read.ts";
import { HOST_RESUME_GATE_SYMBOL } from "./profile.ts";
import { HOST_SERVER_ACTIVITY_SYMBOL } from "./server-activity-observation.ts";
import { HOST_RECEIVER_MODEL_SYMBOL } from "./receiver-model.node.ts";
import { HOST_RUN_OBSERVATION_SYMBOL } from "./run-observation.ts";

// A narrowly scoped read extension of the existing Gateway. The native client
// owns authentication. No credential or generic RPC dispatch is exported.
export const OWNERSHIP_READ_SLICES: readonly SlicePatch[] = [
  {
    id: "ownership-read-schema",
    startAnchor: "var hostStatusArgs = rpcObject({",
    endAnchor: "var localToolPermissionResolution =",
    find: "  includeManagedCapabilities: rpcOptional(rpcBoolean())\n",
    replacement: "  includeManagedCapabilities: rpcOptional(rpcBoolean()),\n  grokboxOwnershipAgentIds: rpcOptional(rpcArray(rpcString())),\n  grokboxOwnershipLocalOnly: rpcOptional(rpcBoolean()),\n  grokboxRuntimeCapabilities: rpcOptional(rpcBoolean()),\n  grokboxHealthChallenge: rpcOptional(rpcString())\n",
  },
  {
    id: "ownership-read-api",
    startAnchor: "    getHostStatus: async ({ includeManagedCapabilities }) => ({",
    endAnchor: "    setBoxMigrating: async (args) => {",
    find: "    getHostStatus: async ({ includeManagedCapabilities }) => ({\n      ...deps.extensions.api(\"host-upgrade\").getVersionState(),\n      isBusy: deps.getHealth().isBusy,\n      capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES\n    }),\n",
    replacement: `    getHostStatus: async ({ includeManagedCapabilities, grokboxOwnershipAgentIds, grokboxOwnershipLocalOnly, grokboxRuntimeCapabilities, grokboxHealthChallenge }) => {
      const read = globalThis[Symbol.for("${HOST_OWNERSHIP_READ_SYMBOL}")];
      if (grokboxHealthChallenge !== undefined) {
        // Only local metadata; do not sample ownership, auth, Bot roster or model.
        let health = null;
        try {
          const descriptor = typeof read === "function" ? Object.getOwnPropertyDescriptor(read, "health") : null;
          if (descriptor && "value" in descriptor && typeof descriptor.value === "function") health = descriptor.value(grokboxHealthChallenge, 1);
        } catch {}
        return { grokboxHostHealth: health };
      }
      const result = {
        ...deps.extensions.api("host-upgrade").getVersionState(),
        isBusy: deps.getHealth().isBusy,
        capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES,
        ...(grokboxRuntimeCapabilities === true ? {
          grokboxRuntimeCapabilities: typeof read?.capabilities === "function" ? read.capabilities(1) : null,
          ...(Array.isArray(grokboxOwnershipAgentIds) && grokboxOwnershipAgentIds.length === 1 ? {
            grokboxReceiverModel: globalThis[Symbol.for("${HOST_RECEIVER_MODEL_SYMBOL}")]?.read(grokboxOwnershipAgentIds[0]) ?? null
          } : {})
        } : {})
      };
      if (grokboxOwnershipAgentIds === undefined) return result;
      if (typeof read !== "function") return result;
      const observed = await read({
        agentIds: grokboxOwnershipAgentIds,
        localOnly: grokboxOwnershipLocalOnly === true,
        listServer: async (signal) => {
          const auth = deps.extensions.api("auth");
          const client = createSandCursorBackendClient(GrokBotService, {
            backend: deps.environment.backend,
            getAccessToken: auth.getAccessToken,
            getTeamId: auth.getTeamId,
            getMachineId: auth.getMachineId
          });
          return await client.listGrokBotAgents({}, { signal });
        },
        readLocal: (agentId) => {
          const path = getSandProfilePath(getSandAgentsRootDir() + "/" + agentId);
          return { harness: readSandProfileHarness(path), serverId: readSandProfileServerId(path) };
        },
        readWindow: () => deps.extensions.api("resume-ownership").getSettledHostWindow(),
        readExecution: () => {
          const execution = deps.extensions.api("turn-execution");
          return { allowed: execution.isLocalWorkAllowed, bound: execution.canExecute };
        },
        readScope: async () => {
          const auth = deps.extensions.api("auth");
          return {
            backend: deps.environment.backend?.backendUrl ?? "default",
            account: tokenSubjectScope(auth.peekAccessToken()),
            team: await auth.getTeamId(),
            machine: await auth.getMachineId()
          };
        }
      });
      let activityObservation;
      try {
        activityObservation = globalThis[Symbol.for("${HOST_SERVER_ACTIVITY_SYMBOL}")]?.snapshot(
          grokboxOwnershipAgentIds, agentId => deps.extensions.api("server-agent-proxy").activityOverlayFor(agentId)
        );
      } catch {}
      let runObservation;
      try { runObservation = globalThis[Symbol.for("${HOST_RUN_OBSERVATION_SYMBOL}")]?.snapshot(grokboxOwnershipAgentIds); } catch {}
      return { ...result, grokboxOwnership: { ...observed, ...(activityObservation ? { activityObservation } : {}),
        ...(runObservation ? { runObservation } : {}) } };
    },
`,
  },
  {
    id: "ownership-resume-gate",
    startAnchor: "  startUpgradeResume(marker17) {",
    endAnchor: "  finishUpgradeResume(marker17) {",
    find: "    this.tm.upgradeResumeStore?.markPending(marker17);\n    this.pauseResumeInFlightAgentIds.add(marker17.agentId);\n",
    replacement: `    const __grokbox_resumeGate = globalThis[Symbol.for("${HOST_RESUME_GATE_SYMBOL}")];
    if (this.tm.execution.isLocalWorkAllowed !== true &&
        (typeof __grokbox_resumeGate !== "function" || __grokbox_resumeGate(marker17.agentId, this.tm.execution.isLocalWorkAllowed))) return "skipped";
    this.tm.upgradeResumeStore?.markPending(marker17);
    this.pauseResumeInFlightAgentIds.add(marker17.agentId);
`,
  },
];
