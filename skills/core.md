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
            -> executable policy + durable Jobs
        -> direct Gateway discovery + loopback HTTP (Grok-only local compatibility fallback)
        -> external Cursor Sandbox control plane
            -> read-only run state
            -> EnsureSandBox + brokered exec no-op
        -> explicit Cursor web quota source
            -> one fresh sanitized account-quota snapshot
        -> daemon desktop classifier / idle prune
        -> Grok Bot host Gateway
```

The source is mid-rebuild. Model selection/query commands now use the authenticated management Server and fixed-local or explicitly pinned connections, with no direct-Gateway fallback. Other command families below still describe their unmigrated implementations; this source is not a complete installation candidate.

The current source reads and manages a narrow product roster surface, appends one Human message to an ordinary agent or product group, reads explicitly admitted cloud-computer files, runs allowlisted structured processes as durable Jobs, queries an explicitly configured fresh account-quota source, and controls the optional Cursor Sandbox lifecycle from outside the box. In `auto` mode, finite Grok commands prefer the local daemon, then direct local Gateway, then a configured remote daemon. Filesystem and process/Job commands require their live daemon capabilities and never fall back to Gateway, SSH, or direct local host access.

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
grokbox fs stat home:/artifact.txt
grokbox fs download home:/artifact.bin ./artifact.bin
grokbox fs write workspace:/status.txt --text "ready"
grokbox fs upload ./artifact.bin workspace:/artifact.bin
grokbox fs remove workspace:/obsolete.txt --yes
grokbox exec run --cwd workspace:/ --detach -- node -e "console.log('ready')"
grokbox jobs show <job-id>
grokbox jobs logs <job-id> --follow
grokbox jobs cancel <job-id>
grokbox desktop status --table
grokbox desktop keep add <agent>
grokbox desktop prune run
grokbox desktop prune enable
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
`grokbox profile ...` for explicit selection/configuration. For a user-managed remote service use `profile add <name> --transport daemon --server-url <https-url> --daemon-token-ref <reference>` and `profile use <name>`. Normal DNS, MagicDNS and IP use the same URL/TLS rules; no peer discovery is needed. `init --peer` / `daemon ensure --bootstrap` are retained legacy compatibility only, never automatic setup. Legacy bootstrap preserves existing filesystem policy; add `--admit-home-read` only when explicitly authorized. Use `--expect-kind agent|group` on
`send` when the caller needs a kind guard.

## Common paths

1. **Diagnose and recover**: `doctor` checks Profile/secret, endpoint HTTP/TLS, daemon auth/capabilities and Gateway health without Tailscale or SSH probes. `data.ok` is application health; diagnostic exit 0 alone is not success. Legacy `tailnet`/`serve` fields are skipped and network identity remains unverified. An unreachable endpoint with a configured Sandbox ref may add read-only provider state. `recover` is a no-op for healthy endpoints; otherwise declared SSH may ensure an installed daemon, followed by doctor. Only a provider-confirmed `hibernated/absent` state plus endpoint failure permits wake; unknown/network failure does not. Default recovery never reads or repairs Serve. Only explicit `recover --legacy-tailnet` restores a previously recorded exact mapping with the old ownership/drift checks. Do not select that option automatically or remove working mappings. `daemon status` is a narrow local handshake; `daemon ensure` never wakes or repairs Serve; confirmed `--bootstrap` is legacy install/replace/credential rotation.
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
10. **Use governed files**: `fs stat/list/read` use `root:/relative/path`; `fs download` writes a new local destination only after size and SHA-256 verification. `fs write` accepts explicit `--text` or stdin and supports `--expected-sha256`; `fs upload` uses bounded verified chunks; `fs mkdir` creates one level; `fs remove` moves content to recoverable trash and requires confirmation. `--recursive` additionally requires elevated live root policy. JSON `read` returns UTF-8 or explicit base64 and never writes arbitrary binary to stdout.

11. **Run governed processes**: `exec run -- <argv...>` resolves argv[0] only as a configured executable alias, preserves all remaining arguments literally, and returns a durable Job. `--run-timeout-ms` governs process lifetime while `--timeout-ms` bounds the client wait; `--detach` returns after admission. `jobs list/show/logs/cancel` require `host.process.manage`; logs are bounded base64 NDJSON and resumable by offset. Shell is separately privileged and normally unavailable. An admitted executable runs as the daemon user and is not sandboxed by cwd.
12. **Control Sandbox lifecycle**: `box status` reads the Cursor run state without waking it. `box wake` performs one broker Ensure plus a bounded exec no-op. `box keepalive run` is an external foreground lease loop; `box keepalive status` reads its redacted protected state. These commands require an explicit `client.profiles.<name>.sandbox.accessTokenRef` and do not depend on daemon, SSH, Tailscale, Gateway health, or an in-box process.
13. **Idle desktop forks**: `desktop status` classifies seated forks and prints keep/floor ids. `desktop keep add|remove` commits `config.desktop.keepAgentIds` through the same canonical writer as `config set`; installation floor protection remains separately enforced. `desktop prune run` dry-runs by default; `--yes` and the daemon tick call official `stop-window`, which deletes `chrome-profile-N`. Keep must-keep agents before `prune enable`. Idle prune never edits the seating table or kills host/Xvfb. Display 1 is always kept. `agents delete` on the box is the exception: after Gateway delete it stops a non-main fork and atomically drops that agent from `.sand-window-assignments.json` (`assignments` and matching `tokens`). The delete receipt includes `desktop: { display, outcome }` (`stopped` | `no_seat` | `unavailable` | `skipped_main`).
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
- Job metadata excludes argv, environment values, and output content. Children receive a fixed minimal environment plus allowlisted additions, never daemon `process.env`; output is bounded and binary-safe. Transport timeout or a log follower disconnect never cancels the Job. Reconcile uncertain submission with its original Job ID and lifecycle through `jobs show`.
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
