# `grokbox` CLI 目标实现架构

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

本文是 CLI、Profile、transport、box daemon 和 host capability 的实现边界 Current Home。它描述已接受的**未来完成态**；当前源码已经交付 Node.js 20+/Commander 的 agent-first registry、严格 Profile v1、local/remote `init` 和 daemon transport、Grok roster/transcript/Memory/send/management 有限方法、离线只读 `export agent`、daemon-only 命名 root 文件能力、结构化 process 与 durable Jobs、generation-aware unified events/recovery、explicit OAuth quota adapter、external Sandbox lifecycle adapter、实验性 desktop classification/prune，以及 layered doctor/explicit recovery。剩余差距由外部 evidence、源码测试与本地 Issue tracker 共同拥有。

产品命令与输出合同见 [CLI 产品合同](product-contract.md)。显式 OAuth quota adapter 与 evidence 见 [Quota Current Home](quota.md)。Cursor Sandbox、freeze 与 keeper 边界见 [Sandbox 控制面](cursor-sandbox-control-plane.md)。Gateway 当前事实见 [上游集成](upstream-integration.md)。非官方身份和上游私有 adapter 的稳定性见 [兼容性边界](compatibility.md)。

## 1. 架构目标

```text
argv/stdin
   -> command registry
   -> application use case
   -> required capability
   -> Profile resolver
   -> capability port
        local socket -----------+
        Tailscale daemon HTTPS -+-> box daemon
        local discovery --------+-> Gateway adapter
        explicit Gateway -------+
        Sandbox control ---------> Cursor / AnyRun control plane
        explicit quota source ---> Cursor/Sand Dashboard

box daemon
   -> capability policy
   -> Gateway adapter -> Grok Bot Gateway
   -> Filesystem adapter -> governed roots
   -> Process adapter -> jobs/processes

external Sandbox adapter / keeper
   -> EnsureSandBox -> current connection descriptor
   -> brokered exec no-op -> wake / lease observation
```

命令不依赖 transport DTO；transport 不拥有产品决策；daemon listener 不直接写产品事实。Sandbox adapter 必须运行在 box 外；内部 daemon 在 cgroup freeze 后不能唤醒自己。

## 2. Authority

| Fact or effect | Final authority |
| --- | --- |
| current Profile selection | CLI global config writer |
| Profile fields | corresponding Profile config writer |
| agent/group/transcript/Memory | Grok Bot Gateway and its stores |
| offline agent export snapshot | local agent-data allowlist reader; never a product writer |
| ordinary cloud files | box filesystem through governed filesystem use cases |
| process/job runtime state | daemon job manager plus observed OS process state |
| Gateway generation | current discovery `{pid,startedAt}` |
| daemon capabilities | daemon policy and runtime capability probe |
| Sandbox allocation and lease | Cursor/AnyRun control plane observation |
| account quota | selected credential-owning Cursor/Sand quota source |
| keeper process state | external keeper state store and observed provider result |
| desired box-runtime activation | box-local runtime activation use case |
| Host patch coverage | generation-bound attestation + watchdog observation |
| `assignments.main` / models catalog | durable `/workspace/.grokbox/box-runtime/models.json` |
| provider secret | modeld-only SecretRef resolution (`env:` / `file:`) |
| Host desired liveness | official wrapper/supervisor |

正常 agent/group 管理只经 Gateway。`export agent` 只读取本地 agent-data allowlist，不是第二个产品 writer，也不经 Gateway 组装导出包。离线文件修复不能成为第二个自动 writer；它必须是显式维护 use case，并在恢复前 fence 正常 writer。

## 3. Repository Shape

The published CLI and daemon, Host preload, modeld, CLI runtime, and runtime-kernel execute on Node.js 20.17.0+ (the pinned native monitor SQLite requirement) and must not import `bun:*` or call Bun runtime globals (`Bun.file`, `Bun.serve`, and the like). Bun remains the repository package manager and may run development scripts, tests and TypeScript tooling. Both executable names share one `#!/usr/bin/env node` shim; its pre-bundle gate returns stable `runtime_unsupported`/59 before importing `dist` when the Node version is below 20.17.0 or unparseable. An npm-installed external client does not require Bun.

一个 **发布包** `grokbox`（bin 名 `grokbox`/`gbox`），仓库内两个 unpublished workspace 包。不要为对称性再拆 quota/sandbox/daemon 成独立发布物。

```text
bin/                         published Node shim (both executable names)
packages/cli/                unpublished @grokbox/cli
  src/index.ts               process entry
  src/program.ts             Commander projection
  src/registry.ts            command + capability metadata
  src/application/           transport-independent use cases
  src/config/                global config and Profile resolution
  src/transports/
  src/quota.ts
  src/sandbox/
  src/gateway/
  src/daemon/
  src/commands/
packages/box-runtime/        unpublished @grokbox/box-runtime
  src/                       Host transform, modeld, watchdog
  must not import daemon/SSH/Profile transport
skills/
test/                        CLI, daemon, packaging tests (repo root)
docs/
```

Published npm tarball remains one `grokbox` with empty `dependencies`; esbuild bundles cli (+ box-runtime) into root `dist/` and copies Node-runnable runtime helpers beside `dist/index.js` (`preload.cjs`, `guardian-child.cjs`, `injector-hold.cjs`, `grokbox-temp-supervisor.cjs`). A second **published** package is earned only when an independently installed consumer exists (future in-box WebUI is the same use cases, not a second npm).

## 4. Command Registry

One registry owns each leaf command's:

```text
path
usage
summary
required capability
accepted target role and target kinds
supported option set and profile-selector eligibility
streaming or finite
stdin/input-source policy
table eligibility and timeout eligibility
destructive confirmation policy
```

Commander parser/help and bundled skill reference derive from this registry. Unsupported options are absent from parsing and help rather than accepted and ignored. Implementations are explicit use-case bindings; the registry never generates arbitrary Gateway method calls. Registry completeness tests compare parser, help, capability metadata and skill projection so one leaf cannot drift across surfaces.

## 5. Profile Resolution

Profiles live in `config.json.client.profiles`; daemon, desktop, runtime desired and ops preferences share that canonical document. The Box uses a durable physical config/models pair with managed home aliases; the client uses its own config file. Models retain their physical path and domain schema. [Configuration](configuration.md) owns the operating guide; [Configuration Spec](roadmap/configuration-rebuild-spec.md) owns schema, layout, writers and migration.

The kernel owns the shared schema, path grammar and ConfigChange program; box-runtime owns protected IO, writer leases and recovery. CLI, domain commands, daemon preference changes and bootstrap all call that program. Consumer dependency revisions are separate from full-document CAS. Host still reads bounded model snapshots, not ops/SQLite/Effect. Bindings, grants, floor, executable pin and verifier are machine facts with distinct authority, never generic JSON keys. Desktop records adoption only after reading the exact snapshot; queries cannot sign its acknowledgement. Bootstrap/migration are recoverable multi-artifact operations, not a claim that Effect Scope or rename gives cross-file atomicity.

The config adapter owns path expansion, permissions, schema validation, secret redaction and precedence. Application use cases receive a resolved immutable Profile, not raw JSON.

The top-level `init [<name>]` use case owns first-run orchestration. It composes local environment inspection, a narrow `TailnetDiscoveryPort`, target selection, shared daemon credential bootstrap, atomic Profile persistence and staged doctor. Discovery DTOs never leak into ordinary command use cases, and discovery alone never grants trust. The optional positional name is the Profile being created or updated; global `--profile` only selects an existing Profile and is invalid for `init`.

