# Persistent observation-loss projection

Date: 2026-09-24. Issue: AH-179; disposition of the D/E independent review's finding 3. Base: `97426af5d13fdacf683c2007fcd428e10bc1aeec`. Main repair: `a8d7df2b86e36178e6545bdfc122f0dbf0742e1b`. Final reviewed code: `cebce4428777ebad21498e81bbb33f778ffe737e`. This report changes no runtime source.

## Confirmed behavior and repair

The original Node HTTP/SQLite observation suite reproduced two failures against the base: after a bounded store rejected 128 synthetic evidence events, collection resumed, `pressure_state` became `normal`, and the source cursor's gap cleared. The original maintenance row still held 128 dropped events and one rejected batch, but both public snapshot and events responses omitted those values. The existing 13 cases passed; the two added cases failed on the absent public projection. This was an observability defect, not demonstrated model execution corruption or a production incident.

Both public surfaces now expose the original row as `observationHealth`, containing only `pressureState`, `droppedEvents`, and `rejectedBatches`. Events read the row within their existing read-only transaction; snapshot already did. Missing or invalid fields fail public validation rather than becoming zero/healthy defaults. The contract rejects negative, fractional, unsafe, string-valued counts, unknown fields and array-valued pressure states. No second database, writer, ledger or retention policy was introduced.

The Console shows active pressure separately from recovery with retained loss. Empty subscription pages update these counters even when the event cursor does not advance. Database-lifetime loss, retained-history truncation and the browser's 100-row display bound remain separate concepts. Reading or refreshing does not restore missing evidence or grant execution authority.

## Executed verification

| Check | Actual result and scope |
| --- | --- |
| Original public observation Node suite | 15 passed, zero failed/skipped; active pressure and recovery on both public surfaces; reads preserve complete database bytes and mtime; no native list/ownership calls |
| Final-code cross-regression | 16 Bun outer tests across seven files, zero failed; nested Node groups: observations 15, incidents/watch 27, messages 36, model authorization 24, Web bridge 9; client contract/watch 11 Bun cases. Nested counts overlap outer wrappers and are not additive totals |
| Root and Web TypeScript | Passed on final reviewed code |
| Production browser, original disjoint groups | On `a8d7df2b`: console 56, state 39, host 9; each group zero failed/skipped. Each outer invocation selected one original group; all three were run. Relocated production artifacts, disposable Chrome home and synthetic native facts |
| Build | Complete CLI/runtime/Web build passed on `a8d7df2b`; the subsequent scalar-enum change has targeted contract and cross-regression evidence, not a claimed second full browser execution |
| Documentation / runtime boundaries / publication | Passed before this report; publication found zero findings |

The first combined browser invocation returned a remote timeout without an exit report. It was not counted as a pass. Its processes were observed ended before running the three unchanged groups separately; no scenario, assertion or internal timeout was relaxed.

## Independent review

The original separate Pi reviewer inspected the complete 12-file repair diff and the necessary store, Server watch, decoder and browser handoff. It accepted finding 3 at `a8d7df2b`, identifying one non-blocking scalar-enum coercion issue. `cebce442` replaced that coercion with strict equality and added the array counterexample. The single final two-file relook accepted that residue as closed. The reviewer did not implement or run the tests.

An earlier review continuation ended with `upstream_http2_stream_error`; it supplied no final acceptance. The subsequent completed review and final relook are the acceptance evidence. Their session is retained in the implementation worktree under `.scratch/ah162-de-review-sessions/`.

## Limits and main-line effect

This closes AH-179 and the specific D/E finding, not the whole AH-162 candidate review, AH-156 persistent-service platform qualification, J2 adoption, or real Bot/Provider/App E2E. No active Host/modeld, global shim, user Bot, credential, desktop or native data was changed. No push or deployment was performed.

## Integrated-candidate follow-up

After actual fast-forward integration to `526ca59f45806c5587ea629e9fec3789ed804f97`, the original `test/packaging.test.ts` was executed on that exact candidate: seven passed, zero failed, 653 assertions, including a fresh build, real tarball installation in a disposable prefix, and both Node CLI aliases. This supplies current-package execution evidence, not a full current-candidate core/native run.

A new independent artifact/source-binding review invocation was rejected by the tool before execution. No new reviewer was started and no acceptance was obtained; it was not retried through another channel. The earlier completed AH-179 reviews remain valid within their stated scope. AH-162 and AH-122 remain open, with their latest integration and evidence limits recorded in Linear.

A fresh ordinary-user platform observation again found PID 1 `tini`, user-manager status `offline`, and an unavailable system bus for the linger query. The actual default installer remains `systemdUserManager()` and requires a reachable user manager plus linger. AH-156 therefore remains a supported-host qualification gap; restarting Host/modeld does not supply the absent manager. No init or official-supervisor modification was performed, and temporary processes were not substituted for persistent service ownership.
