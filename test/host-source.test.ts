import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileObserveThenWriteNext } from "@grokbox/box-runtime/runtime";
import {
  classifySourceMatch,
  LIVE_HOST_BUNDLE_PATH,
  overlaySourceMatch,
  profileWriteNext,
  readLiveShaFromPath,
  readProfileShaFromRoot,
  shaPrefix,
} from "../packages/cli/src/host-source.ts";
import { operatorNext } from "../packages/cli/src/commands/operator.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const OBSERVE_ONLY = `grokbox runtime profile observe --from ${LIVE_HOST_BUNDLE_PATH}`;
const WRITE_A = `${OBSERVE_ONLY} then grokbox runtime profile write --sha ${A}`;

test("classifySourceMatch distinguishes match, mismatch, and unavailable", () => {
  expect(classifySourceMatch(A, A)).toBe("match");
  expect(classifySourceMatch(A, B)).toBe("mismatch");
  expect(classifySourceMatch(null, A)).toBe("unavailable");
  expect(classifySourceMatch(A, null)).toBe("unavailable");
  expect(classifySourceMatch("not-a-digest", A)).toBe("unavailable");
  expect(shaPrefix(A)).toBe("a".repeat(12));
  expect(shaPrefix(null)).toBeUndefined();
});

test("source mismatch overlay wins over official, custom, and stale_attestation", () => {
  expect(overlaySourceMatch({ host: "official", hostReason: null }, "mismatch"))
    .toEqual({ host: "unknown", hostReason: "source_mismatch" });
  expect(overlaySourceMatch({ host: "custom", hostReason: null }, "mismatch"))
    .toEqual({ host: "unknown", hostReason: "source_mismatch" });
  expect(overlaySourceMatch({ host: "unknown", hostReason: "stale_attestation" }, "mismatch"))
    .toEqual({ host: "unknown", hostReason: "source_mismatch" });
  expect(overlaySourceMatch({ host: "official", hostReason: null }, "match"))
    .toEqual({ host: "official", hostReason: null });
  expect(overlaySourceMatch({ host: "official", hostReason: null }, "unavailable"))
    .toEqual({ host: "official", hostReason: null });
});

test("observe then write next embeds a known full live SHA and never a placeholder", () => {
  expect(profileWriteNext(A)).toBe(WRITE_A);
  expect(profileWriteNext(A)).toContain(A);
  expect(profileWriteNext(A)).not.toContain("<sourceSha256>");
  expect(profileObserveThenWriteNext(LIVE_HOST_BUNDLE_PATH, A)).toBe(WRITE_A);
  expect(operatorNext({ daemon: "up", host: "unknown", hostReason: "source_mismatch", liveSha: A }))
    .toBe(WRITE_A);
  expect(operatorNext({ daemon: "down", host: "unknown", hostReason: "source_mismatch", liveSha: A }))
    .toBe(WRITE_A);
  expect(WRITE_A).toContain("runtime profile observe --from /home/box/sand-host/host-main.cjs");
  expect(WRITE_A).not.toContain("profile write --from /home/box/sand-host/host-main.cjs");
});

test("observe then write next is observe-only when the live SHA is unknown", () => {
  expect(profileWriteNext()).toBe(OBSERVE_ONLY);
  expect(profileWriteNext(null)).toBe(OBSERVE_ONLY);
  expect(profileWriteNext("<sourceSha256>")).toBe(OBSERVE_ONLY);
  expect(profileWriteNext("a".repeat(12))).toBe(OBSERVE_ONLY);
  expect(profileObserveThenWriteNext(LIVE_HOST_BUNDLE_PATH)).toBe(OBSERVE_ONLY);
  expect(operatorNext({ daemon: "up", host: "unknown", hostReason: "source_mismatch" }))
    .toBe(OBSERVE_ONLY);
  expect(operatorNext({ daemon: "down", host: "unknown", hostReason: "source_mismatch" }))
    .toBe(OBSERVE_ONLY);
  expect(OBSERVE_ONLY).not.toContain("write --sha");
  expect(OBSERVE_ONLY).not.toContain("<sourceSha256>");
});

test("default SHA readers use temp Host bytes and reviewed.json, not the live bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-host-source-"));
  const hostPath = join(dir, "host-main.cjs");
  await writeFile(hostPath, "fixture-host-bytes\n");
  await mkdir(join(dir, "profiles"), { recursive: true });
  const liveSha = await readLiveShaFromPath(hostPath);
  expect(liveSha).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  await writeFile(join(dir, "profiles", "reviewed.json"), JSON.stringify({ sourceSha256: liveSha }));
  expect(await readProfileShaFromRoot(dir)).toBe(liveSha);
  await writeFile(join(dir, "profiles", "reviewed.json"), JSON.stringify({ sourceSha256: B }));
  expect(classifySourceMatch(liveSha, await readProfileShaFromRoot(dir))).toBe("mismatch");
  expect(await readLiveShaFromPath(join(dir, "missing.cjs"))).toBeNull();
});
