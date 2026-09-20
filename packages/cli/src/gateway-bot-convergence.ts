import { createNativeBotConvergence } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";
import { continuityContext } from "./continuity-context.ts";

export function createGatewayBotConvergence(deps: CliDeps, scopeId: string, authorized?: Parameters<typeof createNativeBotConvergence>[2]) {
  return createNativeBotConvergence(continuityContext(deps), scopeId, authorized);
}
