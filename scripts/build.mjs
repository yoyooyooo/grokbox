import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";
import { buildWeb } from "./build-web.mjs";
import { buildHostVerifier } from "./build-host-verifier.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const identity = buildProvenance(root);
const verifier = buildHostVerifier(root);
await build({
  absWorkingDir: root, entryPoints: { index: "packages/cli/src/index.ts", server: "packages/server/src/main.ts" }, bundle: true,
  platform: "node", target: "node20", format: "esm", outdir: "dist",
  external: ["classic-level", "sqlite3"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __GROKBOX_BUILD_INFO__: JSON.stringify(identity), __GROKBOX_VERIFIER_BUILD_ID__: JSON.stringify(verifier.build_id), __GROKBOX_VERIFIER_BINARY_SHA256__: JSON.stringify(verifier.binary_sha256) },
});
await import("./pack-runtime-helpers.mjs");
await buildWeb(root, identity);
if (buildProvenance(root).sourceDigest !== identity.sourceDigest) {
  throw new Error("Source inputs changed during build; artifacts are not qualified for deployment.");
}
