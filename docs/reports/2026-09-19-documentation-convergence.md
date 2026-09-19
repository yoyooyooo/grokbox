# 2026-09-19 — Source-first documentation convergence slice

This is a fixed report of a documentation-only working-tree change, not a live result, independent review or declaration that every conflict has been removed. The work began from a clean `feat/box-runtime-v2` at `4181e5ec822b6a199681822c7b597710c1195a44` on the isolated branch `docs/astra-source-convergence`. Changes were written to that worktree and remain uncommitted; no merge, push, tag, publication or live adoption was performed.

## Applied scope

AGENTS/CONTEXT and the main documentation map now route by task. Product, architecture and Effect rules were rewritten around current source ownership rather than staged construction narratives. Version-sensitive configuration has one guide linked to actual schema/version/policy sources, with its JSON example validated against production validation.

Concern-oriented runtime contracts now own execution, context, continuity, operations, Host compatibility and cross-domain acceptance. They preserve V01–V30, CTX-A01–A16, CTX-R01–R07, R01–R06, HSO/HCR, F/E and CONT responsibilities without copying current live results. Old monolithic Spec paths retain stable anchors and route to the new owners.

Archive stores retired rebuild, compact, external-session and review explanations, including exact recovery of committed originals at the source baseline. Existing fixed verification reports remain at their stable paths because LIVE and receipt validation consume them. No raw private source, credentials or business transcripts were imported; no old report outcome was upgraded to a current pass.

Current-state/notification distinctions, already-implemented sender, fixed evidence query, retired normal-function compact gate, and existing cooperative configuration CAS were corrected in the affected contracts/guides. T53's remaining combined Routine work no longer implies the whole project lacks pairing or notification. T34 retains remaining qualification responsibilities rather than an old model-specific review ceremony; later scoped closures are preserved in the archive.

`check:docs` adds repository-local link/fragment and explicit-anchor checks, actual-schema example validation, direct current routes, retained acceptance IDs and archive discovery. LIVE parser tests use controlled status fixtures and the actual current result rather than freezing a real scenario at `not-run`. The production receipt parser and its safety/path restrictions were not loosened.

## Known incomplete scope

Two requested writes were rejected by the tool safety check and were not retried through another path:

- `docs/tickets/README.md`: the intended domain-qualified, route-only index was not applied. Its older repeated status/ordering statements remain to be reconciled.
- `docs/roadmap/box-runtime-plan.md`: replacement of the old phase plan with its historical route was not applied. Its old construction instructions remain in that file.

The archived source and new contracts do not make those two edits completed. An optional combined inventory read was also rejected; no claim relies on that call succeeding. These facts prevent a blanket “all conflicts converged” conclusion.

During verification, the integration branch advanced to `6bf4f61b897f6bae8a0e08883466ab52eda4686e` through `da8e673` and `6bf4f61`, adding staged Bot lifecycle/handover and corresponding qualification. This worktree's source remains the original fixed base. Those commits change the registry, continuity schema/programs, CONT-03/07/08, current-state guide and LIVE. Reconciliation must occur on a matched source baseline before this documentation is treated as current for that newer integration tip; do not simply change prose to new implementation claims while retaining the old runtime source.

## Verification actually observed

Toolchain: Bun 1.3.14 via `npx --yes bun@1.3.14`, matching packageManager; actual Node v22.22.0. This is not a fresh execution on every supported minimum/platform runtime.

| Check | Observed result and scope |
| --- | --- |
| Frozen dependency install | `npx --yes bun@1.3.14 install --frozen-lockfile` succeeded in the isolated worktree |
| Documentation/LIVE checks | `npx --yes bun@1.3.14 run check:docs`: 21 pass, 0 fail; latest recorded run 1,227 assertions |
| Typecheck | Passed after adding explicit null/undefined guards to the changed test; the initial two type errors are not counted as a pass |
| Build | `npx --yes bun@1.3.14 run build` passed |
| Related regression and packaging | 118 pass, 0 fail, 963 assertions across modeld-core-verifier, outcome, AH92, AH97, skills and packaging tests; includes real isolated tarball installation and both Node aliases |
| Final combined rerun | 139 pass, 0 fail, 2,190 assertions across the same nine files: the 21 documentation/LIVE cases plus the 118 related cases, not additional independent coverage. Typecheck and publication checks passed again afterward |
| Whole default test invocation | `npx --yes bun@1.3.14 test` hit the tool's 300-second timeout; no complete receipt obtained, not a whole-suite pass or a diagnosed test failure |
| Process observation after timeout | No test process with its working directory inside this worktree was found; the check is not a global process census |
| Publication/privacy | `node scripts/check-publication.mjs --include-untracked`: ok, 1,125 blobs, no findings in the final combined check, including new docs/tests and this report |
| Whitespace/integrity | `git diff --check` passed |
| Runtime/live changes | Diff over `packages`, `skills`, `.agents` and the LIVE index was empty; no current live row was changed |

Targeted regression command:

```bash
npx --yes bun@1.3.14 test test/modeld-core-verifier.test.ts test/outcome.test.ts test/ah97-followups.test.ts test/ah92-admit-observation.test.ts test/skills.test.ts test/packaging.test.ts
```

Before adding this fixed receipt, docs changed from 210 Markdown files / 2,030,802 bytes at the base to 224 files / 1,500,461 bytes. More concern files with less duplicated prose is intentional; file count is not an acceptance goal. AGENTS, CONTEXT and docs/README had 31, 29 and 31 lines respectively. These measurements describe that recorded slice, not future repository limits.

## Not proven or performed

No independent review conclusion, full-suite completion, new native/Provider/App/long-running qualification, live service restart, model spend, identity/data migration, cleanup of business objects, Git publication or integration of the concurrently advanced v2 is claimed. The two rejected writes remain unapplied. Source-first precedence and [documentation maintenance](../maintainers/documentation.md) govern further reconciliation; [LIVE](../tickets/LIVE-integration-validation.md) remains the sole live result owner.
