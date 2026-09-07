# T4d — Route activate admits openai* (offline)

## Goal
Widen route desired/activate / models assignment checks so `runtime start --mode route` and `activate --mode route` accept `stub/echo` **or** openai* records `openAiAccepts` would admit.

## Admit
- `stub/echo` (unchanged)
- openai*: provider `openai` | `openai-chat` | `openai-responses`, http(s) endpoint as baseURL, non-empty `apiKeyRef` (`env:` / `file:`), not stub

Fail-closed otherwise.

## Fence
- No T3 live G1 / re-adopt / canary / Host patch / real spend
- Seam/Host stay SDK-free; Host hook still does not read `models.json`
- S2 / full C1 remain T5
- Default assignment stays stub; this is allowlist widen only

## Status
**done.** `assertRouteAssignment` / `assertStubOnlyRouteAssignments` / `routeHasNonStubAssignment` treat openai* as admitted. Seam IPC accepts modeld's non-stub `modelId`. Coordinator left unedited: it already calls `routeHasNonStubAssignment`. Offline tests cover stub, openai activate, acme denied, missing key/endpoint, modeld route driver submit.