When an explicitly selected remote peer has no usable daemon endpoint and a local, passwordless SSH, or Cursor Sandbox exec bootstrap adapter is available, TTY init may request confirmation and compose the bootstrap use case. Headless init requires `--bootstrap --yes`; without an adapter it returns `bootstrap_unavailable` and an in-box remediation command. Bootstrap owns grokbox daemon installation/update, loopback listener, shared credential creation/rotation and one exact tailnet-only mapping after the bounded compatibility probe succeeds; it does not install or join Tailscale, alter ACL/tags, enable Funnel, reset Serve, or overwrite another mapping.

The built-in default document is synthesized only when canonical config is absent; a present invalid document is rejected before transport selection. Built-in defaults include:

```text
current profile       default
transport             auto
gateway discovery     /home/box/sand-data/gateway.json
finite timeout        10000 ms
daemon socket         $XDG_RUNTIME_DIR/grokbox/daemon.sock
fallback socket       ~/.grokbox/run/daemon.sock
```

Sandbox 没有隐式 account secret。Profile 只保存 `sandbox.accessTokenRef`，其值使用 `env:`、`file:` 或 `keychain:` v1 reference；原始 Cursor access token 不进入 Profile、argv、日志或 box daemon。Quota 也必须显式声明完整的 `quota:{source:"cursor-web",accessTokenRef:<ref>}`；它不借用 Sandbox ref，不把同一 OAuth token 的 quota 成功解释为 wake authority。macOS App descriptor 只提供 Gateway-only session，不推出 Sandbox wake 或 quota authority。

Application input adapters never infer payload presence from `stdin.isTTY` alone. For `send` and `fs write`, an explicit `--text` is authoritative and suppresses stdin reads in TTY and headless processes; stdin is consumed only when `--text` is absent. Cross-kind product commands receive one positional `<target>` and an optional expected-kind guard, while kind-specific commands use positional `<agent>` or `<group>` roles.

Transport resolution is capability-aware. A reachable direct Gateway cannot satisfy `host.fs.read`; SSH is never an implicit fallback. Resolution results are observable in response metadata and verbose diagnostics.

Profile writes use the same ConfigChange lock, revision check, schema validation, canonical temporary publication and readback as other preferences. The immutable transport DTO is derived from the stored camelCase fields; it is not a second disk schema or writer. Error/display projections redact secret-bearing fields.

### Credential references

Connection Profiles use three explicit string reference forms:

```text
env:<NAME>
file:<absolute-path>
keychain:<service>/<account>
```

For `file:` the config adapter opens with no-follow semantics, requires a regular file owned by the current POSIX user, rejects every group/other permission bit, and bounds the read to 1 MiB of valid UTF-8. Platforms that cannot prove POSIX ownership must use `env:` or `keychain:` instead.

The config adapter resolves and redacts these references. There is no plugin registry or versioned provider-object framework in v1. Built-in Mac App session discovery may decrypt the observed Grok Bot gateway descriptor for Gateway-only use; it is not a Cursor wake or quota credential. The explicit quota source resolves only its own reference and never reads App-private storage.

Remote bootstrap creates one high-entropy daemon credential, stores only its hash on the box, and writes the external raw value through a secret reference. v1 has no per-client principal registry: credential rotation is the revocation mechanism. Passwordless SSH normally runs the bootstrap helper so Gateway discovery remains inside the daemon. The implemented explicit Gateway-only maintenance path requires `transport=gateway`, `gatewayUrl`, and either `gatewayTokenRef` or `sshHost`; SSH discovery retrieves only the current token/generation into process memory and reruns after 401. It is never selected as fallback from daemon RPC.

Deferred multi-client identity and private App credential discovery are routed through [Roadmap](roadmap/README.md).

## 6. Transport Port

Application use cases depend on capability-shaped operations, not one giant generic RPC client. A transport advertises capabilities and implements only the operations it can honestly provide.

```text
DaemonTransport
  profile, Grok, fs, exec, jobs, events, daemon health

DirectGatewayTransport
  Grok commands and Gateway events only

LocalGatewayTransport
  same as DirectGatewayTransport, with discovery generation recovery

SandboxControlPort
  Sandbox inspect, wake and brokered keepalive only

ExplicitQuotaAdapter
  one fixed Cursor web quota method, fresh sanitized source-local result only

DesktopPrunePort
  daemon-only lit/idle classification and official stop-window prune

TailnetDiscoveryPort
  inspect an initialized local Tailscale node, enumerate bounded peer candidates,
  derive DNS/IP/Serve endpoints, and report existing Profile/credential matches
```

`TailnetDiscoveryPort` only reads an existing Tailscale installation through its CLI/LocalAPI projection. It does not install Tailscale, join a tailnet, consume auth keys, alter ACL/tags or enable Funnel. `init` must fail with `tailscale_not_ready` or present explicit bootstrap guidance when that prerequisite is absent.

`SandboxControlPort` 与 daemon/Gateway transport 分离，因为它使用 box 外 Cursor 身份，且在 box 完全不可达时仍需工作。拥有 `host.process.run` 不推出拥有 `sandbox.wake`；Tailscale RPC 内部 spawn 也不能替代 AnyRun brokered exec lease。静态 `profile capabilities` 只能从 secret reference 得出 `provider-authorization-dependent`，不能把配置存在解释成 provider 已授权。运行时 `box status` 只证明 inspect authority；wake 需要 `EnsureSandBox` 成功，keepalive 还需要 descriptor 下的 brokered no-op 与长时外部证据。

`ExplicitQuotaAdapter` 同样独立于 daemon/Gateway 和 Sandbox lifecycle。它从 selected Profile 的独立 quota ref 解出 OAuth token，在进程内解析 bounded subject/expiry 以构造固定 session cookie，向固定 HTTPS endpoint 发送一次空 JSON request，拒绝 redirect，并以 64 KiB 限制读取 body。它只把严格验证的 provider fields 投影为 fresh DTO；raw body、subject、token、headers、Machine ID、account identity 与 usage events 不离开 adapter。无配置、expired、401/403、rate limit/provider outage、oversized/malformed/protocol drift 分别映射稳定 quota errors；任何失败都不会切换 source、走 SSH、调用 Gateway/daemon 或触发 wake。盒内执行不改变这条边界：没有完整 `cursor-web` 配置就 fail-closed，不刮 host/App 私有存储，也不把外部 OAuth 拷贝当作盒内产品路径。host-owned Gateway 方法仍属 [Quota source expansion](roadmap/future/quota-query.md)。

The daemon protocol starts narrow. v1 finite methods use JSON request/response over Unix socket or loopback HTTP and map to explicit application use cases. The handshake reports protocol major, daemon version, capabilities, filesystem roots and Gateway generation; major incompatibility fails before side effects. There is no public SDK or generalized streaming framework. Events, Job logs and file transfer add the smallest command-specific streaming/chunking contracts in their owning slices. Promotion conditions for shared streaming live in [Daemon access and streaming](roadmap/future/daemon-access-and-streaming.md).

