import { BackendFailure, CANONICAL_OUTPUT_MAX_BYTES, ChunkedText, StreamEvidence, annotateStreamFailure, invalidStream, type StreamBudgetDiagnostic } from "@grokbox/runtime-kernel/contract";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { interruptedProviderFinish } from "./failure-observation.ts";
import type { OpenaiPromptApi } from "./openai-prompt-adapter.ts";

// Validation before the SDK can discard raw finish reasons or trailing tool
// arguments. Bytes are never rewritten and never enter outward diagnostics.
export const PROVIDER_EVENT_MAX_BYTES = CANONICAL_OUTPUT_MAX_BYTES;
export const PROVIDER_WIRE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOOLS = 128;
const record = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const bytes = (s: string) => new TextEncoder().encode(s).length;
type Tool = { fragments: ChunkedText; final?: string; id?: string; name?: string };
export class ProviderStreamAudit {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly lineParts = new ChunkedText();
  private lineBytes = 0;
  private skipLF = false;
  private readonly data = new ChunkedText();
  private dataLines = 0;
  private eventBytes = 0;
  private wireBytes = 0;
  private argumentBytes = 0;
  private done = false;
  private ended = false;
  private failed = false;
  private violation?: BackendFailure;
  failure(): BackendFailure | undefined { return this.violation; }
  private readonly tools = new Map<string, Tool>();
  constructor(private readonly api: OpenaiPromptApi, readonly evidence: StreamEvidence) { evidence.providerStarted(); }
  headers(status: number): void { this.evidence.httpStatus(status); this.evidence.first("headersMs"); this.evidence.provider("headers"); }
  instrumented(): void { this.evidence.instrumented(); }
  private site() { return this.api === "chat" ? "provider_chat_wire" as const : "provider_responses_wire" as const; }
  private limit(metric: StreamBudgetDiagnostic["metric"], limit: number, measured: number): never {
    throw annotateStreamFailure(new BackendFailure("stream_limit"), { normalizeCause: "stream_budget", rejectSite: this.site(), budget: { layer: "provider", metric, limit, measured } });
  }
  private tool(key: string): Tool {
    let t = this.tools.get(key);
    if (!t) { if (this.tools.size >= MAX_TOOLS) this.limit("tool_count", MAX_TOOLS, this.tools.size + 1); t = { fragments: new ChunkedText() }; this.tools.set(key, t); }
    return t;
  }
  private identity(t: Tool, id: unknown, name: unknown): void {
    for (const [key, value] of [["id", id], ["name", name]] as const) {
      if (value === undefined || value === "") continue;
      if (typeof value !== "string" || value.length > 1024 || (t[key] !== undefined && t[key] !== value)) throw invalidStream("tool_identity_conflict", this.site());
      t[key] = value;
    }
  }
  private append(key: string, delta: unknown): void {
    if (delta === undefined) return;
    if (typeof delta !== "string") throw invalidStream("tool_arguments_invalid", this.site());
    if (!delta) return;
    const t = this.tool(key);
    this.argumentBytes += bytes(delta);
    if (this.argumentBytes > CANONICAL_OUTPUT_MAX_BYTES) this.limit("output_bytes", CANONICAL_OUTPUT_MAX_BYTES, this.argumentBytes);
    t.fragments.append(delta);
  }
  private validate(t: Tool, final?: unknown): void {
    if (final !== undefined && typeof final !== "string") throw invalidStream("tool_arguments_invalid", this.site());
    const raw = t.fragments.text(), supplied = final as string | undefined ?? t.final;
    const full = supplied ?? raw;
    if (bytes(full) > CANONICAL_OUTPUT_MAX_BYTES) this.limit("output_bytes", CANONICAL_OUTPUT_MAX_BYTES, bytes(full));
    let parsed: unknown;
    try { parsed = JSON.parse(full); } catch { throw invalidStream("tool_arguments_invalid", this.site()); }
    if (t.final !== undefined && supplied !== undefined && canonicalJson(JSON.parse(t.final)) !== canonicalJson(parsed)) throw invalidStream("tool_arguments_mismatch", this.site());
    if (raw && supplied !== undefined) {
      let accumulated: unknown;
      try { accumulated = JSON.parse(raw); } catch { throw invalidStream("tool_arguments_invalid", this.site()); }
      if (canonicalJson(accumulated) !== canonicalJson(parsed)) throw invalidStream("tool_arguments_mismatch", this.site());
    }
    if (supplied !== undefined) {
      // Account whole-input-only Responses records too, rather than allowing
      // MAX_TOOLS independent copies of the full per-stream argument budget.
      if (t.final === undefined) this.argumentBytes += bytes(supplied);
      if (this.argumentBytes > 2 * CANONICAL_OUTPUT_MAX_BYTES) this.limit("retained_bytes", 2 * CANONICAL_OUTPUT_MAX_BYTES, this.argumentBytes);
      t.final = supplied;
    }
  }
  private finish(reason: unknown): void {
    this.evidence.providerFinish(reason);
    if (reason === "insufficient_system_resource" || reason === "aborted") throw interruptedProviderFinish(reason);
    if (reason === "stop" || reason === "tool_calls" || reason === "function_call" || reason === "completed") {
      for (const t of this.tools.values()) this.validate(t);
      this.evidence.toolValidation("validated");
    }
  }
  private frame(text: string): void {
    if (this.done) throw invalidStream("event_after_finish", this.site());
    if (text === "[DONE]") { this.done = true; this.evidence.providerDone(); this.evidence.note("provider", "done"); return; }
    let v: Record<string, unknown> | undefined;
    try { v = record(JSON.parse(text)); } catch { throw invalidStream("invalid_event_shape", this.site()); }
    if (!v) throw invalidStream("invalid_event_shape", this.site());
    this.evidence.increment("providerEvents"); this.evidence.first("providerFirstEventMs"); this.evidence.provider("stream");
    this.evidence.note("provider", this.api === "chat" ? "data" : v.type, bytes(text));
    if (this.api === "chat") {
      // The installed SDK consumes choices[0]. Audit exactly that choice rather
      // than fabricating authority over unused choices.
      const c = Array.isArray(v.choices) ? record(v.choices[0]) : undefined, d = record(c?.delta);
      if (Array.isArray(d?.tool_calls)) for (const item of d.tool_calls) {
        const call = record(item), fn = record(call?.function);
        if (!call || typeof call.index !== "number" || !Number.isSafeInteger(call.index) || call.index < 0) throw invalidStream("invalid_event_shape", this.site());
        const key = String(call.index), t = this.tool(key);
        this.identity(t, call.id, fn?.name); this.append(key, fn?.arguments);
      }
      if (c?.finish_reason !== undefined && c.finish_reason !== null) this.finish(c.finish_reason);
      return;
    }
    const itemId = typeof v.item_id === "string" ? v.item_id : undefined;
    if (v.type === "response.function_call_arguments.delta" && itemId) this.append(itemId, v.delta);
    if (v.type === "response.function_call_arguments.done" && itemId) this.validate(this.tool(itemId), v.arguments);
    const item = record(v.item);
    if ((v.type === "response.output_item.added" || v.type === "response.output_item.done") && item?.type === "function_call" && typeof item.id === "string") {
      const t = this.tool(item.id); this.identity(t, item.call_id, item.name);
      if (v.type === "response.output_item.done") this.validate(t, item.arguments);
    }
    if (v.type === "response.completed") this.finish("completed");
    if (v.type === "response.failed" || v.type === "response.incomplete") this.evidence.providerFinish(v.type === "response.failed" ? "failed" : "incomplete");
  }
  private line(line: string): void {
    if (!line) {
      if (this.dataLines) { const data = this.data.text(); this.data.clear(); this.dataLines = 0; this.eventBytes = 0; this.frame(data); }
      return;
    }
    if (line.startsWith("data:")) {
      const data = line.slice(line[5] === " " ? 6 : 5); this.eventBytes += bytes(data) + 1;
      if (this.eventBytes > PROVIDER_EVENT_MAX_BYTES) this.limit("event_bytes", PROVIDER_EVENT_MAX_BYTES, this.eventBytes);
      if (this.dataLines++) this.data.append("\n");
      this.data.append(data);
    }
  }
  private segment(text: string): void {
    if (!text) return;
    this.lineBytes += bytes(text);
    if (this.lineBytes > PROVIDER_EVENT_MAX_BYTES) this.limit("event_bytes", PROVIDER_EVENT_MAX_BYTES, this.lineBytes);
    this.lineParts.append(text);
  }
  private consume(text: string): void {
    // Scan each new code unit once. Re-scanning/re-encoding the accumulated line
    // on every one-byte fragment would make a bounded line quadratic work.
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (this.skipLF) { this.skipLF = false; if (ch === 10) { start = i + 1; continue; } }
      if (ch !== 10 && ch !== 13) continue;
      this.segment(text.slice(start, i));
      const line = this.lineParts.text(); this.lineParts.clear(); this.lineBytes = 0;
      this.line(line); this.skipLF = ch === 13; start = i + 1;
    }
    this.segment(text.slice(start));
    // SSE dispatch still requires a blank line; EOF does not synthesize one.
  }
  push(chunk: Uint8Array): void {
    try {
      this.wireBytes += chunk.byteLength; this.evidence.increment("providerBytes", chunk.byteLength);
      if (this.wireBytes > PROVIDER_WIRE_MAX_BYTES) this.limit("wire_bytes", PROVIDER_WIRE_MAX_BYTES, this.wireBytes);
      let text: string;
      try { text = this.decoder.decode(chunk, { stream: true }); } catch { throw invalidStream("invalid_event_shape", this.site()); }
      this.consume(text);
    } catch (error) { this.rejected(error); throw error; }
  }
  eof(): void {
    try {
      let text: string;
      try { text = this.decoder.decode(); } catch { throw invalidStream("invalid_event_shape", this.site()); }
      this.consume(text); this.ended = true; this.evidence.provider("eof"); this.evidence.note("provider", "eof");
    } catch (error) { this.rejected(error); throw error; }
  }
  bodyError(): void { this.failed = true; this.evidence.provider("body_error"); this.evidence.note("provider", "body_error"); }
  cancelled(): void { if (!this.ended && !this.failed && !this.done) this.evidence.provider("cancelled"); }
  private rejected(error: unknown): void {
    this.failed = true;
    if (error instanceof BackendFailure && this.violation === undefined) this.violation = error;
    this.evidence.toolValidation("rejected");
    if (error && typeof error === "object") annotateStreamFailure(error, { stream: this.evidence.snapshot() });
  }
  dispose(): void { this.tools.clear(); this.lineParts.clear(); this.lineBytes = 0; this.data.clear(); this.dataLines = 0; }
}
/** Demand-driven, no tee/background drain; cancellation belongs to this response. */
export function auditedProviderResponse(response: Response, audit: ProviderStreamAudit): Response {
  audit.headers(response.status);
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
  audit.instrumented();
  const reader = response.body.getReader(); let closed = false;
  const release = () => { audit.dispose(); try { reader.releaseLock(); } catch { /* pending read retains ownership until it settles */ } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try { next = await reader.read(); } catch (error) { if (!closed) { closed = true; audit.bodyError(); release(); controller.error(error); } return; }
      if (closed) { release(); return; }
      try {
        if (next.done) { audit.eof(); closed = true; release(); controller.close(); return; }
        audit.push(next.value); controller.enqueue(next.value);
      } catch (error) { closed = true; void reader.cancel().catch(() => undefined).finally(release); controller.error(error); }
    },
    async cancel() { if (closed) return; closed = true; audit.cancelled(); try { await reader.cancel(); } finally { release(); } },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
