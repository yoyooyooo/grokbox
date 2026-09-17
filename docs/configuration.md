# Configuration

`grokbox config` is the shared, schema-checked interface for preferences and client connections. Models remain a separate document and are changed through model commands. Configuration reads never start services or repair files.

## Two human entry points

| Entry | Contents | Physical storage |
|---|---|---|
| `~/.grokbox/config.json` | Client Profiles, daemon policy, desktop preferences, runtime desired mode and ops preferences | On a Box: the installed durable root's `config.json`; on a client: the local file |
| `~/.grokbox/models.json` | Model catalog, credential references and per-Bot assignments | On a Box: the existing durable root's `models.json`; a client does not synthesize this file |

On a Box, the home entries are managed aliases. The default durable root is `/workspace/.grokbox/box-runtime`; the installed layout and explicit root selection must agree. The CLI writes beside the physical file, not on top of its alias. A detached alias or a different installed root is a conflict, not an instruction to merge files.

```bash
grokbox config path
grokbox config path --physical
grokbox config path --physical --document models
```

The CLI install tree `~/.grokbox/runtime/` is not configuration. Runtime sockets and short-lived process evidence remain in the run root. Existing model secret references, retained Host sources and reviewed profiles do not move with configuration.

## Document shape

```json
{
  "schemaVersion": 2,
  "client": {
    "currentProfile": "default",
    "profiles": { "default": { "transport": "auto" } }
  },
  "desktop": {
    "idleReclaim": { "enabled": false, "minIdleMs": 600000 },
    "keepAgentIds": []
  },
  "runtime": { "desiredMode": "disabled" },
  "ops": {
    "enabled": true,
    "preset": "user",
    "presetRevision": 1,
    "monitor": { "enabled": true, "deepReplay": false },
    "diagnostics": { "mode": "on-request" },
    "maintenance": { "mode": "off" },
    "targets": { "default": { "enabled": true } },
    "routing": { "enabled": false, "defaultTarget": "default", "rules": [] }
  }
}
```

