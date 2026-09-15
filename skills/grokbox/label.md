# Title trailer

App Label is the `title` field. grokbox may append a display trailer. Trailer presence is the show switch; there is no extra config.

```text
[<user>][ | owner=box,m=g46[,k=v...]]
```

- User text first. Fence is ASCII ` | ` (spaces). Parse uses the last fence whose suffix is valid `k=v` pairs.
- `owner=box|temporal|conflict` from live Server ownership.
- `m=` is `models.json` `alias`, else the short `model` field. Official brain omits `m=`.
- Unknown keys stay in the trailer.

```bash
grokbox agents title show <bot> [bot...]
grokbox agents title show --all
grokbox agents title hide [bot...]          # no names = every Bot
grokbox agents title hide --all
grokbox agents title sync [bot...]          # only Bots already showing
```

`show` without names or `--all` is invalid usage. `show` paints even when Server ownership is unconfirmed: roster harness, existing trailer, `models.json` assignment, user text, or trailer-only `owner=box`. Empty App titles (name-only Bots) are still painted. Remaining skips appear under `--json` as `skips: [{ agent, id, reason }]`. `sync` never paints a hidden Bot; a named hidden target is skipped with `reason: hidden`. `agents update --title` replaces the user segment; a showing Bot keeps a refreshed trailer. Missing token → keep `m=`; confirmed no assignment → clear `m=` (same as `title sync`).

Hide and show are display only. `models use --for` paints that Bot's trailer (`m=` from alias, else short model id) and keeps the user title. `models reset --for` only refreshes a trailer that is already showing and drops `m=`. Title write failure does not undo the model assignment.
