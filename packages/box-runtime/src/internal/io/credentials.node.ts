import { constants } from "node:fs";
import { homedir } from "node:os";
import { open, type FileHandle } from "node:fs/promises";
import { Cause, Effect, Exit, Layer } from "effect";
import { BackendFailure, BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  lookupPiProviderApiKey,
  parseApiKeyRef,
  parseModelsFile,
  PI_PROVIDER_REF_PREFIX,
  piModelsPathCandidates,
  type ExternalCatalogEntry,
} from "@grokbox/runtime-kernel/selection";
import { BackendAuth, type AuthLease } from "@grokbox/runtime-kernel/ports";
import { readBoundedJson } from "./bounded-json.node.ts";
import { modelsPath } from "./paths.ts";

/**
 * C1 secret materialization (modeld-owned).
 *
 * - `apiKeyRef` is `env:<NAME>`, `file:/absolute`, or `pi-provider:<name>` via `parseApiKeyRef`
 *   (no `$VAR`, no literals). `pi-provider:` re-reads the string `apiKey` from the same Pi
 *   `models.json` candidate paths used for catalog load. It never copies that secret into
 *   grokbox `models.json` and never executes command-form keys.
 * - Env: missing, non-string, or empty after one `String.prototype.trim()` fails.
 * - After trim, values that start with `!/` are rejected as pi command-form apiKeys
 *   (`credential_invalid`). This path never executes the command.
 * - File: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` then `fstat`; regular file only.
 *   FIFOs/sockets/dirs fail as non-regular without blocking the Host or modeld.
 *   `stat.size` and bytes read must be ≤ `CREDENTIAL_SECRET_MAX_BYTES`; body must
 *   be valid UTF-8; then the same trim.
 * - Trim follows ECMAScript `trim()` (Unicode Space_Separator plus TAB/LF/VT/FF/CR/BOM/NEL).
 * - Empty after trim fails. Invalid UTF-8 fails. Directories, sockets, fifos, and
 *   symlinks fail as non-regular (`ELOOP` / `!isFile`).
 * - `fingerprintSecret` is SHA-256 hex of the trimmed secret. Fingerprint never
 *   returns or logs the secret. Pin/IPC/parts receive only the hex.
 * - OpenAI `resolveApiKey` **re-reads** through this same Effect (no pin-scoped
 *   secret cache). Pin-time fingerprint and complete-time materialization can
 *   diverge if the env/file changes between them.
 */
export const CREDENTIAL_SECRET_MAX_BYTES = 4 * 1024;

export type ApiKeyRefResolveContext = {
  homedir?: string;
  catalog?: ExternalCatalogEntry[];
  durableRoot?: string;
};

export function fingerprintSecret(secret: string): string {
  return sha256Text(secret);
}

function trimUtf8Secret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pi models.json command-form apiKey. Do not treat as a Bearer; do not exec. */
function rejectCommandFormSecret(
  secret: string,
  kind: "env" | "file" | "pi-provider" = "env",
): Effect.Effect<string, BoxRuntimeError> {
  if (secret.startsWith("!/")) {
    const noun = kind === "pi-provider" ? "Pi provider credential" : kind === "file" ? "file credential" : "env credential";
    return Effect.fail(new BoxRuntimeError(
      "credential_invalid",
      `Referenced ${noun} holds a command reference, not a secret.`,
    ));
  }
  return Effect.succeed(secret);
}

function piCredentialUnavailable(): BoxRuntimeError {
  return new BoxRuntimeError("credential_invalid", "Referenced Pi provider credential is unavailable.");
}

function mapFsError(error: unknown): BoxRuntimeError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") return new BoxRuntimeError("credential_invalid", "Referenced file credential is missing.");
  if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR" || code === "ENXIO" || code === "ENOTSUP" || code === "EAGAIN" || code === "EWOULDBLOCK") {
    return new BoxRuntimeError("credential_invalid", "Referenced file credential is not a regular file.");
  }
  return new BoxRuntimeError("credential_invalid", "Referenced file credential is unavailable.");
}

function parseRef(ref: string): Effect.Effect<{ kind: "env" | "file" | "pi-provider"; ref: string }, BoxRuntimeError> {
  return Effect.try({
    try: () => parseApiKeyRef(ref),
    catch: (error) => error instanceof BoxRuntimeError
      ? error
      : new BoxRuntimeError("credential_invalid", "Invalid apiKeyRef."),
  });
}

