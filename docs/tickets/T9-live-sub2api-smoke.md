# T9 — Live CCS modeld smoke (luna + grok)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**done.** Isolated Unix composite modeld, real CCS Responses spend, no Host inject.

## Setup
- Isolated temp durable/run roots (`modeldFixture`). Did not write the box durable `models.json`.
- Catalog = T8 fixture: `provider=openai-responses`, `endpoint=https://provider.example.invalid/`, `apiKeyRef=env:GROKBOX_SUB2API_KEY`.
- Keys: resolve PI `providers[name].apiKey` locally into process env only. PI may store a `!command` wrapper, not a raw bearer — export the **resolved** value as `GROKBOX_SUB2API_KEY`. Never commit keys.
  - luna: `keySource=pi:ccs-sub2api-codex`
  - grok: `keySource=pi:ccs-sub2api-xai`
- Prompt: `ping — reply with exactly: pong`

## Live evidence

| smoke | modelId | ok | dispatched | finish | text | latency |
|---|---|---|---|---|---|---|
| luna | `openai-responses/gpt-5.6-luna` | true | true | stop | `pong` | 2105 ms |
| grok | `openai-responses/grok-4.6` | true | true | stop | `pong` | 5370 ms |

Same Responses wire; switch is assignment + key ref. No `@ai-sdk/xai`.

## Code fix landed with this ticket
Unix idle/partial client timeout is **1 s**. In-flight `complete()` after a full request must not use that timer (live CCS >1 s). After a complete frame, clear socket idle timeout; kernel TTL (default 30 s) owns the wait. Host seam submit wait is `MODELD_SUBMIT_TIMEOUT_MS` (30 s). Offline test: injected 1200 ms stream still returns.

## Not this ticket
Host Agent loop (preload/T3 G1 canary). Operator can `models use` luna↔grok for **modeld admit+complete**. Host turns still need T3 live inject.
