// Owned interoperability fixture: finite getHostStatus contract, no native code import.
export const OWNERSHIP_SHAPED_HOST = `
function rpcObject(value) { return value; }
function rpcOptional(value) { return value; }
function rpcBoolean() { return "boolean"; }
function rpcArray(value) { return [value]; }
function rpcString() { return "string"; }
var hostStatusArgs = rpcObject({
  includeManagedCapabilities: rpcOptional(rpcBoolean())
});
var localToolPermissionResolution = null;
const ownershipFixtureAPI = {
    getHostStatus: async ({ includeManagedCapabilities }) => ({
      ...deps.extensions.api("host-upgrade").getVersionState(),
      isBusy: deps.getHealth().isBusy,
      capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args) => { throw new Error("mutation_forbidden"); }
};
`;
