# Desktop seats and login protection

Load when inspecting desktop forks or protecting a login: `grokbox skills get grokbox --topic desktop`. Desktop control requires the box daemon's desktop capability; a Gateway-only connection is not enough.

```bash
grokbox system desktop get
grokbox system desktop keep set --input @desktop-keep.json --confirm
# Only when removing this protection is intended, submit the reviewed complete set.
grokbox system desktop keep set --input @desktop-keep-without-agent.json --confirm
```

`system desktop get` lists seats, display identities, keep/floor IDs, the current idle-reclaim setting and the management worker without reclaiming a screen. `system desktop keep set` submits the reviewed complete protection set; it does not wake a Bot, prove a login or keep a task running. The keep list is `config.json.desktop.keepAgentIds` on the Box. Keep writes use the canonical revision-checked config writer; they do not edit a client Profile or the protected installation floor. Display 1 is always kept.

`grokbox on`, `grokbox off` and `grokbox upgrade --yes` do not change idle reclaim. Enable or disable it only through the reviewed `system config apply --domain desktop` or `config set desktop.idleReclaim.enabled` path, with the required request, revision and confirmation fields. Reclaim calls the official `stop-window`, which may remove a fork's Chrome profile. Removing protection can therefore permit loss of that fork's login state.

Re-read `system desktop get` to verify the intended protection. For `desktop.idleReclaim.enabled` / `minIdleMs`, load [config](config.md); saving is distinct from a live consumer acknowledgement. `system desktop prune --preview` is read-only. Executing a reclaim requires the original request UUID, current desktop revision and `--confirm`; query the same request with `operation get --domain desktop` if settlement is unknown. Leave the seat table and system processes unchanged unless that separately authorized reclaim is the requested operation.
