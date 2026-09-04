# `grokbox` CLI 目标实现架构

本文是 CLI、Profile、transport、box daemon 和 host capability 的实现边界 Current Home。它描述已接受的**未来完成态**；当前源码已经交付 Node.js 20+/Commander 的 agent-first registry、严格 Profile v1、local/remote `init` 和 daemon transport、Grok roster/transcript/Memory/send/management 有限方法、daemon-only 命名 root 文件能力、结构化 process 与 durable Jobs、generation-aware unified events/recovery、explicit OAuth quota adapter、external Sandbox lifecycle adapter、实验性 desktop classification/prune，以及 layered doctor/explicit recovery。剩余差距由外部 evidence、源码测试与本地 Issue tracker 共同拥有。

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
| ordinary cloud files | box filesystem through governed filesystem use cases |
| process/job runtime state | daemon job manager plus observed OS process state |
| Gateway generation | current discovery `{pid,startedAt}` |
| daemon capabilities | daemon policy and runtime capability probe |
| Sandbox allocation and lease | Cursor/AnyRun control plane observation |
| account quota | selected credential-owning Cursor/Sand quota source |
| keeper process state | external keeper state store and observed provider result |

正常 agent/group 管理只经 Gateway。离线文件修复不能成为第二个自动 writer；它必须是显式维护 use case，并在恢复前 fence 正常 writer。

## 3. Repository Shape

The published CLI and daemon execute on Node.js 20+ and must not call Bun runtime globals. Bun remains the repository package manager and may run development scripts, tests and TypeScript tooling. Both executable names share one `#!/usr/bin/env node` shim; its pre-bundle gate returns stable `runtime_unsupported`/59 before importing `dist` when the Node major is below 20 or unparseable. An npm-installed external client does not require Bun.

先保持一个发布包与一个 executable implementation；npm 同时把它暴露为 `grokbox` 和完全等价的 `gbox`。不要为未来对称性预建 package family。

```text
bin/
  grokbox                    executable shim shared by both bin names
src/
  index.ts                   process entry
  program.ts                 Commander projection
  registry.ts                command + capability metadata
  application/               transport-independent use cases
  config/                    global config and Profile resolution
  transports/
    local-daemon.ts
    remote-daemon.ts
    direct-gateway.ts
  quota.ts                    explicit bounded quota adapter and normalized DTO
  sandbox/
    port.ts                   inspect, wake and keepalive contract
    cursor.ts                 EnsureSandBox and descriptor adapter
    keeper.ts                 external lease loop and state
  gateway/                   discovery and narrow Gateway client
  daemon/
    host.ts                  composition root and shutdown
    protocol.ts              narrow v1 JSON RPC DTO
    policy.ts                credential/capability/root policy
    jobs.ts                  operation and process lifecycle
    filesystem.ts            governed file operations
    process.ts               structured exec adapter
  commands/                  argv/stdin/output adapters
  output/                    JSON, NDJSON, errors, redaction
skills/                      version-matched bundled skills
test/                        unit, integration and recovery tests
docs/                        product and runtime Current Homes
```

A second package is earned only when another independently released consumer needs the daemon protocol or application use cases. Until then, source modules provide boundaries without multiplying publication surfaces.

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

The config adapter owns path expansion, permissions, schema validation, secret redaction and precedence. Application use cases receive a resolved immutable Profile, not raw JSON.

The top-level `init [<name>]` use case owns first-run orchestration. It composes local environment inspection, a narrow `TailnetDiscoveryPort`, target selection, shared daemon credential bootstrap, atomic Profile persistence and staged doctor. Discovery DTOs never leak into ordinary command use cases, and discovery alone never grants trust. The optional positional name is the Profile being created or updated; global `--profile` only selects an existing Profile and is invalid for `init`.

When an explicitly selected remote peer has no usable daemon endpoint and a local, passwordless SSH, or Cursor Sandbox exec bootstrap adapter is available, TTY init may request confirmation and compose the bootstrap use case. Headless init requires `--bootstrap --yes`; without an adapter it returns `bootstrap_unavailable` and an in-box remediation command. Bootstrap owns grokbox daemon installation/update, loopback listener, shared credential creation/rotation and one exact tailnet-only mapping after the bounded compatibility probe succeeds; it does not install or join Tailscale, alter ACL/tags, enable Funnel, reset Serve, or overwrite another mapping.