The current implementation covers both Unix-socket and authenticated loopback-HTTP daemon transport for handshake, health, roster reads and writes, transcript search/tail/thread, Memory reads, `sendPrompt`, and bounded unified event reads. The loopback listener compares a SHA-256 shared-credential hash before reading the RPC body; Tailscale Serve terminates private HTTPS and forwards only to `127.0.0.1`. Roster writes remain limited to create/update/delete agent, create group, replace group members, and notify/hidden settings; there is still no generic daemon method dispatch. `auto` resolves local daemon, direct local Gateway, then configured remote daemon; explicit `daemon` fails closed, while explicit `local` bypasses every daemon. Direct Gateway events remain available as a deliberately non-resumable compatibility adapter.

## 7. Box Daemon

`daemon serve` is the composition root. It creates listeners, auth/policy, discovery watcher, Gateway client, filesystem/process adapters, job manager, command-specific streams and shutdown hooks. The current implementation provides its foreground `0600` Unix listener, optional authenticated `127.0.0.1` HTTP listener, narrow Gateway adapter, versioned handshake, signal/abort shutdown, and socket cleanup. Bootstrap repacks a self-contained Node.js 20+ runtime with local npm, falling back to local Bun only when npm is absent, writes an atomic `0600` daemon config containing only the credential hash, and starts the foreground command through the bounded SSH deployment adapter. Install/upgrade/credential rotation merges and preserves the prior filesystem policy; only explicit `--admit-home-read` adds the peer home read/download root and never write authority. Current slices also provide governed Jobs, policy-aware capability projection, unified events, and experimental desktop classification/prune.

The daemon is the sole ordinary **remote** authority for host filesystem/process effects. It does not become authority for Grok product facts; it delegates those to Gateway use cases. Box-local Host process mutation for model runtime is a separate capability: `grokbox runtime *` does not ride daemon RPC, SSH, or generic exec. Official wrapper/supervisor still own Host desired liveness.

### Listener

Default listeners are Unix socket and/or loopback HTTP. Remote bootstrap uses the compatibility-proven node Serve handler at one explicit HTTPS port and records DNS, port, and loopback proxy URL. Every rotation verifies both the recorded ownership fact and the live exact handler before reusing it; drift or third-party occupancy fails closed. Removal uses only the matching `tailscale serve --https=<port> off` operation, never global reset. Binding a daemon RPC listener to `0.0.0.0` is rejected by daemon config validation. Generic Serve ownership and automatic endpoint migration remain in [Box lifecycle and tailnet hardening](roadmap/future/box-lifecycle-and-tailnet-hardening.md).

### Authentication and authorization

Network reachability and application authorization are separate checks. Local v1 uses socket permissions; remote v1 uses one high-entropy rotatable credential whose hash is stored on the box. The one v1 credential receives the configured capability/root policy, and the policy decision occurs before body streaming or process spawn. Tailnet identity may be audit context but is not sole authorization. The daemon never returns Gateway token, discovery raw JSON, routing headers or unrelated environment variables.

### Lifecycle

`daemon serve` runs foreground and handles graceful shutdown. Deployment owns restart policy. The current box has `tini` and no active systemd, so installation cannot assume systemd or modify the vendor `sand-supervisor` contract. A half-day lifecycle probe may prove an existing startup hook; if it does not, v1 stops there and relies on explicit `daemon ensure`/`recover` after absence rather than building a general-purpose supervisor. Additional-environment promotion conditions live in [Box lifecycle and tailnet hardening](roadmap/future/box-lifecycle-and-tailnet-hardening.md); the supported current runtime/monitor's persistence remains T40/T41, not deferred by this older daemon limit.

## 8. Gateway Adapter

The local adapter rereads discovery at process start and after 401, connection failure or generation drift. Wildcard bind addresses dial loopback. Non-loopback discovery fails closed unless an explicit remote Gateway Profile owns that route.

Gateway methods remain an allowlist. Management parity uses the verified `createAgent`, `createGroup`, `updateAgent`, `setGroupMembers`, `setAgentNotifyOnUpdates`, `setAgentHiddenFromSidebar`, and `deleteAgent` methods; it does not add `raw`. Because `updateAgent.profile` is a complete replacement shape, the application layer merges omitted attributes from the resolved roster row before writing. All member targets resolve and validate before one `setGroupMembers`; interrupted management writes return `operation_outcome_unknown` and are not automatically replayed.

Writes carry stable operation identity where Gateway supports it. Retry policy distinguishes refusal, known non-delivery, accepted, and unknown outcome. Response bodies are projected before leaving the adapter.

## 9. Filesystem Capability

Filesystem roots are policy objects, not string prefixes. The current read-side implementation admits them only from strict daemon config, resolves caller paths as `root:/relative/path`, canonicalizes through `realpath`, and checks operation permission before content access. Every content-bearing operation then opens with `O_NOFOLLOW`, verifies the Linux descriptor target through `/proc/self/fd`, and reads from that pinned descriptor; download chunks never reopen an authorized pathname. Handshake projection contains only each root name and its operation list, never the physical path. Traversal, symlink escape/replacement, pseudo-filesystems, daemon/Gateway private state, known credential directories/files, and shell/session credential files fail closed; directory listing uses a pinned directory descriptor and omits denied entries.

`fs read` is fixed at 1 MiB and returns either validated UTF-8 or explicit base64 in a JSON envelope. `fs download` opens an expiring transfer identity, exposes 256 KiB chunks up to 64 MiB, detects remote size/mtime drift, and always issues cancellation after completion or failure. The client allocates the transfer UUID before `open`, so an interrupted or lost open response can still be cancelled. The daemon reserves that ID before authorization/hash work; cancellation aborts pending work, and a short bounded tombstone prevents a reordered open from publishing after its cancel. SIGINT/SIGTERM and per-request timeout abort in-flight local or remote RPCs; cleanup uses a separate bounded cancellation RPC after removing the same-directory `0600` temporary file. The client checks byte count and SHA-256, then uses an atomic no-clobber link before removing the temporary name. Local-socket and remote-HTTP daemon clients use the same methods and projections. Gateway-only and explicit direct-local Profiles fail with `capability_unavailable` before Gateway, SSH, or local file access.

Write-side roots separately admit `write`, `mkdir`, `upload`, `remove`, and `remove-recursive`; the handshake advertises `host.fs.write` and recursive removal only when live root policy provides them. New destinations authorize and pin their existing parent directory, then operate through `/proc/self/fd/<parent>/<name>` so parent retargeting cannot redirect a mutation. Text writes are fixed at 1 MiB and use a same-directory `0600` temporary file, file fsync, descriptor snapshot revalidation, and atomic rename. Uploads are fixed at 64 MiB with exact 256 KiB ordered chunks, identical duplicate acceptance, changed duplicate rejection, size/SHA-256 verification, cancellation, and the same atomic commit boundary.

Every mutation carries a client-generated operation UUID. The daemon keeps a bounded ten-minute in-memory ledger with `pending`, `committed`, `not_committed`, `conflict`, and `unknown` projections; a lost response is reconciled through `fsMutationStatus` and is never blindly replayed. Restart with no ledger entry is honestly unknown. Mutations for one physical destination are daemon-serialized by the pinned parent `dev:ino` plus basename, so an in-root parent rename cannot split the lock identity. `--expected-sha256` compares a descriptor-pinned baseline and revalidates inode/size/mtime/hash immediately before rename. This fully fences concurrent grokbox writers, but Node has no portable hash compare-and-swap rename; an unrelated external writer retains one final syscall-sized race. v1 documents that limit instead of adding a Linux-native helper.

