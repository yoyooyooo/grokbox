# Host compatibility, provenance and recovery

This page owns precise Host patch application, provenance/profile qualification and HCR recovery. Source and executable suites determine which authoring/sensing capabilities exist; the broader HSO stages below are acceptance responsibilities, not a promise that every target workflow is implemented. [Architecture](../architecture.md) owns composition, [execution](execution.md) owns admission, and [operations](operations.md) owns incident/notification policy.

## Exact runtime application

Runtime applies a reviewed profile to the intended Host source, never guesses a patch site. [profile.ts](../../packages/box-runtime/src/internal/host/profile.ts) and [live-slices.ts](../../packages/box-runtime/src/internal/host/live-slices.ts) own the current slice schema and recipes. The historical two knife points are a bounded authoring concern, not a permanent limit of two runtime patches.

Apply checks the full source SHA, each ordered pass's globally unique start/end anchors and unique find within the end-exclusive window, then the transformed SHA. Counts and offsets must match the actual apply program; first-hit search, ranking, an unchanged observation window or a computed transformed hash does not prove semantic site correctness. Failed applicability does not become managed routing success.

Host compile/preload consumes fixed reviewed data. No parser, corpus scan, fuzzy search, model, candidate ranking or profile-writing logic enters that hot path. Official Agent loop, tools, root, Memory, delivery, renewal and Server ownership remain native. Expanding recipe semantics requires explicit design/qualification, not silently larger replacement strings or a low-risk-policy label.

## Source facts and installation state

Keep four independent tuples: advertised version/channel; staged command/archive digest; installed entry/version/companion bytes; loaded Host PID/start/compile evidence and Gateway identity. Version, archive SHA, entry SHA and loaded generation are not interchangeable. A restart with unchanged bytes still needs activation verification; companion changes with unchanged entry SHA need their own qualification.

Directory watch plus bounded stat/hash resync observes actual bytes; file events may be lost or refer to renamed inodes. Supervisor status, command/ack/marker and bounded native status are advisory sources with their own pinned schema/freshness. An applied marker may precede readiness or rollback; absent markers do not prove absence of upgrade. RPC response time does not refresh a cached upstream version. App/image hints can trigger resense, not attribute a cause without evidence.

Known stage activity, entry-first/version-last transitions, mixed companions, mutated failure, unstable reads and unknown rollback state block applicability/adoption while allowing safe capture. Repeated stable observations reduce uncertainty but do not lock the official supervisor. No fixed waiting duration proves cross-writer exclusion. New evidence supersedes old eligibility; A→B→A is a new installation episode, not renewal of A's old permission.

Sensing does not call updateHostNow/autoUpdateBoxNow, alter official command/ack/markers, force a swap or restore a retained source. Unknown upstream schema reports sensor_contract_changed and lowers coverage rather than parsing arbitrary logs. Historical upstream timing/paths are fixed-version research, not permanent defaults; necessary facts remain in [upstream integration](../upstream-integration.md), detailed retired research in [archive](../archive/README.md).

## One provenance writer

observe/watch/watchdog provenance capture shares the protected IO owner. It is separate from controller action deduplication so a completed control operation does not suppress a later sample. Status/contracts/profile status are read-only: absent trees are missing, not instructions to capture/prune/replay/repair. Do not reconnect a legacy heal function merely to borrow its snapshot code.

Capture from an explicitly authorized local source using a pinned regular-file descriptor, bounded raw bytes, before/after identity and pathname checks. Preserve encoding/BOM/hashbang/newline/whitespace exactly; non-roundtrippable UTF-8 fails. Calculate SHA from observed bytes, not caller claims. Source churn is source_changed, not a new valid mixed generation.

Protected staging, sync/readback and atomic generation publication precede HEAD. Same-SHA source is immutable; conflicting bytes are corpus_corrupt. HEAD is latest complete observation, not loaded state or adoption approval. Entry integrity and installation consistency are separate; a transition sample may be retained without advancing the stable-installation pointer. Derived metadata can be reconstructed only by an explicit operation.

