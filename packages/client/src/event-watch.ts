import { API_VERSION, API_ERROR_CODES, ManagementClientError, RESPONSE_MAX_BYTES, UUID, type ApiReply, type ObservationWatchFrame } from "./contract.ts";
import { observationEvents } from "./observation-validation.ts";
import { exact, record } from "./response-validation.ts";

export type ObservationWatchOptions = { cursor: string; limit?: number; durationMs?: number; signal?: AbortSignal };
export type ObservationWatchReply = ApiReply<ObservationWatchFrame> & { ok: true };
/** Pull-driven, byte-bounded NDJSON decoder shared by CLI, browser and Web proxy.
 * EOF is not completion: only a verified terminal frame closes a watch window.
 * Each page validates the original database/epoch and strictly increasing cursor. */
export async function* decodeObservationWatch(response: Response, input: { installationId: string; cursor: string; limit: number; signal: AbortSignal }): AsyncGenerator<ObservationWatchReply> {
  let cursor = input.cursor, invocationId: string | undefined, total = 0, frames = 0, terminated = false;
  const failure = (code: "protocol_error" | "unavailable", message: string) => new ManagementClientError(code, message, { cursor });
  if (!response.body) throw failure("protocol_error", "The event response has no body.");
  if (response.ok && !/^application\/x-ndjson(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
    await response.body.cancel(); throw failure("protocol_error", "The event response is not the declared NDJSON protocol.");
  }
  const reader = response.body.getReader(), line = new Uint8Array(RESPONSE_MAX_BYTES);
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  input.signal.addEventListener("abort", cancel, { once: true });
  function frame(bytes: Uint8Array): ObservationWatchReply {
    if (++frames > 130) throw failure("protocol_error", "The event window exceeds its frame bound.");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw failure("protocol_error", "The event frame is not strict UTF-8 JSON."); }
    if (!record(raw) || !exact(raw, ["schemaVersion", "installationId", "invocationId", "ok", raw.ok ? "data" : "error"])
      || raw.schemaVersion !== API_VERSION || raw.installationId !== input.installationId || typeof raw.invocationId !== "string" || !UUID.test(raw.invocationId)
      || typeof raw.ok !== "boolean" || (invocationId !== undefined && raw.invocationId !== invocationId)) throw failure("protocol_error", "The event frame identity or envelope is incompatible.");
    invocationId = raw.invocationId;
    if (!raw.ok) {
      if (!record(raw.error) || !API_ERROR_CODES.includes(raw.error.code as never) || typeof raw.error.message !== "string" || raw.error.message.length > 4096
        || Object.keys(raw.error).some(key => !["code", "message", "details"].includes(key))) throw failure("protocol_error", "The event error is incompatible.");
      const error = raw as ApiReply<never> & { ok: false };
      throw new ManagementClientError(error.error.code, error.error.message, { cursor }, error);
    }
    if (!response.ok || !record(raw.data)) throw failure("protocol_error", "The event HTTP status or frame is incompatible.");
    const data = raw.data;
    if (data.kind === "page" && exact(data, ["kind", "page"]) && observationEvents(data.page, input.installationId, input.limit, cursor)) cursor = data.page.cursor;
    else if (data.kind === "end" && exact(data, ["kind", "cursor", "reason"]) && data.cursor === cursor && ["duration", "capacity"].includes(String(data.reason))) terminated = true;
    else throw failure("protocol_error", "The event cursor, order or terminal frame is incompatible.");
    return raw as ObservationWatchReply;
  }
  try {
    while (true) {
      if (input.signal.aborted) throw failure("unavailable", "The event watch was interrupted; resume from the last verified cursor.");
      const chunk = await reader.read();
      if (input.signal.aborted) throw failure("unavailable", "The event watch was interrupted; resume from the last verified cursor.");
      if (chunk.done) {
        if (!response.ok && length) frame(line.subarray(0, length));
        throw failure("unavailable", "The event connection ended without a terminal frame; resume from the last verified cursor.");
      }
      total += chunk.value.byteLength;
      if (total > 5 * 1024 * 1024) throw failure("protocol_error", "The event window exceeds its byte bound.");
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const newline = chunk.value.indexOf(10, offset), end = newline < 0 ? chunk.value.byteLength : newline;
        if (length + end - offset > line.length) throw failure("protocol_error", "The event frame exceeds its byte bound.");
        line.set(chunk.value.subarray(offset, end), length); length += end - offset; offset = end + (newline < 0 ? 0 : 1);
        if (newline < 0) break;
        const parsed = frame(line.subarray(0, length)); length = 0;
        yield parsed;
        if (terminated) return;
      }
    }
  } catch (error) {
    if (error instanceof ManagementClientError) throw error;
    throw failure("unavailable", "The event transport failed; resume from the last verified cursor.");
  } finally { input.signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
