import { sha256Text } from "./hash.ts";
import { createFileEnvSecretResolver, type ModeldDriver, type ModeldPorts } from "./modeld.ts";
import { openAiAccepts, type OpenAiGenerateCall, type OpenAiStreamEvent } from "./modeld-openai-map.ts";
import { STUB_ECHO_MODEL_ID } from "./models.ts";
import type { ModelRecord } from "./models.ts";
import type { StreamPart } from "./session.ts";

/** Bounded stub echo parts. Stub path never reads credentials or networks. */
export const STUB_ECHO_PARTS: StreamPart[] = [
  { type: "text-delta", textDelta: "echo" },
  { type: "finish", reason: "stop" },
];

export function stubEchoAccepts(model: Readonly<ModelRecord>): boolean {
  return model.id === STUB_ECHO_MODEL_ID && model.provider === "stub" &&
    model.endpoint === "stub:echo" && model.apiKeyRef === "";
}

export function createStubEchoModeldDriver(): ModeldDriver {
  return {
    accepts: stubEchoAccepts,
    complete: () => STUB_ECHO_PARTS,
  };
}

/**
 * Composite admit: stub OR openai*. Dispatch prefers stub when both would accept (they never overlap).
 * Route activate remains stub-only; this only widens modeld's default driver accepts list.
 */
export function createCompositeModeldDriver(input: {
  stub?: ModeldDriver;
  openai: ModeldDriver;
}): ModeldDriver {
  const stub = input.stub ?? createStubEchoModeldDriver();
  const openai = input.openai;
  return {
    accepts: (model) => stub.accepts(model) || openai.accepts(model),
    complete: (request) => {
      if (stub.accepts(request.pin.model)) return stub.complete(request);
      if (openai.accepts(request.pin.model)) return openai.complete(request);
      throw new Error("wrong-model");
    },
  };
}

/** Lazy file/env secret → sha256 hex. Never returns or embeds the secret. Stub never calls this. */
export function createDefaultCredentialFingerprint(
  env: NodeJS.Dict<string> = process.env,
): NonNullable<ModeldPorts["credentialFingerprint"]> {
  return async (model) => {
    if (!model.apiKeyRef) throw new Error("credential-unavailable");
    const secret = await createFileEnvSecretResolver(env)(model.apiKeyRef);
    if (!secret) throw new Error("credential-unavailable");
    return sha256Text(secret);
  };
}

export type DefaultModeldDriverOptions = {
  /** Defaults to process.env. Tests inject a dict so missing keys stay offline. */
  env?: NodeJS.Dict<string>;
  fetch?: typeof fetch;
  /** Tests set true. Production CLI omits so admitted+credential models may network. */
  hardOff?: boolean;
  streamEvents?: (call: OpenAiGenerateCall) => AsyncIterable<OpenAiStreamEvent> | Promise<AsyncIterable<OpenAiStreamEvent>>;
};

/**
 * Default CLI/Unix modeld driver: stub echo ∪ OpenAI Chat/Responses.
 * OpenAI module and file/env secrets load only on openai complete — stub Unix tests stay SDK/credential-off.
 */
export function createDefaultModeldDriver(input: DefaultModeldDriverOptions = {}): ModeldDriver {
  const stub = createStubEchoModeldDriver();
  const env = input.env ?? process.env;
  let openai: ModeldDriver | undefined;
  return {
    accepts: (model) => stub.accepts(model) || openAiAccepts(model),
    complete: async (request) => {
      if (stub.accepts(request.pin.model)) return stub.complete(request);
      if (!openAiAccepts(request.pin.model)) throw new Error("wrong-model");
      if (!openai) {
        const { createOpenAiModeldDriver } = await import("./modeld-openai.ts");
        openai = createOpenAiModeldDriver({
          resolveApiKey: async (model) => {
            if (!model.apiKeyRef) throw new Error("credential-unavailable");
            const secret = await createFileEnvSecretResolver(env)(model.apiKeyRef);
            if (!secret) throw new Error("credential-unavailable");
            return secret;
          },
          ...(input.fetch ? { fetch: input.fetch } : {}),
          ...(input.hardOff === true ? { hardOff: true } : {}),
          ...(input.streamEvents ? { streamEvents: input.streamEvents } : {}),
        });
      }
      return await openai.complete(request);
    },
  };
}

export { openAiAccepts };
