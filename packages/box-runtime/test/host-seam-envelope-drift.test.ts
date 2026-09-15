import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  CONTRACT_SLICE_NAMES,
  parseContractGeneration,
} from "../src/internal/io/contracts.ts";
import { sanitizeEvent } from "../src/internal/io/journal.node.ts";
import { hostBundlesDir } from "../src/internal/io/paths.ts";
import {
  buildHostBundleDiff,
  hostBundlePatchImpact,
  observeHostBundles,
  parseHostBundleDiff,
  retainHostBundle,
} from "../src/internal/io/provenance.node.ts";
import {
  ENVELOPE_SLICE_COUNT,
  ENVELOPE_SLICE_IDS,
  ENVELOPE_WINDOWS_FILE,
  diffEnvelopeWindows,
  encodeEnvelopeWindows,
  admitWriteEnvelope,
  classifyWriteEnvelopeDrift,
  measureEnvelopeWindows,
  parseEnvelopeWindows,
  type EnvelopeWindows,
} from "../src/internal/ops/host-seam/envelope-windows.ts";
import { projectHostSeamStatus } from "../src/internal/ops/host-seam/seam-status.ts";
import { observeHostProvenance } from "../src/internal/ops/host-seam/observe.ts";
import { extractContractSlices, profileFromSource } from "../src/internal/host/profile.ts";
import { toyEnvelope } from "./envelope-toy-fixture.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const AT = "2026-01-01T00:00:00.000Z";
const AC5235 = "ac5235aa8258ecc923442244d15d2af68b7d7331fb94e8cad8f2ba1031197628";
const PREV_307DE = "307de3990394efc6b9a868537bab8504fceec3cc898cdd2ad91de68830f2f8dd";
const INSERTION_BYTES = 230;
const FOUR_WINDOW_GREEN = {
  previousSha: PREV_307DE,
  previousBytes: 29316802,
  currentBytes: 29453713,
  previousLines: 786001,
  currentLines: 789352,
  addedLines: 788189,
  removedLines: 784838,
  hunks: 1,
  driftedSlices: [] as string[],
  patchImpact: CONTRACT_SLICE_NAMES.map((slice) => ({ slice, status: "unchanged" as const, review: "none" as const })),
};

function hex64(ch: string): string {
  return ch.repeat(64);
}

async function loadAc5235Golden(): Promise<EnvelopeWindows> {
  const raw = await readFile(new URL("./fixtures/envelope-windows/ac5235aa8258.json", import.meta.url), "utf8");
  return parseEnvelopeWindows(JSON.parse(raw));
}

function flipSha(sha: string): string {
  const last = sha.endsWith("a") ? "b" : "a";
  return `${sha.slice(0, 63)}${last}`;
}

/** Prior golden: same 17 windows, compact-register + managed-step-error-scope shrunk 230B (same insertion). */
function syntheticPriorGolden(current: EnvelopeWindows): EnvelopeWindows {
  return {
    sourceSha: PREV_307DE,
    profileId: current.profileId,
    slices: current.slices.map((row) => {
      if (row.id !== "compact-register" && row.id !== "managed-step-error-scope") return row;
      return {
        ...row,
        windowSha: flipSha(row.windowSha),
        byteRange: { startByte: row.byteRange.startByte, endByte: row.byteRange.endByte - INSERTION_BYTES },
      };
    }),
  };
}