Removal never permanently deletes user content. It atomically renames files and authorized directories into an owner-only `.grokbox-trash` inside the same root and returns only an opaque trash ID. Non-empty directories require `--recursive`, the distinct `remove-recursive` root operation and `host.fs.remove.recursive`, plus confirmation. Recursive preflight rejects symlinks, blocked credential names, excessive depth, and excessive entries. The internal trash and temporary names are blocked from normal caller paths.

## 10. Process and Job Capability

Process spawn accepts literal structured argv, one descriptor-authorized named-root cwd, allowlisted bounded environment additions, hard runtime deadline and capture/discard output policy. Executable aliases map to startup-verified absolute non-symlink files and are revalidated by dev/inode immediately before spawn; ambient `PATH` is never resolution authority and the child does not inherit daemon `process.env`. Node.js has no portable `execveat`-style spawn-by-descriptor API, so an unrelated external replacement retains one final syscall-sized race; policy should point at administrator-owned executable paths. Shell parsing is unavailable unless an absolute shell is separately configured and `host.process.shell` is advertised. Admitting an executable is daemon-user code execution, not a filesystem sandbox; interpreters, shells, plugins and hooks can access authority beyond cwd.

Every accepted process gets a client-generated Job ID and protected `state.json` before spawn. Persisted metadata contains only a request fingerprint, logical cwd, executable alias, counts, states and bounded log counters; argv, environment values and output content are excluded. `logs.ndjson` is owner-only and contains bounded base64 chunks. The manager owns FIFO concurrency, process-group cancellation with TERM/KILL escalation, output draining/truncation, independent long-poll subscribers and terminal reconciliation. Process authority is admitted only on Linux: after spawn it records the process-group leader's `/proc/<pid>/stat` start identity, and termination snapshots a group containing that exact leader. Both TERM and delayed KILL recheck an original `pid:startTime` member, so an exited group whose numeric PGID was reused is never targeted. A final verification-to-signal syscall-sized race remains because Node exposes no pidfd-backed group signal; a disappeared or unverifiable group fails closed instead of signaling.

```text
queued -> running -> succeeded | failed | cancelled
                  -> interrupted | unknown
```

A transport timeout or follower disconnect does not mutate the authoritative Job state. `exec run` retries only the exact idempotent submission envelope with its original Job ID, then reconciles through `jobs show`; it never allocates a replacement identity or falls back to another transport. Clients resume bounded logs from an exact cursor and reconcile lifecycle with `jobs show`. Graceful daemon shutdown interrupts admitted work; prior-generation nonterminal metadata that cannot be proven against a live OS process becomes `unknown`, never invented success or failure.

## 11. Events and Coordination

Daemon event reads merge only declared sources: Gateway events, Jobs and daemon lifecycle. Every unified event names source, daemon-local sequence, observation time, relevant Gateway `{pid,startedAt}`, and an operation identity where one exists. Channel-specific allowlist projection, not recursive key redaction, controls payload shape; prompt, transcript/Memory content, filesystem/process data, child environment, and auth material are absent unless Memory content is explicitly requested.

The daemon owns a bounded in-memory journal: at most 2048 events, 32 MiB of retained projected payload, 128 events per page, and 128 concurrent long polls. Its exact cursor is `<daemon-generation>:<sequence>`. A first read returns the retained window; exact resumes continue after the cursor. A changed generation or evicted cursor emits `daemon_generation_changed` or `history_evicted` before continuing from the oldest available sequence. Gateway disconnect, malformed/oversized upstream SSE, and direct-Gateway resume attempts become explicit non-resumable gap events. Direct Profiles expose only the Gateway source.

The handshake pins `daemonGeneration` separately from Gateway generation. Every Job submit includes `expectedDaemonGeneration`, and daemon dispatch checks it atomically before admission; retries stay on the original client and cannot cross restart authority. Gateway 401 retry rereads discovery but sends a second Bearer only when the credential fingerprint changed; a generation-only change never reuses the rejected credential. Send retains its nonce; Job submit/cancel retain Job/cancel identities; filesystem mutations retain their ledger operation ID. Management writes are not replayed after unknown transport outcome and return an operation identity; a confirmed create with failed post-create projection also returns the created object ID and phase.

## 12. Cursor Sandbox Adapter and Keeper

Cursor adapter 对 `EnsureSandBox` 建立窄类型投影，只把 cluster/pod generation、连接面可用性和 lease observation 交给 application layer。v1 只接受通过 `sandbox.access_token_ref` 显式提供的 Cursor account access token；network token、exec auth、Gateway token 与 VNC descriptor 留在 adapter 内，不写普通日志、daemon RPC 或命令成功 envelope。对 App 私有账号 secret 的发现属于 [Roadmap candidate](roadmap/future/cursor-credential-discovery.md)，不是 v1 fallback。

`box wake` 是有限 use case：刷新 descriptor，并用 bounded brokered exec no-op 验证当前 descriptor。`box keepalive run` 是 box 外 foreground service：先取得 selected Profile 的单实例 lock，再带 jitter 地执行 `EnsureSandBox + brokered exec no-op`；每 tick 有限重试并对 401、429、provider outage 与 descriptor rotation 持久化 exact typed、脱敏状态。exec descriptor 401 只 remint 并复用同一 no-op identity 一次；account token reference 在每 tick 重读。它不调用 Gateway `sendPrompt`，也不生成 agent turn、transcript 或模型 token。`box status` 走独立只读 run-state RPC。

内部 cron、daemon activity、Tailscale ping、SSH、Gateway health 和 SSE 都不能登记为 Sandbox lease。VNC keeper 仅是 brokered exec 实验证伪后的候选，不在首个实现中。

由于 provider lease 语义并非稳定公开合同，交付必须包含 App 关闭条件下的 A/B 真实实验：keeper 运行 2 小时后再扩展到更长窗口，停止后观察 freeze，并从不可达状态验证 wake、Tailscale/IPv4、daemon 与 Gateway 恢复。`scripts/observe-sandbox.mjs` 在独立 runner 上将无凭据 SSH/Tailscale baseline、lease、stop-to-freeze 和 wake-recover 分开并持久化 bounded redacted evidence。Version 3 的 stop phase 在控制面候选前不调用 SSH/Tailscale；freeze 要求 Cursor 状态与被严格分类的外部 SSH network timeout/nonresponse 同时成立，认证、host-key、DNS 或配置失败均为 inconclusive。wake 要求显式 recover、SSH、daemon 和 `doctor.data.ok` 同时恢复。私有环境观察不升级为公共保证；完成显式 release-scoped 验证前不能声称替代常驻 Grok Bot.app。

## 13. SSH and Tailscale

Tailscale is the primary private network transport. ACL/tag policy limits which identities can reach daemon HTTPS; daemon policy limits methods after reachability.

SSH is a deployment adapter for bootstrap, upgrade and recovery. It may install/start/probe the daemon, but ordinary use cases never translate themselves into ad hoc SSH shell strings. SSH failure cannot silently trigger a different writer.

External doctor is a staged read-only probe: local Profile/config and secret/session source, optional Sandbox control-plane status, MagicDNS/Tailscale reachability and path, Serve HTTPS/TLS, daemon HTTP, daemon auth/capabilities, then in-box Gateway generation/health. Each boundary owns a distinct failure code. Without local, SSH, Sandbox exec or daemon evidence it reports Serve state as unverified rather than inferring remote configuration from a refused endpoint. Plain doctor never wakes, starts or installs software，也不能只凭 SSH timeout 宣称 freeze。A completed diagnostic returns exit 0 even for an unhealthy target; `data.ok` and each typed check are the health authority so callers can retain the full boundary report.

