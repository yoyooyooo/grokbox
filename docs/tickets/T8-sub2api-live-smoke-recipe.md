# T8 — Offline CCS sub2api live-smoke recipe

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**done (recipe).** Catalog + admit path only. Live spend is **T9** (isolated modeld) and grokbox test0 luna Host canary (T3). Do not re-spend CCS for this ticket.

## Why
Box PI CCS providers already speak OpenAI Responses on one sub2api host. grokbox’s modeld OpenAI driver already speaks Responses (`provider=openai-responses`, `endpoint` = SDK `baseURL`). No `@ai-sdk/xai`. Switching GPT ↔ Grok is a catalog `model` id (and maybe key), not a second SDK.

## Operator spend (not this ticket)

| role | PI provider | grokbox `model` | prefer |
|---|---|---|---|
| GPT | `ccs-sub2api-codex` | `gpt-5.6-luna` | cheap smoke |
| Grok | `ccs-sub2api-xai` | `grok-4.6` | after luna |

Both: `api: openai-responses`, PI `baseUrl: https://provider.example.invalid/` (trailing slash). Copy **keys** from PI/provider out-of-band. Never copy `~/.pi/agent/models.json` secrets into this repo.

`apiKeyRef: env:GROKBOX_SUB2API_KEY`. PI `apiKey` may be a `!/usr/bin/env sh -lc` wrapper — export the **resolved** bearer, not the wrapper string.

## Admit (already true in source)

`openAiAccepts` allows `http://` and `https://`. This recipe uses **https** only. `createOpenAI({ baseURL })` strips a trailing slash and joins `/responses`.

Durable catalog: `/workspace/.grokbox/box-runtime/models.json`. Offline fixture: `packages/box-runtime/test/fixtures/sub2api-models.json`.
