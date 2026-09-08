import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReviewedProfileFromCopy } from "../src/h3-live.ts";
import { LIVE_SLICE_PATCHES } from "../src/live-slices.ts";
import { loadDurableReviewedProfile } from "../src/reviewed-profile.ts";
import { applyPatchProfile, type SlicePatch } from "../src/transform.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

function hash(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(source = SYNTHETIC_HOST) {
  const root = await fs.mkdtemp(join(tmpdir(), "grokbox-reviewed-"));
  const destDir = join(root, "profiles");
  const hostBundle = join(root, "synthetic-host.cjs");
  const profilePath = join(destDir, "reviewed.json");
  await fs.writeFile(hostBundle, source);
  const input = { destDir, hostBundle, slices: SYNTHETIC_SLICES, profileId: "old-good" };
  return { root, destDir, hostBundle, profilePath, input };
}

async function seeded() {
  const f = await fixture();
  await writeReviewedProfileFromCopy(f.input);
  return { ...f, previous: await fs.readFile(f.profilePath, "utf8") };
}

function staging(path: unknown, dir: string): path is string {
  return typeof path === "string" && path.startsWith(join(dir, ".reviewed-")) && path.endsWith(".tmp");
}

// Fixtures and failed staging are left in their unique disposable directories: no permanent cleanup.
describe("offline reviewed profile authoring", () => {
  test("recomputes both byte hashes, publishes protected JSON only, and never edits the source", async () => {
    const source = `\uFEFF${SYNTHETIC_HOST}\n// 合成 fixture\n`;
    const f = await fixture(source);
    await fs.mkdir(f.destDir, { mode: 0o755 });
    await fs.chmod(f.destDir, 0o755);
    const written = await writeReviewedProfileFromCopy(f.input);
    expect(written.profilePath).toBe(f.profilePath);
    expect(written).not.toHaveProperty("copyPath");
    expect(written.sourceSha256).toBe(hash(source));
    expect(written.diskSha).toBe(hash(Buffer.from(source)));
    const applied = applyPatchProfile(source, written.profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.code);
    expect(written.transformedSourceSha256).toBe(hash(applied.source));
    expect(written.transformedSourceSha256).not.toBe(written.sourceSha256);
    expect(loadDurableReviewedProfile(f.root)).toEqual(written.profile);
    expect(JSON.parse(await fs.readFile(f.profilePath, "utf8"))).toEqual(written.profile);
    expect(await fs.readFile(f.hostBundle, "utf8")).toBe(source);
    expect(await fs.readdir(f.destDir)).toEqual(["reviewed.json"]);
    expect((await fs.stat(f.destDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(f.profilePath)).mode & 0o777).toBe(0o600);
  });

  test("default slices accept the live-shaped synthetic fixture without reading a live Host", async () => {
    const f = await fixture(LIVE_SHAPED_HOST);
    const written = await writeReviewedProfileFromCopy({
      destDir: f.destDir, hostBundle: f.hostBundle, profileId: "reviewed-copy",
    });
    expect(written.profile.slices).toEqual(LIVE_SLICE_PATCHES);
    const applied = applyPatchProfile(LIVE_SHAPED_HOST, written.profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.code);
    expect(applied.source).toContain("agentId: host.getConversationId()");
    expect(applied.source).toContain("invocationId: inferenceRequestId");
    expect(applied.source).toContain("originalSession: __grokbox_session");
    expect(written.sourceSha256).toBe(hash(LIVE_SHAPED_HOST));
    expect(written.transformedSourceSha256).toBe(hash(applied.source));
    expect(await fs.readdir(f.destDir)).toEqual(["reviewed.json"]);
  });

  const badSlices: Array<[string, unknown]> = [
    ["empty", []],
    ["null", null],
    ["one", [SYNTHETIC_SLICES[0]]],
    ["three", [...SYNTHETIC_SLICES, SYNTHETIC_SLICES[0]]],
    ["duplicate ids", [SYNTHETIC_SLICES[0], SYNTHETIC_SLICES[0]]],
    ["wrong id", [{ ...SYNTHETIC_SLICES[0], id: "other" }, SYNTHETIC_SLICES[1]]],
    ["null slice", [null, SYNTHETIC_SLICES[1]]],
    ["empty anchor", [{ ...SYNTHETIC_SLICES[0], startAnchor: "" }, SYNTHETIC_SLICES[1]]],
    ["reversed anchors", [{ ...SYNTHETIC_SLICES[0], startAnchor: SYNTHETIC_SLICES[0]!.endAnchor,
      endAnchor: SYNTHETIC_SLICES[0]!.startAnchor }, SYNTHETIC_SLICES[1]]],
    ["empty replacement", [{ ...SYNTHETIC_SLICES[0], replacement: "" }, SYNTHETIC_SLICES[1]]],
    ["non-string find", [{ ...SYNTHETIC_SLICES[0], find: 1 }, SYNTHETIC_SLICES[1]]],
    ["extra field", [{ ...SYNTHETIC_SLICES[0], extra: "ignored?" }, SYNTHETIC_SLICES[1]]],
    ["no-op", [{ ...SYNTHETIC_SLICES[0], replacement: SYNTHETIC_SLICES[0]!.find }, SYNTHETIC_SLICES[1]]],
  ];
  test.each(badSlices)("refuses %s slices without changing the previous artifact", async (_name, slices) => {
    const f = await seeded();
    await expect(writeReviewedProfileFromCopy({ ...f.input, slices: slices as SlicePatch[] }))
      .rejects.toMatchObject({ code: "invalid_usage" });
    expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    expect(await fs.readdir(f.destDir)).toEqual(["reviewed.json"]);
  });

  test.each([
    ["missing anchor", SYNTHETIC_HOST.replace("function createSession(sessionOptions)", "function other()")],
    ["duplicate anchors", SYNTHETIC_HOST + SYNTHETIC_HOST],
    ["duplicate find", SYNTHETIC_HOST.replace("  return session;\n", "  return session;\n  return session;\n")],
    ["invalid UTF-8", Buffer.concat([Buffer.from(SYNTHETIC_HOST), Buffer.from([0xff])])],
  ])("refuses %s source without publishing", async (_name, source) => {
    const f = await seeded();
    await fs.writeFile(f.hostBundle, source);
    await expect(writeReviewedProfileFromCopy(f.input)).rejects.toMatchObject({ code: "invalid_usage" });
    expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    expect(await fs.readdir(f.destDir)).toEqual(["reviewed.json"]);
  });

  test("requires absolute paths, a bounded profile id and a regular source file", async () => {
    const f = await seeded();
    for (const input of [
      { ...f.input, hostBundle: "relative.cjs" },
      { ...f.input, destDir: "relative" },
      { ...f.input, hostBundle: f.root },
      { ...f.input, profileId: "" },
      { ...f.input, profileId: "x".repeat(129) },
      { ...f.input, profileId: "bad\nid" },
    ]) {
      await expect(writeReviewedProfileFromCopy(input)).rejects.toMatchObject({ code: "invalid_usage" });
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    }
  });

  test("rejects source=destination including lexical, symlink and hardlink aliases", async () => {
    const f = await seeded();
    const symlink = join(f.root, "source-symlink.cjs");
    const hardlink = join(f.root, "source-hardlink.cjs");
    await fs.symlink(f.profilePath, symlink);
    await fs.link(f.profilePath, hardlink);
    for (const hostBundle of [f.profilePath, `${f.destDir}/../profiles/reviewed.json`, symlink, hardlink]) {
      await expect(writeReviewedProfileFromCopy({ ...f.input, hostBundle })).rejects.toMatchObject({
        code: "invalid_usage", message: "Host bundle input must not be the reviewed artifact.",
      });
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    }
  });

  test("refuses a symlink destination without modifying its previous good target", async () => {
    const f = await seeded();
    const target = join(f.root, "previous-good.json");
    await fs.rename(f.profilePath, target);
    await fs.symlink(target, f.profilePath);
    await expect(writeReviewedProfileFromCopy(f.input)).rejects.toMatchObject({ code: "invalid_usage" });
    expect(await fs.readFile(target, "utf8")).toBe(f.previous);
    expect((await fs.lstat(f.profilePath)).isSymbolicLink()).toBe(true);
  });

  test.each([true, false])("partial staging (throws=%s) never replaces the good artifact", async (throws) => {
    const f = await seeded();
    const original = fs.writeFile;
    const spy = spyOn(fs, "writeFile").mockImplementation(async (path, body, options) => {
      if (staging(path, f.destDir)) {
        await original(path, String(body).slice(0, 12), options);
        if (throws) throw Object.assign(new Error("synthetic partial write"), { code: "EIO" });
        return;
      }
      await original(path, body, options);
    });
    try {
      await expect(writeReviewedProfileFromCopy({ ...f.input, profileId: "new" })).rejects.toThrow();
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
      expect(loadDurableReviewedProfile(f.root)?.profileId).toBe("old-good");
      const names = await fs.readdir(f.destDir);
      expect(names).not.toContain("host-main.copy.cjs");
      const temporary = names.filter((name) => name.startsWith(".reviewed-"));
      expect(temporary).toHaveLength(1);
      expect((await fs.stat(join(f.destDir, temporary[0]!))).mode & 0o777).toBe(0o600);
    } finally {
      spy.mockRestore();
    }
  });

  test("failed rename leaves the prior artifact and only protected unpublished staging", async () => {
    const f = await seeded();
    const original = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (staging(from, f.destDir)) throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
      await original(from, to);
    });
    try {
      await expect(writeReviewedProfileFromCopy(f.input)).rejects.toMatchObject({ code: "EIO" });
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
      expect(loadDurableReviewedProfile(f.root)?.profileId).toBe("old-good");
    } finally {
      spy.mockRestore();
    }
  });

  test("failed file sync does not publish or damage the previous artifact", async () => {
    const f = await seeded();
    const original = fs.open;
    const restores: Array<() => void> = [];
    const spy = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await original(path, flags, mode);
      if (staging(path, f.destDir)) {
        const sync = spyOn(handle, "sync").mockRejectedValue(new Error("synthetic sync failure"));
        restores.push(() => sync.mockRestore());
      }
      return handle;
    });
    try {
      await expect(writeReviewedProfileFromCopy(f.input)).rejects.toThrow("synthetic sync failure");
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    } finally {
      for (const restore of restores) restore();
      spy.mockRestore();
    }
  });

  test("source mutation during staging refuses publication", async () => {
    const f = await seeded();
    const original = fs.writeFile;
    const spy = spyOn(fs, "writeFile").mockImplementation(async (path, body, options) => {
      await original(path, body, options);
      if (staging(path, f.destDir)) await original(f.hostBundle, SYNTHETIC_HOST + "\n// concurrent edit\n");
    });
    try {
      await expect(writeReviewedProfileFromCopy(f.input)).rejects.toMatchObject({
        code: "invalid_usage", message: "Host bundle changed during authoring.",
      });
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
    } finally {
      spy.mockRestore();
    }
  });

  test("snapshots mutable caller slices before asynchronous IO", async () => {
    const f = await fixture();
    const slices = SYNTHETIC_SLICES.map((slice) => ({ ...slice }));
    const pending = writeReviewedProfileFromCopy({ ...f.input, slices });
    slices[0]!.replacement = "caller mutated after submit";
    const written = await pending;
    expect(written.profile.slices).toEqual(SYNTHETIC_SLICES);
    expect(loadDurableReviewedProfile(f.root)?.slices).toEqual(SYNTHETIC_SLICES);
  });

  test("concurrent writers use unique staging; readers see only complete committed artifacts", async () => {
    const f = await seeded();
    const sources = { "old-good": SYNTHETIC_HOST, a: SYNTHETIC_HOST + "\n// a", b: SYNTHETIC_HOST + "\n// b" };
    const aPath = join(f.root, "a.cjs");
    const bPath = join(f.root, "b.cjs");
    await fs.writeFile(aPath, sources.a);
    await fs.writeFile(bPath, sources.b);
    const bothStaged = deferred();
    const gates = { a: deferred(), b: deferred() };
    const stagedPaths = new Set<string>();
    const original = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (staging(from, f.destDir)) {
        const id = JSON.parse(await fs.readFile(from, "utf8")).profileId as "a" | "b";
        stagedPaths.add(from);
        if (stagedPaths.size === 2) bothStaged.resolve();
        await gates[id].promise;
      }
      await original(from, to);
    });
    const a = writeReviewedProfileFromCopy({ ...f.input, hostBundle: aPath, profileId: "a" });
    const b = writeReviewedProfileFromCopy({ ...f.input, hostBundle: bPath, profileId: "b" });
    let reading = true;
    const observed = new Set<string>();
    const reader = (async () => {
      while (reading) {
        const profile = loadDurableReviewedProfile(f.root);
        expect(profile).toBeDefined();
        const id = profile!.profileId as keyof typeof sources;
        expect(Object.keys(sources)).toContain(id);
        expect(profile!.sourceSha256).toBe(hash(sources[id]));
        expect(applyPatchProfile(sources[id], profile!).ok).toBe(true);
        observed.add(id);
        await Bun.sleep(1);
      }
    })();
    try {
      await bothStaged.promise;
      expect(stagedPaths.size).toBe(2);
      expect(await fs.readFile(f.profilePath, "utf8")).toBe(f.previous);
      gates.a.resolve();
      await a;
      expect(loadDurableReviewedProfile(f.root)?.profileId).toBe("a");
      await Bun.sleep(5);
      gates.b.resolve();
      await b;
      expect(loadDurableReviewedProfile(f.root)?.profileId).toBe("b");
      await Bun.sleep(5);
      expect([...observed].sort()).toEqual(["a", "b", "old-good"]);
      expect(await fs.readdir(f.destDir)).toEqual(["reviewed.json"]);
    } finally {
      gates.a.resolve(); gates.b.resolve();
      await Promise.allSettled([a, b]);
      reading = false;
      try {
        await reader;
      } finally {
        spy.mockRestore();
      }
    }
  });

  test("a failed concurrent writer cannot overwrite another writer's good result", async () => {
    const f = await seeded();
    const partial = deferred();
    const release = deferred();
    const original = fs.writeFile;
    const spy = spyOn(fs, "writeFile").mockImplementation(async (path, body, options) => {
      if (staging(path, f.destDir) && JSON.parse(String(body)).profileId === "fails") {
        await original(path, String(body).slice(0, 12), options);
        partial.resolve();
        await release.promise;
        throw Object.assign(new Error("synthetic late write failure"), { code: "EIO" });
      }
      await original(path, body, options);
    });
    const failed = writeReviewedProfileFromCopy({ ...f.input, profileId: "fails" }).then(
      () => ({ ok: true, error: undefined }),
      (error: unknown) => ({ ok: false, error }),
    );
    try {
      await partial.promise;
      const success = await writeReviewedProfileFromCopy({ ...f.input, profileId: "winner" });
      release.resolve();
      const outcome = await failed;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: "EIO" });
      expect(loadDurableReviewedProfile(f.root)).toEqual(success.profile);
    } finally {
      release.resolve();
      await failed;
      spy.mockRestore();
    }
  });

  test("does not delete or rewrite a pre-existing legacy full-copy artifact", async () => {
    const f = await seeded();
    const legacy = join(f.destDir, "host-main.copy.cjs");
    await fs.writeFile(legacy, "synthetic legacy artifact; owner decides cleanup");
    await writeReviewedProfileFromCopy(f.input);
    expect(await fs.readFile(legacy, "utf8")).toBe("synthetic legacy artifact; owner decides cleanup");
  });
});
