import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { stripOneTrailingNewline, utf8Bytes } from "../util.ts";
import { validateSecretRef, writeProtectedSecret } from "./profile.ts";

const MAX_SECRET_BYTES = 1024 * 1024;

type SecretFileStat = {
  mode: number;
  uid: number;
  isFile: () => boolean;
};

export function validateSecretFileStat(
  info: SecretFileStat,
  currentUid = process.getuid?.(),
): void {
  if (!info.isFile()) {
    throw new CliError("credential_invalid", "The referenced file credential must be a regular file.");
  }
  if (!Number.isSafeInteger(currentUid)) {
    throw new CliError(
      "credential_invalid",
      "File credential ownership cannot be verified on this platform; use env: or keychain:.",
    );
  }
  if (info.uid !== currentUid) {
    throw new CliError("credential_invalid", "The referenced file credential must be owned by the current user.");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new CliError(
      "credential_invalid",
      "The referenced file credential must not grant group or other permissions.",
    );
  }
}

function checkedSecret(value: string): string {
  const secret = stripOneTrailingNewline(value);
  if (secret.length === 0) {
    throw new CliError("credential_invalid", "The referenced credential is empty.");
  }
  if (utf8Bytes(secret) > MAX_SECRET_BYTES) {
    throw new CliError("credential_invalid", "The referenced credential exceeds 1 MiB.");
  }
  return secret;
}

async function readProtectedSecretFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new CliError("credential_invalid", "The referenced file credential must not be a symbolic link.");
    }
    throw new CliError("credential_unavailable", "The referenced file credential is unavailable.");
  }

  try {
    validateSecretFileStat(await handle.stat());
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_SECRET_BYTES) {
      throw new CliError("credential_invalid", "The referenced credential exceeds 1 MiB.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new CliError("credential_invalid", "The referenced file credential must contain valid UTF-8.");
    }
  } finally {
    await handle.close();
  }
}

export async function resolveSecretRef(
  deps: Pick<CliDeps, "env" | "readFile" | "runCommand">,
  ref: string,
): Promise<string> {
  validateSecretRef(ref, "credential_ref");
  if (ref.startsWith("env:")) {
    const value = deps.env[ref.slice(4)];
    if (value === undefined) {
      throw new CliError("credential_unavailable", "The referenced environment credential is unavailable.");
    }
    return checkedSecret(value);
  }
  if (ref.startsWith("file:")) {
    return checkedSecret(await readProtectedSecretFile(ref.slice(5)));
  }

  const payload = ref.slice("keychain:".length);
  const separator = payload.indexOf("/");
  const service = payload.slice(0, separator);
  const account = payload.slice(separator + 1);
  const result = await deps.runCommand([
    "security",
    "find-generic-password",
    "-w",
    "-s",
    service,
    "-a",
    account,
  ]);
  if (result.code !== 0) {
    const locked = /interaction is not allowed|user interaction|locked/i.test(result.stderr);
    throw new CliError(
      locked ? "credential_locked" : "credential_unavailable",
      locked ? "The referenced Keychain credential is locked." : "The referenced Keychain credential is unavailable.",
    );
  }
  return checkedSecret(result.stdout);
}

export async function retireOwnedFileSecret(
  configDir: string,
  previousRef: string | undefined,
  currentRef: string | undefined,
): Promise<void> {
  if (!previousRef?.startsWith("file:") || previousRef === currentRef) return;
  const path = resolve(previousRef.slice(5));
  const root = resolve(configDir, "secrets");
  if (path !== root && !path.startsWith(`${root}${sep}`)) return;
  await writeProtectedSecret(path, "revoked");
}

export async function resolveDaemonCredential(
  deps: Pick<CliDeps, "env" | "readFile" | "runCommand">,
  ref: string | undefined,
): Promise<string> {
  if (!ref) {
    throw new CliError("daemon_credential_required", "The remote daemon Profile requires daemon_token_ref.");
  }
  try {
    return await resolveSecretRef(deps, ref);
  } catch (error) {
    if (error instanceof CliError && error.code === "daemon_credential_required") throw error;
    if (error instanceof CliError) {
      throw new CliError("daemon_credential_failed", "The remote daemon credential could not be resolved.");
    }
    throw error;
  }
}
