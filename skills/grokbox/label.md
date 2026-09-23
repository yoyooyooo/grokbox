# Title trailer

Load for title display changes: `grokbox skills get grokbox --topic label`. Titles are display-only, not proof of ownership, routing, or execution.

## Change only the requested Bot

```bash
grokbox agents title show <agent>
grokbox agents title hide <agent>
grokbox agents title sync <agent>
```

`show` paints a trailer; `hide` removes it while preserving the user text; `sync` refreshes only an already-showing trailer. A named hidden target is skipped with `reason: hidden`. Re-read `grokbox agents show <agent>` to verify the display.

Use explicit targets by default. `show` without names or `--all` is invalid; `hide` with **no names affects every Bot**. Unscoped `sync` refreshes every showing Bot. Use these wider operations only for an explicitly requested bulk change.

## Read the trailer

App Label is `title`. Trailer presence is the show switch; there is no extra config.

```text
<user text> | owner=box,m=<alias-or-model>,e=<requested-effort>
```

The fence is ASCII ` | `; parsing uses the last fence followed by valid `k=v` pairs. Unknown keys remain. `owner=box|temporal|conflict` reflects live Server ownership when available; `m=` uses the catalog alias, otherwise the short model field. `e=` is optional and shows an explicit requested effort, not a confirmed Provider tier. Default effort omits `e=`; official brain omits both `m=` and `e=`.

`show` can also paint when ownership is unconfirmed, using roster harness, existing trailer, assignment, or a display fallback. Empty App titles can be painted. Consequently a visible `owner=box` is **not** `confirmed_box` evidence; use [ownership](ownership.md) before model changes. Skips are reported as `skips: [{ agent, id, reason }]` in JSON.

## Interaction with models and user titles

Model selection/reset uses `bot model set/reset` through the management Server. Its receipt establishes saved next-turn intent, not a native title write. Use an explicitly scoped title action and readback when display is part of the authorized task. `bot update --input @file` with `profile.title` changes the user segment while preserving the existing showing trailer. It does not refresh model/ownership facts; the separately scoped title-sync owner still owns that projection.

For the deliberately delayed refresh acceptance check, load [validation](validation.md). A routine title edit does not require that full playbook.
