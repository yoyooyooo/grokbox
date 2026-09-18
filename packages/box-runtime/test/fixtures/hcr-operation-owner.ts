import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireOperationLease } from "../../src/internal/io/operation-lease.node.ts";

const root = resolve(process.argv[2] ?? "/not-a-fixture");
if (!root.startsWith(join(tmpdir(), "grokbox-hcr-crash-"))) throw new Error("disposable_fixture_root_required");
const controller = await acquireOperationLease(join(root, "state", "controller-operations.lock"), "fixture-operation");
const identity = await acquireOperationLease(join(root, "run", "ops", "identity.lock"), "fixture-operation");
if (!controller.ok || !identity.ok) throw new Error("fixture_lease_unavailable");
await mkdir(join(root, "state"), { recursive: true });
await writeFile(join(root, "state", "controller-operations.json"), JSON.stringify({
  "fixture-operation": { fingerprint: "f".repeat(64), state: "running", leaseOwner: controller.lock.owner,
    prefix: { signaled: true, spawned: true, guardian: true } },
}) + "\n", { mode: 0o600 });
// The prefix is a synthetic interrupted-state fixture, not a real Host signal.
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.on("end", async () => { await identity.lock.release(); await controller.lock.release(); process.exit(0); });
