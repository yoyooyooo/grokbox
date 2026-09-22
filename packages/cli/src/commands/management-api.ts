import { DesktopError, normalizeDesktopPolicy, normalizeDesktopPrune, type DesktopPolicyRequest, normalizeJobStart, ManagementClientError, botIdFromRef, type ApiErrorCode, type ApiReply, type ModelChange, normalizeSetupRequest, type MaterialWrite, type MaterialScope, type MaterialKind } from "@grokbox/client";
import { startInstalledManagementServer } from "@grokbox/server";
import { type FileChange, FileError } from "@grokbox/client";
import { uploadManagedFile, downloadManagedFile } from "../file-transfers.ts";
import { contextOperationIdentity, contextOperationRef, compactionOperationIdentity, handoverOperationIdentity, type HandoverAction, type ContextChange } from "@grokbox/client";
import { normalizeLifecycleIntent, lifecycleIdentity, lifecycleReference, type LifecycleIntent } from "@grokbox/client";
import { parseRequestedEffort } from "@grokbox/runtime-kernel/selection";
import { ConfigError } from "@grokbox/runtime-kernel/config";
import { parseModelChangeRequest, type ModelChangeRequest } from "@grokbox/runtime-kernel/model-management";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { managementClient } from "../management-client.ts";
import { combineManagementInput, readManagementInput } from "../management-input.ts";
import { createConsoleCredentialFile } from "../console-credential.ts";
import { runInstalledWebService } from "../web-service.ts";

export type ManagementCommandOptions = {
  connection?: string; timeoutMs?: string; limit?: string; cursor?: string; source?: string; scope?: string;
  from?: string; to?: string; recursive?: boolean; deletionRequestId?: string; generation?: string;
  jobRef?: string; waitMs?: string; offset?: string;
  preview?: boolean; scopeId?: string; expectPlan?: string; itemId?: string; evidenceRef?: string;
  requestId?: string; expectRevision?: string; model?: string; followDefault?: boolean; effort?: string; receiver?: string;
  root?: string; nativeDiscovery?: string; port?: string; input?: string; mode?: string; nonce?: string; beforeSeq?: string;
  untilMs?: string; durationMs?: string; domain?: string; databaseId?: string; confirm?: boolean; expectModelRevision?: string;
  bot?: string; snapshotRef?: string; routineRef?: string; expectBindingRevision?: string; enabled?: string; target?: string;
  origin?: string; credentialFile?: string; consoleOrigin?: string; managementUrl?: string; installationId?: string;
};
const invalid = (message: string) => new ManagementClientError("invalid_input", message);

