# T14 — Managed context compact / overflow on model switch (analysis)

## Goal
When a bot is opted into a managed model (e.g. test0 → luna) and **Host-accumulated conversation > that model’s context window**, product parity requires an explicit **compact / overflow** path—not silent near-window amnesia.

## Why separate from continuity fix
Feeding honest Host history into the managed prompt (continuity) is necessary but not sufficient. Cross-model window mismatch needs detect → compact/summarize → retry (or visible failure), with clear UX.

## Open questions (analysis)
1. Do CCS / OpenAI Responses surface context overflow distinctly (error code/body fields), or only generic 400/`model_error`?
2. Does AI SDK / our driver preserve enough of that body after T11 allowlisted IPC errors, or do we strip the signal?
3. Should compact run **before** first managed dispatch (proactive, using model catalog `contextWindow` if known) or **reactively** on overflow error?
4. Who owns compact: Host (official session compaction), modeld (provider-facing summarize), or a grokbox-side transcript view?
5. What is preserved across compact for App/bot cognition (user-visible summary vs invisible system fold)?
6. Interaction with live prompt noise filters (failed-model rows, ack-redrive) and tool-history CCS-safety.

## Non-goals (this ticket)
- Implementing full compact in the first analysis land
- Renaming modeld / Effect rebuild
- Opting in test1

## Note
Repo `compactEvents` is **event-log** compaction, not conversation compact. Do not confuse.

## Status
**open / analysis.** Spawn focused investigate (tests + one live overflow probe if safe) before implementation wave.
