# box-runtime next — 2026-09-08

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

Converged spine for grokbox 改造. Host stays the Agent; grokbox owns one bounded inference admit per STEP. Astra may thicken the core-chain; this file is the shippable order, not a platform catalog.

Locks (do not fight): Host loop / tools / SendToUser / Memory / transcript / compact; managed context = Host `getExecutor` passthrough (CCS-safe); no `store.db` prepend; `GROKBOX_LIVE_PROMPT_*_CAP` unset in live; T14b only on confirmed overflow; WebUI SoT = runtime contracts; SQLite cache-only; backends via sidecar adapters (T16); Host/preload Effect-free / SDK-free.

---

## 1. Current state

**Works (keep):** per-bot official passthrough (T10/T11); CCS luna canary on grokbox test0; official renewer across re-adopt (T12); CCS-safe live prompt (text + SendToUser bubbles + tool stdout fold); Unix chunk frames exist; Effect listen/sweep/stop shell; overflow **observation** (`provider_error_observed`); no silent envelope oldest-drop; no default live near-window.

**Landed in `pre-publication-revision` (Astra A1–A4):** no `/tmp` live-prompt census; overflow log enums only (no `bodySnippet`; unknown code/type → `unknown`); tool continuation kept without “pop until user”; missing/invalid STEP → `host_stream_rejected` (no `lastHandle` replay). Host IPC still `model_error`.

**Not done:** binding revision before first provider effect (A5); raw `/tmp/sand-host-adopt.err` (A6); encoder 1500/8000 + keyword noise (A7); Host still waits full terminal despite T5b frames (A8); Effect acquire without cancel/finalizer (A9); overflow classifier not a compact control signal (A10 / T14b); T13 status honesty; T15 WebUI; T16 extra backends.

test1 stays unassigned. Dirty `packages/cli/src/commands/runtime.ts` and untracked root `src/` stay unstaged.

---

## 2. Phased work

### Phase 0 — leftover incr P1/P2 (no new Host hook)

A1–A4 are **done**. Remaining, small, ordered:

| leftover | pri | do | do not |
|---|---|---|---|
| **A6** raw Host stdout/stderr → `/tmp/sand-host-adopt.err` | P2 | default ignore or bounded opt-in diagnostic; keep T12 renewer allowlist | treat capture as product |
| **A7** fold 1500/8000 + `SAND_HIDDEN`/`ack-redrive` whole-row drop | P2 | Host-selected content stays; overflow → visible fail; control rows by structure not keywords | near-window; fight Host compact |
| **A8** Host waits full `parts[]` | P2 | later: bounded Host stream consumer; terminal = end-state only | claim T5b “done” as TTFT |
| **A9** Effect `bindUnixKernel` acquire vs interrupt | P2 | correct acquire/release before any real Effect root | wrap whole bind as uninterruptible forever |
| **A10** classifier gaps | — | keep log-only; harden parse **with** T14b samples | compact on `model_error` |

**Exit:** no default prompt/error/Host-raw dumps; tool continuation already proven offline; no compact.

### Phase 1 — Host compatibility leaf + grokbox admission/lifecycle kernel

Sink into modeld/box-runtime (one sidecar, not a second Agent):

- **Route/admission:** per-agent opt-in, expected config revision, turn binding, credential fingerprint — **before** first provider effect. Fixes A5 (createSession vs first STEP race; TTL/restart must refuse or keep proven binding, not silent re-pin; Host opt-in vs service `main` fallback).
- **Context admission:** validate Host-selected snapshot (structure, tool causality, size/budget). Decide “can send / how to encode”, **never** which history to keep.
- **Provider codec:** versioned CCS-safe mapper (today’s AI SDK path). Not a generic provider platform.
- **STEP lifetime:** one request scope, one ledger, cancel/unknown/capacity. Host only sync ABI + last-mile projection.
- **Compatibility tuple:** Host source/profile, bridge digest, ABI, wire features. Unknown combo → official passthrough or refuse. Two-slice preload stays the Host adapter, not the kernel.

