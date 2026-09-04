import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareReleaseVersions, parseReleaseVersion, tagForVersion } from "../scripts/release.ts";

const repoRoot = join(import.meta.dir, "..");
const bun = Bun.which("bun") ?? process.execPath;

async function output(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function run(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([output(child.stdout), output(child.stderr), child.exited]);
  return { code, stdout, stderr };
}

function trashRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), ".Trash")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
}

describe("release version contract", () => {
  test("maps prereleases to next", () => {
    expect(parseReleaseVersion("0.1.0-alpha.2")).toEqual({
      version: "0.1.0-alpha.2",
      prerelease: true,
      distTag: "next",
    });
    expect(tagForVersion("0.1.0-alpha.2")).toBe("v0.1.0-alpha.2");
  });

  test("maps stable versions to latest", () => {
    expect(parseReleaseVersion("1.0.0")).toEqual({
      version: "1.0.0",
      prerelease: false,
      distTag: "latest",
    });
  });

  test("accepts and orders SemVer identifiers without precision or locale drift", () => {
    expect(parseReleaseVersion("1.0.0-1alpha").distTag).toBe("next");
    expect(parseReleaseVersion("1.0.0-01alpha.0").prerelease).toBe(true);
    expect(compareReleaseVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.0-alpha.100000000000000000000", "1.0.0-alpha.99999999999999999999")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.0-B", "1.0.0-a")).toBeLessThan(0);
  });

  test.each(["v1.0.0", "1.0", "01.0.0", "1.0.0+build", "1.0.0-alpha..1"])(
    "rejects unsupported release version %s",
    (version) => {
      expect(() => parseReleaseVersion(version)).toThrow();
    },
  );

  test("publish workflow keeps the OIDC and post-publish evidence ordering", async () => {
    const workflow = await readFile(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6");
    expect(workflow).toContain("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("group: npm-publish");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("Refusing to move npm channel backward");
    expect(workflow).toContain('npm_dist_tag=next');
    expect(workflow).toContain('npm_dist_tag=latest');
    expect(workflow).toContain('npm publish --access public --provenance --tag "${NPM_DIST_TAG}"');
    expect(workflow).toContain("Manual dispatch is repair-only");
    expect(workflow).toContain('"$integrity" == "$LOCAL_INTEGRITY"');
    expect(workflow).toContain("Provenance commit does not match the release tag");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow.indexOf("Verify npm package, channel, and provenance"))
      .toBeLessThan(workflow.indexOf("Create GitHub Release after npm verification"));
  });

  test("prechecks exact origin/main, pushes one tag, and refuses to move it", async () => {
    await mkdir(trashRoot(), { recursive: true });
    const fixture = await mkdtemp(join(trashRoot(), "grokbox-release-test-"));
    const remote = join(fixture, "remote.git");
    const work = join(fixture, "work");
    await mkdir(work);
    expect((await run(["git", "init", "--bare", remote], fixture)).code).toBe(0);
    expect((await run(["git", "init", "-b", "main"], work)).code).toBe(0);
    expect((await run(["git", "config", "user.name", "Release Test"], work)).code).toBe(0);
    expect((await run(["git", "config", "user.email", "release@example.invalid"], work)).code).toBe(0);

    await mkdir(join(work, "scripts"));
    await copyFile(join(repoRoot, "scripts", "release.ts"), join(work, "scripts", "release.ts"));
    await writeFile(join(work, "package.json"), JSON.stringify({
      name: "grokbox",
      version: "0.1.0-alpha.2",
      type: "module",
      scripts: { check: "printf checked" },
    }, null, 2) + "\n");
    const fakeBin = join(work, "fake-bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "npm"), "#!/bin/sh\necho 'npm ERR! code E404' >&2\nexit 1\n");
    await chmod(join(fakeBin, "npm"), 0o755);

    expect((await run(["git", "add", "."], work)).code).toBe(0);
    expect((await run(["git", "commit", "-m", "release state"], work)).code).toBe(0);
    expect((await run(["git", "remote", "add", "origin", remote], work)).code).toBe(0);
    expect((await run(["git", "push", "-u", "origin", "main"], work)).code).toBe(0);

    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
    const precheck = await run([bun, "scripts/release.ts", "--precheck", "0.1.0-alpha.2"], work, env);
    expect(precheck.code, precheck.stderr).toBe(0);
    expect(precheck.stdout).toContain("npm dist-tag: next");
    expect((await run(["git", "tag", "--list"], work)).stdout.trim()).toBe("");

    const release = await run([bun, "scripts/release.ts", "0.1.0-alpha.2"], work, env);
    expect(release.code, release.stderr).toBe(0);
    expect((await run(["git", "ls-remote", "--tags", "origin", "refs/tags/v0.1.0-alpha.2"], work)).stdout)
      .toContain("refs/tags/v0.1.0-alpha.2");

    const repeated = await run([bun, "scripts/release.ts", "0.1.0-alpha.2"], work, env);
    expect(repeated.code).not.toBe(0);
    expect(repeated.stderr).toContain("Tags are immutable");
  }, 20_000);
});
