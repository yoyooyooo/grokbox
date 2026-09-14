import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySourceMatch,
  overlaySourceMatch,
  PROFILE_WRITE_NEXT,
  readLiveShaFromPath,
  readProfileShaFromRoot,
  shaPrefix,
} from "../packages/cli/src/host-source.ts";
import { operatorNext } from "../packages/cli/src/commands/operator.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

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
  expect(operatorNext({ daemon: "up", host: "unknown", hostReason: "source_mismatch" }))
    .toBe(PROFILE_WRITE_NEXT);
  expect(operatorNext({ daemon: "down", host: "unknown", hostReason: "source_mismatch" }))
    .toBe(PROFILE_WRITE_NEXT);
  expect(PROFILE_WRITE_NEXT).toContain("runtime profile observe --from /home/box/sand-host/host-main.cjs");
  expect(PROFILE_WRITE_NEXT).toContain("runtime profile write --sha <sourceSha256>");
  expect(PROFILE_WRITE_NEXT).not.toContain("profile write --from /home/box/sand-host/host-main.cjs");
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
