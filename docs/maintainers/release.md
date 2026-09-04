# npm Release Runbook

`grokbox` publishes from `.github/workflows/publish.yml` only. The workflow uses
npm Trusted Publishing (GitHub Actions OIDC) and emits npm provenance; no npm
token belongs in GitHub secrets or workflow configuration.

## One-time configuration

1. Keep the GitHub repository public so npm can attach public provenance.
2. Create the GitHub Actions environment named `npm`.
3. In npm package settings, configure `yoyooyooo/grokbox`, workflow
   `publish.yml`, environment `npm`, with publish permission.
4. Keep account and package 2FA enabled; Trusted Publishing replaces only the
   automation token.
5. Enable GitHub private vulnerability reporting and required CI checks.

The npm trusted-publisher owner, repository, workflow filename, and environment
must exactly match the workflow. Renaming any of them requires updating npm
first.

## Candidate gate

```bash
bun install --frozen-lockfile
bun run release:check
bun run shim:install
grokbox --version
grokbox doctor
```

The global shim is source-backed and proves the current checkout on this
machine. The package test separately proves the Node-only tarball. The manual
`Release candidate artifact` workflow produces a downloadable tarball without
publishing it.

## Publish

1. Complete declared external acceptance holds or narrow release claims.
2. Review [`provenance.md`](provenance.md), `LICENSE`, and
   `THIRD_PARTY_NOTICES` against the final bundle.
3. Confirm full-history secret scanning and verify that no machine-local evidence or private research is tracked.
4. Confirm the package version, changelog, generated help, and intended tag.
5. Merge the exact release commit to `main` and wait for CI.
6. Create and push the matching immutable tag, for example:

   ```bash
   git tag -s v0.1.0-alpha.1 -m "grokbox v0.1.0-alpha.1"
   git push origin v0.1.0-alpha.1
   ```

7. Watch `Publish to npm`. The workflow rejects a tag that differs from
   `package.json`. Prerelease versions publish under `next`; stable versions
   publish under `latest`.
8. Verify the registry version, both executables, integrity, and npm provenance.
9. Install that exact registry version on a distinct external runner and run the
   external harness with `GROKBOX_EXTERNAL_PACKAGE=grokbox@<version>`.

Never publish from a maintainer laptop as a fallback. If OIDC, environment, tag,
or verification fails, leave the version unpublished, diagnose the boundary,
and create a new version rather than reusing registry state.
