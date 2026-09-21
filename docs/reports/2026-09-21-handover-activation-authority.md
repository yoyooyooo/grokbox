# Handover activation and last-effect authority

2026-09-21. CONT-09/10 follow-through; bounded source verification, not live acceptance.

The existing handover and convergence programs now require completed create, initialize and activate stages and an exact distinct successor. Requested activation, a target UUID, a top-level phase label or an already retired workflow is not sufficient. Quiet observation cannot begin before that boundary.

The native adapter reloads the original immutable CONT declaration, verifies its digest, and reads fresh source-account ownership and successor managed-Box ownership. It rechecks the management authority after ownership reads and immediately before every native write, including Routine operations. Source ownership alone, stable account scope alone or an earlier permission check cannot authorize an effect after a target or principal changes.

The original per-duty claim and retirement claim remain the only dispatch grants. Revocation at a committed claim prevents dispatch without erasing that unknown declaration or permitting a later retry. Awaited discovery/inspection cannot commit progress after revocation. A persisted item bound to another successor is an integrity failure, not a retargeting instruction.

Verified using declared Bun 1.3.14: root typecheck passed; `bot-lifecycle`, `bot-convergence`, `bot-protection` and the existing native handover HTTP tests passed 26 tests across four files. Tests use real CONT storage and controlled ownership/HTTP sources; no live Bot or Provider is changed. The new management handover entry and evidence-backed attestation/retirement follow separately, consuming these same programs. The unsafe old arbitrary-hash attestation is not an accepted evidence authority.
