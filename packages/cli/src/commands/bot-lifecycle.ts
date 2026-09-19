import { openBotLifecycle } from "@grokbox/box-runtime/runtime";
import { botWorkflowRequest, botWorkflowDigest, botProfile, isContinuityUuid, isContinuityHash, ContinuityFailure,
  CurrentStateFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { ioFromOpts } from "../opts.ts";
import { writeSuccess } from "../output.ts";
import { createGatewayBotLifecycle } from "../gateway-bot-lifecycle.ts";
import { botProfileRevision } from "../gateway-bot-material.ts";
import { createGatewayBotHandover } from "../gateway-bot-handover.ts";

type Options = { operationId?: string; scopeId?: string; expectPlan?: string; snapshotId?: string; name?: string;
  description?: string; systemPromptFile?: string; model?: string; effort?: string; activate?: boolean; start?: boolean;
  maxRunMs?: string; confirm?: boolean; timeoutMs?: string; json?: boolean; allowHandoverMessages?: boolean };
export async function readBotInstructions(path: string | undefined): Promise<string> {
  if (path === undefined) return "";
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536) throw usage("Instruction file must be a regular file of at most 64 KiB.");
    const bytes = Buffer.alloc(65537), n = await file.read(bytes, 0, bytes.length, 0);
    if (n.bytesRead !== stat.size || n.bytesRead > 65536) throw usage("Instruction file changed while reading.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n.bytesRead));
    if (text.includes("\0")) throw usage("Instruction file contains invalid text."); return text;
  } finally { await file.close(); }
}
export async function runBotLifecycle(deps: CliDeps, action: "clone" | "replace" | "spawn" | "status" | "advance", sourceId: string | undefined, raw: Options) {
  if (!["auto", "local"].includes(deps.transport) || deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl) throw usage("Bot lifecycle control is Box-local.");
  if (!isContinuityUuid(raw.operationId)) throw usage("A stable --operation-id UUID is required.");
  if ((action === "clone" || action === "replace") && !isContinuityUuid(sourceId)) throw usage("An exact source Bot UUID is required.");
  if ((raw.confirm || action === "status" || action === "advance") && !isContinuityHash(raw.scopeId)) throw usage("Use the exact --scope-id from the preview.");
  if ((raw.confirm || action === "advance") && !isContinuityHash(raw.expectPlan)) throw usage("Confirmation requires --expect-plan from the preview.");
  if (action === "advance" && raw.confirm !== true) throw usage("Advancing a saved workflow requires --confirm.");
  const io = ioFromOpts({ ...raw, timeoutMs: raw.timeoutMs ?? "180000" });
  const adapter = createGatewayBotLifecycle(deps, { timeoutMs: io.timeoutMs,
    handover: (request) => createGatewayBotHandover(deps, request.scopeId, io.timeoutMs).program.advance(request.operationId, 16, deps.signal) });
  try {
    if (action === "status" || action === "advance") {
      const program = openBotLifecycle({ durableRoot: deps.boxRuntimeRoot, scopeId: raw.scopeId!, native: adapter.native });
      if (action === "status") { writeSuccess(deps.stdout, await program.status(raw.operationId)); return; }
      const request = await program.request(raw.operationId);
      if (botWorkflowDigest(request) !== raw.expectPlan) throw usage("The saved plan does not match.");
      const result = await program.advance(request, deps.signal);
      writeSuccess(deps.stdout, { ...result, planRevision: botWorkflowDigest(request) }); return;
    }
    const caps = await adapter.capabilities(sourceId ?? raw.operationId);
    if (raw.scopeId !== undefined && raw.scopeId !== caps.scopeId) throw new CurrentStateFailure("source_changed");
    const program = openBotLifecycle({ durableRoot: deps.boxRuntimeRoot, scopeId: caps.scopeId, native: adapter.native });
    let saved: BotWorkflowRequest | null = null;
    if (raw.confirm) {
      saved = await program.request(raw.operationId).catch(error => {
        if (error instanceof ContinuityFailure && ["not_initialized", "not_found"].includes(error.code)) return null; throw error;
      });
    }
    let request: BotWorkflowRequest;
    if (saved) {
      if (saved.kind !== action || saved.sourceId !== (sourceId ?? null) || botWorkflowDigest(saved) !== raw.expectPlan) throw usage("Existing operation has a different plan; it cannot be repurposed.");
      request = saved;
    } else {
      const original = action === "spawn" ? null : await adapter.profile(sourceId!);
      const model = await adapter.selected(sourceId ?? null, raw.model === "official" ? null : raw.model, raw.effort);
      const profile = botProfile({ name: raw.name ?? (original ? `${original.name} · ${action === "replace" ? "继任" : "克隆"}` : "临时 Bot"),
        description: raw.description ?? original?.description ?? "", title: original ? parseAgentTitle(original.title).user : "",
        avatarShape: original?.avatarShape ?? "", avatarColor: original?.avatarColor ?? "" });
      request = botWorkflowRequest({ version: 1, operationId: raw.operationId, scopeId: caps.scopeId, kind: action,
        sourceId: sourceId ?? null, profile, ...model, instructions: await readBotInstructions(raw.systemPromptFile), snapshotId: raw.snapshotId ?? null,
        activate: action === "spawn" || action === "replace" || raw.activate === true || raw.start === true, start: action === "spawn" || raw.start === true,
        ...(action === "replace" ? { handover: { allowUserMessages: raw.allowHandoverMessages === true } } : {}),
        maxRunMs: raw.maxRunMs === undefined ? 180000 : Number(raw.maxRunMs), policyRevision: caps.policyRevision,
        ...(original ? { sourceRevision: botProfileRevision(original) } : {}) });
    }
    const planRevision = botWorkflowDigest(request);
    if (!raw.confirm) {
      writeSuccess(deps.stdout, { operationId: request.operationId, scopeId: request.scopeId, planRevision, kind: action, sourceId: request.sourceId,
        targetName: request.profile.name, model: request.modelRef ?? "official", instructionsHash: sha256Text(request.instructions),
        activate: request.activate, start: request.start, maxRunMs: request.maxRunMs, qualityPolicy: "best_effort_with_gaps",
        sourceDeleted: false, copyRoutineEnabled: false, state: "preview", initialized: false }); return;
    }
    if (raw.expectPlan !== planRevision) throw usage("The source, model or instruction plan changed; review a new preview.");
    writeSuccess(deps.stdout, { ...(await program.advance(request, deps.signal)), planRevision });
  } catch (error) {
    if (error instanceof CliError) throw error;
    const reason = error instanceof CurrentStateFailure || error instanceof ContinuityFailure ? error.code : "unavailable";
    throw new CliError(["commit_unknown", "cleanup_unknown"].includes(reason) ? "operation_outcome_unknown" : "capability_unavailable",
      "Bot lifecycle operation stopped; inspect the same operation before advancing.", { hostReason: reason,
        context: { operationId: raw.operationId, phase: "bot-lifecycle" } });
  }
}
