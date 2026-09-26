# Observed adoption commit lease · 2026-09-23

## Reproduced original failure

Original reviewed source: `5b30cb6fc2c2c1a6e8c9c86bbc2b6abee71bcff8`.
AH-174 code: `bff16d975333064c8d480e8089dc1a03ffb747fd`, based on integrated
AH-173 (`8f675d0c`), not an unmerged sibling implementation.

The original private commitObservedAdopt function was extracted from that exact
source and executed in an isolated VM with synthetic compile/process/source
observations, the real Linux identity lease and the original file writers.
While another owner held the same run-root identity lease, it returned ok=true,
wrote attestation and an attested journal. No Host or supervisor signal occurred.
This proves a missing cooperative commit lock, not a live account incident.

## Original owner repaired

The observed shortcut now holds the existing operationLockPath identity lease
from the first observation through journal/attestation writes and readbacks.
The controller lease does not substitute for that identity lease. The captured
Host, supervisor, marker, profile, preload, source and Gateway observations must
still match after awaited modeld readiness and after original writes. Readiness
must be observed before a route attestation can be reported as committed.

Only an absent reusable generation returns null and permits the caller to use
the existing full adopt path after releasing the lease. A failed receipt,
including lock conflict or release uncertainty, cannot fall through to a new
adopt. The normal transient path retains its own sequential identity lease;
there is no nested acquisition, second writer or supervisor.

Writes use the original attestation/adopt journal functions and original marker
operation identity. A written attestation is retained in a failure receipt when
later readback or identity checks fail. Release failure overrides success.
This is a cooperative lease and observed consistency boundary, not atomicity
against arbitrary official clients or manual filesystem changes.

## Fixed validation and independent review

Declared Bun 1.3.14. The original controller-generation entry passed 23 cases:
its previous eight cases plus fifteen new Linux-lease/original-writer cases.
The new cases cover held locks, stable commit, no reusable generation, seven
kinds of observation drift during await, unready modeld, lock ownership during
await, drift after persistence, journal mismatch and uncertain lock release.
Native observations are synthetic; filesystem writes and Linux leases are real.

The fixed code then passed 150 cases across thirteen controller/lease/recovery/
identity/Host-stop/CLI test files, no failures. Build, root/Web types, docs,
runtime boundaries, publication and diff checks passed. Counts overlap.
A fresh reviewer accepted the observed-shortcut scope on exact bff16d97;
reviewed source hashes were matched before documentation and integration.
The reviewer did not execute tests or approve live adoption.

## Claim limits and remaining work

AH-173 unknown-no-replay remains intact. The two earlier controller findings
are closed in their respective scopes, but whole AH-162 source/artifact review
and AH-156 actual service-manager qualification remain separate. No real Bot,
Provider, Host/modeld, Chrome profile or global shim was changed here.
The pre-existing census receipt shape is not an independent wrapper census
proof, and unprovided full native adopt internals are not signed by this review.
