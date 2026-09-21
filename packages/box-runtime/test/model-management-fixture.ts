import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { runModelChange } from "@grokbox/runtime-kernel/commands";
import { modelConfigurationRevision, type ModelChange, type ModelCaller } from "@grokbox/runtime-kernel/model-management";
import type { RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { modelConfigurationLayer } from "../src/internal/io/model-management.node.ts";
import { managedModelAdmission } from "../src/internal/roots/model-management.runtime.ts";
export const MODEL_CALLER: ModelCaller = { installationId: "11111111-1111-4111-8111-111111111111", principalId: "test-owner" };
/** Test composition of the same public domain program and production adapters.
 * This supplies explicit requests, not a compatibility selection implementation. */
export async function submitModelChange(input: { store: RuntimeStore; change: ModelChange; requestId?: string; expectedRevision?: string; signal?: AbortSignal }
  & Parameters<typeof managedModelAdmission>[0]) {
  input.signal?.throwIfAborted();
  const request = { requestId: input.requestId ?? randomUUID(), expectedRevision: input.expectedRevision ?? modelConfigurationRevision(await input.store.loadModels()), change: input.change };
  return Effect.runPromise(runModelChange(MODEL_CALLER, request, managedModelAdmission(input)).pipe(Effect.provide(modelConfigurationLayer(input.store))), { signal: input.signal });
}
