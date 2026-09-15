---
name: grokbox
description: >-
  Agent-operated grokbox on a Grok Bot cloud computer: friendly speech to people,
  exact CLI to yourself. Use when installing or recovering grokbox, host
  start/stop, doctor next, custom models on disposable Bots, templates, or title
  trailers. Always load via `grokbox skills get grokbox` first.
---

# grokbox

Unofficial CLI for a Grok Bot **cloud computer** you already own. Alpha. Not affiliated with Cursor, xAI, or Grok Bot.

**Primary operators are Agents** (template Bots / canary), not humans typing at a shell. Humans hear outcomes; you run commands.

## Two voices

| Audience | How you speak |
| --- | --- |
| **People** | Friendly outcomes only. No internal jargon: no SHA, reviewed, preload, envelope, source_mismatch, or similar. |
| **Yourself** | Exact CLI / `doctor` / `error.next` commands. Follow printed `next` literally. |

## Role split

- **Operator Bot** (this template / canary): stays on the **official brain**. Never `models use` yourself.
- **Disposable Bots**: create with `grokbox agents create` for custom-model experiments; assign models only to those.
- Deep recover / Host-update playbooks live in companions — not in the market-facing description.

## Tracks

1. **Remote the official product** — Profile, `grokbox doctor`, `agents list`, `send`, `history`. Done when doctor and list succeed.
2. **Custom model on this computer** — `grokbox on`, recover Host channel per [adopt.md](adopt.md), create box Bots with grokbox (not App New Bot), `agents ownership` is `confirmed_box`, `models use --for <disposable-agent>`, optional `title show`. After a grokbox package update: `grokbox upgrade --yes`.

App New Bot is often **temporal** and never uses the custom-model channel. Details: [ownership.md](ownership.md). Title paint: [label.md](label.md). Catalog: [models.md](models.md). Failures: [troubleshoot.md](troubleshoot.md). **Host recover after official update:** [adopt.md](adopt.md).

## Host recover (summary)

When doctor / `error.next` says the custom channel needs a Host update:

1. Follow `next` exactly: observe → write; if write rejects on drift, follow that `next` (often includes `--slice-review`); then `grokbox host start`.
2. `--force` only when start/stop refuse because bots are running **and** that pause is accepted.
3. If the path is **unrecoverable** → `grokbox host stop` (back on official channel), tell the person you’re on the official channel and waiting for a maintainer. Do **not** thrash `--force`.

Full decision tree: [adopt.md](adopt.md). Short table: [troubleshoot.md](troubleshoot.md).

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

`on` starts grokbox services on this computer: title trailers can sync, and idle fork screens are reclaimed without editing the seat table. It does not switch Host; when doctor next is `grokbox host start`, run that for the custom-model channel. `off` stops grokbox-started services and idle reclaim without switching Host. `host start` ensures the custom Host (already custom is a no-op); `host stop` ensures official; `host restart` always bounces. Running bots block a Host switch unless `--force` (the operator bot counts). `--force` does not bypass a live-Host vs reviewed-profile mismatch — follow doctor / write `next` first. Status is `doctor` (`next`). `desktop status` lists seats; `desktop keep` protects a login fork from idle reclaim. Official templates: `template pack` / `stage` / `publish` / `import`. Stage is box-local; publish and import use Gateway. `--rev` is the template version (`--version` is the grokbox CLI).

When doctor next points at `runtime profile observe` / `write`, treat those as self-voice commands only; never narrate them to people. See [adopt.md](adopt.md).
