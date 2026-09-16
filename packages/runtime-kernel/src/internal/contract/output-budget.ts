import type { InferenceEvent } from "./events.ts";
import { CANONICAL_OUTPUT_MAX_BYTES } from "./limits.ts";

const encoder = new TextEncoder();
/** A storage chunk is an allocation target, never an event-count quota. */
export const STREAM_STORAGE_CHARS = 4096;
export class ChunkedText {
  private readonly chunks: string[] = [];
  private length = 0;
  append(text: string): void {
    for (let offset = 0; offset < text.length;) {
      const last = this.chunks.length - 1;
      const room = last >= 0 ? STREAM_STORAGE_CHARS - this.chunks[last]!.length : 0;
      const size = Math.min(room || STREAM_STORAGE_CHARS, text.length - offset);
      const part = text.slice(offset, offset + size);
      if (room) this.chunks[last] += part; else this.chunks.push(part);
      offset += size; this.length += size;
    }
  }
  get chars(): number { return this.length; }
  get blocks(): number { return this.chunks.length; }
  text(): string { return this.chunks.join(""); }
  clear(): void { this.chunks.length = 0; this.length = 0; }
}
/** Count UTF-8 for the concatenated channel, including a surrogate pair split
 * across two provider deltas. Wire JSON and repeated identifiers are not output. */
class Utf8Channel {
  bytes = 0;
  private high = false;
  append(text: string): number {
    if (!text.length) return 0;
    const before = this.bytes;
    if (this.high && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) this.bytes -= 2;
    this.bytes += encoder.encode(text).length;
    const last = text.charCodeAt(text.length - 1);
    this.high = last >= 0xd800 && last <= 0xdbff;
    return this.bytes - before;
  }
}
/** One semantic budget across SDK and IPC/Host shapes. Parameters streamed and
 * repeated as a completed object consume max(streamed, complete), not both.
 * Counters describe this layer's observation; they are not a heap measurement. */
export class StreamOutputBudget {
  used = 0;
  readonly limit: number;
  private readonly text = new Utf8Channel();
  private readonly reasoning = new Utf8Channel();
  private readonly tools = new Map<string, { channel: Utf8Channel; charged: number }>();
  constructor(limit = CANONICAL_OUTPUT_MAX_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error("invalid_output_budget");
    this.limit = limit;
  }
  add(event: InferenceEvent): boolean {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      this.used += (event.type === "text_delta" ? this.text : this.reasoning).append(event.text);
    } else if (event.type === "tool_start" || event.type === "tool_delta" || event.type === "tool_complete") {
      let tool = this.tools.get(event.toolCallId);
      if (!tool) {
        tool = { channel: new Utf8Channel(), charged: 0 }; this.tools.set(event.toolCallId, tool);
        // A real call has identity and structure overhead, independent of the
        // number of transport fragments. Empty-call floods are not free.
        this.used += encoder.encode(event.toolCallId).length + encoder.encode(event.toolName).length + 64;
      }
      let size = tool.charged;
      if (event.type === "tool_delta") { tool.channel.append(event.argsTextDelta); size = Math.max(size, tool.channel.bytes); }
      if (event.type === "tool_complete") size = Math.max(size, encoder.encode(JSON.stringify(event.args)).length);
      this.used += size - tool.charged; tool.charged = size;
    }
    return this.used <= this.limit;
  }
}
