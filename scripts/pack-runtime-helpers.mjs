import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages", "box-runtime", "src");
const helpers = join(src, "internal", "process", "helpers");
const dist = join(root, "dist");
const identity = buildProvenance(root);

mkdirSync(dist, { recursive: true });
for (const name of ["guardian-child.cjs", "injector-hold.cjs", "grokbox-temp-supervisor.cjs"]) {
  cpSync(join(helpers, name), join(dist, name));
}

// The disk-backed monitor loads its declared sqlite3 dependency lazily. Remove
// the retired whole-image engine from previous builds; there is no dual runtime.
rmSync(join(dist, "observation-sqlite.cjs"), { force: true });

await build({
  absWorkingDir: root,
  entryPoints: [join(src, "preload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(dist, "preload.cjs"),
  define: { __GROKBOX_BUILD_INFO__: JSON.stringify(identity) },
  logLevel: "warning",
});
if (buildProvenance(root).sourceDigest !== identity.sourceDigest) {
  throw new Error("Source inputs changed during preload build; artifact is not qualified.");
}
