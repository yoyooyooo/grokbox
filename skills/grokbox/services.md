# Services and Host channel

Load when asked to enable/disable grokbox, open the custom-model channel, or align an updated package: `grokbox skills get grokbox --topic services`.

## Check before changing

```bash
grokbox doctor
grokbox agents list --table
```

`doctor` is read-only. Read its checks and `next`; exit 0 means the diagnosis ran, not necessarily that the computer is healthy. Ordinary official-Bot work does not require a custom Host. A Host marked `official` is not itself an error.

## Management Server and background workers

```bash
grokbox system service get server
grokbox system observation get
grokbox notification status
```

These authenticated management queries do not start a process, initialize storage, enable notifications, or call a model. The management Server owns the collector and automatic notification worker; the legacy daemon no longer starts them. `notification status` needs `notifications.read`. Waiting does not mean enabled, native HTTP acceptance is not a Bot report, and neither proves the user read a notification.

`system service run server` and `system service run web` are explicit foreground entries for an authorized process owner. Query their help before supplying installation, discovery or browser binding options. They are not an OS service install or permission to replace the running Host. Existing `on`/`off` and legacy service registration have not become whole-management lifecycle commands merely because new workers exist. Do not switch a live installation to a development worktree.

## Receiver consent and optional tests

```bash
grokbox notification receiver list
grokbox notification receiver verify <receiver-ref>
grokbox notification receiver enable <receiver-ref> --expect-revision <n> --expect-model-revision <sha256> --request-id <uuid> --confirm
grokbox notification receiver test <receiver-ref> --expect-revision <n> --expect-model-revision <sha256> --request-id <different-uuid> --confirm
grokbox notification list
grokbox notification get <notification-ref>
grokbox operation get --domain receiver --database-id <original-db> --request-id <original-uuid>
grokbox operation get --domain notification-test --database-id <original-db> --request-id <original-test-uuid>
```

Enable records explicit future consent and possible model wake costs; it does not send a message. Verify is read-only, not permission. Testing is independent, optional and separately authorized; it sends one fixed test, never creates an incident or enables future delivery. A failed/unknown test is not an enable prerequisite. Do not run a test merely to make enable succeed.

Persist the original request UUID and database before submitting. Unknown means query that exact operation, never create a replacement request to retry. `notification receiver disable/unbind` use the same binding revision and request contract; disable retains the local credential for later explicit enable, unbind removes it without claiming upstream revocation. Historical enable receipts never restore revoked consent. The old `ops targets activate/disable/unbind` writers are retired. Initial native Routine/configuration/credential pairing remains a separate explicit setup step; never mint keys or enable a native Routine as a read fallback.

## Choose the requested change

| Goal | Command | Boundary |
| --- | --- | --- |
| Start grokbox services | `grokbox on` | Enables title sync and idle screen reclaim; does not switch Host. Protect needed login forks first; see [desktop](desktop.md). |
| Stop grokbox services | `grokbox off` | Stops grokbox-started services and idle reclaim; does not restore the official Host or prove all Bot work stopped. |
| Enable the custom-model channel | `grokbox host start` | Ensures custom Host; already custom is a no-op. Does not assign a model to any Bot. |
| Restore the official Host | `grokbox host stop` | Ensures official Host; verify the result with doctor. This is different from resetting one Bot's model. |
| Deliberately restart the channel | `grokbox host restart` | Always intends a Host interruption; not a routine status check. |
| Align after a grokbox package update | `grokbox upgrade --yes` | Aligns services/Host with the installed package; not an npm package download. Use only for an authorized update. |

Host switches can interrupt running Bots, including the operator itself. If refused because Bots are running, use the corresponding `--force` only after that interruption is accepted. Never add `--force` by default, and never use it to bypass a source/profile mismatch.

## Verify and stop

Re-run `grokbox doctor` after the change. Report only the requested capability that is now confirmed; unrelated suggestions are not a to-do list. Do not claim all background tasks stopped just because `off` or a Host command returned.

When doctor names an observe/write/profile recovery path, load [adopt](adopt.md) with `--topic adopt`. Other failures route through [troubleshoot](troubleshoot.md). Do not invent low-level repair commands.
