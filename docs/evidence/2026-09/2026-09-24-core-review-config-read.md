# Core review closeout: native repairs, R boundaries and configuration reads

Date: 2026-09-24. Starting integrated candidate: `c0a85510f1ee6e4a9138e7fb3a95b5b648cec2b3`. Credential diagnostic correction: `f235c54e441d9e8535be918d602632a2cf5d06e7`. Final reviewed configuration repair: `89b00b47b1d040fb94dfb3b8e92d3622662781a6`. This report adds documentation, not runtime behavior. Linear owns scheduling; this is fixed-input evidence for AH-162/AH-122 and the AH-182 repair, not a replacement issue ledger or adoption receipt.

## Completed independent source reviews

AH-181's separate Astra reviewer inspected the entire `92e196d8..c0a85510` range (13 changed files) and the relevant original profile, run/context observation and worker guards. The final report accepted the native repair scope without an established blocking defect. The first reading window timed out; only the subsequent completed same-session final report is acceptance evidence. AH-181 was successfully marked Done. The [native-evolution report](2026-09-24-current-native-evolution.md) retains the exact execution/source bounds; its earlier pending-review statement describes the earlier stage.

Two broad Astra R-adapter review attempts timed out without a final report and were not counted as passing. Separate, non-implementing DeepSeek high sessions then supplied supplementary independent source reviews of three bounded packages:

- R adapter/credentials/overflow/history: the six original files, followed by actual model-schema, step-program and conformance/overflow-test context. The confirmed file-versus-env diagnostic error was corrected at `f235c54e` and accepted on recheck. Four other suggestions were withdrawn after source inspection: the catalog intentionally selects the first readable source; one compact slot must be reserved before the effect; empty credentials belong to the schema-validated echo route, not a parsed network model; and the raw backend stream is intentionally single-consumer. No retry or nonce safety guard was weakened to satisfy a mistaken review suggestion.
- R request/response normalization: all eleven backend normalization, audit, tool-identity, reasoning and failure-classification files. The initial report found no concrete defect but lacked the wiring. A final relook supplied the actual SDK adapter, managed session/hook and validated-tool test. It accepted the inspected source plus those boundaries: final encoded request limits and identity/context checks are applied at egress; the managed Host selects the validated-batch policy and holds executable tool parts until a successful validated terminal, discarding them on failure/abort. Real SDK/provider behavior and the full modeld wire path are not independently qualified by that source review.
- F configuration: five original read/lock/store/publication modules, then the exact changed reader/lock and regression tests at `89b00b47`. Its three concrete concerns were reproduced as four failed assertions and accepted as fixed on the final recheck. Minor diagnostic/error-shape and imported-caller assumptions remain scoped limits, not established new P0/P1.

These are accurately identified as supplementary DeepSeek reviews, not Astra results or independent test executions. Reviewers did not implement the changes. Session evidence remains under the implementation worktree's `.scratch/ah181-current-review-sessions/`, `.scratch/ah162-r-deepseek-sessions/`, `.scratch/ah162-r-stream-sessions/`, and `.scratch/ah162-f-config-sessions/`. No whole A/R/D/E/F/Q candidate acceptance or live authorization follows merely by adding their scoped verdicts.

## AH-182: reproduced defects and original-owner repair

Four deterministic counterexamples used real disposable files, with narrowly controlled syscall outcomes and restored spies:

1. A short read of the valid numeric JSON `12345` was accepted as `1`.
2. An in-place change during a read still returned the previous JSON without detecting input instability.
3. Two separate owner-liveness observations produced `state=live-or-unproven` with `recoverable=true`.
4. A lock disappearing between the failed claim and recovery inspection exposed raw `ENOENT` rather than the typed configuration conflict.

The first run returned zero passing and four failing cases. The bounded JSON reader now reads within the same fixed byte limit to the complete observed size, compares the open descriptor and named file identities/size/mtime/ctime, and uses strict UTF-8 decoding. It still accepts ordinary readable external catalogs, including mode 0644; it does not introduce a private-file ownership requirement. This is a stable-read check, not a lock against future modifications.

