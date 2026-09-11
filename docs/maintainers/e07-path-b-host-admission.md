# E07 Path B Host admission residual

**E07 stays `auxiliary_unqualified`.** Path B grokbox aux request-kind exists (`grokboxAux` + parent binding). Live Host memory/episode call sites still stream with no STEP and no purpose. This page is not D2 approval and not an E07 pass.

## What is qualified offline

- grokbox admits `memory-extraction` | `episode` only as adapter-trusted `grokboxAux` (not message body).
- `attachHostAuxStreamContext` is the fail-closed Host-facing wrap: bad purpose, missing parent, or aux id equal to parent STEP → leave ctx unchanged.
- Unpatched synthetic Host extract/episode call sites emit no `grokboxAux`.
- `LIVE_SLICE_PATCHES` remain create-session / agent-id / compact-register / activity-bridge. No aux-purpose live slice.

## Blocker (needs D2, not this slice)

Fixed Host profile must carry purpose from the real memory/episode getExecutor/stream sites (continuity F5 / H:751873–751931 class) through the usage wrapper. That is a new Host slice + schema/validator approval. Do not guess purpose from prompt text, missing STEP, or executor count. Do not add an aux-purpose live slice without that approval. `activity-bridge` is unrelated (composer `currentActivity`).

Until then: no-STEP Host streams stay official passthrough; `runAuxiliary` is grokbox-test/Path B only; continuity B stays open.
