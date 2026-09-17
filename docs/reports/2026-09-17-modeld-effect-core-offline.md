# Modeld execution-core: fixed-candidate offline results

Dated evidence, not a replacement for [Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) or an authorization to release. Gate ownership remains [T49](../tickets/T49-modeld-qualification-and-release.md). This report does not include private Host code, runtime identities, credentials, production transcripts or machine-local paths.

## Candidate and dependency reality

Implementation commit: `6d0e9140f1ec07c311cb754998e1448f34f75371` on `feat/modeld-effect-core`.

Comparison baseline: `43166b6d033085548dc7bcbadfdf64c28e6fe5b3`, a clean source checkout of the original v2 base. The comparison did not modify that checkout's tracked files or build its artifacts. The candidate was clean during the final benchmark.

Build source digest: `0a8b8cba7a8475a7f03b56976d1f2c1224430ce8c6aa877c6bd9cd4f8a3d9543`.

Preload artifact SHA-256: `b28c9176c5fad48b4b97abdb832e932838e78c1d84820619a513da08050d0e42`.

Both sides used Bun 1.3.14, Effect 4.0.0-beta.107, esbuild 0.28.2, AI SDK 5.0.253 and OpenAI adapter 2.0.125. The benchmark executes the real source programs under Bun, with actual local Unix sockets and LevelDB but synthetic registration and model HTTP capabilities. Bun's reported Node compatibility version is not a separate Node benchmark. Independent packed-process tests exercised the installed Node runtime; the fragmented-stream probe explicitly reported Node v22.22.0. No new official Host/App qualification follows from either lane.

## Executed checks

| Check | Observed result | Claim limit |
|---|---|---|
| `verify:modeld-core -- authority` | 111 passed, 0 failed, 11 suites | Production gate, source coordinator, Unix/Host and synthetic provider behavior |
| `verify:modeld-core -- release-offline` | 416 passed, 0 failed, 46 suites | Rebuilt candidate; finite union of lifecycle/evidence/state/authority/observation, package/import/privacy vectors |
| Full repository tests | 1997 passed, 5 explicit native qualification skips, 0 failed; 257 files | The five opt-in native-source tests were not executed |
| Packed installation | Passed in the release aggregate | Tarball install, Node-only CLI aliases and isolated Node lifecycle; not official Host upgrade acceptance |
| Publication working-tree scan | Passed with all implementation files staged | No findings among 750 scanned blobs; reachable-history scan is a separate post-commit check |
| Final-tree typecheck | Not established | Earlier typechecks passed before the last telemetry changes; the final recheck was blocked by execution tooling and did not run. Builds/tests do not substitute for this gate |

The test runs and the committed implementation have the same build source digest. Documentation-only changes following this commit do not alter those runtime inputs. A prior full test attempt exposed two outdated first-frame assertions after v6 introduced pre-admission progress; those assertions now inspect the actual terminal. A disposable process-topology test failed once in that earlier run, passed its focused rerun without production changes, and passed the final complete run. This report does not reinterpret the earlier failed run as a pass.

## Fixed source-to-source benchmark

Run with the declared toolchain:

```sh
bun run benchmark:modeld-core -- --baseline-root <clean-baseline-checkout>
```

The same worker imports each checkout's production composition separately. Its own services, execution storage, native source and model responses are isolated. The report validator rejects mismatched workloads, missing cleanup, duplicate terminals/model effects and candidates that merely fail in both lanes.

| Workload | Baseline | Candidate | Model calls, baseline / candidate |
|---|---|---|---|
| Four STEPs, one fragment per response | All succeed; 164.843 ms total | All succeed; 203.766 ms total | 4 / 4 |
| Four STEPs, 2,048 fragments per response | All succeed; 1151.078 ms total | All succeed; 1005.553 ms total | 4 / 4 |
| First source read 5,500 ms; next read fast | `not_admitted`; 5517.826 ms | Completes; 5656.162 ms | 0 / 1 |
| First source read 7,750 ms; next read fast | `not_admitted`; 7766.640 ms | Completes; 7911.289 ms | 0 / 1 |
| First source read 9,000 ms; next read fast | `not_admitted`; 9016.619 ms | Completes; 9185.851 ms | 0 / 1 |
| Cancel during initial source wait | Source settles after 10003.370 ms | Source settles after 2.780 ms | 0 / 0 |

For each delayed first-read case, the candidate made exactly two native reads, consumed one bounded read retry and emitted exactly one STEP terminal. It discarded the stale first observation and used the distinct fresh second observation. The five-second hard evidence policy was **not** enlarged and no timestamp was renewed at response completion. Continuously slow or unavailable reads are not covered by a promise of success; the strict refusal and budget-exhaustion tests remain mandatory.

For both ordinary fragment counts, the baseline and candidate each made **one actual native RPC across four STEPs**. The baseline already had a Host cache. Full-read adapter calls changed from 16 to 1, while the candidate performed 32 fresh local-only witness reads. This is a change in cache ownership and local-fact validation, not a sixteenfold reduction in network calls. Fragment count did not multiply registration reads.

Both cancellation cases had one source call, zero model calls, one terminal and completed fixture cleanup. Client handles settled quickly in both cases (0.927 ms / 0.851 ms); the significant distinction was the lifetime of the underlying synthetic source after cancellation. That is not an observed official-server cancellation latency.

The ordinary one-fragment case became slower in this sample, while the larger-fragment case varied in the other direction. Four samples per case and one machine do not justify a general throughput, P95 or SLA improvement claim. The demonstrated gains are bounded recovery, cancellation ownership, identity isolation and non-amplifying source demand. Cumulative lock/storage timings, source/waiter/local-witness observations and event-loop samples are included in the machine-readable command output; they are not production distributions.

## Remaining release gates

G0 is not fully signed: final-tree typecheck still needs an actual successful run. T47 also retains the pre-existing outer admission timeout alongside the inner cumulative authority allowance. Both fail closed, but the full-budget race and preservation of the most specific timeout cause still require integration qualification. The attempted adjustment was not applied; this report does not claim it was removed.

G1's enumerated offline package/import/provenance tests passed. G3 remains the accepted strict policy. G4 covers only the frozen scenarios above and deterministic contention tests, not an unrestricted performance certification.

G2 (unpatched official / patched passthrough / patched managed native comparison, including final tool consumption), G5 (independent fixed-tip review) and G6 (authorized live cutover and rollback) have no new receipts. They remain release requirements, not optional residue in T50. A modeld material-release fence is not proof of native tool execution after an approval delay, and local native booleans are not a Server lease.

No merge into v2, remote push, real Bot message, provider spend, Host restart, modeld replacement or policy expansion was performed by this qualification. Source implementation, offline test results, independent review, current-native qualification and live release must continue to be reported separately.
