import { TOOL_IDENTITY_TAIL_MAX, type ToolIdentityAudit, type ToolNameObservation, type ToolNameRelation, type StreamEvidence } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";

const digestNames = (names: readonly string[]) => sha256Text(canonicalJson(["tool-names-v1", [...names].sort()]));
/** One provider request owns this observer. Relations are evidence only: no name
 * repair, fuzzy dispatch, raw logging, extra reads or background response drain. */
export class ToolIdentityObserver {
  private readonly names: readonly string[];
  private readonly declared: ReadonlySet<string>;
  private readonly providerNames = new Map<string, string>();
  private readonly sdkNames = new Map<string, string>();
  private readonly audit: ToolIdentityAudit;
  constructor(names: readonly string[], private readonly evidence: StreamEvidence) {
    this.names = [...names]; this.declared = new Set(names);
    this.audit = { version: 1, declared: { count: names.length, digest: digestNames(names) }, observed: 0, tail: [], truncated: false };
    this.publish();
  }
  /** Inspect only the exact encoded name table, not an approximation of SDK input. */
  request(body: string, api: "chat" | "responses"): boolean {
    let sent: string[];
    try {
      const value = JSON.parse(body);
      if (value.tools !== undefined && !Array.isArray(value.tools)) return false;
      sent = (value.tools ?? []).map((tool: { type?: unknown; name?: unknown; function?: { name?: unknown } }) => {
        const name = api === "chat" ? tool.function?.name : tool.name;
        if (tool.type !== "function" || typeof name !== "string" || name.length > 128) throw Error("invalid name table");
        return name;
      });
      if (sent.length > 128) return false;
    } catch { return false; }
    const digest = digestNames(sent), matchesDeclared = digest === this.audit.declared.digest;
    this.audit.sent = { count: sent.length, digest, matchesDeclared }; this.publish();
    return matchesDeclared;
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
    if (boundedId !== undefined && boundedName !== undefined && previous === boundedName) return;
    const wire = layer === "sdk" && boundedId !== undefined ? this.providerNames.get(boundedId) : undefined;
    const item: ToolNameObservation = { layer, ...this.relation(name), phase: previous === undefined ? "first" : "changed",
      ...(boundedName !== undefined ? { nameLength: boundedName.length, nameDigest: sha256Text(boundedName) } : {}),
      ...(boundedId !== undefined ? { callDigest: sha256Text(boundedId) } : {}),
      ...(wire !== undefined && boundedName !== undefined ? { wireNameMatched: wire === boundedName } : {}),
    };
    if (boundedId !== undefined && boundedName !== undefined && (names.has(boundedId) || names.size < 128)) names.set(boundedId, boundedName);
    this.audit.observed = Math.min(1024 * 1024 * 1024, this.audit.observed + 1);
    if (item.relation !== "exact" && !this.audit.firstMismatch) this.audit.firstMismatch = item;
    this.audit.tail.push(item);
    if (this.audit.tail.length > TOOL_IDENTITY_TAIL_MAX) { this.audit.tail.shift(); this.audit.truncated = true; }
    this.publish();
  }
  private publish(): void { this.evidence.toolIdentity(this.audit); }
  dispose(): void { this.providerNames.clear(); this.sdkNames.clear(); }
}
