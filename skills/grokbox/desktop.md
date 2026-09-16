# Desktop seats and login protection

Load when inspecting desktop forks or protecting a login: `grokbox skills get grokbox --topic desktop`. Desktop control requires the box daemon's desktop capability; a Gateway-only connection is not enough.

```bash
grokbox desktop status --table
grokbox desktop keep add <agent>
# Only when removing this protection is intended:
grokbox desktop keep remove <agent> --yes
```

`desktop status` lists seats and keep/floor IDs without reclaiming a screen. `keep add` protects the selected fork from idle reclaim; it does not wake a Bot, prove a login, or keep a task running. The keep list lives in the box daemon configuration, not the client Profile. Display 1 is always kept.

`grokbox on` enables idle reclaim; `grokbox off` stops it along with grokbox-started services. Protect must-keep login forks before enabling services. Reclaim can remove a fork's Chrome profile, so removing protection can permit loss of that fork's login state.

Re-read `desktop status` to verify the intended protection. Leave the seat table and system processes unchanged. Manual pruning is outside this workflow; consult command `--help` or the `core --full` reference only for a separately authorized maintenance task.
