/** Independently authored interoperability fixture, not native Host source. */
export const LOCAL_FIRST_SHAPED_HOST = `
function createHostGatewayApi(deps, manager) {
  const mintAgent = async (args) => {
    const identity = deps.extensions.api("agent-identity");
    const config2 = Object.fromEntries(["name", "description", "title", "avatarShape", "avatarColor"].filter(k => k in args).map(k => [k, args[k]]));
    const options2 = { isIntroductionSuppressed: args.isIntroductionSuppressed ?? false, isKickstartRequested: args.isKickstartRequested ?? false };
    const remote = args.harness === "temporal" || await identity.isWriteEnabled() ? await identity.createRemoteAgentFirst(
      config2, { harness: args.harness }
    ) : null;
    return manager.createAgent(config2, args.origin, { ...options2, remote });
  };
  const deleteAgentsAndReport = async (ids) => {
    return manager.deleteAgents(ids);
  };
  return { createAgent: mintAgent, deleteAgent: args => deleteAgentsAndReport([args.id]) };
}
class SyntheticCreationIdentity {
  async requestMint(create, request5, reportOp = "mint") {
    try {
      return await this.deps.retry.runWithRetry(() => create(request5));
    } catch (error) { throw error; }
  }
  rollbackRemoteAgent(args) { return args; }
}
`;
