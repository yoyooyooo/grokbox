#!/usr/bin/env node
/** Read-only publication checks. Reports locations/rules, never matched values. */
import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const LIMIT = 256 * 1024 * 1024;
const findings = [];
const stats = { commits: 0, blobs: 0, bytes: 0, binaryBlobs: 0 };
let root;
function git(args, input) {
  const result = spawnSync("git", ["-C", root, ...args], { input, maxBuffer: LIMIT });
  if (result.error || result.status !== 0) throw new Error("git_read_failed");
  return result.stdout;
}
function report(rule, path, line = 1, oid) {
  findings.push({ rule, path, line, ...(oid ? { object: oid } : {}) });
}
function checkPath(path) {
  if (/(^|\/)(?:\.scratch|\.publication-private|\.private-audit|\.grokbox)(\/|$)/.test(path)) report("private-artifact-path", path);
  if (/(^|\/)\.env(?:\..+)?$/.test(path) && !/(^|\/)\.env\.example$/.test(path)) report("environment-file", path);
  if (/\.(?:bundle|pem|key|sqlite|sqlite3|db|log|jsonl|ndjson)$/.test(path)) report("private-artifact-extension", path);
}
const rules = [
  ["personal-home-path", /\/(?:home|Users)\/(?!(?:box|user|fixture|example|test|alice|bob)(?=\/|[^a-z0-9_-]|$))[A-Za-z0-9._-]+/gi],
  ["local-checkout-or-evidence", /\/workspace\/(?:code|tmp|repos?)(?=\/|\b)/g],
  ["private-tailnet", /\btail[0-9a-f]{6,}\.ts\.net\b/gi],
  ["private-research-path", /\bgrok-bot\/docs(?:\/|[0-9])/g],
  ["personal-email", /\b[\w.+-]+@(?:qq\.com|163\.com|126\.com|gmail\.com|hotmail\.com|outlook\.com)\b/gi],
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
];
const uuid = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi;
function checkText(path, bytes, oid, commit = false) {
  stats.bytes += bytes.length;
  if (bytes.includes(0)) {
    stats.binaryBlobs++;
    report("binary-requires-explicit-review", path, 1, oid);
    return;
  }
  const text = bytes.toString("utf8");
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) report(rule, path, text.slice(0, match.index).split("\n").length, oid);
  }
  for (const match of text.matchAll(/https?:\/\/([a-z][a-z0-9-]*)(?::\d+)?(?=[/\s"'`])/gi)) {
    if (!["localhost", "host", "x"].includes(match[1])) report("single-label-private-endpoint", path, text.slice(0, match.index).split("\n").length, oid);
  }
  if (path.endsWith(".md") || commit) {
    for (const match of text.matchAll(uuid)) {
      const value = match[0].toLowerCase();
      if (!value.startsWith("00000000-") && new Set(value.replaceAll("-", "")).size > 5) report("non-synthetic-document-identity", path, text.slice(0, match.index).split("\n").length, oid);
    }
  }
  if (commit) {
    const header = text.split("\n\n", 1)[0];
    for (const match of header.matchAll(/^(?:author|committer) .+ <([^>]+)>/gm)) {
      if (!/(?:@users\.noreply\.github\.com|@[^@]+\.(?:invalid|test))$/i.test(match[1])) report("non-anonymized-commit-email", "@commit", 1, oid);
    }
  }
}
try {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, history: { type: "boolean" }, ref: { type: "string" }, "include-untracked": { type: "boolean" },
  }, strict: true, allowPositionals: false });
  root = realpathSync(values.root ?? process.cwd());
  if (values.ref && !values.history) throw new Error("ref_requires_history");
  if (values.history && values["include-untracked"]) throw new Error("untracked_requires_working_tree");
  if (values.history) {
    if (git(["rev-parse", "--is-shallow-repository"]).toString().trim() === "true") throw new Error("incomplete_shallow_history");
    const head = git(["rev-parse", "--verify", "--end-of-options", `${values.ref ?? "HEAD"}^{commit}`]).toString().trim();
    const entries = git(["rev-list", "--objects", head]).toString().trim().split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, "@object"] : [line.slice(0, space), line.slice(space + 1)];
    });
    const paths = new Set(git(["log", "--format=", "--name-only", "-z", head]).toString().split("\0").map((s) => s.replace(/^\n+/, "")).filter(Boolean));
    for (const [, path] of entries) if (path !== "@object") paths.add(path);
    for (const path of paths) checkPath(path);
    const data = git(["cat-file", "--batch"], Buffer.from(entries.map(([oid]) => oid).join("\n") + "\n"));
    let offset = 0;
    for (const [expected, path] of entries) {
      const end = data.indexOf(10, offset);
      const [oid, kind, sizeText] = data.subarray(offset, end).toString().split(" ");
      const size = Number(sizeText);
      if (end < offset || oid !== expected || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= data.length) throw new Error("incomplete_object_read");
      const bytes = data.subarray(end + 1, end + 1 + size);
      offset = end + size + 2;
      if (kind === "commit") { stats.commits++; checkText("@commit", bytes, oid, true); }
      if (kind === "blob") { stats.blobs++; checkText(path, bytes, oid); }
    }
    if (offset !== data.length) throw new Error("unexpected_object_data");
  } else {
    const paths = [...new Set(git(["ls-files", "-z", ...(values["include-untracked"] ? ["--cached", "--others", "--exclude-standard"] : [])]).toString().split("\0").filter(Boolean))];
    for (const path of paths) {
      checkPath(path);
      const absolute = resolve(root, path);
      if (!lstatSync(absolute).isFile()) { report("non-regular-tracked-file", path); continue; }
      stats.blobs++; checkText(path, readFileSync(absolute));
    }
  }
  console.log(JSON.stringify({ ok: findings.length === 0, mode: values.history ? "history" : "working-tree", includesUntracked: values["include-untracked"] === true, ...stats, findings }, null, 2));
  process.exitCode = findings.length ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "publication_scan_failed" }));
  process.exitCode = 2;
}
