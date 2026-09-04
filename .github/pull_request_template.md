## Outcome

<!-- What user-visible or maintenance result does this change deliver? -->

## Boundaries

- [ ] Current source truth and future/experimental targets remain distinct.
- [ ] No credential, private address, provider body, prompt, transcript, Memory, or arbitrary file content is included.
- [ ] Any authority change is explicit and tested.
- [ ] Registry, help, bundled skill, and docs are synchronized when commands change.
- [ ] Dependency or bundle changes update LICENSE/THIRD_PARTY_NOTICES as needed.

## Evidence

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run verify:package`
- [ ] Dependency reality is identified: fake, local-real, or external-real.

## Residual risk

<!-- Platform gaps, upstream-private compatibility, destructive behavior, or unverified paths. -->
