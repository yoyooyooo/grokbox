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

The subsequent cut in this same stage removes older model document versions from normal runtime parsing and migrates positive fixtures to the current format. Keeping original model bytes during general configuration migration is data preservation, not permission to consume an old model schema. Final fixed-source checks are recorded below when completed.
