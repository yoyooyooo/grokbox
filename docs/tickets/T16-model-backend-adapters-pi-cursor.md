# T16 — Model backend adapters: AI SDK + pi + Cursor SDK (todo)

## Status
**open / queued** — fold into full改造路线 after T15 WebUI Astra + incr/Host-kernel synthesis. Analysis-first; no implementation in this ticket yet.

## Goal
Today managed path is centered on AI SDK OpenAI-compatible external LLM APIs. Expand to multiple backends behind a stable admit/submit contract:
- **AI SDK** (current OpenAI chat/responses / sub2api)
- **pi** via JSON-RPC (app-server-style; exact protocol TBD — do not invent Codex app-server details)
- **Cursor SDK**

Prefer **adapter pattern** wired with **Effect DI** (natural given Effect-owned modeld lifecycle).

## Product bar
- Host still owns Agent loop / tools / SendToUser / Memory / transcript.
- modeld (or successor sidecar) owns **one inference admission** per STEP; backends are swappable adapters.
- Config/WebUI (T15) should select backend+model through the same SoT contracts, not per-UI forks.
- Keep Host/preload Effect-free / SDK-free; adapters live inside the sidecar kernel.

## Open questions
1. Shared request/stream/error contract across adapters (map to existing As1 / chunk frames).
2. How pi JSON-RPC session identity relates to Host TURN/STEP.
3. Cursor SDK auth/surface vs box-local constraints.
4. Catalog fields in `models.json` for `provider` / adapter kind without breaking T10 assignments.

## Non-goals
- Replacing Host with pi/Cursor agent loops
- Implementing adapters before roadmap lock
- Treating every provider error as overflow (T14b)

## Related
- Incr+Host-kernel: `/tmp/grokbox-astra-incr-host-kernel-20260908T090905Z.md`
- T15 WebUI / config SoT
- T4b AI SDK driver (current)
