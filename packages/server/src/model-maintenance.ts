import { Effect } from "effect";
import { ModelConfiguration } from "@grokbox/runtime-kernel/ports";
import { requireModel, parseApiKeyRef, modelReferences } from "@grokbox/runtime-kernel/selection";
import { normalizeModelCredential, UUID } from "@grokbox/client/contract";
import { openModelCredentialManagement, openModelProbe, type RuntimeStore } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import type { SystemConfigDomain } from "./system-config.ts";
export function modelMaintenance(domain: SystemConfigDomain & { store: RuntimeStore }, principal: Principal, method: string, url: URL, input: unknown) {
  return Effect.gen(function* () {
    if (url.search) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Model maintenance does not accept query parameters."));
    const read = /^\/v1\/models\/([^/]+)\/(check|credential)$/.exec(url.pathname);
    if (method === "GET" && read) {
      yield* Effect.try({ try: () => requireCapability(principal, "models.read"), catch: error => error });
      const id = yield* Effect.try({ try: () => decodeURIComponent(read[1]!), catch: () => new HttpFailure(400, "invalid_input", "Invalid model identity.") });
      const current = yield* (yield* ModelConfiguration).read();
      if (!Object.hasOwn(current.models.models, id) && id !== "stub/echo") return yield* Effect.fail(new HttpFailure(404, "not_found", "The model does not exist."));
      const model = requireModel(current.models, id);
      const credential = { configured: Boolean(model.apiKeyRef), source: model.apiKeyRef ? parseApiKeyRef(model.apiKeyRef).kind : "none" };
      if (read[2] === "credential") return { modelId: id, revision: current.revision, credential, secretReturned: false };
      return { modelId: id, revision: current.revision, checked: ["schema", "references"], references: modelReferences(current.models, id),
        providerRequestSent: false, cost: "none", serviceReadiness: "not-checked" };
    }
    if (url.pathname === "/v1/model-probes" || url.pathname.startsWith("/v1/model-probe-operations/")) {
      const probe = openModelProbe({ store: domain.store, installationId: domain.installationId, principalId: principal.id });
      if (method === "POST" && url.pathname === "/v1/model-probes") {
        yield* Effect.try({ try: () => requireCapability(principal, "models.probe"), catch: error => error });
        return yield* probe.effect(input, signal => domain.authorize(signal, "models.probe"));
      }
      const requestId = url.pathname.slice("/v1/model-probe-operations/".length);
      if (method !== "GET" || !UUID.test(requestId)) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Use the original probe request UUID."));
      yield* Effect.try({ try: () => requireCapability(principal, "operations.read"), catch: error => error });
      const receipt = yield* Effect.tryPromise({ try: () => probe.receipt(requestId.toLowerCase()), catch: error => error });
      if (!receipt) return yield* Effect.fail(new HttpFailure(404, "not_found", "No probe receipt exists for this principal and request."));
      return receipt;
    }
    const store = openModelCredentialManagement(domain.store, domain.installationId, principal.id);
    const lookup = /^\/v1\/model-credential-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && lookup) {
      yield* Effect.try({ try: () => requireCapability(principal, "operations.read"), catch: error => error });
      if (!UUID.test(lookup[1]!)) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Invalid credential request UUID."));
      const receipt = yield* Effect.tryPromise({ try: () => store.receipt(lookup[1]!.toLowerCase()), catch: error => error });
      if (!receipt) return yield* Effect.fail(new HttpFailure(404, "not_found", "No credential receipt exists for this principal and request."));
      return receipt;
    }
    if (method === "POST" && url.pathname === "/v1/model-credential-imports") {
      yield* Effect.try({ try: () => requireCapability(principal, "models.credentials.import"), catch: error => error });
      if (principal.id !== "installation-owner") return yield* Effect.fail(new HttpFailure(403, "permission_denied", "Credential import requires the installation owner."));
      const request = yield* Effect.try({ try: () => normalizeModelCredential(input), catch: error => error });
      return yield* store.change(request, () => domain.authorize(new AbortController().signal, "models.credentials.import"));
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The model maintenance endpoint does not exist."));
  });
}
