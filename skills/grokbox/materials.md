# Materials: scoped sources and source-write recovery

Load for Memory, native Project documents, source search, named-root binary files or source-write recovery: `grokbox skills get grokbox --topic materials`.

## Discover before reading

```bash
grokbox system materials get
grokbox memory list --scope agent --limit 25
grokbox memory search "exact words" --scope user --limit 25
grokbox project list --limit 25
grokbox file root list
grokbox file search "exact words" --source documents --limit 25
```

The fixed management connection owns these queries; an explicit `--connection` must already be pinned to an installation. Lists return **document metadata**, not native Memory fact IDs, whole-account inventories or body excerpts. Keep the returned `material:...` reference. Same text in two shards remains two source identities. Old positional `memory list <agent>` and `--content` are retired.

`system materials get` separates source availability, last indexed time and freshness. A partial/unavailable source or stale index is not a complete empty result. Search is literal, case-insensitive and limited to configured source documents. Page cursors bind the original source bindings and query; a `cursor_gap` requires a new traversal. Unchanged reconciliation does not invalidate a cursor.

## Read the original document explicitly

```bash
grokbox memory read <material-ref>
grokbox project get <material-ref>
grokbox file read <material-ref>
```

Body permission is independent of metadata/search permission. These reads open the source, not an indexed copy; the result reports `matched`, `lagging`, `not-indexed` or `unavailable` index state. Index damage need not make a healthy source unreadable. A timestamp is not authorship or proof of TURN inclusion.

Native Agent/User/Project shards and Project membership files are currently **read-only local replicas**. The account-scope value is an explicit source binding, not a freshly observed native account login; upstream synchronization remains `not-observed`. Do not edit native shards with generic file commands or claim a complete native CRUD surface. Project membership comes from configured native membership files, not Git repository locations.

## Change only supported existing text files

Prepare a strict JSON input containing `ref`, `requestId`, `expectedRevision` from the direct source read, and `content`. Persist the UUID before submission. The content must fit the 32 KiB write bound.

```bash
grokbox file write --input @source-change.json --confirm
grokbox operation get --domain material --request-id <original-uuid>
```

This is an exact existing-file replacement in a writable file source, not file creation, binary upload, native Memory editing or Project membership modification. Source publication and index adoption are separate results. A version conflict leaves the source untouched; read the current source and review the draft before declaring a new change.

After a lost response, inspect the **original request**. Unknown does not authorize another request ID or another source write. Matching current bytes are not proof of historical submission. Completed receipts remain queryable after source removal; rebuilding the derived index never deletes source-operation guards. Native/external writers do not share an atomic compare-and-swap with this local writer.

## Named-root files and binary transfers

`file root list/get` also identifies configured named roots. Keep the returned `file:...` reference: installation, root binding and encoded relative path are required; do not substitute a raw home path. `file list <file-ref>` lists one directory, while `file list` without a reference lists the indexed document window. A root declaration cannot overlap management state, another root or a material/native source. Metadata, content, publication, deletion and restore use independent permissions.

```bash
grokbox file root get workspace
grokbox file list <directory-ref> --limit 20
grokbox file stat <file-ref>
grokbox file read <file-ref>
grokbox file upload <file-ref> --from ./input.bin --request-id <uuid> --expect-revision absent --confirm
grokbox file download <file-ref> --to ./new-output.bin
grokbox file mkdir <directory-ref> --request-id <uuid> --confirm
grokbox file delete <file-ref> --request-id <uuid> --expect-revision <observed-sha256> --confirm
grokbox file restore <file-ref> --request-id <new-uuid> --deletion-request-id <original-delete-uuid> --confirm
grokbox operation get --domain file --request-id <original-uuid>
```

For named-root text changes, `file write --input @file|- --confirm` accepts the exact file ref, original requestId, expectedRevision (null only for a new destination) and content. Direct `read` returns bounded base64 and validates its SHA; binary transfer handles files up to 64 MiB with ordered 32 KiB chunks and a full hash. Download never replaces a caller-local destination. A directory revision covers its own metadata, not every descendant's contents. Recursive deletion needs the explicit flag and root policy; there is no permanent-delete fallback.

A lost response is recovered by the original request, never a new UUID or another root alias. Upload staging and commit are different phases. Only the current owner can explicitly cancel its uncommitted original staging area: `operation cancel <request-uuid> --domain file --generation <original-service-uuid> --confirm`. Cancellation after commit, dead-owner uncertainty and invalid control history do not imply that no publication happened. Idle staging is bounded; known receipts and unknown safety guards do not expire into replay permission. Restore uses the same principal's original successful delete and original path without overwriting a current destination. The old `fs` commands and daemon file RPCs are removed.

The `/files` console uses the same domain. File bytes and reusable approvals are not stored in browser recovery locators. The original material store owns both domains' safety records; changing a named path into a text source cannot bypass an unresolved publication. Native Project attachments, upstream synchronization and safe long-term trash/receipt retirement are separate remaining capabilities.

## Source onboarding is an explicit configuration change

No query creates a source or initializes its database. An already configured, enabled management indexer creates derived source snapshots; an explicitly authorized first file publication may initialize the same owner's empty safety store without starting an indexer. A missing established safety database is never recreated as fresh permission. Configure exact roots, explicit account-scope digests, native Bot/Project allowlists and file write permission through the existing local configuration owner. Load the [configuration topic](config.md) before doing so. Do not use broad home/system roots or overlap file sources with native material sources. Linux descriptor-backed local files are the qualified platform for this slice; network filesystem guarantees are not implied.

The console's `/materials` page uses the same queries and writer. A browser stores only operation locators, never document bodies, revisions, credentials or write input. Closing the page does not stop indexing.
