import { expect, test } from "bun:test";
import { createStreamingPromptSession, type StreamPart } from "../src/internal/host/session.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
const envelope = buildHostEnvelope([{ role: "user", content: "test" }], [{ name: "lookup", inputSchema: { type: "object" } }]);
const toolParts: StreamPart[] = [
  { type: "tool-call-streaming-start", toolCallId: "one", toolName: "lookup" },
  { type: "tool-call-delta", toolCallId: "one", toolName: "lookup", argsTextDelta: '{"q":"one"}' },
  { type: "tool-call", toolCallId: "one", toolName: "lookup", args: { q: "one" } },
];
for (const outcome of ["success", "extra-tool", "error"] as const) {
  test(`serial ${outcome}: native wire sequence is withheld until validated, not dropped`, async () => {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { ready = resolve; });
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo", vision: false, parallel: "fail-closed",
      produce: async function* () {
        for (const part of toolParts) yield part;
        ready(); await gate;
        if (outcome === "extra-tool") yield { type: "tool-call", toolCallId: "two", toolName: "lookup", args: {} };
        if (outcome === "error") throw Error("owned failure");
        yield { type: "finish", reason: "stop", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
      },
    });
    const handle = prompt.stream({ envelope });
    const seen: StreamPart[] = [];
    const consumed = (async () => { for await (const part of handle.fullStream) seen.push(part); })();
    await reached;
    try { expect(seen).toEqual([]); } finally { release(); }
    await consumed;
    const tools = seen.filter((part) => part.type.startsWith("tool-call"));
    if (outcome === "success") {
      expect(tools).toEqual(toolParts);
      expect((await handle.response).finishReason).toBe("tool-calls");
    } else {
      expect(tools).toEqual([]);
      await expect(handle.response).rejects.toBeInstanceOf(Error);
    }
  });
}
