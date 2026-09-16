---
name: grokbox
description: >-
  Agent-operated grokbox on a Grok Bot cloud computer: friendly speech to people,
  exact CLI to yourself. Use when installing or recovering grokbox, host
  start/stop, doctor next, custom models on disposable Bots, templates, title
  trailers, or watching a send. Always load via `grokbox skills get grokbox` first.
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

1. **Remote the official product** — Profile, `grokbox doctor`, `agents list`, `send`, then `history outcome --nonce … --runtime`. Done when doctor and list succeed; a send is not done at the receipt.
2. **Custom model on this computer** — `grokbox on`, recover Host channel per [adopt.md](adopt.md), create box Bots with grokbox (not App New Bot), `agents ownership` is `confirmed_box`, `models use --for <disposable-agent>`, optional `title show`. After a grokbox package update: `grokbox upgrade --yes`.

App New Bot is often **temporal** and never uses the custom-model channel. Details: [ownership.md](ownership.md). Title paint: [label.md](label.md). Catalog: [models.md](models.md). Failures: [troubleshoot.md](troubleshoot.md). **Host recover after official update:** [adopt.md](adopt.md).

## Host recover (summary)

When doctor / `error.next` says the custom channel needs a Host update:

1. Follow `next` exactly: observe → write; if write rejects on drift, follow that `next` (often analyze then `--slice-review`). Analyze may settle `missing_runner` and still names reject ids plus write `next`. Then `grokbox host start`.
2. `--force` only when start/stop refuse because bots are running **and** that pause is accepted.
3. If the path is **unrecoverable** → `grokbox host stop` (back on official channel), tell the person you’re on the official channel and waiting for a maintainer. Do **not** thrash `--force`.

Full decision tree: [adopt.md](adopt.md). Short table: [troubleshoot.md](troubleshoot.md).

## Watch a send

One canary path. `clientNonce` is your handle. Do not invent a second id.

```bash
grokbox send <agent> --text "<text>" --json
# Keep data.clientNonce. data.accepted / data.status=accepted means queued, not a reply.

grokbox history outcome <agent> --nonce <clientNonce> --runtime [--wait-ms 60000] --json
```

Read outcome `data.state`. Outcome has **no** `accepted` token (`acceptedObserved` is gone). `data.requestId` may be null on an early failure — that is not “never sent”. Empty `data.alerts` is not success. `--runtime` reads the local journal (failure authority). If modeld was started with an explicit `GROKBOX_RUN_ROOT`, pass the **same** value to `history outcome --runtime` and inspect `evidence.runtimeRoot`. Root mismatch, permissions, malformed records, partial append and retention are different gaps; do not attribute every `runtimeGap` to the root. Large journals are byte-windowed rather than rejected wholesale. `--wait-ms` keeps polling until `failed`, `delivered`, or `expected_result_observed`; `recorded` is not settled. `--request-id` looks up the **same** send, not a second handle. An error banner's model STEP can be queried directly with `history outcome <agent-id> --step-id <step-id> --runtime --json`; it is not necessarily the first display request-id. There is no `alerts list --nonce`.

Read `assessment` and `evidence` alongside state. A known runtime gap prevents a mere progress reply from qualifying the observation as settled delivery; actual delivery remains in `delivery`. A correlated explicit failure still wins even with a partial window. `runtimeFailure.diagnostic` gives the fixed rejection site/cause when instrumented; `runtimeTrace` is bounded, not a raw provider dump. Native trigger/lineage facts do not authorize a retry. Tool materials released are not proof of tool execution or checkpoint commit. Writer-health snapshots are timestamped evidence, not current process-liveness proof.

| `data.state` | You | Person hears |
| --- | --- | --- |
| `recorded` | Echo or journal bind only. Keep waiting. | “Queued; still waiting for a reply.” |
| `failed` | Durable reject / terminal / live tray. Empty alerts do not undo this. Paraphrase `runtimeFailure.message` if present. | “The Bot couldn’t reply.” |
| `progress` | A message showed up; expected text did not. | “Working…” |
| `delivered` | A same-request reply is on the transcript. | “There’s a reply.” |
| `expected_result_observed` | Exact `--expect-text` appeared. `executionCompleted` stays `not_proven`. | “Got the expected result.” |
| `unknown` | Missing or conflicting evidence. | “Can’t tell from this check.” |

Retry a send only with the same `--nonce` and the same target/prompt.

## Prove a model switch

Long-lived dogfood Bot only (`model-dogfood`). Not yourself. A send receipt or an immediate title paint is not enough: the App name must still show the model after a title refresh.

```bash
grokbox models use <model-id> --for model-dogfood
grokbox send model-dogfood --text "<text>" --json
# Keep data.clientNonce. data.accepted / data.status=accepted means queued, not a reply.

grokbox history outcome model-dogfood --nonce <clientNonce> --runtime [--wait-ms 60000] --json
grokbox agents show model-dogfood --json
# data.agent.title (App Label) must include m=<alias-or-model>.

grokbox agents title sync
# Wait at least two minutes (one daemon title refresh), then show again. m= must still be there.
```

Read outcome `data.state` with the table above. Do not call the switch successful on `recorded`, empty alerts, or a title that looks right only in the first second.

| You | Person hears |
| --- | --- |
| outcome delivered / expected, and `m=` stayed after the wait | "Switched the dogfood Bot. There's a reply. The name still shows which model it uses." |
| outcome `failed` / `unknown` | say the outcome table line; do not claim the switch worked |
| `m=` gone after the wait | "The name dropped the model tag; that is a title-refresh bug, not a successful switch." |

## Commands

Prefer each command's `--help`. `<agent>` is an exact ID or a unique name.

```bash
grokbox doctor
grokbox send <agent> --text "<text>" --json
grokbox history outcome <agent> --nonce <clientNonce> --runtime --json
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
