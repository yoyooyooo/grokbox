import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { acquireAdvisoryGate } from "../src/internal/io/advisory-gate.node.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { ENVELOPE_WINDOWS_FILE, encodeEnvelopeWindows, measureEnvelopeWindows } from "../src/internal/ops/host-seam/envelope-windows.ts";
import { hostBundlesDir, retainedGenerationSourcePath } from "../src/internal/io/paths.ts";
import { retainHostBundle } from "../src/internal/io/provenance.node.ts";
import {
  ProfileWriteRefused,
  inspectRetainedWriteEnvelope,
  profileWriteExecutableNext,
  writeReviewedProfileFromCopy,
} from "../src/internal/process/profile.node.ts";
import { toyEnvelope } from "./envelope-toy-fixture.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { CONTEXT_SLICE_IDS, profileFromSource } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const AT = "2026-01-01T00:00:00.000Z";

async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-write-lineage-"));
  const destDir = join(root, "profiles");
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  return { root, destDir };
}

async function writeHost(root: string, source: string, name = "host.cjs"): Promise<string> {
  const path = join(root, name);
  await writeFile(path, source);
  return path;
}

async function refreshFixture(changedWindow = false) {
  const f = await rootFixture(), before = toyEnvelope("");
  const afterSource = changedWindow ? toyEnvelope("settledMessageCount:y").source : before.source + "\n// unrelated update\n";
  const beforeSha = sha256Text(before.source), afterSha = sha256Text(afterSource);
  await retainHostBundle({ root:f.root, source:before.source, sourceSha:beforeSha, observedAt:AT, profile:before.profile, matchedProfileId:before.profile.profileId });
  await writeReviewedProfileFromCopy({ destDir:f.destDir, hostBundle:retainedGenerationSourcePath(f.root,beforeSha), slices:before.profile.slices });
  await retainHostBundle({ root:f.root, source:afterSource, sourceSha:afterSha, observedAt:AT });
  const profilePath=join(f.destDir,"reviewed.json"), original=await readFile(profilePath,"utf8");
  return {...f,before,afterSource,beforeSha,afterSha,profilePath,original,input:{destDir:f.destDir,hostBundle:retainedGenerationSourcePath(f.root,afterSha),
    refreshReviewed:true,expectedReviewedSha:sha256Text(original),lineage:{root:f.root,retainedSha:afterSha}}};
}

