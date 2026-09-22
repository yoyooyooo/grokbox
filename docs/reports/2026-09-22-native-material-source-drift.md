# Native material entry points after a Host source change

2026-09-22; DATA-01, HOST-01 and CLI-05 W3. This is an observed dependency correction, not a new native integration or adoption receipt.

The installed `host-main.cjs` read during this work has SHA-256 `ebd92f0d14dd065b779524989dc15a7922c848f77227c69616257be6af6db8f0`. The repository's single qualified source catalog still selects `6be750313bb7bb393cc3833e103d4d2cd0dc336b6d903e7671c107ea1883767f`. The catalog was not repinned. A changed disk file does not prove which bytes an existing process loaded, that any running Bot failed, or that the new source is qualified. Loaded-process provenance and actual current profile state were not observed in this investigation.

## What was actually checked

The installed Gateway method schema and corresponding source definitions were read, not replaced by the older reverse-engineering notes. The former `getAgentMemories`, `deleteAgentMemory` and `clearAgentMemories` methods are absent from that schema and current installed source. The earlier local Agent-state Project create/join/leave methods and Project memory-store constructor are also not present in this layout. This is evidence about this local Host surface, not proof that the overall product or its remote Server no longer has Project or Memory features.

The current source still has its original file-memory store and Agent-state `writeMemory`/`removeMemory` behavior. User-memory writes have an independent notification to the original user-shard synchronization path. Reading an old local shard or directly changing it would not establish that this native owner, callback, prompt-view invalidation or remote synchronization occurred. No native source content, credentials, bodies or private artifact copies are published by this report.

## Implementation consequence

DATA-01 must not implement the removed Gateway RPCs or revive the former Project implementation to satisfy its old examples. Full native material modification needs a version-qualified connection to the actual current native writer, its original callbacks, bounded identity and independent readback. A newly exposed bridge must join the existing Host profile/health and operation contracts; evaluating a copied native store in another process is not equivalent to using the running native owner.

HOST-01/HCR-04 must first evaluate this new disk source against the single current transformation and verifier chain, then establish any necessary native ABI changes. Reuse the existing Node/TS producer, Rust/Oxc verifier, original provenance and OBS chain. No historical recipe fallback, relaxed pin, parallel parser or second native writer is introduced. Existing fixed-source tests remain evidence for their exact inputs and cannot be relabelled as qualification of the new bytes.

The unrelated desktop management migration proceeds in the same main worktree while these dependencies remain explicit. Job, ordinary named-root file transfer/recovery, Compact and handover management entry migrations are not reopened. Their whole-native acceptance and actual-source qualification remain separate.

## Boundaries

Only installed source and repository contracts were inspected. The complete Host entry was not executed, no native memory was edited, no model/remote API was called, and no existing Host/profile/service/global entry was adopted or replaced. The current source adaptation, native Project/file references and full material write chain remain required work, not optional features removed to make W3 appear complete.

See [DATA-01](../tickets/DATA-01-memory-project-files.md), [HOST-01](../tickets/HOST-01-patch-health-verifier.md), [HCR-04](../tickets/HCR-04-capability-profile-upgrade.md), and the earlier [source feasibility record](2026-09-19-webui-source-feasibility.md) for its historical evidence scope.
