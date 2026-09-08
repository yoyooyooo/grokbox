# Retired POC oracles

Extracted from T20 layout cut. These vectors are **not** activated tests and must not be counted as passing product behavior.

| Oracle file | Source tests | Keep / drop | Activate in |
|---|---|---|---|
| `p1-canary-oracles.json` | `p1-canary-safety.test.ts` | **Keep** tool-id correlation, no fake tool name, 401 off IPC, pin rotation zero fetch, FIFO bounds, turn pin isolation | T21, T23, T24, T25, T26 |
| `inference-oracles.json` | `modeld*.test.ts`, seam/stub-route/t11/turn-seam, confluence cancel/restart | Keep selective route, duplicate/conflict with barriers+dispatch counts, generation replacement abort, restart no re-handshake, bounded disconnect/stop. Drop complete-array, v2 server, StubRouteDriver, EOF-success | T23–T26 |
| `overflow-oracles.json` | `provider-overflow.test.ts` | Keep 401/429/too-large are not confirmed overflow | T32 |
| `start-modeld-cli-oracles.json` | `test/runtime-cli.test.ts` start/modeld | Drop stub Unix start; keep not-ready composition | T25, T26 |
| `control-cli-oracles.json` | `test/runtime-cli.test.ts` re-adopt/watchdog | Previous receipts for T28; current public path is runtime_not_ready | T28 |

Do not rewrite these as `expect(runtime_not_ready)` and claim the original product behavior is proven.
