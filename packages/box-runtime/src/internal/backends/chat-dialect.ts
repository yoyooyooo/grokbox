import { EnvelopeError, invalidStream } from "@grokbox/runtime-kernel/contract";
import type { ModelRecord } from "@grokbox/runtime-kernel/selection";

export type ChatDialect = "standard" | "minimax-inline-v1";
/** Protocol qualification uses an exact origin/path, never a provider nickname
 * or substring. Proxies must explicitly select a dialect; explicit standard opts out. */
export function chatDialect(record: Pick<ModelRecord, "endpoint" | "provider" | "chatDialect">): ChatDialect {
  if (record.chatDialect !== undefined) {
    if (record.chatDialect !== "standard" && record.chatDialect !== "minimax-inline-v1") throw new EnvelopeError("unsupported_options");
    if (record.provider === "openai-responses" && record.chatDialect !== "standard") throw new EnvelopeError("unsupported_options");
    return record.chatDialect;
  }
  if (record.provider !== "openai" && record.provider !== "openai-chat") return "standard";
  try {
    const url = new URL(record.endpoint);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash
      && (url.hostname === "api.minimaxi.com" || url.hostname === "api.minimax.io") && /^\/v1\/?$/.test(url.pathname)
      ? "minimax-inline-v1" : "standard";
  } catch { return "standard"; }
}
export function encodeDialectRequest(init: RequestInit | undefined, dialect: ChatDialect): RequestInit | undefined {
  if (dialect === "standard") return init;
  if (typeof init?.body !== "string") throw new EnvelopeError("unsupported_content");
  const body = JSON.parse(init.body);
  // The current canonical history can preserve native inline content exactly.
  // Do not request opaque split metadata and then silently discard it.
  if (body.reasoning_split === true) throw new EnvelopeError("unsupported_options");
  return { ...init, body: JSON.stringify({ ...body, reasoning_split: false }) };
}

/** Classify only the documented initial think block. Markers stay in the
 * reasoning part so flattening ordered assistant history reproduces the exact
 * provider content. No regex stripping, opaque side cache or text duplication.
 * Buffer is at most the length of one marker, independent of reasoning size. */
export class InlineThinkingParts {
  private phase: "initial" | "thinking" | "text" = "initial";
  private pending = "";
  map(part: unknown): unknown[] {
    if (!part || typeof part !== "object") return [part];
    const p = part as { type?: string; delta?: string; text?: string; textDelta?: string };
    if (p.type === "error" || p.type === "abort") { this.pending = ""; return [part]; }
    if (p.type !== "text-delta") {
      const out: unknown[] = [];
      if (p.type === "finish" || p.type === "tool-input-start" || p.type === "tool-call") {
        if (this.phase === "thinking") throw invalidStream("unterminated_reasoning", "sdk_part");
        if (this.pending) { out.push({ type: "text-delta", delta: this.pending }); this.pending = ""; this.phase = "text"; }
      }
      return [...out, part];
    }
    const incoming = typeof p.delta === "string" ? p.delta : typeof p.text === "string" ? p.text : p.textDelta;
    if (typeof incoming !== "string") return [part];
    const out: unknown[] = [];
    const emit = (type: "text-delta" | "reasoning-delta", delta: string) => { if (delta) out.push({ type, delta }); };
    this.pending += incoming;
    if (this.phase === "initial") {
      const marker = "<think>";
      if (marker.startsWith(this.pending) && this.pending.length < marker.length) return [];
      if (this.pending.startsWith(marker)) {
        emit("reasoning-delta", marker); this.pending = this.pending.slice(marker.length); this.phase = "thinking";
      } else this.phase = "text";
    }
    if (this.phase === "thinking") {
      const marker = "</think>", end = this.pending.indexOf(marker);
      if (end >= 0) {
        emit("reasoning-delta", this.pending.slice(0, end + marker.length)); this.pending = this.pending.slice(end + marker.length); this.phase = "text";
      } else {
        // Retain only a possible split closing marker suffix.
        let keep = Math.min(marker.length - 1, this.pending.length);
        while (keep > 0 && !marker.startsWith(this.pending.slice(-keep))) keep--;
        emit("reasoning-delta", this.pending.slice(0, this.pending.length - keep));
        this.pending = keep ? this.pending.slice(-keep) : "";
      }
    }
    if (this.phase === "text") { emit("text-delta", this.pending); this.pending = ""; }
    return out;
  }
}
