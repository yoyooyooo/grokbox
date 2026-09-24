# Core candidate: review binding and current integrated regression

Date: 2026-09-24. Base reviewed candidate: `bde9783d87a7adfa9f4ebf83e4498a14d9dae276`. Fixed implementation/test candidate: `101e77be9a8faefc5402eacbf279d0e666fd2fdf`. AH-180 owns the receipt repair; AH-162 owns complete-candidate independent review; AH-122 consumes integration evidence. This report is documentation only.

## Confirmed receipt defect and bounded repair

The original `validateReceipt` accepted a well-formed independent review whose tip was unrelated to the declared candidate. Replacing only `review.tipCommit` in the existing positive test produced `eligible` and `indexEligible=true`. The original test command then returned six passing cases and one failure. This demonstrated a validator eligibility error, not an observed deployment, malicious artifact or native execution bypass.

The original validator now keeps that receipt structurally readable but reports `structural-only` and `REVIEW_CANDIDATE_MISMATCH`. An accepted review tip must equal the declared candidate source commit. Hexadecimal case does not change identity; the review base may precede the tip. Reusing review for a documentation-only descendant requires a reviewer to check the diff and record the final tip, rather than setting another unchecked applicability Boolean. Existing fixture, self-review, missing loaded identity, unknown, cleanup and authorization requirements remain intact. The checker still grants no adoption authority and does not authenticate evidence declarations.

Tests cover a foreign review tip, a changed candidate with the old review, and matching tips with different hexadecimal case. Three real Node `receipt --file ... --json` invocations exercise those cases and verify that the LIVE index remains byte-identical. The temporary receipts contain synthetic declarations; they are not native evidence.

## Actual independent source/artifact review

A separate Pi reviewer, which did not implement the candidate, completed a read-only review at `bde9783d`. The earlier two bounded execution windows timed out without a final report. A subsequent final-report continuation returned an actual conclusion from the already inspected source:

- Packaging and preload verification mechanisms accepted within the inspected scope. Packaging installs the archive produced from the explicit checkout into a disposable prefix; the preload checker compares captured bytes with an in-memory source rebuild and rechecks input stability.
- Receipt candidate applicability required the correction above. No automatic deployment or P0/P1 was established.
- The Rust build cache assumes trusted local build output. Source ID, binary/notices hashes and the supplied manifest establish internal consistency, not an independent rebuild. The production client additionally checks the build-injected digest/identity and handshake. No evidence established an untrusted cache intake or an ordinary old-binary relabelling bypass, so this remains a non-blocking trust limit.
- Public preload/Web/Rust metadata were inspected; 62 Web entries matched their recorded sizes/hashes. Installed dependency metadata was checked, not every transitive dependency's contents or full installation reproducibility.

The reviewer actually inspected the requested build/provenance/preload/receipt scripts and packaging/preload/receipt tests, plus necessary Web manifests, verifier client/build metadata, CLI entry/root resolution, runtime helpers, verification-source and evidence-controller call sites. Some larger verification/external helpers were read only in bounded excerpts. This is not a claim to have reviewed all A/R/D/E/F/Q implementation.

The exact review session is retained in the implementation worktree under `.scratch/ah162-artifact-review-sessions/`. The attempted repair recheck at `101e77be` was blocked by the tool before execution; no recheck acceptance exists, and the denied call was not retried through another channel. AH-180 has not earned Done even when its tested code is integrated; final independent recheck remains pending. Neither its implementation nor the broad regression below closes AH-162 or J2.

## Complete current-source core and integration execution

All runs below used the declared Bun 1.3.14, the original inventories and original internal budgets. Native opt-ins were explicitly off. Every verifier's before/after source SHA-256 was:

`3e59a02fbe3c74b366abbbc0f18457e4a199241db04be930742b54b0c64c39d1`

The captured inventory contained 1,320 source objects. Every listed command returned code 0, error null, signal null, settled true, and stable true.

| Original entry | Executed result |
| --- | --- |
| `node scripts/verify-host-health.mjs core` | All 18 planned commands completed: 1,573 Bun tests and 39 Rust tests passed; root/Web types included |
| `node scripts/verify-host-health.mjs integration-host` | 6 outer tests passed; actual packaged Rust/preload against public synthetic native inputs |
| `node scripts/verify-host-health.mjs integration-domains` | 18 outer tests passed across 17 files; original HTTP/SQLite/files/processes and controlled native capability fixtures |
| `node scripts/verify-host-health.mjs integration-web` | 10 outer tests passed: all three original browser windows (console 56, state 39, host 9; zero failures/skips) and seven package tests |
| `bun run build` | Full CLI/runtime and Web client/SSR build passed before integration runs |
| `bun run check:docs`, runtime boundaries, root typecheck | Passed on the repair before the aggregate runs; documentation is checked again before committing this report |

The three integration groups are the existing disjoint partition of the original integration inventory, not a reduced substitute. Their outer total is 34. Inner Node/browser counts are contained within these wrappers and must not be added again. All four verifier results explicitly retained `qualified=false`, `nativeWindow=null`, and no native qualification claim. No current live Host/worker pairing, Provider, App, service restart or 24-hour qualification was performed.

## Remaining actual gates

AH-162 still needs the repair's independent recheck and a bounded complete-candidate conclusion for remaining source scopes. AH-122 must still correlate the applicable current native qualification and fixed installation with its final candidate; the new offline results do not replace that evidence.

AH-156 remains a platform qualification issue, not missing authorization for a Host/modeld switch. The observed process tree is `tini → pod-daemon → sand-exit-watch`; the implemented installer consumes `systemdUserManager()` and requires actual manager/linger qualification. No qualified replacement boot owner has been established in this work. An attempted read of a separate host-ops repository was outside this workspace's allowed roots and was not obtained through another route; this does not establish that the platform has no possible extension point. No init, supervisor, service, global shim, credential, desktop or user Bot was modified.

The next live step remains the J2 decision followed by controlled adoption, not automatic deployment of this commit. No push, release or user daily-use acceptance is implied.

The final Linear status/comment update invocation was also blocked before execution. The proposed In Review state and AH-162/AH-122 comments were not published by that invocation; their prepared text remains in the implementation worktree. The repository records completed integration and checks without claiming that the external issue status was successfully updated.
