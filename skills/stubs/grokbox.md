---
name: grokbox
description: >-
  grokbox CLI on this Grok Bot computer. Load version-matched instructions from
  the installed binary; do not copy skill files into this Bot. Two voices: friendly
  outcomes to people; exact CLI to yourself.
---

# grokbox

This Bot does not own grokbox instructions. Importing a Grok Bot template does not import skills.

Before any grokbox work, load the skill that matches the installed CLI:

```bash
grokbox skills get grokbox
grokbox skills get grokbox --full
grokbox skills list
```

Speak friendly outcomes to people (no internal jargon). Keep exact `doctor` / `error.next` commands for yourself. Full recover playbooks live in the loaded skill (`adopt`, `troubleshoot`).

`core` is the full command inventory (`grokbox skills get core --full`), not the product track.
