# Handover controls through the original CONT owner

2026-09-21. CONT-09 / CONT-10 / CLI-05 work package, following the completed Compact management stage. This is implementation and isolated evidence, not native account or production adoption qualification.

## One current management path

`bot handover get/advance/observe/attest/retire` and `operation get/resume/reconcile/cancel --domain handover` use the shared client and management Server. The original CONT workflow/duty tables and native relationship/Routine adapters still own effects. Management declarations, immutable request identities and receipts use the existing `continuity_queued_controls` table; there is no additional workflow engine, operation database or relationship writer.

The former `agents handover` registration, CLI command implementation, forwarding modules and direct attestation facade are removed. A caller cannot write an arbitrary evidence hash into a duty through the old API. Reads remain bounded original-store snapshots; declarations, Routine prompts, profiles and transcript bodies are not exposed by management metadata.

Actions bind installation, principal, account scope, original workflow digest, source/target and expected handover revision. Manual replacement requests remain owned by their original management principal. Protection-generated workflows still require current protection authority. Handover write, user messages, attestation and retirement have independent capabilities. The original activated successor and fresh source-account/target ownership are checked before actual native effects, including after awaited observations and durable duty claims. Requested activation or a target UUID is not sufficient.

## Dependency and evidence boundaries

The original handover program follows a bounded dependency frontier rather than a single pass over UUID-sorted rows. A completed predecessor makes its dependent eligible within the same batch. An item is examined at most once per invocation; a lost write response permits one bounded readback, never another dispatch. A readback absence cannot become a certificate that nothing happened. Routine creation remains disabled, then the old Routine is stopped, then the new one can be enabled. Unknown items do not prevent independent, authorized duties from progressing.

`observe` reads native relationships and retains local observations/convergence. `attest` accepts only an exact completed duty observation from the same principal and workflow, reobserves its native evidence, and verifies the immutable input and dependencies in the same CONT transaction as the resulting management receipt. Unsupported external dependencies cannot be cleared by a pasted hash, model statement or the existence of an active successor. A completed management batch does not assert complete duty coverage.

Inbound text containing a handover marker is still user activity; text is not origin authority. Rewritten, duplicate or malformed transcript windows preserve a gap. Quiet time is not resource independence or an atomic ingress/deletion fence. The current native adapter explicitly lacks those latter capabilities, so actual native retirement remains blocked; no generic delete fallback is added.

Retirement reconciliation is a separate program in the original convergence owner with **no native port**. It can only finish from the exact original durable deletion receipt and repair the local phase. Missing/prepared/unknown inner records cannot trigger a fresh sample or delete. This also allows an already-settled original deletion to be reconciled without requiring its now-absent source to be contacted again. An explicit resume retains the original retirement guard and authority; it does not replay unknown deletion.

## Lifetime, recovery and consumers

Accepted handover work is owned by the management Server, not the caller connection. Same-root lifecycle gates and per-duty claims prevent competing Server instances from duplicating effects. Closing the Server cancels native reads and joins local writes. Packed Server SIGKILL after a native effect leaves the original duty unknown; explicit continuation inspects that duty and preserves its identity. Preparation alone can be cancelled. Claim/settlement acknowledgment loss preserves committed history.

The production protection page and common operation page use the same application, cookies/CSRF and capability checks. Browser recovery stores only the original installation/principal/replacement/scope/request locator, never the reviewed revision, evidence input or private bodies. Conflicts preserve the draft until explicit refresh/reapproval. Reload does not resubmit, and retained history is readable independently of native source availability.

## Verification record

Initial typechecking caught three old convergence tests still omitting the now-explicit retirement authorization; they were migrated to the intended automatic mode rather than restoring an implicit default. The first packed death test used a fixture-owned manual workflow with a different principal from the installed Server; the actual ownership refusal was preserved and the fixture now creates the workflow under the installed principal. Failure observation now surfaces an early rejection instead of waiting for a nonexistent native effect.

The durable-duty revocation test initially hooked any progress transaction, which could be an unsupported item becoming blocked before a dispatch claim. It now observes the actual `effect_unknown` duty claim before revoking. No dispatch assertion or unknown-state requirement was relaxed.

The initial browser run reached all six new scenarios; its retirement test waited on a blocker already present in the prior attestation instead of the new retirement outcome. It now waits for the new blocked retirement result before checking the unchanged source. Existing lifecycle/protection history wording retains the explicit not-proven boundary. No browser-write retry or assertion timeout increase was added.

Stage closure used source fingerprint `9e8c46fe3dae236405fc8fc28e1f851855c8f04e1b9fd37eec4aef23427f4b65` across 1199 source/test/toolchain inputs. The core, integration and explicitly opted-in native-pair windows were stable before/after each run: 892 tests/101 files, 27 tests/20 files and 28 tests/5 files, respectively; 947 tests across 126 non-overlapping files passed, with no failures. Rust separately passed 39 tests. Internal Node handover/compaction counts were 20 each and relocated production Chrome passed 79 nodes; these nested counts are not added to 947. Root/Web typechecks, protocol generation, actual build/tarball installation, verifier/FD and relocated Web checks passed, as did 15 documentation/registered-command checks and staged/unstaged diff checks. This is expanded affected-scope verification, not the final whole-repository candidate.

All native account/collection/earlier activation facts and message destinations in the management fixtures are synthetic. Tests execute real Node HTTP, original CONT/provision stores, native adapters, packed CLI/Server processes and production Chrome. They do not call actual models, deliver external messages, publish/load a profile, change active services or move the global entry point. Full native external dependency/resource independence and conditional deletion remain explicit CONT-09/10 implementation or qualification work, not a completed delivery claim.
