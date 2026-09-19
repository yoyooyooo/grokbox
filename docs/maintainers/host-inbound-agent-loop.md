# Host loop: evidence entry points

The former 2026-09-10 map is **unverified for the current native Host**. All three Host/worker hashes cited by it differ from the files inspected on 2026-09-19. Its private evidence placeholders cannot reproduce the historical claims. Old function names, line numbers, compact thresholds and App-renderer conclusions have been removed.

The original text remains in Git at `6f0473d:docs/maintainers/host-inbound-agent-loop.md`; it is investigation history, not a repair recipe.

## Locally reproduced properties

| Question | Reproduction |
| --- | --- |
| Do executor factories share state? | `bun test packages/box-runtime/test/host-executor-state.test.ts`: separate windows; bind/append/clear on one executor leave siblings unchanged |
| Does the managed bridge stream before terminal? | `bun test packages/box-runtime/test/host-fullstream.test.ts`: public Host-shaped consumer through the Unix/runtime path |
| Can a completed empty auxiliary result be a no-op? | `bun test packages/box-runtime/test/auxiliary-empty-output.test.ts`: qualified auxiliary purpose; cancellation remains failure |
| Does send acceptance imply delivery? | `bun test test/outcome.test.ts`: receipt, delivered content, failure and missing evidence remain distinct |

These tests exercise grokbox with owned dependencies. They do not run the complete current native Agent loop or prove App rendering, production tool effects, native checkpoint transactions or restart recovery.

## Questions still unverified

- Current native queue/epoch/retry/settlement ordering, compact triggers and writer exclusion.
- Exact native Memory/episode, blob-root and transcript interactions.
- App routing, Working/typing visibility and remote delivery.
- Historical context loss, its writer and the time of any missing root change.

Qualify the specific native version and affected path before restoring any of those claims. Current investigations start at [execution](../runtime/execution.md), [context](../runtime/context.md), [result observation](run-outcome-observation.md) and [LIVE](../tickets/LIVE-integration-validation.md).
