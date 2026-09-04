# Changelog

This project follows [Semantic Versioning](https://semver.org/). While the
version is below 1.0, documented experimental compatibility surfaces may change
when upstream Grok Bot or Cursor internals change.

## 0.1.0-alpha.3 — Unreleased

- Keep `setup-node` `registry-url` so npm knows the public registry, then strip
  the empty `_authToken` it writes. Removing `registry-url` entirely caused
  `ENEEDAUTH` on `v0.1.0-alpha.2` before OIDC could start.

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
