---
name: grokbox
description: >-
  Operate grokbox on a Grok Bot cloud computer: check status, manage Bots,
  send messages, or use custom models. Start with this small entry; load
  only the capability needed with `grokbox skills get grokbox --topic <name>`.
---

# grokbox

Unofficial CLI for a Grok Bot **cloud computer** you own or are authorized to use. Alpha; not affiliated with Cursor, xAI, or Grok Bot. Report changes and remaining uncertainty.

## Default operating loop

1. Understand the requested outcome. For status or target discovery, use the read-only checks below; no custom-model setup is needed for ordinary official-Bot work.
2. Resolve `<agent>` to an exact ID or unique name. Before an unfamiliar action, load **one matching topic** below and use the command's `--help` for flags.
3. Inspect the result. Follow `doctor` / `error.next` exactly **within the authorized task**; a suggested command is not permission to interrupt Bots or widen access.
4. Report the observed result, not merely the command receipt. Stop when the requested task is done; do not turn a one-off check into a monitoring loop.

```bash
grokbox doctor
grokbox agents list --table
```

## Always keep these boundaries

- **Stay on the official brain.** Never change your own model. Custom-model experiments belong on disposable Bots created through `grokbox bot create --input @file --preview` followed by its reviewed submission, and require `confirmed_box` ownership.
- **Queued is not delivered.** A send receipt means queued, not a reply. Keep `clientNonce`; use `history outcome` for that same send. Do not resend just to check progress. Read `send` before sending.
- **Changes need scope.** Use CLI lifecycle commands, not App New Bot or ad-hoc state edits. Do not force a Host switch, delete data, or publish a template without the relevant authorization. Uncertain writes need inspection, not blind replay.
- **Protect people and secrets.** Explain outcomes plainly; provide technical evidence when requested. Never expose credentials, private transcripts, or raw provider material in ordinary output or logs. Do not claim recovery or completion without evidence.

## Load by capability, not all at once

```bash
grokbox skills get grokbox --topic models
```

`--topic <name>` returns only that companion, matched to the installed CLI. Repository links follow; installed users use the CLI selector.

| When the task needs… | Topic |
| --- | --- |
| Services on/off, custom channel, package alignment | [services](services.md) |
| Send a message and check its reply | [send](send.md) |
| Assign/reset a model or configure the catalog | [models](models.md) |
| Search scoped Memory/Project documents or read/edit authorized text files | [materials](materials.md) |
| Show/hide the model in a Bot title | [label](label.md) |
| Inspect desktop seats or protect a login fork | [desktop](desktop.md) |
| Pack, stage, publish, or import a template | [templates](templates.md) |
| Inspect, enable, pause or remove an existing native Routine | [routines](routines.md) |

**Escalate only when needed:**

| Trigger | Topic |
| --- | --- |
| Inspect or change configuration, or migrate an old installation | [config](config.md) |
| Custom-model ownership is blocked or unclear | [ownership](ownership.md) |
| A command fails or doctor reports a problem | [troubleshoot](troubleshoot.md) |
| Doctor explicitly requires Host recovery | [adopt](adopt.md) |
| Missing/conflicting runtime evidence or an error STEP | [diagnostics](diagnostics.md) |
| Deliberate canary / sustained model-switch acceptance | [validation](validation.md) |

`grokbox skills list` discovers available topics. `grokbox skills get grokbox --full` is an explicit all-topics reference, **not startup reading**. For capabilities outside this operator guide, use command `--help`; `grokbox skills get core --full` is the complete CLI inventory.
