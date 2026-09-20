import type { NativeContinuityContext } from "@grokbox/box-runtime/runtime";
import { GatewayClient } from "./gateway.ts";
import { runtimeOwnershipReader } from "./runtime-ownership.ts";
import type { CliDeps } from "./deps.ts";

/** Transitional local transport composition for remaining CONT command roots.
 * Business rules live in box-runtime and are shared with the management Server;
 * no Server imports this CLI module or invokes a CLI child. */
export function continuityContext(deps: CliDeps): NativeContinuityContext {
  return { boxRuntimeRoot: deps.boxRuntimeRoot, env: deps.env, fetch: deps.fetch, signal: deps.signal,
    gateway: () => new GatewayClient({ ...deps, transport: "local" }), ownershipRead: runtimeOwnershipReader(deps) };
}
