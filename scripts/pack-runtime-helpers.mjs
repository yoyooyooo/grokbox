import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages", "box-runtime", "src");
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });
for (const name of ["guardian-child.cjs", "injector-hold.cjs", "grokbox-temp-supervisor.cjs"]) {
  cpSync(join(src, name), join(dist, name));
}

await build({
  absWorkingDir: root,
  entryPoints: [join(src, "preload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(dist, "preload.cjs"),
  logLevel: "warning",
});
