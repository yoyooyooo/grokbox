/** Compatibility import for the staged V2 provenance work. The sole runtime
 * implementation is a pure kernel contract, so Host never imports process IO. */
export { projectRuntimeBuildInfo, runtimeBuildInfo, type RuntimeBuildInfo } from "@grokbox/runtime-kernel/contract";
