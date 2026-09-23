import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { version as compilerVersion } from "esbuild";

/** Public source/lock/build inputs only; never Git status output, env values,
 * credentials, machine-local state, transcript or private upstream material. */
export function buildProvenance(root) {
  const paths = [];
  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name);
      if (item.name === "routeTree.gen.ts") continue; // Deterministic router output, regenerated from source routes.
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) paths.push(path);
      else throw new Error("build source must contain regular files/directories only");
    }
  };
  for (const workspace of ["cli", "box-runtime", "runtime-kernel", "client", "server"]) {
    walk(join(root, "packages", workspace, "src"));
    paths.push(join(root, "packages", workspace, "package.json"));
  }
  walk(join(root, "apps", "web", "src"));
  walk(join(root, "crates", "host-verifier", "src"));
  walk(join(root, "protocols", "host-verifier"));
  for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/host-verifier/Cargo.toml", "crates/host-verifier/build.rs", "scripts/build-host-verifier.mjs", "scripts/generate-host-verifier-protocol.mjs"]) paths.push(join(root, file));
  for (const file of ["apps/web/package.json", "apps/web/tsconfig.json", "apps/web/vite.config.ts", "package.json", "bun.lock", "tsconfig.json", "scripts/build.mjs", "scripts/build-web.mjs", "scripts/build-provenance.mjs", "scripts/pack-runtime-helpers.mjs", "scripts/preload-artifact.mjs"]) paths.push(join(root, file));
  const hash = createHash("sha256");
  for (const path of paths.sort()) hash.update(relative(root, path).replaceAll("\\", "/") + "\0").update(readFileSync(path)).update("\0");
  const require = createRequire(join(root, "packages", "box-runtime", "package.json"));
  const dependencyVersion = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
  return {
    version: 1, kind: "bundled", sourceDigest: hash.digest("hex"), compilerVersion,
    sdkVersions: { ai: dependencyVersion("ai"), openai: dependencyVersion("@ai-sdk/openai"), effect: dependencyVersion("effect") },
  };
}