Only `schemaVersion` and `client` are required. An absent document is read as the built-in client default without being created. Present ops leaves override the pinned user/maintainer preset; there is no additional overrides document. `--effective` resolves requested defaults, not a deployment or authorization claim. The ops execution and native Webhook work has its own [implementation tickets](tickets/README.md#template-ops-automation); accepting its preferences does not implement or enable those workers.

Client Profiles use camelCase fields under `client.profiles`: transport, serverUrl, daemonTokenRef, daemonSocket, gatewayUrl, gatewayTokenRef, gatewayHeadersRef, gatewayDiscovery, sshHost, sandbox and quota. The [product contract](product-contract.md#52-profile-字段) owns connection semantics. `profile add/update/use/remove` uses the same configuration writer and does not create a second Profile file tree.

## Read, validate and change

```bash
grokbox config get desktop.idleReclaim.enabled
grokbox config get ops --effective
grokbox config schema desktop
grokbox config validate --file /absolute/path/candidate.json
grokbox config set desktop.idleReclaim.minIdleMs 900000
grokbox config set ops.diagnostics.mode --string on-request
grokbox config unset desktop.idleReclaim.minIdleMs
```

Values are strict JSON or an explicitly selected `--string` / `--value-file`. Duplicate decoded keys, unsafe property names, unknown schema fields, incorrect types, invalid references and out-of-range values are rejected. Desktop idle time remains 600000–86400000 milliseconds; configuration consolidation does not change reclaim policy.

Use dotted paths for ordinary fields. For a map key containing dots, use RFC6901 syntax, for example `/client/profiles/work.v2/transport`. Arrays are replaced as whole values, not modified through numeric path indices. Every array replacement, including one nested in a replaced parent, requires `--replace --expect-revision <observed-sha> --confirm`. Prefer `desktop keep add/remove` for a single Agent.

Full-document `config apply --file <file>` requires the expected revision and confirmation. `config preset ops maintainer --preview` previews preset selection; applying requires confirmation. Explicit leaves are preserved unless a confirmed revision-bound reset is requested. Presets do not grant maintenance, publish issues or change models. Changes that expand network policy, data access, recipient identity or automation cost require confirmation.

`config get` redacts credential references and sensitive identities. `config export --portable` removes installation identities, secrets and grants, and resets nonportable runtime selection. An export is a preference transfer, not a deployable authenticated installation. No generic configuration key can manufacture a binding receipt, daemon verifier, floor entry, Host attestation or issue consent.

## Scope and result

Client preferences belong to the initiating machine. Box changes require a qualified local installation. With a remote Profile selected, choose the intended destination explicitly: `--scope local` or `--scope target`. The latter requires a supported target configuration capability; until that capability is available the command refuses without writing the initiating machine. Environment-selected Profiles receive the same guard.

The writer serializes cooperative mutations, rereads under lock, checks expected revision, validates the complete candidate, writes a protected temporary file, fsyncs and renames the canonical file, then reads it back. A stable operation ID supports reconciliation after a lost output. Different input with the same operation ID is a conflict. A prepared operation may be confirmed only when its exact after-state is present; otherwise it stays unknown and is never replayed over another edit, even when the content hash has returned to the original value. External same-UID writers do not acquire this lock; the model is cooperative concurrency, not a malicious-process sandbox.

Receipts distinguish two independent outcomes:

| Commit | Application |
|---|---|
| `committed` or `unchanged` with operation ID and config revision | `not-required`, `pending`, `applied` or `restart-required` |

Desktop adopts its own dependency revision on its scheduled tick or after a domain mutation. Its acknowledgement includes exact process identity. `config` queries do not acknowledge on its behalf. A different client/ops preference does not invalidate an already adopted desktop revision. Other consumers without a matching acknowledgement remain pending; a daemon launch-policy change requires an independently authorized restart.

```bash
grokbox config set desktop.idleReclaim.enabled false --wait-applied --timeout-ms 65000
```

Application wait is bounded to 1–120000 milliseconds. A timeout returns `config_apply_pending` with the committed operation and revision; it never silently reverts the preference, repeats a signal or starts a consumer. Startup, Host adoption, Provider requests and user delivery each require their own proof.

## One-way migration and recovery

Old global/Profile/daemon/desired files are accepted only by the migrator. Normal readers do not merge old paths or keep them as fallback writers.

```bash
grokbox config migrate --role box --durable-root /absolute/durable/root --preview
```

Review the returned digest, source fingerprints, planned destination, conflicts and active writers. Applying the same plan requires `--apply --plan-digest <sha> --confirm` and the same explicit options. A changed source, unresolved conflict, unsafe alias or active old writer blocks publication. A conflict choice such as `--prefer canonical` is part of the reviewed plan, never inferred from timestamps.

Models already at the physical root retain their exact bytes and secret references. The migrator validates the current schema without normalizing away provider-specific fields. Bootstrap-stage configuration is not automatically preferred over actual installed state. Backups are protected and old intent files are retired only after the new publication reaches its recorded activation phase.

The migration phase is durable: prepared, publishing, published, activated, retired. Use `config migrate --status` to inspect and `--recover --confirm` to resume a recorded plan. A user edit after partial publication is a conflict rather than something recovery may overwrite. Restoring an old backup must not revive authorization or signal a Host.

`config recover` reports the commit lease. Explicit confirmed recovery can reclaim a proven-dead PID/start owner; it never removes an unknown lock because it is old. After a crash, `--operation-id <id>` also reconciles the prepared/committed operation record. Do not delete leases manually.

`config bootstrap` is the explicit installation-resource boundary used by remote bootstrap. A stable operation ID identifies prepare/install/recover. It preserves unrelated preferences and model bytes, keeps credential verifiers in installation state, and delegates preference changes to the same writer. Recovery compares both configuration and security-state digests before restoring; a later user edit is preserved as a conflict. These commands do not start services.

## Repair a detached home alias

A missing alias or an editor replacing it with an ordinary file makes normal configuration access refuse. The explicit repair entry still works:

```bash
grokbox config aliases --preview
grokbox config aliases --scope local --apply --plan-digest <preview-digest> --confirm
```

The preview binds the installation, physical files and current aliases. Apply restores the managed links and preserves each detached file beside the home alias, including malformed editor text. It never merges that text into the durable configuration or models. A changed preview, later user edit or different installation refuses; an interrupted repair can resume the same recorded plan without overwriting a second edit. No consumer is started or restarted.

## Model commands

`grokbox models list/check/use/reset/persist-key` is the public model family. `use` and `reset` require exactly one of `--for <agent>` or `--default`. The explicit default changes no Bot assignment; ordinary routing still uses only per-Bot opt-in. `check` is schema-only and `persist-key` needs a separately confirmed credential operation. General `config` commands cannot rewrite model records or assignments.

## Planned extension: local context maintenance (not yet supported)

The accepted [context maintenance Spec S12](roadmap/box-runtime-impl-spec.md#context-maintenance) adds `runtime.context` for local working-window and automatic-compaction policy. **These fields are not accepted by the current schema v2 implementation.** CTX-01 targets an explicit config v2→v3 migration through the existing writer/alias/recovery path; models remain schema v2 with their existing catalog, credentials and reasoning assignments. Do not paste the planned fields into a current installation or turn on the old HostCompact environment gate as a substitute.

Policy belongs to `config.json`, not a third file or a fabricated model capability. Model declarations continue to describe the endpoint; explicit local limits can be smaller. S12 alone defines defaults, per-model/per-Bot policy overrides, output reserve, measurement, dependency revisions and next-TURN application. A policy override does not opt a Bot into managed inference. Unrelated client/desktop/ops edits and model credential bytes remain isolated.

The intended user experience is automatic maintenance on the next ordinary input to an already-stuck long session, before the main model request, without clearing history or replaying the old failed STEP. Saving policy is not proof that the current Host/modeld supports or has adopted it; consumers must separately report configured/captured/capability/application. The [CTX tickets](tickets/README.md#context-maintenance) own implementation and proof; current commands above retain their existing behavior until that work is delivered.

## Evidence and boundaries

Run `bun scripts/verify-runtime-rebuild.mjs config-unification` with the package-manager version declared in package.json. It typechecks, builds, tests source CLI and packaged Node, exercises real temporary files/locks, process-death and interrupted migration, alias preservation, desktop application and dependency isolation, then checks the preload import fence. Current evidence is recorded in [T57–T60](tickets/README.md#configuration-rebuild). Full repository tests do not prove a production Box reset, installed startup hook or native Webhook/Host cutover. Those gates use the shared [LIVE integration backlog](tickets/LIVE-integration-validation.md).

The implementation contract and owner/import rules are in [Configuration rebuild Spec](roadmap/configuration-rebuild-spec.md). This guide describes the current file and command model rather than retaining parallel configuration instructions.

## Model reasoning schema and general config migration

`config.json` uses `schemaVersion: 2`; `models.json` independently uses `version: 2` with `{ modelId, reasoning?: { effort } }` assignments. New bootstrap and a general config migration without an existing model file initialize an empty model v2 document. General `config migrate` preserves existing model bytes in place, including v2 policies/capabilities; it never normalizes that domain as a side effect. `models migrate --confirm` is the explicit model-schema operation and does not migrate general config, relocate files or grant execution. Protect configuration and coordinate loaded CLI/preload/Host/modeld wire v7 before using the new schema on an existing deployment. See the [reasoning ADR](decisions/2026-09-17-model-reasoning-policy.md).

Client/desktop/general config edits do not rewrite models or change the selected reasoning revision. Effort updates through `models use` do not write general config or invalidate its unrelated domain revisions. Both rules are integration-tested on the unified canonical readers/writers.
