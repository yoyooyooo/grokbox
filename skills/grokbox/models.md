# Models

Load for per-Bot model selection or catalog configuration: `grokbox skills get grokbox --topic models`.

## Select a model for one Bot

**Operator / template Bot stays on the official brain. Never `models use` yourself.** Use disposable Bots for custom-model experiments, not App New Bot. Ordinary official-Bot work needs no model assignment.

```bash
grokbox models list
grokbox agents create --name "<test-bot-name>" --harness box
# Keep the created Bot ID. Do not repeat create if its outcome is unknown.
grokbox agents ownership <created-agent-id>
# Continue only when ownership is confirmed_box and the custom channel is ready.
grokbox models use <model-id> --for <created-agent-id>
```

`<model-id>` must exist in the catalog. Assignments apply to the next turn; other Bots stay unchanged. `confirmed_box` is eligibility, not a production sign-off. A rejected use does not mutate the assignment; inspect `error.code` / `error.next`. Ownership uncertainty routes to [ownership](ownership.md); Host-channel recovery to [adopt](adopt.md). Do not guess the class from `harness=` or the title.

`models use --for` also paints the selected Bot's title trailer and preserves the user title. `m=` uses its alias, otherwise the short `model` field. A title write failure does not undo the assignment; display is not routing authority. See [label](label.md).

After a requested test send, observe it through [send](send.md). State exactly what was verified: saving an assignment is not proof that a provider replied.

## Return one Bot to official

```bash
grokbox models reset --for <agent>
```

`reset` returns that Bot to official on the next turn; its harness does not change. It removes `m=` only from an already-showing trailer. This does not restore the whole computer's official Host; that separate operation belongs to [services](services.md).

## Configure the catalog only when needed

Catalog: `/workspace/.grokbox/box-runtime/models.json`, overridden by `GROKBOX_BOX_RUNTIME_ROOT`; never `~/.grokbox/runtime/`. Prefer an existing catalog entry for normal selection.

Each model has `id`, `provider`, `model`, `endpoint`, and `apiKeyRef`. `openai` / `openai-chat` use Chat Completions; `openai-responses` uses Responses API; `stub/echo` is for tests only. `apiKeyRef` is `env:NAME` or `file:/absolute/path`, never a literal key or `$VAR`. Keep secret values out of argv and ordinary logs.

MiniMax's official HTTPS `/v1` Chat endpoints use the qualified `minimax-inline-v1` dialect: inline thinking is preserved across tool turns but kept out of ordinary answer text, and known empty continuation placeholders are normalized without repairing tool names. A proxy must explicitly set `chatDialect: "minimax-inline-v1"` on its model record; `"standard"` opts out. This field is Chat-only. Do not enable `reasoning_split` independently: nonempty split state is rejected rather than silently lost. A saved assignment or endpoint qualification is not a live acceptance result.

Optional `alias` must be unique and match `^[a-z0-9][a-z0-9._-]{0,15}$`. Assignments are `assignments.agents[<bot-uuid>] = <model-id>`; route selection is per Bot, not a box-wide default. Use the CLI for assignment changes rather than editing this map by hand. Unlisted Bots stay official.

## Deliberate acceptance, not routine setup

**Stay-green after a switch** is a separate validation task: correlated reply evidence, `agents title sync` for the same Bot, then another title read after at least two minutes. Load [validation](validation.md#prove-a-model-switch) with `--topic validation` only when that sustained check is requested. An instant title is not acceptance, and a routine model task is not permission for indefinite monitoring.
