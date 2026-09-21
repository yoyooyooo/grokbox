# Model-domain convergence

2026-09-21, CLI-05 / CONT model-selection follow-through. Continues the existing management branch, without restarting Compact or handover work.

## One selection transaction and receipt owner

The native lifecycle model stage now captures an immutable child request in the existing CONT control record and calls the same `runModelChange` / `ModelConfiguration` program as management HTTP. Installation and originating principal are bound to the original workflow; protection uses a bounded, scope-specific internal caller. No new selection writer or operation database exists.

The former `changeRuntimeModel` program, its public exports and old `models migrate` command are removed. Ownership, catalog validation, reasoning, reset semantics and physical CAS remain in the current model-domain admission and writer. Tests formerly calling that selection program now exercise explicit requests through the current program, real receipt/lock storage, and the production admission adapter. Credential/catalog import is a separate capability and has not been deleted.

A lifecycle continuation cannot infer historical publication success because current content matches the requested model. The regression executes the real model writer, loses its publication acknowledgement, then repeatedly reenters the lifecycle stage with matching bytes: its original model receipt remains unknown and there is one publication attempt. A later user reset also cannot authorize replay. A successful original receipt is history only and cannot restore a selection changed by the user. Approval cannot adopt a newly read revision after an intervening model edit.

Actual installation, target, child UUID and model plan changes are rejected. Former selection-only CONT declarations remain intact but cannot acquire a new current-domain request. Admission checks the lifecycle authority and model definition before and after awaited ownership/catalog work. Captured in-flight TURNs retain their existing model; model changes affect subsequent input only.

## Verification and next cut

The current-domain/lifecycle tests use disposable local stores and synthetic native ownership. The existing model-switch pipeline continues through actual Host hook, Unix modeld, kernel and SDK boundaries, with isolated provider responses and an owned native object. These runs are not production adoption or a real account/Provider round-trip.

The first commit was checked with root typechecking, 72 focused tests across seven files (including the actual clone/spawn owner/worker integration), the 18-scene management lifecycle and 24-scene protection Node combinations, and 15 documentation/command checks. An initial reasoning fixture failed because it inserted an undefined property into a normalized model; the fixture now omits the absent field rather than changing canonical hashing or accepting an invalid document. No failed run is counted as the passing window.

## Current-document cutover

The normal parser now accepts only model document v3 and object assignments. The v1/v2 normalization branches and the local `contextWindow` alias are deleted. `contextWindowTokens` remains the canonical field; the explicit Pi adapter continues to translate Pi's own input without adding a second grokbox model grammar. Five direct tests cover parser/store/Host/CLI refusal, current label readers, captured TURN preservation and independent operation lookup. The original four tests failed against the preceding source before the compatibility branches were removed.

Positive fixtures now declare current model documents across actual modeld, Host, SDK, authority, context, lifecycle, credential, CLI and label consumers. Other domains' version numbers and negative protocol cases are not changed. Older model documents are retained only as explicit refusal or data-preservation inputs, not wrapped in a fixture migration helper. Malformed capacity, provider, credential and assignment tests use the current version so they continue to reach the intended validator instead of passing at a schema-version gate.

General configuration migration no longer borrows model parsing to describe a preserved file. Its existing bounded/no-follow/strict-JSON capture and byte-digest checks still protect the separate document, and its preview now reports `modelValidation: not-performed`. Tests preserve original v1/v2 bytes across interrupted migrations, then verify ordinary store and Host readers refuse them. An unknown version also remains preserved without acquiring runtime qualification. No automatic converter, model migration command, new operation store or source-data deletion was introduced.

An expanded run found five CLI label failures. A direct read at the fixture boundary exposed `config_invalid` for an unprotected file: those fixtures omitted the file mode and depended on the runner's umask. The fixtures now explicitly create private files and validate a current input through the actual store before label painting. Production file protections and title assertions were not relaxed. A separate test ensures unsafe or retired documents cannot clear an existing label. The added label test initially assumed an implicit builtin assignment was a catalog row; its fixture now declares that row explicitly, rather than changing label resolution.

This cut closes model-document live compatibility, not every remaining compatibility surface in the repository. Current shared model/CONT operations remain unchanged; other daemon capabilities, native materials and full Host qualification still belong to W3.

### Fixed-source verification

All three final windows used 1202 source/test/toolchain inputs with digest `c9736459cb334f8d3702a9d55b28317d0be6475434de1ef8343ee1c989df6665` before and after execution. The changed-test window passed 493 tests across 63 files, including 12000 STEPs in one TURN and 4096 TURNs across eight fixture Bots. The expanded core window passed 988 tests across 112 files; integration passed 27 wrapper tests across 20 files. Core and integration are disjoint (1015 total); the changed-test window overlaps them and is not added to that total.

The integration wrappers ran real Node/HTTP/SQLite and packed CLI/Server, including 79 production Chrome nodes against relocated Web artifacts, plus build, tarball install and packaged Rust/FD checks. Rust's 39 tests, protocol generation consistency, root/Web typechecks and 15 documentation/command checks passed. Internal Node and Chrome scene counts are not added to the wrapper totals. No real Bot/provider call, external notification, active service switch, exact-source native-pair rerun or full-repository release sign-off occurred in this cut.