`recover` 是独立的显式组合恢复 use case，顺序固定为：必要时经 Sandbox adapter wake；等待 Tailscale peer 与 box IPv4 恢复；恢复 bootstrap 曾创建并记录的精确 private mapping；若 daemon 未运行，再经 SSH adapter 幂等 ensure；最后验证 daemon auth/capabilities 与 Gateway generation。它在任何 mutation 前拒绝缺失的 required credential，拒绝未记录、漂移或被占用的 Serve mapping，并只启动已存在且完整的 runtime/config。它不能首次安装/加入 Tailscale、启用 Funnel、修改 ACL/tag 或接管其他 mapping。`doctor` 不接受 mutating options，`profile doctor` 与 `daemon doctor` 不存在；Profile 事实由 `profile show/capabilities` 提供，daemon 局部事实由 `daemon status` 提供。

`daemon ensure` is the narrower recovery use case. With an SSH bootstrap adapter it first probes the selected endpoint, starts only an already-installed runtime when unreachable, and then revalidates the handshake. It neither wakes Sandbox nor repairs Serve. Installing or replacing daemon artifacts and first creating its exact private mapping is a separate `--bootstrap` transition with confirmation, Node/version and transferred-package SHA-256 checks, operation identity and redacted audit evidence. TTY `init` may compose it after confirmation; non-TTY orchestration requires both `--bootstrap` and `--yes`. Bootstrap controller fixtures are created directly under platform system Trash rather than permanently deleted.

## 14. Output and Redaction

The output boundary owns success envelopes, NDJSON, stable error codes and transport metadata. Adapters return typed internal results and sanitized error facts, never provider bodies.

Redaction tests include Profile secrets, Gateway Bearer, network headers, prompts, Memory content, filesystem content and subprocess environment. Verbose diagnostics may identify Profile, transport, endpoint host, operation ID and Gateway generation, but not secrets.

## 15. Verification Surfaces

Required lanes:

1. Static: strict TypeScript, Node.js 20+ runtime compatibility without Bun globals, registry completeness, and parser/help/skill option-set equivalence.
2. Command surface: natural-language intent routing, atomic `show` behavior, positional target roles, strict agent/group domains, rejected legacy routes, and unsupported-option refusal.
3. Headless input: explicit `--text` for `send` and `fs write` under non-TTY stdin, stdin-only payloads, missing payloads, and stable operation identity.
4. Unit: Profile precedence/defaults, capability routing, path policy, redaction and job state.
5. Fake integration: mock Gateway and daemon RPC for request/response/error contracts.
6. Local-real: packed CLI against foreground daemon over socket and live read-only Gateway probes.
7. External-preflight: prove the client runner is a distinct host, resolve required runtimes and secret/session-source presence without reading secrets, and reject same-host/self-loop fixtures.
8. Tailnet-real: execute the packed client on an external runner through private Tailscale Serve, with identity/auth, staged doctor, product commands and governed transfer/exec checks.
9. Sandbox-real: App closed, an independently scheduled external keeper without `sendPrompt`, 2-hour then 24-72-hour lease observation, stop-to-freeze and frozen-to-wake recovery.
10. Recover: from the external runner, prove frozen/unreachable Sandbox wake, Tailscale/IPv4 and Serve return, daemon stopped, explicit ensure, idempotent restart, bootstrap refusal/confirmation and post-recovery doctor.
11. Recovery: Gateway restart/token rotation, daemon restart, Serve drift, duplicate operation, stream gap, box hibernation and interrupted job.
12. Packaging: npm pack and isolated system-Trash install, bundle-content inspection, runtime helper assets beside `dist/index.js`, both executable names and identical help/version output, pre-bundle Node <20 refusal, missing-fixture preflight refusal, runtime operation without Bun, and cleanup.

A passing local fake does not prove tailnet identity, box persistence or external routing. A client process must actually execute on the external runner; proxying a local client through SSH is insufficient. Nested orchestration is acceptable for ordinary E2E only when the test command itself runs externally. Freeze/wake evidence is valid only when its observer remains scheduled outside the target box and stores evidence independently. Each delivery claim names the lane, runner roles and artifacts it exercised.

## 16. Migration from Current v1

Migration is contract-first:

1. Stabilize the current v1 agent-first command surface before adding transports: move transcript search to `history search`, make target roles positional, keep agent/group domains strict, separate object detail from history, fix headless text input, and make the registry own every accepted option.
2. Remove replaced v1 routes rather than retaining compatibility aliases. The package is pre-stable, and dual routes would preserve ambiguous natural-language choices in help and skills.
3. Add idempotent `init`, Profile resolution, Tailnet discovery and shared-credential bootstrap while preserving current no-config local behavior.
4. Add the external Sandbox control port and bounded wake/keeper commands without coupling them to daemon transport.
5. Introduce capability-shaped application ports around existing Gateway commands.
6. Add foreground daemon and local transport; keep direct local Gateway as compatibility path.
7. Add management parity, remote daemon, filesystem and jobs as independent vertical slices.
8. Move the default remote path to daemon only after equivalent command and recovery tests pass.
9. Remove duplicated writers or fallback paths only after callers and docs no longer depend on them.

Current implementation remains source reality until each slice lands. This document changes only when the accepted target boundary changes; provider/runtime observations belong in tests or reports and may challenge it.

## 17. Box-local model runtime

