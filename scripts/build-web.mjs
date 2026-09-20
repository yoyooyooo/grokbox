import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";

/** Build outputs only; no native installation, running service or global shim is
 * touched. Every dependency of the Web runtime is bundled into this directory. */
export async function buildWeb(root, identity = buildProvenance(root)) {
  const web = join(root, "apps", "web"), require = createRequire(join(web, "package.json"));
  const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const built = spawnSync("node", [vite, "build"], { cwd: web, stdio: "inherit", timeout: 120_000,
    env: { ...process.env, NODE_ENV: "production" } });
  if (built.error || built.status !== 0) throw new Error("Web client/SSR build failed.");
  const destination = join(root, "dist", "web");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(web, "dist", "client"), join(destination, "client"), { recursive: true });
  await cp(join(web, "dist", "server"), join(destination, "server"), { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ["apps/web/src/node.ts"], outfile: join(destination, "run.mjs"),
    bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
  if (buildProvenance(root).sourceDigest !== identity.sourceDigest) throw new Error("Source inputs changed while building the Web artifact.");
  const files = {};
  async function capture(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await capture(path);
      else if (entry.isFile()) { const bytes = await readFile(path); files[relative(destination, path).replaceAll("\\", "/")] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
      else throw new Error("The Web artifact contains an unexpected file type.");
    }
  }
  await capture(destination);
  const version = name => JSON.parse(require("node:fs").readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
  await writeFile(join(destination, "manifest.json"), JSON.stringify({ version: 1, sourceDigest: identity.sourceDigest,
    node: ">=22.12.0", versions: { vite: version("vite"), start: version("@tanstack/react-start"), react: version("react") }, files }, null, 2) + "\n");
  return destination;
}
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb(root);
