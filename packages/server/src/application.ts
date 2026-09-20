import { Effect } from "effect";
import {
  API_VERSION, UUID, botIdFromRef, botRef, type BotModelView, type DefaultModelView,
  type ManagementIdentity, type ModelList, type ModelView, type ManagementServiceView, type NotificationWorkerView,
} from "@grokbox/client/contract";
import { ModelConfiguration } from "@grokbox/runtime-kernel/ports";
import { readModelOperation, runModelChange } from "@grokbox/runtime-kernel/commands";
import { assignmentForBot, parseApiKeyRef, requireModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { managedModelAdmission, type createManagementGateway } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { botQuery } from "./bots.ts";
import { boundedPage, pageInput } from "./pagination.ts";
import { observationPaths, observationQuery, type ManagementObservations } from "./observations.ts";
import { incidentApplication } from "./incidents.ts";
import { materialApplication, type MaterialApplicationDomain } from "./materials.ts";
import { notificationManagement, type NotificationDomain } from "./notification-management.ts";
import { notificationSetup } from "./notification-setup.ts";
import { protectionApplication, type ProtectionDomain } from "./protection.ts";
import { lifecycleApplication, type LifecycleDomain } from "./lifecycle.ts";
import { contextApplication, type ContextDomain } from "./context.ts";

export type ManagementNative = Pick<ReturnType<typeof createManagementGateway>, "listBots" | "ownershipRead">
  & Partial<Pick<ReturnType<typeof createManagementGateway>, "readNotificationReceiver" | "routineAccess" | "continuityAccess">>;
import { hostHealthQuery } from "./host-health.ts";
import type { HostHealthStatus } from "@grokbox/box-runtime/runtime";
export type ApplicationOptions = { hostHealthState?:()=>HostHealthStatus; contextDomain?: ContextDomain; lifecycleDomain?: LifecycleDomain; protectionDomain?: ProtectionDomain; materialDomain?: MaterialApplicationDomain; installationId: string; native: ManagementNative; observations?: ManagementObservations; serviceState?: () => ManagementServiceView; notificationState?: () => NotificationWorkerView; notificationDomain?: NotificationDomain; env?: NodeJS.Dict<string>; fetch?: typeof fetch };
export function projectModel(record: ModelRecord): ModelView {
  let endpoint: string | null = null;
  try {
    const url = new URL(record.endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") endpoint = `${url.origin}${url.pathname}`;
  } catch { /* Non-network records have no public endpoint. */ }
  const source = record.apiKeyRef ? parseApiKeyRef(record.apiKeyRef).kind : "none";
  return { id: record.id, provider: record.provider, model: record.model, alias: record.alias ?? null, endpoint,
    configurationSource: record.id === "stub/echo" ? "builtin" : record.catalog === "pi" ? "pi" : "local",
    capabilities: record.capabilities, contextWindowTokens: record.contextWindowTokens ?? null,
    credential: { configured: Boolean(record.apiKeyRef), source } };
}
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: error => error });
function invalid(message = "Invalid management request."): HttpFailure { return new HttpFailure(400, "invalid_input", message); }
function noQuery(url: URL): void { if (url.search) throw invalid("This endpoint does not accept query parameters."); }
function segment(value: string): string {
  try { return decodeURIComponent(value); } catch { throw invalid(); }
}

/** Transport-independent application dispatch. Request fields never choose a
 * provider RPC or a writer; every mutation enters its domain's one program. */
