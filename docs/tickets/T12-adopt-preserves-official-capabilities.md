# T12 — Adopt must preserve official Host capabilities

## Goal
After `re-adopt --confirm`, **unpatched product surfaces still work** on the same Host process that carries grokbox preload:

- bots **without** `assignments.agents[id]` reply via official inference (T10 `originalSession`)
- App can **create** a bot
- privacy / agent-identity lookups are authenticated, not `Unauthenticated` fallback

Grok bot luna canary staying green is **not** sufficient. Luna bypasses official inference; the rest of the App does not.

## Why T10 is not this ticket
T10 already returns `originalSession` for uncovered bots. That object is the official session. Live failure is **process replacement**: transient-adopt TERMs the credentialed Host and spawns a new one from grokbox temp supervisor + `IDENTITY_LAUNCH_ALLOWLIST`. Official inference is delivered by the box renewer into **that** process, not via `models.json` / `GROKBOX_SUB2API_KEY`.

Evidence on current adopted Host (do not treat as merge proof):

- `Waiting for an inference credential`
- `privacy-mode lookup failed … Unauthenticated`
- uncovered bots: no Working, no reply
- App: cannot create bot
- grok bot still replies (modeld / luna / `SendToUser`)

## Non-goals
- Do not rebuild official `createCursorInferencePromptSession`.
- Do not silent-fallback managed luna failures to official (T11).
- Do not put Cursor/Gateway/inference secrets in argv, env dumps, fixtures, snapshots, or ordinary logs (`SECURITY.md` / AGENTS.md).
- Do not implement E3 / T5b in this ticket.
- Do not widen `assignments.agents` to every bot as a substitute for official inference.

## Decision required (pick one before coding)
| id | approach | note |
|---|---|---|
| A | Inject preload into the **living** official Host (no TERM) | keeps renewer identity; `--require` normally needs process start — prove a live inject path or reject A |
| B | New Host spawn must receive the **same renewer delivery** sand-supervisor uses | launch allowlist / side channel; still no secret in git |
| C | TERM → wait **official** replacement (T7) → then inject | official process owns credentials; grokbox must not be the spawn parent |

Landing without A/B/C chosen is guessing.

## Acceptance
- Uncovered bot: App shows Working then an official assistant bubble (not luna).
- Create-bot in App succeeds.
- Adopted Host no longer loops `Waiting for an inference credential` / privacy `Unauthenticated` as steady state.
- Grok bot `a0cf5282-…` still luna when listed in `assignments.agents`.
- No new secret material in repo, CLI argv, or status JSON.

## Status
**done.** B: allowlist + fill `SAND_INFERENCE_RENEWAL_CREDENTIAL` from sand-supervisor (never logged). App proof: create-bot OK; uncovered bots Working+reply. Grok bot stays luna. C unused.

## Fence
No E3 listener rewrite, no T5b frames, no extra Host slice beyond what the chosen option requires.
