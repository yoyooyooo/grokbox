import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Cause, Effect, Exit } from "effect";
import { BoxRuntimeError } from "./errors.ts";
import { sha256Text } from "./hash.ts";
import { parseApiKeyRef } from "./models.ts";

/**
 * C1 secret materialization (modeld-owned).
 *
 * - `apiKeyRef` is `env:<NAME>` or `file:/absolute` via `parseApiKeyRef` (no `$VAR`, no literals).
 * - Env: missing, non-string, or empty after one `String.prototype.trim()` fails.
 * - File: `O_NOFOLLOW` regular file only; `stat.size` and bytes read must be ≤
 *   `CREDENTIAL_SECRET_MAX_BYTES`; body must be valid UTF-8; then the same trim.
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

export function fingerprintSecret(secret: string): string {
  return sha256Text(secret);
}

function trimUtf8Secret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapFsError(error: unknown): BoxRuntimeError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") return new BoxRuntimeError("credential_invalid", "Referenced file credential is missing.");
  if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") {
    return new BoxRuntimeError("credential_invalid", "Referenced file credential is not a regular file.");
  }
  return new BoxRuntimeError("credential_invalid", "Referenced file credential is unavailable.");
}

function parseRef(ref: string): Effect.Effect<{ kind: "env" | "file"; ref: string }, BoxRuntimeError> {
  return Effect.try({
    try: () => parseApiKeyRef(ref),
    catch: (error) => error instanceof BoxRuntimeError
      ? error
      : new BoxRuntimeError("credential_invalid", "Invalid apiKeyRef."),
  });
}

function readSecretFile(path: string): Effect.Effect<string, BoxRuntimeError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
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
      return secret;
    }),
    (file) => Effect.promise(() => file.close().then(() => undefined, () => undefined)),
  );
}

/** Effect program: materialize a trimmed secret. Does not fingerprint. */
export function materializeApiKeyRefEffect(
  ref: string,
  env: NodeJS.Dict<string>,
): Effect.Effect<string, BoxRuntimeError> {
  return Effect.gen(function* () {
    yield* Effect.yieldNow;
    const parsed = yield* parseRef(ref);
    if (parsed.kind === "env") {
      const secret = trimUtf8Secret(env[parsed.ref.slice(4)]);
      if (secret === null) {
        return yield* Effect.fail(new BoxRuntimeError("credential_invalid", "Referenced env credential is missing."));
      }
      return secret;
    }
    return yield* readSecretFile(parsed.ref.slice(5));
  });
}

export function fingerprintApiKeyRefEffect(
  ref: string,
  env: NodeJS.Dict<string>,
): Effect.Effect<string, BoxRuntimeError> {
  return materializeApiKeyRefEffect(ref, env).pipe(Effect.map(fingerprintSecret));
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
): Promise<string> {
  return runCredentialEffect(materializeApiKeyRefEffect(ref, env), signal);
}

/** Promise facade: SHA-256 hex. Never returns the secret. */
export function fingerprintApiKeyRef(
  ref: string,
  env: NodeJS.Dict<string>,
  signal?: AbortSignal,
): Promise<string> {
  return runCredentialEffect(fingerprintApiKeyRefEffect(ref, env), signal);
}