Stay Host forever: Agent loop, tool execute, SendToUser, Transcript/Memory writers, compact materialization, identity/root assembly, official renewer protocol, Gateway publish.

**Exit:** two Host-shaped adapters, same kernel; model-switch race has zero wrong egress; same `modelId` + changed endpoint blocked by revision; root/system snapshot exactly once if present; uncovered bots exact `originalSession`; preload still Effect/SDK-free.

No extra monkey-patches. If a needed fact is not on the current two seams, stop for owner — do not add a third knife.

### Phase 2 — WebUI MVP (T15)

Ops console on **shared CLI/use-cases**. Not a second kernel.

- Shared config mutate: lock + expected revision + same parser as CLI (T10: missing assignment = official, not inherit `main`).
- Console process owns modeld/start lifetime; browser disconnect ≠ stop Host / re-adopt.
- Surfaces: overview (prepare + one confirmed apply), bots (roster + saved vs observed model), runtime evidence (circuit/coverage/events — no raw provider body).
- No SQLite in MVP. No catalog/secret CRUD, no chat composer, no 30-day charts.

**Exit:** CLI and API same semantics; concurrent edits don’t clobber; GET is read-only; save ≠ “now using”; re-adopt still `--confirm` once.

### Phase 3 — T16 adapters + Effect DI

Same admit/submit contract; adapters inside sidecar:

| adapter | role |
|---|---|
| AI SDK OpenAI chat/responses | current |
| pi JSON-RPC | inference backend only — not a Host agent loop |
| Cursor SDK | same |

Effect DI wires adapter + credentials + stream. Catalog `provider` / adapter kind extends `models.json` without breaking T10. Host/preload stay Effect-free.

Do after Phase 1 contract exists so pi/Cursor don’t grow a second admission path.

### Phase 4 — T14b then T13

- **T14b:** only after live `provider_error_observed` samples. Host compact capability once → new snapshot → re-admit → **one** retry. Never auth/429/generic 400/500/unknown. No grokbox summarizer.
- **T13:** status must not fake green. Decide (Astra) whether `pending-uncertain` should degrade watchdog when `coverage=attested`. Do not auto-close circuit.

---

## 3. Ticket map

| id | status | phase |
|---|---|---|
| T10–T12, T14 step1, A1–A4 (`pre-publication-revision`) | done | — |
| T5b | frames landed; Host consumer still batch (A8) | 0 leftover / 1 stream |
| A6 | no ticket — T12 residual | 0 |
| A5 | no new id — Phase 1 admission | 1 |
| A9 | no new id — modeld-serve lifetime | 0 or with Phase 1 Effect root |
| T15 | open analysis | 2 |
| T16 | open analysis | 3 |
| T14b | open, blocked on live overflow evidence | 4 |
| T13 | open honesty | 4 |

No T17 unless Phase 1 needs a dedicated “RouteBinding revision” ticket after Astra.

---

## 4. Non-goals / anti-patterns

- Copy Host harness (loop, compact, Memory, store.db, SendToUser).
- Second SoT (SQLite, UI assignment table, prompt archaeology).
- Compact on generic `model_error` or log candidate.
- Restore `store.db` prepend / default `LIVE_PROMPT_*` caps / Responses `role=tool`.
- Extra monkey-patch, 40ms as protocol, lastHandle as exactly-once.
- Rename modeld / split npm platform / Host-side Effect or AI SDK.
- Auto re-adopt, auto-close circuit, UI one-click without `--confirm`.
- Shadow dual provider dispatch; WebUI reading Host ABI or Host SQLite.
- test1 dual-model until explicitly assigned.

---

## 5. Next 1–2 slices (after Astra pass)

1. **A6 close:** stop default raw Host fd to `/tmp/sand-host-adopt.err`; keep T12 renewer. Small, safety, no Host re-adopt.
2. **Phase 1 first kernel cut — A5 RouteBinding:** Host-visible binding revision/hash on submit; modeld checks canonical opt-in + model **before** credential/network; expired/restarted turn refuses or keeps proven pin. Offline races only until this is green.

Then T15 shared config CAS + read-only console; T16 after the admit contract is the same for all adapters; T14b only with overflow evidence.
