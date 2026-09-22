import {
  API_VERSION, API_ERROR_CODES, CAPABILITIES, ManagementClientError, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, UUID, botIdFromRef, botIdForQuery, normalizeBotQuery,
  type ApiReply, type BotList, type BotResolution, type BotModelView, type BotView, type DefaultModelView, type ManagementIdentity,
  type ModelChangeRequest, type ModelList, type ModelOperation, type ModelView, type ConsoleGrant, type ConsoleSession,
  incidentIdentity, normalizeIncidentChange, type IncidentChangeRequest, type IncidentDetail, type IncidentOperation,
  type ObservationSnapshot, type IncidentList, type ObservationEventPage, type ManagementServiceView,
} from "./contract.ts";
export * from "./contract.ts";
import { DesktopError, DESKTOP_UUID, normalizeDesktopPolicy, normalizeDesktopPrune, validDesktopOperation, type DesktopView, type DesktopOperation, type DesktopPolicyReceipt, type DesktopPolicyRequest, type DesktopPruneRequest } from "@grokbox/runtime-kernel/desktop";
import { desktopView, desktopPolicyReceipt } from "./desktop-validation.ts";
const desktopInput = <A>(read: () => A): A => { try { return read(); } catch (e) { if (e instanceof DesktopError) throw new ManagementClientError(e.code, e.message); throw e; } };
import { FileError, FILE_UUID, fileData, fileIdentity, normalizeFileChange, normalizeFileUploadChunk, normalizeFileUploadControl, validFileOperation,
  type FileRootsView, type FileEntry, type FileDirectory, type FileRead, type FileOperation, type FileChange, type FileUpload, type FileUploadChunk, type FileUploadControl, type FileDownload, type FileDownloadChunk } from "@grokbox/runtime-kernel/files";
import { fileRoots, fileEntry, fileDirectory, fileRead, fileUpload, fileDownload, fileDownloadChunk, verifyFileBytes } from "./file-validation.ts";
const fileInput = <A>(f:()=>A):A => { try { return f(); } catch(e) { if(e instanceof FileError)throw new ManagementClientError(e.code,e.message);throw e; } };
import { normalizeJobStart, normalizeJobCancel, jobIdentity, type JobStart, type JobCancel, type JobView, type JobPage, type JobPolicyView, type JobLogPage, type JobCancelReceipt } from "./job-contract.ts";
import { jobPolicy, jobView, jobLogs, jobCancellation } from "./job-validation.ts";
import { hostHealthView, type HostHealthView } from "./host-health-contract.ts";
import { normalizeContextChange, normalizeContextContinuation, contextOperationIdentity, contextOperationRef, type ContextChange, type ContextContinuation, type ContextView, type ContextOperation } from "./context-contract.ts";
import { contextView, contextOperation } from "./context-validation.ts";
import { normalizeHandoverChange, normalizeHandoverContinuation, handoverOperation, type HandoverChange, type HandoverContinuation, type HandoverOperation } from "./handover-contract.ts";
import { contextManualApprovalKey } from "@grokbox/runtime-kernel/compaction";
import { normalizeCompactionChange, normalizeCompactionContinuation, compactionPreview, compactionOperation,
  type CompactionChange, type CompactionContinuation, type CompactionPreview, type CompactionOperation } from "./compaction-contract.ts";
import { normalizeLifecycleIntent, normalizeLifecycleSubmission, normalizeLifecycleResume, lifecycleReference, lifecycleIdentity,
  type LifecycleIntent, type LifecycleSubmission, type LifecycleResume, type LifecyclePreview, type LifecycleOperation, type LifecycleList } from "./lifecycle-contract.ts";
import { lifecyclePreview, lifecycleOperation, lifecycleList } from "./lifecycle-validation.ts";
import { normalizeProtectionChange, protectionReferenceIdentity, type ProtectionChangeRequest, type ProtectionOverview, type ProtectionBotView,
  type ProtectionOperation, type ProtectionSnapshot, type ProtectionSnapshotList, type ProtectionHandover } from "./protection-contract.ts";
import { protectionOverview, protectionBot, protectionOperation, protectionSnapshot, protectionSnapshots, protectionHandover } from "./protection-validation.ts";
import { MaterialError, materialIdentity, normalizeMaterialQuery, normalizeMaterialWrite, type MaterialQuery, type MaterialPage, type MaterialRead, type MaterialStatus, type MaterialWrite, type MaterialOperation } from "./contract.ts";
import { materialStatus, materialPage, materialRead, materialOperation } from "./material-validation.ts";
const materialInput = <A>(read: () => A): A => { try { return read(); } catch (e) { if (e instanceof MaterialError) throw new ManagementClientError(e.code,e.reason); throw e; } };
import { notificationIdentity, normalizeReceiverChange, type ReceiverChangeRequest, type ReceiverList, type ReceiverView, type ReceiverOperation,
  type ReceiverVerification, type NotificationView, type NotificationList, type NotificationTestOperation } from "./contract.ts";
import { receiverView, receiverOperation, notificationView, notificationTestOperation } from "./receiver-validation.ts";
import { normalizeNotificationSend, type NotificationSendRequest, type NotificationSendOperation } from "./notification-send-contract.ts";
import { notificationSendOperation } from "./notification-send-validation.ts";
import { normalizeSetupRequest, routineIdentity, routineReference, setupKind, type SetupRequest, type SetupKind, type SetupOperation,
  type NotificationSettingsView, type RoutineList, type RoutineBlueprint } from "./contract.ts";
import { settingsView, blueprintView, routineList, setupOperation } from "./setup-validation.ts";
import type { NotificationWorkerView } from "./notification-contract.ts";
import { notificationWorker } from "./notification-validation.ts";

import { record, exact, revision, operation, model, modelId, botRow, botModel, botSource, selectedModel, cursor } from "./response-validation.ts";
import { observationSnapshot, incidentList, observationEvents, managementService } from "./observation-validation.ts";
export { observationSnapshot, incidentList, observationEvents } from "./observation-validation.ts";
import { incidentDetail, incidentOperation } from "./incident-validation.ts";
import { decodeObservationWatch, type ObservationWatchOptions, type ObservationWatchReply } from "./event-watch.ts";
import { eventCursor } from "./observation-validation.ts";
export { decodeObservationWatch } from "./event-watch.ts";
export type { ObservationWatchOptions, ObservationWatchReply } from "./event-watch.ts";
const protocolError = () => new ManagementClientError("protocol_error", "The management service returned an incompatible response.");
const pageBound = (value: unknown): boolean => value === null || value === "count" || value === "bytes";
export type ListOptions = { limit?: number; cursor?: string; signal?: AbortSignal };
function pageQuery(options: ListOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new ManagementClientError("invalid_input", "Invalid page size.");
    query.set("limit", String(options.limit));
  }
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || !options.cursor.length || options.cursor.length > 256) throw new ManagementClientError("invalid_input", "Invalid page cursor.");
    query.set("cursor", options.cursor);
  }
  return query;
}

