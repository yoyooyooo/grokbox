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

Without a configured cloud credential, the Routine surface is owner-aware through Gateway/Host. Box-hosted Bots use the local automation store. For Temporal Bots, the bounded Host bridge adds `getGrokboxRoutineAuthority` and routes `getAgentAutomations`, `getAutomationWebhookCredential`, `setAgentAutomationEnabled`, and `deleteAgentAutomation` through Host-owned authenticated Server clients. This path exports neither access tokens nor generic RPC. A missing bridge fails closed instead of treating the local store as authoritative. A configured Profile cloud credential instead selects the cloud read/credential route described below; mutations remain on the Host contract.

Host Routine list/show returns bounded metadata only. Temporal Host contracts expose list, webhook credential, enable/disable and delete, not definition create/update; those writes remain Box-local only. Box create writes disabled definitions; later mutations require revision preflight, explicit confirmation, and same-generation readback. Uncertain writes return `operation_outcome_unknown` and are never automatically replayed. Host credential access retains its explicit confirmation and `--reveal-key` disclosure contract; cloud credential caching and key-only disclosure are described below. Webhook invocation is not part of this surface.

`sendPrompt` represents one Human message to an ordinary agent or group. It is not peer delivery, an administrative broadcast, approval resolution, or arbitrary host execution.

## Server-of-record Routine surface

When the selected Profile declares `server.access_token_ref`, the existing `agents routines list/show` and `agents routines webhook credential` commands use cloud SSOT internally. There is no separate command root, source flag, desktop discovery, or roster union. Without cloud configuration the Gateway/Host behavior remains. For the following bounded Server methods the adapter chooses the verified binary protobuf wire (`content-type: application/proto`) without new dependencies; this does not assert that upstream rejects JSON or other formats:

```text
POST /aiserver.v1.GrokBotService/ListGrokBotAgents
POST /aiserver.v1.GrokBotService/ListGrokBotAgentAutomations   { agent_id }
POST /aiserver.v1.DashboardService/CreateAutomationWebhookApiKey { automation_id }
POST /automations/webhook/<automation_id>                      (credential-scoped, fires the Routine)
```

The adapter resolves Bots with the public `agent_id` (protobuf field 12), not `legacy_agent_id` (field 2) or the internal row `id` (field 1). This public UUID is the product/Gateway identity. `kind` (field 19, ROOM=2) distinguishes groups from ordinary Bots, so rooms cannot be selected for Routine operations. An automation row carries `automation_id` plus a `record_json` string; the bounded native projection retains only safe definition metadata. Prompts, native paths, credentials, and unknown provider fields are never re-emitted.

The returned `automation_id` is authoritative and supplies the webhook URL; do not assume every Temporal automation ID can be derived from a local ID. Cloud list/show preserves envelopes and bounded Routine metadata with `serverId`, webhook URL, and `mutable:false`, never keys or prompts.

Optional webhook verification probes only a fixed, distinct nonexistent automation ID and requires HTTP 401 with exact `missing required scope` scope evidence. It supports abort and never POSTs to the real Routine, which would execute it.

`CreateAutomationWebhookApiKey` is owner-checked, non-idempotent, and has no supported revoke counterpart. First access requires `--confirm` to mint; subsequent access reuses the local key cache scoped to backend, credential digest, agent, Server automation ID, and creation time. Minting is never automatically retried. Keys remain hidden unless `--reveal-key` is explicit; cloud prompts remain private even then.

Cloud failures do not fall back to Gateway or desktop discovery. Check the selected Profile's cloud reference, optional backend URL, and reported authorization/protocol failure. This authority grants no Gateway, daemon, Sandbox, or quota access and adds no cloud CRUD; mutations retain the Host contract.

## Capability separation

The Gateway is not a general cloud-computer RPC. Governed filesystem, process, and Job operations belong to the grokbox daemon. Sandbox lifecycle and quota are separate adapters with separate credential references. Authority on one surface never implies authority on another.

## macOS Gateway session compatibility

When explicitly selected on macOS, the built-in compatibility path can resolve the Grok Bot application descriptor and request Keychain authorization to decrypt a Gateway session. It returns only the bounded session fields needed by the Gateway client and reports typed failures without reflecting secret material.

This path provides Gateway access only. It does not provide daemon, Sandbox lifecycle, quota, SSH, or host-process authority. Passwordless SSH bootstrap is separately declared and never becomes an implicit business-command fallback.

## Freshness

Revalidate this document and the corresponding tests when discovery shape, Gateway routes or schemas, event framing, credential storage, token scope, or host lifecycle changes. A real read-only observation can invalidate an assumption but cannot replace fake-provider refusal and redaction coverage.
