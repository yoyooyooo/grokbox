# grokbox core

Version-matched usage guide for the local/remote Grok Bot CLI and box daemon. Load this file from the installed
binary (`grokbox skills get core --full`) instead of copying command docs into an Agent skill
stub.

## What this CLI is

`grokbox` is an agent-first adapter, not a raw Gateway wrapper. The published package requires Node.js 20+; both `grokbox` and `gbox` resolve to the same shim, which returns stable `runtime_unsupported` before loading the bundle on an older runtime. Bun is development tooling only.

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

The current source reads and manages a narrow product roster surface, appends one Human message to an ordinary agent or product group, reads explicitly admitted cloud-computer files, runs allowlisted structured processes as durable Jobs, queries an explicitly configured fresh account-quota source, and controls the optional Cursor Sandbox lifecycle from outside the box. In `auto` mode, finite Grok commands prefer the local daemon, then direct local Gateway, then a configured remote daemon. Filesystem and process/Job commands require their live daemon capabilities and never fall back to Gateway, SSH, or direct local host access.

## Start here

```bash
grokbox init
grokbox profile list --table
grokbox daemon status
grokbox doctor
grokbox quota
grokbox recover
grokbox box status
grokbox box wake
grokbox box keepalive status
grokbox agents list --table
grokbox groups list --table
grokbox send <target> --text "hello"
grokbox history tail <target> --limit 50
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
```

Targets accept an exact ID first, then an unambiguous case-insensitive name/title. The built-in
`default` Profile works without a file; use `grokbox init` for local onboarding and
`grokbox profile ...` for explicit selection/configuration. Remote bootstrap preserves any existing filesystem policy; add `--admit-home-read` only when the user explicitly authorizes the peer home read/download root. Use `--expect-kind agent|group` on
`send` when the caller needs a kind guard.

## Common paths

1. **Discover and recover**: `doctor` performs a read-only staged check of Profile/secret source, optional Sandbox state, tailnet path, exact Serve ownership, daemon HTTP/auth/capabilities, and Gateway health. The diagnostic returns exit 0 with `data.ok: false` when it successfully describes an unhealthy target; inspect each check's stable code/action. `daemon status` is only a local daemon handshake, not a second doctor. `recover` is the explicit mutating composition and may wake the configured Sandbox, wait for Tailscale/IPv4, restore only the bootstrap-recorded mapping, and start an installed daemon through declared BatchMode SSH before rerunning doctor. `daemon ensure` is narrower and never wakes or repairs Serve; `--bootstrap` is the separately confirmed install/replace and credential-rotation transition.
2. **Manage the roster**: `agents list/show/create/update/delete` only own non-group agents.
   `groups list/show/create/update/delete` only own product groups. Membership is only
   `groups members list/add/remove/set`; every member must resolve to a non-group agent and a group
   must retain 1-6 unique members.
3. **Search/read transcript**: `history search <query>`, `history tail <target>`, and
   `history thread <target> --root <entry-id>` own transcript access. Object `show` commands do
   not add transcript side projections.
4. **Speak as Human**: `send <target>` maps to one `sendPrompt`. Success means accepted, not
   completed. There is no `--wait`.
5. **Watch**: `events` emits unified NDJSON from `gateway`, `job`, and `daemon` sources. Daemon cursors resume a bounded journal; direct Gateway reconnects and all unobserved intervals emit explicit gaps. `is running <target>` reads the roster projection.
6. **Read account quota**: `quota` requires a selected Profile with `quota.source:"cursor-web"` and its independent `quota.access_token_ref`. It performs one fixed bounded HTTPS request and returns only a fresh sanitized DTO. It has no cache, fallback, Gateway/daemon route, Sandbox lifecycle effect, or App-private credential discovery. Missing quota configuration fails closed before discovery/SSH/host/App side effects even when the CLI runs inside the box. Copying an external OAuth token onto the box is not the in-box quota path. Static `profile capabilities` reports `provider-authorization-dependent`; only a successful call proves quota authority.
7. **Memory metadata**: `memory list <agent>` strips `content` unless `--content` is explicit.
8. **Use governed files**: `fs stat/list/read` use `root:/relative/path`; `fs download` writes a new local destination only after size and SHA-256 verification. `fs write` accepts explicit `--text` or stdin and supports `--expected-sha256`; `fs upload` uses bounded verified chunks; `fs mkdir` creates one level; `fs remove` moves content to recoverable trash and requires confirmation. `--recursive` additionally requires elevated live root policy. JSON `read` returns UTF-8 or explicit base64 and never writes arbitrary binary to stdout.

9. **Run governed processes**: `exec run -- <argv...>` resolves argv[0] only as a configured executable alias, preserves all remaining arguments literally, and returns a durable Job. `--run-timeout-ms` governs process lifetime while `--timeout-ms` bounds the client wait; `--detach` returns after admission. `jobs list/show/logs/cancel` require `host.process.manage`; logs are bounded base64 NDJSON and resumable by offset. Shell is separately privileged and normally unavailable. An admitted executable runs as the daemon user and is not sandboxed by cwd.
10. **Control Sandbox lifecycle**: `box status` reads the Cursor run state without waking it. `box wake` performs one broker Ensure plus a bounded exec no-op. `box keepalive run` is an external foreground lease loop; `box keepalive status` reads its redacted protected state. These commands require an explicit `sandbox.access_token_ref` and do not depend on daemon, SSH, Tailscale, Gateway health, or an in-box process.
11. **Idle desktop forks**: `desktop status` classifies seated forks and prints keep/floor ids. `desktop keep add|remove` persists Chrome keep ids on the box daemon config, not the client Profile. `desktop prune run` dry-runs by default; `--yes` and the daemon tick call official `stop-window`, which deletes `chrome-profile-N`. Keep must-keep agents before `prune enable`. Never edit the seating table or kill host/Xvfb. Display 1 is always kept.

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

## Output

Finite commands write one JSON object plus a trailing newline, except `skills get`, which is
Markdown unless `--json`. `events`, `jobs logs`, and `box keepalive run` write NDJSON. On failure, stdout is empty and stderr is one
JSON error object. `is running` returning false is still exit 0.

## External skill stub

Harness-installed skills should only say:

```text
Run `grokbox skills get core --full` before first use in this session.
```
