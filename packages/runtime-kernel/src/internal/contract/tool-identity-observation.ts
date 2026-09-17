/** Bounded, payload-free witnesses. A name relation is diagnostic, never an alias
 * or permission to execute a tool. No tool names, IDs, arguments or schemas escape. */
export const TOOL_NAME_RELATIONS = ["exact", "case_only", "qualified", "strict_prefix", "unmatched", "empty", "invalid_type"] as const;
export type ToolNameRelation = typeof TOOL_NAME_RELATIONS[number];
export const TOOL_IDENTITY_TAIL_MAX = 8;
export type ToolNameObservation = {
  layer: "provider" | "sdk";
  relation: ToolNameRelation;
  nameLength?: number;
  nameDigest?: string;
  callDigest?: string;
  candidateCount?: number;
  phase: "first" | "changed";
  wireNameMatched?: boolean;
};
export type ToolIdentityAudit = {
  version: 1;
  declared: { count: number; digest: string };
  sent?: { count: number; digest: string; matchesDeclared: boolean };
  observed: number;
  firstMismatch?: ToolNameObservation;
  tail: ToolNameObservation[];
  truncated: boolean;
};
function own(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
function count(value: unknown, max = 1024 * 1024 * 1024): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}
function digest(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
function nameObservation(value: unknown): ToolNameObservation | undefined {
  const layer = own(value, "layer"), relation = own(value, "relation"), phase = own(value, "phase");
  if ((layer !== "provider" && layer !== "sdk") || (phase !== "first" && phase !== "changed")
    || typeof relation !== "string" || !TOOL_NAME_RELATIONS.includes(relation as ToolNameRelation)) return undefined;
  const nameLength = count(own(value, "nameLength"), 1024), nameDigest = digest(own(value, "nameDigest"));
  const callDigest = digest(own(value, "callDigest")), candidateCount = count(own(value, "candidateCount"), 128);
  const wireNameMatched = own(value, "wireNameMatched");
  return { layer, relation: relation as ToolNameRelation, phase,
    ...(nameLength !== undefined ? { nameLength } : {}), ...(nameDigest ? { nameDigest } : {}),
    ...(callDigest ? { callDigest } : {}), ...(candidateCount !== undefined ? { candidateCount } : {}),
    ...(typeof wireNameMatched === "boolean" ? { wireNameMatched } : {}),
  };
}
export function projectToolIdentityAudit(value: unknown): ToolIdentityAudit | undefined {
  try {
    if (own(value, "version") !== 1) return undefined;
    const declared = own(value, "declared"), n = count(own(declared, "count"), 128), d = digest(own(declared, "digest"));
    const observed = count(own(value, "observed")), truncated = own(value, "truncated");
    if (n === undefined || !d || observed === undefined || typeof truncated !== "boolean") return undefined;
    const out: ToolIdentityAudit = { version: 1, declared: { count: n, digest: d }, observed, truncated, tail: [] };
    const sent = own(value, "sent"), sn = count(own(sent, "count"), 128), sd = digest(own(sent, "digest")), match = own(sent, "matchesDeclared");
    if (sn !== undefined && sd && typeof match === "boolean") out.sent = { count: sn, digest: sd, matchesDeclared: match };
    const first = nameObservation(own(value, "firstMismatch"));
    if (first) out.firstMismatch = first;
    const tail = own(value, "tail");
    if (Array.isArray(tail)) {
      if (tail.length > TOOL_IDENTITY_TAIL_MAX) out.truncated = true;
      for (let i = Math.max(0, tail.length - TOOL_IDENTITY_TAIL_MAX); i < tail.length; i++) {
        const item = nameObservation(own(tail, String(i)));
        if (item) out.tail.push(item);
      }
    }
    return out;
  } catch { return undefined; }
}
