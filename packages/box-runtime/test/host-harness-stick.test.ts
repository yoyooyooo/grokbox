import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, approvedSliceSet, profileFromSource, transformUnchecked, type SlicePatch } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

// Historical IDs are untrusted input used to prove retired profiles cannot be
// resurrected. No test calls a live writer, changes a Bot or copies native data.
const RETIRED = ["harness-profile-rpc", "harness-update-trim", "harness-agent-write", "harness-local-write", "harness-server-write"];
const STICK_SYMBOL = "grokbox.box-runtime.harness-stick.v1";
const section = (source: string, start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < a) throw new Error("owned_writer_anchor_missing");
  return source.slice(a, b);
};

test("active profile keeps observation but no harness mutation slices", () => {
  const ids: string[] = LIVE_SLICE_PATCHES.map(slice => slice.id);
  for (const id of RETIRED) expect(ids).not.toContain(id);
  expect(ids).toContain("harness-blank");
  expect(ids).toContain("harness-summary");
  expect(ids).toContain("ownership-read-api");
  const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
  if (!applied.ok) throw new Error(applied.code);
  expect(applied.source).not.toContain(STICK_SYMBOL);
  expect(applied.source).not.toContain("harness: rpcOptional(");
  expect(applied.source).toContain('harness: readSandProfileHarness(profilePath) === "temporal" ? "temporal" : "box"');
});

for (const id of RETIRED) {
  test(`retired ${id} cannot be loaded or reauthored as a current profile`, () => {
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "owned-retirement-profile");
    const stale = { id, startAnchor: "function writeSandProfileFile(path31, profile) {",
      endAnchor: "function seedRoomProfileName(seed) {", find: "  const parsed = parseProfileJson2(path31);",
      replacement: "  const parsed = null;" } as SlicePatch;
    expect(approvedSliceSet([...profile.slices, stale])).toBe(false);
    expect(applyPatchProfile(LIVE_SHAPED_HOST, { ...profile, slices: [...profile.slices, stale] }))
      .toMatchObject({ ok: false, code: "retired-slice" });
    expect(transformUnchecked(LIVE_SHAPED_HOST, [stale])).toMatchObject({ ok: false, code: "retired-slice" });
  });
}

test("profile transformation leaves native local/server writer bodies unchanged", async () => {
  const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
  if (!applied.ok) throw new Error(applied.code);
  const localStart = "function writeSandProfileFile(path31, profile) {";
  const localEnd = "function seedRoomProfileName(seed) {";
  const serverStart = "function writeServerBackedProfileFile(path31, profile, binding) {";
  const serverEnd = "function isServerTemporalHarnessRefusal(error41) {";
  const local = section(applied.source, localStart, localEnd);
  const server = section(applied.source, serverStart, serverEnd);
  expect(local).toBe(section(LIVE_SHAPED_HOST, localStart, localEnd));
  expect(server).toBe(section(LIVE_SHAPED_HOST, serverStart, serverEnd));
  const rows = new Map<string, Record<string, unknown>>();
  rows.set("owned-path", { name: "old", serverId: "owned-row", harness: "box", origin: "fixture-origin", purpose: "fixture-purpose" });
  const sandbox = {
    parseProfileJson2: (path: string) => rows.get(path) ?? null,
    profileServerBindingFromJson: (row: Record<string, unknown>) => ({ serverId: row.serverId, harness: row.harness }),
    // An independent finite serializer, not the implementation under test.
    serializeSandProfileFile: (profile: Record<string, unknown>, binding: Record<string, unknown>) =>
      JSON.stringify({ name: profile.name, description: profile.description, ...binding }),
    writeProfileJson: (path: string, value: string) => { rows.set(path, JSON.parse(value)); },
    readSandProfileCreationMetadata: (path: string) => ({ origin: rows.get(path)?.origin, purpose: rows.get(path)?.purpose }),
  };
  const writer = runInNewContext(`${local}\n${server}\n({local:writeSandProfileFile,server:writeServerBackedProfileFile})`, sandbox) as {
    local(path: string, profile: Record<string, unknown>): void;
    server(path: string, profile: Record<string, unknown>, binding: Record<string, unknown>): void;
  };
  writer.local("owned-path", { name: "rename", description: "", harness: "temporal" });
  expect(rows.get("owned-path")).toMatchObject({ name: "rename", serverId: "owned-row", harness: "box" });
  rows.set("owned-path", { ...rows.get("owned-path"), origin: "fixture-origin", purpose: "fixture-purpose" });
  writer.server("owned-path", { name: "server-name" }, { serverId: "owned-row", harness: "temporal" });
  expect(rows.get("owned-path")).toMatchObject({ harness: "temporal", serverId: "owned-row", origin: "fixture-origin", purpose: "fixture-purpose" });
  writer.local("owned-path", { name: "another-name", harness: "box" });
  expect(rows.get("owned-path")?.harness).toBe("temporal");
  // This tests the writer's data contract, not the existence of a public reverse migration API.
  writer.server("owned-path", { name: "confirmed-box" }, { serverId: "owned-row", harness: "box" });
  expect(rows.get("owned-path")?.harness).toBe("box");

  const roster = section(applied.source, "const rosterOwner = {", "const sessionStoreOwner = {");
  const api = runInNewContext(`${roster}\nrosterOwner`, {}) as { updateAgent(id: string, profile: Record<string, unknown>): Promise<{ trimmedProfile: Record<string, unknown> }> };
  expect((await api.updateAgent("owned", { name: " x ", description: " y ", harness: "box" })).trimmedProfile)
    .toEqual({ name: "x", description: "y" });
});

test("source preload no longer installs the old identity-write hook", () => {
  const source = readFileSync(new URL("../src/preload.ts", import.meta.url), "utf8");
  expect(source).not.toContain("bindHarnessStickHook");
  expect(source).not.toContain("HOST_HARNESS_STICK_SYMBOL");
});
