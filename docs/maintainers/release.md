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

## Rebuild qualification and first use

[LIVE](../tickets/LIVE-integration-validation.md) owns the new accepted scope and current results; the [execution guide](live-end-to-end.md) owns local verification versus concentrated E2E. Development may be incomplete or unavailable. Do not finish the retired v2 window first, keep every intermediate commit deployable, or build a compatibility/zero-downtime layer for an unused development release. Preserve native data and unknown effects; final runtime reliability remains required.

Functional Web, API, CLI and background capabilities qualify together before user acceptance and dogfooding. Visual confirmation has a separate browser exit. Package publication remains independent. Historical reports and unresolved reviews apply to their original content; reused code needs scoped revalidation, not automatic inherited approval or a blanket requirement to close every old release lane.

<a id="live-window-procedure"></a>
### Run one bounded integration window

1. **Select and freeze.** Follow the new LIVE obligations. Targeted development checks need only their affected scope; a complete functional candidate needs applicable full regression, artifact checks and independent review. Record source/content-to-artifact mapping without a fixed branch name. Integration or a passing report does not authorize live actions.
2. **Build and protect data.** Fix CLI/Server/Web/modeld/Host adapter artifacts, dependencies and actual loaded identities. Use an isolated installed candidate, not the mutable global source shim. Preserve native identities/materials/credentials and unknown external effects; import valuable configuration once as needed, fence old writers and rebuild derived indexes with explicit coverage. Generic legacy database migration, old-schema downgrade and return to continuous old-development service are not required. Establish a safe stop/recovery or qualified official-exit path before native changes.
3. **Authorize and coordinate.** Fix the installation, individual Bots/models/tools, new-message nonces, allowed mutation/stop scope, request/token/cost and waiting bounds, approval operator and rollback target. Specify which native version upgrades or high-impact resets are allowed; Host/modeld restart is not an implicit native binary or platform upgrade grant. One operator coordinates the window. Drain or fence relevant work under the existing native/control contract; unknown work is not idle. Use the supported CLI/controller lifecycle, not a second supervisor, random operation IDs, deleted ledgers or reconstructed attestations. Do not adopt an unmerged feature worktree.
4. **Observe distinct layers.** Establish native source/loaded identity and official passthrough before managed canaries; then authority, actual tool consumption, Provider/Host terminals and original-App delivery; finally the selected restart/return paths. Prefer isolated native three-route comparisons over repeated takeover of a business environment. A model response, released tool batch, approval, tool side effect, stored result, transcript delivery and App view are separate facts. Long shell waits do not prove approval-time revocation. A new service epoch must not replay an old STEP or inherit in-memory permits. Per-Bot official selection and full unpatched Host exit need their own evidence; platform Reset remains separately authorized, and generic old-schema rollback is not a rebuild obligation.
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
candidate artifacts into an isolated prefix and inspect CLI, Server/Web, modeld,
native dependencies and bundled Skills before concentrated E2E. The current build
still packages the existing CLI/runtime; CLI-05/WEB-02 must extend the real build,
input provenance and installation checks when the new apps exist, not merely add
an empty directory to the acceptance list. The manual
`Release candidate artifact` workflow produces a tarball without publishing it.

Do not include `shim:install` in an otherwise read-only candidate gate: it
changes the everyday command entry. A source-backed global shim, migration and
Host/modeld/daemon adoption belong to the separately coordinated live window,
after the affected data and safe recovery path are protected. This is not a requirement to re-adopt and restore the old development installation after each code change. Do not
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