The existing lock implementation now samples staleness once for its status fields. A disappearing lock at the initial recovery inspection yields `config_conflict`; it does not delete another owner's file, change the operation identity or automatically replay a write. Original lock creation, nonce-scoped recovery guards, conservative owner checks and configuration publication remain in place.

The fifth new case covers normal readable JSON, symlink refusal, invalid UTF-8, the original byte cap and a missing file. All test-level syscall spies are restored in `finally`; all newly created test directories are disposed. The new test file is part of the formal `verify-host-health.mjs core` inventory. No prior test or deadline was removed.

The separate credential change fixes only the rejected file-reference error noun and a stale implementation comment. Its regression checks that the command text and file path are not included. Credential materialization, pinning, fingerprint verification and release behavior are unchanged.

## Actual verification, with exact input separation

| Executed entry | Candidate and result |
| --- | --- |
| Original full `verify-modeld-core.mjs release-offline` | At `c0a85510`: all 14 original shards completed, 693 passed, zero failed/skipped; fresh build and disposable-prefix tarball installation included. Input before/after `5304264c45f876eb83cb772b53ecdea57412078ebfc2da2843dc424907e2dad5`, 1,320 objects. This preceded the new I/O fixes. |
| Original full `verify-host-health.mjs core` | At `89b00b47`: all 18 commands code 0, no error/signal, settled; 1,583 Bun tests and 39 Rust tests passed. Root/Web TypeScript included. New configuration tests were actually consumed. |
| Final affected cross-regression | At `89b00b47`: 60 outer tests passed across nine files; includes original configuration/lease/credentials/backend/overflow/packed tests plus Node model authorization 24 and message HTTP 36 inside their wrappers. Inner counts are not additional totals. |
| Regression/inventory checks | 21 passed across consistency, shard and inventory tests. An earlier eight-file configuration cross-check passed 38 cases before the fifth new bound/UTF-8 case was added. |
| Final build and checks | Full CLI/runtime/Web build, root/Web types, documentation 16 cases, runtime boundaries and publication privacy passed. |

The final core's before/after source-test-lock digest was `27c29f769ce530ee8d3e65f2c382e2ea1488eac1bd8845be0a71f50f2c322512`, 1,321 objects, stable. Native opt-ins were off for this core run and `qualified=false` remained explicit. The earlier current-native trio and earlier full browser integration are retained under their original source identities, not described as fresh executions on `89b00b47`.

## Persistent-host investigation: a lead, not a qualified owner

This round read the allowed Agent Kit host-ops source and actual user autostart entries. Host-ops explicitly converges a finite service list, and an existing installer uses desktop autostart for a separate service. The actual Dagu worker desktop entry invokes its own Python `--ensure` path. Those observations establish an existing user startup convention, not its boot/rebuild guarantee or suitability as a grokbox service manager.

The platform desktop-start/desktop-supervision script names were located, but opening their system directory was rejected by the workspace root policy. Their contents were not retrieved through another path. Consequently, this round did not verify which process consumes desktop entries, when they rerun, crash ownership, behavior after a container rebuild, or a durable single-instance registration contract. No init, native supervisor or persistent service was changed; the unrelated existing Agent Kit SSH edits were untouched.

AH-156 remains blocked on a supported, actually qualified persistent owner. Existing desktop entries do not justify pretending systemd/linger is available or deploying a second unqualified supervisor. This is not a missing token budget or missing permission to make an otherwise qualified Host/modeld switch.

## Mainline effect and remaining boundary

The new configuration defect is closed by exact source review and executed regression, not by changing product acceptance requirements. AH-162 can consume the AH-181, R and F dispositions, but must still correlate its existing A/D/E/F/Q scopes and fixed artifacts to the final candidate before declaring the entire review complete. AH-122 also retains actual platform/installation and controlled-load obligations. J2/J3/J4, real Bot/Provider/App E2E and daily-use acceptance are not signed by this report.

The user's real-E2E model order and no-artificial-token-cap instruction remain as recorded in AH-124/AH-125. DeepSeek was used here for independent review of public code, not as a grokbox Bot E2E result. No real Bot message, provider call through modeld, actual Host/modeld cutover, user credential change, global shim change, push or deployment occurred.
