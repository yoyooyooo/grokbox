# Models

Catalog: `/workspace/.grokbox/box-runtime/models.json` (override `GROKBOX_BOX_RUNTIME_ROOT`, never `~/.grokbox/runtime/`).

Each model: `id`, `provider`, `model`, `endpoint`, `apiKeyRef`.

- `openai` / `openai-chat` → Chat Completions
- `openai-responses` → Responses API
- `stub/echo` → tests only

`apiKeyRef` is `env:NAME` or `file:/absolute/path`. No literal keys, no `$VAR`.

`alias` is optional, unique, `^[a-z0-9][a-z0-9._-]{0,15}$`. Label `m=` uses **alias if set, else the short `model` field**. Official brain omits `m=`.

Assignments: `assignments.agents[<bot-uuid>] = <model-id>`. Unlisted Bots stay official. Route mode uses per-Bot assignment, not a box-wide default.

```bash
grokbox models list
grokbox models use <model-id> --for <agent>
grokbox models reset --for <agent>
```

`reset` returns that Bot to official next turn; harness unchanged.

`models use --for` requires `confirmed_box`. Other ownership classes refuse before writing; `error.next` is the remediation. See [ownership.md](ownership.md).

`models use --for` also paints that Bot's App title trailer (`m=`), keeping any user title. Official `reset --for` drops `m=` only if a trailer is already showing. Title is display-only; a failed title write does not undo the assignment.

**Stay-green after a switch (dogfood Bot):** `models use` then one send is not done. Watch with `history outcome --nonce … --runtime` (no success-ish without that proof). Check App title / `agents show` for `m=<alias-or-model>`. Run `agents title sync`, wait at least two minutes, and check `m=` again. Instant green is not enough. Procedure: [SKILL.md](SKILL.md#prove-a-model-switch).

**Operator / template Bot:** stay on the official brain — never `models use` yourself. Create disposable Bots with `grokbox agents create` for custom-model experiments. Host recover when the channel is down: [adopt.md](adopt.md).
