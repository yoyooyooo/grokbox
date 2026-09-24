import { Effect } from "effect";
import { projectLiveStatus, readControllerOperation, type RuntimeStatus } from "@grokbox/box-runtime/runtime";
import type { OperationRecord } from "@grokbox/runtime-kernel/ports";
import {
  systemHostView, systemIntegrationView, integrationOperationView, integrationReconciliationView,
  type SystemHostView, type SystemIntegrationView, type IntegrationOperationView, type IntegrationReconciliationView,
} from "@grokbox/client/contract";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type SystemIntegrationDomain = {
  root: string;
  runRoot?: string;
  readStatus?: () => Promise<RuntimeStatus>;
  readOperation?: (operationId: string) => OperationRecord | null;
};
export function projectSystemHost(status: RuntimeStatus): SystemHostView {
  return {
    component: "official-host", observedAt: status.observedAt, origin: status.facets.bridge.value?.origin ?? null,
    actual: status.facets.bridge.value?.actual ?? "unknown", gap: status.facets.bridge.gap,
    lifecycleOwner: "official-supervisor",
  };
}
export function projectSystemIntegration(status: RuntimeStatus): SystemIntegrationView {
  return { component: "host-integration", observedAt: status.observedAt,
    bridge: status.facets.bridge, controller: status.facets.controller,
    recovery: status.facets.recovery, circuit: status.circuit };
}
export function systemIntegrationQuery(domain: SystemIntegrationDomain, principal: Principal, method: string, url: URL) {
  return Effect.tryPromise({
    try: async (): Promise<SystemHostView | SystemIntegrationView | IntegrationOperationView | IntegrationReconciliationView> => {
      requireCapability(principal, "system.read");
      if (method !== "GET" || url.search) throw new HttpFailure(400, "invalid_input", "This endpoint accepts a read without query parameters.");
      const observe = () => domain.readStatus?.() ?? projectLiveStatus({ root: domain.root, ephemeralRoot: domain.runRoot });
      if (url.pathname === "/v1/system/host") {
        const view = projectSystemHost(await observe());
        if (!systemHostView(view)) throw new HttpFailure(503, "unavailable", "Host observation is unavailable.");
        return view;
      }
      if (url.pathname === "/v1/system/integration") {
        const view = projectSystemIntegration(await observe());
        if (!systemIntegrationView(view)) throw new HttpFailure(503, "unavailable", "Integration observation is unavailable.");
        return view;
      }
      const match = /^\/v1\/system\/integration\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})(\/reconciliation)?$/.exec(url.pathname);
      if (!match) throw new HttpFailure(404, "not_found", "System management resource not found.");
      requireCapability(principal, "operations.read");
      // Historical controller records predate principal scoping. Only the
      // installation owner can inspect these records; a guessed identity grants nothing.
      if (principal.id !== "installation-owner") throw new HttpFailure(403, "permission_denied", "Original controller operations require installation owner access.");
      let row: OperationRecord | null;
      try { row = domain.readOperation ? domain.readOperation(match[1]!) : readControllerOperation(domain.root, match[1]!); }
      catch { throw new HttpFailure(503, "unavailable", "The original controller journal is unavailable."); }
      if (!row) throw new HttpFailure(404, "not_found", "Original controller operation not found.");
      const operation: IntegrationOperationView = { operationId: match[1]!, state: row.state,
        effects: row.prefix ? { ...row.prefix } : null, owner: "original-controller", replayAuthorized: false };
      if (!integrationOperationView(operation)) throw new HttpFailure(503, "unavailable", "Original controller receipt is unavailable.");
      if (!match[2]) return operation;
      const reconciliation: IntegrationReconciliationView = { operation,
        observation: projectSystemIntegration(await observe()), reconciliation: "observation-only" };
      if (!integrationReconciliationView(reconciliation)) throw new HttpFailure(503, "unavailable", "Integration observation is unavailable.");
      return reconciliation;
    },
    catch: error => error,
  });
}
