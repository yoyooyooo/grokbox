import { build } from "esbuild";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProvenance } from "./build-provenance.mjs";

const MAX_BYTES = 32 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const equalBuild = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const failure = reason => Object.assign(new Error(reason), { code: reason });

/** The sole preload compiler recipe. The packer publishes these bytes; the
 * development checker independently rebuilds them in memory from source/lock/
 * compiler inputs. Neither a candidate's claims nor a saved golden is an oracle. */
export function preloadBuildOptions(root, identity) {
  return {
    absWorkingDir: resolve(root), entryPoints: [join(resolve(root), "packages/box-runtime/src/preload.ts")],
    bundle: true, platform: "node", target: "node20", format: "cjs",
    outfile: join(resolve(root), "dist/preload.cjs"), write: false,
    define: { __GROKBOX_BUILD_INFO__: JSON.stringify(identity) }, logLevel: "silent",
  };
}

export async function buildPreloadReference(root) {
  const identity = buildProvenance(root);
  const result = await build(preloadBuildOptions(root, identity));
  if (!equalBuild(identity, buildProvenance(root))) throw failure("preload_source_changed");
  if (result.outputFiles?.length !== 1
    || result.outputFiles[0].path !== join(resolve(root), "dist/preload.cjs")) throw failure("preload_output_invalid");
  const bytes = Buffer.from(result.outputFiles[0].contents);
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw failure("preload_output_invalid");
  return { bytes, sha256: digest(bytes), build: identity };
}

function readArtifact(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) throw failure("preload_not_regular");
    if (before.size < 1 || before.size > MAX_BYTES) throw failure("preload_size_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== before.size || !sameFile(before, fstatSync(fd))
      || !sameFile(before, lstatSync(path))) throw failure("preload_artifact_changed");
    return { bytes: offset, sha256: digest(bytes.subarray(0, offset)), stat: before };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Read-only development evidence, not signature verification or permission to
 * load/adopt. Capture the candidate BEFORE rebuilding. Never execute or repair
 * candidate code; wrong/old code with a plausible embedded identity still fails.
 * A later consumer must also pin its own window: these observations are no lock. */
export async function verifyPreloadArtifact(root, path = join(root, "dist/preload.cjs")) {
  let observed, expected;
  try {
    observed = readArtifact(path);
    expected = await buildPreloadReference(root);
    const after = readArtifact(path);
    if (!sameFile(observed.stat, after.stat) || observed.sha256 !== after.sha256) throw failure("preload_artifact_changed");
    if (!equalBuild(expected.build, buildProvenance(root))) throw failure("preload_source_changed");
    const ok = observed.sha256 === expected.sha256;
    return { ok, reason: ok ? "source-bound-rebuild" : "preload_rebuild_mismatch",
      artifact: { sha256: observed.sha256, bytes: observed.bytes },
      expected: { sha256: expected.sha256, build: expected.build },
      sourceStable: true, artifactStable: true, executed: false, adoptionAuthorized: false };
  } catch (error) {
    const code = error?.code;
    const reason = code === "ENOENT" ? "preload_missing" : code === "ELOOP" ? "preload_not_regular"
      : ["preload_not_regular", "preload_size_invalid", "preload_artifact_changed", "preload_source_changed", "preload_output_invalid"].includes(code)
        ? code : "preload_verification_unavailable";
    return { ok: false, reason, artifact: observed ? { sha256: observed.sha256, bytes: observed.bytes } : null,
      expected: expected ? { sha256: expected.sha256, build: expected.build } : null,
      executed: false, adoptionAuthorized: false };
  }
}
