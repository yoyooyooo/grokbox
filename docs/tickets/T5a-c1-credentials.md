# T5a — C1 credentials productization (modeld Effect scope)

## Goal
Replace ad-hoc double `createFileEnvSecretResolver` calls in `modeld-default.ts` with one modeld-owned credential module. Effect owns resolve IO; Promise facades only at `ModeldPorts.credentialFingerprint` and OpenAI `resolveApiKey`.

## Design
- `packages/box-runtime/src/modeld-credentials.ts` parses `apiKeyRef` via `parseApiKeyRef`.
- Bounded materialization: env missing/empty-after-trim fails; file is `O_NOFOLLOW` regular file, ≤ 4 KiB, valid UTF-8, one `String.prototype.trim()`.
- `fingerprintSecret` is SHA-256 hex. Secret never enters pin/IPC/parts/`StreamPart`.
- Driver `resolveApiKey` **re-reads** the same Effect (no pin-scoped secret cache).
- Stub path never calls the module. Host/preload/seam/ipc stay Effect-free and SDK-free (lazy `import()` from `modeld-default.ts`).
- Not E3: listener/admit/TTL stay Promise. Not T5b/S2.

## Status
**done.** Offline bun@1.3.14 tests cover env/file hit-miss, size/non-regular, stable fingerprint, openai admit with injected env, resolve re-read, hardOff, Host Effect fence.

## Fence
No S2 frames, no full modeld E3 rewrite, no T3 live/re-adopt/canary/spend, no unrelated WIP.
