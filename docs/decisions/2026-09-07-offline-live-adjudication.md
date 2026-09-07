# Adjudication — 2026-09-07 offline/live critical point

Owner judgments after two-model review/design divergence. Binding until a later dated adjudication supersedes them.

## Context
- Branch: `feat/box-runtime-v2` (offline S0–S5 landed; Effect E0 catalog + standard landed).
- Live G1 Host patch was not started at adjudication time.
- Handoff for live work continues on Raft agent `grokbox` (`/life-lees`) because Host patching can interrupt Grok Bot App turns.

## Decisions

### D1 — Ticket 13 terminal journal placement
**Keep Host append-only terminal journal for now.** Watchdog remains the sole compactor.

Do **not** migrate writers to modeld, and do **not** add Host Effect solely to close this gap, as a precondition of G1. Journal-via-modeld remains a later, separately decided contract change. Treat the Host heavy-IO path as an explicit temporary exception, not a permanent Effect exemption narrative.

### D2 — G1 timing vs Effect seams
**Identity/SHA/topology preflight → G1 stub live path** (at most one confirmed `re-adopt` + one text-only stub Gateway turn once authorized).

Do **not** require E1–E2 Effect write/coordinator migration as a gate before G1. Effect adoption continues incrementally on the same live path during later feature work, following [Effect 标准](../effect-box-runtime.md).

### D3 — Bun lock gate
**Merge/CI remains pinned to the declared `packageManager` Bun (currently `bun@1.3.14`) with `bun install --frozen-lockfile`.**

Do not raise the tool/lock to 1.4.2 / lockfile v2 as part of the critical-path work. Local newer Bun is fine for day-to-day use; claiming merge-green requires the declared version. Tool upgrades are a separate change.

## Explicit non-decisions
- No G1 execution authorization is granted by this note alone; each live attempt still needs fresh Host identity confirmation in-session.
- No M3 / real provider authorization.
- No change to stub/echo-only route admit until a later model admit decision.
