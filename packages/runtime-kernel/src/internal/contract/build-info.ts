/** Build-injected, payload-free provenance shared by Host and modeld. No Effect,
 * SDK, filesystem or process execution is imported into the preload path. */
declare const __GROKBOX_BUILD_INFO__: unknown;
export type RuntimeBuildInfo =
  | { version: 1; kind: "source" }
  | { version: 1; kind: "bundled"; sourceDigest: string; compilerVersion: string;
      sdkVersions: { ai: string; openai: string; effect: string } };
const version = (value: unknown): value is string => typeof value === "string" && /^[0-9][A-Za-z0-9.+-]{0,63}$/.test(value);
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}
export function projectRuntimeBuildInfo(value: unknown): RuntimeBuildInfo | undefined {
  try {
    if (own(value, "version") !== 1) return undefined;
    if (own(value, "kind") === "source") return { version: 1, kind: "source" };
    const sdk = own(value, "sdkVersions"), sourceDigest = own(value, "sourceDigest"), compilerVersion = own(value, "compilerVersion");
    const ai = own(sdk, "ai"), openai = own(sdk, "openai"), effect = own(sdk, "effect");
    if (own(value, "kind") !== "bundled" || typeof sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(sourceDigest)
      || !version(compilerVersion) || !version(ai) || !version(openai) || !version(effect)) return undefined;
    return { version: 1, kind: "bundled", sourceDigest, compilerVersion, sdkVersions: { ai, openai, effect } };
  } catch { return undefined; }
}
const BUILD = typeof __GROKBOX_BUILD_INFO__ === "undefined" ? { version: 1, kind: "source" } : __GROKBOX_BUILD_INFO__;
export function runtimeBuildInfo(): RuntimeBuildInfo {
  return projectRuntimeBuildInfo(BUILD) ?? { version: 1, kind: "source" };
}
