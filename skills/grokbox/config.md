# Unified configuration

Load for preferences, connection Profiles or configuration repair: `grokbox skills get grokbox --topic config`.

The two human entry points are `~/.grokbox/config.json` and `~/.grokbox/models.json`. A Box keeps their actual bytes in its installed durable root; use the CLI to preserve the managed aliases. A client-only installation has its own configuration and does not synthesize a model file.

```bash
grokbox config path --physical
grokbox config path --physical --document models
grokbox config get desktop.idleReclaim.enabled
grokbox config get ops --effective
grokbox config schema ops.notifications
```

Queries do not create files, migrate, initialize a service, test a Provider or send a notification. `--effective` resolves intent defaults, not execution permission. Missing configuration is not evidence that monitoring is running.

## Change only the requested scope

```bash
grokbox config set desktop.idleReclaim.enabled false
grokbox config set desktop.idleReclaim.minIdleMs 900000
grokbox config set ops.diagnostics.mode --string on-request
grokbox config preset ops maintainer --preview
```

A selected remote Profile requires an explicit `--scope local` or `--scope target` for Box edits. An unqualified target capability refuses without writing the local machine. Model configuration remains `models *`; floor protection, credentials and operation grants are not generic configuration keys.

Use strict JSON values, `--string <literal>` or a bounded `--value-file`. Dotted paths address ordinary fields; use a JSON Pointer for a map key containing dots, for example `/client/profiles/work.v2/transport`. Unknown or misspelled keys, duplicate JSON members, invalid types and unsafe paths are rejected before publication.

Arrays replace as a whole and require `--replace --expect-revision <observed-sha> --confirm`. Prefer `desktop keep add/remove` for individual protection changes. A full `config apply --file <file>` also requires the observed revision and confirmation. Never retry a revision conflict by silently dropping that check. `unset` removes an optional explicit override and exposes its default; it cannot delete required configuration or change protected state.

A committed receipt means saved. `application: pending` means no matching consumer acknowledgement; `restart-required` does not authorize a restart. `--wait-applied --timeout-ms <n>` waits within a bound; a timeout still reports the already committed operation and revision. It never restarts a service or switches Host.

## Repair rather than guess

`config validate --file <candidate>` and `config path` work without a valid selected Profile. For old-format installations, use `config migrate --preview` and inspect conflicts, active writers and the exact plan. Applying requires `--plan-digest <sha> --confirm`; recovery is explicit. Do not rename old files, overwrite aliases or copy another installation's configuration to bypass a refusal.

`config recover` inspects the writer lease. Only explicit `--scope local --confirm` can recover a proven-dead owner; age is not proof. Do not delete lock files manually. Export portable preferences with `config export --portable`, which omits connection secrets, installed identities and grants. Keep all credentials out of command arguments, output and issue attachments.