**2026-09-16 accepted modeld consolidation:** [ADR](decisions/2026-09-16-modeld-effect-core.md) and the existing [Spec S10](roadmap/box-runtime-impl-spec.md#modeld-effect-core) own the next execution-core change. Keep the native Host loop/tools/delivery, one kernel and one durable execution index. Separate deployment proof, live execution fences and observation. Audit native authority before removing supplemental Server checks; keep strict freshness defaults until a separately qualified policy decision. Effect owns shared source and waiter lifetimes; no second daemon, universal collector or hidden restart/replay. [T43–T50](tickets/README.md#modeld-effect-core) carry scope and proof, not an implementation-complete claim.

### 2026-09-17 Local context maintenance boundary（源码已实现，发布分层取证）

[Spec S12](roadmap/box-runtime-impl-spec.md#context-maintenance)与[ADR](decisions/2026-09-17-local-context-maintenance.md)扩展本节上下文职责：kernel拥有本地工作预算、按root的一次维护程序与摘要请求寿命；Host拥有材料分区、输入队列、候选接受、archive/carrier/root/checkpoint。主动、手动、硬预算与T32失败恢复共用该程序，后者仍受零放行/一次额外主请求约束。不是另一个Agent loop、历史store或Host部署控制器。

Host在有资格的原生安全点通过有界modeld协议取得最小捕获策略并在IPC前计量；不导入统一配置reader、ops、SDK或Effect。modeld的prepare及最终HTTP门复核同一budget/编码；adapter不compact或改写历史。手动无STEP维护以独立operation/root能力授权，可信conversation-compaction子请求使用同一ModelBackend/BackendAuth和捕获模型，不能借memory purpose或伪造业务STEP。

候选先预算/结构验证再由Host版本化接受并checkpoint，回执丢失按真实root对账；ExecutionHistory只记录维护身份/阶段和提交引用，不存第二份可回放正文。Effect负责source/waiter、期限、取消和资源，但不是原生事务或远端取消证明。当前源码已支持默认auto/schema3/wire8，原部署不会因代码提交自动升级；[CTX-00–CTX-04](tickets/README.md#context-maintenance)记录实现及离线/Node/原生隔离证明，[固定报告](reports/2026-09-17-context-maintenance-offline.md)保留证明边界与独立review缺口。实际采用只认LIVE当前索引，不从临时存储或fixture推断现役原生事务。

**复用边界：** S12.0固定一个 `ContextCompactionAlgorithm` port，kernel只见grokbox只读材料/sourceRef/候选和受限请求能力；box-runtime `internal/context/pi-compaction.ts` 封装实际Pi core算法，`pi-projection.ts`负责有界投影/映射。Host保有原始对象/metadata，Pi的retainedTail/Entry只作临时视图，不持久化为第二会话。CTX-00已依据公共API/Node/serializer证据选择受控纯代码提取，来源/许可/差异就在vendor中；后续升级仍按直接依赖→最小补丁→提取→有证据局部重写审查，不因Effect风格重写全部，不向Host/preload或kernel导入Pi运行时。维护捕获的credential指纹与原TURN绑定共享，终态/撤销或scope改变仍由原执行域阻断，不借context请求创建第二授权事实。

摘要算法提出的每个请求仍由唯一Effect/ModelBackend/BackendAuth运行，公共Models桥或受控callback不能开启隐式认证/重试/目录刷新或新Runtime；只有实际Provider是测试替身，算法不能被mock掉冒充集成。当前AI SDK继续供给模型传输；[PI-AI-01](tickets/PI-AI-01-model-backend-qualification.md)另评估进程内pi-ai Provider，并非T30 RPC。新的Node最低版本/完整AgentHarness/SessionManager/模型store不在本轮默许范围，打包与许可差异显式审查。

### 2026-09-18 Single-current-state continuity and handover（目标，尚未交付）

[S13](roadmap/box-runtime-impl-spec.md#continuity-architecture)固定单盒公共链路：真实身份→prepare hold→受管指令/材料初始化→原生commit/read-back/reopen→激活→逐职责交接与退役。每Bot只维护唯一当前工作上下文，contextRevision/activationEpoch不是会话目录；快照vault是非权威备份，原生Host仍是活状态和Agent loop的最终writer。

kernel continuity保存纯规则；既有config writer管理保护/权限；monitor/OBS只发布证据/意图；受监督的continuity Effect owner协调正式创建、当前状态控制、职责和关系ports。管理DB中的operation/duty/ancestry及vault发布需要显式恢复协议，不能用本地CAS宣称跨原生/服务端事务。现有session适配器、S12、Routine和title writer复用，不另造模型loop或多session控制面。

新Bot开始可确认职责时，旧Bot可继续指路/处理旧结果；职责、关系、恢复质量与退役分别表达，不要求旧端全局idle。未知effect只隔离相关职责/冲突资源，健康旧入站观察与未结依赖决定退役。OBS/Template Ops持有通知目标、诊断/告警权限和容量策略，CONT只消费其typed边界，不重复实现。完整阶段和代码落点只在S13，不在本页复制第二实施表。

### 2026-09-18 Native Bot ops / bounded evidence boundary（目标，尚未交付）

[Template Ops Spec §9](roadmap/template-ops-automation-spec.md#layout)是唯一骨架：OBS-00–03拥有最低证据、intake、固定manifest和视图；T41原SQLite扩展incident/evidence/outbox/预算/租约各受限事务域。OBS-04拥有诊断容量/轮转/分层GC，OBS-05通过原执行/恢复/制品owner实施安全退役，不把安全账本当日志。现有ConfigChange管理ops与下一版storage偏好，bindings/grants/实测容量/租约归各机器状态owner；本轮不改现役schema3。

`monitor.runtime.ts`在同一宿主分开有界source读取、本地drain、检测和通知子Scope，慢上游不能拖住本地异常；单DB事务writer，网络在事务外。`storage-maintenance.runtime.ts`是现有服务内的维护组合，不新增daemon，必要GC不随通知关闭。跨manifest/blob/DB/controller使用稳定引用、部分提交和恢复协议，不宣称跨文件原子事务；GET不capture/GC/续租。

默认目标Bot只提醒安全摘要、ID和可信registry生成的只读命令，不执行它们、不自动分析或询问Issue。用户委托后原生Bot仍能自主取证、管理Bot/模型并核验；使用原Agent loop和既有工具，不把提醒策略写成永久只读persona。后续Host维护调度只调用唯一controller，Bot交接后先结束，原生排空屏障和实际回执决定完成。

普通规则/视图为纯TS，IO/租约/退避/取消复用仓库Effect pin/Scope；Host/preload不导入Effect/SQLite/CLI/Webhook或ops配置。默认不采集原始正文，local/bot/public分层投影保留诊断关系。通知reference不是执行权限，同UID任意shell不是安全沙箱；缺工具隔离资格时不开放自动诊断/维护。

T53的AgentRoutines由CLI native adapter装配，通用CRUD/create-update/模板配对共用程序，原生scheduler仍是权威。T54先交付一个固定目标与binding，T55的高级路由/备用/一层交接后置；unknown不广播，路由不改模型、不放大真实Bot额度。CONT通知消费同一outbox，恢复manifest/blob仍由S13私有owner控制。

T52/T56延期，首发不建支持发布worker/REST adapter或issue grant。未来用户决定后仅GhIssuePublisher复用已有可用gh身份，无认证则本地保留，不提取token/切身份。通知、诊断、控制、公开四种副作用不能互相借权。

### 2026-09-12 Observation and incident management boundary

**First local slice implemented; full T41 remains open.** [Spec S0.1.4](roadmap/box-runtime-impl-spec.md#continuous-observation) / [T41](tickets/T41-continuous-observation-and-alerting.md) add a scoped long-lived observer before Web UI. It reuses T37's native evidence acquisition and T27/T33 DTOs, not a second admission or controller. Box identity, account/team/backend scope, Bot identity and each source/runtime epoch remain explicit. CLI and future API read one projection and use the existing command programs.

The current `monitor.runtime.ts` collector, `monitor-store.node.ts` transaction adapter and pure `kernel/monitor.ts` policy form one CLI/application path. `init` and `run` are explicitly confirmed, queries only reopen local committed snapshots, and management uses request identity plus incident revision. Installation and native delivery remain separate gates; incremental storage, crash and retention proofs retain their scoped source/test evidence in [T41](tickets/T41-continuous-observation-and-alerting.md). See [current operations](maintainers/continuous-observation.md) rather than treating every historical gap as unimplemented.

The observer's Node adapter owns `${durableRoot}/observability/observations.sqlite` on that Box; no Host leaf SQLite import, browser direct access or cross-machine shared database. Current-state/index rows are rebuildable only from available sources; observed transitions and incident acknowledgement/snooze/notification receipts have their own retention and durability, not an assumed disposable-cache policy. J13/raw provenance and native Host stores stay with their existing writers. The database is never configuration, transcript, execution, identity or deployment authority.

Collector/incident writes are explicit background capabilities, not GET side effects. Network sampling precedes a bounded local transaction; committed observation/incident updates are published with source/scope/cursor. Notification sends happen outside that transaction with stable delivery IDs and honest unknown/retry semantics; they cannot invoke model, tool or control effects. Corruption/migration/retention use controlled maintenance and preserve gaps. T37 consumes qualified live evidence, never restored SQL green state, and does not wait for database or notifier availability.

Current source uses a disk SQLite adapter with incremental transactions and explicit maintenance; the early sql.js full-image adapter is retired. The database, indexes, auxiliary files and retained references need physical capacity accounting, not a lifetime row quota. [OBS-04](tickets/OBS-04-bounded-observation-storage.md) extends bounded retention/reclamation without changing original J13, configuration or execution authority. Host/preload does not load the database; package/runtime qualification stays with source and executable tests.

Monitor resources belong to the existing Effect runtime/service owner, not the webpage. UI later adds snapshot/subscription and command calls; it does not start a collector per tab. Model/monitor configuration still uses ConfigurationWrite; incident management has its own revision and writer. Future product surfaces and fleet/external-offline limitations are in [future](roadmap/future/README.md).

### 2026-09-12 Server-authoritative Host-only completion

Accepted construction is [Spec S0.1.2](roadmap/box-runtime-impl-spec.md#server-authority-rollout). The new ticket boundaries are T37 ownership evidence/admission, T38 identity-writer retirement and conflict calibration, T39 native official/custom roundtrip qualification, and T40 persistent release/rollback; T24/T26/T28 remain the only selection, stream and controller programs. No App patch, second identity database, second provider loop or transcript merger is introduced.

- **Pure authority contract:** extract reusable scope/identity/freshness/classification rules into runtime-kernel's existing contract/command surface. CLI remains a projection; Host never imports CLI. Classification is not an authorization grant, nor a server lease.
- **Effects and native adapter:** the existing Host ownership bridge borrows the original authenticated Server client. T37 connects bounded refresh/invalidation to real asynchronous admission and native resume/turn fences without making synchronous PromptSession APIs asynchronous. Model credentials and Server identity credentials remain separate.
- **One write owner:** T38 removes harness from ordinary profile updates and retires local-over-server policy only after admission/protection is usable. Reconciliation is native and separately authorized; no direct product-db edits or hidden full-roster mutation.
- **Stable native state:** T24 changes future inference selection only; T26 retains Host root/metadata/tools/Memory/checkpoint. T39 proves originalSession can consume custom-persisted native state, not only a mock official prefix. Server/Mac are qualified read views, never prompt-authority replacements.
- **Deployment versus selection:** T40 uses T25/T28 exact process/receipt owners for persistent service and full unpatched exit. Per-Bot official choice does not require global deactivate. Real App routing is a compatibility proof, not authority to alter App code.

Implementation/offline/review evidence and planned-case status remain in [source tickets](tickets/README.md). Current live progress, missing proof and window evidence are routed only through the [LIVE index](tickets/LIVE-integration-validation.md); this section does not declare new gates implemented or maintain another deployment ledger.

Accepted ownership, not an implementation completion claim. Product obligations live in [product-contract §12](product-contract.md). **2026-09-12 R2:** [Spec S0](roadmap/box-runtime-impl-spec.md#stable-delivery) owns the current stable-delivery scope. Kernel remains the only attempt/recovery ledger; T35 adds the necessary Host STEP lifetime, summary scheduling/acceptance fence and native retry control before provider start. Host retains actual compact/root/tools/Memory/checkpoint writers. No second orchestrator, store, provider loop or mandatory new package. Design lives in [box-runtime.md](box-runtime.md). The [Current Implementation Spec](roadmap/box-runtime-impl-spec.md) now owns the forward **single-track rebuild** topology: new private `packages/runtime-kernel` for contracts/Effect programs, existing `packages/box-runtime` for Host leaf/adapters/roots, CLI as a thin caller. Its import/removal rules supersede preservation of POC internal APIs; the source-shaped descriptions below are substrate references, not permission to keep old execution tracks.

```text
packages/runtime-kernel/  private contracts/Effect programs (implemented; scope proof in tickets)
packages/box-runtime/     private Host/adapters/roots target (not a second npm)

/workspace/.grokbox/box-runtime/          durable (survives box reset; not git)
  config.json  models.json  profiles/reviewed.json  contracts/  host-bundles/  log/events.ndjson  secrets/
  state/installation.json  state/config-operations/  state/config-consumers/

~/.grokbox/run/                           box-runtime live state (not XDG)
  attestation.json  modeld.sock  ops/  state/

~/.grokbox/runtime/                       CLI install only; do not mix
```

Box-runtime live artifacts default to `~/.grokbox/run` even when `XDG_RUNTIME_DIR` is set. Daemon/Profile socket selection stays the existing XDG contract (`$XDG_RUNTIME_DIR/grokbox/daemon.sock`, fallback `~/.grokbox/run/daemon.sock`) and is not this tree.

Watchdog observes live Host source SHA read-only. On SHA change it extracts contract slices into `contracts/generations/<sha>/` (mode 0700/0600), updates HEAD, and reports slice drift. The same observe append-only retains full source bytes under `host-bundles/generations/<sourceSha>/`, isolated from transform/preload. It does not inject an unknown bundle, rewrite official `host-main.cjs` in place, restore Host from the archive, or write git. Contract slices keep at most 5 SHAs; host-bundles keep at most 16. Neither deletes the live SHA or the last SHA that matched a PatchProfile.

The current PatchProfile requires `create-session` and `agent-id` (`host.getConversationId()`, `invocationId: inferenceRequestId`, and `clientNonce: options2.clientNonce`). Optional slices include `compact-register`, `activity-bridge`, `memory-purpose`, `episode-purpose`, read-only harness declaration and ownership observation; authoring accepts only unique approved ids and rejects retired harness-writer slices. Missing optional hooks are inert. Changing a live slice is not loaded by merging git; the reviewed profile must be rewritten and `runtime re-adopt --confirm` is the only public live writer. The D2-approved [E07 purpose seam](maintainers/e07-path-b-host-admission.md) labels only the two real memory/episode factories and binds them to an actual completed STEP in the same managed session, never to prompt text or executor counts. Route seam sends a Bot to modeld only when `assignments.agents[agentId]` is set to an admitted managed model; missing override is official passthrough. `assignments.main` is not a session fallback. Historical T11 fallbacks are not the current contract: invalid/unreadable route selection and unqualified no-STEP managed calls fail visibly; valid unassigned Bots and dedicated native summary sessions retain their explicit original-session path. After wrap/dispatch errors remain correlated and never replay officially. Debug canary is grokbox test0 `00000000-0000-4000-8000-000000000114`. grokbox test1 `00000000-0000-4000-8000-000000000113` stays official and is not authorized for managed opt-in in this delivery.

Keep the Host leaf thin, but allow an extra exact patch when demonstrated stability/capability gains outweigh coupling and the profile/validator/behavioral gates are updated. The boundary normalizes in both directions: preserve Host-selected input, then reshape provider output into the original PromptSession/session/fullStream contract so the Host retains session/store/tools/SendToUser ownership. See the [Host seam adjudication](decisions/2026-09-08-host-seam-normalization-and-roadmap.md) and [implementation plan](roadmap/box-runtime-plan.md); neither grants live adoption authority.

Composition roots:

- `grokbox` CLI: box-local **Agent-first** runtime commands (`start`/`activate`/`deactivate`/`models`/`status`/`log`/`contracts`); `--profile` is invalid. No inject/heal/kill. Future in-box WebUI reuses these use cases. Public `activate` stays desired-only.
- `runtime start --mode observe|identity|route`: CLI calls the single `command.runtime.ts` program. Validate route configuration before effects, acquire through the same root-qualified `startModeldProcess` as `modeld run`, save desired through ConfigurationWrite, run the existing **unconfirmed reconcile** for identity/route, and publish status/configuration evidence. Its Effect Scope retains a newly owned modeld in the foreground and observes the actual `finished` lifetime as well as command cancellation; unexpected listener loss fails the command after cleanup instead of leaving a pretend-live process. Output failure also cleans up; a borrower returns and never stops the owner. No hidden detach, stub server, automatic adopt, autostart installation or second daemon. Scope cannot roll back an already committed configuration write; cancellation and missing production evidence remain explicit. Current verification bounds are owned by [T40](tickets/T40-persistent-release-and-rollback.md).
- `runtime re-adopt --confirm`: the only public CLI composition root with live Host adopt authority. It loads the durable reviewed profile and wires writable process/adopt ports into the shared coordinator. Missing `--confirm` or a non-local context refuses before live ports. Matching canonical identity + `attestation.diskSha === liveDiskSha()` + reviewed profile identity is a zero-signal no-op. Ownership that still matches while the SHA is stale (`reason=stale_attestation`) admits one manual deactivate→official→transient-adopt. An already-route Host whose ownership and `diskSha` still match may be refreshed once when the reviewed profile SHA changed. Watchdog without `--confirm` keeps that case zero-signal `route_mismatch`. Not a loop, daemon, or second writer.
- `runtime watchdog run`: single process-mutation coordinator + operation file, and the owner of future automatic reconciliation. This slice does not wire `processes`, `adopt`, or `reviewedProfile` mutation ports; it cannot automatically replace a live Host. Guardian is the sole emergency exception: idempotent `SIGCONT` of an exact frozen wrapper.
- `runtime modeld run`: `internal/roots/modeld.runtime.ts` composes the current v4 Unix server with the one `runtime-kernel` admission/binding/STEP program, canonical configuration/auth adapters and an explicit ModelBackend registry. `backends/ai-sdk.ts` provides a bounded canonical stream for Chat/Responses; `echo.ts` is explicitly selected, never fallback. The old modeld-ipc/modeld-as1/complete-array names are retired POC architecture. Effect lifecycle, epoch/TTL/tombstones and abort do not promise cross-restart resume. Same-connection HostCompact is opt-in; scoped persistent rollout and the complete deadline/root-acceptance contract remain T32/T35 work. SDKs remain outside Host leaf/CLI. **Dogfood/install start is packed Node:** `bun run build` then `bun run modeld:run` (Node `dist/index.js`, same as `./bin/grokbox runtime modeld run`). Do not point live modeld at worktree TypeScript (`bun run grokbox runtime modeld run`). Isolated packed proof is `packages/box-runtime/test/modeld-packaged-lifecycle.test.ts` after build.
- Host preload: exact SHA transform and thin session adapter. Bounded model-selection reads/fields may support `getModelId()` alignment on the existing ABI; no projection-file family is required first. It does not read canonical attestation or provider secrets, import Effect/SDK, or own admission/provider effects.
- read-only runtime status: explicit command run-root override reaches the shared observer; modeld `service-info` scopes readiness to the current durable/run roots and reports a generation. Missing/invalid identity is unknown and another root is not ready; health alone is not installation qualification, Bot ownership or admission. The six-facet projector stays unique.
- existing `daemon serve`: no default runtime mutation capability.
- non-public H3 launch-strategy port (not a CLI command): `direct-overlay` | `transient-adopt-candidate` | `unavailable`. Topology evidence is strategy-aware and must not treat every official chain as PPID-only.

H3 topology:

- `direct-launch` / `direct-overlay`: `findUniqueOfficialChain` — unique wrapper+supervisor+Host and supervisor-born Host (`host.ppid === supervisor.pid`). Do not weaken this finder to pass adoption.
- Canonical ownership is identity + singleton topology against the grokbox attestation; patch freshness is `attestation.diskSha === liveDiskSha()`. Freshness mismatch does not erase exact ownership (`origin=grokbox-attested`, `reason=stale_attestation`). Identity/census/gateway/topology/attestation mismatch stays `grokbox-unattested`/`ambiguous`.
- `transient-adopt`: `findAdoptedHostState` — logical adoption of a surviving Host. Success is **not** `host.ppid === supervisor.pid`. Evidence is a singleton wrapper/supervisor/Host, wrapper-owned supervisor, gateway pid agreement, stable Host identity, temp supervisor gone, adopting supervisor unpreloaded, disk SHA unchanged, attestation `launchMode: "transient-adopt"`. Mutation preflight still uses this finder; do not weaken `findUniqueOfficialChain`.
- Official replacement after TERM (`waitOfficialReplacement`): process-visible new Host is not proof. Wait until Gateway pid equals the pinned candidate; do not chase a later generation. `replacement-gateway-unproven` vs `replacement-unproven` stay distinct.
- Current official `sand-supervisor` is not `direct-overlay`. Classify `transient-adopt-candidate` only after exact version/capability review. The live adapter may run transient-adopt after unique-chain preflight; failed preflight stays zero-signal.
- Guardian remains SIGCONT-only on an exact frozen wrapper. The coordinator may identity-checked TERM the exact old official supervisor and the exact operation-owned temp supervisor during authorized H3. No SIGKILL of official wrapper/supervisor/Host.

`packages/box-runtime` is an unpublished workspace package. Do not publish it separately until an independently installed consumer exists. Offline transform and PromptSession contract tests are required before any live Host inject. An adopted-topology offline fixture must keep the final Host PPID different from the new supervisor; that fixture is not a live inject.

Credential rotation mid-turn is forbidden: pin the credential fingerprint with the resolved config. Idle cache cooling releases an AuthLease but keeps immutable binding metadata in the service-epoch execution index; reactivation must recheck the original fingerprint, ownership, model and selection revision. Idle time is not a TURN-expiry deadline.

The kernel remains the sole execution-identity writer. Its `ExecutionHistory` capability is backed by `io/execution-history.node.ts` (`classic-level`, one exclusive database owner) in the production modeld root. Claim persistence precedes provider dispatch; hot STEP records retire after settlement without deleting the exact durable duplicate/conflict evidence. A fresh service incarnation retires the old index before publishing its listener, while old-epoch requests remain fenced. This replaces the early process-lifetime 1,024-entry quota; database cache/compaction thresholds never constitute request-count quotas. Observation journals and group-progress queries cannot authorize execution or replay.

### 同通道 reasoning policy 补充（2026-09-17）

Catalog 的模型身份/能力与 schema v2 的 per-Bot assignment 分离。kernel 的纯 parser/resolver 输出 `ResolvedModelSelection`，policy 与 capability 进入 selectionRevision，deep-frozen snapshot 交给既有 TURN binding；持久绑定恢复再次验证完整选择与 revision。配置发布沿用唯一 Effect command/RuntimeStore/CAS，不建立旁路字段文件或另一套执行根。

box-runtime ModelBackend 在 prepare 验证能力、冻结设置，在既有 guarded fetch 的实际 HTTP 前校验白名单字段与 wire model，修正 SDK 对未识别兼容模型的参数省略而拒绝冲突。SDK 与最终 body 都使用同一 policy，none 不破坏 SDK 的采样语义。routeId 仍表示通道，不掺入档位；模型身份不因改档改变。Host 仍 SDK/Effect-free，prompt envelope 不新增任意 providerOptions。wire v7 保护新增 usage 终态；观察数据不授予执行权。详见[ADR](decisions/2026-09-17-model-reasoning-policy.md)。
