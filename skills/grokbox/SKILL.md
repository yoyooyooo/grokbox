---
name: grokbox
description: >-
  grokbox: turn grokbox on or off on a Grok Bot computer, upgrade after a grokbox update, assign a custom model to a confirmed box Bot, or show/hide App title trailers. Use when installing grokbox, grokbox on/off/upgrade, host start/stop/restart, models use, box vs temporal, or title show/hide.
---

# grokbox

Unofficial CLI for a Grok Bot **cloud computer** you already own. Alpha. Not affiliated with Cursor, xAI, or Grok Bot.

Completion: doctor reports a next step of `none` or a command you then ran; every Bot you touch is classified; custom-model Bots are `confirmed_box`; title trailers match [label.md](label.md) only when asked to show them.

## Tracks

1. **Remote the official product** — Profile, `grokbox doctor`, `agents list`, `send`, `history`. Done when doctor and list succeed.
2. **Custom model on this computer** — `grokbox on`, `grokbox host start`, create with grokbox (not App New Bot), `agents ownership` is `confirmed_box`, `models use --for <agent>`, optional `title show`. After a grokbox package update: `grokbox upgrade --yes`.

App New Bot is often **temporal** and never uses the custom-model channel. Details: [ownership.md](ownership.md). Title paint: [label.md](label.md). Catalog: [models.md](models.md). Failures: [troubleshoot.md](troubleshoot.md).

## Commands

Prefer each command's `--help`. `<agent>` is an exact ID or a unique name.

```bash
grokbox doctor
grokbox on
grokbox host start
grokbox host start --force
grokbox host restart --force
grokbox upgrade --yes
grokbox off
grokbox host stop
grokbox host stop --force
grokbox agents create --name "<name>"
grokbox agents ownership <name-or-id>
grokbox models list
grokbox models use <provider/model> --for <agent>
grokbox models reset --for <agent>
grokbox agents title show <agent>
grokbox agents title hide <agent>
grokbox desktop status
grokbox desktop keep add <agent>
grokbox desktop keep remove <agent> --yes
grokbox template pack <agent> --out recipe.json
grokbox template stage <agent> --visibility public --from recipe.json --yes
grokbox template publish <shareId> --rev <n> --yes
grokbox template import <shareId> --name <name> --rev <n> --yes
```

`on` starts grokbox services on this computer: title trailers can sync, and idle fork screens are reclaimed without editing the seat table. It does not switch Host; `host=unchanged` means run `grokbox host start` for the custom-model channel. `off` stops grokbox-started services and idle reclaim without switching Host. `host start` ensures the custom Host (already custom is a no-op); `host stop` ensures official; `host restart` always bounces. Running bots block a Host switch unless `--force` (the maintainer bot counts). `--force` does not bypass a live-Host SHA mismatch; rewrite the reviewed profile first. Status is `doctor` (`next`). `desktop status` lists seats; `desktop keep` protects a login fork from idle reclaim. Official templates: `template pack` / `stage` / `publish` / `import`. Stage is box-local; publish and import use Gateway. `--rev` is the template version (`--version` is the grokbox CLI).
