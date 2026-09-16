# T44 — One modeld acquisition and service lifetime

Status: implemented and offline verified; independent review pending. Milestone M1. Depends on: [T43](T43-modeld-authority-baseline.md). Spec: [S10.2, S10.5](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Make ensure/start/CLI lifetime consume one service acquisition program. Retain owned versus borrowed semantics, exact root/epoch fencing, interrupt-safe acquisition and bounded cleanup. This is a structural replacement, not another daemon or a Promise/Effect mode switch.

## Module / files

- `packages/box-runtime/src/internal/roots/modeld.runtime.ts`: one acquisition/lifetime Effect; Promise host facade runs it.
- `packages/box-runtime/src/internal/modeld/server.node.ts`, `unix-listen.node.ts`: bounded socket/STEP scopes and shutdown observation.
- Existing lifecycle/start/failure/packed tests plus focused new lifecycle tests as needed.
- Add `lifecycle` to `scripts/verify-modeld-core.mjs` only when the required tests exist.

## Required behavior

An already running root-qualified service is borrowed, never stopped by a caller's cancellation. A new service is owned by the root, and readiness is not published before resources and finalizers are registered. Typed failures, defects, interruption before the first instruction and unexpected listener death settle readiness/finished truthfully. Stop rejects new work, ends owned request/source lifetimes, then closes listener/storage in bounded order. A finalizer that has not actually ended is a cleanup gap, not successful release.

Keep native callback adapters thin; no per-request Layer/Runtime construction or business retry inside socket code. Keep J13 journal placement and existing CLI public verbs.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- lifecycle
```

Required existing tests include `modeld-start-failure`, `modeld-running-failure`, `modeld-lifecycle`, `modeld-root-identity`, `modeld-service-info`, `runtime-start`, `runtime-start-lifetime`, `modeld-packaged-lifecycle`, and `runtime-start-packed`. Add a regression that both entrypoints use the same acquisition behavior for ready/failure/borrow/stop without source-only string assertions.

Cover pre-aborted signal, acquisition partial failure, listener lost during readiness publication, stop reentry, cleanup timeout and competing socket protection. Real temporary Unix sockets and packed Node child processes must stay within fixture-owned roots. Ordinary release counts reach zero; injected release failure remains explicit.

## Forbidden / non-goals

No dependency upgrades, broad HTTP/RPC framework migration, live Host signal, competing socket deletion, global process sweep, duplicate service implementation or effectMode. Do not remove the Promise public handle merely to reduce runPromise counts; remove duplicated orchestration beneath it.

## Exit evidence

`ensureModeld` and `startModeldProcess` now consume the same private service-lifetime Effect. Owned/borrowed readiness and the original resource cleanup paths remain in that single program; the Promise facade only runs/observes it. The new parity tests exposed and corrected another ownership error: a borrowing handle must not report its external owner's shared listener counter as its own cleanup failure.

Bun 1.3.14 typecheck passed. `verify:modeld-core lifecycle` performs a fresh build before testing and passed 82 tests across 11 suites, including four new two-entrypoint parity tests and actual packaged Node lifecycle/start cases. The initial cold worktree lacked dist; the verifier now builds the current source rather than relying on leftovers. Source failure/defect/interruption, listener loss, repeated stop, competing path and borrowed-owner behavior were exercised.

The complete repository regression then passed 1929 tests, with 5 explicit native-source qualification skips and 0 failures across 248 files. A separate package install/Node-entry check passed all 6 tests. The first full run caught the expected stale preload SHA fixture: build provenance embeds the changed root/package inputs even when the Host behavior is unchanged. The fixture was updated from an actual fresh build and its reject-old/byte-drift negative tests passed; no assertion was weakened.

Independent fixed-tip review remains pending. No live service replacement, dependency upgrade or wire/policy change occurred.
