# Materials: scoped sources and source-write recovery

Load for Memory, native Project documents, local-source search or editing an existing authorized text file: `grokbox skills get grokbox --topic materials`.

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

## Source onboarding is an explicit configuration change

No query creates a source or initializes its database. Only an already configured, enabled management indexer creates the derived index. Configure exact roots, explicit account-scope digests, native Bot/Project allowlists and file write permission through the existing local configuration owner. Load the [configuration topic](config.md) before doing so. Do not use broad home/system roots or overlap file sources with native material sources. Linux descriptor-backed local files are the qualified platform for this slice; network filesystem guarantees are not implied.

The console's `/materials` page uses the same queries and writer. A browser stores only operation locators, never document bodies, revisions, credentials or write input. Closing the page does not stop indexing.
