#!/usr/bin/env bun
/**
 * Stage and publish the canonical grokbox official template.
 * Box-local: Host launch-env renewal + Gateway publish. Does not log credentials.
 *
 *   bun run publish:template -- --for <source-bot> --yes
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { runTemplatePublish, runTemplateStage } from "../packages/cli/src/commands/template.ts";

const recipePath = join(dirname(fileURLToPath(import.meta.url)), "templates", "grokbox.recipe.json");

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const source = arg("--for") ?? process.env.GROKBOX_TEMPLATE_SOURCE_AGENT;
if (!source) {
  process.stderr.write("publish:template requires --for <source-bot> or GROKBOX_TEMPLATE_SOURCE_AGENT.\n");
  process.exit(2);
}
if (!process.argv.includes("--yes")) {
  process.stderr.write("publish:template requires --yes.\n");
  process.exit(2);
}

const deps = createProductionDeps();
let receipt: { shareId?: string; version?: number } = {};
const originalWrite = deps.stdout.write.bind(deps.stdout);
deps.stdout.write = (chunk: string) => {
  originalWrite(chunk);
  try {
    const parsed = JSON.parse(chunk) as { data?: { shareId?: string; version?: number } };
    if (typeof parsed.data?.shareId === "string") receipt = { ...receipt, ...parsed.data };
  } catch {
    // best-effort envelope parse
  }
};

await runTemplateStage(deps, source, {
  visibility: "public",
  from: recipePath,
  yes: true,
  json: true,
});
if (!receipt.shareId || typeof receipt.version !== "number") {
  process.stderr.write("publish:template staged but the receipt lacked shareId/version.\n");
  process.exit(1);
}
await runTemplatePublish(deps, receipt.shareId, {
  rev: String(receipt.version),
  yes: true,
  json: true,
});
