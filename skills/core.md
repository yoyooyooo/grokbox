# grokbox core

Version-matched usage guide for the Box-first Grok Bot CLI and its established remote daemon capabilities. Load this file from the installed
binary (`grokbox skills get core --full`) instead of copying command docs into an Agent skill
stub.

## What this CLI is

`grokbox` is an agent-first adapter primarily executed inside the supported Box, not a raw Gateway wrapper. Existing remote commands remain available, but new local runtime capabilities need no remote equivalent. The operator owns networking and supplies endpoint/credential references; Tailscale is not a default dependency. The published package requires Node.js 20+; both `grokbox` and `gbox` resolve to the same shim, which returns stable `runtime_unsupported` before loading the bundle on an older runtime. Bun is development tooling only.

```text
Agent / Skill
    -> grokbox + selected Profile
        -> local or remote daemon (finite Grok + governed host capabilities)
            -> Gateway discovery + loopback HTTP
            -> admitted named filesystem roots
        -> authenticated management Server
            -> executable policy + principal-scoped durable Jobs
        -> direct Gateway discovery + loopback HTTP (Grok-only local compatibility fallback)
        -> external Cursor Sandbox control plane
            -> read-only run state
            -> EnsureSandBox + brokered exec no-op
        -> explicit Cursor web quota source
            -> one fresh sanitized account-quota snapshot
        -> management-owned desktop classifier / explicit idle reclaim
        -> Grok Bot host Gateway
```

The source is mid-rebuild. Model selection/query commands now use the authenticated management Server and fixed-local or explicitly pinned connections, with no direct-Gateway fallback. Other command families below still describe their unmigrated implementations; this source is not a complete installation candidate.

The current source reads and manages a narrow product roster surface, appends one Human message to an ordinary agent or product group, reads explicitly admitted cloud-computer files, runs allowlisted structured processes as durable Jobs, queries an explicitly configured fresh account-quota source, and controls the optional Cursor Sandbox lifecycle from outside the box. In `auto` mode, finite Grok commands prefer the local daemon, then direct local Gateway, then a configured remote daemon. Unmigrated filesystem commands still require their live daemon capabilities. Jobs use only the pinned management Server and its independent jobs permissions; neither family falls back to Gateway, SSH, or direct local host access.

## Start here

```bash
grokbox init
grokbox profile list --table
grokbox daemon status
grokbox doctor
grokbox on
grokbox host start [--force]
grokbox off
grokbox host stop [--force]
grokbox host restart [--force]
grokbox upgrade --yes
grokbox model list
grokbox bot model get <bot-ref>
grokbox bot model set <bot-ref> --model <model-id> --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox bot model reset <bot-ref> --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox quota
grokbox recover
grokbox box status
grokbox box wake
grokbox box keepalive status
grokbox agents list --table
grokbox groups list --table
grokbox send <target> --text "hello"
grokbox history outcome <target> --nonce <uuid> --runtime
grokbox history tail <target> --limit 50
grokbox export agent <agent> --out ./export
grokbox file root list
grokbox file root get workspace
grokbox file stat <file-ref>
grokbox file download <file-ref> --to ./artifact.bin
grokbox file write --input @file-change.json --confirm
grokbox file upload <file-ref> --from ./artifact.bin --request-id <uuid> --expect-revision absent --confirm
grokbox file delete <file-ref> --request-id <uuid> --expect-revision <sha256> --confirm
grokbox file restore <file-ref> --request-id <new-uuid> --deletion-request-id <original-uuid> --confirm
grokbox operation get --domain file --request-id <original-uuid>
grokbox job policy
grokbox job start --input @job.json --request-id <uuid> --expect-revision <sha256> --confirm
grokbox job wait <job-ref> --wait-ms 25000
grokbox job logs <job-ref> --offset 0
grokbox job cancel <job-ref> --request-id <cancel-uuid> --confirm
grokbox system desktop get
grokbox system desktop prune --preview
grokbox system desktop keep set --input @desktop-keep.json --confirm
grokbox system config apply --domain desktop --input @desktop-policy.json --confirm
grokbox operation get --domain desktop --request-id <original-uuid>
grokbox runtime status
grokbox model list
grokbox models check
grokbox model default set stub/echo --request-id <persisted-uuid> --expect-revision <observed-revision>
grokbox config get desktop.idleReclaim --effective
grokbox runtime activate --mode observe|identity|route
grokbox runtime profile write --sha <retainedSourceSha>
grokbox runtime re-adopt --confirm
grokbox runtime modeld run
grokbox runtime watchdog run
grokbox runtime deactivate
```

