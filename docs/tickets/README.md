# box-runtime-v2 remaining tickets (local)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

Herdr-driven backlog. **Not** Multica issues.
Cite ticket ids in herdr prompts. Update status in this file.

| id | status | title |
|---|---|---|
| T0 | open | Tracker / sequencing |
| T1 | done | Host full-bundle provenance + diff + patch impact |
| T2 | done | Land offline STEP-slot / envelope seam work |
| T3 | done | Live G1: grokbox test0 luna bubbles; T12 official bots/create-bot |
| T4 | done | Real model A+S1 inside modeld |
| T4b | done | AI SDK OpenAI chat+responses driver (sub2api baseURL) |
| T4c | done | Default modeld composite stub∪openai admit + minimal C1 |
| T4d | done | Route activate admits openai* (offline) |
| T4e | done | Route Host/preload session modelId follows models.json |
| T5 | split | T5a done / T5b done |
| T5a | done | C1 credentials productization (modeld Effect seam) |
| T5b | done | S2 streaming IPC (chunk frames + Host fullStream) |
| T6 | done | Unified `runtime start` facade (ensure modeld/watchdog + activate) |
| T7 | done | Prove official replacement via Gateway pid |
| T8 | done | Offline CCS sub2api recipe; spend superseded by T9 / test0 luna |
| T9 | done | Live CCS modeld smoke (luna + grok Responses) |
| T10 | done | Per-Bot official passthrough (selective route) |
| T11 | done | Pre-dispatch official passthrough + STEP-correlated visible errors |
| T12 | done | Adopt preserves official Host renewer env (create-bot / other bots) |
| T13 | open | Status honesty: circuit/watchdog vs attested coverage after adopt |
| T14 | open | Managed context compact/overflow when switched model window is smaller |

## Live canary bots

Stable ids (App names may change). Route is `assignments.agents[id]`; missing key = official (T10).

| App name | id | live route |
|---|---|---|
| grokbox test0 | `00000000-0000-4000-8000-000000000114` | opted-in (currently luna) |
| grokbox test1 | `00000000-0000-4000-8000-000000000113` | unassigned / official until opted in |

Driver: herdr grok main line; true blockers → new session gpt-6-astra max.

## Residual (not this closeout)

- **Live prompt:** default is Host conversation passthrough (CCS-safe text + SendToUser bubbles + tool stdout as assistant text; no `role=tool` replay). When Host’s executor window has already compacted away App-visible turns, managed STEPs prepend **this bot’s** `store.db` user/`send-message` history (not other agents). `GROKBOX_LIVE_PROMPT_*_CAP` stay unset in live. Unix envelope/frame fail visibly. T14 is provider overflow, not the first fix for folded store turns. Census: `/tmp/grokbox-live-prompt-census.json`. Diagnose: `/tmp/grokbox-context-t96-note.md`.
- **T13 / Astra:** `status.circuit=open` + `watchdog=degraded` (`circuitReason=pending-uncertain`) can coexist with `coverage=attested` after many live adopts. Do not silently close the circuit. Host `transcript-publish` `writerSeq` vs `publishedThroughSeq` lag is Host-owned, not a grokbox writer.
- **Wontfix here:** dirty `packages/cli/src/commands/runtime.ts` (`profileId: reviewed-copy-envelope`) and untracked root `src/` — leftover CLI/envelope WIP, not E3/T5b. Leave unstaged.
- **test1** dual-model opt-in: not assigned.
