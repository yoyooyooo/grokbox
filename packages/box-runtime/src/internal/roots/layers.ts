import { Layer } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { echoModelBackendLayer } from "../backends/echo.ts";
import { aiSdkModelBackendLayer } from "../backends/ai-sdk.ts";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../io/credentials.node.ts";

export type BackendLayerOptions = {
  fetch?: typeof fetch;
  env?: NodeJS.Dict<string>;
};

/** Temporary test Scope graph. Construction does not send model requests. Not a production root. */
export function testEchoBackendLayer(env: NodeJS.Dict<string> = {}): Layer.Layer<ModelBackend | BackendAuth> {
  return Layer.merge(echoModelBackendLayer, liveBackendAuthLayer(env));
}

export function testSdkBackendLayer(options: BackendLayerOptions): Layer.Layer<ModelBackend | BackendAuth> {
  const deny = async (): Promise<Response> => {
    throw new Error("test sdk layer has no fetch");
  };
  const fetchImpl = options.fetch ?? (Object.assign(deny, { preconnect: deny }) as typeof fetch);
  const auth = createLiveBackendAuth(options.env ?? {});
  return Layer.merge(aiSdkModelBackendLayer(fetchImpl, auth.unseal), auth.layer);
}

export { echoModelBackendLayer, aiSdkModelBackendLayer, liveBackendAuthLayer, createLiveBackendAuth };
export { modeldRootLayer, liveAdmissionAuthorityLayer } from "./modeld.runtime.ts";
