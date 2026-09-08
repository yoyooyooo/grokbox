# Box-runtime tickets

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

后续实施统一遵循 [Box-runtime 实施方案](../roadmap/box-runtime-plan.md)。本文只索引票据范围与状态，不维护第二套执行顺序；阶段完成以方案中的出口证据为准。

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
| T5 | split | T5a done / T5b framing done; Host streaming remains Phase 1 |
| T5a | done | C1 credentials productization (modeld Effect seam) |
| T5b | framing done | Unix chunk frames; bounded Host stream consumer is Phase 1 / A8 |
| T6 | done | Unified `runtime start` facade (ensure modeld/watchdog + activate) |
| T7 | done | Prove official replacement via Gateway pid |
| T8 | done | Offline CCS sub2api recipe; spend superseded by T9 / test0 luna |
| T9 | done | Live CCS modeld smoke (luna + grok Responses) |
| T10 | done | Per-Bot official passthrough (selective route) |
| T11 | done | Pre-dispatch official passthrough + STEP-correlated visible errors |
| T12 | done | Adopt preserves official Host renewer env (create-bot / other bots) |
| T13 | open | Shared status facets in Phase 1; deeper diagnostics in Phase 4 |
| T14 | observation done | Enums-only overflow observation; correlation/classification work remains |
| T14b | open | Confirmed-overflow Host compact + one recovery attempt; Phase 4 |
| T15 | open | Shared use cases / command boundary / WebUI MVP; Phase 2 |
| T16 | open | Qualify and implement pi/Cursor backends on Phase 1 DI; Phase 3 |

## Live canary bots

Stable ids (App names may change). Route is `assignments.agents[id]`; missing key = official (T10).

| App name | id | live route |
|---|---|---|
| grokbox test0 | `00000000-0000-4000-8000-000000000114` | opted-in (currently luna) |
| grokbox test1 | `00000000-0000-4000-8000-000000000113` | unassigned / official until opted in |

## Open follow-through

A1/A2/A4 are closed in source at `pre-publication-revision`. A3 tool-role continuation is fixed; **A3fu user-contained tool-result preservation remains open**. A3fu/A5–A10 reuse the gap labels and phase mapping in the [implementation plan](../roadmap/box-runtime-plan.md), without creating a parallel ticket series. Live adoption, provider spend, and test1 opt-in require separate authorization.
