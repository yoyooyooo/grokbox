# Modeld core — linear integration into v2

Dated integration evidence, 2026-09-17. This records an authorized source integration, not independent review, native qualification or live deployment. Gate ownership remains [T49](../tickets/T49-modeld-qualification-and-release.md); live scheduling and receipts remain in the continuing [LIVE ticket](../tickets/LIVE-integration-validation.md).

## Actual integration

The feature tip `967b4099c2bb22aba283c7d48c50753cfc781c48` originally branched from `43166b6d033085548dc7bcbadfdf64c28e6fe5b3`. Current v2 already contained eight additional commits through `36e6dc5b605b6b2979f314a4508a8bd9b4a8b288`, including MiniMax framing/reasoning, SDK/tool-identity diagnostics, final-delivery history and native auxiliary no-op fixes.

All eleven feature commits were rebased onto that exact v2 tip, then `feat/box-runtime-v2` was advanced with `git merge --ff-only` from `36e6dc5` to **`b57574844428219ead9b9ee18dce90ad3c8535fc`**. Both worktrees were clean before integration; the target tip was rechecked immediately before fast-forward. There are zero merge commits in `36e6dc5..b575748`; the original v2 commits and their hashes are unchanged. A local backup branch retains the pre-rebase feature tip. No remote push or branch deletion was performed.

| Original feature commit | Rebased commit on v2 | Scope |
|---|---|---|
| `0292220` | `7a2c3f3` | Spec, decision and milestone tickets |
| `5321c9a` | `0481e66` | Isolated verifier baseline |
| `c4f4ca0` | `865bb7b` | Single service acquisition/lifetime |
| `286a6a8` | `5039684` | Initial regression/local-witness boundary |
| `c244685` | `abc2a91` | Shared source versus waiter lifecycle |
| `f4bd897` | `0c17b42` | Per-identity persistence and bounded maintenance |
| `6d0e914` | `ce942f2` | Authority gates and v6 progress |
| `2025f71` | `652ae5e` | Earlier fixed-candidate report |
| `743daea` | `e6c5bf5` | One ingress deadline |
| `c6156c4` | `8d2f806` | Continuing cross-worktree LIVE ticket |
| `967b409` | `b575748` | Earlier closeout and review availability record |

Historical reports intentionally keep their original tested hashes. This mapping provides the new reachability; it does not retroactively claim their tests used the rebased tree.

## Conflict handling and preservation

Only the common diagnostic import block and the generated preload pin required manual conflict resolution. Both ownership wait/recovery diagnostics and v2's SDK-validation/tool-identity imports were retained. The preload SHA was regenerated from each affected combined source state, never copied from either old branch. `git range-diff` shows the same logical feature patches with these expected context/pin differences.

An explicit diff against `36e6dc5` confirmed the v2 backend implementations, delivery fallback, session/auxiliary handling, selection logic and their targeted tests were unchanged by this integration. The merged failure-summary and diagnostic projectors were exercised with both provider and authority scenarios. No strategy selected one entire side over the other; no dependency or policy change was introduced for the integration.

## Combined-candidate validation

All tests below executed in the feature worktree **after** rebase, at clean `b575748`, before the target fast-forward. They validate the exact combined source tree subsequently integrated into v2, not the old isolated feature tip. The report/LIVE status follow-up is documentation only. No active v2 build directory was rebuilt or activated for this integration.

| Check | Actual result |
|---|---|
| TypeScript `bun run typecheck` | passed |
| Focused combined provider/authority/deadline/delivery/artifact tests | **66 passed, 0 failed, 10 files** |
| Full repository with native opt-ins disabled | **2054 passed, 6 explicitly skipped, 0 failed, 264 files** |
| Rebuilt `verify:modeld-core -- release-offline` | **424 passed, 0 failed, 47 files**; includes packed Node installation, import/lifecycle/storage/Unix proof |
| Working-tree publication privacy scan | passed, no findings |
| Rebased HEAD history privacy scan | passed, 372 commits / 3187 blobs, no findings |
| Git range/diff/ancestry checks | old v2 is ancestor; feature changes retained; zero merge commits; no unresolved conflicts |

The six skipped tests require explicitly enabled native qualification. Their status is not converted into a pass. Tests used Bun 1.3.14 / Effect 4.0.0-beta.107 / esbuild 0.28.2 / AI SDK 5.0.253 / OpenAI adapter 2.0.125. Unix, LevelDB and SQLite resources were fixture-owned; upstream registration and inference HTTP were synthetic. The packed fragmented-stream probe reported Node v22.22.0. No real Bot request was sent.

Combined build source digest: `be04b5ffda494ee2a8b9fbe19bde5f528231ba6dfb4bd6174840ebeed357da91`.

Fixture-built CLI SHA-256: `32077cb6b99151b07c2ba85e94e097e86b41f648337db8b3d23f8e3cbb435660`.

Fixture-built preload SHA-256: `f42b076a3e40592bf162509270d5b66f84e989089960ca486dcbee916ecb3a11`.

These are the combined test-build identities, not observations of what any active Host/modeld has loaded. A future deployment must select its exact v2 candidate, rebuild/qualify it and record actual loading separately.

## Remaining gates

The user explicitly authorized this linear source integration. It does not waive G5: independent code review remains `review_pending` after the previously recorded 503/timeout failures. No new independent review was claimed or launched during this integration.

The six modeld LIVE entries now have a concrete source-to-v2 mapping. They remain blocked on the source-ticket review gate and a selected/authorized native/live window, not `passed`. The source review obligation remains in T49, not moved to the live queue. Five-second evidence freshness and all original execution/replay fences remain unchanged.

No Host/modeld restart, adoption, profile activation, global shim switch, real model spend, provider verification run or live message replay occurred. Other worktrees were neither rebased nor merged by this action. Future changes to the combined v2 tip or native/profile identities require their own affected-range revalidation.
