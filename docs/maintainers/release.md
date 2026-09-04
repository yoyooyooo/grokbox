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
exactly. Renaming any of them requires updating npm first. Do not set
`registry-url` on `actions/setup-node` or export `NODE_AUTH_TOKEN`: an empty
registry token makes npm skip OIDC and 404 the publish PUT. With an authenticated
modern npm CLI, read back the external configuration:

```bash
npm trust list grokbox
```

This readback confirms npm configuration visibility; only an authorized real
release proves the OIDC exchange end to end.

## Candidate gate

```bash
bun install --frozen-lockfile
bun run check
bun run shim:install
grokbox --version
grokbox doctor
```

The source-backed global shim proves the current checkout on this machine. The
package test separately proves the Node-only tarball. The manual `Release
candidate artifact` workflow produces a downloadable tarball without publishing
it.

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
