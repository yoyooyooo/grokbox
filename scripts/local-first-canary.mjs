import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const canonical = v => JSON.stringify(v, (_, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const keys = (v, expected) => v && Object.keys(v).sort().join() === expected;
const source = v => keys(v, "generationId,preloadSha256,profileSha256,sourceSha256,transformedSha256")
  && [v.sourceSha256, v.transformedSha256, v.profileSha256, v.preloadSha256].every(hash) && typeof v.generationId === "string" && v.generationId.length > 0 && v.generationId.length <= 128;
export function creationCanaryPlan(v) {
  if (!keys(v, "artifactSha256,authorizationRef,cleanupRequestId,expectedNativeGeneration,expectedSource,installationId,maxAgeMs,profile,requestId,scopeId,version")
    || !Number.isSafeInteger(v.maxAgeMs) || v.maxAgeMs < 60000 || v.maxAgeMs > 86400000
    || v.version !== 1 || ![v.requestId, v.cleanupRequestId, v.installationId].every(uuid) || v.requestId === v.cleanupRequestId
    || ![v.scopeId, v.expectedNativeGeneration, v.artifactSha256].every(hash) || !source(v.expectedSource)
    || !(v.authorizationRef === null || typeof v.authorizationRef === "string" && /^private:[A-Za-z0-9._:-]{1,160}$/.test(v.authorizationRef))
    || !keys(v.profile, "description,name") || typeof v.profile.name !== "string" || !v.profile.name.trim()
    || v.profile.name !== v.profile.name.trim() || v.profile.name.length > 128 || typeof v.profile.description !== "string" || v.profile.description.length > 1024)
    throw Error("creation_canary_invalid_plan");
  return v;
}

/** One narrow journey owned by the existing live validation runner. Persisted
 * attempt markers only prevent resubmission; management CONT owns the effects.
 * The caller supplies the formal CLI, never a private Gateway or POC function. */
export async function runCreationCanary({ plan: raw, confirm = false, cli, read, save, now = Date.now }) {
  const plan = creationCanaryPlan(raw), at = now();
  const result = { version: 1, kind: "grokbox-creation-canary", status: "not-run", ok: false, requestId: plan.requestId, cleanupRequestId: plan.cleanupRequestId,
    scopeId: plan.scopeId, installationId: plan.installationId, expectedSource: plan.expectedSource, artifactSha256: plan.artifactSha256,
    observedAtMs: at, freshness: "not-observed", creation: { state: "not-run", stage: "authorization" }, cleanup: { state: "not-run", stage: "authorization" },
    targetId: null, source: null, lastSuccess: null, executionQualified: false, workerQualification: "not-exercised" };
  const previous = await read("first-success"); result.lastSuccess = previous?.observedAtMs ?? null;
  if (previous && (at - previous.observedAtMs > plan.maxAgeMs || at < previous.observedAtMs
    || canonical(previous.expectedSource) !== canonical(plan.expectedSource))) result.freshness = "stale";
  if (!confirm || plan.authorizationRef === null) return result;
  const declaration = await read("declaration");
  if (declaration && canonical(declaration) !== canonical(plan)) throw Error("creation_canary_original_plan_changed");
  if (!declaration) await save("declaration", plan);
  const invoke = async (args, input) => {
    const reply = await cli(args, input);
    if (!reply || reply.installationId !== plan.installationId) throw Error("wrong_installation");
    if (reply.ok !== true) throw Error(/^[a-z_]{1,80}$/.test(reply.error?.code) ? reply.error.code : "cli_failed");
    return reply.data;
  };
  const lookup = async requestId => {
    let receipt = await invoke(["product", "operation", "get", requestId, "--scope-id", plan.scopeId]);
    if (receipt.state === "effect_unknown") receipt = await invoke(["product", "operation", "reconcile", requestId, "--scope-id", plan.scopeId, "--confirm"]);
    return receipt;
  };
  const once = async (kind, requestId, args, input) => {
    if (await read(`${kind}-attempt`)) return lookup(requestId);
    const preview = await invoke([...args, "--input", "-", "--preview"], input);
    if (preview.scopeId !== plan.scopeId || preview.sourceGeneration !== plan.expectedNativeGeneration) throw Error("source_or_account_changed");
    if (kind === "create" && !preview.creationSource) throw Error("creation_capability_missing");
    if (kind === "create" && canonical(preview.creationSource) !== canonical(plan.expectedSource)) throw Error("loaded_source_changed");
    const savedPlan = await read(`${kind}-plan`);
    if (savedPlan && canonical(savedPlan) !== canonical(preview)) throw Error("original_preview_changed");
    if (!savedPlan) await save(`${kind}-plan`, preview);
    // Exclusive immutable marker precedes the only submission. A lost response,
    // crash or concurrent runner can only look up this original request later.
    await save(`${kind}-attempt`, { requestId, atMs: now(), revision: preview.revision });
    try {
      const receipt = await invoke([...args, "--input", "-", "--scope-id", plan.scopeId, "--expect-revision", preview.revision, "--accept-non-atomic", "--confirm"], input);
      return receipt.state === "effect_unknown" ? lookup(requestId) : receipt;
    } catch { return lookup(requestId); }
  };
  const settledCreation = await read("creation-verdict");
  if (settledCreation && await read("cleanup-attempt")) {
    result.creation = settledCreation.creation; result.targetId = settledCreation.targetId; result.source = settledCreation.source;
    return cleanupOriginal();
  }
  let created;
  try {
    created = await once("create", plan.requestId, ["bot", "create"], { requestId: plan.requestId, profile: plan.profile, harness: "box", deferStart: true });
    await save(`create-observation-${randomUUID()}`, created);
  } catch (error) {
    const stale = ["source_or_account_changed", "loaded_source_changed"].includes(error.message);
    result.creation = { state: stale ? "stale" : error.message === "creation_capability_missing" ? "failed" : "uncertain",
      stage: await read("create-attempt") ? "registration" : "preflight", code: String(error.message).slice(0, 80) };
    if (stale) result.freshness = "stale";
    result.cleanup = { state: "not-run", stage: "creation-unconfirmed" };
    return finish();
  }
  const r = created?.result, evidence = r?.creation;
  result.targetId = r?.targetId ?? null; result.source = evidence?.source ?? null;
  if (created.state !== "complete" || !uuid(result.targetId) || r.nativeReceipt !== "returned") {
    result.creation = { state: r?.nativeReceipt === "not-dispatched" ? "failed" : "uncertain", stage: r?.nativeReceipt === "not-dispatched" ? "local-factory" : "registration" };
    return finish();
  }
  let ownership, local;
  try {
    ownership = await invoke(["bot", "ownership", "get", result.targetId]);
    local = await invoke(["bot", "profile", "get", result.targetId]);
    await save(`readback-${randomUUID()}`, { ownership, local });
  } catch {
    result.creation = { state: "uncertain", stage: "readback" }; result.cleanup = { state: "not-run", stage: "ownership-unconfirmed" }; return finish();
  }
  const owned = ownership?.agents?.[0], object = local?.objects?.[0];
  const sameScope = ownership.scopeId === plan.scopeId && local.scopeId === plan.scopeId;
  const sameGeneration = ownership.sourceGeneration === plan.expectedNativeGeneration && local.sourceGeneration === plan.expectedNativeGeneration;
  if (sameGeneration && canonical(evidence?.source) === canonical(plan.expectedSource)) result.freshness = "current";
  // Corroborate the original returned identity under the same authenticated scope.
  // Optional sharing metadata is not a positive-owner claim; explicit denial blocks.
  const exactTarget = sameScope && sameGeneration && owned?.id === result.targetId && owned.viewerIsOwner !== false
    && ["confirmed_box", "confirmed_temporal"].includes(owned.state) && evidence?.firstResponse?.agentId === result.targetId
    && evidence.firstResponse.serverId === owned.serverId && evidence.localAgentId === result.targetId;
  if (!evidence || evidence.outcome === "unknown") result.creation = { state: "uncertain", stage: evidence?.stage ?? "server-result" };
  else if (canonical(evidence.source) !== canonical(plan.expectedSource) || !sameGeneration) result.creation = { state: "stale", stage: "loaded-source" };
  else if (evidence.outcome === "registered" && exactTarget && owned.state === "confirmed_box" && evidence.firstResponse.harness === "box"
    && evidence.request?.introductionSuppressed === true && evidence.request?.kickstartRequested === false
    && object?.id === result.targetId && object.kind === "bot" && object.harness === "box" && object.profile.name === plan.profile.name)
    result.creation = { state: "passed", stage: "readback" };
  else result.creation = { state: "failed", stage: evidence.outcome === "mismatch" ? evidence.stage : "readback" };
  if (!exactTarget) { result.cleanup = { state: "not-run", stage: "ownership-unconfirmed" }; return finish(); }
  if (!settledCreation) await save("creation-verdict", { creation: result.creation, targetId: result.targetId, source: result.source });
  return cleanupOriginal();

  async function cleanupOriginal() {
  try {
    const cleanup = await once("cleanup", plan.cleanupRequestId, ["bot", "delete", result.targetId], { requestId: plan.cleanupRequestId });
    await save(`cleanup-observation-${randomUUID()}`, cleanup);
    if (cleanup.state !== "complete" || cleanup.result?.nativeReceipt !== "returned" || cleanup.result.targetId !== result.targetId) {
      result.cleanup = { state: "uncertain", stage: "cleanup" }; return finish();
    }
    const afterOwnership = await invoke(["bot", "ownership", "get", result.targetId]);
    // Exact native lookup's not_found is an absence observation, not a generic
    // failed query. Pair it with independent Server absence and the delete receipt.
    let afterLocal;
    try { afterLocal = await invoke(["bot", "profile", "get", result.targetId]); }
    catch (error) { if (error.message !== "not_found") throw error; afterLocal = { absent: true }; }
    await save(`cleanup-readback-${randomUUID()}`, { ownership: afterOwnership, local: afterLocal });
    if (afterOwnership.sourceGeneration !== plan.expectedNativeGeneration) result.freshness = "stale";
    else if (result.freshness !== "stale") result.freshness = "current";
    const absent = afterOwnership.agents?.[0];
    const deleted = afterOwnership.scopeId === plan.scopeId && afterOwnership.sourceGeneration === plan.expectedNativeGeneration
      && cleanup.result.readBack === "matched" && afterLocal.absent === true
      && absent?.id === result.targetId && absent.state === "unconfirmed" && absent.serverId === null && absent.viewerIsOwner === null;
    result.cleanup = { state: deleted && ["complete", "not-applicable"].includes(cleanup.result.cleanup) ? "passed" : "uncertain", stage: "cleanup-readback" };
  } catch { result.cleanup = { state: "uncertain", stage: "cleanup" }; }
  return finish();
  }

  async function finish() {
    if (previous && (at - previous.observedAtMs > plan.maxAgeMs || at < previous.observedAtMs)) result.freshness = "stale";
    result.status = result.freshness === "stale" ? "stale" : result.creation.state;
    result.ok = result.creation.state === "passed" && result.cleanup.state === "passed" && result.freshness === "current";
    if (result.creation.state === "passed" && !previous) { await save("first-success", result); result.lastSuccess = result.observedAtMs; }
    await save(`attempt-result-${randomUUID()}`, result);
    return result;
  }
}

export async function creationCanaryFiles(directory) {
  if (!isAbsolute(directory)) throw Error("creation_canary_absolute_directory_required");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error("creation_canary_private_directory_required");
  const path = key => {
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw Error("creation_canary_record_key");
    return join(directory, `${key}.json`);
  };
  return {
    read: async key => { try { const file = path(key), st = await lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 131072 || (st.mode & 0o077) !== 0) throw Error("creation_canary_record_invalid"); return JSON.parse(await readFile(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    save: async (key, value) => { const body = JSON.stringify(value); if (Buffer.byteLength(body) > 131072) throw Error("creation_canary_record_limit"); await writeFile(path(key), body + "\n", { flag: "wx", mode: 0o600 }); },
  };
}
export function creationCanaryCli(entry, env = process.env) {
  return (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
    let stdout = "", stderrBytes = 0;
    child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 131072) child.kill(); });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 131072) child.kill(); });
    child.on("error", () => reject(Error("cli_unavailable")));
    child.on("close", () => { try { resolve(JSON.parse(stdout)); } catch { reject(Error("cli_response_unknown")); } });
    child.stdin.on("error", () => {}); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
export async function checkCanaryArtifact(entry, expected) {
  if (!isAbsolute(entry) || createHash("sha256").update(await readFile(entry)).digest("hex") !== expected) throw Error("creation_canary_artifact_changed");
}
