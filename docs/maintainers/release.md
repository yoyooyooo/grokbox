# npm Release Runbook

`grokbox` publishes from `.github/workflows/publish.yml` only. The workflow uses
npm Trusted Publishing (GitHub Actions OIDC) and requests npm provenance. No npm
token belongs in GitHub secrets, repository files, or a maintainer fallback
command.

## Release state machine

```text
release version committed on main
  -> local precheck proves HEAD == origin/main and version is unused
  -> immutable v<version> tag points to that exact commit
  -> one serialized GitHub-hosted Actions lane checks and packs the tag
  -> monotonic npm OIDC publish (prerelease -> next, stable -> latest)
  -> registry version/channel/provenance readback
  -> GitHub Release creation
```

A successful CI run, npm publication, provenance, GitHub Release, and external
host validation are separate claims and must be checked separately.

## One-time configuration

1. Keep the GitHub repository public so npm provenance can be publicly verified.
2. Create the GitHub Actions environment named `npm` and restrict deployments
   to tags matching `v*`.
3. In npm package settings, configure the Trusted Publisher with:
   - owner: `yoyooyooo`
   - repository: `grokbox`
   - workflow filename: `publish.yml`
   - environment: `npm`
4. Keep account and package 2FA enabled. Trusted Publishing replaces only the
   automation token.
5. Enable GitHub private vulnerability reporting and required CI checks.

The npm owner, repository, workflow **filename**, and environment must match
exactly. Renaming any of them requires updating npm first. The publish step
must use a token-free npmrc: `setup-node` `registry-url` writes an empty
`_authToken` that 404s the PUT, and a failed OIDC exchange is swallowed as
`ENEEDAUTH`. With an authenticated modern npm CLI, read back the external
configuration:

```bash
npm trust list grokbox
```

This readback confirms npm configuration visibility; only an authorized real
release proves the OIDC exchange end to end.

## Cross-worktree native/live acceptance

