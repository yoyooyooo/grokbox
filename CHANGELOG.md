# Changelog

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

This project follows [Semantic Versioning](https://semver.org/). While the
version is below 1.0, documented experimental compatibility surfaces may change
when upstream Grok Bot or Cursor internals change.

## 0.1.0-alpha.6 — Unreleased

- Recheck the same management principal's current `messages.write` after message preflight and before native `sendPrompt`. Revocation or subject change during native reads does not dispatch; retained receipts and replay are not new write authority. Disconnect does not cancel an admitted send; Server shutdown aborts and settles the owned transport.
- **Breaking runtime configuration/protocol:** models schema v2 uses structured per-Bot assignments and wire v7 preserves reasoning-token usage. Read-only v1 normalization does not write; explicit saves/migration require coordinated CLI/preload/Host/modeld upgrade and a protected rollback configuration. Older peers remain diagnostic-only; no data-root relocation or automatic live cutover.
- Add capability-gated `models use --effort`, configured-only `models show --for`, and `models migrate --confirm`. Keep the same channel/model identity, freeze policy in TURN selection/revision, validate cold restore and final HTTP effort, preserve bounded SDK warnings and requested/emitted evidence, and show optional `e=` without inventing catalog variants.

- Preserve finite native ownership-read subcodes, checkpoints, timings and budgets through admission, v5 failure summaries, Host errors, journals, incident/alert queries and monitor conditions. Distinguish unavailable evidence from proven access denial; never infer missing historical causes or replay work.
- Keep aggregate and standalone modeld status consistent about observer/service protocol drift, uninstrumented execution, scope mismatches and generation changes. A diagnostic legacy probe does not authorize execution or replacement, and does not claim the loaded Host's protocol is known.

- CLI/daemon title sync preserves `m=` when models.json is missing or the assigned record cannot be resolved; only a confirmed empty assignment clears it. Host profile writes keep the same contract, including a non-UUID agentId.
- Teach the canary send watch as `send` then `history outcome --nonce … --runtime`.
  Outcome `data.state` has no `accepted` token; send receipt `accepted` means queued only.
- `runtime profile analyze` still settles `missing_runner` when no Agent runner
  is installed, but now emits write-gate envelope reject ids and an executable
  `write --sha` / `--slice-review` `next` so Host recover can continue after
  reject-on-drift.
- Embed the full live Host source SHA in doctor/operator/ownership `next` for
  `source_mismatch` observe→write remediations. If the digest is unknown, `next`
  is observe-only; never leave a `<sourceSha256>` placeholder.
- Converge Unix modeld on one generation-bound admission/pinning kernel. Bind
  requests to compiled Host identity and a service-incarnation fence; resolve
  per-Bot config inside modeld, pin immutable config/fingerprints, and reject
  mismatches before driver effects. Bound wait/TTL/ledger/client lifetimes,
  cancel uncertain work without retry or official fallback, and preserve active
  socket owners. Offline stub/fake proof only; no provider credentials/egress or
  live Host patch, and production IPC remains response-only.
- Add a frozen, bounded Host message/state/tool/options envelope and an incremental
  single-producer session with independent completion, late-reader replay and
  visible cancellation/errors. Preserve tool ids without a second Host tool loop;
  carry envelope hashes through stub IPC conflict checks. Scripted offline stream
  proof only: production stub remains response-only and provider-hard-off.
- Separate desired/actual runtime status: disabled while patched remains pending,
  with no new Host writer. Read coordinator/journal/contract/event facts with
  explicit missing/bad-file evidence, bounded metadata-only contracts and logs,
  and route/modeld/topology checks. Reject unimplemented `log --follow` explicitly;
  label `models check` as schema-only. Offline/fake proof only.
- Bind transient-adopt receipts to pinned profile bytes and actual compile hashes,
  PID/start and operation identity. Read back canonical attestation/journal, check
  route modeld readiness independently, and preserve aggregate signals/committed
  evidence on partial failure. Fence uncertain attempts rather than retrying;
  fake/disposable verification only, no live Host/provider claim.
- Share first-signal admission across manual identity/route refresh: replay the
  exact reviewed target against source bytes, require H3 launch capability,
  canonical ownership/topology, gateway and settled journal before launch
  preparation or signals. Recheck under the operation lock; keep generation
  dedupe/budget and matching-target no-op. Fake tests only; no live cutover.
- Close offline `runtime profile write --from <host-bundle>` authoring: validate
  two exact slices and recomputed source/transformed hashes, then read back and
  sync private per-writer profile staging before atomic `reviewed.json` publication.
  No retained full-bundle copy; source/output aliases and changed input fail closed.
  Failed staging stays unpublished for operator cleanup; concurrent successful
  writers are last-rename-wins. Authoring is not patch approval. No live Host
  inject, TERM, or re-adopt.
- Stub-route Host executor `stream()` returns synchronously with independent
  `fullStream` / `response` / `usage` waiters, trim-able `response.modelId`,
  a `messages` array on success and error, camelCase usage including
  `totalTokens`, and Array `getMessages()` / `getState()`. Confirmed
  `runtime re-adopt --confirm` can refresh an already-route Host when the
  reviewed profile SHA changes while ownership and `diskSha` still match;
  watchdog without `--confirm` stays zero-signal `route_mismatch`. No live
  Host cutover.
- Route `createSession` returns a Host-shaped session (`getModelId` /
  `getExecutor`) and the existing agent-id slice also writes
  `invocationId: inferenceRequestId`. Identity still returns
  `originalSession` unwrapped. No live Host re-adopt.
- Split the repo into unpublished workspaces `packages/cli` and
  `packages/box-runtime` while still publishing a single `grokbox` package.
- Add box-local `runtime *` / `runtime models *` Agent CLI, offline Host
  transform fixtures, and a fake PromptSession contract. No live Host inject.
- Add fake-tree inject/guardian, modeld admission, and watchdog contract
  snapshots with stale-patched heal. Still no live Host inject.
- Add compile-hook transform on tmp copies and live-bundle copy H1. Live Host
  path is refused unless explicitly allowed; Host body is not in git.
- Identity inject protocol is tested on a fake process tree (STOP/CONT/census).
  Live Host is not injected.
- Land-now 06 safety kernel: exclusive lock, reviewed SHA, independent
  guardian child, supervisor-owned replacement, fail-closed deactivate,
  activate remains desired-only. No live Host inject.
- Guardian armed handshake before STOP; marker after successful compile;
  non-public H3 composition uses reviewed SHA, pickLaunchEnv, and real preload.
- H3 uses fresh diskSha reads, identityLaunchFields for replacement env, and
  mandatory attestation persist/read-back before coverage attested.
- Non-public live H3 adapter fills `/proc` ports and preflights unique official
  chain plus reviewed SHA; public `runtime activate` stays desired-only.
- Wire v2-safe live transient-adopt: allowlisted `identityLaunchFields`, logical
  adoption proof, SIGCONT-only guardian, no official SIGKILL.
- Adopt handoff waits for `gateway.json.pid` to match the identity Host before
  TERM temp / CONT wrapper; stale gateway aborts `recovery-required`.
- `runtime status` classifies `host.origin` / `host.reason` from canonical
  attestation and named grokbox env only; `deactivate` no longer claims live
  `coverage: none`.
- Offline `runtime watchdog run` reconciles desired identity on fake trees via
  transient-adopt. Public activate stays desired-only; unattested Hosts are
  recovery-required with zero signals. No live Host cutover.
- Watchdog cutover journals phases before signals, reclaims a stale coordinator
  lease, proves temp-Host ownership, and requires a different direct official
  Host after legacy-adopted deactivate. No `/tmp` attestation import.
- Add box-local `runtime re-adopt --confirm` as an explicit one-shot into the
  same coordinator. Public activate stays desired-only; watchdog remains the
  automatic writer. No live Host re-adopt.
- `runtime re-adopt --confirm` is the only public CLI root that wires live
  adopt ports and the durable reviewed profile. Matching SHA stays a no-op;
  exact ownership with a stale `diskSha` admits one manual re-adopt.
  Watchdog/activate stay non-mutating. No live Host re-adopt was executed.
- Publish Node-runnable runtime helpers beside the CLI bundle (`preload.cjs`,
  `guardian-child.cjs`, `injector-hold.cjs`, `grokbox-temp-supervisor.cjs`) so
  packed `runtime re-adopt --confirm` can resolve them. No live Host re-adopt
  was executed.
- Pin box-runtime live state to `~/.grokbox/run` even when `XDG_RUNTIME_DIR` is
  set. Explicit `ephemeralRoot` remains the test override. Daemon/Profile
  sockets stay on the existing XDG contract. No live Host REDACTED_PROCESS_ID.
- Retry GitHub Actions Trusted Publishing now that npm `grokbox` has a
  `repository` field from the `0.1.0-alpha.5` web publish.

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
