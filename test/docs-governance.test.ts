import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA_VERSION, validateConfig } from "../packages/runtime-kernel/src/internal/config/schema.ts";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";

// Pure repository checks: no network, runtime probes, private source or writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const withoutFences = (value: string) => value
  .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
  .replace(/^~~~[^\n]*\n[\s\S]*?^~~~\s*$/gm, "");

function markdownFiles(directory: string): string[] {
  const result: string[] = [];
  for (const item of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) result.push(...markdownFiles(path));
    else if (item.isFile() && path.endsWith(".md")) result.push(path);
  }
  return result;
}

const files = ["AGENTS.md", "CONTEXT.md", "README.md", ...markdownFiles("docs"), ...markdownFiles("skills"), ...markdownFiles(".agents")];
const anchorCache = new Map<string, Set<string>>();
function anchors(path: string): Set<string> {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const text = withoutFences(readFileSync(path, "utf8"));
  const ids = new Set([...text.matchAll(/<a\s+id="([^"]+)"/g)].map(match => match[1]!));
  const used = new Map<string, number>();
  for (const heading of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = heading[1]!.toLowerCase().replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
    const count = used.get(slug) ?? 0;
    used.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  anchorCache.set(path, ids);
  return ids;
}

function localLinkFailures(file: string): string[] {
  const failures: string[] = [];
  for (const link of withoutFences(read(file)).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = link[1]!;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) continue;
    try {
      const [path, fragment] = href.split("#", 2);
      const target = path ? resolve(dirname(resolve(root, file)), decodeURIComponent(path)) : resolve(root, file);
      if (!existsSync(target)) { failures.push(`${file}: missing ${href}`); continue; }
      if (fragment && target.endsWith(".md") && !anchors(target).has(decodeURIComponent(fragment))) {
        failures.push(`${file}: missing anchor ${href}`);
      }
    } catch { failures.push(`${file}: malformed/unreadable ${href}`); }
  }
  return failures;
}

test("repository documentation local inline links and fragments resolve", () => {
  expect(files.flatMap(localLinkFailures)).toEqual([]);
});

test("explicit documentation anchors are unique within each file", () => {
  const failures: string[] = [];
  for (const file of files) {
    const ids = [...withoutFences(read(file)).matchAll(/<a\s+id="([^"]+)"/g)].map(match => match[1]!);
    if (new Set(ids).size !== ids.length) failures.push(file);
  }
  expect(failures).toEqual([]);
});

test("current configuration example validates against the actual source schema", () => {
  const examples = [...read("docs/configuration.md").matchAll(/^```json\n([\s\S]*?)^```/gm)];
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    const value: unknown = JSON.parse(example[1]!);
    expect(() => validateConfig(value)).not.toThrow();
    expect((value as { schemaVersion: number }).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  }
});

test("every source ticket remains reachable by its complete filename", () => {
  const index = withoutFences(read("docs/tickets/README.md"));
  const linked = new Set([...index.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split("#")[0]!));
  const tickets = readdirSync(resolve(root, "docs/tickets"))
    .filter(name => name.endsWith(".md") && name !== "README.md");
  expect(tickets.length).toBeGreaterThan(0);
  for (const ticket of tickets) expect(linked.has(ticket), ticket).toBe(true);
});

test("lifecycle examples use registered commands", () => {
  const guide = read("docs/maintainers/bot-lifecycle.md");
  const commands = LEAF_COMMANDS.map(command => command.path.join(" ")).sort((a, b) => b.length - a.length);
  const examples = [...guide.matchAll(/^```bash\n([\s\S]*?)^```/gm)]
    .flatMap(match => match[1]!.split("\n")).filter(line => line.startsWith("grokbox "));
  expect(examples.length).toBeGreaterThan(0);
  for (const line of examples) {
    const text = line.slice("grokbox ".length);
    expect(commands.some(command => text === command || text.startsWith(`${command} `)), line).toBe(true);
  }
});
