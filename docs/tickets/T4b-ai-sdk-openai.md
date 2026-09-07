# T4b — AI SDK OpenAI Chat Completions + Responses in modeld

## Goal
Wire real AI SDK inside modeld ModeldDriver (A+S1): map generate stream → StreamPart[] → existing submit IPC.

## Priority
1. Chat Completions (`openai.chat` / custom `baseURL` for sub2api)
2. Responses API (`openai.responses`)
3. Grok/xAI: prefer OpenAI-compatible baseURL first; optional `@ai-sdk/xai` later. No xAI server-side agentic tools as default (Host owns tool loop).

## Fence
- SDK only in modeld; Host/preload/seam/session SDK-free
- Default CLI admit remains stub/echo until explicit models admit
- No live Host patch/canary; no real spend in CI — use mocked generate / recorded fixtures
- Hard-off: network calls only when model admitted + credential present + not test hard-off

## Deliver
- Dependencies: `ai` + `@ai-sdk/openai` (catalog/lock as project requires)
- Driver implementing ModeldDriver via existing `modeld-as1` port or successor
- Envelope → AI SDK messages/tools mapping; SDK events → StreamPart
- Tests offline; docs/tickets update; clean commit(s)

## Status
**done.** `ai@5.0.253` + `@ai-sdk/openai@2.0.125` (Node 20 catalog `ai-sdk`) on `@grokbox/box-runtime` only. `createOpenAiModeldDriver` selects Chat Completions vs Responses from `provider`, uses `endpoint` as `baseURL`, maps envelope → SDK messages/tools (no `execute`), maps fullStream events → As1 → `complete()` `StreamPart[]`. Default CLI admit remains stub/echo. Tests mock fetch / inject stream events. Host/preload/seam/session stay SDK-free.
