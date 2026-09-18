import { join } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { runtimeDesiredFromConfig, RECEIVER_MODEL_SOURCE, nativeReceiverModelRevision, type ReceiverModelObservation } from "@grokbox/runtime-kernel/observation";
import { captureHostManagedSelection } from "./selection.node.ts";
import { readBoundedJsonSync } from "./bounded-json.node.ts";

export const HOST_RECEIVER_MODEL_SYMBOL = "grokbox.box-runtime.receiver-model.v1";
type NativePreview = { mockConfigured: boolean; requestedModel?: unknown };
type Input = { durableRoot: string; mode: "route" | "identity"; profileRevision?: string; sourceRevision?: string; preloadRevision?: string; now?: () => number };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Local, bounded selection preview from the same native closure that owns
 * createSession. No session/executor, auth call, model request or writer is run.
 * This cannot prove future execution, arbitrary session overrides or tool access. */
export function bindReceiverModel(input: Input) {
  let readNative: (() => NativePreview) | undefined, ambiguous = false;
  const now = input.now ?? Date.now;
  return {
    capture: (reader: () => NativePreview) => {
      if (typeof reader !== "function") return;
      if (readNative && readNative !== reader) { ambiguous = true; return; }
      readNative = reader;
    },
    read: (agentId: unknown): ReceiverModelObservation | null => {
      if (typeof agentId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(agentId)) return null;
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 1) return null;
      const base = { version: 1 as const, source: RECEIVER_MODEL_SOURCE, agentId, observedAtMs,
        loadedProfileRevision: hash(input.profileRevision) ? input.profileRevision : null,
        loadedSourceRevision: hash(input.sourceRevision) ? input.sourceRevision : null,
        loadedPreloadRevision: hash(input.preloadRevision) ? input.preloadRevision : null,
        loadedMode: input.mode, scope: "next_local_default_automation_session" as const,
        executionObserved: false as const, toolsObserved: false as const, noModelRequest: true as const } as const;
      const unavailable = (reason: ReceiverModelObservation["reason"]): ReceiverModelObservation => ({ ...base, state: "unavailable", selection: "unknown", modelRevision: null, reason });
      if (ambiguous) return unavailable("ambiguous_source");
      if (!readNative || !base.loadedProfileRevision || !base.loadedSourceRevision || !base.loadedPreloadRevision) return unavailable("model_source_missing");
      try {
        const before = readBoundedJsonSync(join(input.durableRoot, "config.json"));
        const desired = runtimeDesiredFromConfig(before);
        if (desired.mode !== input.mode) return unavailable("configuration_changed");
        const selected = input.mode === "route" ? captureHostManagedSelection(input.durableRoot, agentId) : { kind: "official" as const };
        const preview = readNative();
        if (preview.mockConfigured !== false) return unavailable("mock_not_supported");
        const nativeRevision = nativeReceiverModelRevision(preview.requestedModel);
        if (!nativeRevision) return unavailable("selection_unavailable");
        // Include the fallback-native signature even on a managed route: native
        // session construction still precedes the qualified replacement hook.
        const modelRevision = sha256Text(canonicalJson({ mode: input.mode, nativeRevision,
          managedRevision: selected.kind === "managed" ? selected.selectionRevision : null }));
        const after = readBoundedJsonSync(join(input.durableRoot, "config.json"));
        if (canonicalJson(after) !== canonicalJson(before)) return unavailable("configuration_changed");
        if (selected.kind === "managed") {
          const again = captureHostManagedSelection(input.durableRoot, agentId);
          if (again.kind !== "managed" || again.selectionRevision !== selected.selectionRevision) return unavailable("configuration_changed");
        } else if (input.mode === "route" && captureHostManagedSelection(input.durableRoot, agentId).kind !== "official") return unavailable("configuration_changed");
        return { ...base, state: "observed", selection: selected.kind === "managed" ? "managed" : "native", modelRevision, reason: "selected" };
      } catch { return unavailable("selection_unavailable"); }
    },
  };
}
