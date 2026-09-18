# Configuration

`grokbox config` is the shared, schema-checked interface for preferences and client connections. Models remain a separate document and are changed through model commands. Configuration reads never start services or repair files.

> **Schema 4 source candidate:** storage policy now has one configuration domain; the former `ops.support` intent is retired. Existing schema 2/3 files require explicit migration and matching consumers. This is not permission to replace a running installation piecemeal. Monitor and modeld log owners capture their relevant budgets at start; aggregate physical reservations, full-consumer adoption and native Bot delivery remain separate implementation gates. Current live state is only in the [LIVE index](tickets/LIVE-integration-validation.md).

## Two human entry points

| Entry | Contents | Physical storage |
|---|---|---|
| `~/.grokbox/config.json` | Client Profiles, daemon policy, desktop preferences, runtime desired mode/local context policy, ops preferences and storage budgets | On a Box: the installed durable root's `config.json`; on a client: the local file |
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
  "schemaVersion": 4,
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
  },
  "storage": {
    "policyRevision": 1,
    "diagnostics": { "targetBytes": 268435456, "maxBytes": 536870912, "reserveBytes": 67108864, "detailDays": 7, "summaryDays": 30 }
  }
}
```

Only `schemaVersion` and `client` are required. An absent document is read as the built-in client default without being created. Present ops leaves override the pinned user/maintainer preset; there is no additional overrides document. `--effective` resolves requested defaults, not a deployment or authorization claim. The ops execution and native Webhook work has its own [implementation tickets](tickets/README.md#template-ops-automation); accepting its preferences does not implement or enable those workers.

Client Profiles use camelCase fields under `client.profiles`: transport, serverUrl, daemonTokenRef, daemonSocket, gatewayUrl, gatewayTokenRef, gatewayHeadersRef, gatewayDiscovery, sshHost, sandbox and quota. The [product contract](product-contract.md#52-profile-字段) owns connection semantics. `profile add/update/use/remove` uses the same configuration writer and does not create a second Profile file tree.

## Storage policy and adoption

`storage` is intent, not a GC receipt. Its independent dependency revision prevents notification or desktop changes from invalidating storage, and storage changes from altering captured model selection. Both lowering retention and enlarging budgets require impact confirmation, including parent replacement or unset.

The registered retention categories are `monitor` (`maxBytes`), `journal` and `process` (`segmentBytes`, `maxBytes`, `maxAgeMs`). Current schema limits allow reducing the existing writer ceilings, not arbitrary larger allocations or path-based deletion. Detailed evidence lasts 1–30 days and summaries 1–365 days, with detail no longer than summary. Safety ledgers, native Memory and user files have no configurable observation TTL. The default monitor/two-journal/process allocation is 416 MiB within the 512 MiB diagnostic pool, with 64 MiB reserved and 32 MiB unallocated. Allocation validation is not a guarantee that all physical auxiliary files are reserved yet.

```bash
grokbox config get storage --effective
grokbox config schema storage
grokbox config set storage.diagnostics.detailDays 2 --preview
grokbox config set storage.diagnostics.detailDays 2 --confirm
grokbox runtime storage status --json
```

Monitor initialization, explicit capture and lease acquire current policy; an explicitly started collector captures it for its lifetime. The actual modeld log writer captures its process allocation after acquiring its listener. Journal writers receive the canonical root explicitly and read its current storage slice on each write; they record policy adoption only after a successful append and fsync. A known configuration disappearing or becoming invalid refuses new journal writes instead of restoring larger defaults. Journal status distinguishes the last successful writer policy from the requested policy and does not infer current writer liveness. The collector's existing maintenance Scope also handles registered closed journal segments independently of notification settings, skipping occupied locks rather than blocking local evidence ingestion. There is no all-owner hot-reload or aggregate `storage applied` receipt yet; `--wait-applied` remains pending until qualified consumers acknowledge the exact revision. Merely reading configuration never installs a consumer or performs GC. `runtime storage status` bypasses Profile initialization so old or broken config does not hide local storage evidence. Ordinary incident reads do not require healthy current config; new writes fail closed rather than silently restoring defaults.

The candidate modeld now owns a housekeeping child after listener readiness, even without a collector or enabled notifications. It reclaims existing observation data and closed log segments using their existing owners; it never initializes a missing DB, starts monitoring, calls models, or grants an aggregate `storage applied` receipt. Passes use a fixed 30-second delay after completion and settle before service resources close. `runtime storage status` includes bounded maintenance receipts and a metadata-only footprint of explicit diagnostic namespaces, with unmeasured owners disclosed. Measured usage is not a global writer reservation or automatic permission to delete backups. Box boot-time installation remains separately unqualified. See the [fixed proof](reports/2026-09-18-modeld-storage-lifetime.md).

Migration validates the old support shape before removing it. Unknown fields or raw credentials refuse migration; explicit off, target, cost and data-policy choices survive. The preview explicitly says support is retired and no binding, credential, model call or garbage collection is created. Existing model bytes and predecessor migration receipts remain protected. Source and executable proof are in [T51](tickets/T51-ops-capability-presets.md).

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

The migration phase is durable: prepared, publishing, published, activated, retired. Use `config migrate --status` to inspect and `--recover --confirm` to resume a recorded plan. A user edit after partial publication is a conflict rather than something recovery may overwrite. A later schema migration can follow a retired migration: preview binds the predecessor's fingerprint, and apply preserves its immutable manifest and backups under its original operation directory before publishing the next manifest. An unfinished, changed or conflicting predecessor blocks the new migration. Do not delete the previous receipt to force an upgrade. Restoring an old backup must not revive authorization or signal a Host.

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

## Local context maintenance

Schema v3 introduced `runtime.context`; schema v4 preserves it for local working-window and automatic-compaction policy. **An existing schema v2 installation needs explicit migration and matching wire-v8 Host/modeld artifacts before this feature can be used.** Migration is not deployment and does not itself start a summary. Models remain schema v2 with their catalog, credentials and reasoning assignments. The old HostCompact environment gate is not a normal enablement step; fault injection remains separate and disabled.

Default policy is auto, local window 128000, reserve 16384, and recent-message retention budget 20000. Policy belongs to `config.json`, not a third file or a fabricated model capacity. Inheritance is common policy → exact model override → Bot override; an override does not opt a Bot into managed inference. Use JSON Pointer paths for model IDs containing dots/slashes. All context changes require explicit confirmation because they can affect model cost.

```bash
grokbox config schema runtime.context
grokbox config get runtime.context
grokbox config set runtime.context.windowTokens 128000 --confirm
grokbox config set runtime.context.compaction.mode --string auto --confirm
grokbox agents context <agent> --json
```

An omitted policy still has defaults even when a raw `config get` path is absent. `agents context` reports configured policy/budget and the last maintenance receipt; `currentNativeRoot: not-observed` is not a live root measurement. Captured policy and safe credential identity remain fixed for the TURN, including tools and summaries; the next TURN uses changed preferences. A credential rotated after preflight cannot silently become the first main request's credential. Unrelated client/desktop/ops or another Bot's settings do not change this Bot's resolved policy revision.

The [S12 budget contract](roadmap/box-runtime-impl-spec.md#context-maintenance) defines output reserve, safety margin, smaller declared limits and post-compaction headroom. The current meter is an explicitly reported complete-envelope estimate, not an exact tokenizer or provider bill. A failed/zero-usage response does not suppress checking. An oversized new message or fixed system/tool material can still be refused rather than silently truncated. Manual mode disables proactive summarization, not the hard local budget.

The next ordinary input to a long failed session is checked before the main model request; qualified maintenance preserves that input and never replays the old failed STEP or executed tools. Explicit manual maintenance is available for an idle **loaded default Box session**:

```bash
grokbox agents compact <agent> --session '' --operation-id <stable-id> --confirm --json
```

It uses the native summarize action, not a hidden user prompt or fake model STEP. Busy, unloaded, named/server/subagent or unqualified native sessions refuse instead of being silently mapped or woken. A lost checkpoint acknowledgement or partial native replacement remains `commit_unknown`; inspect the operation rather than deleting its record or reusing a new ID to replay it. The current native shell reports `nativeCapability: blocked` and `nativeBlockReason` until it has been reloaded or independently reconciled; neither queued nor later inputs automatically cross that block. Native cleanup waits for an already-started checkpoint as well as summary generation. An upstream 503 before any native write is different: the original root is unchanged and a new ordinary input can run its own budget check. Original history and actual committed state remain owned by the Host.

The [CTX tickets](tickets/README.md#context-maintenance) and [offline report](reports/2026-09-17-context-maintenance-offline.md) describe implemented/source/packed/native-isolated scope and the pending independent review. Actual loaded adoption, original App input/Working and real native restart proof remain in [LIVE](tickets/LIVE-integration-validation.md#live-ctx-adoption); a green local build does not prove the current deployment.

## Evidence and boundaries

Run `bun scripts/verify-runtime-rebuild.mjs config-unification` with the package-manager version declared in package.json. It typechecks, builds, tests source CLI and packaged Node, exercises real temporary files/locks, process-death and interrupted migration, alias preservation, desktop application and dependency isolation, then checks the preload import fence. Current evidence is recorded in [T57–T60](tickets/README.md#configuration-rebuild). Full repository tests do not prove a production Box reset, installed startup hook or native Webhook/Host cutover. Those gates use the shared [LIVE integration backlog](tickets/LIVE-integration-validation.md).

The implementation contract and owner/import rules are in [Configuration rebuild Spec](roadmap/configuration-rebuild-spec.md). This guide describes the current file and command model rather than retaining parallel configuration instructions.

## Model reasoning schema and general config migration

Current source candidate uses `config.json` `schemaVersion: 4`; `models.json` independently uses `version: 2` with `{ modelId, reasoning?: { effort } }` assignments. New bootstrap and a general config migration without an existing model file initialize an empty model v2 document. General `config migrate` preserves existing model bytes in place, including v2 policies/capabilities; it never normalizes that domain as a side effect. `models migrate --confirm` is the explicit model-schema operation and does not migrate general config, relocate files or grant execution. Protect configuration and coordinate matching loaded CLI/preload/Host/modeld artifacts before using new schemas on an existing deployment: reasoning originally introduced wire v7, while context maintenance now requires wire v8. Historical v7 acceptance is not proof of v8 adoption. See the [reasoning ADR](decisions/2026-09-17-model-reasoning-policy.md).

Client/desktop/general config edits do not rewrite models or change the selected reasoning revision. Effort updates through `models use` do not write general config or invalidate its unrelated domain revisions. Both rules are integration-tested on the unified canonical readers/writers.