Targets accept an exact ID first, then an unambiguous case-insensitive name/title. The built-in
`default` Profile works without a file; use `grokbox init` for local onboarding and
`grokbox profile ...` for explicit selection/configuration. For a user-managed remote service use `profile add <name> --transport daemon --server-url <https-url> --daemon-token-ref <reference>` and `profile use <name>`. Normal DNS, MagicDNS and IP use the same URL/TLS rules. No peer discovery, remote network bootstrap or Serve repair commands are provided. Configure the existing endpoint and credential reference explicitly; local installation policy remains under its canonical configuration owner. Use `--expect-kind agent|group` on
`send` when the caller needs a kind guard.

## Common paths

1. **Diagnose and recover**: `doctor` checks Profile/secret, endpoint HTTP/TLS, daemon auth/capabilities and Gateway health without network-tool or SSH probes. `data.ok` is application health; diagnostic exit 0 alone is not success. No legacy network status placeholders are returned. An unreachable endpoint with a configured Sandbox ref may add read-only provider state. `recover` is a no-op for healthy endpoints; otherwise explicitly configured SSH may ensure an already installed daemon, followed by doctor. Only a provider-confirmed `hibernated/absent` state plus endpoint failure permits wake; unknown/network failure does not. `daemon status` is a narrow handshake; `daemon ensure` never installs, replaces a live unhealthy process, rotates credentials or repairs networking. Network bootstrap and compatibility flags are absent. Do not modify machine mappings or keys to make diagnostics pass.
2. **Manage the roster**: `agents list/show/create/update/delete` only own non-group agents.
   `groups list/show/create/update/delete` only own product groups. Membership is only
   `groups members list/add/remove/set`; every member must resolve to a non-group agent and a group
   must retain 1-6 unique members.
3. **Search/read transcript**: `history search <query>`, `history tail <target>`, and
   `history thread <target> --root <entry-id>` own transcript access. Object `show` commands do
   not add transcript side projections.
4. **Speak as Human**: `send <target>` maps to one `sendPrompt`. Receipt `accepted:true` /
   `status:accepted` means queued, not a reply. Keep `clientNonce`. There is no `--wait` on send.
5. **Watch that send**: `history outcome <target> --nonce <clientNonce> --runtime --json`.
   Journal is failure authority. Outcome `data.state` is `unknown` | `recorded` | `failed` |
   `progress` | `delivered` | `expected_result_observed` — never `accepted` (`acceptedObserved`
   is gone). `recorded` is echo or journal bind only; keep waiting. Empty `alerts` is not
   success. `requestId` may be null on an early failure. `--request-id` looks up the same send,
   not a second handle. There is no `alerts list --nonce`. `--wait-ms` settles only on
   `failed` | `delivered` | `expected_result_observed`.
6. **Watch events**: `events` emits unified NDJSON from `gateway`, `job`, and `daemon` sources. Daemon cursors resume a bounded journal; direct Gateway reconnects and all unobserved intervals emit explicit gaps. `is running <target>` reads the roster projection.
7. **Read account quota**: `quota` requires a selected Profile with `quota.source:"cursor-web"` and its independent `quota.accessTokenRef` in `config.client.profiles`. It performs one fixed bounded HTTPS request and returns only a fresh sanitized DTO. It has no cache, fallback, Gateway/daemon route, Sandbox lifecycle effect, or App-private credential discovery. Missing quota configuration fails closed before discovery/SSH/host/App side effects even when the CLI runs inside the box. Copying an external OAuth token onto the box is not the in-box quota path. Static `profile capabilities` reports `provider-authorization-dependent`; only a successful call proves quota authority.
8. **Material scopes**: `memory list --scope agent` returns indexed document metadata from explicitly configured sources. `memory read <material-ref>` separately reads source text; native Memory/Project replicas are read-only. Load `grokbox skills get grokbox --topic materials` for search, coverage and file-write recovery.
9. **Export one local Bot**: `export agent <agent> --out <dir>` reads the local agent-data tree only. Default output is owned profile/settings/Memory/automations plus `manifest.json`. Skill/workflow/plugin have no per-bot structured ownership (`association: none`); related workflow names are text references. `--include-related-workflows` copies referenced `SKILL.md` only. It never packs `gateway.json`, tokens, or transcript DBs, and it does not use Gateway or Profile.
10. **Use governed files**: `file root list/get` provides exact installation/root-bound references. `file list <file-ref>` reads one directory; no argument lists indexed material files. Direct `file read` returns bounded base64 with verified SHA-256, never raw binary or executable markup. `file write --input @file|- --confirm` declares ref, requestId, expectedRevision (null only for an absent destination), and exact content; material references retain their original source writer. `file upload --from` and `file download --to` use bounded chunks and complete size/hash verification; download never overwrites a local destination. `file delete` moves the reviewed object into private trash, with separate recursive root policy; `file restore` requires the same principal's original successful deletion. `operation get --domain file` reads history after a lost response. Only a live original staging upload can be explicitly cancelled with `operation cancel <request-uuid> --domain file --generation <original-service-uuid> --confirm`; unknown commit or a dead owner is not proof of cancellation. Never switch to old fs/daemon/Gateway methods: those file paths are retired. Named roots cannot overlap material/native sources or management state.

