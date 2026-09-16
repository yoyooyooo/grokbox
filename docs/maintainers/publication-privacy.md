# Publication privacy

Publication covers the selected branch's entire reachable history, not only its latest files. This is separate from native runtime qualification or permission to operate a live service.

## Allowed public material

Keep the upstream protocol and product names, standard box-layout defaults, public dependency and repository links, license notices, and synthetic test fixtures. A supported platform path is not a developer checkout path. Example endpoints must be clearly non-production, and example execution identities must be synthetic.

Do not publish credentials, real tailnet names, developer checkout paths, private research locations, machine execution diaries, transcripts, real agent/run/session identifiers, process inventories, backup bundles, or private author/committer email addresses. Preserve private evidence outside the repository with restricted permissions. Ignoring a file does not remove its already committed history.

## Local gates

```sh
bun run check:publication
bun run check:publication:history
```

The first command checks tracked working files. The second reads every reachable commit and unique file object from `HEAD`, including deleted historical files and author/committer metadata. It refuses shallow history and unreviewed binary content. Reports contain rule names and locations, not matched secret values. Commit identities must use a verified GitHub no-reply address or an explicit non-deliverable publication identity; never guess another contributor's GitHub address.

The repository's existing full-history Gitleaks job remains a separate gate. Gitleaks and the publication rules are complementary, not proof that arbitrary sensitive data is impossible. Use full-object secret scanning when preparing a history rewrite, especially for merge-only content or older deleted versions. Public licenses and upstream attribution must not be erased to make a scanner green.

## Scoped history rewrite

Record the exact branch tip, remote tip, other refs, worktree state, and local-only files before starting. Save and verify a restricted backup outside the repository. Preserve uncommitted work and running services. Perform object rewriting in an isolated bare repository; review the resulting tree, commit map, parent topology, and tests before updating the original branch with an expected-old-tip check.

Keep the original commit sequence and existing merges unless a separate topology change is requested. Keep a private old-to-new commit map. Do not publish that map or a pre-cleanup bundle. Build and package checks must use an isolated snapshot when the source worktree supports running services.

Force-push only the reviewed branch, with a recorded expected remote tip:

```sh
git push --dry-run --no-follow-tags \
  --force-with-lease=refs/heads/<branch>:<expected-remote-commit> \
  origin <reviewed-clean-commit>:refs/heads/<branch>
```

A dry run does not update the remote. Actual publication needs explicit authorization and the same guards. Do not use `--all`, `--mirror`, or push tags during a branch-scoped cleanup. A changed remote tip requires reconciliation, not an unconditional force push.

## Remaining copies

Rewriting one branch does not clean other branches, tags, pull-request refs, forks, clones, server caches, local reflogs, or private backups. Do not merge an old branch into the sanitized branch: that can reintroduce the original history. Rebase or selectively reapply reviewed changes onto the clean history instead.

Rotate or revoke an exposed live credential; rewriting Git does not revoke it. Coordinate any wider repository purge and provider-side cached-reference removal separately. Do not delete other worktrees or run shared-object garbage collection as part of a branch-scoped operation.
