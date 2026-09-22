# Desktop management: complete source intake for the parallel v2 baseline

2026-09-22. Source integration and scoped verification, not live desktop qualification or runtime adoption. The user requested all remaining work from the original management worktree be committed and linearly integrated into `feat/box-runtime-v2`, rather than leaving unpublished dependencies for parallel Agents. This package follows `1e22c04e`; deferred VOICE planning was preserved separately in `827859cb`. No pending desktop source is intended to remain only in the old worktree.

## What is included

The original desktop classifier and helper manager now live in `packages/runtime-kernel/src/desktop.ts` and `packages/box-runtime/src/internal/io/desktop.node.ts`. `packages/server/src/desktop.ts` owns their management lifetime. CLI, shared client and `/desktop` use this domain; the old desktop command file, ordinary daemon desktop RPCs, Profile capability promises and implicit on/off/upgrade reclaim toggles have exited. The original native Bot-deletion seat cleanup remains a distinct D/F responsibility, not a second ordinary prune API hidden under a compatibility alias.

Manual and automatic reclaim share the same protected per-display records. Admission and dispatch are retained before helper effects; a different UUID, another principal, a restarted service or an automatic tick cannot replay an unresolved action. Reads, policy changes, helper effects and historical queries have separate permissions. Policy changes use the canonical config writer, not a new desktop preferences file.

The inherited implementation includes the four reproduced boundary fixes: installation floor and policy revisions are rechecked after dispatch declaration; a seating-table or display-instance replacement during source scanning makes the observation incomplete. Helper completion is not an atomic native seat lease. Ordinary reclaim does not unseat or delete a Bot; helper effects may remove the fork's browser profile.

## Failures found and corrected during intake

The first current targeted run produced 130 pass / 5 fail. Two operator tests still required `screenIdle`; three Profile tests still required `host.desktop.read`. The tests now require those retired fields to be absent. The `on` case also reads actual configuration before and after and asserts that desktop preferences were not changed; the fix did not restore implicit automatic-reclaim authority.

The expanded run produced 327 pass / 3 fail. Two configuration tests asserted the old error wording. A third incorrectly upgraded a prepared receipt solely from current content equality, contradicting the already implemented original configuration writer. The tests now assert `config_commit_unknown`, unchanged config and receipt bytes, and refusal after reopening the store. No production configuration replay or recovery rule was relaxed.

CLI/Skill examples, configuration guidance, architecture, command mapping and the LIVE primary-route table now use the implemented management commands. The Node desktop suite is included in `test:web` and the existing host-health integration inventory; no new acceptance framework or retired writer was introduced to obtain green tests.

## Executed checks

Node 22.22.0 and repository-declared Bun 1.3.14 were used. These are scoped integration results, not a whole-repository or all-native signature.

| Check | Actual result |
| --- | --- |
| Root and Web typecheck | Passed |
| Desktop/client/config/CLI/daemon/architecture cross-regression | 330 pass, 0 fail, 20 files |
| Wrapped actual Node desktop suite | 23 internal scenarios, 0 fail, 0 skip; included in the 330 |
| Relocated production Chrome, console group | 56 internal test nodes, 0 fail, 0 skip; state/host groups not rerun in this intake |
| Production build and tarball installation | Build passed; 7 packaging tests passed |
| Documentation/actual CLI coverage/validation harness | 15 pass, 0 fail; rechecked with the intake report and revised route cards |
| Working-tree publication scan including untracked files | 1,575 text blobs, no findings; includes all desktop source and the separately committed VOICE plan |

The fixed desktop suites exercise actual Node HTTP, protected config publication, retained action records and real process SIGKILL at claim/dispatch/effect boundaries. Native facts and reclaim ports are isolated. Separate source/helper cases use disposable files, Unix display sockets and owned helper children. They do not stop a user's display. Internal Node/Chrome counts must not be added to their wrapping test counts.

Useful exact rerun entry points:

```bash
bun run typecheck
bun run typecheck:web
bun run check:docs
bun test test/desktop-management.test.ts test/desktop.test.ts packages/client/test/desktop-contract.test.ts apps/web/test/operations.test.ts test/profile.test.ts test/operator.test.ts packages/box-runtime/test/unified-config-store.test.ts
bun test test/web-browser.test.ts -t 'qualification \(console\)'
bun run build
bun run verify:package
node scripts/check-publication.mjs --include-untracked
```

## Remaining ownership, not a missing worktree dependency

[F](../roadmap/agent-first-cli/routes/f-system-lifecycle.md) inherits the desktop implementation from v2 for system/host closeout. [D](../roadmap/agent-first-cli/routes/d-native-product.md) and F still need to converge the native deletion/seat-cleanup ownership. [W](../roadmap/agent-first-cli/routes/w-web-console.md) inherits the existing page and browser journey rather than rebuilding it. Real helper/platform qualification, conditional native seat semantics and final candidate/soak remain separate [LIVE](../tickets/LIVE-integration-validation.md#live-optional-capabilities) obligations.

[Q](../roadmap/agent-first-cli/routes/q-integration-and-qualification.md) verifies the final clean worktrees and matching committed tips at fast-forward. Source integration does not mean J2/J3/J4 is approved. The current Host/worker adaptation, runtime roundtrip and actual persistent service owner remain on the runtime-first critical path.

No push, release, Host/modeld adoption, global-entry change, real desktop cleanup, model call or external notification was performed in this intake. Unfinished product capability is retained as an explicit source-ticket obligation, not as uncommitted files outside the common baseline.
