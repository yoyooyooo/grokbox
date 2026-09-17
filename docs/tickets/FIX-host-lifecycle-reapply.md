# FIX — Host stop/start reapply identity and truthful lifecycle receipts

Status: repair implemented at `338cf83`, rebuilt preload pin at `fe05442`; scoped offline qualification passed, independent review unavailable; native revalidation pending. Discovered by the authorized 2026-09-17 integration window on the v2 code candidate `7994b92`; documentation-only integration tip `02a6d81`.

## Observed failure

A completed custom Host apply was followed by a successful return to the official Host. Starting the identical profile/preload again reused the original controller operation ID. The durable controller correctly returned its old terminal duplicate without another mutation, but the CLI incorrectly reported `outcome=started`, `actual=official`, `next=none`.

The defect has two owners: the CLI's apply identity omitted the observed Host lifetime, and its lifecycle success projection did not require the requested postcondition. Deleting the operation ledger, using random IDs to bypass an unknown operation, weakening the running-Bot guard, or changing artifacts only to defeat deduplication are not fixes.

## Repair contract

The explicit apply composition root obtains a read-only, bracketed census of the unique Host and supervisor, verifies the Gateway PID and both current process identities, and binds the operation key to their PID/start/UID tuple plus the existing artifact digests. Repeating the same observed lifetime remains the same key; a verified subsequent Host lifetime permits a distinct operation on unchanged artifacts. Missing, ambiguous or changing identity refuses before desired configuration is changed. This observation is a deduplication scope, not a replacement for the controller lease, source/profile admission, process recheck or existing unknown-operation recovery.

After start/restart/stop, the operator must observe the requested actual channel before emitting a successful lifecycle result. Failed postconditions return `host_mismatch`, `grokbox doctor`, and the originating operation ID when available. An old terminal receipt alone is not success. Stop's official-channel observation does not require a match to the now-unused patched profile, so profile drift cannot trap the user in custom mode.

## Proof

- Same-artifact start → already-started → stop → start → already-started performs exactly two applies with two lifetime-bound IDs.
- An old duplicate receipt while still official fails both start and restart rather than reporting success.
- Missing generation refuses without a desired-mode write or apply.
- Same-lifetime observation is stable; PID reuse, changed process start and a later Host lifetime change the key. Missing/duplicate census, discovery drift and process-inspection drift return no key; observation never signals.
- Existing source mismatch, running-Bot, lease, unknown operation, prefix persistence and duplicate-operation tests remain required.
- The actual repeated same-artifact stop/start and next fresh canary are owned by the dated [LIVE window](LIVE-integration-validation.md); source tests cannot close that native oracle.

Qualification receipt (2026-09-17): typecheck passed; control/operator suites 73/0; rebuilt artifact and packaging suites 12/0; read-only pinned native-source lane 28/0. The first repair full-suite run returned 2195 pass / 6 skip / 1 failure: the committed preload pin still described the pre-repair source provenance. The pin was explicitly updated to the repeatable rebuilt artifact (`0d31637d0524acaffab59b1d8da75244badedbf61bdeaced0a0ab61a84718ffd`), without weakening the E09 assertion, and both packing and old-artifact rejection tests passed. A fresh aggregate run remains to be recorded.

A bounded, no-tools/no-extensions/no-session independent reviewer invocation against the fixed source patch returned HTTP 503 without a report. The requested Astra/max reviewer did not execute source tools or live operations; the prescribed Herdr transport was unavailable. This is `review_pending`, not an independent approval or a reason to label all live checks passed.

Independent review remains a separate obligation. Do not treat a reviewer transport failure, implementer inspection or an authorized maintenance repair as broad production release qualification. No source worktree may adopt the live Host before its repair is integrated into v2.