`default` is synthesized before optional file overlay. Built-in defaults include:

```text
current profile       default
transport             auto
gateway discovery     /home/box/sand-data/gateway.json
finite timeout        10000 ms
daemon socket         $XDG_RUNTIME_DIR/grokbox/daemon.sock
fallback socket       ~/.grokbox/run/daemon.sock
```

Sandbox 没有隐式 account secret。Profile 只保存 `sandbox.access_token_ref`，其值使用 `env:`、`file:` 或 `keychain:` v1 reference；原始 Cursor access token 不进入 Profile、argv、日志或 box daemon。Quota 也必须显式声明完整的 `quota:{source:"cursor-web",access_token_ref:<ref>}`；它不借用 Sandbox ref，不把同一 OAuth token 的 quota 成功解释为 wake authority。macOS App descriptor 只提供 Gateway-only session，不推出 Sandbox wake 或 quota authority。

Application input adapters never infer payload presence from `stdin.isTTY` alone. For `send` and `fs write`, an explicit `--text` is authoritative and suppresses stdin reads in TTY and headless processes; stdin is consumed only when `--text` is absent. Cross-kind product commands receive one positional `<target>` and an optional expected-kind guard, while kind-specific commands use positional `<agent>` or `<group>` roles.

Transport resolution is capability-aware. A reachable direct Gateway cannot satisfy `host.fs.read`; SSH is never an implicit fallback. Resolution results are observable in response metadata and verbose diagnostics.

Profile writes use temporary file plus atomic rename. Directory/file modes are verified after creation. Error and display projections redact every secret-bearing field.

### Credential references

Profile v1 uses three explicit string reference forms only:

```text
env:<NAME>
file:<absolute-path>
keychain:<service>/<account>
```

For `file:` the config adapter opens with no-follow semantics, requires a regular file owned by the current POSIX user, rejects every group/other permission bit, and bounds the read to 1 MiB of valid UTF-8. Platforms that cannot prove POSIX ownership must use `env:` or `keychain:` instead.

The config adapter resolves and redacts these references. There is no plugin registry or versioned provider-object framework in v1. Built-in Mac App session discovery may decrypt the observed Grok Bot gateway descriptor for Gateway-only use; it is not a Cursor wake or quota credential. The explicit quota source resolves only its own reference and never reads App-private storage.

Remote bootstrap creates one high-entropy daemon credential, stores only its hash on the box, and writes the external raw value through a secret reference. v1 has no per-client principal registry: credential rotation is the revocation mechanism. Passwordless SSH normally runs the bootstrap helper so Gateway discovery remains inside the daemon. The implemented explicit Gateway-only maintenance path requires `transport=gateway`, `gateway_url`, and either `gateway_token_ref` or `ssh_host`; SSH discovery retrieves only the current token/generation into process memory and reruns after 401. It is never selected as fallback from daemon RPC.

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

`ExplicitQuotaAdapter` 同样独立于 daemon/Gateway 和 Sandbox lifecycle。它从 selected Profile 的独立 quota ref 解出 OAuth token，在进程内解析 bounded subject/expiry 以构造固定 session cookie，向固定 HTTPS endpoint 发送一次空 JSON request，拒绝 redirect，并以 64 KiB 限制读取 body。它只把严格验证的 provider fields 投影为 fresh DTO；raw body、subject、token、headers、Machine ID、account identity 与 usage events 不离开 adapter。无配置、expired、401/403、rate limit/provider outage、oversized/malformed/protocol drift 分别映射稳定 quota errors；任何失败都不会切换 source、走 SSH、调用 Gateway/daemon 或触发 wake。盒内执行不改变这条边界：没有完整 `cursor-web` 配置就 fail-closed，不刮 host/App 私有存储，也不把外部 OAuth 拷贝当作盒内产品路径。host-owned Gateway 方法仍属 [Quota source expansion](roadmap/quota-query.md)。

The daemon protocol starts narrow. v1 finite methods use JSON request/response over Unix socket or loopback HTTP and map to explicit application use cases. The handshake reports protocol major, daemon version, capabilities, filesystem roots and Gateway generation; major incompatibility fails before side effects. There is no public SDK or generalized streaming framework. Events, Job logs and file transfer add the smallest command-specific streaming/chunking contracts in their owning slices. Promotion conditions for shared streaming live in [Daemon access and streaming](roadmap/daemon-access-and-streaming.md).

