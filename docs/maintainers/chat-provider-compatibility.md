# Chat provider compatibility and tool-identity diagnosis

## Ownership and supported dialect

The Host owns tool execution, approvals, user delivery and subsequent model STEPs. The backend owns one provider request and protocol adaptation inside its existing Effect Scope. No SDK tool executor, model-driven repair, automatic task replay, second response reader or provider-specific execution ledger is introduced.

`openai` and `openai-chat` remain Chat Completions protocols. The optional model field `chatDialect` selects `standard` or `minimax-inline-v1`; it participates in selection revision, and a changed explicit dialect cannot silently replace a pinned selection. Only the exact HTTPS origins `api.minimaxi.com` and `api.minimax.io` with `/v1` or `/v1/`, no credentials/query/fragment, receive the MiniMax default. An explicit `standard` opts out. A proxy requires an explicit dialect; names containing “minimax” do not qualify. Responses does not accept this Chat-only field.

The MiniMax dialect requests `reasoning_split: false`. It classifies the initial `<think>...</think>` block as reasoning while retaining its exact markers and text in ordered assistant history. Ordinary user delivery consumes only answer text. The Host text-to-delivery fallback now appends a delivery projection instead of erasing the assistant history. When the actual text-tool schema unambiguously admits boolean `end_turn: true`, that final fallback sets it rather than forcing another model step. The recognizer fails closed for references, conditional/unknown constraints, and ambiguous union branches; it is not a second JSON Schema validator. It never invents this capability for an older Host.

Separated reasoning is not half-supported: nonempty or malformed `reasoning_content` / `reasoning_details` in this inline dialect is `unsupported_provider_state`, not silently dropped data. An unterminated initial think block is rejected before tool authorization or successful completion. Supporting opaque split state is a separate end-to-end history/Host contract, not a request-body toggle.

MiniMax documents both formats and requires complete assistant history, including tool calls and thinking content, for multi-turn tool use:
- https://platform.minimax.io/docs/api-reference/text-openai-api
- https://platform.minimax.io/docs/guides/text-m3-function-call

## Empty continuation fields are not new tool identities

A qualified live MiniMax stream can contain `tool_calls[].type: ""` on a later argument fragment. The pinned OpenAI SDK rejects that field because its schema accepts `function`, null or absence. The dialect omits **only** an empty type on the same index after an explicitly typed function with a valid known id/name. The original frame is audited before transformation. Arguments, tool ids and names are not repaired. First-call empty types, nonempty wrong types, changed identities and undeclared names remain errors.

An empty `finish_reason` is omitted before SDK parsing so it cannot overwrite a preceding real terminal. It never grants completion: the raw finish audit still records every empty field, conflicting or unknown reasons remain rejected, and missing terminal / incomplete arguments cannot be promoted to success. Standard Chat retains its original strict bytes.

The existing incremental SSE parser performs the transformation after audit; there is no tee, background drain or second parser. Original byte budgets and UTF-8 validation remain in force; request budgets are checked before dialect parsing and after encoding. Reframing preserves every line of multiline SSE data, including unchanged JSON frames and byte-fragmented UTF-8. Rewritten framing drops content-length/encoding headers. Cancellation releases the same owned response reader. SDK raw-part counts and post-adaptation part counts are distinct.

## Completed empty auxiliary results are not failed main replies

The pinned native memory parser treats complete blank text as no additions/removals, and its episode consumer treats it as no narrative. An inference-only, qualified `memory-extraction` or `episode` STEP may therefore finish with blank answer text, including when reasoning was present. The Host records `auxiliaryEmptyCompletions` and returns the original completed stream without inventing a sentinel, message, tool call or memory fact. The auxiliary outcome adapter reports `kind: empty`, not a fact-bearing `ok` or a failed stream.

This is a purpose-specific native consumer contract, not MiniMax-specific permission to accept empty output everywhere. Main/unqualified output, tools on the auxiliary request, malformed/mismatched parent identity, missing finish, cancellation and partial/error streams retain their existing rejection/failure rules. The trusted purpose comes from the admitted Host call site, never prompt text. The native Host remains the only memory writer.

A main reply may precede post-turn memory/episode work. Requery the same send after the Bot settles and inspect auxiliary terminals separately; an early `expected_result_observed` can later coexist with a real auxiliary failure. Do not declare whole-run success at the first reply.

## STEP tool choice and validation scope

A returned call must match the frozen declaration and this STEP's `toolChoice`. Omitted/`auto` allows any declared name; `none` rejects all calls and disables synthetic SendToUser delivery; a selected name rejects other declared names. `required` and a selected name require a real completed call before successful completion. Errors, cancellation and unfinished parameters retain their original failure, and required with no tools is invalid before dispatch. `tool_choice_mismatch` is not retryable; generation parallelism is a separate preference.

`toolValidationScope=structure_only` limits the claim to name/choice, call identity, complete JSON and matching fragments. It does not prove native argument-schema semantics, permissions, approval, execution or delivery. JSON-valid wrong keys/types remain the native executor's responsibility. Material release is not execution or user delivery; those vectors belong to [LIVE-TOOL-CONTRACT](../tickets/LIVE-integration-validation.md#live-tool-contract).

## Evidence without provider payloads

`diagnostic.streams.backend.toolIdentity` links the declared name multiset, actual HTTP name multiset and observed provider/SDK identities using bounded digests, lengths and relation enums. Its `contract` independently reports schema digests/`schemasMatch` and requested/sent choice/`choiceMatch`; `sent.matchesDeclared` alone is name parity, not schema parity. It retains the first mismatch and at most eight tail observations. No names, ids, arguments, prompts, schemas, secrets or raw SDK error messages are logged.

