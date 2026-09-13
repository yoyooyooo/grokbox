import type { SlicePatch } from "./profile.ts";
import { HOST_OWNERSHIP_READ_SYMBOL } from "./ownership-read.ts";

// A narrowly scoped read extension of the existing Gateway. The native client
// owns authentication. No credential or generic RPC dispatch is exported.
export const OWNERSHIP_READ_SLICES: readonly SlicePatch[] = [
  {
    id: "ownership-read-schema",
    startAnchor: "var hostStatusArgs = rpcObject({",
    endAnchor: "var localToolPermissionResolution =",
    find: "  includeManagedCapabilities: rpcOptional(rpcBoolean())\n",
    replacement: "  includeManagedCapabilities: rpcOptional(rpcBoolean()),\n  grokboxOwnershipAgentIds: rpcOptional(rpcArray(rpcString()))\n",
  },
  {
    id: "ownership-read-api",
    startAnchor: "    getHostStatus: async ({ includeManagedCapabilities }) => ({",
    endAnchor: "    setBoxMigrating: async (args) => {",
    find: "    getHostStatus: async ({ includeManagedCapabilities }) => ({\n      ...deps.extensions.api(\"host-upgrade\").getVersionState(),\n      isBusy: deps.getHealth().isBusy,\n      capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES\n    }),\n",
    replacement: `    getHostStatus: async ({ includeManagedCapabilities, grokboxOwnershipAgentIds }) => {
      const result = {
        ...deps.extensions.api("host-upgrade").getVersionState(),
        isBusy: deps.getHealth().isBusy,
        capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES
      };
      if (grokboxOwnershipAgentIds === undefined) return result;
      const read = globalThis[Symbol.for("${HOST_OWNERSHIP_READ_SYMBOL}")];
      if (typeof read !== "function") return result;
      return { ...result, grokboxOwnership: await read({
        agentIds: grokboxOwnershipAgentIds,
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
            machine: auth.getMachineId()
          };
        }
      }) };
    },
`,
  },
];