function resolvePiCatalog(
  context: ApiKeyRefResolveContext,
): Effect.Effect<ExternalCatalogEntry[], BoxRuntimeError> {
  if (context.catalog) return Effect.succeed(context.catalog);
  if (!context.durableRoot) return Effect.succeed(["pi"]);
  const root = context.durableRoot;
  return Effect.tryPromise({
    try: async () => {
      const raw = await readBoundedJson(modelsPath(root));
      const file = parseModelsFile(raw);
      return file.externalCatalog && file.externalCatalog.length > 0 ? file.externalCatalog : ["pi"];
    },
    catch: () => piCredentialUnavailable(),
  });
}

function materializePiProviderApiKey(
  ref: string,
  env: NodeJS.Dict<string>,
  context: ApiKeyRefResolveContext,
): Effect.Effect<string, BoxRuntimeError> {
  return Effect.gen(function* () {
    const name = ref.slice(PI_PROVIDER_REF_PREFIX.length);
    const catalog = yield* resolvePiCatalog(context);
    const candidates = yield* Effect.try({
      try: () => piModelsPathCandidates({
        catalog,
        homedir: context.homedir ?? homedir(),
        env: env as Record<string, string | undefined>,
      }),
      catch: () => piCredentialUnavailable(),
    });
    for (const path of candidates) {
      const pi = yield* Effect.promise(() => readBoundedJson(path));
      if (pi === undefined) continue;
      const lookup = lookupPiProviderApiKey(pi, name);
      if (lookup.kind === "command-form") {
        return yield* Effect.fail(new BoxRuntimeError(
          "credential_invalid",
          "Referenced Pi provider credential holds a command reference, not a secret.",
        ));
      }
      if (lookup.kind !== "string") {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced Pi provider credential is missing."));
      }
      if (Buffer.byteLength(lookup.value, "utf8") > CREDENTIAL_SECRET_MAX_BYTES) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced Pi provider credential exceeds size limit."));
      }
      return yield* rejectCommandFormSecret(lookup.value, "pi-provider");
    }
    return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced Pi provider credential is missing."));
  });
}

function readSecretFile(path: string): Effect.Effect<string, BoxRuntimeError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      catch: mapFsError,
    }),
    (file: FileHandle) => Effect.gen(function* () {
      const info = yield* Effect.tryPromise({
        try: () => file.stat(),
        catch: mapFsError,
      });
      if (!info.isFile()) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced file credential is not a regular file."));
      }
      if (info.size > CREDENTIAL_SECRET_MAX_BYTES) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced file credential exceeds size limit."));
      }
      const bytes = Buffer.alloc(CREDENTIAL_SECRET_MAX_BYTES + 1);
      const read = yield* Effect.tryPromise({
        try: () => file.read(bytes, 0, bytes.length, 0),
        catch: mapFsError,
      });
      if (read.bytesRead > CREDENTIAL_SECRET_MAX_BYTES) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced file credential exceeds size limit."));
      }
      const body = bytes.subarray(0, read.bytesRead);
      const text = body.toString("utf8");
      if (!Buffer.from(text).equals(body)) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced file credential is not valid UTF-8."));
      }
      const secret = trimUtf8Secret(text);
      if (secret === null) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced file credential is empty."));
      }
      return yield* rejectCommandFormSecret(secret);
    }),
    (file) => Effect.promise(() => file.close().then(() => undefined, () => undefined)),
  );
}

/** Effect program: materialize a trimmed secret. Does not fingerprint. */
export function materializeApiKeyRefEffect(
  ref: string,
  env: NodeJS.Dict<string>,
  context: ApiKeyRefResolveContext = {},
): Effect.Effect<string, BoxRuntimeError> {
  return Effect.gen(function* () {
    yield* Effect.yieldNow;
    const parsed = yield* parseRef(ref);
    if (parsed.kind === "env") {
      const secret = trimUtf8Secret(env[parsed.ref.slice(4)]);
      if (secret === null) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced env credential is missing."));
      }
      return yield* rejectCommandFormSecret(secret);
    }
    if (parsed.kind === "pi-provider") {
      return yield* materializePiProviderApiKey(parsed.ref, env, context);
    }
    return yield* readSecretFile(parsed.ref.slice(5));
  });
}

