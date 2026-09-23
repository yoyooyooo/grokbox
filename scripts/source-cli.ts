import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliEntry } from "../packages/cli/src/entry.ts";

// Bun resolves this complete source graph in the checkout, not by scanning an
// arbitrary caller directory. Restore invocation semantics only AFTER linking,
// before constructing CLI dependencies, opening files or starting any command.
const callerDirectory = process.argv[2];
let restored = false;
try {
  if (!process.versions.bun || !callerDirectory || !isAbsolute(callerDirectory)) throw new Error("invalid-source-invocation");
  process.chdir(callerDirectory);
  process.argv.splice(1, 2, fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)));
  restored = true;
} catch {
  process.stderr.write("grokbox local shim: caller directory is unavailable\n");
  process.exitCode = 127;
}
if (restored) await runCliEntry(process.argv.slice(2));
