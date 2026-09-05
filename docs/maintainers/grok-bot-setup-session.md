# External reference: `grok-bot-setup` PromptSession contract

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

> **Role: external implementation reference.** This file records bounded, source-backed interoperability lessons from another public project. It is **not** grokbox product or architecture authority, does not prove current Host behavior, and does not authorize a live Host change or provider call. Current behavior remains owned by source and executable tests; accepted grokbox behavior remains owned by [`product-contract.md`](../product-contract.md), [`architecture.md`](../architecture.md), and [`box-runtime.md`](../box-runtime.md).

## Source and freshness

- Repository: [`BlockedPath/grok-bot-setup`](https://github.com/BlockedPath/grok-bot-setup)
- Upstream revision mined: `d9119f9632c635473213c57ace336028f7278abd` (`d9119f9`)
- Upstream commit date: 2026-08-17
- Clone and inspection date: 2026-09-05
- Files inspected at that revision:
  - `docs/GUIDE_CUSTOM_INFERENCE.md`
  - `docs/GROK_BOT_CLAUDE_FIXES.md`
  - `xai-prompt-session.cjs`
  - `scripts/ensure-xai-inference.sh`

This reference is invalidated when the observed Host `createSession`/`getExecutor` shape changes, when `xai-prompt-session.cjs` or its contract guide changes in that repository, or when grokbox's Host contract slices contradict it. Re-mine and re-run our disposable Host-contract tests rather than treating this revision as a stable upstream API.

Code excerpts below are copied from the pinned MIT-licensed revision without shortening; attribution and license terms are at the end of this file.

## 1. Mental model

The replacement is narrower than a second agent runtime:

```text
Grok Bot UI
  -> Host queue / turn loop
      -> createCursorSandInference.createSession(...)
          -> replacement PromptSession model stream
              -> provider adapter
      -> Host-owned tool execution / permissions / SendToUser / Transcript / Memory
```

Only the **model stream** is replaced. The Host continues to own the UI, queue, turn loop, tools, permissions, final delivery, Transcript, and Memory. A provider adapter therefore returns Host-shaped messages and stream parts; it must not execute tools, write product state, or create a second turn loop.

Changing a model-id setting alone does not change transport. The source project inserted its replacement after `resolveSandRequestedModel(...)` and before `createCursorInferencePromptSession(...)` inside `createCursorSandInference.createSession(...)`.

## 2. Contract asserted by the pinned source

These shapes are copied verbatim from `GUIDE_CUSTOM_INFERENCE.md`. They are evidence for the pinned Host generation, not a promise that every Host generation has the same contract.

### Session shape

```js
{
  getExecutor(initialMessages) { /* -> executor */ },
  getModelId() { return "grok-4.5"; }
}
```

### Executor and synchronous stream-result shape

```js
{
  appendMessages(messages) { /* array or single msg */; return this; },
  getMessages() { return [...this.messages]; },  // MUST be Array
  getState()    { return [...this.messages]; },  // MUST be Array
  clearMessages() {},
  stream(ctx, invocationId, tools, options) {
    return {
      fullStream,           // async iterable
      response,             // Promise
      usage,                // Promise
      extendedUsage,        // Promise
      providerMetadata,     // Promise
      invocationId,         // Promise
    };
  }
}
```

`stream(...)` itself is synchronous: it must immediately return the object above. Asynchronous work lives behind `fullStream` and the five promises. Returning a promise for the whole object is a contract violation.

The source guide declares four `stream` arguments. Its concrete JavaScript implementation accepts three (`ctx`, `invocationId`, `tools`); JavaScript ignores a fourth argument, but that implementation consequently does not consume `options`. grokbox must retain the four-argument Host-facing shape and preserve abort handling from the current `ctx`/`options` contract.

The pinned external session does **not** expose `getExecutorWithoutResolvedModelTracking`. Our current Host contract does, so grokbox must continue to provide both executor accessors rather than copying the external session object blindly:

```text
getModelId()
getExecutor(state)
getExecutorWithoutResolvedModelTracking(state)
```

### Stream parts

The pinned adapter emits these Host-facing part names and payloads:

| `type` | Required payload |
| --- | --- |
| `text-delta` | `{ textDelta }` |
| `reasoning` | `{ textDelta }` |
| `tool-call-streaming-start` | `{ toolCallId, toolName }` |
| `tool-call-delta` | `{ toolCallId, toolName, argsTextDelta }` |
| `tool-call` | `{ toolCallId, toolName, args }` |
| `finish` | `{ finishReason, usage, response }` |
| `error` | `{ error }` |

The source's `finish.finishReason` and tool-call content blocks are not identical to grokbox's current stub-internal `finish.reason` and `SessionMessage.toolCalls`. Internal normalization may differ, but the final Host adapter must translate to the exact revalidated Host shape.

### Resolved values

At the pinned revision:

- `response` resolves to an object containing a non-empty string `modelId`, a `messages` array, and `finishReason`.
- `usage` resolves to `{ promptTokens, completionTokens, totalTokens }`.
- `extendedUsage` resolves to `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, maxTokens }`.
- `providerMetadata` resolves to an object.
- `invocationId` resolves to the supplied invocation id.

`response.messages` is part of the functional tool loop, not optional metadata. Tool-call messages must use the same `toolCallId` values as streamed tool-call parts and later tool results.

## 3. Pitfalls not to repeat

The source's twelve-item repair log and three guide-level bugs reduce to the following failure checklist. Items marked **CURRENT MISS / ADOPT NOW** directly intersect the ticket-14 stub-route failure or the contract surface exposed by it.

1. **CURRENT MISS / ADOPT NOW — returning a bare `{ stream() }` value instead of a Host session.** The Host calls `session.getModelId()` and `session.getExecutor(...).stream(...)`; a bare stream wrapper fails before managed output can be consumed. In grokbox this was corrected by `pre-publication-revision` with a Host-shaped route adapter; identity must still return `originalSession` by reference.
2. **Generator/promise mismatch.** `yield` inside a non-generator `async function` caused a syntax error at require time, and the source hook then fell back to the stock path.
3. **Dead helper references.** Calls to removed model/message helpers failed at runtime before a turn could be built. Thread model and messages explicitly from session/executor state.
4. **CURRENT MISS / ADOPT NOW — asynchronous `stream()` return.** Returning or chaining a promise for the stream-result object leaves the Host without `fullStream`. Construct the processing promise internally, but synchronously return the handle.
5. **CURRENT MISS / ADOPT NOW — `teeStream` consumers sharing one queue.** Completion waiters consumed parts from the same queue as the UI iterator, so text/tool deltas disappeared. Completion observers must never dequeue delivery parts; use independent completion state or a real broadcast/fan-out primitive.
6. **CURRENT MISS / ADOPT NOW — OpenAI usage keys leaked through.** `{ prompt_tokens, completion_tokens, total_tokens }` did not satisfy Host sanitization. Normalize every exposed usage object to camel-case Host keys.
7. **CURRENT MISS / ADOPT NOW — missing `response.modelId`.** The Host performs `response.modelId.trim()` without a guard; omission turns an otherwise completed stream into a `TypeError`. Success and error responses both need a trim-able string.
8. **CURRENT MISS / ADOPT NOW — missing `response.messages`.** The Host performs `response.messages.some(...)`; omission caused `cannot read properties of undefined (reading 'some')` and prevented tool-call/result correlation. Success and error responses both need an array.
9. **Invalid tool-call ids.** A provider rejected ids outside `^[a-zA-Z0-9_-]+$`. Deterministic sanitization must preserve equality among streamed tool calls, response messages, and returned tool results.
10. **Wrong message representation.** The Host supplied content blocks (`text`, `tool-call`, `tool-result`), while the unfinished converter expected OpenAI fields. Text and tools were dropped or malformed until the converter accepted the Host blocks.
11. **Redacted wrappers treated as plain values.** Plain string checks silently discarded wrapped text, arguments, and results. Any unwrapping must occur only at the authorized model boundary and must not become a general logging or persistence escape hatch.
12. **Assistant-last history.** A provider rejected assistant prefill. The source appends a synthetic user continuation after conversion; a future driver must make this behavior provider-specific rather than silently changing the Host transcript.
13. **Insufficient structural diagnostics.** Silent conversion drops were hard to locate. The source added a structure-only dump. grokbox may adopt bounded shape diagnostics, but never raw prompts, results, credentials, provider bodies, Transcript, or Memory content.
14. **`getState()`/`getMessages()` returned an object.** Host code expected arrays and failed with `plainMessages.map is not a function`. Both methods must return array copies.
15. **Wrapped or non-object tool schemas.** Sending an AI-SDK wrapper instead of its plain JSON Schema caused HTTP 400: `tool parameter root must be an object type`. Unwrap `jsonSchema`/`inputSchema` and ensure an object root before provider effect.
16. **Host-internal model ids sent upstream.** Summary/default sessions produced ids such as `sand-default`; providers rejected or misrouted them. Model resolution belongs at the driver boundary and must result in a configured provider model, never an accidental fallback.

A restart is an observation from the external implementation because Node caches its required session module and reads environment at process start. It is **not** authority to restart our Host: grokbox live mutation remains governed exclusively by its own local-only coordinator and separate authorization gates.

## 4. Minimal reusable source snippets

These are the bounded implementation fragments worth carrying into a future driver review. They are reproduced exactly from `xai-prompt-session.cjs` at `d9119f9`; names such as `XAI_*` remain source-local and are not grokbox configuration decisions.

### 4.1 Synchronous executor construction

```js
function createExecutor(session) {
  const state = { messages: [] };
  return {
    appendMessages(messages) {
      const list = Array.isArray(messages) ? messages : messages == null ? [] : [messages];
      state.messages.push(...list);
      return this;
    },
    getMessages() {
      return [...state.messages];
    },
    getState() {
      return [...state.messages];
    },
    clearMessages() {
      state.messages = [];
    },
    stream(ctx, invocationId, tools) {
      if (typeof session.onRequestId === "function") {
        try {
          session.onRequestId(invocationId);
        } catch {
          /* ignore */
        }
      }
      const processing = (async () => {
        loadEnvFile();
        const auth = resolveAuth();
        const model = mapModelId(session.requestedModel);
        if (auth.mode === "none") {
          return errorResult(
            model,
            invocationId,
            new Error("no XAI_API_KEY and no ~/.grok/auth.json session — run adapters use … or grok login")
          );
        }
        return runStream({
          model,
          messages: state.messages,
          tools,
          invocationId,
          auth,
        });
      })();

      const fullStream = (async function* () {
        const result = await processing;
        for (const part of result.parts) yield part;
      })();

      return {
        fullStream,
        response: processing.then((r) => r.response),
        usage: processing.then((r) => r.usage),
        extendedUsage: processing.then((r) => r.extendedUsage),
        providerMetadata: processing.then((r) => r.providerMetadata),
        invocationId: processing.then((r) => r.invocationId ?? invocationId),
      };
    },
  };
}
```

This is a contract pattern, not necessarily the desired buffering strategy: this source accumulates `parts` before `fullStream` yields them. A future grokbox driver may stream live, but it must still return the handle synchronously and fan out without one observer swallowing another's parts.

### 4.2 Error result

```js
function errorResult(modelId, invocationId, err) {
  const message = err && err.message ? err.message : String(err);
  const usage = normalizeUsage({});
  const response = {
    modelId,
    messages: [{ role: "assistant", content: "" }],
    finishReason: "error",
  };
  const parts = [
    { type: "error", error: err instanceof Error ? err : new Error(message) },
    { type: "finish", finishReason: "error", usage, response },
  ];
  return {
    parts,
    response,
    usage,
    extendedUsage: normalizeExtendedUsage({}),
    providerMetadata: {},
    invocationId,
  };
}
```

The reusable point is structural completeness on failure. grokbox must still apply its own visible-error, redaction, terminal, and no-provider-fallback rules.

### 4.3 Usage normalization

```js
function normalizeUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const promptTokens = Number(u.promptTokens ?? u.prompt_tokens ?? u.inputTokens ?? u.input_tokens ?? 0) || 0;
  const completionTokens =
    Number(u.completionTokens ?? u.completion_tokens ?? u.outputTokens ?? u.output_tokens ?? 0) || 0;
  const totalTokens = Number(u.totalTokens ?? u.total_tokens ?? 0) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}
```

### 4.4 `response.messages` for text and tool calls

```js
function buildResponseMessages(text, toolCalls) {
  if (toolCalls.length) {
    const content = [];
    if (text) content.push({ type: "text", text });
    for (const tc of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
      });
    }
    return [{ role: "assistant", content }];
  }
  return [{ role: "assistant", content: text || "" }];
}
```

The exact success finalization statements are:

```js
const usage = normalizeUsage(usageRaw);
const response = {
  modelId: model,
  messages: buildResponseMessages(text, toolCalls),
  finishReason: finishReason === "tool_calls" ? "tool-calls" : finishReason || "stop",
};
push({ type: "finish", finishReason: response.finishReason, usage, response });
```

## 5. Message and tool conversion lessons

The pinned implementation converts at one explicit boundary:

| Host/Sand input | OpenAI-compatible projection |
| --- | --- |
| `system`/`user` text or text parts | same role plus `content` |
| assistant `tool-call` content parts | assistant `tool_calls[]`, preserving id/name/args |
| `tool-result` content parts | `role: "tool"`, matching `tool_call_id`, string content |
| reasoning parts | omitted on resend unless a provider explicitly supports the mapping |
| image parts | `image_url` parts only for a vision-capable route |

Tool conversion must:

1. unwrap `parameters.jsonSchema`, `inputSchema`, or `schema`;
2. produce a plain root `{ type: "object", properties: ... }`;
3. sanitize tool names and ids deterministically where a provider requires it;
4. preserve one id across streaming-start, deltas, terminal tool call, `response.messages`, and the Host's later tool result;
5. parse accumulated argument text once into an object, retaining a bounded visible failure for invalid input rather than inventing a different call;
6. keep provider conversion out of the Host hook and product-state writers.

The external implementation's redaction unwrap purpose and provider-specific continuation message are observations, not permissions or universal semantics. Revalidate them against grokbox's trust boundary before any real driver is admitted.

## 6. Hook and recovery evidence—not an implementation recipe

`ensure-xai-inference.sh` demonstrates four useful facts:

1. a Host bundle replacement can remove both the hook and adjacent session module;
2. an injection anchor must be exact and unique, otherwise injection must stop;
3. syntax/module loading and hook presence need separate checks;
4. a required module is cached for the lifetime of that Host process.

The script itself copies files beside the Host, writes `host-main.cjs` in place, keeps an on-disk backup, and injects a `try/catch` fallback. Those mechanics conflict with grokbox's accepted architecture and are not to be run or ported.

### Do not copy

- **Do not write `/home/box/sand-host/host-main.cjs` in place.** grokbox uses exact-SHA, in-memory transformation and leaves the official bundle unchanged.
- **Do not copy the `SAND_INFERENCE_PROVIDER` gate's silent fallback to Cursor.** The external hook catches construction failure and continues into `createCursorInferencePromptSession`; grokbox route failures are visible and fail closed once managed execution is selected.
- **Do not `require()` a replacement module from the official `sand-host` directory.** Runtime implementation and durable configuration stay in grokbox-owned roots.
- **Do not copy manual supervisor/Host killing, donor-environment cloning, or any `SIGKILL` supervisor recovery.** grokbox permits only its local coordinator, exact identity checks, bounded `SIGTERM` where authorized, and guardian `SIGCONT` for an exact frozen wrapper; no live action is authorized by this reference.
- **Do not copy provider credentials, auth files, proxy configuration, debug bodies, or full environments.** Provider secrets belong to modeld-only resolution through grokbox `SecretRef` boundaries.
- **Do not use the App, Gateway turns, trial/official-model spend, or real-provider traffic to validate this document.** Offline contract fixtures are sufficient for this mining task; later live evidence requires separate authorization.

## 7. Intersection with grokbox box-runtime

### Adopt now for ticket 14's stub route

Ticket 14 remains stub-only and provider-hard-off. Commit `pre-publication-revision` is the current correction for the first observed mismatch: route now returns a Host-shaped session, `response.modelId` is trim-able, and the existing agent-id transform slice also carries `invocationId: inferenceRequestId`. That commit does **not** by itself claim ticket 14 or the whole external contract is complete.

Keep or add offline proof for these immediate invariants:

- identity returns the exact `originalSession`; route returns a distinct Host-shaped session only for ordinary main;
- both `getExecutor` methods exist for our current Host shape;
- `executor.stream(ctx, invocationId, tools, options)` returns synchronously;
- `fullStream` is an async iterable and no completion observer consumes its parts;
- success and error `response` values contain a trim-able `modelId` and a `messages` array;
- exposed usage uses Host camel-case keys;
- repeated `stream()` does not redispatch, and no stub path resolves credentials or opens provider network access.

The pinned source also exposes `providerMetadata` and `invocationId` promises, `usage.totalTokens`, `extendedUsage.maxTokens`, `finish.finishReason`, and content-block tool calls in `response.messages`. Current grokbox stub types are narrower. Treat these as explicit compatibility deltas to revalidate against the current Host slices—not fields to silently discard and not proof that ticket 14 needs provider code.

### Defer to ticket 07 / real-provider work

Do not start ticket 07 from this reference. Defer all of the following:

- real provider driver, credentials, DNS/TCP/HTTP, SSE parsing, auth refresh, model catalog, or proxy selection;
- provider-specific message/history normalization and assistant-last behavior;
- real tool-call delta accumulation and the exact Host content-block projection;
- vision, parallel-tool, two-bot/per-agent, burned-wait, retry, and next-turn behavior;
- M3/I1, App-visible, billing, or live ordinary-main claims.

Before ticket 07 begins, revalidate the live-generation contract offline and decide each compatibility delta explicitly. In particular, do not let the stub's simplified `SessionMessage.toolCalls` or `finish.reason` become the real Host boundary by accident.

## License for copied excerpts

The excerpt source is licensed as follows:

```text
MIT License

Copyright (c) 2026 BlockedPath

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