export function fingerprintApiKeyRefEffect(
  ref: string,
  env: NodeJS.Dict<string>,
  context: ApiKeyRefResolveContext = {},
): Effect.Effect<string, BoxRuntimeError> {
  return materializeApiKeyRefEffect(ref, env, context).pipe(Effect.map(fingerprintSecret));
}

async function runCredentialEffect<A>(
  effect: Effect.Effect<A, BoxRuntimeError>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("cancelled");
  const squashed = Cause.squash(exit.cause);
  if (squashed instanceof BoxRuntimeError) throw squashed;
  if (squashed instanceof Error) throw squashed;
  throw new BoxRuntimeError("credential_invalid", "Credential resolve failed.");
}

/** Promise facade: trimmed secret. Same Effect as fingerprint. */
export function materializeApiKeyRef(
  ref: string,
  env: NodeJS.Dict<string>,
  signal?: AbortSignal,
  context?: ApiKeyRefResolveContext,
): Promise<string> {
  return runCredentialEffect(materializeApiKeyRefEffect(ref, env, context), signal);
}

/** Promise facade: SHA-256 hex. Never returns the secret. */
export function fingerprintApiKeyRef(
  ref: string,
  env: NodeJS.Dict<string>,
  signal?: AbortSignal,
  context?: ApiKeyRefResolveContext,
): Promise<string> {
  return runCredentialEffect(fingerprintApiKeyRefEffect(ref, env, context), signal);
}

type LeaseRecord = { fingerprint: string; secret: string; ref: string; env: NodeJS.Dict<string> };

function makeLease(): AuthLease {
  return Object.freeze(Object.create(null)) as AuthLease;
}

export type LiveBackendAuth = {
  layer: Layer.Layer<BackendAuth>;
  unseal: (lease: AuthLease) => string;
};

/** Per-root auth. Unseal is injected into backends; maps are not shared across roots. */
export function createLiveBackendAuth(
  env: NodeJS.Dict<string> = process.env,
  context: ApiKeyRefResolveContext = {},
): LiveBackendAuth {
  const leases = new WeakMap<AuthLease, LeaseRecord>();
  const unseal = (lease: AuthLease): string => {
    const record = leases.get(lease);
    if (!record) throw new BackendFailure("auth_mismatch");
    return record.secret;
  };
  const layer = Layer.succeed(BackendAuth, {
    pin: (input: unknown) => {
      const ref = input && typeof input === "object" && "apiKeyRef" in input && typeof (input as { apiKeyRef: unknown }).apiKeyRef === "string"
        ? (input as { apiKeyRef: string }).apiKeyRef
        : "";
      const acquire = ref === ""
        ? Effect.sync(() => {
          const lease = makeLease();
          const fingerprint = fingerprintSecret("");
          leases.set(lease, { fingerprint, secret: "", ref: "", env });
          return { lease, fingerprint };
        })
        : materializeApiKeyRefEffect(ref, env, context).pipe(
          Effect.mapError((error) => error instanceof BackendFailure ? error : new BackendFailure("credential_invalid")),
          Effect.map((secret) => {
            const lease = makeLease();
            const fingerprint = fingerprintSecret(secret);
            leases.set(lease, { fingerprint, secret, ref, env });
            return { lease, fingerprint };
          }),
        );
      return Effect.acquireRelease(
        acquire,
        ({ lease }) => Effect.sync(() => {
          const record = leases.get(lease);
          if (record) record.secret = "";
          leases.delete(lease);
        }),
      );
    },
    verify: (lease: AuthLease) => Effect.gen(function* () {
      const record = leases.get(lease);
      if (!record) return yield* Effect.fail(new BackendFailure("auth_mismatch"));
      const current = record.ref === ""
        ? fingerprintSecret("")
        : yield* fingerprintApiKeyRefEffect(record.ref, record.env, context);
      if (current !== record.fingerprint) return yield* Effect.fail(new BackendFailure("auth_mismatch"));
    }),
  });
  return { layer, unseal };
}

export function liveBackendAuthLayer(
  env: NodeJS.Dict<string> = process.env,
  context: ApiKeyRefResolveContext = {},
): Layer.Layer<BackendAuth> {
  return createLiveBackendAuth(env, context).layer;
}
