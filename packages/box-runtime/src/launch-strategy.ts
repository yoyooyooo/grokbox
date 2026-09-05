import type { ProcessIdentity } from "./process.ts";

export type H3LaunchStrategy = "direct-overlay" | "transient-adopt-candidate" | "unavailable";

export function decideH3LaunchStrategy(input: {
  supervisor: ProcessIdentity;
  reviewedAdoptCapability?: boolean;
}): H3LaunchStrategy {
  const line = input.supervisor.cmdline.join(" ");
  if (line.includes("disposable-supervisor.cjs") && line.includes("launch.json")) {
    return "direct-overlay";
  }
  if (line.includes("disposable-adopt-supervisor.cjs")) {
    return "transient-adopt-candidate";
  }
  if (line.includes("sand-supervisor.mjs") && input.reviewedAdoptCapability === true) {
    return "transient-adopt-candidate";
  }
  return "unavailable";
}
