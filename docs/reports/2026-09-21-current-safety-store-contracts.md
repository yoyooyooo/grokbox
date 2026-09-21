# Current safety-store contracts

2026-09-21. CLI-05 W3, with OBS-01/04, CONT-02 and T45/T53. Continues the accepted destructive rebuild in the existing management branch. This is not W4 candidate acceptance, a native account qualification or permission to reset an installation.

## One current contract per owner

Observation SQLite accepts only its current metadata and physical header version 4; CONT accepts version 4; Routine provisioning accepts version 3. Normal reads, initializers, background maintenance and mutations no longer upgrade older schemas or manufacture absent records from missing older tables. The original owners, databases, transaction boundaries, effect identities and native adapters remain in place.

The OBS v1/v2/v3 migration, backups and PID-only migration-lock recovery have been deleted. CONT no longer adds historical request/result columns or reruns workflow DDL on an existing owner. Routine writes no longer add tombstone or state-operation tables, and older stores cannot report a missing current operation as permission to dispatch. Current initialization is a read-only identity check, not a collector restart. OBS and CONT check contract identity again inside the transaction that consumes it, not only before acquiring the transaction snapshot.

Old files, credentials, acknowledgements, original unknown effects and foreign lock footprints remain untouched. Their preservation is not live compatibility: unsupported data is unavailable through current domain APIs, not interpreted as an empty successful store. Opaque foreign owner footprints can block writes but are never parsed or stolen. This work does not remove the separately accepted explicit general-configuration import capability or authorize removal of historical/user data.

The shared observation DTO and production page no longer carry a migration-required placeholder. Invalid storage is a source error, not a UI prompt to invoke an upgrade the current product no longer implements. Maintenance receipts likewise reject the retired migration-required state.

## Lost observation history is not a new installation

A separate regression reproduced a safety defect: removing the canonical observation database while retaining its directory allowed initialize to create a replacement database identity. The store also holds notification attempts and management receipts, so silently recreating it is not harmless index rebuilding.

Only the creator of a new private owner directory can publish the first database. An existing directory with a missing ledger is unavailable, including an empty interrupted owner. First publication uses a private staging database, exclusive publication, directory-identity checks and directory synchronization. An orderly failure before publication may clean only its own staging file and empty directory; cleanup is nonrecursive and preserves foreign entries. Reopening a valid current database does not run publication hooks or change the current collector. Concurrent initializers cannot publish competing histories. This does not claim recovery from arbitrary whole-installation rollback or deletion of every identity footprint.

## Current notification consent only

The private binding owner consumes only v2 explicit-enable authorization. Historical v1 tested-consent records are not normalized, used to send or silently renewed. Optional testing stays independent of enable; current revocation, ongoing native/model/ownership checks, spending limits and original-attempt recovery remain unchanged.

Negative tests also reproduced two parser flaws: the version getter ran before descriptor validation, and an inherited grant could validate but clone into an empty object. The current parser checks exact own data descriptors before reading any field, rejects symbols/hidden fields and detaches the accepted document. A real private-capsule regression retains the old bytes and verifies zero additional native reads, HTTP sends and attempt reservations, even with new work available.

## Verification boundaries

Counterexamples were exercised before the implementation changes: older ledgers were accepted, a current-looking OBS metadata row bypassed its physical header, old tested consent was accepted, and lost OBS files were recreated. An initial test used a nonexistent storage method; it was corrected to the actual storageHealth method and is not counted as a product defect. Actual preceding DB layouts are also reconstructed in owned fixtures, not only version-number mutations.

The first expanded core run passed 1128 tests. Its integration run passed 26 of 27 wrappers; the sole failure was an old receiver test still expecting migration-specific behavior. That test now checks the current rejection through actual management HTTP while preserving a recorded live collector. No production schema gate, assertion or test timeout was relaxed. The complete rerun is recorded below; the earlier failed receiver expectation is not counted as a passing run.

Tests use disposable files, original SQLite/CONT/Routine owners, real Node HTTP, packed CLI/Server processes, synthetic native facts and loopback notification responses. Production Chrome and tarball installation validate current consumer/artifact integration, not actual Provider/App delivery. This batch does not publish/load a Host profile, call a real model, send an external notification or change active services/global entrypoints.

## Fixed-source closure

After re-reading the actual owner changes and all pending consumers, both expanded windows completed on the same 1,204-input fingerprint `48e1ca6bc4a2e2afc0ef01a2da2c5aac656feaa5ef0a9448c3a9f995944252a6`: core 1,129 tests / 124 files and integration 27 tests / 20 files, zero failures. These non-overlapping outer suites total 1,156 tests / 144 files. Rust's 39 tests, protocol generation, root/Web typechecks, tarball installation and relocated production Chrome (79 internal nodes) passed; wrapper-internal Node/Chrome counts are not added to the outer total. This is an affected-scope check, not a whole-repository final candidate or a new native-source qualification. The current staging of unrelated VOICE planning is preserved separately.

Remaining W3 work includes old command/daemon consumers and full material/resource pathways. Complete Host capability coverage, resource-independent restoration, native retirement conditions, independent notification delivery, installation qualification and concentrated real acceptance remain with their original tickets. Previously closed Compact/handover management migrations are not reopened.
