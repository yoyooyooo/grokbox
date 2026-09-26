import type { SlicePatch } from "./profile.ts";
import { HOST_LOCAL_FIRST_SYMBOL } from "./local-first.ts";

/** Explicit Box intent only. Default and Temporal mints keep the native path.
 * The local factory and registration remain the original native owners. */
export const LOCAL_FIRST_SLICES: readonly SlicePatch[] = [
  {
    id: "native-create-local-first",
    startAnchor: "  const mintAgent = async (args) => {",
    endAnchor: "  const deleteAgentsAndReport = async (ids) => {",
    find: '    const remote = args.harness === "temporal" || await identity.isWriteEnabled() ? await identity.createRemoteAgentFirst(\n',
    replacement: `    if (args.harness === "box") {
      const bridge = globalThis[Symbol.for("${HOST_LOCAL_FIRST_SYMBOL}")];
      if (!bridge) throw new Error("local_first_bridge_unavailable");
      return await bridge.create(args, config2, options2, manager, identity);
    }
    const remote = args.harness === "temporal" || await identity.isWriteEnabled() ? await identity.createRemoteAgentFirst(
`,
  },
  {
    id: "native-create-box-harness",
    startAnchor: '  async requestMint(create, request5, reportOp = "mint") {',
    endAnchor: "  rollbackRemoteAgent(args) {",
    find: "      return await this.deps.retry.runWithRetry(() => create(request5));\n",
    replacement: `      const bridge = globalThis[Symbol.for("${HOST_LOCAL_FIRST_SYMBOL}")];
      const local = bridge?.mint(request5, create);
      if (local !== undefined) return await local;
      return await this.deps.retry.runWithRetry(() => create(request5));
`,
  },
];