Retained bundles, contract windows, reviewed profile copies, review digests and replay outputs have distinct roles within one private provenance domain. No second source corpus or public build dependency. Actual retention budgets live in the source policy. Protect live/current, last qualified rollback, in-use/review/episode references; pressure does not authorize deleting protected inputs. Plan/prune rechecks digest, protection, leases and identity under the owner lock; no permanent deletion, global Trash cleanup or GET mutation.

Archives are data, never executable recovery media. No require/import/eval/vm/compile of private retained Host; syntax checking, when supported, uses a bounded owned worker without inherited loader/NODE_OPTIONS/credentials. Public tests use independently authored fixtures.

## Replay and candidate qualification

Legacy observation windows are not patch sites. patchImpact uses exact source × slice × recipe/profile evidence; envelopeDrift is a separate contract surface, not a larger driftedSlices list. Missing/ambiguous observations remain unknown, not unchanged or empty success.

Replay covers every selected source and required slice even when another fails. Trace records source/profile/recipe, integrity, global anchor counts, in-window find count, ordering, original source range and current-pass range. The first replacement can change the second pass; never reorder an old reviewed profile. UTF-16 parser offsets must be mapped and verified against original UTF-8 byte ranges and substring hashes.

A reviewed profile must match its own retained source and transformed SHA. The same profile on another SHA fails unknown-sha even with unique literals. New unique candidates remain unreviewed. Missing source/profile, incomplete corpus, corrupt bytes, truncation and trace mismatch cannot produce support. A regression correctly expecting refusal is not supportGatePassed.

Golden site labels and behavior expectations are independent of the matcher. Changing the engine must not regenerate its own expected sites. Replay keys include source, profile/candidate and tool/engine/parser/recipe revisions; old cached green evidence does not qualify a changed input.

Candidate engines contribute literal, fingerprint and structural evidence to one table, not three competing authorities. Keep all semantic variants with distinct bindings/replacement, even at one span. Ranking affects presentation only; contradictions, ties, multiple sites and truncation cannot be hidden by a highest score.

The create-session role is the synchronous factory method in the actual inference options object, after directive prologue and before official provider initialization. Callback/options bindings and same-object neighbors provide evidence, not merely a name or two-argument shape. Async/generator/destructured/computed changes require explicit supported binding semantics rather than guessed replacement.

The agent-id role is the main TURN options object actually passed as the factory's second argument, with the same Host receiver and already-initialized TURN binding. STEP callback IDs and arbitrary UUID variables are not TURN identity. Shadowing, TDZ, spreads/getters/duplicate identity fields, background lookalikes and already-patched source need explicit rejection or new review. Preserve original evaluation order and untouched bytes.

Strict parser failure/timeout/OOM leaves structural evidence unavailable. Textual evidence may still be presented with limitations, never relabeled as executable-method proof. No permissive-parser roulette or pretty-printing Host source. Source size, worker time/memory, candidate/pair counts, byte windows and queue budgets are finite and versioned; incomplete analysis cannot publish. Killing an owned parser worker is distinct from signaling a live Host.

## Review, publication and adoption

Candidate artifacts have a distinct discriminator, not a shape the ordinary profile loader can mistake for reviewed input. A review digest binds exact source/baseline, selected ordered candidate data/bindings, rules, replay/semantic evidence and any participating code revision. Publisher recomputes rather than trusting artifact-supplied counts or scores. Artifact edits, source changes or changed evidence require new review.

Human/explicitly delegated policy review must establish correct main-chain sites, early guard/official passthrough, identity/initialization, no expanded native responsibilities, complete negative evidence and current installation applicability. A typed confirmation digest binds intent; it is not cryptographic proof of a human identity. Model verdicts, comments in source and successful tests do not self-authorize publication.

Use the existing profile writer, with protected staging/readback, expected-reviewed digest/CAS and source revalidation. Same-source capability upgrades preserve the complete baseline and unrelated slices. Publication writes profile/review evidence only: no automatic code edit, preload rebuild, Host/attestation/desired mutation, or adopt. Snapshot copies of mixed/staged source cannot bypass applicability barriers.

