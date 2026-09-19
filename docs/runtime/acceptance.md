# Runtime acceptance obligations

This page preserves the cross-domain V01–V30 requirements from the rebuild without retaining its old schedule, live object names or one-off permissions. It defines properties, not completion status. Source tickets own implementation/offline/review; [LIVE](../tickets/LIVE-integration-validation.md) alone owns current candidate results. [The live guide](../maintainers/live-end-to-end.md) owns execution procedure.

## Stable vectors

| ID | Required observation or negative case | Contract / responsibility |
| --- | --- | --- |
| V01 | Different managed models on A/B; C official; actual requests isolated | [Execution](execution.md), model selection / T24 |
| V02 | Next-TURN edits preserve current TURN/recovery binding and historical choice | Execution / T24 |
| V03 | First real request can immediately overflow; old late-register ordering fails | [Context](context.md) / T35 |
| V04 | Pending external/self/background summaries preserve one root acceptance owner; supported work progresses, unsupported dependency is bounded | Context / T35 |
| V05 | One qualified compact, legal resume, one extra main attempt and one terminal | Context / runtime-T32 |
| V06 | Ordinary auth/rate/size/disconnect/timeout or released material does not authorize overflow replay | Context / runtime-T32 |
| V07 | Legitimate summary longer than the former short timeout can complete within parent budget; exhausted total budget never renews | Context / runtime-T32 / T35 |
| V08 | Cancel before/during/after root acceptance, late result fences, unknown isolation, no fictional rollback | Context / T35 |
| V09 | Repeated/old nonce, wrong tuple/generation and late disconnected responses produce no duplicate effects | Execution / runtime-T32 |
| V10 | Executor/metadata isolation, bad bind/append/getter rejection and snapshot qualification | [F1/F2/F3](../maintainers/managed-context-continuity.md) / context |
| V11 | Failed managed recovery cannot be amplified by an outer Host retry; official negative control remains native | Context / T35 |
| V12 | Functional enablement and fault injection have separate scopes; multi-Bot work has no unbounded wait cycle | Context / runtime-T32 |
| V13 | Actual packed bytes match qualified source; stale profile/SHA, missing or empty proof cases cannot pass | F6 / [Host compatibility](host-compatibility.md) |
| V14 | Checkpoint followed by process exit/new-process restore, not RAM or UI backfill | E04/E08 / context |
| V15 | Memory/episode purpose and parent selection are qualified both ways; error/reasoning does not become Memory | F5/E07 / execution |
| V16 | Unmodified App input/display is correlated with actual Host model, tools and delivery | T26 / T39 |
| V17 | Normal config/credential readback, clean startup and restart persistence, without temporary injection assumptions | T40 / service composition |
| V18 | Fixed-version upgrade/deactivate/rollback preserves native state and never replays an unknown STEP | T40 / [rollback](../maintainers/official-rollback-acceptance.md) |
| V19 | Representative multi-TURN usage, post-recovery continuation, tools and required auxiliary behavior | T39 / E10 |
| V20 | Original Server ownership, scope/freshness/revocation at actual Host admission; missing/conflict yields no unauthorized new effect | T37 / execution |
| V21 | Ordinary profile writes do not write harness; creation is confirmed; local-priority identity writers do not bypass Server authority | T38 |
| V22 | Preserve and reject conflicting identity samples; calibration needs its own impact authorization, no history merging or unknown replay | T38 |
| V23 | Same Bot official→A→B→official→A; official reader consumes custom native checkpoint with identity/history intact | T39 / execution / context |
| V24 | Working/typing/approval/stream are scoped to the correct session/run/generation; late old events do not revive or extinguish another run | T36 / [App projections](../maintainers/host-app-projections.md) |
| V25 | Per-Bot official selection and full unpatched-Host exit are independently proven; post-exit proof does not require the removed bridge | T40 / rollback |
| V26 | Stable native prefix/encoding; cold/hot cache changes no correctness; real usage or missing observation is honest | T39 |
| V27 | Fixed candidate, independent review, actual support scope and bounded authorization; required missing evidence prevents the relevant release claim | T40 / LIVE |
| V28 | Collector independent of pages, shared bounded reads, scope/generation/freshness and current revocation distinct from old observations | T41 / [operations](operations.md) |
| V29 | SQLite observation/management separation, crash/corruption/migration/retention/cursor gap; DB never restores execution authority or writes config/Host | T41 / operations |
| V30 | Incident dedupe/recovery/ack/snooze and delivery idempotency limits, no task replay/repair; collection not tied to an open page | T41 / T40 / operations |

The fuller CTX-A/R matrices live in [context](context.md), HSO/HCR responsibilities in [Host compatibility](host-compatibility.md), and CONT acceptance in [continuity](continuity.md). F/E named obligations retain their owner in [managed context continuity](../maintainers/managed-context-continuity.md); source evidence does not silently retire an unresolved property.

## Evidence boundaries

Owned fixtures, source programs, actual packed Node, explicit native-method isolation, live Host with injected overflow, actual Provider overflow, App visibility and restart/long-running behavior prove different things. Synthetic negative tests should run in isolation, not repeatedly disrupt business objects. No unbounded soak or every future ABI is required to complete a precisely scoped release.

Tool generation preference is not execution capability. Production validated-batch releases a complete legal multi-call batch in original order; a second legal tool is not intrinsically invalid. No-op auxiliary completion, empty main output, length/content-filter and successful stop retain their separate semantics. Tool material released is not an external transaction completed.

Host trays are an ephemeral bounded memory projection, not a durable warning database. Missing warnings do not prove success; later STEP failure must correlate by actual TURN/service identities, not only the first requestId. Expected-result matching proves observed content, not complete checkpoint/whole-run success. Preserve already-known failure alongside evidence gaps.

App cached restore/Server roster can affect input routing as well as display. A successful CLI or local Box profile does not prove the unmodified App uses the same qualified path. Working, typing, per-message stream and local sending queue have separate scopes; currentActivity absence alone does not prove the spinner should stop. Original-App proof cannot be replaced by patching/clearing the client or reading Host fields alone.

## Finish a scoped change

Find the affected property and its actual source owner, reuse existing executable vectors, add regression at the wrong boundary, and run matching source/packed qualification. Do not re-open old implementation tickets solely because a new suite exists, and do not close an accepted product obligation because the original implementation was removed.

Current readiness, blockers and selected release scope remain in LIVE, with stable scenario IDs and fixed evidence references. Historical permissions, sample Bot names, model choices and old GATE unlocks do not authorize another window. A document-only refactor preserves the matrix but performs none of its live actions.