11. **Run governed processes**: `job policy` supplies the current management-service policy revision. `job start` takes strict JSON (`argv`, optional `environment`/`cwd`/`output`/`shell`, and `runTimeoutMs`), a caller-persisted request UUID, reviewed revision and explicit confirmation. It resolves argv[0] as an executable alias, not a shell fragment; shell needs separate policy and permission. `job get/wait` observes the original service-owned execution, while `job logs` explicitly reads bounded base64 pages with independent output permission. Cancellation has its own persisted UUID and never reverses external effects. After a lost response use `operation get --domain job --request-id <uuid>` or `--domain job-cancel --job-ref <ref> --request-id <cancel-uuid>`; never invent a new request to repair uncertainty. No daemon/CLI fallback executor remains. Approved executables are not filesystem-sandboxed by cwd.
12. **Control Sandbox lifecycle**: `box status` reads the Cursor run state without waking it. `box wake` performs one broker Ensure plus a bounded exec no-op. `box keepalive run` is an external foreground lease loop; `box keepalive status` reads its redacted protected state. These commands require an explicit `client.profiles.<name>.sandbox.accessTokenRef` and do not depend on daemon, SSH, Tailscale, Gateway health, or an in-box process.
13. **Idle desktop forks**: `system desktop get` reports current display identities, source coverage, keep/floor protection and the management worker. `system desktop prune --preview` is read-only; execution requires `--request-id`, the reviewed `--expect-revision` and `--confirm`. The helper may delete a fork's Chrome profile. `system desktop keep set --input @file --confirm` uses an exact `agentIds` set plus `requestId`/`expectedRevision`; `system config apply --domain desktop --input @file --confirm` currently accepts `action: idle-reclaim`, `enabled` and `minIdleMs` plus those identities. Both use the original config writer. Main display and installation floor stay protected. Missing/raced observations refuse reclaim; stop intent and settlement are durable, and unknown is never replayed by a new UUID or automatic cycle. Query the original request with `operation get --domain desktop` or `desktop-policy`. Ordinary prune does not unseat or delete a Bot. Native Bot deletion still has separate exact-seat cleanup that must be converged with the remaining lifecycle migration; neither local checks nor helper exit proves an atomic native seat lease.
14. **Execution services and model intent**: `bot model get/set/reset` and `model list/get/default` use the shared management service. Changes require a persisted request UUID and expected revision; explicit followers alone follow the default. Read-only `operation get --request-id` does not replay an uncertain model write. Remaining `runtime *` and `models check/persist-key/migrate` are local maintenance paths, not selection alternatives. `models check` is schema-only, not provider readiness. `runtime activate/deactivate` saves `config.runtime.desiredMode`; saved intent is not a Host switch or rollback proof. Read `runtime status/log/contracts` for qualified evidence, keeping missing and stale facts unknown. Profile authoring operates on retained source through `runtime profile write --sha <retainedSourceSha>`; it is neither approval nor live activation. Confirmed `runtime re-adopt` and `host start/stop/restart` use the governed Host control paths. Modeld is a packaged Node service. For development dogfood, run `bun run build` then `bun run modeld:run`; the equivalent installed-artifact entry is `node dist/index.js runtime modeld run`, never worktree TypeScript. `runtime watchdog run` performs observation without granting itself mutation authority. Use the installed `grokbox` skill's models, services, config and adopt topics for the specific capability. **No live unless authorized**: source tests, configuration saves and a green modeld health response never authorize a Host switch or provider probe.

Sensitive or multiline prompts should go on stdin:

```bash
printf '%s' "$prompt" | grokbox send <target>
```

An explicit `--text` is authoritative even in a non-TTY runner and suppresses stdin reads. If you
retry the same send, reuse `--nonce <uuid>` and the same target/prompt.

## Safety

