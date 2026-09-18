import { readFileSync, writeFileSync } from "node:fs";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy, isContinuityUuid, type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { openContinuityRecoveryStore } from "../../src/runtime.ts";
import { captureNativeCheckpoint, verifyNativeCheckpointMaterialReadback } from "../../src/internal/host/native-checkpoint.ts";
import { buildHostEnvelope } from "../../src/internal/host/context-codec.ts";
import { nativeContinuityCode, CONT_NATIVE_PAIR } from "../native-continuity-code.ts";

// Only caller-owned test directories. The original AgentStore operates on owned
// file/metadata ports, never the installed Bot database or full Host entrypoint.
const [directory, mode, requestId] = process.argv.slice(2);
if (!directory || !isContinuityUuid(requestId) || !["seed", "install", "readback"].includes(mode ?? "")
  || await readFile(join(directory, "owned-marker"), "utf8") !== "native-checkpoint-node-test") throw Error("unowned_test_path");
const n = nativeContinuityCode(), policy = continuityStorePolicy(), scopeId = "b".repeat(64);
const bytes = (value: string) => new TextEncoder().encode(value), slot = bytes("owned-native-slot");
const key = (id: Uint8Array) => {
  if (!(id instanceof Uint8Array) || id.byteLength < 1 || id.byteLength > 32) throw Error("owned-invalid-ref");
  return Buffer.from(id).toString("hex");
};
const schema = { root: n.ConversationStateStructure, referenceTypes: n.BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
  referenceMetadata: n.getBlobReferenceMessageMetadata, isMessage: n.isMessage };
async function ownedStore(label: "source" | "target", create: boolean) {
  const path = join(directory!, label), metadataFile = join(path, "metadata.json");
  if (create) {
    await mkdir(path, { mode: 0o700 }); await mkdir(join(path, "blobs"), { mode: 0o700 });
    await writeFile(metadataFile, JSON.stringify({ root: "" }), { mode: 0o600 });
  }
  const metadata = { get: (name: string) => name === "latestRootBlobId"
    ? Uint8Array.from(Buffer.from(JSON.parse(readFileSync(metadataFile, "utf8")).root, "hex")) : undefined,
    set: (name: string, value: Uint8Array) => {
      if (name !== "latestRootBlobId") throw Error("unexpected-metadata-write");
      writeFileSync(metadataFile, JSON.stringify({ root: key(value) }), { mode: 0o600 });
    } };
  const readBlob = async (id: Uint8Array, max: number): Promise<Uint8Array | undefined> => {
    const file = join(path, "blobs", key(id));
    try {
      if ((await stat(file)).size > max) throw Error("owned_limit");
      const data = await readFile(file); if (data.byteLength > max) throw Error("owned_limit"); return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const blobs = { getBlob: (_ctx: unknown, id: Uint8Array) => readBlob(id, policy.maxPartBytes),
    setBlob: async (_ctx: unknown, id: Uint8Array, data: Uint8Array) => {
      await writeFile(join(path, "blobs", key(id)), data, { mode: 0o600 });
    } };
  return { path, metadata, readBlob, blobs, original: new n.AgentStore(blobs, metadata, { fixedRootBlobId: slot }) };
}
const head = (hash: string): NativeCurrentHead => ({ agentId: mode === "seed" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  scopeId, hostSourceSha: CONT_NATIVE_PAIR.host, nativeSchema: CONT_NATIVE_PAIR.schema,
  hostGeneration: "owned-native-node", contextRevision: "d".repeat(64), activationEpoch: "owned-native-epoch",
  state: "prepared", effects: "clear", rootHash: hash });
const vault = openContinuityRecoveryStore({ durableRoot: directory, scopeId });
if (mode === "seed") {
  const source = await ownedStore("source", true);
  const put = async (data: Uint8Array) => {
    const id = Uint8Array.from(Buffer.from(sha256Bytes(data), "hex")); await source.blobs.setBlob({}, id, data); return id;
  };
  const current = await put(bytes(JSON.stringify({ role: "user", content: "NODE_NATIVE_SENTINEL" })));
  const archived = await put(bytes(JSON.stringify({ role: "user", content: "NODE_ARCHIVE_SENTINEL" })));
  const summary = await put(bytes(JSON.stringify({ role: "assistant", content: "NODE_SUMMARY_SENTINEL" })));
  const archive = await put(new n.ConversationSummaryArchive({ summarizedMessages: [archived], summaryMessage: summary }).toBinary());
  const root = new n.ConversationStateStructure({ rootPromptMessagesJson: [summary, current], summaryArchives: [archive] });
  await source.original.handleCheckpoint({}, root);
  const material = await captureNativeCheckpoint({ expected: head(sha256Bytes(root.toBinary())), schema,
    reader: { rootId: slot, readBlob: source.readBlob }, policy, capturedAtMs: 1 });
  await vault.initialize(); const publication = await vault.publish({ requestId, ...material });
  console.log(JSON.stringify({ state: publication.state, parts: material.manifest.parts.length,
    archiveRef: key(archive), sourceRootHash: head(sha256Bytes(root.toBinary())).rootHash, nativeImportProven: false }));
} else {
  const material = await vault.readSnapshot(requestId), target = await ownedStore("target", mode === "install");
  const rootPart = material.manifest.parts.find(part => part.id === material.manifest.root)!;
  if (mode === "install") {
    // Qualification of the original writer with an owned dependency store.
    // This is not the production cross-identity importer or an activation grant.
    for (const part of material.manifest.parts) if (part.id !== material.manifest.root) {
      if (!/^n:[a-f0-9]{2,64}$/.test(part.id)) throw Error("owned-native-part-id");
      await target.blobs.setBlob({}, Uint8Array.from(Buffer.from(part.id.slice(2), "hex")), material.content.get(part.hash)!);
    }
    await target.original.handleCheckpoint({}, n.ConversationStateStructure.fromBinary(material.content.get(rootPart.hash)));
  }
  const expected = head(rootPart.hash);
  const proof = await verifyNativeCheckpointMaterialReadback({ store: target.original, ctx: {}, material, schema, policy, expected,
    readBlob: target.readBlob, readHead: async () => ({ ...expected, rootHash: sha256Bytes((await target.readBlob(slot, policy.maxPartBytes))!) }) });
  // Checks production window conversion only; no original loop or Provider is run.
  const messages = await Promise.all(target.original.getConversationStateStructure().rootPromptMessagesJson.map(async (id: Uint8Array) =>
    JSON.parse(Buffer.from((await target.readBlob(id, policy.maxPartBytes))!).toString("utf8"))));
  const window = JSON.stringify(buildHostEnvelope(messages));
  console.log(JSON.stringify({ node: process.version, rootHash: proof.rootHash, verifiedParts: proof.verifiedParts,
    nativeClosureReadBack: proof.nativeClosureReadBack, hasCurrent: window.includes("NODE_NATIVE_SENTINEL"),
    hasSummary: window.includes("NODE_SUMMARY_SENTINEL"), hasArchivedInCurrentWindow: window.includes("NODE_ARCHIVE_SENTINEL"),
    originalAgentLoopProven: false, activationAuthorized: false, providerDispatched: false, applicationMarkerProven: false }));
}
