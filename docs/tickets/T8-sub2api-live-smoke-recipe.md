# T8 — Offline sub2api live-smoke recipe (no spend)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**ready / not spent.** Catalog + admit path only. Do not call `http://provider-b.example.invalid/` or any provider from this ticket.

## Why
Box PI already has two OpenAI-Responses providers on the same sub2api host. grokbox’s modeld OpenAI driver already speaks Responses (`provider=openai-responses`, `endpoint` = SDK `baseURL`). No `@ai-sdk/xai`. Switching GPT ↔ Grok is a catalog `model` id (and maybe key), not a second SDK.

## Later spend (operator, not this ticket)

| role | PI provider | grokbox `model` | prefer |
|---|---|---|---|
| GPT | `example-provider-b-codex` | `gpt-5.6-luna` | cheap smoke |
| Grok | `example-provider-b-xai` | `grok-4.6` | after luna |

Both: `api: openai-responses`, PI `baseUrl: http://provider-b.example.invalid/` (trailing slash). Copy **keys** from PI/provider out-of-band. Never copy `~/.pi/agent/models.json` secrets into this repo.

Suggested env: `GROKBOX_SUB2API_KEY` (`apiKeyRef: env:GROKBOX_SUB2API_KEY`). Same host may share one key; if PI uses distinct keys, export the one that matches the assignment.

## Admit (already true in source)

`openAiAccepts` allows `http://` and `https://` (`/^https?:\/\//i`). It does **not** require `/v1`. `stub:echo`, `wss:`, empty `apiKeyRef`, and non-openai* providers stay fail-closed.

`createOpenAI({ baseURL })` strips a trailing slash and joins `{baseURL}{path}` with `path=/responses`. So:

| `endpoint` in models.json | request URL |
|---|---|
| `http://provider-b.example.invalid/` (PI form; **recipe default**) | `http://provider-b.example.invalid/responses` |
| `http://provider-b.example.invalid/v1` | `http://provider-b.example.invalid/v1/responses` |

If a later spend 404s, try the `/v1` form. Do not probe that in this ticket.

## Catalog shape

Durable file: `/workspace/.grokbox/box-runtime/models.json` (or `GROKBOX_BOX_RUNTIME_ROOT`). There is no `models add` CLI — author the catalog, then `models use`.

Offline fixture (no secrets): `packages/box-runtime/test/fixtures/sub2api-models.json`.

```json
{
  "version": 1,
  "models": {
    "openai-responses/gpt-5.6-luna": {
      "id": "openai-responses/gpt-5.6-luna",
      "provider": "openai-responses",
      "model": "gpt-5.6-luna",
      "endpoint": "http://provider-b.example.invalid/",
      "apiKeyRef": "env:GROKBOX_SUB2API_KEY",
      "capabilities": { "vision": false, "tools": true, "images": false },
      "dataTypes": ["text", "tools"]
    },
    "openai-responses/grok-4.6": {
      "id": "openai-responses/grok-4.6",
      "provider": "openai-responses",
      "model": "grok-4.6",
      "endpoint": "http://provider-b.example.invalid/",
      "apiKeyRef": "env:GROKBOX_SUB2API_KEY",
      "capabilities": { "vision": false, "tools": true, "images": false },
      "dataTypes": ["text", "tools"]
    }
  },
  "assignments": { "main": "openai-responses/gpt-5.6-luna", "agents": {} }
}
```

`models use` ids must already exist in `models`. Prefer luna as `assignments.main` for a first smoke.

## Runbook (offline until a later spend ticket)

1. Export `GROKBOX_SUB2API_KEY` in the operator shell (from PI/provider). Not argv, not git, not fixtures.
2. Write the catalog to the durable `models.json` (merge if other models exist).
3. `grokbox runtime models check`
4. `grokbox runtime models use openai-responses/gpt-5.6-luna`  
   Switch: `grokbox runtime models use openai-responses/grok-4.6` (same provider/endpoint/env).
5. `grokbox runtime start --mode route` (ensures modeld + writes desired route). Or `activate --mode route` if modeld is already up.
6. Composite modeld **admits** openai-responses. Route session `modelId` follows `models.json` (T4e).
7. **Stop.** No Host turn, no `re-adopt`, no canary, no fetch to `mini:8319`. T3 live G1 stays gated.

`runtime start` does not spend. Spend would be a later admitted turn with a real key and `hardOff` unset — not authorized here.

## Fence
No live API, no secrets in git, no T3, no T5b/S2, no envelope/root `src/` WIP.
