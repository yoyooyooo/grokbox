# B1 · Current Memory / Project / fileRef material contract

Date: 2026-09-22

Issue: AH-132

Base reviewed: 498a9656 (feat/box-runtime-v2)

Scope: the current public management implementation in this repository. This report records observed contracts and explicit gaps; it is not a native Host adoption receipt.

## Current source families

The current material API exposes source-scoped documents. It does not create a second Memory fact identity.

| Family | Current source path shape | Public identity | Metadata/body behaviour | Write owner |
| --- | --- | --- | --- | --- |
| Agent Memory | agents/<agentId>/memory/profile.md and bounded log/*.md | material:<installation>:<binding>:<sourceId>:<path>, scope=agent, agentId=<UUID> | Metadata responses omit body; the derived search index stores normalized path+body for literal search; body reads are separate | Native source is read-only in the current implementation |
| User Memory | user-memory/by-agent/<agentId>/memory/profile.md and bounded log/*.md | Same material reference shape, scope=user, same configured agent selector | Same response permission boundary; the derived search index still stores normalized path+body | Native source is read-only in the current implementation |
| Project description / Project Memory | projects/<slug>/project.md and projects/<slug>/memory/by-agent/<agentId>/... | Same material reference shape, scope=project, explicit configured Project slug | Project membership is checked against the configured Project allowlist; metadata responses omit body while search indexing stores normalized path+body | Native source is read-only in the current implementation |
| Project membership | agents/<agentId>/projects.json | A material reference with kind=membership; returned body is the filtered {projects:[...]} projection | Only configured Project slugs are disclosed; this is membership evidence, not an attachment listing | Native source is read-only in the current implementation |
| Ordinary indexed text | Explicit configured files source, bounded UTF-8 text | Same material reference shape, kind=file, scope=file | Metadata responses omit body; search indexing stores normalized path+body, while direct source reads remain separate | The configured file source writer, only when writable=true |

The source adapter enforces these shapes in packages/box-runtime/src/internal/io/material-source.node.ts. A native source is bounded by explicit Bot and Project selectors; paths outside those selectors are rejected before reading. The adapter does not infer authorship, current login, Project membership from Git, or TURN adoption from file contents. The response contract keeps body out of metadata/list results, but packages/box-runtime/src/internal/io/material-store.node.ts persists `${path}\n${content}` in the derived SQLite search_text column; index confidentiality and access control therefore remain part of the material boundary.

## Identity and source binding

Every material reference is pinned to all of:

1. the management installation UUID;
2. the configured source ID;
3. a binding SHA derived from the installation, source declaration, canonical real root, device and inode;
4. a canonical relative path.

The configured accountScope is exposed as a declared source scope. It is an operator-supplied binding field, not proof of a current native account or synchronization session. Source views therefore expose:

- identityBasis=explicit-source-binding;
- upstreamSync=not-observed;
- the current binding or null;
- source state, index age and missing/partial reason.

The management indexer owns only the derived index. It does not own native Memory/Project truth, perform native RPCs, or publish source writes.

## Permission contract

The API keeps four permissions separate:

| Operation | Capability | Source of truth | Current result |
| --- | --- | --- | --- |
| List / metadata | materials.read | Published bounded index | Response contains no body, private root path or inferred author; the protected derived index may retain searchable body text |
| Literal search | materials.search | Published bounded index | Case-insensitive literal search; no excerpts are returned, but search operates over the protected derived path+body index |
| Read body | materials.content.read | Direct descriptor-backed source read | Exact UTF-8 text or the authorized membership projection; returns index lag separately |
| Replace existing text | materials.write | The original configured file writer | Allowed only for a writable files source; native Memory/Project replicas return permission_denied |

A missing or damaged index never becomes a successful empty result. Direct reads may remain available when the derived index is unavailable. A changed root, changed binding, unsafe link, invalid UTF-8 document or out-of-scope path is rejected. A source write records the original request and keeps an uncertain publication unknown; matching current bytes do not prove a historical success.

## fileRef identity: what exists and what does not

There are two intentionally different reference grammars:

- material:<installation>:<binding>:<sourceId>:<path> is a source document reference.
- file:<installation>:<binding>:<root>:<path> is a configured named-root reference.

The second is owned by the named-root file service and cannot alias native material storage. The current repository has no qualified producer for a native Project attachment/fileRef. A Project material document or a membership document is not an attachment fileRef, and a named-root file: reference is not a substitute. No current endpoint should invent, coerce or silently translate one into the other.

This is an explicit unavailable contract, not an empty list success. Any consumer that requires native Project attachments must preserve the missing capability and wait for the native owner bridge.

## Native writer and synchronization status

The current code proves safe reads of configured local replicas and safe writes only for ordinary writable text sources. A continuity-only native-current-state-owner.ts path can capture, apply and verify bot supplements; that path is separate from the management material source contract. The management seam still does not prove:

- a qualified current Host/worker owner for native Memory or Project source writes;
- the original native callbacks, cache/prompt invalidation or remote synchronization for those management writes;
- an authenticated current account/session beyond the declared accountScope;
- native Project attachment enumeration, bytes, deletion or independent attachment readback.

The source-drift evidence in docs/reports/2026-09-22-native-material-source-drift.md records that the older Gateway Memory/Project methods are absent from the current inspected Host surface. The repository still contains a continuity compatibility fallback in packages/box-runtime/src/internal/io/continuity-material.node.ts that calls getAgentMemories and getAgentTranscriptTail through the generic Gateway RPC path. The CLI/daemon compatibility surface also retains the getAgentMemories route (packages/cli/src/commands/memory.ts and the Gateway/daemon protocol), so docs describing that path as exited are stale until those consumers are retired or fenced. These are unqualified legacy execution paths, not a current native owner or material writer; they must be removed or replaced behind a qualified owner bridge before B1 can become Done. A copied local store must not be treated as the native owner.

## Concrete A3-M bridge requirements

AH-135 can close the native-material seam only when the current Host owner supplies all of the following through a version-qualified capability/ABI:

1. Owner and scope — a stable native owner/generation, Bot/User/Project scope, authenticated account/source identity and explicit supported operation set.
2. Read contract — bounded metadata and body reads for the exact native source, with source revision and independent readback identity. Missing source and stale authorization remain distinct.
3. Write contract — an owner-mediated operation with original request identity, native concurrency/revision rules, callback/synchronization outcome and a readback that is independent of the request acknowledgement.
4. Attachment contract — a real Project attachment/fileRef producer that returns stable source-scoped refs, Project membership context, byte/hash metadata and a separate body/download capability. It must not reuse named-root refs.
5. Failure contract — explicit unsupported, permission_denied, source_changed, source_unavailable and unknown outcomes. Lost acknowledgements cannot be retried as a new native write.
6. Proof boundary — loaded/attached/exercised evidence must come from the actual current Host owner. A static source copy, fixture, indexed bytes or matching current content is insufficient.

No second writer, direct native SQLite/fragment edit, old Gateway RPC, or index update may satisfy these requirements.

## Downstream handoff

- C (continuity): retain the exact material/fileRef and source binding as an external dependency. Do not copy a native attachment into a named root and call the dependency closed. Preserve unknown and source-unavailable states.
- D (native product/export): use Project membership and Project Memory only through their explicit material refs. Add Project file listing/export only after the native attachment producer above exists; never use Git paths or named-root files as a fallback.
- R (managed runtime): consume direct reads with the returned revision/index state. includedInTurn=not-observed remains honest; material presence does not prove model adoption.
- E (observation/safety): retain source binding, operation request ID and unknown receipts. Do not auto-retry a lost native publication or prune unresolved records to make capacity available.

## Executable evidence

The contract is exercised by:

- packages/client/test/material-contract.test.ts: strict reference, source-view, metadata, read and operation validation; it now also proves material refs cannot be used as named-root refs and that the current Project document contract has no invented fileRef.
- packages/server/test/materials.node.ts: Agent/User/Project/membership separation, direct reads, native read-only behaviour, source binding drift, permission withdrawal and unknown recovery.
- packages/server/test/materials-boundaries.node.ts: source overlap, index damage, bounded scans, source removal, external writers and shutdown/recovery boundaries.
- packages/box-runtime/src/internal/io/material-source.node.ts, packages/server/src/materials.ts and packages/runtime-kernel/src/materials.ts: the implementation seams named above.

This records B1's current-source contract and exposes the remaining blocker: the legacy continuity fallback and the unqualified native writer / attachment seam must be retired or replaced by AH-135 before B1 can become Done. It does not claim B2 native management or B3 attachment closure.
