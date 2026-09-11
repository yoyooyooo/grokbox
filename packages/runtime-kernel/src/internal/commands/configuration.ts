import { Effect } from "effect";
import { ConfigurationWrite } from "../../ports.ts";
import type { DesiredFile, ModelsFile } from "../../selection.ts";

export type ConfigurationSaveKind = "models" | "desired";

export type ConfigurationSaveRequest = {
  boxRoot: string;
  kind: ConfigurationSaveKind;
  file: ModelsFile | DesiredFile;
};

export type ConfigurationSaveReceipt =
  | { ok: true; kind: ConfigurationSaveKind; boxRoot: string; configRevision: string }
  | { ok: false; reason: "invalid-box-root" | "remote-box-root" | "invalid-kind" };

function admitBoxRoot(value: unknown): { ok: true; boxRoot: string } | { ok: false; reason: "invalid-box-root" | "remote-box-root" } {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || /[\r\n]/.test(value)) {
    return { ok: false, reason: "invalid-box-root" };
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return { ok: false, reason: "invalid-box-root" };
  }
  if (value.includes("://") || value.includes("@") || /^(?:https?|ssh|git|daemon):/i.test(value)) {
    return { ok: false, reason: "remote-box-root" };
  }
  return { ok: true, boxRoot: value };
}

export function admitConfigurationSave(request: ConfigurationSaveRequest): ConfigurationSaveReceipt | { ok: true; boxRoot: string; kind: ConfigurationSaveKind } {
  const box = admitBoxRoot(request.boxRoot);
  if (!box.ok) return box;
  if (request.kind !== "models" && request.kind !== "desired") {
    return { ok: false, reason: "invalid-kind" };
  }
  if (!request.file || typeof request.file !== "object") {
    return { ok: false, reason: "invalid-kind" };
  }
  return { ok: true, boxRoot: box.boxRoot, kind: request.kind };
}

/** Single-writer configuration save. No expected-revision CAS. */
export function runConfigurationSave(request: ConfigurationSaveRequest) {
  return Effect.gen(function* () {
    const admitted = admitConfigurationSave(request);
    if (!admitted.ok) return admitted;
    const write = yield* ConfigurationWrite;
    if (admitted.kind === "models") {
      const saved = yield* write.saveModels(request.file as ModelsFile);
      return { ok: true as const, kind: "models" as const, boxRoot: admitted.boxRoot, configRevision: saved.configRevision };
    }
    const saved = yield* write.saveDesired(request.file as DesiredFile);
    return { ok: true as const, kind: "desired" as const, boxRoot: admitted.boxRoot, configRevision: saved.configRevision };
  });
}