- Agent/group deletion is permanent and removes that object's product data. In a headless runner,
  pass `--yes`; in a TTY, review the confirmation prompt. Resolve and inspect the object first.
- Interrupted management writes return `operation_outcome_unknown` with an operation ID and are not replayed automatically; inspect the roster before deciding whether to retry. If create succeeded before a later settings/projection failure, the error also names the created object ID and `post-create` phase.
- `doctor` never wakes, starts, installs, changes Tailscale, or accepts a repair option. `profile doctor`, `daemon doctor`, and `doctor --repair` are not commands. `recover` refuses unresolved required credentials, unrecorded/drifted/occupied Serve handlers, missing installed runtime, and unavailable declared SSH rather than broadening authority. It never runs `tailscale serve reset`, `tailscale up`, Funnel, ACL/tag changes, or ordinary business RPC over SSH.
- Local daemon access is gated by its `0600` Unix socket; remote daemon access uses the selected Profile credential. Handshake returns daemon generation, capability names, named filesystem roots/operations, and Gateway generation, never physical root paths, the Gateway token, or raw discovery JSON.
- Filesystem paths must use a handshake-advertised named root. Parent traversal, symlink escape, pseudo-filesystems, daemon/Gateway state, and known credential/session paths fail closed. `read` is bounded to 1 MiB; `download` is bounded to 64 MiB in 256 KiB chunks and refuses to overwrite an existing local destination.
- Job metadata excludes argv, environment values, and output content. Children receive a fixed minimal environment plus allowlisted additions, never the service's `process.env`; output is bounded and binary-safe. Transport timeout or a log follower disconnect never cancels the Job. Read uncertain submission with `operation get --domain job --request-id <uuid>`; use `job get/wait/logs` for the scoped execution. The old daemon Job event source and Profile process-capability promises are removed, not silent empty fallbacks.
- Event cursors are opaque and should be persisted only for reconnect. Daemon restart/eviction and Gateway disconnect emit explicit gap events. Event payloads are channel allowlists; Memory content requires both the memory channel and `--include-memory-content`. Prompt, transcript, filesystem/process, environment, and auth content are never general event fields.
- Sandbox and quota access tokens must use separate explicit `env:`, protected absolute `file:`, or macOS `keychain:` Profile references. A `file:` ref must be a current-user-owned regular file with no group/other permissions; symbolic links and unverifiable ownership are rejected. A quota failure never falls back to the Sandbox ref, App Gateway descriptor, private App persistence, Gateway, daemon, SSH, or wake. There is no credential-sync command. Quota output excludes account identity, raw provider body, token, Machine ID, headers, and usage events.
- App Gateway descriptors and private App persistence are not wake credentials. Brokered exec, network, Gateway, and VNC descriptors stay inside the Sandbox adapter. The keeper never calls `sendPrompt` or creates model turns; its local success does not prove the required App-closed 24-72-hour lease experiment.
- No `--token`, `--gateway-url`, `--host`, `--port`, or raw API route.
- Gateway HTTP has no `Origin` header. The quota adapter is the explicit exception: it sends only the fixed provider-required `Origin: https://cursor.com` to its fixed endpoint. Tokens never belong on argv, URL, stdout, stderr, or logs.
- Default output redacts roster `path` / `avatarDataUrl` / `lastMessagePreview` and Memory
  `content`.
- Transcript and Memory content are private product data; do not copy them into ordinary logs.
- Unsupported options are absent from each leaf command and fail before any network request.
- Box-local `runtime *` and the remaining model maintenance commands are local-only. Management model operations use their pinned Server connection. Saving desired mode or an offline profile does not switch the live Host. Host lifecycle commands and confirmed re-adoption use the governed controller; valid per-Bot custom assignments use the qualified backend, while unassigned Bots retain their official path. Missing or invalid configuration is never permission for a silent model fallback. The short-lived run root is `~/.grokbox/run/`; live changes and provider probes require explicit scope authorization.

## Output

Finite commands write one JSON object plus a trailing newline, except `skills get`, which is
Markdown unless `--json`. Management commands put a versioned success or failure envelope on stdout; a failed mutation can require read-only reconciliation even when the client was interrupted. The remaining unmigrated commands retain their earlier envelope: `events`, `jobs logs`, and `box keepalive run` write NDJSON, and finite failures use stderr. `is running` returning false is still exit 0.

## External skill stub

Harness-installed grokbox helpers should use the small [template stub](stubs/grokbox.md):

```text
Run `grokbox skills get grokbox` before first use in this session.
Then load only the needed `--topic <name>` from that entry.
```

This core inventory is an explicit reference, not default template-Bot startup reading.
