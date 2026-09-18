# Upstream Grok Bot Integration Facts

This document is the Current Home for the minimum upstream compatibility facts required by grokbox. These interfaces are not documented upstream public APIs. Source adapters and executable fake-provider tests own the exact current projection.

## Local Gateway discovery

A running Grok Bot host exposes a generation-specific discovery document at the box runtime path:

```text
/home/box/sand-data/gateway.json
```

The client consumes only the scheme, host, port, process identity, start time, and credential needed to connect. Wildcard bind hosts are dialed through loopback. Non-loopback local discovery fails closed. Clients reread discovery after authentication failure, connection failure, event disconnect, or generation drift.

The path is a product runtime convention, not a path to this source checkout.

## HTTP and authentication

The compatibility adapter uses a small fixed surface:

```text
GET  /health
POST /api/<allowlisted-method>
GET  /events?channels=<allowlist>
```

Protected requests use a Gateway bearer credential. The credential is high privilege and has no assumed read-only or per-method scope, so grokbox exposes no generic raw Gateway command. Discovery data, credentials, routing headers, prompts, Memory content, transcripts, and raw provider bodies must not enter ordinary output, errors, audit records, or fixtures.

## Typed method boundary

The implemented method allowlist is:

```text
getHostStatus
getTrays
listAgents
searchAgents
getAgentTranscriptTail
getAgentThread
getAgentMemories
sendPrompt
createAgent
createGroup
updateAgent
setGroupMembers
setAgentNotifyOnUpdates
setAgentHiddenFromSidebar
deleteAgent
```

Every write has an explicit schema and command. Groups reject nested groups, membership is bounded, updates preserve required existing fields, and uncertain delivery is not blindly replayed.

`sendPrompt` represents one Human message to an ordinary agent or group. It is not peer delivery, an administrative broadcast, approval resolution, or arbitrary host execution.

## Official registration inspection via Host

A versioned optional `grokboxOwnershipAgentIds` field on the existing `getHostStatus` request activates the grokbox Host read bridge. It is absent from ordinary status requests. The native Host Gateway deps expose `environment` directly (not `context.host.environment`); the bridge constructs its official client with that backend and the Host auth API. Only `ListGrokBotAgents` is borrowed, with cancellation/deadline and target projection; no token value or generic remote invocation crosses Gateway.

The reviewed bridge can additionally accept `grokboxOwnershipLocalOnly: true` for the same bounded target list. Its distinct `Host.native-local-ownership` result reports current local identity, scope, migration and allowed/bound facts without calling List. That result cannot independently authorize managed execution. Modeld may reuse only remote registration evidence and must obtain this current local witness before/after using it; an old peer returning the normal registration source marker is not a valid local-only capability. The native adapter retains only a bounded in-flight operation guard, not a completed registration cache. This is a version-qualified grokbox extension, not an upstream API guarantee.

Server responses distinguish public `agentId`, Server row `id` and `harness`. Generic identity Update does not carry harness, and the native App's server-roster view may filter to temporal rows. Ownership inspection must therefore use unfiltered original List evidence, not infer box from an omitted row. Official controlled migration is separate, has side effects, and is not invoked by this command. Exact finite DTO/classifier and synthetic interoperability tests are in `ownership-read.ts`, `ownership-slices.ts`, CLI `ownership.ts`, and their tests. Unsupported Host versions remain unavailable, never silently replaced with local evidence.

<a id="continuity-import-boundary"></a>
## Native duplication and continuity import boundary

The reviewed native `duplicateAgent` delegates to a new-identity materialization flow, opens the new session and changes the active-session projection. Its directory copier checkpoints the source SQLite before copying the store, copies selected profile/settings/avatar and automation definitions, then clears transient state and deliberately clears the conversation. The new profile does not carry the source's harness/server registration. In this version the copier does not copy the separate conversation-blob database or filesystem Memory directory, unhides the new Bot and does not disable copied routine definitions. Neither opening a new local directory nor omitting the old registration proves Server-confirmed Box ownership.

The native conversation-clear operation removes transcript/completion records and resets the retained root reference. Merely changing the internal history flag is therefore not a complete clone implementation: it still lacks a complete working-state closure, scoped Memory, new-identity validation, paused target preparation and side-effect reconciliation. Native duplication is not a supported resume primitive for grokbox.

A separate native working-state export path walks the retained root and reachable blobs, but skips Temporal agents and in-flight turns. The exposed export operation also uploads to the upstream object store; it is not a read-only local backup command. Its internal snapshot helper can attempt root recovery when the root is missing, so its name is not a non-mutation guarantee. A continuity snapshot adapter must qualify a non-repairing reader and preserve committed closure provenance without invoking migration, upload or repair as a side effect of observation.