The current implementation covers both Unix-socket and authenticated loopback-HTTP daemon transport for handshake, health, roster reads and writes, transcript search/tail/thread, Memory reads, `sendPrompt`, and bounded unified event reads. The loopback listener compares a SHA-256 shared-credential hash before reading the RPC body; Tailscale Serve terminates private HTTPS and forwards only to `127.0.0.1`. Roster writes remain limited to create/update/delete agent, create group, replace group members, and notify/hidden settings; there is still no generic daemon method dispatch. `auto` resolves local daemon, direct local Gateway, then configured remote daemon; explicit `daemon` fails closed, while explicit `local` bypasses every daemon. Direct Gateway events remain available as a deliberately non-resumable compatibility adapter.

## 7. Box Daemon

`daemon serve` is the composition root. It creates listeners, auth/policy, discovery watcher, Gateway client, filesystem/process adapters, job manager, command-specific streams and shutdown hooks. The current implementation provides its foreground `0600` Unix listener, optional authenticated `127.0.0.1` HTTP listener, narrow Gateway adapter, versioned handshake, signal/abort shutdown, and socket cleanup. Bootstrap repacks a self-contained Node.js 20+ runtime with local npm, falling back to local Bun only when npm is absent, writes an atomic `0600` daemon config containing only the credential hash, and starts the foreground command through the bounded SSH deployment adapter. Install/upgrade/credential rotation merges and preserves the prior filesystem policy; only explicit `--admit-home-read` adds the peer home read/download root and never write authority. Current slices also provide governed Jobs, policy-aware capability projection, unified events, and experimental desktop classification/prune.

The daemon is the sole ordinary remote authority for host filesystem/process effects. It does not become authority for Grok product facts; it delegates those to Gateway use cases.

### Listener

Default listeners are Unix socket and/or loopback HTTP. Remote bootstrap uses the compatibility-proven node Serve handler at one explicit HTTPS port and records DNS, port, and loopback proxy URL. Every rotation verifies both the recorded ownership fact and the live exact handler before reusing it; drift or third-party occupancy fails closed. Removal uses only the matching `tailscale serve --https=<port> off` operation, never global reset. Binding a daemon RPC listener to `0.0.0.0` is rejected by daemon config validation. Generic Serve ownership and automatic endpoint migration remain in [Box lifecycle and tailnet hardening](roadmap/box-lifecycle-and-tailnet-hardening.md).

### Authentication and authorization

Network reachability and application authorization are separate checks. Local v1 uses socket permissions; remote v1 uses one high-entropy rotatable credential whose hash is stored on the box. The one v1 credential receives the configured capability/root policy, and the policy decision occurs before body streaming or process spawn. Tailnet identity may be audit context but is not sole authorization. The daemon never returns Gateway token, discovery raw JSON, routing headers or unrelated environment variables.

### Lifecycle

`daemon serve` runs foreground and handles graceful shutdown. Deployment owns restart policy. The current box has `tini` and no active systemd, so installation cannot assume systemd or modify the vendor `sand-supervisor` contract. A half-day lifecycle probe may prove an existing startup hook; if it does not, v1 stops there and relies on explicit `daemon ensure`/`recover` after absence rather than building a general-purpose supervisor. The probe and deferred promotion conditions live in [Box lifecycle and tailnet hardening](roadmap/box-lifecycle-and-tailnet-hardening.md).

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

Cursor adapter 对 `EnsureSandBox` 建立窄类型投影，只把 cluster/pod generation、连接面可用性和 lease observation 交给 application layer。v1 只接受通过 `sandbox.access_token_ref` 显式提供的 Cursor account access token；network token、exec auth、Gateway token 与 VNC descriptor 留在 adapter 内，不写普通日志、daemon RPC 或命令成功 envelope。对 App 私有账号 secret 的发现属于 [Roadmap candidate](roadmap/cursor-credential-discovery.md)，不是 v1 fallback。

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
12. Packaging: npm pack and isolated system-Trash install, bundle-content inspection, both executable names and identical help/version output, pre-bundle Node <20 refusal, missing-fixture preflight refusal, runtime operation without Bun, and cleanup.

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
