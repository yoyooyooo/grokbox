import { TOOL_IDENTITY_TAIL_MAX, toolChoiceMode, type GenerationOptions, type ToolDefinition, type ToolIdentityAudit, type ToolNameObservation, type ToolNameRelation, type StreamEvidence } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";

const digestNames = (names: readonly string[]) => sha256Text(canonicalJson(["tool-names-v1", [...names].sort()]));
const digestSchemas = (tools: readonly { name: string; inputSchema: unknown }[]) => sha256Text(canonicalJson(["tool-schemas-v1",
  [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(t => [t.name, t.inputSchema]),
]));
type NameState = { name?: string; changed: boolean };
type RequestMismatch = "tool_declaration_mismatch" | "tool_schema_declaration_mismatch" | "tool_choice_declaration_mismatch";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function sentChoice(raw: unknown, api: "chat" | "responses"): GenerationOptions["toolChoice"] {
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (record(raw) && raw.type === "function") {
    const name = api === "chat" && record(raw.function) ? raw.function.name : api === "responses" ? raw.name : undefined;
    if (typeof name === "string" && name.length > 0 && name.length <= 128) return { type: "tool", toolName: name };
  }
  throw Error("invalid choice");
}

/** One provider attempt owns this observer. No aliases, payload logs, execution,
 * extra reads or background drain. Schema comparison is final-encoding parity,
 * not validation of generated arguments against JSON Schema. */
export class ToolIdentityObserver {
  private readonly names: readonly string[];
  private readonly declared: ReadonlySet<string>;
  private readonly providerNames = new Map<string, NameState>();
  private readonly sdkNames = new Map<string, NameState>();
  private readonly historyNames = new Set<string>();
  private readonly audit: ToolIdentityAudit;
  private readonly requestedChoice: GenerationOptions["toolChoice"];
  private mismatch: RequestMismatch = "tool_declaration_mismatch";
  constructor(names: readonly string[], private readonly evidence: StreamEvidence, options: {
    tools?: readonly ToolDefinition[]; toolChoice?: GenerationOptions["toolChoice"];
    messages?: readonly { role: string; content: string | readonly { type: string; toolName?: string }[] }[];
  } = {}) {
    this.names = [...names]; this.declared = new Set(names);
    this.requestedChoice = typeof options.toolChoice === "object" ? { ...options.toolChoice } : options.toolChoice;
    this.audit = { version: 1, declared: { count: names.length, digest: digestNames(names) }, observed: 0, tail: [], truncated: false,
      ...(options.tools ? { contract: { schemaDigest: digestSchemas(options.tools), requestedChoice: toolChoiceMode(options.toolChoice) } } : {}) };
    if (options.messages) {
      this.audit.historyTruncated = false;
      for (const message of options.messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content) if (part.type === "tool-call" && typeof part.toolName === "string") {
          if (this.historyNames.has(part.toolName)) continue;
          if (this.historyNames.size < 128) this.historyNames.add(part.toolName);
          else this.audit.historyTruncated = true;
        }
      }
    }
    this.publish();
  }
  requestMismatch(): RequestMismatch { return this.mismatch; }
  /** Inspect exact encoded declarations after all SDK/dialect transformations. */
  request(body: string, api: "chat" | "responses"): boolean {
    this.mismatch = "tool_declaration_mismatch";
    delete this.audit.sent;
    if (this.audit.contract) {
      delete this.audit.contract.sentSchemaDigest; delete this.audit.contract.schemasMatch;
      delete this.audit.contract.sentChoice; delete this.audit.contract.choiceMatch;
    }
    this.publish();
    let value: Record<string, unknown>, sent: { name: string; inputSchema: unknown }[];
    try {
      const parsed: unknown = JSON.parse(body);
      if (!record(parsed) || (parsed.tools !== undefined && !Array.isArray(parsed.tools))) return false;
      value = parsed;
      const tools = (value.tools ?? []) as unknown[];
      if (tools.length > 128) return false;
      sent = tools.map(tool => {
        if (!record(tool) || tool.type !== "function") throw Error("invalid name table");
        const definition = api === "chat" ? tool.function : tool;
        if (!record(definition) || typeof definition.name !== "string" || !definition.name || definition.name.length > 128) throw Error("invalid name table");
        return { name: definition.name, inputSchema: definition.parameters };
      });
    } catch { return false; }
    const digest = digestNames(sent.map(t => t.name)), matchesDeclared = digest === this.audit.declared.digest;
    this.audit.sent = { count: sent.length, digest, matchesDeclared };
    const contract = this.audit.contract;
    if (contract) {
      delete contract.sentSchemaDigest; delete contract.sentChoice;
      contract.schemasMatch = false; contract.choiceMatch = false;
      try {
        if (sent.some(t => !record(t.inputSchema))) throw Error("invalid schema table");
        contract.sentSchemaDigest = digestSchemas(sent);
        contract.schemasMatch = contract.sentSchemaDigest === contract.schemaDigest;
      } catch { /* missing/malformed schemas never count as equivalent */ }
      try {
        // The SDK omits tool_choice when no tools exist; explicit none remains
        // equivalent only in that zero-capability request.
        const choice = value.tool_choice === undefined && sent.length === 0 && this.requestedChoice === "none" ? "none" : sentChoice(value.tool_choice, api);
        contract.sentChoice = toolChoiceMode(choice);
        contract.choiceMatch = canonicalJson(choice ?? "auto") === canonicalJson(this.requestedChoice ?? "auto");
      } catch { /* invalid choice is a pre-dispatch failure */ }
      if (matchesDeclared && !contract.schemasMatch) this.mismatch = "tool_schema_declaration_mismatch";
      else if (matchesDeclared && !contract.choiceMatch) this.mismatch = "tool_choice_declaration_mismatch";
    }
    this.publish();
    return matchesDeclared && (!contract || (contract.schemasMatch === true && contract.choiceMatch === true));
  }
  provider(id: unknown, name: unknown): void { this.observe("provider", id, name); }
  sdk(id: unknown, name: unknown): void { this.observe("sdk", id, name); }
  private relation(name: unknown): { relation: ToolNameRelation; candidateCount?: number } {
    if (typeof name !== "string" || name.length > 1024) return { relation: "invalid_type" };
    if (!name) return { relation: "empty" };
    if (this.declared.has(name)) return { relation: "exact", candidateCount: 1 };
    const lower = this.names.filter(n => n.toLowerCase() === name.toLowerCase());
    if (lower.length) return { relation: "case_only", candidateCount: lower.length };
    const qualified = this.names.filter(n => name.endsWith(`.${n}`) || name.endsWith(`/${n}`) || name.endsWith(`::${n}`));
    if (qualified.length) return { relation: "qualified", candidateCount: qualified.length };
    const prefixes = this.names.filter(n => n.startsWith(name));
    if (prefixes.length) return { relation: "strict_prefix", candidateCount: prefixes.length };
    return { relation: "unmatched", candidateCount: 0 };
  }
  private observe(layer: "provider" | "sdk", id: unknown, name: unknown): void {
    const names = layer === "provider" ? this.providerNames : this.sdkNames;
    const boundedId = typeof id === "string" && id.length > 0 && id.length <= 1024 ? id : undefined;
    const boundedName = typeof name === "string" && name.length <= 1024 ? name : undefined;
    const previous = boundedId === undefined ? undefined : names.get(boundedId);
    if (previous && boundedName !== undefined && previous.name === boundedName) return;
    const callDigest = boundedId === undefined ? undefined : sha256Text(boundedId);
    const changed = previous !== undefined || boundedName === undefined;
    if (layer === "provider" && changed && callDigest) {
      // Audit can run ahead of SDK consumption. Once the wire identity changes,
      // invalidate earlier comparisons too; never compare to a moving last slot.
      for (const item of [...this.audit.tail, ...(this.audit.firstMismatch ? [this.audit.firstMismatch] : [])]) {
        if (item.layer === "sdk" && item.callDigest === callDigest) {
          delete item.wireNameMatched; item.wireComparison = "identity_changed";
        }
      }
    }
    const wire = layer === "sdk" && boundedId !== undefined ? this.providerNames.get(boundedId) : undefined;
    const comparable = wire !== undefined && !wire.changed && wire.name !== undefined && boundedName !== undefined;
    const item: ToolNameObservation = { layer, ...this.relation(name), phase: previous === undefined ? "first" : "changed",
      ...(boundedName !== undefined ? { nameLength: boundedName.length, nameDigest: sha256Text(boundedName) } : {}),
      ...(callDigest ? { callDigest } : {}),
      ...(layer === "sdk" ? { wireComparison: wire?.changed ? "identity_changed" : comparable ? "stable_identity" : "not_observed" } : {}),
      ...(comparable ? { wireNameMatched: wire!.name === boundedName } : {}),
      ...(this.audit.historyTruncated !== undefined && boundedName !== undefined ? { history: this.historyNames.has(boundedName) ? "structured_call" : this.audit.historyTruncated ? "unknown" : "not_observed" } : {}),
    };
    if (boundedId !== undefined && (names.has(boundedId) || names.size < 128)) names.set(boundedId, { name: boundedName, changed });
    this.audit.observed = Math.min(1024 * 1024 * 1024, this.audit.observed + 1);
    if (item.relation !== "exact" && !this.audit.firstMismatch) this.audit.firstMismatch = item;
    this.audit.tail.push(item);
    if (this.audit.tail.length > TOOL_IDENTITY_TAIL_MAX) { this.audit.tail.shift(); this.audit.truncated = true; }
    this.publish();
  }
  private publish(): void { this.evidence.toolIdentity(this.audit); }
  dispose(): void { this.providerNames.clear(); this.sdkNames.clear(); this.historyNames.clear(); }
}
