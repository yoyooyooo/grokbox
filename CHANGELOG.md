# Changelog

This project follows [Semantic Versioning](https://semver.org/). While the
version is below 1.0, documented experimental compatibility surfaces may change
when upstream Grok Bot or Cursor internals change.

## 0.1.0-alpha.8 — Unreleased

- Make Routine management owner-aware: Temporal Bots read Server-authoritative Routines through the bounded Host bridge instead of the legacy local Box store, with fail-closed authority checks.
- Add explicit webhook credential access with URL-by-default output and opt-in `--reveal-key`; support Temporal enable/disable/delete while refusing unsupported Temporal definition create/update.
- Allow up to five minutes for npm registry/provenance propagation after a successful Trusted Publishing upload.

## 0.1.0-alpha.7 — 2026-10-01

- Add bounded native Grok Bot Routine lifecycle commands under `agents routines`: list/show plus confirmed create/update/enable/disable/delete with revision preflight, same-generation readback, disabled-by-default creation, and no prompt/credential disclosure.
- Publish through GitHub Actions Trusted Publishing with npm provenance and a prerelease GitHub Release.

## 0.1.0-alpha.5 — 2026-09-04

- Published to npm `next` via web 2FA without GitHub provenance.
- Set the GitHub Actions workflow `name` to `publish.yml` so the OIDC `workflow`
  claim matches the Trusted Publisher filename.

## 0.1.0-alpha.4 — 2026-09-04

- Tagged as `v0.1.0-alpha.4`. npm OIDC exchange returned `package not found`.
- Give `npm publish` a token-free npmrc and print OIDC exchange diagnostics.
  `v0.1.0-alpha.3` still failed with `ENEEDAUTH` after stripping setup-node's
  empty `_authToken`; npm swallows a failed OIDC exchange and reports login.
- Use `https://github.com/yoyooyooo/grokbox.git` as `repository.url` so provenance
  can match the GitHub repo.

## 0.1.0-alpha.3 — 2026-09-04

- Tagged as `v0.1.0-alpha.3`. npm did not accept this version.

## 0.1.0-alpha.2 — 2026-09-04

- Tagged as `v0.1.0-alpha.2`. npm did not accept this version.

## 0.1.0-alpha.1 — 2026-09-04

- Remove machine-local evidence and private planning history from the public tree.
- Generalize contributor documentation and synthetic test identities.
- Validate a fresh macOS source-development checkout.
- Add an aggregate local check, exact-main release precheck, immutable tag push,
  registry/provenance readback, and post-publish GitHub Release automation.
- Add a maintained Simplified Chinese README and dependency update policy.
- Tagged as `v0.1.0-alpha.1`. npm did not accept this version.

## 0.1.0-alpha.0 — 2026-09-04

- Prepare the repository for public development under the MIT License.
- Mark upstream-private Gateway, Sandbox, quota, and desktop integrations as
  experimental compatibility surfaces.
- Add protected-file credential validation, CI, community documentation, and a
  repository-backed local global shim.
- Add npm Trusted Publishing with public provenance and a distinct-runner
  registry E2E lane.

## 0.0.1 — 2026-08-31

- Early npm snapshot. It predates much of the current control-plane
  implementation and is not the release represented by current `main`.
