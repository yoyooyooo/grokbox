import type { ObservationGap, RuntimeStatusFacets } from "@grokbox/runtime-kernel/status";

export type SystemHostView = {
  component: "official-host";
  observedAt: string;
  origin: "official" | "grokbox-attested" | "grokbox-unattested" | "ambiguous" | null;
  actual: "official" | "identity" | "route" | "patched-unknown" | "unknown";
  gap: ObservationGap;
  lifecycleOwner: "official-supervisor";
};
export type SystemIntegrationView = {
  component: "host-integration";
  observedAt: string;
  bridge: RuntimeStatusFacets["facets"]["bridge"];
  controller: RuntimeStatusFacets["facets"]["controller"];
  recovery: RuntimeStatusFacets["facets"]["recovery"];
  circuit: RuntimeStatusFacets["circuit"];
};
export type IntegrationOperationView = {
  operationId: string;
  state: "reserved" | "running" | "unknown" | "terminal";
  effects: { signaled: boolean; spawned: boolean; guardian: boolean } | null;
  owner: "original-controller";
  replayAuthorized: false;
};
export type IntegrationReconciliationView = {
  operation: IntegrationOperationView;
  observation: SystemIntegrationView;
  reconciliation: "observation-only";
};

function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function keys(v: Record<string, unknown>, names: string[]) { return Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k)); }
const gaps: readonly unknown[] = [null, "missing", "invalid", "unavailable", "partial", "truncated", "unsupported_schema"];
const desiredModes: readonly unknown[] = [null, "disabled", "observe", "identity", "route"];
const pendingStates: readonly unknown[] = [null, true, false];
const actuals: readonly unknown[] = ["official", "identity", "route", "patched-unknown", "unknown"];
const origins: readonly unknown[] = [null, "official", "grokbox-attested", "grokbox-unattested", "ambiguous"];
const time = (v: unknown) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const reason = (v: unknown) => v === null || typeof v === "string" && /^[a-z0-9_:-]{1,100}$/i.test(v);
function facet(v: unknown, value: (v: unknown) => boolean) {
  return record(v) && keys(v, ["source", "observedAt", "gap", "value"])
    && typeof v.source === "string" && v.source.length <= 160 && (v.observedAt === null || time(v.observedAt))
    && gaps.includes(v.gap) && (v.value === null || value(v.value));
}
export function systemHostView(v: unknown): v is SystemHostView {
  return record(v) && keys(v, ["component", "observedAt", "origin", "actual", "gap", "lifecycleOwner"])
    && v.component === "official-host" && time(v.observedAt) && origins.includes(v.origin)
    && actuals.includes(v.actual) && gaps.includes(v.gap) && v.lifecycleOwner === "official-supervisor";
}
export function systemIntegrationView(v: unknown): v is SystemIntegrationView {
  return record(v) && keys(v, ["component", "observedAt", "bridge", "controller", "recovery", "circuit"])
    && v.component === "host-integration" && time(v.observedAt)
    && facet(v.bridge, b => record(b) && keys(b, ["desired", "actual", "origin", "coverage", "reason"])
      && desiredModes.includes(b.desired) && actuals.includes(b.actual)
      && origins.includes(b.origin) && ["none", "window-open", "attested", "unknown"].includes(String(b.coverage)) && reason(b.reason))
    && facet(v.controller, b => record(b) && keys(b, ["liveness"]) && ["unknown", "alive", "stopped"].includes(String(b.liveness)))
    && facet(v.recovery, b => record(b) && keys(b, ["state", "pending"])
      && ["clear", "recovery-required", "unknown"].includes(String(b.state)) && pendingStates.includes(b.pending))
    && facet(v.circuit, b => record(b) && keys(b, ["state", "reason"]) && ["open", "closed"].includes(String(b.state)) && reason(b.reason));
}
export function integrationOperationView(v: unknown): v is IntegrationOperationView {
  return record(v) && keys(v, ["operationId", "state", "effects", "owner", "replayAuthorized"])
    && typeof v.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.operationId)
    && ["reserved", "running", "unknown", "terminal"].includes(String(v.state))
    && (v.effects === null || record(v.effects) && keys(v.effects, ["signaled", "spawned", "guardian"])
      && typeof v.effects.signaled === "boolean" && typeof v.effects.spawned === "boolean" && typeof v.effects.guardian === "boolean")
    && v.owner === "original-controller" && v.replayAuthorized === false;
}
export function integrationReconciliationView(v: unknown): v is IntegrationReconciliationView {
  return record(v) && keys(v, ["operation", "observation", "reconciliation"])
    && integrationOperationView(v.operation) && systemIntegrationView(v.observation) && v.reconciliation === "observation-only";
}
