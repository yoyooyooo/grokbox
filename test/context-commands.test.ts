import { expect, test } from "bun:test";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { runManagementCommand } from "../packages/cli/src/commands/management-api.ts";
import { LEAF_COMMANDS, GATEWAY_METHODS } from "../packages/cli/src/registry.ts";
import { GatewayClient } from "../packages/cli/src/gateway.ts";
import { captureCli } from "./helpers.ts";
const bot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("manual compaction has one management entry and no former direct Gateway facade", () => {
  expect(LEAF_COMMANDS.some(r => r.path.join(" ") === "agents context" || r.path.join(" ") === "agents compact")).toBe(false);
  const current = LEAF_COMMANDS.find(r => r.path.join(" ") === "bot context compact")!;
  expect(current.protocol).toBe("management"); expect(current.gateway).toBe(false);
  expect(current.options.some(o => o.flags.startsWith("--session"))).toBe(false);
  expect(GATEWAY_METHODS as readonly string[]).not.toContain("grokboxContextControl");
  expect(Object.hasOwn(GatewayClient.prototype, "contextControl")).toBe(false);
});

for (const options of [{}, { confirm: true }, { preview: true, confirm: true }, { preview: true, requestId: "old" }, { preview: true, scopeId: "a".repeat(64) }]) {
  test(`invalid compaction intent refuses before credentials or transport: ${JSON.stringify(options)}`, async () => {
    let calls = 0;
    const deps = { ...createProductionDeps(), env: {}, readFile: async () => { calls++; throw Error("no-source"); }, fetch: (async () => { calls++; throw Error("no-network"); }) as unknown as typeof fetch };
    await expect(runManagementCommand(deps, "bot context compact", [bot], options)).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toBe(0);
  });
}
for (const args of [["agents", "context", bot], ["agents", "compact", bot, "--operation-id", "former", "--confirm"], ["bot", "context", "compact", bot, "--session", "named", "--preview"]]) {
  test(`removed syntax is a parser failure, not a hidden compatibility dispatch: ${args.join(" ")}`, async () => {
    let calls = 0;
    const result = await captureCli(args, { env: {}, fetch: (async () => { calls++; throw Error("forbidden-network"); }) as unknown as typeof fetch });
    expect(result.code).toBe(2); expect(calls).toBe(0);
  });
}
