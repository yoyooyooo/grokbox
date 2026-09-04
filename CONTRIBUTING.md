# Contributing to grokbox

Thanks for helping improve grokbox. The project is currently alpha and its
upstream-private compatibility adapters may change without notice.

## Start here

1. Read [`CONTEXT.md`](CONTEXT.md) and [`docs/README.md`](docs/README.md).
2. Discuss user-visible behavior in a GitHub issue before a large change.
3. Never include real credentials, private provider bodies, prompts,
   transcripts, file contents, tailnet addresses, or account identities.

Public reports and proposals belong in GitHub Issues. Machine-local plans and
operational evidence are not tracked in this repository. Security reports
follow [`SECURITY.md`](SECURITY.md).

## Development

Requirements: Bun 1.3.14 and Node.js 20 or newer.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify:package
```

Use fake providers for writes. Real-provider validation requires explicit
owner authorization and must retain only bounded, redacted evidence.

## Pull requests

- Keep current source truth separate from accepted targets and runtime
  observations.
- Add tests for changed behavior, including refusal and redaction paths.
- Update the registry, help, bundled skill, and docs together when a command
  changes.
- Record platform and dependency reality: fake, local-real, or external-real.
- Do not broaden Gateway, daemon, filesystem, process, Sandbox, quota, SSH, or
  Tailscale authority as an incidental change.
- Confirm `bun run release:check` passes and the worktree contains no generated
  package archive or credential artifact.

By contributing, you agree that your contribution is licensed under the MIT
License in [`LICENSE`](LICENSE).
