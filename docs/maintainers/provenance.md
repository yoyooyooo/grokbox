# Source Provenance Review

This record supports the repository's MIT licensing decision. It is a bounded repository audit, not legal advice about provider terms or trademark law.

## Repository-owned implementation

The public tree contains independently maintained grokbox CLI, daemon, adapters, tests, and documentation. It does not include provider application binaries, reconstructed source dumps, transcripts, private operational evidence, or credentials.

The MIT license applies only to files in this repository for which the contributors hold the necessary rights. Product and provider names identify interoperability targets and do not imply endorsement or license upstream software.

## Third-party code

The published JavaScript bundle embeds Commander.js. Its MIT notice is retained in [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES) and included in the package allowlist. Bun, TypeScript, esbuild, and type packages are development dependencies and are not shipped as package files.

Re-run the bundle inventory whenever runtime dependencies or bundling change.

## Compatibility facts are not authorization

Method names, endpoints, schemas, and observed behavior support interoperability. Their presence does not imply upstream endorsement, stability, or permission to bypass access controls. [`docs/compatibility.md`](../compatibility.md) owns the public commitment.

## Public-history hygiene

The public branch begins with one reviewed initialization commit. Machine-local planning, run artifacts, private research, and pre-initialization history are excluded from public refs. CI scans every reachable commit for secrets; each release still requires a manual path, identity, and package-content review.

Use a public GitHub noreply address for release commits when author email privacy matters. Never add raw provider responses, private addresses, account identities, prompts, transcripts, credentials, or generated package archives.

## Release checks

Before a release candidate:

1. inspect new vendored or copied files and record their licenses;
2. compare bundle contents with `THIRD_PARTY_NOTICES`;
3. run full-history secret scanning and review absolute paths and environment-specific names;
4. confirm package metadata and compatibility disclaimers;
5. confirm the npm allowlist contains no private evidence or provider material.

Last reviewed: 2026-09-04. Revisit when authorship, vendored code, runtime dependencies, bundle composition, or public history changes.
