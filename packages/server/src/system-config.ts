import { Effect } from "effect";
import { normalizeSystemConfigChange, type SystemConfigReceipt, type SystemConfigView, UUID, type Capability } from "@grokbox/client/contract";
import { ConfigError, redactConfig, portableConfig, isObject } from "@grokbox/runtime-kernel/config";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { openConfigStore, rootConfigLayout } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
export type SystemConfigDomain = { root: string; installationId: string; authorize: (signal: AbortSignal, capability: Capability) => Promise<void> };
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
function failure(error: unknown): unknown {
  if (!(error instanceof ConfigError)) return error;
  if (error.code === "config_idempotency_conflict") return new HttpFailure(409, "idempotency_conflict", "This config request UUID already names another input.");
  return new HttpFailure(error.code === "config_conflict" ? 409 : error.code === "config_commit_unknown" ? 503 : 400,
    error.code === "config_conflict" ? "revision_conflict" : error.code === "config_commit_unknown" ? "operation_unknown" : "invalid_input",
    error.code === "config_commit_unknown" ? "The original config publication is uncertain; inspect its retained receipt." : "The config request did not pass canonical validation.");
}
export function systemConfigApplication(domain: SystemConfigDomain, principal: Principal, method: string, url: URL, input: unknown) {
  return Effect.gen(function* () {
    if (url.search) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Config endpoints do not accept query parameters."));
    const store = openConfigStore(rootConfigLayout(domain.root));
    const operationKey = (id: string) => `management:${sha256Text(`${domain.installationId}:${principal.id}:${id}`)}`;
    if (method === "GET" && ["/v1/system-config", "/v1/system-config/export"].includes(url.pathname)) {
      yield* Effect.try({ try: () => requireCapability(principal, "system.config.read"), catch: error => error });
      const current = yield* attempt(store.read);
      const redacted = redactConfig(url.pathname.endsWith("/export") ? portableConfig(current.document) : current.document);
      if (!isObject(redacted)) return yield* Effect.fail(new HttpFailure(503, "unavailable", "Config projection is unavailable."));
      // Client connections and private security state belong to other owners.
      const { client: _client, ...document } = redacted;
      return { revision: current.revision, document, application: "not-observed", grantsIncluded: false } satisfies SystemConfigView;
    }
    const lookup = /^\/v1\/system-config-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && lookup) {
      yield* Effect.try({ try: () => requireCapability(principal, "operations.read"), catch: error => error });
      const id = lookup[1]!;
      if (!UUID.test(id)) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Invalid config request UUID."));
      const receipt = yield* attempt(() => store.receipt(operationKey(id.toLowerCase())));
      if (!receipt) return yield* Effect.fail(new HttpFailure(404, "not_found", "No config receipt exists for this principal and request."));
      return { requestId: id.toLowerCase(), revision: receipt.configRevision, commit: receipt.commit, changedPaths: receipt.changedPaths, application: receipt.application } satisfies SystemConfigReceipt;
    }
    if (method === "POST" && url.pathname === "/v1/system-config-changes") {
      yield* Effect.try({ try: () => requireCapability(principal, "system.config.write"), catch: error => error });
      // A generic cross-domain writer is installation-owner only. Delegated
      // principals use their narrow existing domain APIs and permissions.
      if (principal.id !== "installation-owner") return yield* Effect.fail(new HttpFailure(403, "permission_denied", "Cross-domain config is restricted to the installation owner."));
      const request = yield* Effect.try({ try: () => normalizeSystemConfigChange(input), catch: error => error });
      const receipt = yield* store.change({ operationId: operationKey(request.requestId), scope: "target", kind: "domain",
        domain: request.domain, mode: request.mode, ...(request.mode === "reset" ? {} : { value: request.value }),
        expectedRevision: request.expectedRevision, confirm: true, replaceArrays: true },
        () => domain.authorize(new AbortController().signal, "system.config.write"));
      return { requestId: request.requestId, revision: receipt.configRevision, commit: receipt.commit, changedPaths: receipt.changedPaths, application: receipt.application } satisfies SystemConfigReceipt;
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The config endpoint does not exist."));
  }).pipe(Effect.mapError(failure));
}
