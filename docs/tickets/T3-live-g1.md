# T3 — Live G1 path

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Goal (original)
When explicitly authorized: identity/SHA preflight → at most one `re-adopt --confirm` → at most one stub text canary.

## Status
**done (live, luna not stub).** grokbox test0 `00000000-0000-4000-8000-000000000114` replies via modeld `openai-responses/gpt-5.6-luna` and Host `SendToUser` (bounded `pong` canary). T12 green: create-bot and uncovered bots still official after adopt. grokbox test1 stays official until opted in.

Original stub-only canary was superseded by the luna opt-in; do not reopen for a stub ping.

## Fence
No extra Host re-adopt for E3/T5b unless a later ticket requires it.
