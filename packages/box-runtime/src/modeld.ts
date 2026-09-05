import { readFile } from "node:fs/promises";
import { BoxRuntimeError } from "./errors.ts";
import { sha256Text } from "./hash.ts";
import { parseApiKeyRef, resolveAssignment, type ModelRecord, type ModelsFile } from "./models.ts";

export type Attestation = {
  generationId: string;
  activationId: string;
  pid: number;
  start: number;
  sourceSha: string;
  committed: boolean;
};

export type InvocationState = "pending" | "running" | "terminal" | "unknown" | "conflict";

export type InvocationRecord = {
  id: string;
  fingerprint: string;
  state: InvocationState;
  terminal?: boolean;
  lastResortOfficial?: boolean;
};

export type AdmitRequest = {
  invocationId: string;
  agentId?: string;
  turnId: string;
};

export type AdmitResult =
  | {
      ok: true;
      dispatched: boolean;
      modelId: string;
      fingerprint: string;
      lastResortOfficial: false;
    }
  | {
      ok: true;
      dispatched: false;
      lastResortOfficial: true;
      userVisible: true;
      message: string;
    }
  | {
      ok: false;
      code: "conflict" | "missing-assignment";
      userVisible?: boolean;
    };

export type FakeDriver = {
  calls: number;
  complete: (modelId: string) => void;
};

export type SecretResolver = (ref: string) => Promise<string>;

export function createFileEnvSecretResolver(env: NodeJS.Dict<string>): SecretResolver {
  return async (ref) => {
    const parsed = parseApiKeyRef(ref);
    if (parsed.kind === "env") {
      const name = parsed.ref.slice("env:".length);
      const value = env[name];
      if (!value) throw new BoxRuntimeError("credential_invalid", "Referenced env credential is missing.");
      return value;
    }
    return await readFile(parsed.ref.slice("file:".length), "utf8");
  };
}

export function createModeld(input: {
  loadModels: () => ModelsFile | Promise<ModelsFile>;
  getAttestation: () => Attestation | null;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now: () => number;
  budgetMs: number;
  resolveSecret: SecretResolver;
  driver: FakeDriver;
  pollMs?: number;
}) {
  const registry = new Map<string, InvocationRecord>();
  const pins = new Map<string, { model: ModelRecord; fingerprint: string }>();
  let officialDefault = false;

  async function fingerprintFor(model: ModelRecord): Promise<string> {
    const secret = await input.resolveSecret(model.apiKeyRef);
    return sha256Text(`${model.id}\n${model.endpoint}\n${secret}`);
  }

  async function pinTurn(turnId: string, agentId?: string): Promise<{ model: ModelRecord; fingerprint: string }> {
    const existing = pins.get(turnId);
    if (existing) return existing;
    const models = await input.loadModels();
    const model = resolveAssignment(models, agentId);
    const fingerprint = await fingerprintFor(model);
    const pin = { model, fingerprint };
    pins.set(turnId, pin);
    return pin;
  }

  async function waitForAttestation(): Promise<boolean> {
    const deadline = input.now() + input.budgetMs;
    const poll = input.pollMs ?? 5;
    while (input.now() < deadline) {
      const attestation = input.getAttestation();
      if (attestation?.committed) return true;
      await input.wait(poll);
    }
    return input.getAttestation()?.committed === true;
  }

  async function admit(request: AdmitRequest): Promise<AdmitResult> {
    let pin: { model: ModelRecord; fingerprint: string };
    try {
      pin = await pinTurn(request.turnId, request.agentId);
    } catch {
      return { ok: false, code: "missing-assignment", userVisible: true };
    }
    const existing = registry.get(request.invocationId);
    if (existing) {
      if (existing.fingerprint !== pin.fingerprint) {
        existing.state = "conflict";
        return { ok: false, code: "conflict" };
      }
      if (existing.lastResortOfficial) {
        return {
          ok: true,
          dispatched: false,
          lastResortOfficial: true,
          userVisible: true,
          message: "Last-resort official already used for this invocation.",
        };
      }
      return {
        ok: true,
        dispatched: existing.state === "running" || existing.state === "terminal",
        modelId: pin.model.id,
        fingerprint: pin.fingerprint,
        lastResortOfficial: false,
      };
    }

    const record: InvocationRecord = {
      id: request.invocationId,
      fingerprint: pin.fingerprint,
      state: "pending",
    };
    registry.set(request.invocationId, record);

    const committed = await waitForAttestation();
    if (record.state === "unknown") {
      return { ok: false, code: "conflict" };
    }
    if (!committed) {
      record.state = "terminal";
      record.terminal = true;
      record.lastResortOfficial = true;
      officialDefault = false;
      return {
        ok: true,
        dispatched: false,
        lastResortOfficial: true,
        userVisible: true,
        message: "Configured model wait burned; this message may complete on official.",
      };
    }

    record.state = "running";
    input.driver.complete(pin.model.id);
    input.driver.calls += 1;
    record.state = "terminal";
    record.terminal = true;
    return {
      ok: true,
      dispatched: true,
      modelId: pin.model.id,
      fingerprint: pin.fingerprint,
      lastResortOfficial: false,
    };
  }

  function disconnect(invocationId: string): void {
    const record = registry.get(invocationId);
    if (!record || record.terminal) return;
    record.state = "unknown";
  }

  function get(invocationId: string): InvocationRecord | undefined {
    return registry.get(invocationId);
  }

  return {
    admit,
    disconnect,
    get,
    pins,
    officialBecameDefault: () => officialDefault,
    managedFailure: () => {
      return { calledOriginalSession: false, calledSecondProvider: false };
    },
  };
}

export type ModelD = ReturnType<typeof createModeld>;
