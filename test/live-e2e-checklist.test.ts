import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";

// Documentation integrity only: no live probes, services, credentials, providers
// or mutations. Registry growth must earn an explicit acceptance route.
const root = fileURLToPath(new URL("../", import.meta.url));
const indexFile = "docs/tickets/LIVE-integration-validation.md";
const guideFile = "docs/maintainers/live-end-to-end.md";
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const withoutFences = (value: string) => value.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
const index = read(indexFile), guide = read(guideFile), rendered = withoutFences(index);
const rows = rendered.split("\n").filter(line => /^\| <a id="live-/.test(line));
const cells = (line: string) => line.split("|").slice(1, -1).map(v => v.trim());
const idOf = (line: string) => line.match(/<a id="([^"]+)"/u)![1]!;
const scenarioIds = new Set(rows.map(idOf));
const results = /`(?:not-run|awaiting-integration|ready|running|passed|failed|blocked|needs-revalidation|excluded|superseded)`/;

test("each scenario keeps implementation, current result, concrete oracles and source/next action distinct", () => {
  expect(rows.length).toBeGreaterThan(0);
  expect(scenarioIds.size).toBe(rows.length);
  for (const row of rows) {
    const parts = cells(row), id = idOf(row);
    expect(parts, id).toHaveLength(4); expect(parts.every(v => v.length > 0), id).toBe(true);
    expect(parts[0], id).toContain(id.toUpperCase()); expect(parts[0], id).toMatch(/<br>(?:G[0-3]|D)/);
    expect(parts[1], id).toMatch(/`(?:integrated|partial|planned|reserved)(?:\/(?:integrated|partial|planned|experimental))?`/);
    expect(parts[1], id).toMatch(results);
    expect(parts[3], id).toMatch(/\]\([^)]*\.md(?:#[^)]*)?\)/);
  }
});

test("all registered CLI leaves have exactly one explicit primary scenario, including reserved and optional surfaces", () => {
  const section = rendered.split('<a id="command-coverage"></a>')[1]!.split('<a id="worktree-intake"></a>')[0]!;
  const mapped: string[] = [];
  for (const row of section.split("\n").filter(line => line.startsWith("| `"))) {
    const parts = cells(row), commands = [...parts[0]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!);
    const target = parts[1]!.match(/\(#(live-[a-z0-9-]+)\)/)?.[1];
    expect(target, row).toBeDefined(); expect(scenarioIds.has(target!), row).toBe(true);
    expect(commands.length, row).toBeGreaterThan(0);
    for (const command of commands) { expect(command, row).not.toContain("*"); mapped.push(command); }
  }
  const registry = LEAF_COMMANDS.map(c => c.path.join(" ")).sort();
  expect(new Set(mapped).size).toBe(mapped.length);
  expect(mapped.sort()).toEqual(registry);
});

test("runbook commands reference existing leaves", () => {
  const blocks = [...guide.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]!);
  const commands = LEAF_COMMANDS.map(c => c.path.join(" ")).sort((a, b) => b.length - a.length);
  for (const block of blocks) for (const line of block.trim().split("\n")) {
    if (!line.startsWith("grokbox ")) continue;
    const content = line.slice("grokbox ".length);
    expect(commands.some(command => content === command || content.startsWith(`${command} `)), line).toBe(true);
  }
});

function completionIssues(resultCell: string): string[] {
  const checked = /^\[x\]\s/i.test(resultCell), passed = /`passed`/.test(resultCell);
  const issues: string[] = [];
  if (checked !== passed) issues.push("completion_mark_must_match_passed");
  const reports = [...resultCell.matchAll(/\]\((\.\.\/reports\/[^)\s]+)\)/g)].map(match => match[1]!);
  if (passed && (reports.length !== 1 || !/\.md#[^#\s]+$/.test(reports[0]!))) issues.push("one_current_anchored_report_required");
  return issues;
}

test("completion ticks require one current per-scenario evidence pointer, not a growing report history", () => {
  for (const row of rows) expect(completionIssues(cells(row)[1]!), idOf(row)).toEqual([]);
  // Parser fixtures only: these are not live results or links in the index.
  const proof = "[evidence](../reports/example-live-window.md#live-example)";
  expect(completionIssues(`[x] \`integrated\`；\`passed\`；candidate；${proof}`)).toEqual([]);
  expect(completionIssues("[ ] `integrated`；`blocked`；ENV")).toEqual([]);
  expect(completionIssues(`[ ] \`passed\`；${proof}`)).toContain("completion_mark_must_match_passed");
  expect(completionIssues("[x] `blocked`")).toContain("completion_mark_must_match_passed");
  expect(completionIssues("[x] `passed`；[window](../reports/example-live-window.md)"))
    .toContain("one_current_anchored_report_required");
  expect(completionIssues(`[x] \`passed\`；${proof}；${proof}`)).toContain("one_current_anchored_report_required");
});
