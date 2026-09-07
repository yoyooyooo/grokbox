# T4e — Route Host/preload session modelId follows models.json

## Goal
Route Host session hook labels / submit `modelId` from durable `models.json` (`resolveAssignment`, T4d allowlist), not hardcoded `stub/echo`.

## Design
- Resolve lazily at session create with known `agentId` so `assignments.agents.*` overrides apply.
- Fail closed if models file missing or assignment is not stub/echo or openai*.
- Identity mode unchanged; Host/preload stay SDK-free.
- `runtime modeld run` JSON reports `driver: "composite"` instead of a fake single stub model.

## Status
**done.** `bindHostSessionHook` uses `loadModelsFileSync` + `resolveRouteSessionModel`. Seam `resolveSession` is per-agent. Offline tests cover openai main, stub, missing/disallowed, and agent override.
