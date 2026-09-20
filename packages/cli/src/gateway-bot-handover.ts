import { createNativeBotHandover } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";
import { continuityContext } from "./continuity-context.ts";

export function createGatewayBotHandover(deps: CliDeps, scopeId: string, timeoutMs: number, authorized?: Parameters<typeof createNativeBotHandover>[3]) {
  return createNativeBotHandover(continuityContext(deps), scopeId, timeoutMs, authorized);
}