test("source refresh preserves all approved slices in one publication, without a same-source baseline or core-only intermediate",async()=>{
 const f=await refreshFixture();try{
  await expect(writeReviewedProfileFromCopy({...f.input,expectedReviewedSha:"f".repeat(64)})).rejects.toMatchObject({refusal:"refresh_baseline_changed"});
  await expect(writeReviewedProfileFromCopy({...f.input,slices:f.before.profile.slices})).rejects.toBeDefined();
  expect(await readFile(f.profilePath,"utf8")).toBe(f.original);
  const result=await writeReviewedProfileFromCopy(f.input);
  expect(result.profile.sourceSha256).toBe(f.afterSha);expect(result.profile.slices).toEqual(f.before.profile.slices);
  expect(result.sourceRefresh).toEqual({baselineProfileSha256:sha256Text(f.original),previousSourceSha256:f.beforeSha,preservedIds:f.before.profile.slices.map(s=>s.id),reboundIds:[]});
  expect(result.envelope?.rejectingIds).toEqual([]);expect(result.capabilityUpgrade).toBeUndefined();
  expect(await readFile(retainedGenerationSourcePath(f.root,f.beforeSha),"utf8")).toBe(f.before.source);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("source refresh keeps exact envelope review and refuses unqualified native capability reuse",async()=>{
 const f=await refreshFixture(true);try{
  const rejected=await writeReviewedProfileFromCopy(f.input).then(()=>null,e=>e as ProfileWriteRefused);
  expect(rejected?.refusal).toBe("envelope_drift");expect(rejected?.next).toContain("--refresh-reviewed");
  expect(await readFile(f.profilePath,"utf8")).toBe(f.original);
  const ids=rejected!.details.requiredIds as string[];
  await expect(writeReviewedProfileFromCopy({...f.input,lineage:{...f.input.lineage,sliceReview:[...ids,"agent-id"]}})).rejects.toMatchObject({refusal:"envelope_drift"});
  const result=await writeReviewedProfileFromCopy({...f.input,lineage:{...f.input.lineage,sliceReview:ids}});
  expect(result.profile.slices).toEqual(f.before.profile.slices);
  const native={...JSON.parse(f.original),slices:f.before.profile.slices.map((s,i)=>i===2?{...s,id:"continuity-native-worker-handshake"}:s)};
  const body=JSON.stringify(native);await writeFile(f.profilePath,body,{mode:0o600});
  await expect(writeReviewedProfileFromCopy({...f.input,expectedReviewedSha:sha256Text(body)})).rejects.toMatchObject({refusal:"source_pair_unqualified"});
  expect(await readFile(f.profilePath,"utf8")).toBe(body);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("source refresh rechecks the same approved bytes under the publication gate and never overwrites a later writer",async()=>{
 const f=await refreshFixture();let gate:Awaited<ReturnType<typeof acquireAdvisoryGate>> = null;
 try{
  gate=await acquireAdvisoryGate(join(f.root,"state","profile-publication.gate"),2000);if(!gate)throw Error("fixture_gate");
  const pending=writeReviewedProfileFromCopy(f.input).then(()=>null,e=>e as ProfileWriteRefused);
  const end=performance.now()+1200;
  while(!(await readdir(f.destDir)).some(name=>name.startsWith(".reviewed-"))){if(performance.now()>end)throw Error("fixture_staging_missing");await new Promise(r=>setTimeout(r,5));}
  const newer=JSON.stringify({...JSON.parse(f.original),profileId:"later-reviewed-writer"});await writeFile(f.profilePath,newer,{mode:0o600});
  await gate.release();gate=null;
  expect((await pending)?.refusal).toBe("refresh_baseline_changed");expect(await readFile(f.profilePath,"utf8")).toBe(newer);
 }finally{await gate?.release();await rm(f.root,{recursive:true,force:true});}
},6000);

describe("reviewed profile write retained bind + envelope reject-on-drift", () => {
  test("context recipe upgrade: analyzer and writer agree, exact new slice review works and incomplete/superset reviews refuse", async () => {
    const { root, destDir } = await rootFixture();
    const source = LIVE_SHAPED_HOST, sha = sha256Text(source);
    const legacy = LIVE_SLICE_PATCHES.filter(slice => !(CONTEXT_SLICE_IDS as readonly string[]).includes(slice.id));
    const before = profileFromSource(source, legacy, "pre-context");
    await retainHostBundle({ root, source, sourceSha: sha, observedAt: AT, profile: before, matchedProfileId: before.profileId });
    await writeReviewedProfileFromCopy({ destDir, hostBundle: retainedGenerationSourcePath(root, sha), slices: legacy, profileId: before.profileId });
    const original = await readFile(join(destDir, "reviewed.json"), "utf8");
    const inspect = await inspectRetainedWriteEnvelope(root, sha);
    expect(inspect.refusal).toBe("envelope_drift");
    expect(new Set(inspect.requiredIds)).toEqual(new Set(CONTEXT_SLICE_IDS));
    const input = { destDir, hostBundle: retainedGenerationSourcePath(root, sha), lineage: { root, retainedSha: sha } };
    await expect(writeReviewedProfileFromCopy(input)).rejects.toMatchObject({ refusal: "envelope_drift", details: { requiredIds: inspect.requiredIds } });
    await expect(writeReviewedProfileFromCopy({ ...input, lineage: { ...input.lineage, sliceReview: inspect.requiredIds.slice(1) } })).rejects.toMatchObject({ refusal: "envelope_drift" });
    await expect(writeReviewedProfileFromCopy({ ...input, lineage: { ...input.lineage, sliceReview: [...inspect.requiredIds, "create-session"] } })).rejects.toMatchObject({ refusal: "envelope_drift" });
    expect(await readFile(join(destDir, "reviewed.json"), "utf8")).toBe(original);
    const written = await writeReviewedProfileFromCopy({ ...input, lineage: { ...input.lineage, sliceReview: inspect.requiredIds } });
    expect(written.envelope?.sliceReview).toEqual(inspect.requiredIds);
    expect(written.profile.slices.filter(slice => (CONTEXT_SLICE_IDS as readonly string[]).includes(slice.id))).toHaveLength(CONTEXT_SLICE_IDS.length);
    expect(await readFile(retainedGenerationSourcePath(root, sha), "utf8")).toBe(source);
  });

  test("without lineage still authors from an arbitrary path (library test helper)", async () => {
    const { destDir } = await rootFixture();
    const { source, profile } = toyEnvelope("");
    const hostBundle = await writeHost(destDir, source);
    const written = await writeReviewedProfileFromCopy({
      destDir, hostBundle, slices: profile.slices, profileId: profile.profileId,
    });
    expect(written.unretained_source).toBeUndefined();
    expect(written.envelope).toBeUndefined();
    expect(written.sourceSha256).toBe(sha256Text(source));
  });

  test("bootstrap first write from retained SHA does not require golden or slice-review", async () => {
    const { root, destDir } = await rootFixture();
    const { source, profile } = toyEnvelope("");
    const sha = sha256Text(source);
    await retainHostBundle({
      root, source, sourceSha: sha, observedAt: AT, profile, matchedProfileId: profile.profileId,
    });
    const written = await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, sha),
      slices: profile.slices,
      profileId: profile.profileId,
      lineage: { root, retainedSha: sha },
    });
    expect(written.unretained_source).toBeUndefined();
    expect(written.envelope).toMatchObject({ bootstrap: true, baselineSourceSha: null, rejectingIds: [] });
  });

  test("unretained path without allow flag refuses with observe next", async () => {
    const { root, destDir } = await rootFixture();
    const { source, profile } = toyEnvelope("");
    const hostBundle = await writeHost(root, source);
    await expect(writeReviewedProfileFromCopy({
      destDir, hostBundle, slices: profile.slices, profileId: profile.profileId, lineage: { root },
    })).rejects.toMatchObject({
      name: "ProfileWriteRefused",
      refusal: "unretained_source",
      next: `grokbox runtime profile observe --from ${hostBundle}`,
    });
    await expect(readFile(join(destDir, "reviewed.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("pin exists but golden missing refuses; next is re-observe that generation", async () => {
    const { root, destDir } = await rootFixture();
    const before = toyEnvelope("");
    const pinSha = sha256Text(before.source);
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: AT,
    });
    const hostBundle = retainedGenerationSourcePath(root, pinSha);
    await writeReviewedProfileFromCopy({
      destDir, hostBundle, slices: before.profile.slices, profileId: before.profile.profileId,
    });
    await expect(writeReviewedProfileFromCopy({
      destDir,
      hostBundle,
      slices: before.profile.slices,
      profileId: before.profile.profileId,
      lineage: { root, retainedSha: pinSha },
    })).rejects.toMatchObject({
      refusal: "missing_golden",
      next: `grokbox runtime profile observe --from ${hostBundle}`,
    });
  });

  test("escape hatch sets unretained_source and still runs reject-on-drift", async () => {
    const { root, destDir } = await rootFixture();
    const before = toyEnvelope("");
    const after = toyEnvelope("settledMessageCount:x");
    const pinSha = sha256Text(before.source);
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: AT,
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, pinSha),
      slices: before.profile.slices,
      profileId: before.profile.profileId,
    });
    const candidatePath = await writeHost(root, after.source, "next.cjs");
    const failed = writeReviewedProfileFromCopy({
      destDir,
      hostBundle: candidatePath,
      slices: after.profile.slices,
      profileId: after.profile.profileId,
      lineage: { root, allowUnretained: true },
    });
    await expect(failed).rejects.toBeInstanceOf(ProfileWriteRefused);
    await expect(failed).rejects.toMatchObject({
      refusal: "envelope_drift",
      details: { requiredIds: ["compact-register", "managed-step-error-scope"] },
    });
    const error = await failed.then(() => null, (value) => value as ProfileWriteRefused);
    expect(error?.next).toContain("runtime profile analyze --sha ");
    expect(error?.next).toContain("--slice-review compact-register,managed-step-error-scope");
    expect(error?.next).not.toContain("profile write --from /home/box/sand-host/host-main.cjs");

    await expect(writeReviewedProfileFromCopy({
      destDir,
      hostBundle: candidatePath,
      slices: after.profile.slices,
      profileId: "again",
      lineage: {
        root,
        allowUnretained: true,
        sliceReview: ["compact-register", "managed-step-error-scope", "agent-id"],
      },
    })).rejects.toMatchObject({ refusal: "envelope_drift" });

    const exact = await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: candidatePath,
      slices: after.profile.slices,
      profileId: after.profile.profileId,
      lineage: {
        root,
        allowUnretained: true,
        sliceReview: ["managed-step-error-scope", "compact-register"],
      },
    });
    expect(exact.unretained_source).toBe(true);
    expect(exact.sourceSha256).toBe(sha256Text(after.source));
    expect(exact.envelope?.rejectingIds).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(JSON.parse(await readFile(join(destDir, "reviewed.json"), "utf8")).sourceSha256).toBe(exact.sourceSha256);
  });

  test("primary --sha path loads retain bytes and still refuses drift", async () => {
    const { root, destDir } = await rootFixture();
    const before = toyEnvelope("");
    const after = toyEnvelope("settledMessageCount:y");
    const pinSha = sha256Text(before.source);
    const nextSha = sha256Text(after.source);
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: AT,
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, pinSha),
      slices: before.profile.slices,
      profileId: before.profile.profileId,
    });
    await retainHostBundle({
      root, source: after.source, sourceSha: nextSha, observedAt: "2026-01-01T00:00:01.000Z",
    });
    const hostBundle = retainedGenerationSourcePath(root, nextSha);
    await expect(writeReviewedProfileFromCopy({
      destDir, hostBundle, slices: after.profile.slices, profileId: after.profile.profileId,
      lineage: { root, retainedSha: nextSha },
    })).rejects.toMatchObject({ refusal: "envelope_drift" });
    const written = await writeReviewedProfileFromCopy({
      destDir, hostBundle, slices: after.profile.slices, profileId: after.profile.profileId,
      lineage: { root, retainedSha: nextSha, sliceReview: ["compact-register", "managed-step-error-scope"] },
    });
    expect(written.unretained_source).toBeUndefined();
    expect(written.sourceSha256).toBe(nextSha);
    expect(written.envelope?.bootstrap).toBe(false);
  });

  test("byteRange-only shift does not require slice-review", async () => {
    const { root, destDir } = await rootFixture();
    const before = toyEnvelope("");
    const after = toyEnvelope("");
    after.source = `// pad\n${after.source}`;
    after.profile = { ...after.profile, sourceSha256: sha256Text(after.source) };
    const pinSha = sha256Text(before.source);
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: AT,
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, pinSha),
      slices: before.profile.slices,
      profileId: before.profile.profileId,
    });
    const golden = await readFile(join(hostBundlesDir(root), "generations", pinSha, ENVELOPE_WINDOWS_FILE), "utf8");
    expect(golden).toBe(encodeEnvelopeWindows(measureEnvelopeWindows(before.source, before.profile)));
    const candidatePath = await writeHost(root, after.source, "shifted.cjs");
    const written = await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: candidatePath,
      slices: after.profile.slices,
      profileId: "shifted",
      lineage: { root, allowUnretained: true },
    });
    expect(written.envelope?.rejectingIds).toEqual([]);
    expect(written.envelope?.informationalIds.length).toBeGreaterThan(0);
    expect(written.unretained_source).toBe(true);
  });

  test("inspect names write-gate reject ids from retained envelope-windows without a runner", async () => {
    const { root, destDir } = await rootFixture();
    const before = toyEnvelope("");
    const after = toyEnvelope("settledMessageCount:inspect");
    const pinSha = sha256Text(before.source);
    const nextSha = sha256Text(after.source);
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: AT,
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, pinSha),
      slices: before.profile.slices,
      profileId: before.profile.profileId,
    });
    await retainHostBundle({
      root, source: after.source, sourceSha: nextSha, observedAt: "2026-01-01T00:00:01.000Z",
    });
    const inspect = await inspectRetainedWriteEnvelope(root, nextSha, after.profile.slices);
    expect(inspect.generationPresent).toBe(true);
    expect(inspect.refusal).toBe("envelope_drift");
    expect(inspect.requiredIds).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(inspect.sliceReviewRequired).toBe(true);
    expect(inspect.next).toBe(profileWriteExecutableNext(nextSha, inspect.requiredIds));
    expect(inspect.next).toBe(
      `grokbox runtime profile write --sha ${nextSha} --slice-review compact-register,managed-step-error-scope`,
    );
    await expect(writeReviewedProfileFromCopy({
      destDir,
      hostBundle: retainedGenerationSourcePath(root, nextSha),
      slices: after.profile.slices,
      profileId: after.profile.profileId,
      lineage: { root, retainedSha: nextSha },
    })).rejects.toMatchObject({ details: { requiredIds: inspect.requiredIds } });
  });

  test("inspect measures from reviewed recipe when candidate envelope-windows.json is missing", async () => {
    const { root } = await rootFixture();
    const before = toyEnvelope("");
    const after = toyEnvelope("settledMessageCount:fallback");
    const pinSha = sha256Text(before.source);
    const nextSha = sha256Text(after.source);
    await retainHostBundle({
      root, source: after.source, sourceSha: nextSha, observedAt: AT,
    });
    await retainHostBundle({
      root, source: before.source, sourceSha: pinSha, observedAt: "2026-01-01T00:00:01.000Z",
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "profiles", "reviewed.json"), `${JSON.stringify(before.profile)}\n`);
    expect(await readFile(join(hostBundlesDir(root), "generations", nextSha, ENVELOPE_WINDOWS_FILE), "utf8").then(() => true, () => false)).toBe(false);
    const inspect = await inspectRetainedWriteEnvelope(root, nextSha, after.profile.slices);
    expect(inspect.refusal).toBe("envelope_drift");
    expect(inspect.requiredIds).toEqual(["compact-register", "managed-step-error-scope"]);
    expect(inspect.sliceReviewRequired).toBe(true);
    expect(inspect.next).toContain(`write --sha ${nextSha} --slice-review compact-register,managed-step-error-scope`);
  });
});
