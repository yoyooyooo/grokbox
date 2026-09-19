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

`<model-id>` must exist in the catalog. Assignments apply to the next turn; other Bots stay unchanged. `models use/reset` require exactly one of `--for <agent>` or `--default`; the explicit default is not a routing fallback. Use only the top-level `models` commands. `confirmed_box` is eligibility, not a production sign-off. A rejected use does not mutate the assignment; inspect `error.code` / `error.next`. Ownership uncertainty routes to [ownership](ownership.md); Host-channel recovery to [adopt](adopt.md). Do not guess the class from `harness=` or the title.

`models use --for` also paints the selected Bot's title trailer and preserves the user title. `m=` uses its alias, otherwise the short `model` field. A title write failure does not undo the assignment; display is not routing authority. See [label](label.md).

After a requested test send, observe it through [send](send.md). State exactly what was verified: saving an assignment is not proof that a provider replied.

## Choose a reasoning effort on the same channel

```bash
grokbox models use <model-id> --for <agent> --effort xhigh
grokbox models show --for <agent>
grokbox models use <model-id> --for <agent> --effort default
```

An explicit effort must appear in that record's `capabilities.reasoning.efforts` whitelist. Missing capability is unknown, `false` means unsupported; both refuse explicit effort before ownership/catalog I/O and saving. The CLI never changes endpoint, credential or wire model to obtain an effort. Allowed wire vocabulary is `none|minimal|low|medium|high|xhigh|max`, but each channel supports only its declared subset. `none` is not `default`. A `reasoning: true` flag or an OpenAI-compatible endpoint alone proves no whitelist.

Omitting `--effort`, or specifying `default`, clears the prior override and sends no explicit effort; it does not guess the provider default. Existing TURNs retain their captured policy; the next TURN uses the new selection. `models show` reports configured-next-turn data, not current execution. The title adds `e=<effort>` independently of `m=`; default/official clears it. Emitted effort, Provider execution and token usage are distinct evidence, not guaranteed by the title or model self-report.

## Return one Bot to official

```bash
grokbox models reset --for <agent>
```

`reset` returns that Bot to official on the next turn; its harness does not change. It removes `m=` and `e=` only from an already-showing trailer. This does not restore the whole computer's official Host; that separate operation belongs to [services](services.md).

## Configure the catalog only when needed

Human catalog entry: `~/.grokbox/models.json`. On a Box it aliases the installed durable `models.json`; resolve the actual path with `grokbox config path --physical --document models`. The runtime reads the canonical file, never the CLI install tree. `models *` owns model writes; generic `config set` does not edit this document. Prefer an existing catalog entry for normal selection; see [config](config.md) for layout and migration.

Each model has `id`, `provider`, `model`, `endpoint`, and `apiKeyRef`. `openai` / `openai-chat` use Chat Completions; `openai-responses` uses Responses API; `stub/echo` is for tests only. `apiKeyRef` is `env:NAME` or `file:/absolute/path`, never a literal key or `$VAR`. Keep secret values out of argv and ordinary logs.

MiniMax's official HTTPS `/v1` Chat endpoints use the qualified `minimax-inline-v1` dialect: inline thinking is preserved across tool turns but kept out of ordinary answer text, and known empty continuation placeholders are normalized without repairing tool names. A proxy must explicitly set `chatDialect: "minimax-inline-v1"` on its model record; `"standard"` opts out. This field is Chat-only. Do not enable `reasoning_split` independently: nonempty split state is rejected rather than silently lost. A saved assignment or endpoint qualification is not a live acceptance result.

Optional `alias` must be unique and match `^[a-z0-9][a-z0-9._-]{0,15}$`. Schema v2 assignments are `assignments.agents[<bot-uuid>] = { "modelId": "<model-id>", "reasoning": { "effort": "high" } }` (reasoning is optional); route selection is per Bot, not a box-wide default. Use the CLI for assignment changes rather than editing this map by hand. Unlisted Bots stay official.

## Schema upgrade is a maintenance operation

Readers normalize old v1 string assignments in memory without writing. Explicit model saves write v2; `grokbox models migrate --confirm` performs that normalization without changing model identity or adding effort. Before any v2 save on an existing deployment, a maintainer must protect the old configuration and coordinate compatible CLI/preload/Host/modeld artifacts and verify the loaded protocol; the model schema number does not establish wire compatibility. Old CLI readers reject v2 rather than silently dropping settings. No automatic root relocation, credential copy, Host restart or downgrade occurs. Rollback restores the matching old artifact and its protected old-schema snapshot together; it is not deleting effort fields.

For a local record, capability declaration is `"capabilities": { "reasoning": { "efforts": ["low", "medium", "high", "xhigh"] } }` only when qualified for that exact endpoint/API/wire model. Pi imports can supply an explicit identity `thinkingLevelMap`; numeric budgets, lossy level mapping and booleans are not accepted as effort qualification. An administrator's declaration authorizes a request shape, not a claim that the gateway honors it. Never add guessed capabilities merely to bypass a refusal.

## Deliberate acceptance, not routine setup

**Stay-green after a switch** is a separate validation task: correlated reply evidence, `agents title sync` for the same Bot, then another title read after observing the scheduled refresh. Load [validation](validation.md#prove-a-model-switch) with `--topic validation` only when that sustained check is requested. An instant title is not acceptance, and a routine model task is not permission for indefinite monitoring.