export function application(options: ApplicationOptions, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const path = url.pathname;
    if(path==="/v1/host-health")return yield* hostHealthQuery(options.installationId,options.hostHealthState,principal,method,url);
    if (path.startsWith("/v1/contexts/") || path.startsWith("/v1/context-")) {
      if (!options.contextDomain) return yield* Effect.fail(new HttpFailure(503, "unavailable", "Current-state management is unavailable."));
      return yield* contextApplication(options.contextDomain, principal, method, url, input);
    }
    if (path.startsWith("/v1/lifecycle-")) {
      if (!options.lifecycleDomain) return yield* Effect.fail(new HttpFailure(503, "unavailable", "Lifecycle management is unavailable."));
      return yield* lifecycleApplication(options.lifecycleDomain, principal, method, url, input);
    }
    const caller = { installationId: options.installationId, principalId: principal.id };
    if (path === "/v1/protection" || path.startsWith("/v1/protection/") || path.startsWith("/v1/protection-")) {
      if (!options.protectionDomain) return yield* Effect.fail(new HttpFailure(503,"unavailable","Protection management is unavailable."));
      return yield* protectionApplication(options.protectionDomain,principal,method,url,input);
    }
    if (path === "/v1/materials" || path.startsWith("/v1/material-")) {
      if (!options.materialDomain) return yield* Effect.fail(new HttpFailure(503,"source_unavailable","Material management is unavailable."));
      return yield* materialApplication(options.materialDomain, principal, method, url, input);
    }
    if (path === "/v1/incident-changes" || path.startsWith("/v1/incident-operations/") || path.startsWith("/v1/incidents/")) {
      return yield* incidentApplication(options.installationId, options.observations, principal, method, url, input);
    }
    if (method === "GET" && observationPaths.has(path)) return yield* observationQuery(options.installationId, options.observations, principal, url);
    if (path === "/v1/notification-settings" || path.startsWith("/v1/notification-blueprint/") || path === "/v1/setup-changes"
      || path.startsWith("/v1/setup-operations/") || path === "/v1/routines" || path.startsWith("/v1/routines/")) {
      if (!options.notificationDomain) return yield* Effect.fail(new HttpFailure(503, "source_unavailable", "Setup management is unavailable."));
      return yield* notificationSetup({ root: options.notificationDomain.root, installationId: options.installationId, routineAccess: options.native.routineAccess }, principal, method, url, input);
    }
    if (path.startsWith("/v1/notification-") && path !== "/v1/notification-worker" || path === "/v1/notifications" || path.startsWith("/v1/notifications/")) {
      if (!options.notificationDomain) return yield* Effect.fail(new HttpFailure(503, "source_unavailable", "Notification management is unavailable."));
      return yield* notificationManagement(options.notificationDomain, principal, method, url, input);
    }
    if (method === "GET" && path === "/v1/notification-worker") {
      yield* checked(() => { noQuery(url); requireCapability(principal, "notifications.read"); });
      if (!options.notificationState) return yield* Effect.fail(new HttpFailure(503, "unavailable", "The notification worker status is unavailable."));
      return yield* checked(options.notificationState);
    }
    if (method === "GET" && path === "/v1/service") {
      yield* checked(() => { noQuery(url); requireCapability(principal, "system.read"); });
      if (!options.serviceState) return yield* Effect.fail(new HttpFailure(503, "unavailable", "The management process status is unavailable."));
      return yield* checked(options.serviceState);
    }
    if (method === "GET" && path === "/v1/identity") {
      yield* checked(() => noQuery(url));
      return { installationId: options.installationId, principalId: principal.id, capabilities: [...principal.capabilities], apiVersion: API_VERSION } satisfies ManagementIdentity;
    }
    const botModel = /^\/v1\/bots\/([^/]+)\/model$/.exec(path);
    if (method === "GET" && botModel) {
      yield* checked(() => { noQuery(url); requireCapability(principal, "models.read"); });
      const id = yield* checked(() => botIdFromRef(segment(botModel[1]!), options.installationId));
      const current = yield* (yield* ModelConfiguration).read();
      const selection = Object.hasOwn(current.models.assignments.agents, id) ? current.models.assignments.agents[id] : undefined;
      const effective = assignmentForBot(current.models, id);
      return {
        botRef: botRef(options.installationId, id), revision: current.revision,
        selection: !selection ? { kind: "native" } : selection.modelId === undefined ? { kind: "default" } : { kind: "model", ...selection },
        effectiveModel: effective ? { modelId: effective.modelId, reasoning: effective.reasoning ?? null } : null,
        effectiveWhen: "next-turn", currentTurn: "not-observed", source: "model-configuration",
      } satisfies BotModelView;
    }
    if (method === "GET" && (path === "/v1/bots" || /^\/v1\/bots\/[^/]+$/.test(path))) return yield* botQuery(options, principal, url);
    if (method === "GET" && path === "/v1/model-default") {
      yield* checked(() => { noQuery(url); requireCapability(principal, "models.read"); });
      const current = yield* (yield* ModelConfiguration).read();
      return { selection: current.models.assignments.main, revision: current.revision } satisfies DefaultModelView;
    }
    if (method === "GET" && path === "/v1/models") {
      const page = yield* checked(() => { requireCapability(principal, "models.read"); return pageInput(url); });
      const current = yield* (yield* ModelConfiguration).read();
      const records = Object.values(current.models.models).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const result = yield* checked(() => boundedPage(records, page, options.installationId, current.revision, projectModel));
      return { models: result.items, revision: current.revision, total: result.total, nextCursor: result.nextCursor, pageBound: result.pageBound } satisfies ModelList;
    }
    const model = /^\/v1\/models\/([^/]+)$/.exec(path);
    if (method === "GET" && model) {
      const id = yield* checked(() => {
        noQuery(url); requireCapability(principal, "models.read");
        const value = segment(model[1]!);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw invalid();
        return value;
      });
      const current = yield* (yield* ModelConfiguration).read();
      if (!Object.hasOwn(current.models.models, id) && id !== "stub/echo") return yield* Effect.fail(new HttpFailure(404, "not_found", "The model is not configured."));
      return { model: projectModel(requireModel(current.models, id)), revision: current.revision };
    }
    const operation = /^\/v1\/model-operations\/([^/]+)$/.exec(path);
    if (method === "GET" && operation) {
      const id = yield* checked(() => {
        noQuery(url); requireCapability(principal, "operations.read");
        const value = segment(operation[1]!);
        if (!UUID.test(value)) throw invalid();
        return value;
      });
      const result = yield* readModelOperation(caller, id);
      if (!result) return yield* Effect.fail(new HttpFailure(404, "not_found", "No model operation was found for this principal and request ID."));
      return result;
    }
    if (method === "POST" && path === "/v1/model-changes") {
      yield* checked(() => { noQuery(url); requireCapability(principal, "models.write"); });
      return yield* runModelChange(caller, input, managedModelAdmission({ ownershipRead: options.native.ownershipRead, env: options.env, fetch: options.fetch }));
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The management endpoint is not available."));
  });
}
