import { projectStreamDiagnostic, type AuthorityDiagnostic } from "./stream-diagnostic.ts";

function message(detail?: AuthorityDiagnostic): string {
  const read = detail?.ownershipRead;
  if (detail?.reason === "server_read_unavailable") {
    const messages: Record<string, string> = {
      timeout: "The Host timed out while reading this Bot's server ownership.",
      authorization_unavailable: "The Host could not authenticate or access the server ownership service. This is not a model-provider credential failure.",
      unsupported_rpc: "The server does not support the Host's ownership-read RPC.",
      invalid_response: "The Host received an invalid server ownership response.",
      server_read_failed: "The Host could not complete the server ownership read.",
      busy: "The Host ownership reader is still occupied by an earlier read.",
      invalid_request: "The Host rejected an invalid ownership-read request.",
      scope_unavailable: "The Host could not establish the identity scope for the ownership read.",
      scope_changed: "The Host identity scope changed during the ownership read.",
      source_cancelled: "The ownership source read was cancelled. The available evidence does not identify the cancelling actor.",
      clock_unavailable: "The ownership read could not establish a valid elapsed-time observation.",
    };
    return read?.state === "unavailable" && read.errorCode ? messages[read.errorCode] ?? "The Host could not obtain usable ownership evidence."
      : "The local runtime could not obtain a usable server ownership observation for this Bot. The underlying read error was not recorded.";
  }
  if (detail?.reason === "ownership_read_timeout") return detail.availabilityCause === "wait_budget"
    ? "This STEP exhausted its remaining qualification wait budget. This does not establish that Bot ownership changed."
    : "The local runtime timed out waiting for the Host/Gateway ownership read. This does not establish that Bot ownership changed.";
  if (["ownership_reader_unavailable", "ownership_read_unavailable", "ownership_bridge_unavailable", "ownership_gateway_mismatch"].includes(detail?.reason ?? "")) {
    return "The local runtime could not obtain ownership evidence through the current Host/Gateway channel. Check the channel and loaded components; this does not establish that the Host is stopped.";
  }
  if (["harness_mismatch", "server_id_mismatch", "ownership_identity_changed"].includes(detail?.reason ?? "")) return "The Bot's server and local execution identities disagree or changed during this request.";
  if (detail?.reason === "confirmed_temporal") return "This Bot uses the server-side agent loop; this Box-local model runtime cannot execute it.";
  if (detail?.reason === "ownership_evidence_stale") {
    const why = detail.availabilityCause === "read_elapsed" ? " The ownership read returned after its evidence was already too old."
      : detail.availabilityCause === "evidence_elapsed" ? " The evidence expired during subsequent qualification work."
      : detail.availabilityCause === "permit_elapsed" ? " The issued permit expired before it could be consumed, including any intervening credential verification."
      : " The detecting timing boundary was not recorded.";
    return "The Bot ownership evidence was too old to authorize this STEP." + why
      + " This does not establish that ownership changed or that the Bot is temporal.";
  }
  if (detail?.reason === "native_execution_not_ready") return "The native Host was not ready to authorize local execution. Check its pause/binding state; do not infer that the Host process is stopped.";
  if (detail?.reason === "turn_closed") return "This TURN has already closed after a failed eligibility check and cannot be replayed. This is not proof that Bot ownership changed.";
  if (detail?.reason === "turn_revoked") return "This TURN no longer has valid execution authority and cannot be revived by replaying it.";
  if (["host_identity_mismatch", "host_generation_changed", "authority_not_committed"].includes(detail?.reason ?? "")) return "The local Host generation or committed runtime authority could not be verified.";
  return "The local runtime could not verify this Bot's execution eligibility. This does not establish that the account lacks permission.";
}

/** Shared read-only guidance for CLI model selection and Host/STEP failures.
 * Presentation never changes classification, restarts a Host, refreshes title,
 * or authorizes replay. Missing historical evidence stays unknown. */
export function presentAuthorityFailure(raw: AuthorityDiagnostic | undefined, target: { agentId?: string; stepId?: string } = {}) {
  const detail = projectStreamDiagnostic({ authority: raw })?.authority;
  const reason = detail?.reason, readCode = detail?.ownershipRead?.errorCode;
  const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  const ownership = `grokbox agents ownership ${id(target.agentId) ? target.agentId : "<agent>"}`;
  const incident = id(target.agentId) && id(target.stepId)
    ? `grokbox runtime incident ${target.stepId} --agent ${target.agentId} --json` : ownership;
  const component = ["ownership_bridge_unavailable", "ownership_gateway_mismatch", "host_identity_mismatch", "host_generation_changed", "authority_not_committed"].includes(reason ?? "")
    || reason === "server_read_unavailable" && ["unsupported_rpc", "invalid_request", "invalid_response"].includes(readCode ?? "");
  const local = ["ownership_reader_unavailable", "ownership_read_unavailable", "authority_unavailable", "native_execution_not_ready"].includes(reason ?? "");
  const access = reason === "server_read_unavailable" && readCode === "authorization_unavailable";
  const action = component ? "align_local_components" : local ? "inspect_local_runtime"
    : access ? "check_ownership_access" : "check_ownership";
  const next = component || local ? "grokbox doctor"
    : ["ownership_evidence_stale", "ownership_read_timeout", "turn_closed", "turn_revoked"].includes(reason ?? "") ? incident : ownership;
  return { message: message(detail), action, next };
}
