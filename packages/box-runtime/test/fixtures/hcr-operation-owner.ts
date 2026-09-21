import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireOperationLease } from "../../src/internal/io/operation-lease.node.ts";

const root = resolve(process.argv[2] ?? "/not-a-fixture");
const exitAfterPublication = process.argv[3] === "exit-after-publication";
const disposable = exitAfterPublication
  ? ["grokbox-hcr-lifetime-", "grokbox-hcr-cli-"].some(prefix => root.startsWith(join(tmpdir(), prefix)))
    || basename(root) === "installed-hcr-runtime" && basename(dirname(root)).startsWith("grokbox-package-test-")
  : root.startsWith(join(tmpdir(), "grokbox-hcr-crash-"));
if (!disposable || process.argv.length > 4 || process.argv[3] !== undefined && !exitAfterPublication) throw new Error("disposable_fixture_root_required");
const operationId = exitAfterPublication ? "lifetime-fixture" : "fixture-operation";
const controller = await acquireOperationLease(join(root, "state", "controller-operations.lock"), operationId);
const identity = await acquireOperationLease(join(root, "run", "ops", "identity.lock"), operationId);
if (!controller.ok || !identity.ok) throw new Error("fixture_lease_unavailable");
await mkdir(join(root, "state"), { recursive: true });
await writeFile(join(root, "state", "controller-operations.json"), JSON.stringify({
  [operationId]: { fingerprint: "f".repeat(64), state: "running", leaseOwner: controller.lock.owner,
    prefix: { signaled: true, spawned: true, guardian: true } },
}) + "\n", { mode: 0o600, flag: "wx" });
// The prefix is a synthetic interrupted-state fixture, not a real Host signal.
process.stdout.write("ready\n");
if (exitAfterPublication) process.exit(0); // Test-only hard boundary: no JavaScript lock release.
process.stdin.resume();
process.stdin.on("end", async () => { await identity.lock.release(); await controller.lock.release(); process.exit(0); });
