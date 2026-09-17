# Modeld core: deadline closeout and deferred live acceptance

Dated evidence for the clean candidate `c6156c4a8d214877520712c4ad45bd4a4f839178`, 2026-09-17. [T49](../tickets/T49-modeld-qualification-and-release.md) owns gate disposition; [LIVE](../tickets/LIVE-integration-validation.md) owns cross-worktree live scheduling/receipts. This report is neither native qualification nor release authorization. It supplements, rather than rewrites, the [earlier fixed-candidate results](2026-09-17-modeld-effect-core-offline.md).

## Landed changes

- `743daea`: removed the obsolete aggregate admission timer and unused 500ms/10.5s constants. Server and kernel use the same injected monotonic ingress origin. The unchanged 180-second request budget spans claim/admission/prepare/streaming; only the kernel gate owns the smaller cumulative authority allowance. Future ingress origins fail before claim; a returned source failure is not masked by a separate same-scale admission timer.
- `c6156c4`: established the continuing `LIVE` ticket, six feature-scoped entries and routes from AGENTS, docs map, ticket index, Spec and release runbook. Code/offline/review blockers cannot be deferred there. Normal live qualification waits for an actual fixed v2 integration mapping and one approved artifact/window. Neither registration nor merging authorizes operations.

The five-second evidence policy is unchanged. A slow first observation must be discarded and a genuinely fresh second observation obtained inside the existing finite budget; persistent slow sources still refuse. One gate recovery never re-infers an already dispatched model call. Deadline expiry is not proof that uninterruptible durable acknowledgements or external effects have physically settled.

## Executed validation

| Check | Result at the fixed candidate | Scope |
|---|---|---|
| `bun run typecheck` | passed | Final production and test types, including telemetry and ingress timing |
| Focused deadline/gate/Unix/observation run | 25 passed, 0 failed | Includes seven new deadline/origin vectors |
| `bun run verify:modeld-core -- release-offline` | **424 passed, 0 failed, 47 files** | Fresh build, production capability substitution, real temporary Unix/LevelDB/SQLite, packed Node install, lifecycle/import/privacy tests |
| `bun test --only-failures` | **2005 passed, 5 explicitly skipped, 0 failed, 258 files** | Whole repository; skipped native qualification tests remain unproved |
| Clean source benchmark | passed behavioral/cleanup oracles | Same fixed baseline/workload and dependency versions; not a production SLA |

Declared tools: Bun 1.3.14, Effect 4.0.0-beta.107, esbuild 0.28.2, AI SDK 5.0.253, OpenAI adapter 2.0.125. No dependency upgrade. The fragmented packed Node probe reported Node v22.22.0. All inference HTTP and native registration inputs in these tests were synthetic. Temporary real sockets and stores were owned by the fixtures; no real Bot was reassigned, messaged or replayed.

Build source digest: `41cd1be7dc0f327cbb29c80d8fcf2db05dbd0837b5808c51edec2c1fe1ae4527`.

Built CLI SHA-256: `1352eb76fbb7df97d5c6f30203d0f6c96ef3c3429d86273b8e3bb7fc6c4523d6`.

Built preload SHA-256: `f788c160fd56feb6e7a4ddb3369d8b72f8ebaf154e7d565df067a2c4a0c14e6b`.

A later integration build must record its own commit, digest, artifacts and native version; it cannot reuse these as proof of what an installed Host has loaded.

## Deadline oracles

The production server suite uses real Unix framing and an injected TestClock. A two-second claim followed by a 9.9-second source failure preserves `server_read_unavailable` and RPC code 14, with zero model effects; the retired outer cap would have fired first. A full ten-second authority wait after the same claim preserves the gate's `ownership_read_timeout`. Twelve-second preparation can complete safely; 100-second preparation plus 100-second streaming times out at the original 180-second deadline, with one model call and one error terminal. Preparation that never becomes ready ends without model dispatch. Kernel tests account for pre-kernel ingress time and reject a future origin before persistence. Resource and lease release are asserted separately.

## Benchmark replay

Baseline remains clean `43166b6d033085548dc7bcbadfdf64c28e6fe5b3` / source digest `0a82a51a9f265f85c858d3436735e9e2de9b45a74ec68b282fd5c514834cc285`; candidate was clean `c6156c4` with the source digest above. Neither checkout was rebuilt or modified by the benchmark worker itself.

Four successive STEPs at one fragment and at 2048 fragments each still made four model calls and one actual native RPC on both baseline and candidate. The old Host cache already reduced upstream RPCs; this is not a claim of a sixteen-fold upstream reduction.

For a fixed first native read of 5500, 7750 or 9000ms followed by a fast source response, the baseline refused before inference. Each candidate run made two reads, accepted the genuinely new evidence and made exactly one model call. Cancellation of the controlled source took about 10005.278ms in the baseline and 3.111ms in the candidate, with zero model calls, one terminal and completed fixture cleanup in both. These are synthetic controlled measurements, not an official service latency guarantee or statistical speedup claim.

## Independent-review availability — not a pass

The external reviewer was invoked read-only against fixed tips, without write/command/service capabilities or production data. No independent report was obtained:

| Attempt | Requested reviewer / input | Result |
|---|---|---|
| 1 | `sub2api-codex/gpt-6-astra`, maximum reasoning, checkout `743daea` | Upstream HTTP 503, no report |
| 2 | Same reviewer, checkout `c6156c4` | Upstream HTTP 503, no report |
| 3 | Configured alternate route `sub2api-codex-alikl/gpt-6-astra`, same fixed candidate and read-only scope | Bounded 270-second process ended with timeout status 124, no report |
| 4 | Primary reviewer, attached public source only / no tools, same candidate | Upstream HTTP 503, no report |

These failures do not establish a code defect, a Host outage or a completed review. Implementer inspection, test counts and this report cannot substitute for G5. The remaining independent code review is a **non-live external blocker in T49**, not optional T50 residue and not a live-only entry. No further reviewer or monitoring job was left running by these bounded invocations.

## Disposition

The identified code/type/deadline tail is implemented and the fixed candidate passes the enumerated offline gates. G5 remains `review_pending` because the reviewer returned no result; there is no claim that all non-live release requirements are signed.

The actual native triptych, installed cutover, real source cancellation/identity behavior, delayed tool consumer, Provider/App observation and restart/rollback receipts are registered in LIVE under six stable `LIVE-MODELD-*` IDs, all `awaiting-integration`. Sources must be mapped to a fixed `feat/box-runtime-v2` commit and revalidated together before an approved live window. No merge, push, shim switch, profile activation, adoption, Host/modeld restart or real Bot request was performed in this closeout.
