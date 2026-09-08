# Retired POC inference oracles

Extracted from T20 layout cut. These vectors are **not** activated tests and must not be counted as passing product behavior.

| Oracle file | Source tests | Activate in |
|---|---|---|
| `inference-oracles.json` | `modeld.test.ts`, `modeld-as1.test.ts`, `modeld-default.test.ts`, `modeld-openai.test.ts`, `modeld-confluence.test.ts`, `seam`/`stub-route`/`t11`/`turn-seam` | T23, T24, T25, T26 |
| `overflow-oracles.json` | `provider-overflow.test.ts` | T32 |
| `start-modeld-cli-oracles.json` | `test/runtime-cli.test.ts` start/modeld cases | T25, T26 |

Do not rewrite these as `expect(runtime_not_ready)` and claim the original product behavior is proven.