These facts are bounded by the explicitly pinned native qualification in `packages/box-runtime/test/ownership-continuity-native.test.ts`. It executes selected original functions with owned filesystem/database/network dependencies, without importing the full Host or copying its implementation into this repository. Ordinary public tests do not require private source. The probes do not prove cross-identity import, live restart/resume, original-App delivery, routine transfer or a permanently Box-owned replacement. [Spec S13](roadmap/box-runtime-impl-spec.md#ownership-continuity) and [CONT-00](tickets/CONT-00-native-clone-feasibility.md) own the proposed integration and remaining qualification.

## Capability separation

The Gateway is not a general cloud-computer RPC. Governed filesystem, process, and Job operations belong to the grokbox daemon. Sandbox lifecycle and quota are separate adapters with separate credential references. Authority on one surface never implies authority on another.

## macOS Gateway session compatibility

When explicitly selected on macOS, the built-in compatibility path can resolve the Grok Bot application descriptor and request Keychain authorization to decrypt a Gateway session. It returns only the bounded session fields needed by the Gateway client and reports typed failures without reflecting secret material.

This path provides Gateway access only. It does not provide daemon, Sandbox lifecycle, quota, SSH, or host-process authority. Passwordless SSH bootstrap is separately declared and never becomes an implicit business-command fallback.

## Host session boundary

The exact-profile interception is at `createSession` entry, before official-provider model resolution or client/session construction. The hook returns a managed session only for a configured per-agent route; `undefined` declines interception and leaves the original Host body in charge of constructing its official session. `host-entry.test.ts` exercises that ordering with failing official-provider preconditions and exact official passthrough.

The minimum Host-shaped contract retained by box-runtime is `getModelId()`, both executor accessors, Array message/state access, and synchronous `stream(ctx, invocationId, tools, options)`. The returned handle exposes an async `fullStream` and independent completion promises. Text and tool-call/result content blocks must keep matching ids; the Host owns tool execution, final delivery, Transcript and Memory.

The provider-neutral supported subset and explicit refusal cases live in `docs/box-runtime.md` §2 and `packages/box-runtime/src/envelope.ts`. `host-envelope.test.ts`, `stream-contract.test.ts`, and `envelope-seam.test.ts` use synthetic input and a scripted driver, not private Host code or provider traffic. They are bounded compatibility evidence, not validation of every live Host generation or provider-specific message format.

## Host auxiliary purpose boundary

The reviewed memory-extraction and interval-episode sites each obtain a new executor from the main session. Their collector omits STEP; the usage wrapper preserves the four stream arguments. These facts alone do not identify arbitrary no-STEP requests as auxiliary. The optional `memory-purpose` / `episode-purpose` slices carry explicit call-site purpose and the real parent TURN; the managed session supplies its actual completed STEP and captured selection. The evidence-only Memory branch does not invoke either factory. Dedicated external summary and STEP-bearing self-summary are separate paths.

See [E07 Host admission](maintainers/e07-path-b-host-admission.md) and `e07-host-*.test.ts` for exact-apply, passthrough, cancellation, source/packed proof and remaining native qualification. Host continues to own all Memory policy and writes. No native prompts or consumer implementation are a public dependency.

## Native turn observation fields

The currently inspected Host main-session options already carry optional `requestSource`, subagent flags and `lineage`; observing them does not require another code-injection slice. The supported source labels are `turn`, `agent`, `automation`, `handoff-resume`, `connector`, and `voice-call`; other values remain unknown. Native lineage contains `parentRequestId`, `rootParentRequestId`, and optionally `parentAgentToolCallId`. Only UUID-shaped native request identities and tool-ID presence are projected. They are never relabeled as kernel STEP/TURN identities or used to authorize a retry, and missing lineage is not reconstructed from a display group or adjacent timestamp. Synthetic projection tests live in `turn-observation.test.ts`; these are optional version-qualified observation facts, not proof of every native trigger or native checkpoint transaction.

The native interaction callback owns both its `streamWatchdog.noteUpdate` and `host.emitUpdate` receiver. It must remain run-owned. The managed first-chunk observation no longer injects a synthetic thinking update through a process-global last-listener callback; such a callback can attribute one Agent's work to another Agent's watchdog/UI.

## Final text delivery and Chat dialects

The inspected native `SendToUser` contract can offer an optional boolean `end_turn` for final delivery. When offered and a send succeeds, the native owner ends that run without another assistant message. Other Host modes omit the capability. The managed plain-text fallback therefore sets it only when the current STEP's text-tool schema grants the field; it preserves the original ordered text/reasoning history instead of replacing it with the delivery projection. `delivery-fallback.test.ts` covers offered, absent and incompatible-union cases without importing native source. This is not permission to end arbitrary runs or to count a queued send as delivery.

The source-pinned native memory consumer parses completed blank text as zero additions/removals; the episode consumer returns no narrative for blank text. Qualified inference-only auxiliary STEPs preserve that no-op instead of treating it as an empty main reply. `native-auxiliary-noop.test.ts` checks the actual pinned consumers in isolation; `auxiliary-empty-output.test.ts` keeps main, malformed-parent, cancellation and missing-finish paths strict. No model reasoning is substituted for an empty memory result and no memory writer is moved.

MiniMax's documented Chat format supports complete inline `<think>` content or separated reasoning state. The qualified `minimax-inline-v1` adapter requests the former and preserves it across tool turns. The adapter also handles empty `type` slots on already-established function continuations, omitting only those slots after original-frame audit. Unknown names, first-call missing identity, nonempty invalid types, missing completion and incomplete arguments remain failures. `minimax-chat.test.ts` uses synthetic streams; no live provider frame is a fixture. See [Chat compatibility](maintainers/chat-provider-compatibility.md) for configuration, bounded evidence and separate provider/native acceptance gates.

## Freshness

Revalidate this document and the corresponding tests when discovery shape, Gateway routes or schemas, event framing, credential storage, token scope, or host lifecycle changes. A real read-only observation can invalidate an assumption but cannot replace fake-provider refusal and redaction coverage.