async function decode(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw protocolError();
  const reader = response.body.getReader(), bytes = new Uint8Array(RESPONSE_MAX_BYTES);
  let total = 0, completed = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) { completed = true; break; }
      if (total + next.value.length > bytes.length) throw protocolError();
      bytes.set(next.value, total); total += next.value.length;
    }
    if (signal.aborted) throw signal.reason;
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))) as unknown; }
    catch { throw protocolError(); }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function resolveCredential(resolve: (signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<string> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return resolve(signal); }), cancelled]);
  } catch {
    throw new ManagementClientError(signal.aborted ? "unavailable" : "authentication_required",
      signal.aborted ? "Credential resolution ended before submission." : "The configured management credential is unavailable.");
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

export type ManagementClientOptions = {
  baseUrl: string;
  installationId?: string;
  credential?: (signal: AbortSignal) => Promise<string>;
  console?: { csrfToken?: () => string | undefined };
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Browser/Node shared transport. One submission, no automatic retry or fallback.
 * Clients persist their request ID before sending and query it after uncertainty. */
export class ManagementClient {
  private readonly baseUrl: string;
  private readonly options: ManagementClientOptions;
  constructor(options: ManagementClientOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); }
    catch { throw new ManagementClientError("invalid_input", "Invalid management endpoint."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || (options.installationId !== undefined && !UUID.test(options.installationId))) {
      throw new ManagementClientError("invalid_input", "Use an explicit management endpoint without credentials or query parameters; nonlocal connections require HTTPS.");
    }
    this.baseUrl = url.origin;
    if (options.console && options.credential) throw new ManagementClientError("invalid_input", "Choose console cookies or a management bearer, not both.");
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new ManagementClientError("invalid_input", "Invalid client request timeout.");
    this.options = Object.freeze({ ...options, installationId: options.installationId?.toLowerCase(),
      console: options.console ? Object.freeze({ ...options.console }) : undefined });
  }

  private async request<T>(path: string, validate: (value: unknown) => boolean, input?: DesktopPolicyRequest | DesktopPruneRequest | FileChange | FileUploadControl | FileUploadChunk | { requestId: string; ref: string } | { requestId: string; generation: string } | JobStart | JobCancel | ModelChangeRequest | IncidentChangeRequest | ReceiverChangeRequest | NotificationSendRequest | SetupRequest | MaterialWrite | ProtectionChangeRequest | LifecycleIntent | LifecycleSubmission | LifecycleResume | ContextChange | ContextContinuation | CompactionChange | CompactionContinuation | HandoverChange | HandoverContinuation | { origin: string } | { code: string } | Record<string, never>, signal?: AbortSignal, authentication = false, lookupPath?: string, readOnlyPost = false): Promise<ApiReply<T> & { ok: true }> {
    if (path !== "/v1/identity" && !this.options.installationId) {
      throw new ManagementClientError("wrong_installation", "Pin the connection to an installation before reading or changing its resources.");
    }
    const mutation = authentication || readOnlyPost ? undefined : input as { requestId: string; expectedRevision?: unknown; planRevision?: unknown; scopeId?: unknown; action?: unknown } | undefined;
    if (mutation !== undefined && (!record(mutation) || !UUID.test(mutation.requestId)
      || !(path === "/v1/file-changes" ? mutation.expectedRevision === null || revision(mutation.expectedRevision) : path === "/v1/file-upload-chunks" || path === "/v1/file-upload-controls" ? true : path === "/v1/job-starts" ? revision(mutation.expectedRevision) : path === "/v1/job-cancellations" ? true : ["/v1/lifecycle-changes", "/v1/lifecycle-resumptions"].includes(path) ? revision(mutation.planRevision) && revision(mutation.scopeId)
        : path === "/v1/desktop-prunes" || path === "/v1/desktop-policy-changes" ? revision(mutation.expectedRevision)
        : path === "/v1/handover-changes" ? revision(mutation.expectedRevision)
        : path === "/v1/handover-continuations" ? revision(mutation.scopeId) && ["resume", "reconcile", "cancel"].includes(String(mutation.action))
        : path === "/v1/context-changes" || path === "/v1/context-compactions" ? revision(mutation.scopeId) && revision(mutation.expectedRevision)
        : path === "/v1/context-compaction-continuations" ? revision(mutation.scopeId) && ["resume", "reconcile", "cancel"].includes(String(mutation.action))
        : path === "/v1/context-continuations" ? revision(mutation.scopeId) && (["resume", "reconcile", "cancel"].includes(String(mutation.action)) || mutation.action === "activate" && revision(mutation.expectedRevision))
        : path === "/v1/setup-changes" ? revision(mutation.expectedRevision) || "action" in mutation && mutation.action === "apply" && mutation.expectedRevision === null
        : ["/v1/material-changes","/v1/protection-changes"].includes(path) ? revision(mutation.expectedRevision) : lookupPath ? Number.isSafeInteger(mutation.expectedRevision) && Number(mutation.expectedRevision) > 0 : revision(mutation.expectedRevision)))) throw new ManagementClientError("invalid_input", "A mutation requires a persisted request UUID and expected revision.");
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const bounded = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let body: string | undefined;
    try { body = input === undefined ? undefined : JSON.stringify(input); }
    catch { throw new ManagementClientError("invalid_input", "The management input must be JSON serializable."); }
    const recovery = mutation ? { requestId: mutation.requestId.toLowerCase(), installationId: this.options.installationId,
      lookupPath: lookupPath ?? `/v1/model-operations/${mutation.requestId.toLowerCase()}` } : undefined;
    if (body !== undefined && new TextEncoder().encode(body).length > REQUEST_MAX_BYTES) throw new ManagementClientError("invalid_input", "The request exceeds the management input bound.");
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.options.installationId) headers.set("x-grokbox-installation-id", this.options.installationId.toLowerCase());
    if (this.options.credential) {
      const credential = await resolveCredential(this.options.credential, bounded);
      if (typeof credential !== "string" || !credential || credential.length > 8192 || /[^\x21-\x7e]/.test(credential)) throw new ManagementClientError("authentication_required", "The configured management credential is unavailable.");
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (this.options.console && body !== undefined && path !== "/v1/console/redeem") {
      const csrf = this.options.console.csrfToken?.();
      if (!csrf || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) throw new ManagementClientError("permission_denied", "Refresh the console session before this action.");
      headers.set("x-grokbox-csrf", csrf);
    }
    if (bounded.aborted) throw new ManagementClientError("unavailable", "The client request ended before submission.");
    let raw: unknown, httpOk = false;
    const invalidReply = () => mutation ? new ManagementClientError("operation_unknown", "The mutation response is not verifiable; query the original request ID.", recovery) : protocolError();
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(`${this.baseUrl}${path}`, {
        method: input ? "POST" : "GET", headers, body, signal: bounded, redirect: "manual", credentials: "same-origin",
      });
      httpOk = response.ok;
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw protocolError(); }
      raw = await decode(response, bounded);
    } catch (error) {
      if (!mutation && error instanceof ManagementClientError) throw error;
      throw new ManagementClientError(mutation ? "operation_unknown" : "unavailable",
        mutation ? "The response was lost; query the original request ID without resubmitting." : authentication ? "The authentication response was lost; inspect the console session without resubmitting." : "The management service is unavailable.",
        recovery);
    }
    if (!record(raw) || raw.schemaVersion !== API_VERSION || typeof raw.installationId !== "string" || !UUID.test(raw.installationId)
      || typeof raw.invocationId !== "string" || !UUID.test(raw.invocationId) || typeof raw.ok !== "boolean" || raw.ok !== httpOk
      || Object.keys(raw).some(key => !["schemaVersion", "installationId", "invocationId", "ok", raw.ok ? "data" : "error"].includes(key))) throw invalidReply();
    if (this.options.installationId && raw.installationId !== this.options.installationId.toLowerCase()) {
      if (mutation && raw.ok) throw invalidReply();
      throw new ManagementClientError("wrong_installation", "The response came from another installation.", recovery);
    }
    if (!raw.ok) {
      if (!record(raw.error) || !API_ERROR_CODES.includes(raw.error.code as never)
        || typeof raw.error.message !== "string" || raw.error.message.length > 4096
        || Object.keys(raw.error).some(key => !["code", "message", "details"].includes(key))
        || (raw.error.details !== undefined && !record(raw.error.details))) throw invalidReply();
      const reply = raw as ApiReply<never> & { ok: false };
      // A settled compaction failure unlocks future user intent, so its exact
      // request/target/approval must be checked just like a successful receipt.
      if (reply.error.code === "desktop_prune_refused" && path === "/v1/desktop-prunes"
        && (!mutation || !validate(reply.error.details?.operation) || !record(reply.error.details?.operation) || reply.error.details.operation.state !== "refused")) throw invalidReply();
      if (reply.error.code === "file_change_refused" && (path === "/v1/file-changes" || path === "/v1/file-upload-controls")
        && (!mutation || !validate(reply.error.details?.operation) || !record(reply.error.details?.operation) || !["refused","cancelled"].includes(String(reply.error.details.operation.state)))) throw invalidReply();
      if (reply.error.code === "compaction_failed" && path.startsWith("/v1/context-compaction")
        && (!mutation || !validate(reply.error.details?.operation) || !record(reply.error.details?.operation) || reply.error.details.operation.state !== "failed")) throw invalidReply();
      if ((reply.error.code === "notification_send_refused" && path === "/v1/notification-sends"
        || reply.error.code === "notification_test_refused" && path === "/v1/notification-tests")
        && (!mutation || !validate(reply.error.details?.operation) || !record(reply.error.details?.operation)
          || reply.error.details.operation.state !== "refused")) throw invalidReply();
      throw new ManagementClientError(reply.error.code, reply.error.message,
        reply.error.code === "operation_unknown" ? { ...reply.error.details, ...recovery } : reply.error.details, reply);
    }
    if (!validate(raw.data)) throw invalidReply();
    return raw as ApiReply<T> & { ok: true };
  }

  desktop(signal?: AbortSignal) { return this.request<DesktopView>("/v1/desktop", v => desktopView(v, this.options.installationId!), undefined, signal); }
  async pruneDesktop(input: DesktopPruneRequest, signal?: AbortSignal) {
    const r = desktopInput(() => normalizeDesktopPrune(input));
    return this.request<DesktopOperation>("/v1/desktop-prunes", v => validDesktopOperation(v, this.options.installationId!, r.requestId) && v.expectedRevision === r.expectedRevision && v.origin === "manual", r, signal, false, `/v1/desktop-operations/${r.requestId}`);
  }
  async changeDesktopPolicy(input: DesktopPolicyRequest, signal?: AbortSignal) {
    const r = desktopInput(() => normalizeDesktopPolicy(input));
    return this.request<DesktopPolicyReceipt>("/v1/desktop-policy-changes", v => desktopPolicyReceipt(v, r.requestId, r.expectedRevision), r, signal, false, `/v1/desktop-policy-operations/${r.requestId}`);
  }
  async desktopOperation(requestId: string, signal?: AbortSignal) {
    if (!DESKTOP_UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Use the original desktop request UUID."); const id = requestId.toLowerCase();
    return this.request<DesktopOperation>(`/v1/desktop-operations/${id}`, v => validDesktopOperation(v, this.options.installationId!, id), undefined, signal);
  }
  async desktopPolicyOperation(requestId: string, signal?: AbortSignal) {
    if (!DESKTOP_UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Use the original desktop policy request UUID."); const id = requestId.toLowerCase();
    return this.request<DesktopPolicyReceipt>(`/v1/desktop-policy-operations/${id}`, v => desktopPolicyReceipt(v, id), undefined, signal);
  }

  fileRoots(signal?:AbortSignal) { return this.request<FileRootsView>("/v1/file-roots",v=>fileRoots(v,this.options.installationId!),undefined,signal); }
  async fileStat(ref:string,signal?:AbortSignal) {
    const t=fileInput(()=>fileIdentity(ref,this.options.installationId!));return this.request<FileEntry>(`/v1/file-stat/${encodeURIComponent(t.ref)}`,v=>fileEntry(v,this.options.installationId!,t.ref)&&v.revision!==null,undefined,signal);
  }
  async fileDirectory(ref:string,options:ListOptions={}) {
    const t=fileInput(()=>fileIdentity(ref,this.options.installationId!)),query=pageQuery(options);
    return this.request<FileDirectory>(`/v1/file-directories/${encodeURIComponent(t.ref)}${query.size?`?${query}`:""}`,v=>fileDirectory(v,this.options.installationId!,t.ref)&&v.entries.length<=(options.limit??100),undefined,options.signal);
  }
  async readFile(ref:string,signal?:AbortSignal) {
    const t=fileInput(()=>fileIdentity(ref,this.options.installationId!));const result=await this.request<FileRead>(`/v1/file-content/${encodeURIComponent(t.ref)}`,v=>fileRead(v,this.options.installationId!,t.ref),undefined,signal);
    if(!await verifyFileBytes(result.data.contentBase64,result.data.sha256))throw new ManagementClientError("protocol_error","The file content digest did not match its receipt.");return result;
  }
  async changeFile(input:FileChange,signal?:AbortSignal) {
    const i=this.options.installationId!,r=fileInput(()=>normalizeFileChange(input,i));
    const digest=r.action==="write"?Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(r.content))),n=>n.toString(16).padStart(2,"0")).join(""):null;
    return this.request<FileOperation|FileUpload>("/v1/file-changes",v=>validFileOperation(v,i,r.requestId,r)&&(v.state!=="succeeded"||digest===null||v.result?.revision===digest)||r.action==="upload"&&fileUpload(v,i,r),r,signal,false,`/v1/file-operations/${r.requestId}`);
  }
  async fileOperation(requestId:string,signal?:AbortSignal) {
    if(!FILE_UUID.test(requestId))throw new ManagementClientError("invalid_input","Use the original file request UUID.");const id=requestId.toLowerCase();
    return this.request<FileOperation>(`/v1/file-operations/${id}`,v=>validFileOperation(v,this.options.installationId!,id),undefined,signal);
  }
  async uploadFileChunk(input:FileUploadChunk,signal?:AbortSignal) {
    const r=fileInput(()=>normalizeFileUploadChunk(input));
    return this.request<{requestId:string;index:number;bytes:number;accepted:true}>("/v1/file-upload-chunks",v=>record(v)&&exact(v,["requestId","index","bytes","accepted"])&&v.requestId===r.requestId&&v.index===r.index&&v.accepted===true&&v.bytes===atob(r.contentBase64).length,r,signal,false,`/v1/file-operations/${r.requestId}`);
  }
  async controlFileUpload(input:FileUploadControl,signal?:AbortSignal) {
    const r=fileInput(()=>normalizeFileUploadControl(input));return this.request<FileOperation>("/v1/file-upload-controls",v=>validFileOperation(v,this.options.installationId!,r.requestId)&&v.action==="upload"&&v.serviceGeneration===r.generation,r,signal,false,`/v1/file-operations/${r.requestId}`);
  }
  async openFileDownload(input:{requestId:string;ref:string},signal?:AbortSignal) {
    const i=this.options.installationId!,r=fileInput(()=>{const d=fileData(input,["requestId","ref"]);if(typeof d.requestId!=="string"||!FILE_UUID.test(d.requestId))throw new FileError("invalid_input","Invalid transfer request UUID.");return {requestId:d.requestId.toLowerCase(),ref:fileIdentity(d.ref,i).ref};});
    return this.request<FileDownload>("/v1/file-downloads",v=>fileDownload(v,i,r.requestId,r.ref),r,signal,false,undefined,true);
  }
  async downloadFileChunk(opened:FileDownload,index:number,signal?:AbortSignal) {
    const r=structuredClone(opened),i=this.options.installationId!;
    if(!fileDownload(r,i,r.requestId,r.ref)||!Number.isSafeInteger(index)||index<0||index>=r.chunks)throw new ManagementClientError("invalid_input","Invalid pinned download cursor.");
    return this.request<FileDownloadChunk>(`/v1/file-download-chunks/${r.requestId}?${new URLSearchParams({generation:r.generation,index:String(index)})}`,v=>fileDownloadChunk(v,r,index),undefined,signal);
  }
  async closeFileDownload(opened:FileDownload,signal?:AbortSignal) {
    const r={requestId:opened.requestId,generation:opened.generation};if(!FILE_UUID.test(r.requestId)||!FILE_UUID.test(r.generation))throw new ManagementClientError("invalid_input","Invalid pinned transfer identity.");
    return this.request<{requestId:string;closed:true}>("/v1/file-download-controls",v=>record(v)&&exact(v,["requestId","closed"])&&v.requestId===r.requestId&&v.closed===true,r,signal,false,undefined,true);
  }

  jobPolicy(signal?: AbortSignal) { return this.request<JobPolicyView>("/v1/job-policy",jobPolicy,undefined,signal); }
  async startJob(input: JobStart, signal?: AbortSignal) {
    const r=normalizeJobStart(input), i=this.options.installationId!;
    return this.request<JobView>("/v1/job-starts",v=>jobView(v,i)&&v.requestId===r.requestId&&v.policyRevision===r.expectedRevision
      &&v.command.shell===r.shell&&v.command.executable===(r.shell?"shell":r.argv[0])&&v.command.argumentCount===(r.shell?1:r.argv.length-1)
      &&v.runTimeoutMs===r.runTimeoutMs&&v.output===r.output&&(r.cwd===undefined||v.cwd===r.cwd),r,signal,false,`/v1/job-operations/${r.requestId}`);
  }
  async jobOperation(requestId: string, signal?: AbortSignal) {
    if(!UUID.test(requestId))throw new ManagementClientError("invalid_input","Use the original Job request UUID.");
    const id=requestId.toLowerCase();return this.request<JobView>(`/v1/job-operations/${id}`,v=>jobView(v,this.options.installationId!)&&v.requestId===id,undefined,signal);
  }
  async job(ref: string, options: {waitMs?:number;signal?:AbortSignal} = {}) {
    const target=jobIdentity(ref,this.options.installationId!),waitMs=options.waitMs??0;
    if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>25000)throw new ManagementClientError("invalid_input","Job waiting is bounded to 25 seconds per observation.");
    return this.request<JobView>(`/v1/jobs/${encodeURIComponent(target.ref)}?waitMs=${waitMs}`,v=>jobView(v,this.options.installationId!)&&v.jobRef===target.ref,undefined,options.signal);
  }
  jobs(options: ListOptions = {}) {
    const query=pageQuery(options),i=this.options.installationId!,limit=options.limit??100;
    return this.request<JobPage>(`/v1/jobs?${query}`,v=>record(v)&&exact(v,["jobs","nextCursor","coverage"])&&v.coverage==="retained-principal-records"
      &&Array.isArray(v.jobs)&&v.jobs.length<=limit&&v.jobs.every(j=>jobView(j,i))&&new Set(v.jobs.map(j=>j.jobRef)).size===v.jobs.length
      &&(v.nextCursor===null||typeof v.nextCursor==="string"&&/^[a-f0-9]{64}:[1-9][0-9]*:[a-f0-9-]{36}$/.test(v.nextCursor)),undefined,options.signal);
  }
  async jobLogs(ref: string, options: {offset?:number;limitBytes?:number;waitMs?:number;signal?:AbortSignal}={}) {
    const target=jobIdentity(ref,this.options.installationId!),offset=options.offset??0,max=options.limitBytes??65536,wait=options.waitMs??0;
    if(!Number.isSafeInteger(offset)||offset<0||max!==65536||!Number.isSafeInteger(wait)||wait<0||wait>25000)throw new ManagementClientError("invalid_input","Use a verified log offset and a bounded output page.");
    return this.request<JobLogPage>(`/v1/jobs/${encodeURIComponent(target.ref)}/logs?offset=${offset}&limitBytes=${max}&waitMs=${wait}`,v=>jobLogs(v,this.options.installationId!,target.ref,offset,max),undefined,options.signal);
  }
  async cancelJob(input: JobCancel, signal?: AbortSignal) {
    const r=normalizeJobCancel(input,this.options.installationId!),target=jobIdentity(r.jobRef,this.options.installationId!);
    return this.request<JobCancelReceipt>("/v1/job-cancellations",v=>jobCancellation(v,this.options.installationId!,target.ref,r.requestId),r,signal,false,`/v1/job-cancellations/${target.id}/${r.requestId}`);
  }
  async jobCancellation(ref: string, requestId: string, signal?: AbortSignal) {
    const target=jobIdentity(ref,this.options.installationId!);if(!UUID.test(requestId))throw new ManagementClientError("invalid_input","Use the original cancellation request UUID.");
    const id=requestId.toLowerCase();return this.request<JobCancelReceipt>(`/v1/job-cancellations/${target.id}/${id}`,v=>jobCancellation(v,this.options.installationId!,target.ref,id),undefined,signal);
  }

  async previewLifecycle(input: LifecycleIntent, signal?: AbortSignal) {
    const intent = normalizeLifecycleIntent(input, this.options.installationId ?? "");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(intent.instructions)));
    const instructionsSha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    return this.request<LifecyclePreview>("/v1/lifecycle-previews", v => lifecyclePreview(v, this.options.installationId!, intent) && v.instructionsSha256 === instructionsSha256, intent, signal, false, undefined, true);
  }
  submitLifecycle(input: LifecycleSubmission, signal?: AbortSignal) {
    const request = normalizeLifecycleSubmission(input, this.options.installationId ?? "");
    const ref = lifecycleReference(this.options.installationId!, request.scopeId, request.requestId);
    return this.request<LifecycleOperation>("/v1/lifecycle-changes", v => lifecycleOperation(v, this.options.installationId!, ref, request.planRevision, request), request, signal, false,
      `/v1/lifecycle-operations/${request.scopeId}/${request.requestId}`);
  }
  resumeLifecycle(input: LifecycleResume, signal?: AbortSignal) {
    const request = normalizeLifecycleResume(input), ref = lifecycleReference(this.options.installationId ?? "", request.scopeId, request.requestId);
    return this.request<LifecycleOperation>("/v1/lifecycle-resumptions", v => lifecycleOperation(v, this.options.installationId!, ref, request.planRevision), request, signal, false,
      `/v1/lifecycle-operations/${request.scopeId}/${request.requestId}`);
  }
  lifecycle(ref: string, signal?: AbortSignal) {
    const target = lifecycleIdentity(ref, this.options.installationId ?? "");
    return this.request<LifecycleOperation>(`/v1/lifecycle-operations/${target.scopeId}/${target.requestId}`, v => lifecycleOperation(v, this.options.installationId!, target.ref), undefined, signal);
  }
  lifecycles(options: ListOptions = {}) {
    const query = pageQuery(options), limit = options.limit ?? 20;
    return this.request<LifecycleList>(`/v1/lifecycle-operations${query.size ? `?${query}` : ""}`, v => lifecycleList(v, this.options.installationId!, limit), undefined, options.signal);
  }

  changeHandover(input: HandoverChange, signal?: AbortSignal) {
    const installation=this.options.installationId??"",r=normalizeHandoverChange(input,installation),ref=protectionReferenceIdentity(r.handoverRef,installation,"handover");
    return this.request<HandoverOperation>("/v1/handover-changes",v=>handoverOperation(v,installation,ref.scopeId,r.requestId)&&v.handoverRef===r.handoverRef&&v.action===r.action&&v.expectedRevision===r.expectedRevision,
      r,signal,false,`/v1/handover-operations/${ref.scopeId}/${r.requestId}`);
  }
  continueHandover(input: HandoverContinuation, signal?: AbortSignal) {
    const installation=this.options.installationId??"",r=normalizeHandoverContinuation(input);
    return this.request<HandoverOperation>("/v1/handover-continuations",v=>handoverOperation(v,installation,r.scopeId,r.requestId),r,signal,false,`/v1/handover-operations/${r.scopeId}/${r.requestId}`);
  }
  handoverOperation(scopeId:string,requestId:string,signal?:AbortSignal) {
    if(!revision(scopeId)||!UUID.test(requestId))throw new ManagementClientError("invalid_input","Use the original handover account scope and request UUID.");
    const installation=this.options.installationId??"",id=requestId.toLowerCase();
    return this.request<HandoverOperation>(`/v1/handover-operations/${scopeId}/${id}`,v=>handoverOperation(v,installation,scopeId,id),undefined,signal);
  }

  async compactionPreview(bot: string, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", id = botIdFromRef(bot, installation);
    const reply = await this.request<CompactionPreview>(`/v1/context-compactions/${id}`, v => compactionPreview(v, installation, id), undefined, signal);
    // Same canonical declaration as the native/server owner; WebCrypto keeps
    // browser revalidation independent of Node-only createHash and SSR caches.
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(contextManualApprovalKey(id, reply.data.approval))));
    const revision = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (reply.data.revision !== revision) throw protocolError();
    return reply;
  }
  compact(input: CompactionChange, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", r = normalizeCompactionChange(input, installation);
    return this.request<CompactionOperation>("/v1/context-compactions", v => compactionOperation(v, installation, r.scopeId, r.requestId)
      && v.botRef === r.botRef && v.expectedRevision === r.expectedRevision, r, signal, false, `/v1/context-compaction-operations/${r.scopeId}/${r.requestId}`);
  }
  continueCompaction(input: CompactionContinuation, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", r = normalizeCompactionContinuation(input, installation);
    return this.request<CompactionOperation>("/v1/context-compaction-continuations", v => compactionOperation(v, installation, r.scopeId, r.requestId)
      && v.botRef === r.botRef, r, signal, false, `/v1/context-compaction-operations/${r.scopeId}/${r.requestId}`);
  }
  compactionOperation(scopeId: string, requestId: string, signal?: AbortSignal) {
    if (!revision(scopeId) || !UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Use the original compaction scope and request UUID.");
    const installation = this.options.installationId ?? "", id = requestId.toLowerCase();
    return this.request<CompactionOperation>(`/v1/context-compaction-operations/${scopeId}/${id}`, v => compactionOperation(v, installation, scopeId, id), undefined, signal);
  }
  context(bot: string, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", id = botIdFromRef(bot, installation), ref = `bot:${installation}:${id}`;
    return this.request<ContextView>(`/v1/contexts/${id}`, v => contextView(v, installation, ref), undefined, signal);
  }
  changeContext(input: ContextChange, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", r = normalizeContextChange(input, installation), ref = contextOperationRef(installation, r.scopeId, r.requestId);
    return this.request<ContextOperation>("/v1/context-changes", v => contextOperation(v, installation, ref, r.botRef, r), r, signal, false, `/v1/context-operations/${r.scopeId}/${r.requestId}`);
  }
  continueContext(input: ContextContinuation, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", r = normalizeContextContinuation(input, installation), ref = contextOperationRef(installation, r.scopeId, r.requestId);
    return this.request<ContextOperation>("/v1/context-continuations", v => contextOperation(v, installation, ref, r.botRef), r, signal, false, `/v1/context-operations/${r.scopeId}/${r.requestId}`);
  }
  contextOperation(ref: string, signal?: AbortSignal) {
    const installation = this.options.installationId ?? "", r = contextOperationIdentity(ref, installation);
    return this.request<ContextOperation>(`/v1/context-operations/${r.scopeId}/${r.requestId}`, v => contextOperation(v, installation, r.ref), undefined, signal);
  }

  hostHealth(signal?: AbortSignal) { return this.request<HostHealthView>("/v1/host-health", v=>hostHealthView(v,this.options.installationId!),undefined,signal); }
  materialStatus(signal?: AbortSignal) { return this.request<MaterialStatus>("/v1/material-status",materialStatus,undefined,signal); }
  materials(options: MaterialQuery & { signal?: AbortSignal } = {}) {
    const { signal, ...input } = options, query = materialInput(() => normalizeMaterialQuery(input));
    const params = new URLSearchParams(); for (const [key,value] of Object.entries(query)) if (value !== undefined) params.set(key,String(value));
    return this.request<MaterialPage>(`/v1/materials${params.size ? `?${params}` : ""}`,v => materialPage(v,this.options.installationId!,query),undefined,signal);
  }
  readMaterial(ref: string, signal?: AbortSignal) {
    const target = materialInput(() => materialIdentity(ref,this.options.installationId ?? ""));
    return this.request<MaterialRead>(`/v1/material-content/${encodeURIComponent(target.ref)}`,v => materialRead(v,this.options.installationId!,target.ref),undefined,signal);
  }
  changeMaterial(input: MaterialWrite, signal?: AbortSignal) {
    const request = materialInput(() => normalizeMaterialWrite(input,this.options.installationId ?? ""));
    return this.request<MaterialOperation>("/v1/material-changes",v => materialOperation(v,this.options.installationId!,request.requestId,request),request,signal,false,`/v1/material-operations/${request.requestId}`);
  }
  materialOperation(requestId: string, signal?: AbortSignal) {
    if (!UUID.test(requestId)) throw new ManagementClientError("invalid_input","Use the original material request UUID.");
    return this.request<MaterialOperation>(`/v1/material-operations/${requestId.toLowerCase()}`,v => materialOperation(v,this.options.installationId!,requestId.toLowerCase()),undefined,signal);
  }

  protection(signal?: AbortSignal) {
    return this.request<ProtectionOverview>("/v1/protection",v=>protectionOverview(v,this.options.installationId!),undefined,signal);
  }
  async botProtection(ref: string,signal?:AbortSignal) {
    const id=botIdFromRef(ref,this.options.installationId??""),target=`bot:${this.options.installationId}:${id}`;
    return this.request<ProtectionBotView>(`/v1/protection/bots/${id}`,v=>protectionBot(v,this.options.installationId!,target),undefined,signal);
  }
  async protectionOperation(ref: string,requestId:string,signal?:AbortSignal) {
    const installation=this.options.installationId??"",id=ref==="system"?"system":botIdFromRef(ref,installation);
    if(!UUID.test(requestId))throw new ManagementClientError("invalid_input","Use the original protection request UUID.");
    const target=id==="system"?`protection-system:${installation}`:`bot:${installation}:${id}`;
    return this.request<ProtectionOperation>(`/v1/protection-operations/${id}/${requestId.toLowerCase()}`,v=>protectionOperation(v,installation,target,requestId.toLowerCase()),undefined,signal);
  }
  async changeProtection(input: ProtectionChangeRequest,signal?:AbortSignal) {
    const installation=this.options.installationId??"",r=normalizeProtectionChange(input,installation),id=r.action==="system"?"system":botIdFromRef(r.botRef,installation);
    const target=id==="system"?`protection-system:${installation}`:`bot:${installation}:${id}`;
    return this.request<ProtectionOperation>("/v1/protection-changes",v=>protectionOperation(v,installation,target,r.requestId,r.expectedRevision),r,signal,false,`/v1/protection-operations/${id}/${r.requestId}`);
  }
  async protectionSnapshots(ref:string,limit=20,signal?:AbortSignal) {
    const installation=this.options.installationId??"",id=botIdFromRef(ref,installation),target=`bot:${installation}:${id}`;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ManagementClientError("invalid_input","Use a snapshot metadata limit of 1 to 100.");
    return this.request<ProtectionSnapshotList>(`/v1/protection-snapshots?bot=${encodeURIComponent(target)}&limit=${limit}`,v=>protectionSnapshots(v,installation,target,limit),undefined,signal);
  }
  async protectionSnapshot(ref:string,signal?:AbortSignal) {
    const installation=this.options.installationId??"",target=protectionReferenceIdentity(ref,installation,"snapshot").ref;
    return this.request<ProtectionSnapshot>(`/v1/protection-snapshots/${encodeURIComponent(target)}`,v=>protectionSnapshot(v,installation)&&v.snapshotRef===target,undefined,signal);
  }
  async protectionHandover(ref:string,signal?:AbortSignal) {
    const installation=this.options.installationId??"",target=protectionReferenceIdentity(ref,installation,"handover").ref;
    return this.request<ProtectionHandover>(`/v1/protection-handovers/${encodeURIComponent(target)}`,v=>protectionHandover(v,installation,target),undefined,signal);
  }

  async *watchObservationEvents(options: ObservationWatchOptions): AsyncGenerator<ObservationWatchReply> {
    const installationId = this.options.installationId;
    if (!installationId) throw new ManagementClientError("wrong_installation", "Pin the connection before watching events.");
    const cursor = options.cursor, durationMs = options.durationMs ?? 30_000, limit = options.limit ?? 100;
    if (!eventCursor(cursor) || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 60_000) throw new ManagementClientError("invalid_input", "Event watching requires a snapshot cursor and a duration of at most 60 seconds.");
    const query = pageQuery({ cursor, limit }); query.set("durationMs", String(durationMs));
    const timeout = AbortSignal.timeout(Math.min(durationMs + 10_000, this.options.timeoutMs ?? durationMs + 10_000)), signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const headers = new Headers({ accept: "application/x-ndjson", "x-grokbox-installation-id": installationId });
    if (this.options.credential) {
      const credential = await resolveCredential(this.options.credential, signal);
      if (typeof credential !== "string" || !credential || credential.length > 8192 || /[^\x21-\x7e]/.test(credential)) throw new ManagementClientError("authentication_required", "The configured management credential is unavailable.");
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (signal.aborted) throw new ManagementClientError("unavailable", "Event watching ended before the request was sent.", { cursor });
    let response: Response;
    try { response = await (this.options.fetch ?? globalThis.fetch)(`${this.baseUrl}/v1/observation-events/watch?${query}`, { method: "GET", headers, credentials: "same-origin", redirect: "manual", signal }); }
    catch { throw new ManagementClientError("unavailable", "The event connection is unavailable; the cursor has not advanced.", { cursor }); }
    yield* decodeObservationWatch(response, { installationId, cursor, limit, signal });
  }

  async incident(ref: string, signal?: AbortSignal) {
    const { databaseId, incidentId } = incidentIdentity(ref, this.options.installationId ?? "");
    const normalized = `incident:${this.options.installationId}:${databaseId}:${incidentId}`;
    return this.request<IncidentDetail>(`/v1/incidents/${encodeURIComponent(normalized)}`, value => incidentDetail(value, this.options.installationId!, normalized), undefined, signal);
  }
  async changeIncident(input: IncidentChangeRequest, signal?: AbortSignal) {
    const request = normalizeIncidentChange(input, this.options.installationId ?? "");
    const { databaseId } = incidentIdentity(request.incidentRef, this.options.installationId ?? "");
    return this.request<IncidentOperation>("/v1/incident-changes", value => incidentOperation(value, this.options.installationId!, databaseId, request.requestId, request),
      request, signal, false, `/v1/incident-operations/${databaseId}/${request.requestId}`);
  }
  async incidentOperation(databaseId: string, requestId: string, signal?: AbortSignal) {
    if (!UUID.test(databaseId) || !UUID.test(requestId)) throw new ManagementClientError("invalid_input", "An incident operation requires database and request UUIDs.");
    databaseId = databaseId.toLowerCase(); requestId = requestId.toLowerCase();
    return this.request<IncidentOperation>(`/v1/incident-operations/${databaseId}/${requestId}`, value => incidentOperation(value, this.options.installationId!, databaseId, requestId), undefined, signal);
  }

  receivers(signal?: AbortSignal) {
    return this.request<ReceiverList>("/v1/notification-receivers", value => record(value) && exact(value, ["receivers", "coverage", "maxReceivers"])
      && value.coverage === "local-bindings" && value.maxReceivers === 8 && Array.isArray(value.receivers) && value.receivers.length <= 8
      && value.receivers.every(row => receiverView(row, this.options.installationId!))
      && new Set(value.receivers.map(row => row.bindingId)).size === value.receivers.length, undefined, signal);
  }
  async receiver(ref: string, signal?: AbortSignal) {
    const target = notificationIdentity(ref, this.options.installationId!);
    return this.request<ReceiverView>(`/v1/notification-receivers/${encodeURIComponent(target.ref)}`,
      value => receiverView(value, this.options.installationId!) && value.receiverRef === target.ref, undefined, signal);
  }
  async verifyReceiver(ref: string, signal?: AbortSignal) {
    const target = notificationIdentity(ref, this.options.installationId!);
    return this.request<ReceiverVerification>(`/v1/notification-receivers/${encodeURIComponent(target.ref)}/verification`, value => record(value)
      && exact(value, ["receiverRef", "revision", "state", "reason", "modelRevision", "testRequired", "notificationSent", "grantsPermission"])
      && value.receiverRef === target.ref && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
      && ["ready", "blocked"].includes(String(value.state)) && typeof value.reason === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(value.reason)
      && (value.state === "ready" ? revision(value.modelRevision) : value.modelRevision === null)
      && value.testRequired === false && value.notificationSent === false && value.grantsPermission === false, undefined, signal);
  }
  async changeReceiver(input: ReceiverChangeRequest, signal?: AbortSignal) {
    const request = normalizeReceiverChange(input, this.options.installationId!), target = notificationIdentity(request.receiverRef, this.options.installationId!);
    if (request.action === "test") throw new ManagementClientError("invalid_input", "Tests use the independent testReceiver action.");
    return this.request<ReceiverOperation>("/v1/notification-receiver-changes", value => receiverOperation(value, this.options.installationId!, target.databaseId, request.requestId, request),
      request, signal, false, `/v1/notification-receiver-operations/${target.databaseId}/${request.requestId}`);
  }
  async testReceiver(input: ReceiverChangeRequest, signal?: AbortSignal) {
    const request = normalizeReceiverChange(input, this.options.installationId!), target = notificationIdentity(request.receiverRef, this.options.installationId!);
    if (request.action !== "test") throw new ManagementClientError("invalid_input", "The independent test action is required.");
    return this.request<NotificationTestOperation>("/v1/notification-tests", value => notificationTestOperation(value, this.options.installationId!, target.databaseId, request.requestId, request),
      request, signal, false, `/v1/notification-test-operations/${target.databaseId}/${request.requestId}`);
  }
  async receiverOperation(databaseId: string, requestId: string, signal?: AbortSignal) {
    if (!UUID.test(databaseId) || !UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Database and request UUIDs are required.");
    databaseId = databaseId.toLowerCase(); requestId = requestId.toLowerCase();
    return this.request<ReceiverOperation>(`/v1/notification-receiver-operations/${databaseId}/${requestId}`,
      value => receiverOperation(value, this.options.installationId!, databaseId, requestId), undefined, signal);
  }
  async notificationTestOperation(databaseId: string, requestId: string, signal?: AbortSignal) {
    if (!UUID.test(databaseId) || !UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Database and request UUIDs are required.");
    databaseId = databaseId.toLowerCase(); requestId = requestId.toLowerCase();
    return this.request<NotificationTestOperation>(`/v1/notification-test-operations/${databaseId}/${requestId}`,
      value => notificationTestOperation(value, this.options.installationId!, databaseId, requestId), undefined, signal);
  }
  async sendNotification(input: NotificationSendRequest, signal?: AbortSignal) {
    const request = normalizeNotificationSend(input, this.options.installationId!), target = notificationIdentity(request.notificationRef, this.options.installationId!, "notification");
    return this.request<NotificationSendOperation>("/v1/notification-sends",
      value => notificationSendOperation(value, this.options.installationId!, target.databaseId, request.requestId, request), request, signal, false,
      `/v1/notification-send-operations/${target.databaseId}/${request.requestId}`);
  }
  async notificationSendOperation(databaseId: string, requestId: string, signal?: AbortSignal) {
    if (!UUID.test(databaseId) || !UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Database and original request UUIDs are required.");
    databaseId = databaseId.toLowerCase(); requestId = requestId.toLowerCase();
    return this.request<NotificationSendOperation>(`/v1/notification-send-operations/${databaseId}/${requestId}`,
      value => notificationSendOperation(value, this.options.installationId!, databaseId, requestId), undefined, signal);
  }
  async notification(ref: string, signal?: AbortSignal) {
    const target = notificationIdentity(ref, this.options.installationId!, "notification");
    return this.request<NotificationView>(`/v1/notifications/${encodeURIComponent(target.ref)}`,
      value => notificationView(value, this.options.installationId!, target.databaseId) && value.notificationRef === target.ref, undefined, signal);
  }
  notifications(options: ListOptions = {}) {
    const query = pageQuery(options), limit = options.limit ?? 100;
    return this.request<NotificationList>(`/v1/notifications${query.size ? `?${query}` : ""}`, value => record(value) && exact(value, ["notifications", "databaseId", "nextCursor", "coverage"])
      && typeof value.databaseId === "string" && UUID.test(value.databaseId) && value.coverage === "retained-work"
      && Array.isArray(value.notifications) && value.notifications.length <= limit && value.notifications.every(row => notificationView(row, this.options.installationId!, value.databaseId as string))
      && new Set(value.notifications.map(row => row.workId)).size === value.notifications.length
      && (value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length <= 128
        && value.nextCursor.split(":").length === 3 && value.nextCursor.split(":")[0] === value.databaseId
        && /^[1-9][0-9]*$/.test(value.nextCursor.split(":")[1]!) && Number.isSafeInteger(Number(value.nextCursor.split(":")[1]))
        && UUID.test(value.nextCursor.split(":")[2]!)), undefined, options.signal);
  }
  notificationSettings(signal?: AbortSignal) {
    return this.request<NotificationSettingsView>("/v1/notification-settings", value => settingsView(value,this.options.installationId!),undefined,signal);
  }
  async notificationBlueprint(alias: string, signal?: AbortSignal) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) throw new ManagementClientError("invalid_input","Invalid receiver alias.");
    return this.request<RoutineBlueprint>(`/v1/notification-blueprint/${alias}`,value => blueprintView(value,this.options.installationId!),undefined,signal);
  }
  async routines(ref: string, signal?: AbortSignal) {
    const id = botIdFromRef(ref,this.options.installationId ?? ""), botRef = `bot:${this.options.installationId}:${id}`;
    return this.request<RoutineList>(`/v1/routines?${new URLSearchParams({ botRef })}`,value => routineList(value,this.options.installationId!,botRef),undefined,signal);
  }
  async routine(ref: string, signal?: AbortSignal) {
    const target = routineIdentity(ref,this.options.installationId ?? ""), normalized = routineReference(this.options.installationId!,target.botId,target.routineId);
    return this.request<RoutineList>(`/v1/routines/${encodeURIComponent(normalized)}`,value => routineList(value,this.options.installationId!,`bot:${this.options.installationId}:${target.botId}`,normalized),undefined,signal);
  }
  async changeSetup(input: SetupRequest, signal?: AbortSignal) {
    const request = normalizeSetupRequest(input,this.options.installationId ?? ""), kind = setupKind(request.action);
    const scope = kind === "routine" ? request.action === "apply" ? botIdFromRef(request.botRef,this.options.installationId!)
      : routineIdentity((request as Extract<SetupRequest,{routineRef:string}>).routineRef,this.options.installationId!).botId : "installation";
    const lookupPath = `/v1/setup-operations/${kind}/${scope}/${request.requestId}`;
    return this.request<SetupOperation>("/v1/setup-changes",value => setupOperation(value,this.options.installationId!,kind,scope,request.requestId,request),request,signal,false,lookupPath);
  }
  async setupOperation(kind: SetupKind, scope: string, requestId: string, signal?: AbortSignal) {
    if (!["settings","routine","pairing"].includes(kind) || !UUID.test(requestId) || (kind === "routine" ? !UUID.test(scope) : scope !== "installation")) throw new ManagementClientError("invalid_input","Invalid setup operation locator.");
    const normalizedScope = scope.toLowerCase(), id = requestId.toLowerCase();
    return this.request<SetupOperation>(`/v1/setup-operations/${kind}/${normalizedScope}/${id}`,value => setupOperation(value,this.options.installationId!,kind,normalizedScope,id),undefined,signal);
  }
  notificationWorker(signal?: AbortSignal) {
    return this.request<NotificationWorkerView>("/v1/notification-worker", notificationWorker, undefined, signal);
  }
  createConsoleGrant(origin: string, signal?: AbortSignal) {
    return this.request<ConsoleGrant>("/v1/console/grants", value => record(value) && typeof value.grantId === "string" && UUID.test(value.grantId)
      && typeof value.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.code) && value.origin === origin
      && Number.isSafeInteger(value.expiresAt) && value.persistence === "server-lifetime", { origin }, signal, true);
  }
  private validSession(value: unknown): boolean {
    return record(value) && typeof value.sessionId === "string" && UUID.test(value.sessionId) && typeof value.principalId === "string"
      && typeof value.origin === "string" && typeof value.csrfToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)
      && Array.isArray(value.capabilities) && value.capabilities.every(capability => CAPABILITIES.includes(capability as never))
      && Number.isSafeInteger(value.expiresAt) && value.persistence === "server-lifetime";
  }
  redeemConsoleGrant(code: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return Promise.reject(new ManagementClientError("invalid_input", "Invalid console bootstrap code."));
    return this.request<ConsoleSession>("/v1/console/redeem", value => this.validSession(value), { code }, signal, true);
  }
  consoleSession(signal?: AbortSignal) {
    return this.request<ConsoleSession>("/v1/console/session", value => this.validSession(value), undefined, signal, true);
  }
  consoleLogout(signal?: AbortSignal) {
    return this.request<{ signedOut: true }>("/v1/console/logout", value => record(value) && value.signedOut === true, {}, signal, true);
  }
  async identity(signal?: AbortSignal) {
    const result = await this.request<ManagementIdentity>("/v1/identity", value => record(value) && value.apiVersion === 1
      && typeof value.installationId === "string" && UUID.test(value.installationId)
      && typeof value.principalId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.principalId)
      && Array.isArray(value.capabilities) && value.capabilities.length <= CAPABILITIES.length
      && value.capabilities.every(capability => CAPABILITIES.includes(capability as never)), undefined, signal);
    if (result.data.installationId !== result.installationId) throw protocolError();
    return result;
  }
  service(signal?: AbortSignal) {
    return this.request<ManagementServiceView>("/v1/service", managementService, undefined, signal);
  }
  observation(signal?: AbortSignal) {
    return this.request<ObservationSnapshot>("/v1/observation", value => observationSnapshot(value, this.options.installationId!), undefined, signal);
  }
  incidents(options: ListOptions = {}) {
    const query = pageQuery(options), limit = options.limit ?? 100;
    return this.request<IncidentList>(`/v1/incidents${query.size ? `?${query}` : ""}`, value => incidentList(value, this.options.installationId!, limit), undefined, options.signal);
  }
  observationEvents(options: ListOptions = {}) {
    const query = pageQuery(options), limit = options.limit ?? 100, after = options.cursor;
    return this.request<ObservationEventPage>(`/v1/observation-events${query.size ? `?${query}` : ""}`, value => observationEvents(value, this.options.installationId!, limit, after), undefined, options.signal);
  }
  async bot(ref: string, signal?: AbortSignal) {
    const id = botIdFromRef(ref, this.options.installationId ?? "");
    return this.request<BotView>(`/v1/bots/${id}`, value => botRow(value, this.options.installationId!) && (value as BotView).id === id, undefined, signal);
  }
  async bots(options: ListOptions = {}) {
    const query = pageQuery(options);
    const limit = options.limit ?? 100;
    return this.request<BotList>(`/v1/bots${query.size ? `?${query}` : ""}`, value => record(value)
      && exact(value, ["bots", "membershipRevision", "nextCursor", "total", "pageBound", "source", "coverage", "consistency"])
      && Array.isArray(value.bots) && value.bots.length <= limit && value.bots.every(row => botRow(row, this.options.installationId!))
      && new Set(value.bots.map(row => row.id)).size === value.bots.length && revision(value.membershipRevision)
      && Number.isSafeInteger(value.total) && Number(value.total) >= value.bots.length && pageBound(value.pageBound)
      && cursor(value.nextCursor) && botSource(value.source) && value.coverage === "current-snapshot"
      && value.bots.every(row => row.source.generation === (value.source as BotView["source"]).generation
        && row.source.pid === (value.source as BotView["source"]).pid && row.source.startedAt === (value.source as BotView["source"]).startedAt)
      && value.consistency === "stable-membership-fresh-fields", undefined, options.signal);
  }
  async resolveBot(value: string, signal?: AbortSignal) {
    const query = normalizeBotQuery(value);
    botIdForQuery(query, this.options.installationId ?? "");
    const params = new URLSearchParams({ query });
    return this.request<BotResolution>(`/v1/bots/resolve?${params}`, value => record(value)
      && botRow(value.bot, this.options.installationId!) && ["id", "name", "title"].includes(String(value.matchedBy)), undefined, signal);
  }
  async botModel(ref: string, signal?: AbortSignal) {
    const id = botIdFromRef(ref, this.options.installationId ?? "");
    return this.request<BotModelView>(`/v1/bots/${id}/model`, value => botModel(value, `bot:${this.options.installationId}:${id}`), undefined, signal);
  }
  async models(options: ListOptions = {}) {
    const query = pageQuery(options);
    const limit = options.limit ?? 100;
    return this.request<ModelList>(`/v1/models${query.size ? `?${query}` : ""}`, value => record(value)
      && exact(value, ["models", "revision", "nextCursor", "total", "pageBound"]) && revision(value.revision)
      && Array.isArray(value.models) && value.models.length <= limit && value.models.every(model)
      && new Set(value.models.map(item => item.id)).size === value.models.length
      && cursor(value.nextCursor) && Number.isSafeInteger(value.total) && Number(value.total) >= value.models.length && pageBound(value.pageBound), undefined, options.signal);
  }
  async model(id: string, signal?: AbortSignal) {
    if (!modelId(id)) throw new ManagementClientError("invalid_input", "Invalid model identity.");
    return this.request<{ model: ModelView; revision: string }>(`/v1/models/${encodeURIComponent(id)}`, value => record(value)
      && exact(value, ["model", "revision"]) && revision(value.revision) && model(value.model) && value.model.id === id, undefined, signal);
  }
  defaultModel(signal?: AbortSignal) {
    return this.request<DefaultModelView>("/v1/model-default", value => record(value) && exact(value, ["selection", "revision"]) && revision(value.revision)
      && (value.selection === null || selectedModel(value.selection)), undefined, signal);
  }
  async changeModels(input: ModelChangeRequest, signal?: AbortSignal) {
    let snapshot: ModelChangeRequest;
    try { snapshot = structuredClone(input); }
    catch { throw new ManagementClientError("invalid_input", "The model request must contain plain data."); }
    if (!record(snapshot) || !record(snapshot.change)) throw new ManagementClientError("invalid_input", "Invalid model request.");
    const change = snapshot.change;
    const target = change.kind === "bot-selection" ? typeof change.agentId === "string" ? change.agentId.toLowerCase() : undefined
      : change.kind === "default-selection" ? "default" : change.modelId;
    return this.request<ModelOperation>("/v1/model-changes", value => operation(value, this.options.installationId!)
      && value.state === "succeeded" && value.requestId === snapshot.requestId.toLowerCase()
      && value.command === change.kind && value.target === target && value.beforeRevision === snapshot.expectedRevision, snapshot, signal);
  }
  async modelOperation(requestId: string, signal?: AbortSignal) {
    if (!UUID.test(requestId)) throw new ManagementClientError("invalid_input", "Invalid request UUID.");
    return this.request<ModelOperation>(`/v1/model-operations/${requestId.toLowerCase()}`, value => operation(value, this.options.installationId!)
      && value.requestId === requestId.toLowerCase(), undefined, signal);
  }
}
