import { Effect } from "effect";
import { normalizeAccessChange, UUID } from "@grokbox/client/contract";
import { ConfigError } from "@grokbox/runtime-kernel/config";
import { openManagementAccess } from "@grokbox/box-runtime/runtime";
import type { SystemConfigDomain } from "./system-config.ts";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
export function accessApplication(domain: SystemConfigDomain, principal: Principal, method: string, url: URL, input: unknown) {
  return Effect.gen(function* () {
    if (url.search) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Access endpoints do not accept query parameters."));
    const store = openManagementAccess(domain.root, domain.installationId);
    const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
    if (method === "GET" && url.pathname === "/v1/access") {
      yield* Effect.try({ try: () => requireCapability(principal, "system.access.read"), catch: error => error });
      return yield* attempt(store.view);
    }
    // Only the installation owner can issue/revoke credentials or read their
    // receipts. Ordinary delegated operations remain principal-scoped.
    if (principal.id !== "installation-owner") return yield* Effect.fail(new HttpFailure(403, "permission_denied", "Access administration requires the installation owner."));
    const lookup = /^\/v1\/access-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && lookup) {
      yield* Effect.try({ try: () => requireCapability(principal, "operations.read"), catch: error => error });
      if (!UUID.test(lookup[1]!)) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Invalid access request UUID."));
      const receipt = yield* attempt(() => store.receipt(lookup[1]!.toLowerCase()));
      if (!receipt) return yield* Effect.fail(new HttpFailure(404, "not_found", "No access receipt exists for this request."));
      return receipt;
    }
    if (method === "POST" && url.pathname === "/v1/access-changes") {
      yield* Effect.try({ try: () => requireCapability(principal, "system.access.write"), catch: error => error });
      const request = yield* Effect.try({ try: () => normalizeAccessChange(input), catch: error => error });
      return yield* store.change(request, () => domain.authorize(new AbortController().signal, "system.access.write"));
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The access endpoint does not exist."));
  }).pipe(Effect.mapError(error => error instanceof ConfigError
    ? new HttpFailure(error.code === "config_conflict" || error.code === "config_idempotency_conflict" ? 409 : 503, error.code === "config_idempotency_conflict" ? "idempotency_conflict" : error.code === "config_conflict" ? "revision_conflict" : "unavailable", "Access policy publication was refused; inspect its original receipt before retrying.") : error));
}
