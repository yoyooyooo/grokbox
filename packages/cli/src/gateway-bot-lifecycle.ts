import { createNativeBotLifecycle } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";
import { continuityContext } from "./continuity-context.ts";

export function createGatewayBotLifecycle(deps: CliDeps, input: Parameters<typeof createNativeBotLifecycle>[1]) {
  return createNativeBotLifecycle(continuityContext(deps), input);
}
