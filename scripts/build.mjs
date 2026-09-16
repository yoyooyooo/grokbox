import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const identity = buildProvenance(root);
await build({
  absWorkingDir: root, entryPoints: ["packages/cli/src/index.ts"], bundle: true,
  platform: "node", target: "node20", format: "esm", outfile: "dist/index.js",
  external: ["classic-level", "sqlite3"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __GROKBOX_BUILD_INFO__: JSON.stringify(identity) },
});
await import("./pack-runtime-helpers.mjs");
if (buildProvenance(root).sourceDigest !== identity.sourceDigest) {
  throw new Error("Source inputs changed during build; artifacts are not qualified for deployment.");
}
