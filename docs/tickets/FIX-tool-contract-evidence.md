# FIX · Tool contract evidence

Status: implemented in the current v2 worktree and qualified by offline fixture and synthetic production-path tests. Independent review is pending. No live model, native ABI, deployed Unix peer, or real provider tool execution was run.

## Scope

This fix closes the model/tool auxiliary chain around one explicit request contract:

- the exact tool name and canonical input schema are captured and compared at the request boundary;
- `tool_choice` (`auto`, `none`, `required`, or one named tool) is validated against declarations and observed calls;
- provider, wire, and Host diagnostics retain separate evidence layers;
- identity changes invalidate prior wire/SDK comparisons instead of producing false rewrite evidence;
- structured call history is bounded and payload-free;
- no aliases, old model format, second executor, or provider schema execution were introduced.

The implementation is carried by `runtime-kernel` contract types, `box-runtime` AI SDK/OpenAI/modeld/Host adapters, and CLI diagnosis/projection. The verifier exposes this evidence as the `tool-contract` modeld-core proof case.

## Evidence levels

| Level | Evidence |
| --- | --- |
| Fixture-only | `tool-choice-contract.test.ts`, `tool-declaration-contract.test.ts`, `tool-identity-framing.test.ts`, and `layered-tool-diagnosis.test.ts` exercise the contract and directional counterexamples with fixture-owned streams. |
| Synthetic production path | `tool-contract-integration.test.ts` and `tool-evidence-retention.test.ts` exercise SDK/modeld, disk/Unix framing, Host terminalization, and retained presentation evidence using synthetic capabilities and local resources. |
| Real SDK/Unix/storage/process | The tests traverse production adapters and journal/transport seams, but use deterministic local fixtures; they are not live provider, native ABI, or deployed-process qualification. |
| Live/native | Not run. The R1-I/live model/native gate and independent review remain open. |

## Absorbed execution branch

The current v2 tree already contains the bounded settled-step reclaim and matching counter/reclaim coverage in `runtime-kernel/src/internal/inference/step-program.ts` and `execution-cooling-review.test.ts`. The hot-ledger branch was therefore absorbed by semantic parity rather than blindly merged; no second executor or old ledger format was added.

## Verification

Passed offline in this worktree:

- `tool-choice-contract.test.ts`: 8 passed
- `tool-declaration-contract.test.ts`: 24 passed
- `layered-tool-diagnosis.test.ts`: 26 passed
- `tool-identity-framing.test.ts`: 9 passed
- `tool-contract-integration.test.ts`: 26 passed
- `tool-evidence-retention.test.ts`: 4 passed

Remaining blockers are the independent review, live model/provider execution, native ABI qualification, and deployed delivery proof.
