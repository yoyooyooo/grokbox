# Current recovery and verification entrypoints

2026-09-21. CLI-05 W3 / HCR-03, following the current safety-store contract cut. This remains implementation convergence, not W4 adoption or a release.

## A current operation owns its recovery evidence

The controller and identity operation use the single advisory-gated `operation-lease.node.ts` writer. PID-only parsing/recovery, the old exclusive PID writer and the unused coordinator lease writer have been deleted with their consumers. The obsolete `op-lock.ts` module is gone; the current owner also owns its identity-lock pathname. No refusal-only shim or fallback has been added.

A PID-only footprint is invalid/opaque, even when a tracked disposable process with that PID has demonstrably exited. Neither inspection nor confirmed recovery removes it. A running row without its own captured lease identity cannot borrow a stale controller file at the same pathname to qualify for demotion. Such records remain intact; the current system does not infer that old work stopped or can be reissued.

Current identities still support proven process exit, boot changes and PID-reuse discrimination. Explicit recovery holds controller then identity gates, rechecks file identity, and may only demote the original running record to unknown; it neither signals a Host nor authorizes replay. Owner parsing now validates all own data descriptors before reading even version, rejects inherited/hidden/symbol fields and returns a detached identity before asynchronous process observations.

Four changed counterexamples failed against the preceding implementation: legacy PID recovery, borrowing a stale file for an ownerless running row, accepting a PID-only owner and retaining the caller's mutable owner object. Current positive hard-exit, competing recovery, publication failure and cancellation cases remain exercised. Two earlier lifetime fixtures still fabricated PID-only locks; those were replaced by an actual child calling the current lease writer and exiting without JavaScript cleanup. No timeout or recovery assertion was relaxed. The same fixture now feeds source and installed Node CLI qualification.

## Retire live poisoning, retain the actual diagnosis

The old `verify-ah92-admit-observation.mjs` script directly replaced a selected installation's model document, sent a canary, and restored earlier bytes on exit. It bypassed the current model writer and could overwrite later changes; keeping its CLI switches was not a product requirement. That script and its script-shape-only assertions have been removed rather than rewritten as another live mutation path.

`test/admission-observation.test.ts` now drives the real Host session hook against disposable current or deliberately retired model inputs, waits for the original journal writes, and reads the actual rejection through both the outcome program and repeated fresh packed Node CLI processes. It covers no transcript echo, a null-request-id echo, empty trays, wrong nonce and wrong Bot isolation. There is no synthesized rejection log and no send/create/update request. Native executor/request-id counters remain zero; original configuration and journal bytes are unchanged by all reads. This proves the selected denial and observation chain, not a real account, Provider or App delivery.

## Mainline and evidence boundaries

CLI-05's current status is recalibrated to completed model/Compact/handover management migrations and remaining W3 work, without rewriting historical verification windows. Current observation/recovery guides no longer recommend removed automatic SQLite migrations or PID-only recovery. The staged VOICE planning remains separate, and no active service, global entrypoint, real Bot, model credential or external notification is changed.

The preceding safety-store commit was verified on its own fixed input before this work began. Its publication scanner call was blocked twice by the tool safety-state check and was not rerouted or counted as passing. Functional and artifact verification are separate from that uncompleted scan. The final recovery/verification cut used the same 1,203-input fingerprint `75bb6f27948515b72fcce3fa56f2f73a5acb88a7b5f87d8ce6d40aa9733563f4` before and after both windows: core 1,231 tests / 132 files and integration 27 tests / 20 files, zero failures. The non-overlapping outer total is 1,258 tests / 152 files. Rust's 39 tests, root/Web typechecks, generated protocol, build/installed tarball and relocated Chrome's 79 internal nodes also passed; internal and earlier-window counts are not added. A first core attempt stopped on a new test's missing `{invalid:true}` union guard; the test now narrows the actual journal result, without weakening production parsing. This remains affected-scope evidence, not a whole-repository or new native-source acceptance.
