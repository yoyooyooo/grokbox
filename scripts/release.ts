#!/usr/bin/env -S bun
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const EXPECTED_PACKAGE = "grokbox";
const REGISTRY = "https://registry.npmjs.org";

type Options = { precheck: boolean; version: string };
type CommandResult = { exitCode: number; stdout: string; stderr: string };

export function parseReleaseVersion(value: string): { version: string; prerelease: boolean; distTag: "next" | "latest" } {
  const match = value.match(VERSION_PATTERN);
  if (match === null) {
    throw new Error(`Expected an exact semver x.y.z or x.y.z-prerelease without build metadata. Got: ${value}`);
  }
  const prerelease = match[4] !== undefined;
  return { version: value, prerelease, distTag: prerelease ? "next" : "latest" };
}

export function tagForVersion(version: string): string {
  return `v${parseReleaseVersion(version).version}`;
}

export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => {
    parseReleaseVersion(value);
    const match = value.match(VERSION_PATTERN)!;
    return {
      core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const l = parse(left);
  const r = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (l.core[index] !== r.core[index]) return l.core[index]! < r.core[index]! ? -1 : 1;
  }
  if (l.prerelease.length === 0) return r.prerelease.length === 0 ? 0 : 1;
  if (r.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(l.prerelease.length, r.prerelease.length); index += 1) {
    const a = l.prerelease[index];
    const b = r.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return a.length === b.length ? (a < b ? -1 : 1) : a.length - b.length;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const release = parseReleaseVersion(options.version);
    const tag = tagForVersion(release.version);

    assertReleaseBase();
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name !== EXPECTED_PACKAGE) {
      fail(`Expected package name ${EXPECTED_PACKAGE}; got ${String(packageJson.name)}.`);
    }
    if (packageJson.version !== release.version) {
      fail(`package.json version must equal requested release. file=${String(packageJson.version)} requested=${release.version}`);
    }
    assertTagAbsent(tag);
    assertNpmVersionAbsent(release.version, release.distTag);
    run("bun", ["run", "check"]);

    const head = run("git", ["rev-parse", "HEAD"], { quiet: true });
    console.log(`Release ${options.precheck ? "precheck passed" : "ready"}:
  package: ${EXPECTED_PACKAGE}@${release.version}
  commit: ${head}
  tag: ${tag}
  npm dist-tag: ${release.distTag}
  source: ${REMOTE}/${DEFAULT_BRANCH}
  pushed tags are immutable
`);

    if (options.precheck) return;

    run("git", ["tag", "-a", tag, "-m", `${EXPECTED_PACKAGE} ${tag}`]);
    run("git", ["push", REMOTE, `refs/tags/${tag}`]);
    console.log(`${tag} pushed. GitHub Actions now owns npm publication and GitHub Release creation.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): Options {
  let precheck = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--precheck") precheck = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) fail(`Expected exactly one version.\n\n${usage()}`);
  return { precheck, version: positional[0]! };
}

function usage(): string {
  return `Usage:
  bun run release:precheck -- <x.y.z|x.y.z-prerelease>
  bun run release -- <x.y.z|x.y.z-prerelease>

The manifest version must already be committed at the exact origin/main commit.
The command never publishes from this machine; it creates and pushes one annotated tag.`;
}

function assertReleaseBase(): void {
  run("git", ["rev-parse", "--is-inside-work-tree"], { quiet: true });
  const status = run("git", ["status", "--porcelain"], { quiet: true });
  if (status.length > 0) fail("Working tree is not clean. Commit the release state before tagging.");
  const branch = run("git", ["branch", "--show-current"], { quiet: true });
  if (branch !== DEFAULT_BRANCH) fail(`Release must run on ${DEFAULT_BRANCH}. Current branch: ${branch || "detached HEAD"}.`);
  run("git", ["remote", "get-url", REMOTE], { quiet: true });
  run("git", ["fetch", REMOTE, DEFAULT_BRANCH, "--tags"]);
  const head = run("git", ["rev-parse", "HEAD"], { quiet: true });
  const remoteHead = run("git", ["rev-parse", `${REMOTE}/${DEFAULT_BRANCH}`], { quiet: true });
  if (head !== remoteHead) {
    fail(`HEAD must equal ${REMOTE}/${DEFAULT_BRANCH}. head=${head} remote=${remoteHead}`);
  }
}

function assertTagAbsent(tag: string): void {
  const local = exec("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], false);
  if (local.exitCode === 0) fail(`Tag already exists: ${tag}. Tags are immutable; choose a new version.`);
  if (local.exitCode !== 1) fail(`Unable to inspect local tag ${tag}.`);

  const remote = exec("git", ["ls-remote", "--exit-code", "--tags", REMOTE, `refs/tags/${tag}`], false);
  if (remote.exitCode === 0) fail(`Remote tag already exists: ${tag}. Tags are immutable; choose a new version.`);
  if (remote.exitCode !== 2) {
    fail(`Unable to inspect remote tag ${tag}.\n${remote.stderr || remote.stdout}`);
  }
}

function assertNpmVersionAbsent(version: string, distTag: "next" | "latest"): void {
  const result = exec("npm", ["view", `${EXPECTED_PACKAGE}@${version}`, "version", "--registry", REGISTRY], false);
  if (result.exitCode === 0) {
    fail(`${EXPECTED_PACKAGE}@${version} already exists on npm. Published versions are immutable; choose a new version.`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/E404|404 Not Found|is not in this registry/i.test(output)) {
    fail(`Unable to prove ${EXPECTED_PACKAGE}@${version} is absent from npm.\n${output.trim()}`);
  }

  const channel = exec("npm", ["view", `${EXPECTED_PACKAGE}@${distTag}`, "version", "--registry", REGISTRY], false);
  if (channel.exitCode === 0) {
    const current = channel.stdout.trim();
    if (compareReleaseVersions(version, current) <= 0) {
      fail(`Refusing to move npm ${distTag} backward: requested=${version} current=${current}`);
    }
    return;
  }
  const channelOutput = `${channel.stdout}\n${channel.stderr}`;
  if (!/E404|404 Not Found|is not in this registry/i.test(channelOutput)) {
    fail(`Unable to read npm ${distTag} channel.\n${channelOutput.trim()}`);
  }
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  const result = exec(command, args, options.quiet !== true);
  if (result.exitCode !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    fail(`Command failed: ${formatCommand([command, ...args])}${output ? `\n${output}` : ""}`);
  }
  return result.stdout.trim();
}

function exec(command: string, args: string[], log: boolean): CommandResult {
  if (log) console.log(`$ ${formatCommand([command, ...args])}`);
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function formatCommand(parts: string[]): string {
  return parts.map((part) => (/^[A-Za-z0-9_/:=.,@+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}

function fail(message: string): never {
  throw new Error(message);
}

if (import.meta.main) main();
