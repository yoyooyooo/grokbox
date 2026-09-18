import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scanner = fileURLToPath(new URL("../scripts/check-publication.mjs", import.meta.url));
function git(root: string, ...args: string[]) {
  const ran = spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (ran.status !== 0) throw new Error("fixture_git_failed");
  return ran.stdout.trim();
}
function fixture(body: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "publication-fixture-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function commit(root: string) { git(root, "add", "--all"); git(root, "commit", "-q", "-m", "fixture"); }
function scan(root: string, history = false, includeUntracked = false) {
  const ran = spawnSync(process.execPath, [scanner, "--root", root, ...(history ? ["--history", "--ref", "HEAD"] : []), ...(includeUntracked ? ["--include-untracked"] : [])], { encoding: "utf8", timeout: 20_000 });
  expect(ran.stderr).toBe("");
  return { status: ran.status, body: JSON.parse(ran.stdout), raw: ran.stdout };
}

test("publication guard preserves standard platform paths, public attribution, and synthetic identities", () => fixture((root) => {
  writeFileSync(join(root, "README.md"), "/home/box/sand-data/gateway.json\nhttps://provider.example.invalid/\n00000000-0000-4000-8000-000000000001\n");
  writeFileSync(join(root, "THIRD_PARTY_NOTICES"), "Public Maintainer <maintainer@upstream.example>\n");
  commit(root);
  expect(scan(root).status).toBe(0);
  const history = scan(root, true);
  expect(history.status).toBe(0);
  expect(history.body).toMatchObject({ commits: 1, blobs: 2, binaryBlobs: 0 });
}));

test("publication guard finds deleted historical evidence without printing matched values", () => fixture((root) => {
  const evidence = ["/workspace", "tmp", "private-receipt.md"].join("/");
  writeFileSync(join(root, "old.md"), evidence);
  commit(root);
  git(root, "rm", "old.md");
  writeFileSync(join(root, "README.md"), "public\n");
  commit(root);
  expect(scan(root).status).toBe(0);
  const history = scan(root, true);
  expect(history.status).toBe(1);
  expect(history.body.commits).toBe(2);
  expect(history.body.findings.some((x: { rule: string }) => x.rule === "local-checkout-or-evidence")).toBe(true);
  expect(history.raw).not.toContain(evidence);
}));

test("publication guard rejects private artifact paths and opaque binary inputs", () => fixture((root) => {
  mkdirSync(join(root, ".scratch"));
  writeFileSync(join(root, ".scratch", "receipt.md"), "fixture\n");
  writeFileSync(join(root, "opaque.bin"), Buffer.from([0, 1, 2, 3]));
  commit(root);
  const result = scan(root, true);
  expect(result.status).toBe(1);
  expect(result.body.findings.map((x: { rule: string }) => x.rule)).toContain("private-artifact-path");
  expect(result.body.binaryBlobs).toBe(1);
}));

test("publication guard rejects private endpoints and non-anonymized commit metadata", () => fixture((root) => {
  const endpoint = "https://fixture." + "tail" + "abcdef" + ".ts.net/";
  writeFileSync(join(root, "README.md"), endpoint);
  git(root, "config", "user.email", "fixture@private.example");
  commit(root);
  const result = scan(root, true);
  expect(result.status).toBe(1);
  const rules = result.body.findings.map((x: { rule: string }) => x.rule);
  expect(rules).toContain("private-tailnet");
  expect(rules).toContain("non-anonymized-commit-email");
  expect(result.raw).not.toContain(endpoint);
  expect(result.raw).not.toContain("fixture@private.example");
}));

test("untracked source is scanned explicitly without changing the Git index", () => fixture((root) => {
  writeFileSync(join(root, "README.md"), "public\n"); commit(root);
  const before = git(root, "status", "--porcelain");
  const endpoint = "https://fixture." + "tail" + "abcdef" + ".ts.net/";
  writeFileSync(join(root, "new.md"), endpoint);
  expect(scan(root).status).toBe(0);
  const result = scan(root, false, true);
  expect(result.status).toBe(1); expect(result.body).toMatchObject({ includesUntracked: true, blobs: 2 });
  expect(result.raw).not.toContain(endpoint);
  expect(git(root, "diff", "--cached", "--name-only")).toBe("");
  expect(git(root, "status", "--porcelain")).toBe("?? new.md"); expect(before).toBe("");
}));

test("publication guard fails closed for a missing history revision", () => fixture((root) => {
  const result = scan(root, true);
  expect(result.status).toBe(2);
  expect(result.body.ok).toBe(false);
}));
