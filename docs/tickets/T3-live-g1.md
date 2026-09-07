## Goal
When explicitly authorized, run G1 live stub path: identity/SHA preflight → at most one `re-adopt --confirm` → at most one stub text canary.

## Gates (human phrases)
- `可以预检` / `可以补丁` / `可以 canary`
- No real model / no second dangerous call without fresh `继续` after hard fail

## Blockers until ready
- Offline STEP contract credible (see sibling land ticket)
- W-LOAD / W-DELIVERY / G2 safe-input still called out as gaps — do not fake green

## Driver
Herdr only after human gate phrases. Do not self-open.