async function runServer(deps: CliDeps, component: string | undefined, options: ManagementCommandOptions) {
  if (component === "web") return runInstalledWebService(deps, options);
  if (component !== "server") throw invalid("The service component must be server or web.");
  if (options.managementUrl !== undefined || options.installationId !== undefined) throw invalid("Explicit Web binding options are not management Server options.");
  if (options.port !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(options.port)) throw invalid("Invalid service port.");
  if (deps.signal?.aborted) throw new ManagementClientError("unavailable", "Service startup was interrupted before acquisition.");
  const server = await startInstalledManagementServer({ root: options.root ?? deps.boxRuntimeRoot, discoveryPath: options.nativeDiscovery ?? deps.discoveryPath,
    ...(options.consoleOrigin ? { allowedOrigins: [options.consoleOrigin] } : {}),
    ...(options.port === undefined ? {} : { port: Number(options.port) }) }).catch(() => {
      throw new ManagementClientError("unavailable", "The installed management Server could not start; inspect its configuration and listener ownership.");
    });
  let stopping: Promise<void> | undefined;
  const stop = () => { stopping ??= server.close(); void stopping.catch(() => undefined); };
  deps.signal?.addEventListener("abort", stop, { once: true });
  if (deps.signal?.aborted) stop();
  try {
    deps.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "system.service.run", invocationId: deps.randomUUID(),
      installationId: server.status().installationId, ok: true, data: { component: "server", state: "running", url: server.url, pid: process.pid } })}\n`);
    await server.finished;
  } finally {
    stop(); await stopping; deps.signal?.removeEventListener("abort", stop);
  }
}

export async function runManagementCommand(deps: CliDeps, command: string, args: Array<string | undefined>, options: ManagementCommandOptions) {
  if (command === "system service run") return runServer(deps, args[0], options);
  if (command === "bot context compact") {
    if (Boolean(options.preview) === Boolean(options.confirm)) throw invalid("Choose a read-only --preview or an explicitly confirmed compaction, not both.");
    if (options.preview && [options.requestId, options.scopeId, options.expectRevision].some(v => v !== undefined)) throw invalid("Preview accepts no write intent.");
    if (!options.preview && (!options.requestId || !options.scopeId || !options.expectRevision)) throw invalid("Persist the request-id and supply the exact preview scope-id and expect-revision before confirmation.");
  }
  let declared: ModelChangeRequest | undefined;
  if (command === "model apply") {
    const input = combineManagementInput(await readManagementInput(deps, options.input), {
      modelId: args[0], mode: options.mode, requestId: options.requestId, expectedRevision: options.expectRevision,
    }, ["modelId", "mode", "model", "requestId", "expectedRevision"]);
    if (input.mode !== "patch" && input.mode !== "replace") throw invalid("Model apply requires an explicit patch or replace mode.");
    try {
      declared = parseModelChangeRequest({ requestId: input.requestId, expectedRevision: input.expectedRevision,
        change: input.mode === "patch" ? { kind: "model-patch", modelId: input.modelId, patch: input.model }
          : { kind: "model-put", modelId: input.modelId, model: input.model } });
    } catch { throw invalid("Invalid model apply input."); }
  }
  const lifecycleKind = ["bot clone", "bot replace", "bot spawn"].includes(command) ? command.split(" ")[1] as LifecycleIntent["kind"] : undefined;
  let lifecycleInput: Record<string, unknown> | undefined;
  if (lifecycleKind) {
    if (Boolean(options.preview) === Boolean(options.confirm) || options.preview && (options.scopeId !== undefined || options.expectPlan !== undefined)) throw invalid("Choose --preview or --confirm with the exact scope-id and expect-plan, not both.");
    lifecycleInput = combineManagementInput(await readManagementInput(deps, options.input), { kind: lifecycleKind, sourceBotRef: lifecycleKind === "spawn" ? null : args[0], requestId: options.requestId },
      ["requestId", "kind", "sourceBotRef", "name", "description", "instructions", "modelId", "effort", "snapshotRef", "activate", "start", "maxRunMs", "allowHandoverMessages"]);
  }
  const setupInput = command === "notification settings apply" || command === "routine apply" ? await readManagementInput(deps,options.input) : undefined;
  let jobInput;
  if (command === "job start") {
    if (options.confirm !== true) throw invalid("Explicit OS execution confirmation is required.");
    jobInput = normalizeJobStart({ ...combineManagementInput(await readManagementInput(deps, options.input),
      { requestId: options.requestId, expectedRevision: options.expectRevision }, ["requestId", "expectedRevision", "argv", "environment", "cwd", "runTimeoutMs", "output", "shell"]), confirmed: true });
  }
  let desktopInput: DesktopPolicyRequest | undefined;
  if (command === "system desktop keep set" || command === "system config apply") {
    if (options.confirm !== true || command === "system config apply" && options.domain !== "desktop") throw invalid("Confirm one supported desktop policy domain change.");
    const input = combineManagementInput(await readManagementInput(deps, options.input), { requestId: options.requestId, expectedRevision: options.expectRevision },
      command === "system desktop keep set" ? ["requestId", "expectedRevision", "agentIds"] : ["requestId", "expectedRevision", "action", "enabled", "minIdleMs"]);
    try { desktopInput = normalizeDesktopPolicy({ ...input, ...(command === "system desktop keep set" ? { action: "keep" } : {}), confirmed: true }); }
    catch { throw invalid("Use the current bounded desktop policy declaration, not legacy daemon fields."); }
    if (command === "system config apply" && desktopInput.action !== "idle-reclaim") throw invalid("Use system desktop keep set for a protection set; system config apply currently accepts desktop idle-reclaim.");
  }
  if (command === "system desktop prune") {
    if (Boolean(options.preview) === Boolean(options.confirm) || options.preview && [options.requestId, options.expectRevision].some(v => v !== undefined)) throw invalid("Choose a read-only preview, or an explicitly confirmed original desktop batch.");
    if (!options.preview) { try { normalizeDesktopPrune({ requestId: options.requestId, expectedRevision: options.expectRevision, confirmed: true }); } catch { throw invalid("Persist a request UUID and provide the reviewed desktop revision."); } }
  }
  const waitMs = command === "job wait" ? Number(options.waitMs ?? "25000") : 0;
  if (command === "job wait" && (!/^[1-9][0-9]*$/.test(options.waitMs ?? "25000") || waitMs > 25000)) throw invalid("Job wait is bounded to 1–25000 milliseconds.");
  const { client, installationId } = await managementClient(deps, command === "job wait" && options.timeoutMs === undefined ? { ...options, timeoutMs: String(waitMs + 5000) } : options);
  if (command === "event watch") {
    for (const value of [options.limit, options.durationMs]) if (value !== undefined && !/^[1-9][0-9]{0,5}$/.test(value)) throw invalid("Invalid event watch bounds.");
    for await (const frame of client.watchObservationEvents({ cursor: options.cursor ?? "", limit: options.limit === undefined ? undefined : Number(options.limit),
      durationMs: options.durationMs === undefined ? undefined : Number(options.durationMs), signal: deps.signal })) {
      const line = `${JSON.stringify({ ...frame, command: "event.watch" })}\n`;
      if (deps.stdout.writeAsync) await deps.stdout.writeAsync(line, deps.signal); else deps.stdout.write(line);
    }
    return;
  }
  let reply: ApiReply<unknown>;
  switch (command) {
    case "job policy": reply = await client.jobPolicy(deps.signal); break;
    case "job start": reply = await client.startJob(jobInput!, deps.signal); break;
    case "job list": {
      if (options.limit !== undefined && !/^[1-9][0-9]*$/.test(options.limit)) throw invalid("Invalid Job page size.");
      reply = await client.jobs({ limit: options.limit === undefined ? 25 : Number(options.limit), cursor: options.cursor, signal: deps.signal }); break;
    }
    case "job get": case "job wait": reply = await client.job(args[0] ?? "", { waitMs, signal: deps.signal }); break;
    case "job logs": {
      if (options.offset !== undefined && !/^(0|[1-9][0-9]*)$/.test(options.offset)) throw invalid("Use a verified Job output offset.");
      reply = await client.jobLogs(args[0] ?? "", { offset: Number(options.offset ?? "0"), signal: deps.signal }); break;
    }
    case "job cancel": reply = await client.cancelJob({ jobRef: args[0] ?? "", requestId: options.requestId ?? "", confirmed: options.confirm as true }, deps.signal); break;
    case "bot context get": reply = await client.context(args[0] ?? "", deps.signal); break;
    case "bot context compact": {
      if (options.preview) {
        if (options.confirm || options.requestId !== undefined || options.scopeId !== undefined || options.expectRevision !== undefined) throw invalid("Compaction preview accepts no write intent or previously approved revision.");
        reply = await client.compactionPreview(args[0] ?? "", deps.signal);
      } else {
        if (options.confirm !== true) throw invalid("Choose --preview, or explicitly confirm compaction with request-id, scope-id and expect-revision. A summary may incur model cost.");
        reply = await client.compact({ botRef: args[0] ?? "", requestId: options.requestId ?? "", scopeId: options.scopeId ?? "", expectedRevision: options.expectRevision ?? "", confirmed: true }, deps.signal);
      }
      break;
    }
    case "bot snapshot create": case "bot context initialize": case "bot context reset": case "bot context restore": {
      if (options.confirm !== true) throw invalid("Confirm the exact current-state operation.");
      const action = command === "bot snapshot create" ? "capture" : command.split(" ")[2] as "initialize" | "reset" | "restore";
      reply = await client.changeContext({ requestId: options.requestId ?? "", scopeId: options.scopeId ?? "", expectedRevision: options.expectRevision ?? "",
        botRef: command === "bot snapshot create" ? options.bot ?? "" : args[0] ?? "", confirmed: true, action,
        ...(action === "initialize" || action === "restore" ? { snapshotRef: options.snapshotRef ?? "" } : {}) } as ContextChange, deps.signal); break;
    }
    case "bot activate": {
      if (options.confirm !== true) throw invalid("Confirm release of the original prepared context.");
      reply = await client.continueContext({ action: "activate", requestId: options.requestId ?? "", scopeId: options.scopeId ?? "", botRef: args[0] ?? "",
        expectedRevision: options.expectRevision ?? "", confirmed: true }, deps.signal); break;
    }
    case "bot clone": case "bot replace": case "bot spawn": {
      const intent = normalizeLifecycleIntent(lifecycleInput, installationId);
      reply = options.preview ? await client.previewLifecycle(intent, deps.signal) : await client.submitLifecycle({ ...intent,
        scopeId: options.scopeId ?? "", planRevision: options.expectPlan ?? "", confirmed: true }, deps.signal);
      if (reply.ok && "effectsUnknown" in (reply.data as object) && ((reply.data as {effectsUnknown:boolean;state:string}).effectsUnknown || (reply.data as {state:string}).state === "blocked")) {
        throw new ManagementClientError("operation_unknown", "The saved lifecycle has an unresolved stage. Read its original operation before explicit resume; do not create a replacement request.", { operation: reply.data, requestId: intent.requestId, scopeId: options.scopeId });
      }
      break;
    }
    case "operation cancel": {
      if(options.domain==="file") {
        if(options.confirm!==true||options.bot!==undefined)throw invalid("Confirm cancellation of the original staging upload only.");
        reply=await client.controlFileUpload({requestId:args[0]??"",generation:options.generation??"",action:"cancel"},deps.signal);break;
      }
      if (options.domain === "handover") {
        if(options.confirm!==true||options.bot!==undefined)throw invalid("Handover cancellation uses only its exact original operation and confirmation.");
        const ref=handoverOperationIdentity(args[0]??"",installationId);
        reply=await client.continueHandover({requestId:ref.requestId,scopeId:ref.scopeId,action:"cancel",confirmed:true},deps.signal);break;
      }
      if (options.domain === "compaction") {
        if (options.confirm !== true) throw invalid("Confirm cancellation of the original undispatched compaction.");
        const original = compactionOperationIdentity(args[0] ?? "", installationId);
        reply = await client.continueCompaction({ action: "cancel", requestId: original.requestId, scopeId: original.scopeId, botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
      }
      if (options.domain !== "context" || options.confirm !== true) throw invalid("Cancellation is limited to an original context preparation without native application.");
      const original = contextOperationIdentity(args[0] ?? "", installationId);
      reply = await client.continueContext({ action: "cancel", requestId: original.requestId, scopeId: original.scopeId, botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
    }
    case "operation list":
      if (options.domain !== "lifecycle" || options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("This listing supports --domain lifecycle and a bounded page.");
      reply = await client.lifecycles({ limit: options.limit === undefined ? undefined : Number(options.limit), cursor: options.cursor, signal: deps.signal }); break;
    case "operation resume": {
      if(options.domain==="handover"){
        if(options.confirm!==true||options.bot!==undefined||options.expectPlan!==undefined)throw invalid("Resume the exact original handover request; no replacement plan or target is accepted.");
        const ref=handoverOperationIdentity(args[0]??"",installationId);
        reply=await client.continueHandover({requestId:ref.requestId,scopeId:ref.scopeId,action:"resume",confirmed:true},deps.signal);break;
      }
      if (options.domain === "compaction") {
        if (options.confirm !== true || options.expectPlan !== undefined) throw invalid("Compaction resume uses its original request and Bot, not a replacement plan. Unknown dispatch permits only readback.");
        const original = compactionOperationIdentity(args[0] ?? "", installationId);
        reply = await client.continueCompaction({ action: "resume", requestId: original.requestId, scopeId: original.scopeId, botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
      }
      if (options.domain === "context") {
        if (options.confirm !== true || options.expectPlan !== undefined) throw invalid("Context resume requires only its original operation, Bot and explicit confirmation, not a new plan.");
        const original = contextOperationIdentity(args[0] ?? "", installationId);
        reply = await client.continueContext({ action: "resume", requestId: original.requestId, scopeId: original.scopeId, botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
      }
      if (options.domain !== "lifecycle" || options.confirm !== true || options.bot !== undefined) throw invalid("Explicit lifecycle resume requires its original reference, plan and confirmation.");
      const identity = lifecycleIdentity(args[0] ?? "", installationId);
      const result = await client.resumeLifecycle({ requestId: identity.requestId, scopeId: identity.scopeId, planRevision: options.expectPlan ?? "", confirmed: true }, deps.signal);
      if (result.data.effectsUnknown || result.data.state === "blocked") throw new ManagementClientError("operation_unknown", "The original lifecycle remains blocked or uncertain; no unknown creation was replayed.", { operation: result.data });
      reply = result; break;
    }
    case "system protection get": reply=await client.protection(deps.signal);break;
    case "bot protection get": reply=await client.botProtection(args[0]??"",deps.signal);break;
    case "bot snapshot get": reply=await client.protectionSnapshot(args[0]??"",deps.signal);break;
    case "bot handover get": reply=await client.protectionHandover(args[0]??"",deps.signal);break;
    case "bot handover advance": case "bot handover observe": case "bot handover attest": case "bot handover retire": {
      if(options.confirm!==true)throw invalid("Confirm the bounded handover action and persist its original request UUID.");
      reply=await client.changeHandover({requestId:options.requestId??"",handoverRef:args[0]??"",action:command.split(" ")[2] as HandoverAction,expectedRevision:options.expectRevision??"",confirmed:true,
        ...(options.itemId!==undefined?{itemId:options.itemId}:{}),...(options.evidenceRef!==undefined?{evidenceRef:options.evidenceRef}:{})},deps.signal);break;
    }
    case "bot snapshot list": reply=await client.protectionSnapshots(options.bot??"",options.limit===undefined?20:Number(options.limit),deps.signal);break;
    case "system protection set": case "bot protection set": case "bot protection reset": {
      if(options.confirm!==true)throw invalid("Confirm the protection policy change.");
      const common={requestId:options.requestId??"",expectedRevision:options.expectRevision??"",confirmed:true as const};
      if(command==="system protection set"){
        if(!["true","false"].includes(options.enabled??""))throw invalid("Protection enabled must be exactly true or false.");
        reply=await client.changeProtection({...common,action:"system",enabled:options.enabled==="true"},deps.signal);
      }else if(command==="bot protection reset")reply=await client.changeProtection({...common,action:"reset",botRef:args[0]??""},deps.signal);
      else reply=await client.changeProtection({...common,action:"set",botRef:args[0]??"",patch:await readManagementInput(deps,options.input)},deps.signal);
      break;
    }
    case "system desktop get": reply = await client.desktop(deps.signal); break;
    case "system desktop prune": reply = options.preview ? await client.desktop(deps.signal) : await client.pruneDesktop({ requestId: options.requestId!, expectedRevision: options.expectRevision!, confirmed: true }, deps.signal); break;
    case "system desktop keep set": case "system config apply": reply = await client.changeDesktopPolicy(desktopInput!, deps.signal); break;
    case "system materials get": reply = await client.materialStatus(deps.signal); break;
    case "file root list": {
      const identity=await client.identity(deps.signal),caps=identity.data.capabilities;
      if(!caps.includes("files.read")&&!caps.includes("materials.read"))throw new ManagementClientError("permission_denied","Root discovery requires a source metadata capability.");
      const named=caps.includes("files.read")?await client.fileRoots(deps.signal):undefined,indexed=caps.includes("materials.read")?await client.materialStatus(deps.signal):undefined;
      reply={...identity,data:{roots:named?.data.roots??[],state:named?.data.state??"not-authorized",sources:indexed?.data.sources.filter(s=>s.kind==="files")??[],indexedSourceAccess:indexed?"authorized":"not-authorized",coverage:"authorized-source-types"}};break;
    }
    case "file root get": {
      const value=await client.fileRoots(deps.signal),root=value.data.roots.find(r=>r.name===args[0]);
      if(!root)throw new ManagementClientError("not_found","That exact named root is not available.");reply={...value,data:root};break;
    }
    case "file stat":reply=await client.fileStat(args[0]??"",deps.signal);break;
    case "file mkdir":case "file delete":case "file restore": {
      if(options.confirm!==true)throw invalid("Confirm this exact file effect with its original request UUID.");
      const base={requestId:options.requestId??"",ref:args[0]??"",confirmed:true as const};
      const input:FileChange=command==="file mkdir"?{...base,action:"mkdir",expectedRevision:null}:command==="file delete"?{...base,action:"delete",expectedRevision:options.expectRevision??"",recursive:options.recursive===true}:{...base,action:"restore",expectedRevision:null,deletionRequestId:options.deletionRequestId??""};
      reply=await client.changeFile(input,deps.signal);break;
    }
    case "file upload":
      if(options.confirm!==true||!options.from||!options.expectRevision)throw invalid("Upload requires an explicit local source, persisted request UUID, reviewed revision or absent, and confirmation.");
      reply=await uploadManagedFile(client,deps,installationId,args[0]??"",options.from,options.requestId??"",options.expectRevision==="absent"?null:options.expectRevision);break;
    case "file download":
      if(!options.to)throw invalid("Choose the new local destination explicitly.");reply=await downloadManagedFile(client,deps,installationId,args[0]??"",options.to);break;
    case "memory list": case "file list": case "project list": case "memory search": case "file search": {
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("Invalid material page limit.");
      if(command==="file list"&&args[0]) {
        if(options.source!==undefined||options.scope!==undefined)throw invalid("A named-root directory is selected by its complete file reference, not an indexed-source filter.");
        reply=await client.fileDirectory(args[0],{limit:options.limit===undefined?undefined:Number(options.limit),cursor:options.cursor,signal:deps.signal});break;
      }
      reply = await client.materials({ kind: command.split(" ")[0] as MaterialKind, sourceId: options.source, scope: options.scope as MaterialScope | undefined,
        query: command.endsWith("search") ? args[0] : undefined, limit: options.limit === undefined ? undefined : Number(options.limit), cursor: options.cursor, signal: deps.signal }); break;
    }
    case "file read": reply=args[0]?.startsWith("file:")?await client.readFile(args[0],deps.signal):await client.readMaterial(args[0]??"",deps.signal);break;
    case "memory read": case "project get": reply = await client.readMaterial(args[0] ?? "",deps.signal); break;
    case "file write": {
      if (options.confirm !== true) throw invalid("Confirm this one source text replacement.");
      const value = combineManagementInput(await readManagementInput(deps,options.input),{ref:args[0],requestId:options.requestId,expectedRevision:options.expectRevision},["ref","requestId","expectedRevision","content"]);
      reply = typeof value.ref==="string"&&value.ref.startsWith("file:")?await client.changeFile({...value,action:"write",confirmed:true} as FileChange,deps.signal):await client.changeMaterial({...value,confirmed:true} as MaterialWrite,deps.signal);break;
    }
    case "incident get": reply = await client.incident(args[0] ?? "", deps.signal); break;
    case "incident ack":
    case "incident snooze": {
      if (!options.expectRevision || !/^[1-9][0-9]*$/.test(options.expectRevision)
        || command === "incident snooze" && (!options.untilMs || !/^[1-9][0-9]*$/.test(options.untilMs))) throw invalid("Incident revisions and deadlines must be positive integers.");
      reply = await client.changeIncident({ requestId: options.requestId ?? "", incidentRef: args[0] ?? "", expectedRevision: Number(options.expectRevision),
        ...(command === "incident ack" ? { action: "ack" } : { action: "snooze", untilMs: Number(options.untilMs) }) }, deps.signal);
      break;
    }
    case "system host health": reply=await client.hostHealth(deps.signal);break;
    case "system identity get": reply = await client.identity(deps.signal); break;
    case "notification settings get": reply = await client.notificationSettings(deps.signal); break;
    case "notification settings apply":
    case "routine apply": {
      const request = normalizeSetupRequest(setupInput,installationId);
      if (request.action !== (command === "routine apply" ? "apply" : "settings")) throw invalid("The input action does not match this command.");
      reply = await client.changeSetup(request,deps.signal); break;
    }
    case "notification receiver blueprint": reply = await client.notificationBlueprint(args[0] ?? "",deps.signal); break;
    case "notification receiver bind": {
      if (!/^(0|[1-9][0-9]*)$/.test(options.expectBindingRevision ?? "") || options.confirm !== true) throw invalid("Binding requires its previous revision (0 for first bind) and explicit confirmation.");
      reply = await client.changeSetup({action:"bind",alias:args[0] ?? "",routineRef:options.routineRef ?? "",databaseId:options.databaseId ?? "",expectedRevision:options.expectRevision ?? "",
        expectedBindingRevision:Number(options.expectBindingRevision),confirmed:true,requestId:options.requestId ?? ""},deps.signal); break;
    }
    case "routine list": reply = await client.routines(options.bot ?? "",deps.signal); break;
    case "routine get": reply = await client.routine(args[0] ?? "",deps.signal); break;
    case "routine enable":
    case "routine disable":
    case "routine delete": {
      if (options.confirm !== true) throw invalid("A native Routine change requires explicit confirmation.");
      reply = await client.changeSetup({action:command.split(" ")[1] as "enable"|"disable"|"delete",routineRef:args[0] ?? "",requestId:options.requestId ?? "",expectedRevision:options.expectRevision ?? "",confirmed:true},deps.signal); break;
    }
    case "notification status": reply = await client.notificationWorker(deps.signal); break;
    case "notification receiver list": reply = await client.receivers(deps.signal); break;
    case "notification receiver get": reply = await client.receiver(args[0] ?? "", deps.signal); break;
    case "notification receiver verify": reply = await client.verifyReceiver(args[0] ?? "", deps.signal); break;
    case "notification get": reply = await client.notification(args[0] ?? "", deps.signal); break;
    case "notification send": {
      if (options.confirm !== true || !/^[1-9][0-9]{0,15}$/.test(options.expectRevision ?? "")) throw invalid("Explicit confirmation and the reviewed binding revision are required.");
      reply = await client.sendNotification({ notificationRef: args[0] ?? "", receiverRef: options.receiver ?? "", requestId: options.requestId ?? "",
        expectedRevision: Number(options.expectRevision), expectedModelRevision: options.expectModelRevision ?? "", confirmed: true }, deps.signal);
      break;
    }
    case "notification receiver enable":
    case "notification receiver disable":
    case "notification receiver unbind":
    case "notification receiver test": {
      if (options.confirm !== true || !options.expectRevision || !/^[1-9][0-9]*$/.test(options.expectRevision)) throw invalid("A receiver change requires explicit confirmation and an integer revision.");
      const action = command.split(" ").at(-1)! as "enable" | "disable" | "unbind" | "test";
      const input = { requestId: options.requestId ?? "", receiverRef: args[0] ?? "", expectedRevision: Number(options.expectRevision), confirmed: true as const,
        ...(action === "enable" || action === "test" ? { action, expectedModelRevision: options.expectModelRevision ?? "" } : { action }) };
      reply = action === "test" ? await client.testReceiver(input, deps.signal) : await client.changeReceiver(input, deps.signal);
      break;
    }
    case "system service get":
      if (args[0] !== "server") throw invalid("Only the management server status is implemented here; modeld and Web are separate components.");
      reply = await client.service(deps.signal); break;
    case "system observation get": reply = await client.observation(deps.signal); break;
    case "system console grant create": reply = await createConsoleCredentialFile(deps, client, options.origin, options.credentialFile); break;
    case "message send": {
      const input = combineManagementInput(await readManagementInput(deps, options.input),
        { botRef: args[0], requestId: options.requestId, clientNonce: options.nonce },
        ["botRef", "requestId", "clientNonce", "text"]);
      reply = await client.sendMessage({
        requestId: typeof input.requestId === "string" ? input.requestId : "",
        botRef: typeof input.botRef === "string" ? input.botRef : "",
        text: typeof input.text === "string" ? input.text : "",
        clientNonce: typeof input.clientNonce === "string" ? input.clientNonce : "",
      }, deps.signal); break;
    }
    case "message operation get": reply = await client.messageOperation(args[0] ?? "", deps.signal); break;
    case "message delivery get": {
      if (options.waitMs !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(options.waitMs)) throw invalid("Delivery wait must be 0 to 25000 milliseconds.");
      const waitMs = options.waitMs === undefined ? 0 : Number(options.waitMs);
      if (waitMs > 25_000) throw invalid("Delivery wait must be 0 to 25000 milliseconds.");
      reply = await client.messageDelivery(args[0] ?? "", { waitMs, signal: deps.signal }); break;
    }
    case "message list": {
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("Invalid message page size.");
      if (options.beforeSeq !== undefined && !/^(0|[1-9][0-9]*)$/.test(options.beforeSeq)) throw invalid("Invalid message cursor.");
      reply = await client.messages(args[0] ?? "", { limit: options.limit === undefined ? undefined : Number(options.limit), beforeSeq: options.beforeSeq === undefined ? undefined : Number(options.beforeSeq), signal: deps.signal }); break;
    }
    case "message thread": {
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("Invalid message page size.");
      reply = await client.messageThread(args[0] ?? "", options.root ?? "", { limit: options.limit === undefined ? undefined : Number(options.limit), signal: deps.signal }); break;
    }
    case "message search": {
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("Invalid message search limit.");
      reply = await client.searchMessages(args[0] ?? "", { botRef: options.bot, limit: options.limit === undefined ? undefined : Number(options.limit), signal: deps.signal }); break;
    }
    case "bot get": reply = await client.bot(args[0] ?? "", deps.signal); break;
    case "bot resolve": reply = await client.resolveBot(args[0] ?? "", deps.signal); break;
    case "bot model get": reply = await client.botModel(args[0] ?? "", deps.signal); break;
    case "model get": reply = await client.model(args[0] ?? "", deps.signal); break;
    case "model default get": reply = await client.defaultModel(deps.signal); break;
    case "bot list":
    case "notification list":
    case "incident list":
    case "event list":
    case "model list": {
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw invalid("Invalid page size.");
      const page = { limit: options.limit === undefined ? undefined : Number(options.limit), cursor: options.cursor, signal: deps.signal };
      reply = command === "bot list" ? await client.bots(page) : command === "incident list" ? await client.incidents(page)
        : command === "event list" ? await client.observationEvents(page) : command === "notification list" ? await client.notifications(page) : await client.models(page);
      break;
    }
    case "operation reconcile":
      if(options.domain==="handover"){
        if(options.confirm!==true||options.bot!==undefined||options.expectRevision!==undefined||options.routineRef!==undefined)throw invalid("Handover reconciliation accepts only the original request and account scope.");
        reply=await client.continueHandover({requestId:options.requestId??"",scopeId:options.scopeId??"",action:"reconcile",confirmed:true},deps.signal);break;
      }
      if (options.domain === "compaction") {
        if (options.confirm !== true || options.routineRef !== undefined || options.expectRevision !== undefined) throw invalid("Compaction readback uses its original request, account and Bot, without a new revision.");
        reply = await client.continueCompaction({ action: "reconcile", requestId: options.requestId ?? "", scopeId: options.scopeId ?? "", botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
      }
      if (options.domain === "context") {
        if (options.confirm !== true || options.routineRef !== undefined || options.expectRevision !== undefined) throw invalid("Context reconciliation uses only its original request, scope and Bot; no new revision or Routine is accepted.");
        reply = await client.continueContext({ action: "reconcile", requestId: options.requestId ?? "", scopeId: options.scopeId ?? "", botRef: options.bot ?? "", confirmed: true }, deps.signal); break;
      }
      if (options.scopeId !== undefined || options.bot !== undefined) throw invalid("Routine reconciliation does not accept context locators.");
      if (options.domain !== "routine" || options.confirm !== true) throw invalid("This reconciliation requires domain routine and explicit confirmation.");
      reply = await client.changeSetup({action:"reconcile",routineRef:options.routineRef ?? "",expectedRevision:options.expectRevision ?? "",requestId:options.requestId ?? "",confirmed:true},deps.signal); break;
    case "operation get":
      if (options.domain === "desktop") { reply = await client.desktopOperation(options.requestId ?? "", deps.signal); break; }
      if (options.domain === "desktop-policy") { reply = await client.desktopPolicyOperation(options.requestId ?? "", deps.signal); break; }
      if(options.domain==="file"){reply=await client.fileOperation(options.requestId??"",deps.signal);break;}
      if (options.domain === "job") { reply = await client.jobOperation(options.requestId ?? "", deps.signal); break; }
      if (options.domain === "job-cancel") { reply = await client.jobCancellation(options.jobRef ?? "", options.requestId ?? "", deps.signal); break; }
      if(options.domain==="handover"){reply=await client.handoverOperation(options.scopeId??"",options.requestId??"",deps.signal);break;}
      if (options.domain === "compaction") { reply = await client.compactionOperation(options.scopeId ?? "", options.requestId ?? "", deps.signal); break; }
      if (options.domain === "context") { reply = await client.contextOperation(contextOperationRef(installationId, options.scopeId ?? "", options.requestId ?? ""), deps.signal); break; }
      if (options.domain === "lifecycle") { reply = await client.lifecycle(lifecycleReference(installationId, options.scopeId ?? "", options.requestId ?? ""), deps.signal); break; }
      if(options.domain==="protection") { reply=await client.protectionOperation(options.target??"",options.requestId??"",deps.signal);break; }
      if (options.domain === "material") { reply = await client.materialOperation(options.requestId ?? "",deps.signal); break; }
      if (options.domain === "routine") {
        if (options.databaseId !== undefined) throw invalid("Routine receipts use the original Bot, not an observation database.");
        reply = await client.setupOperation("routine",botIdFromRef(options.bot ?? "",installationId),options.requestId ?? "",deps.signal);
      } else if (options.domain === "notification-settings" || options.domain === "pairing") {
        if (options.databaseId !== undefined || options.bot !== undefined) throw invalid("This setup receipt is installation-scoped.");
        reply = await client.setupOperation(options.domain === "notification-settings" ? "settings" : "pairing","installation",options.requestId ?? "",deps.signal);
      } else if (options.domain === "incident") reply = await client.incidentOperation(options.databaseId ?? "", options.requestId ?? "", deps.signal);
      else if (options.domain === "receiver") reply = await client.receiverOperation(options.databaseId ?? "", options.requestId ?? "", deps.signal);
      else if (options.domain === "notification-test") reply = await client.notificationTestOperation(options.databaseId ?? "", options.requestId ?? "", deps.signal);
      else if (options.domain === "notification") reply = await client.notificationSendOperation(options.databaseId ?? "", options.requestId ?? "", deps.signal);
      else if ((options.domain === undefined || options.domain === "model") && options.databaseId === undefined) reply = await client.modelOperation(options.requestId ?? "", deps.signal);
      else throw invalid("Select a known operation domain and its original source locator; use operation get --help.");
      break;
    default: {
      let change: ModelChange;
      let reasoning;
      try { reasoning = parseRequestedEffort(options.effort); } catch { throw invalid("Invalid reasoning effort."); }
      if (command === "bot model set" || command === "bot model reset") {
        const agentId = botIdFromRef(args[0] ?? "", installationId);
        if (command === "bot model reset") change = { kind: "bot-selection", agentId, selection: { kind: "native" } };
        else {
          if (Boolean(options.model) === Boolean(options.followDefault) || (options.followDefault && options.effort !== undefined)) {
            throw invalid("Select exactly one explicit model or follow-default; followers cannot override its effort.");
          }
          change = { kind: "bot-selection", agentId, selection: options.followDefault ? { kind: "default" }
            : { kind: "model", modelId: options.model!, ...(reasoning ? { reasoning } : {}) } };
        }
      } else if (command === "model default set") change = { kind: "default-selection", selection: { modelId: args[0] ?? "", ...(reasoning ? { reasoning } : {}) } };
      else if (command === "model default reset") change = { kind: "default-selection", selection: null };
      else if (command === "model apply") change = declared!.change;
      else if (command === "model delete") change = { kind: "model-delete", modelId: args[0] ?? "" };
      else throw invalid("Unknown management command.");
      const input = declared ?? { requestId: options.requestId ?? "", expectedRevision: options.expectRevision ?? "", change };
      if (!input.requestId || !input.expectedRevision) throw invalid("A mutation requires request-id and expect-revision.");
      const outcome = await client.changeModels(input, deps.signal);
      if (outcome.data.state === "unknown") {
        const error = { code: "operation_unknown" as const, message: "The model operation remains uncertain; inspect its original receipt without resubmitting.",
          details: { installationId, requestId: input.requestId, operationRef: outcome.data.operationRef } };
        throw new ManagementClientError(error.code, error.message, error.details, {
          schemaVersion: outcome.schemaVersion, installationId: outcome.installationId, invocationId: outcome.invocationId, ok: false, error,
        });
      }
      reply = outcome;
    }
  }
  deps.stdout.write(`${JSON.stringify({ ...reply, command: command.replaceAll(" ", ".") })}\n`);
}

export function writeManagementFailure(deps: CliDeps, command: string, error: unknown): number {
  let failure: ManagementClientError;
  if (error instanceof ManagementClientError) failure = error;
  else if(error instanceof FileError) failure=new ManagementClientError(error.code,error.message);
  else if (error instanceof ConfigError) failure = new ManagementClientError("unavailable", "The client configuration requires inspection or explicit recovery.");
  else if (error instanceof CliError) failure = new ManagementClientError(error.code.startsWith("credential_") ? "authentication_required"
    : error.code === "profile_not_found" ? "not_found" : "invalid_input", "The command or its configured credential is unavailable.");
  else failure = new ManagementClientError("unavailable", "The management command did not complete; inspect the selected service.");
  const codes: Partial<Record<ApiErrorCode, number>> = {
    invalid_input: 2, authentication_required: 3, permission_denied: 3, caller_identity_unavailable: 3, not_found: 4, ambiguous_target: 5,
    wrong_installation: 5, revision_conflict: 5, idempotency_conflict: 5, model_in_use: 5, model_default_in_use: 5, model_default_missing: 5,
    model_source_read_only: 6, cursor_gap: 5, operation_unknown: 8, protection_target_conflict: 5, source_changed: 5, incident_resolved: 5, notification_test_refused: 5, notification_send_refused: 5, file_change_refused: 5, desktop_prune_refused: 5,
  };
  const envelope = failure.reply ?? { schemaVersion: 1, installationId: failure.details?.installationId ?? null, invocationId: deps.randomUUID(), ok: false,
    error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } };
  deps.stdout.write(`${JSON.stringify({ ...envelope, command: command.replaceAll(" ", "."), ...(deps.signal?.aborted ? { meta: { interrupted: true } } : {}) })}\n`);
  return deps.signal?.aborted ? 130 : codes[failure.code] ?? 7;
}
