# T16 — ModelBackend adapters: AI SDK + pi + Cursor SDK

## Status
**Open · product-scope tracker, not an implementation lane.** Rebuild foundation is [T23](T23-runtime-model-backend.md) in Phase 1; candidate execution is [T30 pi](T30-runtime-pi-backend.md) and [T31 Cursor](T31-runtime-cursor-backend.md) in Phase 3. The [implementation spec](../roadmap/box-runtime-impl-spec.md#backends) owns the one DI/ModelBackend shape; do not maintain a second adapter/kernel track in this ticket.

## Goal
Add pi JSON-RPC and Cursor SDK inference backends behind the same binding, STEP/attempt lifecycle, typed events and failure contract.

## Qualification gates
- Pin Pi's actual RPC protocol/version and Cursor's specific SDK/package and local/cloud execution surface. Do not infer Codex app-server methods or JSON-RPC 2.0 from a name.
- Prove a single inference can use the explicit snapshot/tools/options without executing tools, importing hidden root/history/Memory, auto-compacting, retrying/failing over or modifying a repository.
- Keep backend session identity private. Prove state reset, Bot isolation and cancel/restart behavior before stateful reuse.
- Match the shared conformance suite for tool correlation, content capabilities, stream/cancel, auth identity, context-limit evidence and usage availability. Refuse unproven capabilities.
- Mark a candidate unsupported/deferred if it cannot satisfy the inference-only boundary; a full Agent's final string is not equivalent.

## Integration
Use the existing kernel and Effect-owned resources. Extend the single catalog schema only for necessary backend/provider/auth differences; preserve T10 opt-in and CLI/WebUI SoT. Host/preload remain Effect-free and SDK-free.

## Non-goals
- Replacing Host with pi/Cursor Agent loops or adding a backend-local turn registry.
- Dynamic arbitrary module/command loading, implicit retries or another credential authority.
- Blocking T14b or the rest of the runtime on completion of every candidate.

## Related
- [T15 — WebUI](T15-webui-ops-config-storage.md)
- [T14b — confirmed overflow recovery](T14b-host-reuse-compact-on-confirmed-overflow.md)
