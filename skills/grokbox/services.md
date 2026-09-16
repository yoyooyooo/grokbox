# Services and Host channel

Load when asked to enable/disable grokbox, open the custom-model channel, or align an updated package: `grokbox skills get grokbox --topic services`.

## Check before changing

```bash
grokbox doctor
grokbox agents list --table
```

`doctor` is read-only. Read its checks and `next`; exit 0 means the diagnosis ran, not necessarily that the computer is healthy. Ordinary official-Bot work does not require a custom Host. A Host marked `official` is not itself an error.

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