A separately authorized controller operation performs actual adoption against current source/profile/process/Gateway and required native fences. It pins the appropriate observed generation, not a later convenient replacement. Compile marker, canonical attestation, loaded capability, current Bot admission and Provider/App roundtrip are separate proof.

## HCR: current controlled capability and operation recovery

[HCR-01–04](../tickets/README.md#host-capability-recovery) cover deterministic recipe/witness diagnosis, actual loaded wrapper/reader capabilities, interrupted-operation recovery and same-source capability upgrades. These mechanisms exist in source; full native/live coverage and independent review remain separately scoped.

profile analyze/write share one preflight and finite slice/code failure. Missing measurement is not empty drift. Explicit registered capability upgrade starts from the reviewed baseline digest, includes dependency closure, preserves unrelated slice bytes and uses the original envelope review/publication gate. Missing baseline, drift, unknown dependency or missing golden evidence refuses; no arbitrary slice skipping or generic external executable recipe.

Loaded capability reflects the wrapper AND reader actually running, not desired profile or a test UUID. A capability query is read-only and does not itself perform Server List or model calls. doctor separates Host origin, modeld readiness and bridge capability; unknown has an observational next step. loaded_profile_mismatch requires authorized adoption/restart, not repeating a successful disk profile write forever.

Controller and identity writers hold a Linux advisory gate through the operation. Recovery inspects without creating roots/gates; explicit confirm acquires controller then identity gates, checks a definitely dead owner and unchanged protected file instance, and restores running metadata only to unknown. It does not emit signals, attest or replay the operation. Live/unknown/PID-reused owners, symlink/replacement and legacy ambiguous records refuse.

The gate uses a protected open fd with the supported flock primitive, not PID-only unlink mutual exclusion; missing primitive fails visibly. Old writers must be fenced before recovery because a new gate does not constrain bypassing writers. Scope manages normal acquisition/release, not crash atomicity. Cancellation before resource acquisition does nothing; cancellation during a short commit waits for actual IO settlement. Partial publication remains inspectable/unknown, never a claimed rollback.

## Responsibility and executable proof

| Stable responsibility | Required evidence |
| --- | --- |
| HSO-0 observation semantics | exact ordered trace, all counts, legacy/window distinction, scoped upgrade facts |
| HSO-1 sensing/retain | real CLI/writer path, watch loss/resync/churn, protected generations, no heal/control side effects |
| HSO-2 corpus/replay | complete matrix, independent labels, unknown SHA/corrupt/missing refusal, no source execution |
| HSO-3 proposal/analysis | finite variants/ranking, no self-approval, missing runner and cancellation settle, no private upload |
| HSO-4 structure/iteration | byte/binding correctness, lookalike and shadowing negatives, owned worker bounds, explicit code-write scope |
| HSO-5 publication | digest/CAS/source race negatives, no unauthorized writer shortcut or automatic adopt |
| HSO-6 integrated qualification | same production programs, full negative gates, source/packed/private-static scopes distinguished |
| HCR-01–04 | shared diagnostics, new/old wrapper-reader combinations, real process lock recovery, exact baseline upgrade and Node CLI |

These IDs retain accepted obligations; they are not another progress ledger. Discover actual suites in `packages/box-runtime/test/host-seam-*`, `host-upgrade-*`, HCR tests and `test/host-*`. Available verifier names come from package/scripts, not historical planned commands. Performance results need fixed loads/toolchain and actual exits; missing/empty/skipped evidence is not completion.

Revalidate changed upstream sensor schema, recipe/source/companion, native ABI, parser/ranges, review policy, process lock primitive or publication lifecycle. Keep old failed windows immutable. Current live disposition is only [LIVE-HOST-CAPABILITY-RECOVERY](../tickets/LIVE-integration-validation.md#live-host-capability-recovery), and no offline qualification authorizes service mutation or model spend.
