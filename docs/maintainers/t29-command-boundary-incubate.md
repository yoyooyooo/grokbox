# T29 command/API boundary incubate

**Not the default post-T28 chain. Not a browser MVP. Not a second SoT.** Owner allowed this parallel incubate; [T29](../tickets/T29-runtime-webui.md) still forbids treating it as the next construction ticket after T28. Console/browser/Playwright stay unauthorized here.

## Inventory (current tip)

| Surface | Exists | Honest gap |
|---|---|---|
| `kernel/commands` | Yes — controller admit/run/fingerprint only | No configuration save use case yet |
| `kernel/status` | Yes — facets, correlation, journal roles | Future API must consume this, not a console projector |
| `ConfigurationWrite` **port** | Yes — `saveModels`/`saveDesired` → `{ configRevision }` | No live Layer; modeld graph correctly lacks this port |
| Config IO | `openRuntimeStore` atomic tmp+rename; `configurationReadLayer` | Returns `void`, no expected revision, no short lock |
| CLI runtime | `packages/cli/src/commands/runtime.ts` via runtime facade | Not yet a second writer; do not add UI-only lock |
| Box identity | Controller `boxRoot`; durable root resolver | Command-boundary agentId/runtime-root refuse-remote not a T29 CAS |
| `console/` / `console.runtime.ts` / `runtime-roster.ts` | **Absent** (required) | Do not scaffold for this incubate |

## D6 / CAS timing

[ADR D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer): keep the single-writer path simple. **Do not implement shared CAS until a real second writer exists.** When it does, add short lock → canonical reread → expected `configRevision` → mutate/publish **on the same ConfigurationWrite entry**, CLI included. No revision DB, no UI-only lock, no SQLite SoT.

This incubate does **not** add that CAS. Atomic rename is not concurrency-safe publication.

## Next (when actually scheduled)

1. Configuration use case on `kernel/commands` over the existing port.
2. CAS only with a real second writer.
3. Browser MVP only under a separate owner authorization.
