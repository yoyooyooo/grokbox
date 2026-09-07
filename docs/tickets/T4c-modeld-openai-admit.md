# T4c — Default modeld admits OpenAI via composite + minimal C1

## Goal
Wire `createOpenAiModeldDriver` into the **default** `startStubModeldServer` / CLI (`modeld run`, `runtime start`) path as a **composite** with stub, plus a minimal credential slice so openai* models with `apiKeyRef` can pin/fingerprint offline-safely.

## Why T4b stopped short
T4b shipped the driver factory only. Default Unix/CLI driver stayed stub-only so route activate / spend fences were not accidentally widened. This ticket opens **modeld admit** only.

## Fence (keep)
1. **Route activate / `assertRouteAssignment` stay stub-only** — fail-closed on non-stub assignments. Product contract unchanged: route mode admits only `stub/echo` until a later ticket.
2. No reckless live spend; tests stay offline (mock fetch / injected `streamEvents` / `hardOff`).
3. Do not fold unrelated dirty WIP (official-chain*, coordinator/h3/live-readopt/transient-adopt, reviewed-copy, root `src/`).

## Deliver
1. **Composite `ModeldDriver`**: `accepts` = stub OR `openAiAccepts`; `complete` dispatches; stub path still `STUB_ECHO_PARTS`.
2. **Default `startStubModeldServer`**: when caller omits `driver`, use composite (not stub-only). Injected `driver` unchanged.
3. **Minimal C1 for default server**:
   - `credentialFingerprint` via `createFileEnvSecretResolver` → sha256 hex (never secret in pin/IPC/parts)
   - `resolveApiKey` for OpenAI from the same resolver (lazy; stub never calls)
4. Document: modeld can admit openai* if `models.json` assigns an openai* model with https endpoint + `apiKeyRef`; route activation still refuses non-stub. Listing openai models without assigning them to route remains allowed by parse.
5. Tests + docs; full C1/S2 still **T5**.

## Status
**done.** `modeld-default.ts` provides `createCompositeModeldDriver` / `createDefaultModeldDriver` / `createDefaultCredentialFingerprint`. Default Unix/CLI path uses composite + lazy file/env C1 slice. Route activate remains stub-only. Offline tests cover stub echo, openai admit + fingerprint, missing key → `credential-unavailable`, `hardOff`, and SDK fence (Host/preload/seam/ipc have no direct `ai` import).
