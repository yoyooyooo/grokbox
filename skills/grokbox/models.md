# Models

Load for per-Bot selection or catalog configuration: `grokbox skills get grokbox --topic models`.

## Select one Bot's future model

**Operator / template Bot stays on the official brain. Never change your own model.** Use a separately authorized disposable Bot for custom-model experiments. Ordinary official-Bot work needs no assignment.

The model commands use the management Server, not a local-file or Gateway fallback. The implicit connection is this Box. `--connection <name>` selects an explicitly pinned endpoint for this invocation; neither `profile use` nor `GROKBOX_PROFILE` changes that target. A missing Server is a failure, not permission to start or bypass it.

```bash
grokbox system identity get
grokbox model list
grokbox bot list
grokbox bot resolve <name-or-title>
grokbox bot get <bot-ref>
grokbox bot model get <bot-ref>
grokbox bot model set <bot-ref> --model <model-id> --request-id <persisted-uuid> --expect-revision <observed-revision>
```

Use a native UUID or `bot:<installation-id>:<native-uuid>` for a change, not a display name. `bot list` returns scoped refs; `bot resolve` performs exact case-insensitive name/title matching and returns candidates on ambiguity. Truncated identity text does not become a unique match, and `self` requires a trusted runtime binding. Persist the request UUID and exact input before submission. Read `revision` from the model query and use it for the change. A fresh intent needs its own UUID; an uncertain intent must not acquire a new one merely to retry.

The Server validates the model, ownership and catalog before publication. `confirmed_box` is eligibility, not production qualification. Failure or stale source evidence never authorizes a local harness edit, Host switch or alternate route. See [ownership](ownership.md) and [adopt](adopt.md) for the remaining inspection/maintenance paths.

Selection affects subsequent TURNs. The reply records configuration publication, not provider execution, current TURN adoption or an App title update. Saving a selection does not write a native title; title display and execution must be observed separately through [label](label.md) and [send](send.md).

## Follow or change the default

```bash
grokbox model default get
grokbox model default set <model-id> --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox bot model set <bot-ref> --follow-default --request-id <persisted-uuid> --expect-revision <observed-revision>
```

An unassigned Bot remains native. Following the default is an explicit relationship; selecting the same model explicitly is not following it. Default changes affect followers only. A follower cannot supply its own effort. Clearing a referenced default refuses until its followers are explicitly rebound; a missing default cannot be followed.

## Set or clear reasoning effort

```bash
grokbox bot model set <bot-ref> --model <model-id> --effort xhigh --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox bot model get <bot-ref>
grokbox bot model set <bot-ref> --model <model-id> --effort default --request-id <new-persisted-uuid> --expect-revision <new-observed-revision>
```

An explicit effort must be in the model's `capabilities.reasoning.efforts` whitelist. Missing capability is unknown; `false` is unsupported. Both refuse an explicit effort before ownership/catalog work and publication. The request never changes endpoint, credential or wire model to obtain an effort. Wire vocabulary is `none|minimal|low|medium|high|xhigh|max`, limited to the model's declaration. `none` is not `default`.

Omitting effort, or specifying `default`, clears the override without guessing the provider's default. In-flight TURNs retain their captured selection. `bot model get` is a configured-next-turn projection and reports current execution as `not-observed`. Captured, emitted, provider-reported and title values are separate evidence.

## Reset or inspect uncertainty

```bash
grokbox bot model reset <bot-ref> --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox model default reset --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox operation get --request-id <original-request-uuid>
```

Bot reset removes only its managed intent; it does not change native ownership, reset context or switch the whole Host. It is not trapped behind unavailable ownership evidence. Default reset is a separate operation and refuses while followers exist.

Model mutations return exit `8` for an uncertain outcome; interruption returns `130` without cancelling an admitted Server commit. A read-only receipt lookup may succeed while reporting `state: unknown`. Do not infer success from exit `0` on that lookup, matching file contents or an empty error list. Prepared receipts are uncertainty fences, not retry permission. Lookup is installation/principal scoped and currently covers the model domain.

## Catalog and credential maintenance

Human catalog entry: `~/.grokbox/models.json`. On a Box it aliases the installed canonical document; `grokbox config path --physical --document models` identifies it. General `config` commands do not edit model records or assignments. Do not bypass the management writer with manual assignment edits.

The current source still exposes `models check`, `models persist-key` and `models migrate` as maintenance entries pending their remaining CLI migration. They do not restore the retired selection syntax. `check` is schema-only, not provider readiness; credential persistence is separately confirmed.

```bash
grokbox model apply <model-id> --mode patch --input @model-change.json --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox model delete <model-id> --request-id <persisted-uuid> --expect-revision <observed-revision>
```

The apply document contains `modelId`, `mode`, `model`, `requestId` and `expectedRevision`; a field may instead come from its positional argument or flag, never both. `--input -` reads explicit bounded UTF-8 stdin. Unknown/duplicate keys, invalid null and oversized input refuse before submission. When identity, mode and concurrency fields are provided as flags above, the file can be `{"model":{"alias":"example"}}`.

`patch` preserves omitted fields, including the credential reference and capabilities. Supplied arrays replace that field. Null explicitly clears `alias`, `contextWindowTokens`, `chatDialect` or `capabilities.reasoning`; required fields do not accept null. A reasoning change that invalidates current selections refuses. `replace` requires a complete model declaration; omitted optional settings reset according to the model schema. Neither mode rewrites an in-flight captured selection.

Apply writes a local definition, including when explicitly overriding a Pi-imported identity; it never edits Pi's file. Delete refuses current Bot/default references and direct imported/builtin deletion. Removing a local override may reveal an imported definition again: inspect `model get` and its `configurationSource`. A verified local publication reports its actual readback revision; this does not claim control over the external catalog owner's writes. Full credential import management is still awaiting migration.

Records contain provider, wire model, endpoint, capabilities and a private credential reference. `openai` / `openai-chat` use Chat Completions; `openai-responses` uses Responses API; `stub/echo` is test-only. References are `env:NAME` or `file:/absolute/path`, never a literal key or `$VAR`. API model views disclose only credential source/configuration status, not the reference or value.

Current writes use models schema v3. Readers normalize v1/v2 without saving or inventing followers; explicit legacy assignments remain explicit. Every serving CLI/Host/modeld artifact must support the installed schema before adoption. No schema read automatically relocates roots, copies credentials, restarts a Host or downgrades data.

An optional alias is unique and matches `^[a-z0-9][a-z0-9._-]{0,15}$`. Local reasoning capabilities and exact Pi `thinkingLevelMap` imports declare request shapes, not observed provider support. Never add guessed capabilities to bypass a refusal. Referenced model deletion and incompatible reasoning changes refuse instead of silently rebinding users.

MiniMax's qualified `minimax-inline-v1` Chat dialect preserves inline thinking across tool turns without putting it in ordinary answers. A proxy requires that explicit dialect; `standard` opts out. Nonempty split thinking state is rejected. Endpoint configuration alone is not live acceptance.

## Deliberate acceptance

Load [validation](validation.md#prove-a-model-switch) only for a requested bounded canary or sustained check. Correlated provider/tool/compact/reply evidence and a later title read are distinct from saving configuration. Do not start indefinite monitoring or select a production Bot to fill an evidence gap.
