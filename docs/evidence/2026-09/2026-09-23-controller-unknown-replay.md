# Controller unknown replay boundary · 2026-09-23

## Fixed source and reproduced failure

Base: `5b30cb6fc2c2c1a6e8c9c86bbc2b6abee71bcff8`.
Code: `4c170952471913a945c3f4090c54452b0edc1cb8`.

The former production lease used a current unique official process census to
re-acquire a stored unknown operation. Four formal tests ran the original
filesystem lease and kernel controller with counted, non-effectful mutation
ports. All four failed before repair: direct and transient commands reached
signal/spawn and commit, with both true and false previous effect prefixes.
No real Host, supervisor, Bot or Provider was invoked.

## Repair and contract

The original lease now returns uncertain for the same unknown fingerprint,
before rewriting the row or reaching any mutation port. The original row and
prefix remain byte-identical across repeated attempts and new runtime instances.
The census-only recovery helper and its partially injected census seam were
removed, not retained as alternate execution paths. Read-only Host observation
still supports its existing observation ports. Fresh, terminal, conflicting,
running and reserved operation handling are otherwise unchanged.

Metadata recovery may still demote proven interrupted owners and remove proven
stale locks, but cannot authorize replay. Its follow-up now points to status,
not another apply of the same unknown request. A distinct future operation
requires its own verified target and authorization; changing IDs is not recovery.

The old tests that expected census-only re-acquisition encoded the disproven
assumption. They were replaced by actual original-row preservation tests,
plus direct/transient no-effect regressions; lock/cancellation tests remain.

## Verification and review

Declared Bun 1.3.14. Controller and recovery checks: 47 pass. Direct cross-domain
checks: 127 pass in 11 files, no failures. Build, root/Web typechecks, docs,
runtime boundaries and publication checks passed. These test counts overlap.
A fresh source-only reviewer accepted the fixed AH-173 scope; reviewed source
and test hashes were rechecked before delivery. Review did not execute tests.

R1's separate fixed-source review covered STEP/TURN admission, persistent dedup,
final dispatch gates, stream cancellation and provider recovery, with no blocker
found. Six corresponding original test files passed 67 cases on base 5b30cb6f.
That does not qualify unreviewed backend adapters, compact or live Provider IO.

## Remaining controller boundary

AH-174 tracks the separately reproduced observed-adoption shortcut that can
write attestation while another identity lease is held. This report and AH-173
acceptance do not close that finding or sign whole-controller, AH-162 or LIVE.
