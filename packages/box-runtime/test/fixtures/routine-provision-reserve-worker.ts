import { openRoutineProvisionStore } from "../../src/internal/io/routine-provision.node.ts";
import { parseRoutineBlueprint, desiredRoutineDigest, provisionFingerprint } from "@grokbox/runtime-kernel/routines";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
const root = resolve(process.argv[2] ?? "");
if (!root.startsWith(resolve(tmpdir()) + sep)) throw Error("owned_fixture_root_required");
const command = { action: "apply" as const, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "initial", confirmed: true as const,
  blueprint: parseRoutineBlueprint({ schemaVersion: 1, key: "notice", name: "Runtime notices", prompt: "PRIVATE_PROMPT_SENTINEL", trigger: { type: "webhook" } }) };
await openRoutineProvisionStore(root).reserve({ agentId: command.agentId, operationId: command.operationId, key: command.blueprint.key,
  fingerprint: provisionFingerprint(command), desiredDigest: desiredRoutineDigest(command.blueprint), action: "create", binding: null, atMs: Date.now() });
process.stdout.write("reserved\n");
setInterval(() => {}, 1000);