async function plantGeneration(root: string, input: {
  sha: string;
  at: string;
  envelope?: EnvelopeWindows;
  diff?: unknown;
}): Promise<void> {
  const dir = join(hostBundlesDir(root), "generations", input.sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify({
    sourceSha: input.sha, bytes: 1, observedAt: input.at,
  }, null, 2)}\n`);
  if (input.diff) await writeFile(join(dir, "diff.json"), `${JSON.stringify(input.diff, null, 2)}\n`);
  if (input.envelope) await writeFile(join(dir, ENVELOPE_WINDOWS_FILE), `${JSON.stringify(input.envelope, null, 2)}\n`);
}

describe("parallel envelopeDrift observation", () => {
  test("legacy driftedSlices lock still rejects envelope slice names", () => {
    expect(CONTRACT_SLICE_NAMES).toEqual(["create-session", "session-options", "agent-id", "prompt-session"]);
    expect(ENVELOPE_SLICE_COUNT).toBe(19);
    expect(ENVELOPE_SLICE_IDS).toContain("compact-register");
    expect(ENVELOPE_SLICE_IDS).toContain("managed-step-error-scope");
    expect(CONTRACT_SLICE_NAMES as readonly string[]).not.toContain("compact-register");

    expect(() => parseHostBundleDiff({
      ...FOUR_WINDOW_GREEN,
      driftedSlices: ["compact-register"],
    })).toThrow(/invalid host-bundle diff/);
    expect(() => parseHostBundleDiff({
      ...FOUR_WINDOW_GREEN,
      patchImpact: [...FOUR_WINDOW_GREEN.patchImpact, {
        slice: "compact-register", status: "drifted", review: "re-review",
      }],
    })).toThrow(/invalid host-bundle diff/);
    expect(() => parseContractGeneration({
      sourceSha: hex64("a"),
      bytes: 1,
      observedAt: AT,
      sliceHashes: Object.fromEntries(CONTRACT_SLICE_NAMES.map((name, i) => [name, hex64(String(i))])),
      driftedSlices: ["managed-step-error-scope"],
    })).toThrow(/invalid contract metadata/);

    const parsedGreen = parseHostBundleDiff(FOUR_WINDOW_GREEN);
    expect(parsedGreen.driftedSlices).toEqual([]);
    expect(parsedGreen.patchImpact.every((row) => row.status === "unchanged")).toBe(true);

    const sanitized = sanitizeEvent({
      name: "contracts_snapshot",
      at: AT,
      sha: hex64("a"),
      driftedSlices: ["create-session", "compact-register", "managed-step-error-scope"],
    });
    expect(sanitized?.driftedSlices).toEqual(["create-session"]);
  });

  test("ac5235 golden vs synthetic prior reports compact-register / managed-step-error-scope same insertion", async () => {
    const current = await loadAc5235Golden();
    expect(current.sourceSha).toBe(AC5235);
    expect(current.slices).toHaveLength(19);
    const compact = current.slices.find((row) => row.id === "compact-register");
    const step = current.slices.find((row) => row.id === "managed-step-error-scope");
    expect(compact?.byteRange.endByte).toBe(compact!.byteRange.startByte + 7173);
    expect(compact!.byteRange.startByte).toBeGreaterThan(step!.byteRange.startByte);
    expect(compact!.byteRange.endByte).toBeLessThan(step!.byteRange.endByte);

    const previous = syntheticPriorGolden(current);
    const drift = diffEnvelopeWindows(previous, current);
    expect(drift.evidenceKind).toBe("envelope-windows");
    expect(drift.compared).toBe(19);
    expect(drift.unchangedCount).toBe(17);
    expect(drift.missing).toEqual([]);
    expect(drift.appeared).toEqual([]);
    expect(drift.drifted.map((row) => row.id).sort()).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(drift.drifted.every((row) => row.byteDelta === INSERTION_BYTES)).toBe(true);
    expect(drift.drifted.every((row) => row.reasons.includes("windowSha") && row.reasons.includes("byteRange"))).toBe(true);
    expect(drift.insertionGroups).toEqual([{
      id: "compact-register+managed-step-error-scope",
      sliceIds: ["compact-register", "managed-step-error-scope"],
      kind: "overlapping-byte-range",
    }]);
    expect(drift.drifted.every((row) => row.insertionGroup === "compact-register+managed-step-error-scope")).toBe(true);
  });

  test("toy nested insertion: envelopeDrift sees the pair; four-window patchImpact stays unchanged", () => {
    const before = toyEnvelope("");
    const insertion = "settledMessageCount: initialMessages.length;".padEnd(INSERTION_BYTES, "x");
    expect(Buffer.byteLength(insertion, "utf8")).toBe(INSERTION_BYTES);
    const after = toyEnvelope(insertion);
    const previous = measureEnvelopeWindows(before.source, { ...before.profile, sourceSha256: sha256Text(before.source) });
    const current = measureEnvelopeWindows(after.source, { ...after.profile, sourceSha256: sha256Text(after.source) });
    const drift = diffEnvelopeWindows(previous, current);
    expect(drift.drifted.map((row) => row.id).sort()).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(drift.unchangedCount).toBe(17);
    expect(drift.insertionGroups[0]?.id).toBe("compact-register+managed-step-error-scope");

    const impact = hostBundlePatchImpact(before.source, after.source);
    expect(impact.map((row) => row.slice)).toEqual([...CONTRACT_SLICE_NAMES]);
    expect(impact.every((row) => row.status === "unchanged" && row.review === "none")).toBe(true);
    const rebuilt = buildHostBundleDiff(sha256Text(before.source), before.source, after.source);
    expect(rebuilt.driftedSlices).toEqual([]);
    expect(Object.keys(extractContractSlices(before.source)).sort()).toEqual([...CONTRACT_SLICE_NAMES].sort());
  });

  test("profile status projects envelopeDrift from retained goldens and does not write or heal", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-drift-"));
    const current = await loadAc5235Golden();
    const previous = syntheticPriorGolden(current);
    await plantGeneration(root, { sha: PREV_307DE, at: "2026-01-01T00:00:00.000Z", envelope: previous });
    await plantGeneration(root, {
      sha: AC5235,
      at: "2026-01-02T00:00:00.000Z",
      envelope: current,
      diff: FOUR_WINDOW_GREEN,
    });
    await mkdir(hostBundlesDir(root), { recursive: true });
    await writeFile(join(hostBundlesDir(root), "HEAD"), `${AC5235}\n`);

    const listTree = async () => (await readdir(hostBundlesDir(root), { recursive: true })).slice().sort();
    const before = await listTree();
    const status = await projectHostSeamStatus({ root });
    expect(status.adoptEligibility).toBe(false);
    expect(status.envelopeDrift.state).toBe("present");
    expect(status.envelopeDrift.evidenceKind).toBe("envelope-windows");
    expect(status.envelopeDrift.drifted.map((row) => row.id).sort()).toEqual([
      "compact-register",
      "managed-step-error-scope",
    ]);
    expect(status.envelopeDrift.insertionGroups[0]?.sliceIds).toEqual([
      "compact-register",
      "managed-step-error-scope",
    ]);
    expect(status.gaps).not.toContain("envelope_windows_missing");
    const bundles = await observeHostBundles(root);
    expect(bundles.generations.find((row) => row.sourceSha === AC5235)?.diff?.driftedSlices).toEqual([]);
    expect(await listTree()).toEqual(before);

    const missingRoot = await mkdtemp(join(tmpdir(), "grokbox-envelope-missing-"));
    const missing = await projectHostSeamStatus({ root: missingRoot });
    expect(missing.envelopeDrift.state).toBe("missing");
    expect(missing.envelopeDrift.drifted).toEqual([]);
    expect(missing.gaps).toContain("envelope_windows_missing");
    expect(missing.adoptEligibility).toBe(false);

    const injected = await projectHostSeamStatus({
      root: missingRoot,
      envelopeWindows: { previous, current },
    });
    expect(injected.envelopeDrift.drifted.map((row) => row.id).sort()).toEqual([
      "compact-register",
      "managed-step-error-scope",
    ]);
  });

  test("retain/observe without reviewed do not invent envelope-windows.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-nowrite-"));
    const sha = sha256Text(SYNTHETIC_HOST);
    await retainHostBundle({ root, source: SYNTHETIC_HOST, sourceSha: sha, observedAt: AT });
    const names = await readdir(join(hostBundlesDir(root), "generations", sha));
    expect(names).not.toContain(ENVELOPE_WINDOWS_FILE);
    await retainHostBundle({
      root, source: SYNTHETIC_HOST, sourceSha: sha, observedAt: AT, matchedProfileId: "reviewed",
      profile: profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "reviewed"),
    });
    expect(await readdir(join(hostBundlesDir(root), "generations", sha))).not.toContain(ENVELOPE_WINDOWS_FILE);
    const from = join(root, "host.cjs");
    await writeFile(from, SYNTHETIC_HOST);
    await observeHostProvenance({ root, from, now: () => AT });
    expect(await readdir(join(hostBundlesDir(root), "generations", sha))).not.toContain(ENVELOPE_WINDOWS_FILE);
    const watchdog = await readFile(new URL("../src/internal/process/watchdog.ts", import.meta.url), "utf8");
    expect(watchdog).not.toContain("envelopeDrift");
    expect(watchdog).not.toContain("envelope-windows");
  });

  test("retain with reviewed 19-slice profile writes envelope-windows.json stable under recompute", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-retain-"));
    const { source, profile } = toyEnvelope("");
    const sha = sha256Text(source);
    const first = await retainHostBundle({
      root, source, sourceSha: sha, observedAt: AT, matchedProfileId: profile.profileId, profile,
    });
    expect(first.retained).toBe("new");
    const path = join(hostBundlesDir(root), "generations", sha, ENVELOPE_WINDOWS_FILE);
    const body = await readFile(path, "utf8");
    const measured = measureEnvelopeWindows(source, profile);
    expect(measured.slices).toHaveLength(19);
    expect(body).toBe(encodeEnvelopeWindows(measured));
    expect(parseEnvelopeWindows(JSON.parse(body)).slices.map((row) => row.id).sort()).toEqual([...ENVELOPE_SLICE_IDS].sort());
    const second = await retainHostBundle({
      root, source, sourceSha: sha, observedAt: "2026-01-02T00:00:00.000Z", profile,
    });
    expect(second.retained).toBe("existing");
    expect(await readFile(path, "utf8")).toBe(body);
    expect(first.diff).toBeNull();
  });

  test("observe with durable reviewed.json writes envelope-windows.json; missing reviewed does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-observe-"));
    const { source, profile } = toyEnvelope("");
    const from = join(root, "host.cjs");
    await writeFile(from, source);
    const first = await observeHostProvenance({ root, from, now: () => AT });
    expect(await readdir(join(hostBundlesDir(root), "generations", first.observedSha))).not.toContain(ENVELOPE_WINDOWS_FILE);
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "profiles", "reviewed.json"), `${JSON.stringify(profile, null, 2)}\n`);
    const second = await observeHostProvenance({ root, from, now: () => "2026-01-01T00:00:01.000Z" });
    expect(second.retained).toBe("existing");
    const path = join(hostBundlesDir(root), "generations", second.observedSha, ENVELOPE_WINDOWS_FILE);
    const body = await readFile(path, "utf8");
    expect(body).toBe(encodeEnvelopeWindows(measureEnvelopeWindows(source, profile)));
    expect(parseEnvelopeWindows(JSON.parse(body)).slices).toHaveLength(19);
    const third = await observeHostProvenance({ root, from, profile, now: () => "2026-01-01T00:00:02.000Z" });
    expect(third.retained).toBe("existing");
    expect(await readFile(path, "utf8")).toBe(body);
  });

  test("new retain writes envelope-windows.json from previous-SHA reviewed recipe; status can compare", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-retain-prev-pin-"));
    const before = toyEnvelope("");
    const insertion = "settledMessageCount: initialMessages.length;".padEnd(INSERTION_BYTES, "x");
    const after = toyEnvelope(insertion);
    const prevSha = sha256Text(before.source);
    const nextSha = sha256Text(after.source);
    expect(prevSha).not.toBe(nextSha);

    const first = await retainHostBundle({
      root, source: before.source, sourceSha: prevSha, observedAt: AT,
      matchedProfileId: before.profile.profileId, profile: before.profile,
    });
    expect(first.retained).toBe("new");
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "profiles", "reviewed.json"), `${JSON.stringify(before.profile, null, 2)}\n`);

    const from = join(root, "next.cjs");
    await writeFile(from, after.source);
    const observed = await observeHostProvenance({ root, from, now: () => "2026-01-02T00:00:00.000Z" });
    expect(observed.retained).toBe("new");
    expect(observed.observedSha).toBe(nextSha);

    const path = join(hostBundlesDir(root), "generations", nextSha, ENVELOPE_WINDOWS_FILE);
    const body = await readFile(path, "utf8");
    const measured = measureEnvelopeWindows(after.source, before.profile);
    expect(measured.sourceSha).toBe(nextSha);
    expect(body).toBe(encodeEnvelopeWindows(measured));
    expect(parseEnvelopeWindows(JSON.parse(body)).slices).toHaveLength(19);

    const status = await projectHostSeamStatus({ root });
    expect(status.envelopeDrift.state).toBe("present");
    expect(status.envelopeDrift.compared).toBe(19);
    expect(status.envelopeDrift.evidenceKind).toBe("envelope-windows");
    expect(status.envelopeDrift.drifted.map((row) => row.id).sort()).toEqual([
      "compact-register",
      "managed-step-error-scope",
    ]);
    expect(status.gaps).not.toContain("envelope_windows_incomplete");
    expect(status.gaps).not.toContain("envelope_windows_missing");
    expect(status.gaps).not.toContain("envelope_windows_invalid");
  });
});

describe("write-gate envelope reject predicate", () => {
  test("byteRange-only and find.global-only are informational; windowSha/count/inWindow reject", () => {
    const { source, profile } = toyEnvelope("");
    const baseline = measureEnvelopeWindows(source, profile);
    const byteRangeOnly: EnvelopeWindows = {
      ...baseline,
      slices: baseline.slices.map((row, index) => ({
        ...row,
        byteRange: { startByte: row.byteRange.startByte + 10, endByte: row.byteRange.endByte + 10 + index },
      })),
    };
    const byteShift = classifyWriteEnvelopeDrift(baseline, byteRangeOnly);
    expect(byteShift.requiredIds).toEqual([]);
    expect(byteShift.rejecting).toEqual([]);
    expect(byteShift.informational).toHaveLength(19);
    expect(byteShift.informational.every((row) => row.infoReasons.includes("byteRange") && row.rejectReasons.length === 0)).toBe(true);

    const globalOnly: EnvelopeWindows = {
      ...baseline,
      slices: baseline.slices.map((row) => row.id === "create-session"
        ? { ...row, find: { ...row.find, global: row.find.global + 1 } }
        : row),
    };
    const global = classifyWriteEnvelopeDrift(baseline, globalOnly);
    expect(global.requiredIds).toEqual([]);
    expect(global.informational.map((row) => row.id)).toEqual(["create-session"]);
    expect(global.informational[0]?.infoReasons).toEqual(["find.global"]);

    const inWindow: EnvelopeWindows = {
      ...baseline,
      slices: baseline.slices.map((row) => row.id === "agent-id"
        ? { ...row, find: { ...row.find, inWindow: row.find.inWindow + 1 } }
        : row),
    };
    const windowFind = classifyWriteEnvelopeDrift(baseline, inWindow);
    expect(windowFind.requiredIds).toEqual(["agent-id"]);
    expect(windowFind.rejecting[0]?.rejectReasons).toEqual(["find.inWindow"]);

    const insertion = toyEnvelope("x".repeat(INSERTION_BYTES));
    const drifted = measureEnvelopeWindows(insertion.source, insertion.profile);
    const classified = classifyWriteEnvelopeDrift(baseline, drifted);
    expect(classified.requiredIds).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(classified.insertionGroups[0]?.sliceIds).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(classified.rejecting.every((row) => row.rejectReasons.includes("windowSha"))).toBe(true);
    expect(admitWriteEnvelope({
      pinSha: baseline.sourceSha,
      golden: baseline,
      candidate: drifted,
      sliceReview: [],
    }).ok).toBe(false);
    expect(admitWriteEnvelope({
      pinSha: baseline.sourceSha,
      golden: baseline,
      candidate: drifted,
      sliceReview: ["compact-register", "managed-step-error-scope"],
    }).ok).toBe(true);
    expect(admitWriteEnvelope({
      pinSha: baseline.sourceSha,
      golden: baseline,
      candidate: drifted,
      sliceReview: ["compact-register", "managed-step-error-scope", "agent-id"],
    }).ok).toBe(false);
    expect(admitWriteEnvelope({
      pinSha: baseline.sourceSha,
      golden: baseline,
      candidate: drifted,
      sliceReview: ["compact-register"],
    }).ok).toBe(false);
    expect(admitWriteEnvelope({
      pinSha: baseline.sourceSha,
      golden: baseline,
      candidate: byteRangeOnly,
      sliceReview: [],
    }).ok).toBe(true);
  });

  test("bootstrap allows first write; pin without golden refuses", () => {
    const { source, profile } = toyEnvelope("");
    const candidate = measureEnvelopeWindows(source, profile);
    expect(admitWriteEnvelope({ pinSha: null, golden: null, candidate, sliceReview: [] })).toMatchObject({
      ok: true, bootstrap: true,
    });
    expect(admitWriteEnvelope({
      pinSha: candidate.sourceSha, golden: null, candidate, sliceReview: [],
    })).toMatchObject({ ok: false, refusal: "missing_golden" });
    expect(admitWriteEnvelope({
      pinSha: candidate.sourceSha, golden: { ...candidate, sourceSha: hex64("c") }, candidate, sliceReview: [],
    })).toMatchObject({ ok: false, refusal: "missing_golden" });
  });
});
