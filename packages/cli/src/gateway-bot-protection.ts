import { createNativeBotProtection } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";
import { continuityContext } from "./continuity-context.ts";

export function createGatewayBotProtection(deps: CliDeps, scopeId: string) {
  return createNativeBotProtection(continuityContext(deps), scopeId);
}
