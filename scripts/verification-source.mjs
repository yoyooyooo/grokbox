import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";

export const VERIFICATION_SOURCE_PATHS = Object.freeze([
  "apps", "packages", "scripts", "test", "bin", "skills", "crates", "protocols",
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
  "package.json", "bun.lock", "bun.lockb", "bunfig.toml", "tsconfig.json",
]);

/** Ephemeral proof input, not a new runtime/version store. Include uncommitted and
 * untracked sources/tests plus lock/config inputs; exclude generated dist and ignored
 * dependencies. Dependency installation and native Host qualification remain separate.
 */
export function captureVerificationSource(root, ownedPaths) {
  let fd;
  try {
    const base = resolve(root);
    const paths = ownedPaths ?? execFileSync("git", [
      "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
      ...VERIFICATION_SOURCE_PATHS,
    ], { cwd: base, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).split("\0").filter(Boolean);
    const ordered = [...new Set(paths)].sort();
    if (!ordered.length || ordered.length > 20_000) throw new Error("source_count");
    const hash = createHash("sha256");
    let total = 0;
    for (const relative of ordered) {
      const path = resolve(base, relative);
      if (typeof relative !== "string" || !path.startsWith(`${base}${sep}`)) throw new Error("source_path");
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        hash.update(relative).update("\0missing\0");
        continue;
      }
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 8 * 1024 * 1024 || (total += before.size) > 64 * 1024 * 1024) throw new Error("source_bound");
      const bytes = Buffer.alloc(before.size + 1);
      const read = readSync(fd, bytes, 0, bytes.length, 0);
      const after = fstatSync(fd);
      if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("source_changed");
      hash.update(relative).update("\0").update(String(before.mode & 0o777)).update("\0").update(String(read)).update("\0").update(bytes.subarray(0, read)).update("\0");
      closeSync(fd); fd = undefined;
    }
    return { ok: true, sha256: hash.digest("hex"), files: ordered.length };
  } catch {
    return { ok: false, reason: "source_unavailable_or_changed" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** A test result on moving inputs is not an exact candidate qualification. */
export function withVerificationSource(report, before, after) {
  const stable = before.ok && after.ok && before.sha256 === after.sha256;
  const source = { before, after, stable, scope: "git-visible-source-tests-locks-not-installed-dependencies" };
  if (stable) return { ...report, source };
  return {
    ...report, ok: false, supports: [], source,
    error: report.error ?? "verification_source_changed",
    notProven: [...new Set([...(report.notProven ?? []), "source_consistency"])],
  };
}
