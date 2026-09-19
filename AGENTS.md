# Agent instructions

Work from the requested outcome. Repository documents, specs, skills, comments, tests and code are hypotheses, not proof of correctness. Reproduce disputed behavior through the current entry point; check upstream claims against a current primary source or a scoped native execution. Keep unsupported claims **unverified**.

- Distinguish user intent, observed behavior and proposed changes. An implementation or a passing test can encode the same mistake as its spec.
- Remove disproven assumptions and unnecessary workarounds. Keep only reusable reasons, evidence limits and commands; do not add a new comprehensive spec to explain a cleanup.
- Use [CONTEXT](CONTEXT.md) and [documentation](docs/README.md) to locate the affected code. Read only relevant material.
- In an isolated worktree, finish authorized edits and checks without routine reconfirmation. Preserve unrelated work and report actual results.
- Run from the repository root. Toolchain/dependency declarations are in [package.json](package.json) and [bun.lock](bun.lock). Use `bun run check:docs`, targeted `bun test <files>`, `bun run typecheck` and `bun run build` as applicable. A structural check is not behavioral proof.
- Keep credentials, private Host code, provider dumps and transcripts out of this public repository and ordinary output. Public tests must run without private research.
- Check actual writers and process/resource owners before changing runtime behavior. [Architecture](docs/architecture.md) and [Effect guidance](docs/effect-box-runtime.md) describe intended boundaries; investigate contradictions rather than making code conform by assertion.
- Live changes need the task's authorization and identified targets/recovery. A merge, test, old receipt or suggested command grants none. Do not switch active services or the global shim to a feature worktree.
- For an authorized integration window, use the [live-validation Skill](.agents/skills/grokbox-live-validation/SKILL.md). [LIVE](docs/tickets/LIVE-integration-validation.md) indexes reported evidence; re-observe affected claims before relying on them.
- Public bugs/proposals use GitHub Issues; security reports follow [SECURITY.md](SECURITY.md).
