import { acquireConfigurationLease } from "../../src/internal/io/config-lock.node.ts";
const root = process.argv[2];
if (!root || !root.startsWith("/")) throw new Error("Test root is required.");
const lease = await acquireConfigurationLease(root);
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, nonce: lease.owner.nonce })}\n`);
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", async () => { clearInterval(timer); await lease.release(); process.exit(0); });
