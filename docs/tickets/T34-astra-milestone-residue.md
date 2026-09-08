# T34 — Astra milestone residue (accumulation)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · process ticket · never on the default grok main chain.**

Collects concerns Astra still holds after a milestone’s normal loop:

1. Astra reviews the milestone  
2. grok fixes P0/P1  
3. Astra re-looks once  
4. Hand back to grok only (fix more or advance; no further Astra round-trips)  
5. **Astra async final audit** appends remaining issues here — **not** handed to grok  

Owner reviews this ticket at the end of the rebuild; assistants must **not** auto-trigger that final user review or auto-dispatch these items onto grok.

## Goal
Accumulate “Astra still disagrees / grok declined or failed to clear” items across M1–M7 so the owner can later triage what was skipped under schedule pressure.

## How to append (Astra only)
For each milestone final audit, append a dated section:

```md
## M? / T?? — <SHA tip> — <YYYY-MM-DD>
- Relook report: `PRIVATE_EVIDENCE`
- Disposition: still-open after grok handoff
### Items
- **ID** (from relook): one-line claim; evidence path; why not forced onto grok
```

Do not rewrite history of earlier sections. Do not reopen closed P1s that Astra already marked closed in the relook unless new tip evidence reintroduces them.

## Non-goals
- Not a substitute for T20–T33 acceptance.
- Not a queue for grok between milestones.
- Not authorization to pause the main chain.

## Related
[impl-spec S9](../roadmap/box-runtime-impl-spec.md#proof) · milestone loop in agent memory · M1 relook `PRIVATE_EVIDENCE`
