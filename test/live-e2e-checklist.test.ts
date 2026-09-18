import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

// Historical externally-linked IDs are contractual. The instructional template
// anchor and the two dated windows are preserved but are not live test cases.
const historicalIds = [
  "live-config-cutover", "live-config-consumers", "live-config-home-reset", "live-modeld-cutover", "live-reasoning-cutover", "live-host-capability-recovery",
  "live-modeld-native", "live-modeld-authority", "live-auth-availability-native", "live-modeld-tools", "live-auth-availability-tools", "live-modeld-app",
  "live-auth-availability-app", "live-reasoning-provider", "live-reasoning-host-app", "live-provider-minimax", "live-session-roundtrip",
  "live-context-native-continuity", "live-ownership-alignment", "live-modeld-restart", "live-runtime-persistence", "live-monitor-persistence",
  "live-obs-evidence", "live-obs-storage", "live-obs-safe-retirement", "live-ownership-continuity", "live-ownership-loss-protection",
  "live-continuity-material", "live-continuity-primitives", "live-current-context", "live-continuity-spawn", "live-continuity-handover",
  "live-continuity-retirement", "live-ops-routines", "live-ops-receivers", "live-ops-observer-lifetime", "live-ops-autonomy",
  "live-ops-issue-publishing", "live-ops-maintenance", "live-ctx-adoption", "live-ctx-next-input", "live-ctx-durability",
  "window-context-v8-20260917", "window-20260917", "live-feature-case", "live-native-duplicate",
];

function anchors(markdown: string): Set<string> {
  const text = withoutFences(markdown), ids = new Set([...text.matchAll(/<a id="([^"]+)"/g)].map(m => m[1]!));
  const used = new Map<string, number>();
  for (const heading of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = heading[1]!.toLowerCase().replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
    const count = used.get(slug) ?? 0;
    used.set(slug, count + 1); ids.add(count ? `${slug}-${count}` : slug);
  }
  return ids;
}

function localLinkFailures(file: string): string[] {
  const failures: string[] = [], text = withoutFences(read(file));
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = match[1]!;
    if (/^(?:https?:|mailto:)/i.test(href)) continue;
    const [path, fragment] = href.split("#", 2);
    const target = path ? resolve(dirname(resolve(root, file)), decodeURIComponent(path)) : resolve(root, file);
    if (!existsSync(target)) { failures.push(`${file}: missing ${href}`); continue; }
    if (fragment && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(decodeURIComponent(fragment))) {
      failures.push(`${file}: missing anchor ${href}`);
    }
  }
  return failures;
}

test("all historical LIVE anchors survive exactly once without becoming placeholder scenarios", () => {
  const all = [...rendered.matchAll(/<a id="([^"]+)"/g)].map(m => m[1]!);
  expect(new Set(all).size).toBe(all.length);
  for (const id of historicalIds) expect(all.filter(found => found === id), id).toHaveLength(1);
  expect(scenarioIds.has("live-feature-case")).toBe(false);
  for (const id of historicalIds.filter(id => id.startsWith("live-") && id !== "live-feature-case")) expect(scenarioIds.has(id), id).toBe(true);
});

test("each scenario keeps implementation, current result, concrete oracles and source/next action distinct", () => {
  expect(rows.length).toBeGreaterThanOrEqual(69);
  for (const row of rows) {
    const parts = cells(row), id = idOf(row);
    expect(parts, id).toHaveLength(4); expect(parts.every(v => v.length > 0), id).toBe(true);
    expect(parts[0], id).toContain(id.toUpperCase()); expect(parts[0], id).toMatch(/<br>(?:G[0-3]|D)/);
    expect(parts[1], id).toMatch(/`(?:integrated|partial|planned|reserved)(?:\/(?:integrated|partial|planned|experimental))?`/);
    expect(parts[1], id).toMatch(results);
    expect(parts[2]!.length, id).toBeGreaterThan(25);
    expect(parts[3], id).toMatch(/(?:CODE|REVIEW|ENV|AUTH|BUDGET|TOOL|DEP)/);
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

test("six separately addressable authorized model-effort cases and their common compact oracle are retained", () => {
  const expected = [
    ["live-model-sol-high", "sub2api-codex/gpt-5.6-sol", "high"],
    ["live-model-sol-xhigh", "sub2api-codex/gpt-5.6-sol", "xhigh"],
    ["live-model-grok-high", "sub2api-xai/grok-4.6", "high"],
    ["live-model-grok-xhigh", "sub2api-xai/grok-4.6", "xhigh"],
    ["live-model-deepseek-high", "sub2api-deepseek/deepseek-v4.1-flash", "high"],
    ["live-model-deepseek-xhigh", "sub2api-deepseek/deepseek-v4.1-flash", "xhigh"],
  ];
  for (const [id, model, effort] of expected) {
    const row = rows.find(r => idOf(r) === id);
    expect(row, id).toContain(`${model} / ${effort}`); expect(row, id).toContain("执行M");
    expect(guide, id).toContain(id!.toUpperCase());
  }
  for (const token of ["captured", "emitted", "reported", "checkpoint", "no-op", "控制Bot", "同一默认会话"]) expect(guide).toContain(token);
});

test("new runbook commands reference existing leaves and do not invent a live-all executor", () => {
  const blocks = [...guide.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]!);
  const commands = LEAF_COMMANDS.map(c => c.path.join(" ")).sort((a, b) => b.length - a.length);
  for (const block of blocks) for (const line of block.trim().split("\n")) {
    if (!line.startsWith("grokbox ")) continue;
    const content = line.slice("grokbox ".length);
    expect(commands.some(command => content === command || content.startsWith(`${command} `)), line).toBe(true);
  }
  expect(LEAF_COMMANDS.some(c => c.path.join(" ") === "verify live-all")).toBe(false);
});

test("all index and executable-guide local links and fragments resolve", () => {
  expect([...localLinkFailures(indexFile), ...localLinkFailures(guideFile)]).toEqual([]);
});

test("existing documentation links into LIVE still resolve after the reorganization", () => {
  const targets = anchors(index), failures: string[] = [];
  const visit = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) { visit(path); continue; }
      if (!item.isFile() || !path.endsWith(".md")) continue;
      const text = withoutFences(readFileSync(path, "utf8"));
      for (const link of text.matchAll(/\]\([^\s)]*LIVE-integration-validation\.md#([^\s)]+)\)/g)) {
        if (!targets.has(decodeURIComponent(link[1]!))) failures.push(`${path.slice(root.length)}: ${link[1]}`);
      }
    }
  };
  visit(resolve(root, "docs"));
  expect(failures).toEqual([]);
});

test("a finite live window does not silently authorize publication, irreversible cleanup or fake provider proof", () => {
  for (const token of ["Git push/tag/npm", "平台 Reset", "不迁移配置", "不把未实现代码或 review 改称 live 待办", "cleanup_required", "needs-revalidation"]) expect(index).toContain(token);
  for (const token of ["操作人", "unknown", "不改系统时钟", "不生产填满磁盘", "先保存", "--confirm-receiver", "不重放"]) expect(index + guide).toContain(token);
});

test("worktree contributors have intake, invalidation and one current result home", () => {
  for (const id of ["worktree-intake", "command-coverage", "release-lanes", "window-order"]) expect(anchors(index).has(id)).toBe(true);
  for (const token of ["来源SHA", "失败/重启反例", "费用", "清理", "受影响LIVE-ID", "不整段覆盖", "awaiting-integration"]) expect(index).toContain(token);
  expect(guide).toContain("不要在这里打第二套通过/待办勾");
});