Current live progress, missing proof, blockers and receipt links are maintained **only** in [`LIVE — the end-to-end acceptance checklist`](../tickets/LIVE-integration-validation.md). Its [release lanes](../tickets/LIVE-integration-validation.md#release-lanes) distinguish core use, default unattended reminders, selected extensions and deferred scope. The [live E2E runbook](live-end-to-end.md) supplies candidate/object/budget records, the six provider-effort cells, real compact/tool oracles and the Webhook-to-reminder journey; it is not a second status table. Feature tickets own semantics, implementation and independent review; dated reports own immutable evidence. Coverage and supported-model claims must match the exact runtime and tested cells. npm release/tag authority remains separate.

<a id="live-window-procedure"></a>
### Run one bounded integration window

1. **Select and freeze.** Read the relevant LIVE rows and their source contracts. Complete code, offline/native-isolated qualification and independent review in the feature worktree; map the actual source commits onto one fixed `feat/box-runtime-v2` candidate. A rebase/cherry-pick needs a verified mapping, not a branch-name assertion. Rerun affected combined tests. Neither integration nor a report grants deployment permission.
2. **Build and protect the recovery path.** Record CLI/preload digests, source/profile/transformed SHA, native version, wire/schema/policy and locked dependency versions. Identify whether the global CLI is a source shim: its next invocation may change after Git integration although resident processes have not changed. Preserve fixed, usable old artifacts and configuration before stopping anything. General `config migrate` and `models migrate` have separate contracts; do not rewrite model bytes or credential references as an incidental general migration. Preview exact roots, fingerprints, conflicts, aliases and old writers; unresolved conflicts or unconfirmed old-writer shutdown block application.
3. **Authorize and coordinate.** Fix the installation, individual Bots/models/tools, new-message nonces, allowed mutation/stop scope, request/token/cost and waiting bounds, approval operator and rollback target. Specify which native version upgrades or high-impact resets are allowed; Host/modeld restart is not an implicit native binary or platform upgrade grant. One operator coordinates the window. Drain or fence relevant work under the existing native/control contract; unknown work is not idle. Use the supported CLI/controller lifecycle, not a second supervisor, random operation IDs, deleted ledgers or reconstructed attestations. Do not adopt an unmerged feature worktree.
4. **Observe distinct layers.** Establish native source/loaded identity and official passthrough before managed canaries; then authority, actual tool consumption, Provider/Host terminals and original-App delivery; finally the selected restart/return paths. Prefer isolated native three-route comparisons over repeated takeover of a business environment. A model response, released tool batch, approval, tool side effect, stored result, transcript delivery and App view are separate facts. Long shell waits do not prove approval-time revocation. A new service epoch must not replay an old STEP or inherit in-memory permits. Per-Bot official selection, full unpatched Host exit, old-schema rollback and platform Reset each need their own evidence.
5. **Stop, reconcile and record.** Stop the affected lane on unexpected identity/version, budget, duplicate inference/effect, failed oracle or unknown mutation; do not enlarge the target set or retry old messages. Recover only through the selected, identity-checked path, preserving later user edits and unknown outcomes. Deleting effort fields is not lossless downgrade; restarting does not cancel temporal children or roll back external side effects. Verify actual post-recovery owners and loaded state, and clean only owned, settled test resources. Record cleanup_required/unknown rather than inventing closure. Write the dated evidence report and update each affected LIVE row with proved scope, exact residual, blocker and next action; a single restart cannot close unrelated rows.

Each window report must retain source→integration mapping; planned and actually loaded identities; native/wire/schema/policy; target and nonce/STEP correlation; permissions and actual consumption; per-oracle results; stopping, recovery and cleanup outcomes. Raw credentials, private prompts, dumps and machine-local evidence locations stay outside the public repository; use controlled receipt references and sanitized summaries. Missing App images, native consumer evidence or Provider-reported effort remains not-observed/unknown.

Specific safety and operation contracts remain in [configuration](../configuration.md), [authority boundaries](modeld-authority-boundaries.md), [tool/Host execution](host-inbound-agent-loop.md), [Provider qualification](chat-provider-compatibility.md), [outcome observation](run-outcome-observation.md), [App acceptance](composer-working-status.md) and [official rollback](official-rollback-acceptance.md). Template Ops/CTX source tickets still own their not-yet-implemented execution contracts. This procedure creates no `verify --live-all`, automatic publisher or standing maintenance permission.

## Candidate gate

```bash
bun install --frozen-lockfile
bun run check
bun run check:publication
bun test test/live-e2e-checklist.test.ts test/modeld-core-verifier.test.ts
```

Use the pinned package manager and the fixed candidate. The checklist tests are
structure and command-routing checks, not live proof. Install the resulting
Node-only tarball into an isolated prefix and inspect its `grokbox`/`gbox`, native
dependencies and bundled Skills before any production adoption. The manual
`Release candidate artifact` workflow produces a tarball without publishing it.

Do not include `shim:install` in an otherwise read-only candidate gate: it
changes the everyday command entry. A source-backed global shim, migration and
Host/modeld/daemon adoption belong to the separately coordinated live window,
after runnable old artifacts and configuration recovery are preserved. Do not
let concurrent worktree merges change the next CLI invocation mid-window.

## Prepare and publish

1. Complete declared external acceptance holds or narrow release claims.
2. Review [`provenance.md`](provenance.md), `LICENSE`, and
   `THIRD_PARTY_NOTICES` against the final bundle.
3. Confirm full-history secret scanning and verify that no machine-local
   evidence or private research is tracked.
4. Update `package.json` to the exact intended version and update
   `CHANGELOG.md`. Commit and merge that release state to `main`.
5. Wait for required CI on the exact `main` commit.
6. From a clean, up-to-date `main`, run the no-write precheck:

   ```bash
   git switch main
   git pull --ff-only origin main
   bun run release:precheck -- 0.1.0-alpha.2
   ```

7. After reviewing the printed commit, version, tag, and npm channel, authorize
   the tag push. Precheck also refuses a version that would move its npm channel
   backward:

   ```bash
   bun run release -- 0.1.0-alpha.2
   ```

   The command creates one annotated tag and pushes only that tag. It never
   invokes `npm publish` locally.
8. Watch `Publish to npm`. A new tag must point to the exact current
   `origin/main` commit. The workflow rejects package-name or version mismatch.
9. Verify:

   ```bash
   npm view grokbox@0.1.0-alpha.2 version dist.integrity dist.attestations --json
   npm view grokbox dist-tags --json
   gh release view v0.1.0-alpha.2
   ```

10. Install that exact registry version on a distinct external runner and run
    the external harness with `GROKBOX_EXTERNAL_PACKAGE=grokbox@<version>`.

## Failure and repair

Published npm versions and pushed release tags are immutable.

- If precheck fails, make no tag; repair the release commit and rerun checks.
- If tag-triggered validation or publish fails before npm accepts the version,
  diagnose the boundary and prepare a new version. Do not move or delete the
  public tag.
- If npm publish succeeds but registry readback is delayed, rerun the same
  workflow only after checking npm directly.
- If npm and provenance are visible but GitHub Release creation failed, dispatch
  `publish.yml` on the original immutable tag ref:

  ```bash
  gh workflow run publish.yml --ref v0.1.0-alpha.2 -f tag=v0.1.0-alpha.2
  ```

  The manual lane is repair-only: the npm version must already exist, the tag
  must remain reachable from `main`, and the expected npm channel must still
  point to that version. It compares the tagged local package integrity with the
  registry and binds the provenance subject, repository, workflow ref, and Git
  commit before creating the missing GitHub Release. It never republishes or
  repoints a channel.
- Never publish from a maintainer laptop as a fallback.
