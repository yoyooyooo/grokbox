import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ManagementClientError, type ManagementClient } from "@grokbox/client";
import type { CliDeps } from "./deps.ts";

/** Owner-requested console bootstrap. The one-use code goes only to an exclusive
 * private file; the command's normal envelope contains no credential value. */
export async function createConsoleCredentialFile(deps: CliDeps, client: ManagementClient, origin: string | undefined, destination: string | undefined) {
  if (!origin || !destination) throw new ManagementClientError("invalid_input", "Console bootstrap requires origin and credential-file.");
  const target = resolve(destination), parent = dirname(target);
  try {
    if (await realpath(parent) !== parent) throw new Error("parent_alias");
    const info = await lstat(parent);
    if (!info.isDirectory() || !process.getuid || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new Error("unsafe_parent");
    try { await lstat(target); throw new Error("exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch { throw new ManagementClientError("invalid_input", "Choose a new credential file in an existing, owned, non-writable-by-others directory without symlinks."); }
  const temp = await mkdtemp(join(parent, ".grokbox-console-"));
  try {
    const reply = await client.createConsoleGrant(origin, deps.signal);
    const path = join(temp, "credential.json");
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, installationId: reply.installationId, ...reply.data })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await link(path, target);
    return { ...reply, data: { credentialFile: target, grantId: reply.data.grantId, origin: reply.data.origin,
      expiresAt: reply.data.expiresAt, persistence: reply.data.persistence } };
  } catch (error) {
    if (error instanceof ManagementClientError) throw error;
    throw new ManagementClientError("unavailable", "Console bootstrap output was not confirmed. Any issued code expires within five minutes; the destination was not overwritten.");
  } finally { await rm(temp, { recursive: true, force: true }); }
}
