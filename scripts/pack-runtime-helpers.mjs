import { cpSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";
import { buildPreloadReference } from "./preload-artifact.mjs";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages", "box-runtime", "src");
const helpers = join(src, "internal", "process", "helpers");
const dist = join(root, "dist");
const identity = buildProvenance(root);

mkdirSync(dist, { recursive: true });
for (const name of ["guardian-child.cjs", "injector-hold.cjs", "grokbox-temp-supervisor.cjs", "retirement-observer.py"]) {
  cpSync(join(helpers, name), join(dist, name));
}

// The disk-backed monitor loads its declared sqlite3 dependency lazily. Remove
// the retired whole-image engine from previous builds; there is no dual runtime.
rmSync(join(dist, "observation-sqlite.cjs"), { force: true });

const reference = await buildPreloadReference(root);
if (JSON.stringify(reference.build) !== JSON.stringify(identity)) {
  throw new Error("Source inputs changed before preload build; artifact is not qualified.");
}
const pending = join(dist, `preload.${randomUUID()}.tmp`);
try {
  writeFileSync(pending, reference.bytes, { flag: "wx", mode: 0o644 });
  if (JSON.stringify(buildProvenance(root)) !== JSON.stringify(identity)) {
    throw new Error("Source inputs changed during preload publication; artifact is not qualified.");
  }
  renameSync(pending, join(dist, "preload.cjs"));
} finally { rmSync(pending, { force: true }); }

if (buildProvenance(root).sourceDigest !== identity.sourceDigest) {
  throw new Error("Source inputs changed during preload build; artifact is not qualified.");
}
