# Upstream integration: evidence and limits

Repository adapters, fixtures and old source reports are hypotheses about upstream behavior. This page separates public contracts checked on 2026-09-19 from local tests and native behavior still **unverified** for the installed generation.

## Local Gateway discovery and credentials

The local client reads `/home/box/sand-data/gateway.json`; this is a runtime path, not the checkout. Discovery validation, explicit local/SSH selection and credential refresh are exercised by `test/profile.test.ts`. These fixtures do not qualify every live Gateway generation.

Gateway, daemon and Sandbox credentials are separate capabilities. The implemented credential resolver accepts explicit environment, file and Keychain references. There is no implemented macOS Grok Bot application-descriptor/session-decryption path; the former claim was false. See [compatibility](compatibility.md) and [configuration](configuration.md) for supported selection.

Gateway adapters use health, typed API and event routes. Follow the adapters from the registered CLI command; do not maintain a second method allowlist here. A send receipt is not completed delivery. Never expose raw credentials, prompts or provider bodies as diagnostic evidence.

<a id="native-routine-and-notification-webhook-boundary"></a>
## Routine HTTP contract

The [official Routines help](https://cursor.com/help/grok-bot/routines), checked 2026-09-19, specifies POST to the saved Routine URL, Bearer authentication and optional JSON delivered with the instruction. HTTP 200 means accepted and started; completion requires separate observation.

The repository's sender, pairing and outbox are separate local implementations. Their checks do not establish native CAS, receiver execution, App visibility or permission to activate a Routine. Follow [operations](runtime/operations.md) and the selected [LIVE scenario](tickets/LIVE-integration-validation.md).

## Ownership inspection

The optional `grokboxOwnershipAgentIds` / `grokboxOwnershipLocalOnly` request fields are grokbox Host extensions, not upstream API guarantees. The intended distinction is current local identity versus Server registration evidence; neither an absent App row nor a local directory proves Server ownership.

Current native DTOs, harness interpretation and installed wrapper/reader interoperability remain **unverified in this audit**. Use [Host compatibility](runtime/host-compatibility.md) and its HCR evidence before relying on a particular installation.

<a id="continuity-import-boundary"></a>
## Duplication and continuity

Historical private-source observations about native duplication, copied stores, cleared conversation, Memory, routines, upload and repair are **unverified for the installed generation**. The old detailed claims remain recoverable at `6f0473d:docs/upstream-integration.md`; they are not a supported resume procedure.

Native duplication must not be assumed to preserve a complete working state or establish Box ownership. [CONT-00](tickets/CONT-00-native-clone-feasibility.md) records the unresolved qualification; the opt-in `ownership-continuity-native.test.ts` requires its pinned private source and was not run in this audit.

<a id="native-checkpoint-closure"></a>
### Checkpoint closure

A pointer match, successful session open or model recalling a fact cannot establish complete checkpoint readback. Determine the actual writer boundary, reference closure, immutable bytes and readback behavior for the selected native generation.

The [2026-09-18 report](reports/2026-09-18-continuity-native-checkpoint.md) records a narrow historical qualification. Its native codecs, AgentStore and private pins were not requalified here. Synthetic fixtures do not establish live worker/DB transactions, Memory import, writer exclusion or restart continuity.

## Host session boundary

**Unresolved implementation conflict:** the intended managed interception precedes official-provider initialization, but the current literal patch and structural emitter construct the official session before calling the hook. `host-entry.test.ts` checks the latter with fixtures; it does not prove managed execution is independent of failing official-provider preconditions.

The managed hook does not use that official session. Restoring early selection requires qualifying both emitters, passthrough and current native profiles; accepting the dependency instead is a product decision. Do not treat current code or its positive test as resolving this conflict.

The local session exposes synchronous stream handles, async `fullStream` and executor/state access. `host-fullstream.test.ts` and `host-executor-state.test.ts` exercise those fixture contracts, including isolated executors. See [runtime](box-runtime.md) and [Host research limits](maintainers/host-inbound-agent-loop.md) before inferring native compatibility.

## Auxiliary, activity and delivery boundaries

- `auxiliary-empty-output.test.ts` distinguishes qualified auxiliary empty output from invalid main output. Current native Memory/episode consumer behavior remains unverified.
- `host-activity-bridge.test.ts` exercises an explicit source-local activity sink without a process-global last-listener fallback. It does not qualify App rendering or watchdog behavior.
- `delivery-fallback.test.ts` exercises optional `end_turn` schema handling. A queued tool send is not observed delivery.
- Optional source/lineage fields and purpose slices are version-specific inputs. Fixture acceptance does not prove every native trigger supplies them.

Native ownership, Memory, tool execution, checkpoint and delivery must be observed at their actual writers; repository projections do not replace that evidence.

## MiniMax Chat

The [official OpenAI-compatible API documentation](https://platform.minimax.io/docs/api-reference/text-openai-api), checked 2026-09-19, requires preserving complete assistant messages across tool turns, including reasoning. It documents inline `<think>` content and a separate `reasoning_split` format.

`minimax-chat.test.ts` exercises the repository's inline dialect with synthetic streams. It does not qualify a live provider or arbitrary compatible dialects. See [Chat compatibility](maintainers/chat-provider-compatibility.md) for the adapter's scope.

Revalidate affected assumptions when native bytes, API/schema, credentials, model encoding or loaded artifacts change. Keep source tests, private qualification and observed deployment results separate.