Relations `case_only`, `qualified` and `strict_prefix` are **diagnostic only**. They never authorize case-folding, prefix removal, fuzzy dispatch or completing a name by guesswork. `wireNameMatched` is comparable only with `wireComparison=stable_identity`; `identity_changed` invalidates earlier comparisons for that call. A stable unequal observation records a boundary mismatch, not blame by itself.

`tool_declaration_mismatch` stops before HTTP if the encoded name table differs from the frozen STEP table. `tool_schema_declaration_mismatch` and `tool_choice_declaration_mismatch` independently stop final input-schema or choice drift; object key order is immaterial and no name/schema is repaired. `sdk_schema_mismatch` includes at most eight allowlisted field paths, issue classes and received value shapes; no arbitrary field text or values escape.

Use `grokbox runtime incident <step-id> --agent <id> --json` or the original send nonce with `history outcome --runtime`. Read `diagnostic.streams.backend`, `.wire` and `.host` separately: Host release counts do not overwrite backend declaration/history witnesses and counts are not summed. Independent enrichment requires the complete execution tuple, equal binding and a known matching final attempt. A new source commit is not evidence that the loaded Host/modeld contains it.

`firstMismatch.history=structured_call` only means that a name appeared in structured assistant history for this request; text corrections do not establish a call. History is bounded to 128 names; truncation is unknown, not absent. Error presentations guide current declarations without appending feedback to persistent history, fabricating tool results or scheduling a new request.

A historical `undeclared_tool` record without identity witnesses proves its rejection boundary, **not** the exact returned name or whether a hypothetical alternative dialect would have changed the result. Never retroactively relabel such an incident based on an unrelated live failure.

## Regression and live acceptance

This section owns the commands and acceptance contract, not current progress. Current proved scope, missing Provider/native vectors, blockers and next actions are maintained only in [LIVE-PROVIDER-MINIMAX](../tickets/LIVE-integration-validation.md#live-provider-minimax); approval-time execution and original-App evidence also link to [LIVE-MODELD-TOOLS](../tickets/LIVE-integration-validation.md#live-modeld-tools) / [APP](../tickets/LIVE-integration-validation.md#live-modeld-app). Fixed-run receipts belong in dated reports reached from those rows.

Offline implementation/review receipts and exact scope are owned by [FIX-tool-contract-evidence](../tickets/FIX-tool-contract-evidence.md); SDK/encoding, snapshot/toolChoice, Host release, diagnostic projection or attempt-correlation changes invalidate the related fixture proof.

Offline gates:
- `bun run typecheck`
- `bun run verify:modeld-core tool-contract` rebuilds first and checks the dedicated production-path matrix; the same suites are included in `release-offline`.
- `bun test packages/box-runtime/test/tool-choice-contract.test.ts packages/box-runtime/test/tool-declaration-contract.test.ts packages/box-runtime/test/tool-contract-integration.test.ts packages/box-runtime/test/layered-tool-diagnosis.test.ts packages/box-runtime/test/tool-identity-framing.test.ts packages/box-runtime/test/tool-evidence-retention.test.ts packages/box-runtime/test/host-tool-admission.test.ts packages/box-runtime/test/host-tool-wire-order.test.ts`
- `bun test packages/box-runtime/test/minimax-chat.test.ts packages/box-runtime/test/tool-identity-audit.test.ts packages/box-runtime/test/sdk-validation.test.ts packages/box-runtime/test/delivery-fallback.test.ts packages/box-runtime/test/auxiliary-empty-output.test.ts`
- With explicit native-source access, `bun run test:native-host` checks the pinned native retry, compact and empty-auxiliary contracts on read-only copies/isolated functions; ordinary tests do not discover private source.
- Existing Unix/Host integration, batch-release, cancellation, fragmentation and package gates remain required.

Explicit provider spend, synthetic tools only:

```sh
bun packages/box-runtime/scripts/verify-provider-tools.ts --live --model <catalog-id>
bun packages/box-runtime/scripts/verify-provider-tools.ts --live --model <catalog-id> --batch
bun packages/box-runtime/scripts/verify-provider-tools.ts --live --model <catalog-id> --long-value
```

This probe uses production configuration/auth/backend and a real provider, but only in-memory fixture tools. It checks lookup-result binding, idempotent records, receipt-based completion, successful backend termination and exact assistant-text history. Duplicate records or rejected fixture operations fail the probe, even if a later attempt appears to finish. The long-value lane exercises longer argument continuations without granting filesystem or business tools. Its eight-request/per-step-timeout bounds do not authorize business replay. It is not native Host acceptance. With a shell pipeline, enable `pipefail` and inspect `pass`, not only the formatter's exit code.

Native acceptance uses a disposable confirmed-box Bot, the same selected model and a fresh recorded nonce. Create named disabled test automations only in that Bot, inspect actual native creation history and exported owned records, then compare records after a verified idle modeld replacement or Host restart. Independently check the persisted `enabled`, schedule and last-run fields: a model may replace a requested year-specific one-shot with annual cron while still claiming success. Such a case fails date semantics and must not be enabled or reported as a passing one-shot test. Cleanup affects only those test objects: delete under the authorized native capability, or explicitly disable and verify them while retaining the isolated Bot as an audit sample. Report retained objects rather than claiming deletion. Count actual native changes and user-visible sends; a reply claiming success or a healthy daemon is not enough. Existing failed business tasks must be reconciled first because earlier STEPs may already have created real objects.

A finite successful canary does not prove that a model will never invent an unavailable tool. The correct response to a genuinely undeclared call remains zero executable material for that STEP, preserved evidence, and no automatic replay or fallback model.
