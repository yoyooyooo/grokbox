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
listAgents
searchAgents
getAgentTranscriptTail
getAgentThread
getAgentMemories
getAgentAutomations
createAgentAutomation
updateAgentAutomation
setAgentAutomationEnabled
deleteAgentAutomation
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

The Routine surface is owner-aware. For Box-hosted Bots the existing Gateway methods continue to use the local automation store. For Temporal Bots, the official desktop coordinator routes Routine reads and supported mutations to Server actions; a direct Box Gateway caller would otherwise see only the legacy local store. Grokbox's bounded management Host bridge therefore adds `getGrokboxRoutineAuthority` and makes `getAgentAutomations`, `getAutomationWebhookCredential`, `setAgentAutomationEnabled`, and `deleteAgentAutomation` use the Host's own authenticated Server clients when the Bot is Temporal. No access token or generic Server RPC is exported to the CLI. If that bridge is absent, the CLI refuses Temporal Routine access instead of interpreting the local store as authoritative.

Routine list/show is projected into a bounded metadata-only window; prompt bodies, filesystem paths, webhook credentials and unknown provider fields never enter normal output. Current Temporal Server contracts expose list, webhook credential, enable/disable and delete, but not definition create/update. `createAgentAutomation` and `updateAgentAutomation` therefore remain Box-local only, and the CLI rejects those commands for Temporal Bots before any write. Box create writes disabled definitions; later mutations use revision preflight plus explicit confirmation and same-generation readback. Upstream Routine APIs expose neither compare-and-swap nor native idempotency, so uncertain writes are `operation_outcome_unknown` and are never automatically replayed. Webhook credential access is an explicit confirmed command: the URL is safe output, while the key and prompt are omitted unless `--reveal-key` is explicitly requested. Credential access may mint/persist an upstream key; webhook invocation itself is not part of this command surface.

`sendPrompt` represents one Human message to an ordinary agent or group. It is not peer delivery, an administrative broadcast, approval resolution, or arbitrary host execution.

## Server-of-record Routine surface

Temporal Bots keep their Routines on the Grok Bot Server rather than in the box's local automation store, so a Gateway-only caller sees an empty list and cannot mint a webhook key. When a Profile declares `server.access_token_ref`, grokbox may address three Server unary methods directly, in the Server's own binary protobuf encoding (`content-type: application/proto`; JSON is rejected with 415):

```text
POST /aiserver.v1.GrokBotService/ListGrokBotAgents
POST /aiserver.v1.GrokBotService/ListGrokBotAgentAutomations   { agent_id }
POST /aiserver.v1.DashboardService/CreateAutomationWebhookApiKey { automation_id }
POST /automations/webhook/<automation_id>                      (credential-scoped, fires the Routine)
```

Observed response fields used by the adapter: agents carry `id`, `name`, and `harness`; an automation row carries `automation_id` plus a `record_json` string with `id`, `name`, `trigger.type`, `isEnabled`, and `createdAt`. Everything else in the record is ignored and never re-emitted.

Two server-side facts shape the contract:

- The automation id is `sha256("<agentId>\0<localId>")` reshaped into UUID form, so a Routine's webhook URL can be derived without any credential.
- Webhook keys are scoped to exactly one automation (`automation:<id>`) and authorize nothing else: they cannot call the RPC surface, and posting to a different automation id is refused with `missing required scope`. That refusal is the only safe liveness probe; posting to the Routine's own id would run it.

`CreateAutomationWebhookApiKey` is owner-checked (`Only the automation owner can create webhook API keys`), is not idempotent, and has no revoke counterpart in the supported surface. The adapter therefore mints only on explicit request and never retries a mint automatically.

This surface is a separate credential authority and does not imply Gateway, daemon, Sandbox, or quota access.

## Capability separation

The Gateway is not a general cloud-computer RPC. Governed filesystem, process, and Job operations belong to the grokbox daemon. Sandbox lifecycle and quota are separate adapters with separate credential references. Authority on one surface never implies authority on another.

## macOS Gateway session compatibility

When explicitly selected on macOS, the built-in compatibility path can resolve the Grok Bot application descriptor and request Keychain authorization to decrypt a Gateway session. It returns only the bounded session fields needed by the Gateway client and reports typed failures without reflecting secret material.

This path provides Gateway access only. It does not provide daemon, Sandbox lifecycle, quota, SSH, or host-process authority. Passwordless SSH bootstrap is separately declared and never becomes an implicit business-command fallback.

## Freshness

Revalidate this document and the corresponding tests when discovery shape, Gateway routes or schemas, event framing, credential storage, token scope, or host lifecycle changes. A real read-only observation can invalidate an assumption but cannot replace fake-provider refusal and redaction coverage.
