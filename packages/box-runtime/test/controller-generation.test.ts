import { describe, expect, test } from "bun:test";
import { expectedCompileReceipt } from "../src/internal/host/compile-receipt.ts";
import { profileFromSource } from "../src/internal/host/profile.ts";
import { controllerOperationId, observedAdoptGenerationMatches } from "../src/internal/roots/controller-program.node.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "generation-a");
const host = { pid: 13, start: 102 };
const preloadSha256 = "f".repeat(64);
const marker = {
  ...host,
  operationId: "original-generation-operation",
  mode: "route" as const,
  modeld: false as const,
  compiled: true as const,
  transformed: true as const,
  compile: expectedCompileReceipt(profile),
  preloadSha256,
};

describe("controller loaded generation", () => {
  test("reuses only matching loaded preload and compiled profile", () => {
    expect(observedAdoptGenerationMatches(marker, host, profile, preloadSha256)).toBe(true);
    expect(observedAdoptGenerationMatches({ ...marker, preloadSha256: undefined }, host, profile, preloadSha256)).toBe(false);
    expect(observedAdoptGenerationMatches(marker, host, profile, "e".repeat(64))).toBe(false);
    expect(observedAdoptGenerationMatches({ ...marker, start: 101 }, host, profile, preloadSha256)).toBe(false);
    const nextProfile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES, "generation-b");
    expect(observedAdoptGenerationMatches(marker, host, nextProfile, preloadSha256)).toBe(false);
    expect(observedAdoptGenerationMatches({ ...marker, compile: undefined }, host, profile, preloadSha256)).toBe(false);
  });

  test("profile changes are new operations even if the preload filename and bytes stay unchanged", () => {
    const generation = { preloadSha256, profileSha256: expectedCompileReceipt(profile).profileSha256 };
    const first = controllerOperationId("apply", "/owned/box", generation);
    expect(controllerOperationId("apply", "/owned/box", { ...generation })).toBe(first);
    expect(controllerOperationId("apply", "/owned/box", { ...generation, profileSha256: "a".repeat(64) })).not.toBe(first);
    expect(controllerOperationId("apply", "/owned/box", { ...generation, preloadSha256: "a".repeat(64) })).not.toBe(first);
  });
});
