# T43 — Authority responsibility audit and executable baseline

Status: in progress. Milestone M0. Depends on: accepted [ADR](../decisions/2026-09-16-modeld-effect-core.md). Spec: [S10.1–S10.3, S10.8](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Freeze what modeld must own, what it introduced unnecessarily, and what is actually established about native execution authority. Establish a reproducible baseline before changing production mechanisms. Do not use line counts or the presence of Effect imports as architecture proof.

## Module / files

- `docs/maintainers/modeld-authority-boundaries.md`: source-backed responsibility and native coverage matrix.
- `scripts/verify-modeld-core.mjs`: finite proof entry invoking existing production-path tests.
- `test/modeld-core-verifier.test.ts`: invalid/missing-case and isolation checks.
- `package.json`, Spec/index routes: expose the command, not a new framework.

## Decisions and forbidden changes

Current native per-Agent/per-TURN revocation coverage is not proven; preserve Server evidence and local fences. Do not replace them with allowed/bound or titles. Native source material stays private. Do not change Effect/SDK/Bun/storage pins, deploy Host, invoke a model, create a polling task, or claim latency improvement without measurement.

## Acceptance

Run with the declared Bun version:

```bash
bun run typecheck
bun test test/modeld-core-verifier.test.ts
bun run verify:modeld-core -- baseline
bun run check:publication
```

The baseline invokes real existing ownership-scope/cache, ownership-admission, native-pause, modeld lifecycle and architecture tests. The runner must fail unknown cases, empty/missing required suites, wrong toolchain and subprocess failure; pending cases are not green placeholders. Output explicitly says synthetic capabilities/real local protocol versus native/live not qualified. Do not duplicate the production classifier inside the verifier.

The matrix distinguishes self-owned policy/implementation, necessary integration, external trigger, proven native defect and unresolved attribution, plus independent severity. Each candidate gate removal needs the exact replacement fact and its invalidation proof. Current conservative preservation is a completed decision, not permission to block all other work indefinitely.

## Non-goals

Full live three-route comparison, new provider qualification, patch update automation, UI fixes and native task cleanup. Those are separate evidence surfaces; this ticket does not close T37/T39/T40.

## Exit evidence

Pending: baseline commands, commit and independent review. Documentation is accepted target/source audit only until executable exits are recorded.
