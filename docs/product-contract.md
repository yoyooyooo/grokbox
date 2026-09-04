# `grokbox` CLI 产品合同

本文是 `grokbox` 命令、Profile、输出和能力边界的 Current Home。它描述已经接受的**未来完成态**，不是当前源码能力清单。当前实现已覆盖 agent-first CLI、Profile/init、local/remote daemon、agent/group management、governed filesystem、structured exec/durable Jobs、generation-aware unified events/recovery、显式 OAuth quota adapter、Cursor Sandbox lifecycle adapter、实验性 desktop 管理，以及 layered doctor/explicit recovery；最终外部 evidence matrix 仍由后续本地 Ticket 跟踪。交付进度必须由本地 Issue tracker 与源码/测试证明，不能只从本文的未来完成态推断。

实现边界见 [CLI 架构](architecture.md)。当前 quota source、DTO、错误和真实证据见 [Quota Current Home](quota.md)。Cursor Sandbox、`EnsureSandBox`、freeze 与外部 keeper 背景见 [Sandbox 控制面](cursor-sandbox-control-plane.md)。当前 Gateway 与 box 信任事实见 [上游集成](upstream-integration.md)。非官方身份、商标和上游私有接口的稳定性等级见 [兼容性边界](compatibility.md)。

## 1. 产品定位

`grokbox` 是 Grok Bot 云电脑的统一控制面 CLI。同一条命令可以在云电脑内外执行，调用者只选择 Profile，不需要知道背后使用 Unix socket、loopback Gateway、Tailscale daemon RPC 还是直接 Gateway。`gbox` 是完全等价的短别名；帮助、输出、配置与行为均以 canonical name `grokbox` 表述。

发布的 CLI 与 daemon 运行时合同是 Node.js 20+，不得依赖 `Bun.*` globals 或要求最终用户安装 Bun。两个 executable name 共用一个 pre-bundle Node shim；Node major 低于 20 或不可解析时，在加载 bundle 前返回稳定 `runtime_unsupported`/59。仓库仍使用 Bun 执行依赖安装、`bun run`、测试和其他开发流程；开发工具选择不进入用户运行时合同。

```text
User / Agent / Skill
        |
        | grokbox [--profile <name>] <command>
        v
Profile + capability router
        |
        +-- local daemon socket
        +-- Tailscale daemon RPC
        +-- local Gateway discovery
        +-- explicit remote Gateway compatibility path
        `-- explicit quota source -> Cursor/Sand Dashboard
```

CLI 统一四类能力：

1. Grok Bot 产品能力：agent、group、消息、transcript、Memory 和 events。
2. 云电脑能力：受控文件读写、命令执行、长任务和 artifact 传输。
3. Sandbox 生命周期能力：从外部唤醒、维持 lease 和观察 Cursor/AnyRun 状态。
4. 账号额度能力：由显式 credential-owning source 返回 fresh sanitized quota，不从 transcript 推算。
5. 连接与运行能力：Profile、doctor、daemon 和版本匹配的 bundled skills。

正常远程路径由 box 内 daemon 持有 Gateway discovery 与本机权限。Sandbox wake/lease 由 box 外控制面 adapter 持有，因为 cgroup freeze 后内部 daemon 不能唤醒自己。外部客户端不需要获得 Gateway Bearer。SSH 只负责 bootstrap 与故障恢复，不是日常命令 transport。

## 2. 默认体验

安装后逻辑上始终存在名为 `default` 的 Profile。没有配置文件时，下列命令仍然成立：

```bash
grokbox doctor
grokbox agents list
grokbox is running <id>
```

用户只在切换环境时显式使用 Profile：

```bash
grokbox --profile remote agents list
grokbox profile use remote
grokbox agents list              # 此后使用 remote
```

选择优先级固定为：

```text
--profile <name>
GROKBOX_PROFILE
~/.grokbox/config.json 的 current_profile
default
```

任何有稳定默认值的字段都可省略。CLI 不要求用户为本机常规路径填写 `gateway_discovery`、daemon socket、timeout 或输出模式。

### 2.1 首次初始化

```bash
grokbox init
grokbox init --local
grokbox init remote --peer <tailnet-peer>
grokbox init --peer <tailnet-peer> --bootstrap --yes
grokbox init remote --peer <tailnet-peer> --bootstrap --admit-home-read --yes
```

`init` 是幂等的首次连接 use case，不是项目目录生成器。它按当前环境执行：

```text
inspect local Gateway / daemon
  -> inspect already-initialized Tailscale
  -> derive Self/peer DNS, IPv4 and Serve endpoint
  -> select exactly one target
  -> create or resolve the shared daemon credential when required
  -> atomically create/update Profile and current_profile
  -> run staged doctor
```

TTY 中可以从候选节点选择；非 TTY 在无法唯一确定目标时返回候选摘要与 `target_ambiguous`，要求显式 `--local` 或 `--peer`。只有一个与现有 Profile/credential 匹配的目标时，`init` 可以将它设为当前 Profile；不能仅凭 peer 出现在 tailnet 中就静默授予 daemon 信任。

Bootstrap 安装、升级或轮换 credential 时必须原样保留既有 filesystem root policy，包括“没有 root”的窄策略。`--admit-home-read` 是独立的显式 policy transition，只能与 `--bootstrap` 同用；它将 peer home 的 `stat/list/read/download` policy 合并到既有 roots，TTY confirmation 必须披露该扩权，headless 必须同时提供 `--yes`。

当显式选择远程 peer 且 daemon/private endpoint 尚未就绪时，若存在 local、免登 SSH 或 Cursor Sandbox exec bootstrap adapter，TTY `init` 可以请求一次确认后组合调用 bootstrap use case；非 TTY 必须同时提供 `--bootstrap --yes`。没有可用 adapter 时返回 `bootstrap_unavailable`，并提示在 box 内运行 `grokbox daemon ensure --bootstrap`。bootstrap 幂等安装或升级 grokbox daemon、建立 loopback listener、创建一个可轮换 daemon credential，并配置 bounded Serve spike 已证明可隔离和回滚的精确 tailnet-only mapping。它不得执行 `tailscale serve reset`、覆盖其他 mapping 或开启 Funnel。

`init` 不自动安装 Tailscale、不执行 `tailscale up`、不消费 auth key、不修改 tailnet ACL/tag，也不开放 Funnel。没有 bootstrap 授权时，它只诊断并返回稳定错误和可直接执行的 remediation command。`profile add` 保留为需要手工 endpoint/secret-reference 字段时的高级 fallback；常规用户不需要先理解 Profile JSON。

`--profile` 始终表示“选择一个已经存在的 Profile”，不承担创建目标的命名职责。`init` 的可选位置参数 `<name>` 是要创建或更新的 Profile 名称；省略时使用 `default`。因此 parser 必须拒绝 `grokbox --profile remote init` 和 `grokbox init --profile remote`，避免同一个参数在不同命令中改变角色。

## 3. 完整命令树

```text
grokbox (alias: gbox)
├── init [<name>] [--local | --peer <name-or-dns>] [--bootstrap] [--admit-home-read] [--yes]
├── skills
│   ├── list
│   └── get <name> [--full]
├── profile
│   ├── list
│   ├── show [<name>]
│   ├── use <name>
│   ├── add <name> [connection options]
│   ├── update <name> [connection options]
│   ├── remove <name>
│   └── capabilities [<name>]
├── doctor
├── quota
├── recover
├── agents
│   ├── list
│   ├── show <id-or-name>
│   ├── create --name <name> [agent attributes]
│   ├── update <id-or-name> [agent attributes]
│   └── delete <id-or-name> [--yes]
├── groups
│   ├── list
│   ├── show <id-or-name>
│   ├── create --name <name> --member <id-or-name>...
│   ├── update <id-or-name> [group attributes]
│   ├── members
│   │   ├── list <group>
│   │   ├── add <group> <agent>
│   │   ├── remove <group> <agent>
│   │   └── set <group> --member <agent>...
│   └── delete <id-or-name> [--yes]
├── send <target> [--text <text> | stdin] [--expect-kind agent|group] [--nonce <uuid>]
├── history
│   ├── search <query>
│   ├── tail <target>
│   └── thread <target> --root <entry-id>
├── memory
│   └── list <agent> [--content]
├── events
├── is
│   └── running <target>
├── fs
│   ├── stat <remote-path>
│   ├── list <remote-path>
│   ├── read <remote-path>
│   ├── write <remote-path> [--text <text> | stdin]
│   ├── mkdir <remote-path>
│   ├── upload <local-path> <remote-path>
│   ├── download <remote-path> <local-path>
│   └── remove <remote-path> [--recursive] [--yes]
├── exec
│   └── run [--cwd <remote-path>] [--env <key=value>...] [--detach] -- <argv...>
├── jobs
│   ├── list
│   ├── show <job-id>
│   ├── logs <job-id> [--follow]
│   └── cancel <job-id>
├── desktop
│   ├── status
│   ├── keep
│   │   ├── add <agent>
│   │   └── remove <agent> --yes
│   └── prune
│       ├── run [--yes]
│       ├── enable
│       └── disable
├── box
│   ├── status
│   ├── wake
│   └── keepalive
│       ├── run [--interval-ms <n>]
│       └── status
└── daemon
    ├── serve
    ├── ensure [--bootstrap] [--admit-home-read] [--yes]
    └── status
```

顶层不提供 `raw` 或任意 `/api/<method>` fallback。新增 Grok Bot 或 host 能力必须先获得命令语义、权限、输出和恢复合同。

## 4. 全局选项

```text
--profile <name>       选择执行 Profile
--json                 JSON 输出；有限命令默认即为 JSON
--table                声明支持时输出人读表格
--timeout-ms <n>       有限请求 deadline；默认 10000
--verbose              stderr 输出 transport 与恢复诊断，不输出凭据
--help
--version
```

Profile、timeout 和输出 flags 可放在顶层命令前。未知 flag 在本地失败，不发起网络请求。

`--profile` 只对消费已有 Profile 的命令开放；`init` 的目标 Profile 使用位置参数，`profile add/update/use/remove` 的 Profile 名称也使用各自的位置参数。registry 必须逐叶声明允许的 option 集合：不支持表格的命令不会在 parser/help 中出现 `--table`，纯本地命令不会出现无意义的网络 `--timeout-ms`。

## 5. Profile 合同

### 5.1 文件布局

```text
~/.grokbox/
├── config.json
└── profiles/
    └── <name>/config.json
```

全局配置最小形状：

```json
{
  "version": 1,
  "current_profile": "default"
}
```

持久化全局配置同样要求 `version: 1`；未知 version/field 返回 `profile_invalid`。`current_profile` 缺失时回退到 `default`。

`default` 是内置逻辑 Profile，不要求 `profiles/default/config.json` 存在。用户创建同名文件时，只覆盖显式字段，不需要复制默认值。

### 5.2 Profile 字段

```json
{
  "version": 1,
  "transport": "auto",
  "server_url": "https://grokbox.example-tailnet.ts.net",
  "daemon_token_ref": "keychain:grokbox/default/daemon",
  "gateway_url": "https://gateway.example",
  "gateway_token_ref": "env:GROK_BOT_GATEWAY_TOKEN",
  "gateway_headers_ref": "file:/path/to/gateway-headers.json",
  "gateway_discovery": "/home/box/sand-data/gateway.json",
  "daemon_socket": "/path/to/grokbox/daemon.sock",
  "ssh_host": "grokbox.example-tailnet.ts.net",
  "sandbox": {
    "access_token_ref": "env:CURSOR_ACCESS_TOKEN",
    "keepalive_interval_ms": 600000
  },
  "quota": {
    "source": "cursor-web",
    "access_token_ref": "keychain:grokbox/quota"
  }
}
```

持久化 Profile 必须显式包含 `"version": 1`；其他字段可选。内置 `default` 没有文件时由程序合成。v1 对未知 schema version 和未知字段返回 `profile_invalid`，并且在解析任何 secret reference 之前失败。字段语义：

| Field | Meaning |
| --- | --- |
| `version` | Profile schema version；v1 固定为 `1` |
| `transport` | `auto`, `daemon`, `local`, or `gateway` |
| `server_url` | daemon HTTPS endpoint，通常由已验证的 tailnet endpoint 暴露 |
| `daemon_token_ref` | v1 单一可轮换 daemon credential 的 secret reference |
| `gateway_url` | 显式 Gateway 兼容路径，不是默认远程路径 |
| `gateway_token_ref` | 显式 Gateway Bearer reference；属于高权限、易轮换凭据 |
| `gateway_headers_ref` | Gateway routing headers JSON reference，例如 AnyRun network token |
| `gateway_discovery` | box 内 discovery；默认 `/home/box/sand-data/gateway.json` |
| `daemon_socket` | 本地 daemon socket；默认 XDG runtime 路径，缺失时回退 `~/.grokbox/run/daemon.sock` |
| `ssh_host` | bootstrap/recovery 与显式 SSH discovery 目标；不参与普通业务 RPC fallback |
| `sandbox` | `access_token_ref` 与 keeper policy；只接受显式 Cursor account token reference |
| `quota` | 必须同时声明 `source:"cursor-web"` 与独立 `access_token_ref`；配置存在不等于方法已授权 |

Secret reference v1 只支持 `env:<NAME>`、`file:<absolute-path>` 和 `keychain:<service>/<account>` 三种字符串形状，不提供插件注册机制。Profile 目录必须是 `0700`；`file:` secret 必须是当前 POSIX 用户拥有的 regular file，不能是 symlink，且不得给 group/other 任何权限（通常为 `0600` 或 `0400`）。实现必须在读取时验证这些条件，不只依赖调用者约定；无法验证 POSIX ownership 的平台应改用 `env:` 或 `keychain:`。Profile 本身不接受内联 token。`profile show`、日志、错误和测试 fixture 一律脱敏。

### 5.3 `auto` transport

`auto` 按能力与环境解析，不按进程名猜身份：

```text
1. 可用的本地 daemon socket
2. 可读的本地 Gateway discovery（仅 Gateway 能力）
3. 已配置的 daemon server_url
4. 已配置的 explicit gateway_url
5. capability_unavailable
```

CLI 不从 daemon 静默降级到直接文件写入；不从失败的远程 RPC 静默改走 SSH；破坏性命令不因 transport fallback 改变最终 writer。

### 5.4 外部凭据获取

外部凭据按用途解析，不能把 Cursor 身份、daemon credential 和 Gateway Bearer 当作一种 token：

1. 完整远程路径由 bootstrap 生成一个高熵、可轮换的 daemon credential；外部只保存 `daemon_token_ref`，Gateway Bearer 不离开 box。v1 不建立 per-client principal 或 revocation registry，撤销通过 credential rotation 完成。
2. macOS Grok Bot App session 是内置 Gateway-only 来源：读取 `gateway-descriptor.json`，并使用 Keychain 中 `Grok Bot Safe Storage` 的口令解密临时 Gateway URL、Bearer 和 routing headers。它不授予 Sandbox wake。
3. `sandbox.access_token_ref` 必须显式解析为 Cursor account access token，供 Sandbox lifecycle 方法使用；Cursor dashboard API key 不等价。v1 不逆向 App 私有账号 secret。
4. `quota.access_token_ref` 是 quota-only 方法引用；即使它与 Sandbox ref 指向同一个显式 OAuth fixture，CLI 也不据此推出 wake/keeper authority，且不会从缺失或失败的 quota ref 自动改用 Sandbox ref。
5. 显式 Gateway-only Profile 可以使用 SSH discovery，在连接建立和 401/generation drift 后重新读取远端 discovery；secret 只留在进程内或外部 keychain。这不是普通命令失败后的隐式 SSH fallback。
6. 手工 Gateway credential 是最后维护 fallback，只能通过 no-echo secret 输入落入 `file:`/`keychain:` reference；单独复制 `gateway.json` token 仍可能缺 endpoint、routing headers 和 rotation。

App descriptor 或 secret reference 的 absent、locked/denied、malformed、unsupported、ambiguous、incomplete、stale 与 unauthorized 状态都必须可诊断且不输出 secret。后置的多客户端身份、通用 credential plugin 和 App 私有 Cursor token 发现见 [Roadmap](roadmap/README.md)。

## 6. Capability 路由

每个叶命令声明所需 capability，而不是直接选择 provider。

| Domain | Capability examples | Local Gateway | Direct Gateway | Daemon |
| --- | --- | ---: | ---: | ---: |
| agents/groups | `grok.roster.read/write` | yes | yes | yes |
| send/history | `grok.transcript.read/write` | yes | yes | yes |
| memory/events | `grok.memory.read`, `grok.events.read` | yes | yes | yes |
| files | `host.fs.read/write` | no | no | yes |
| exec/jobs | `host.process.run/manage` | no | no | yes |
| desktop | `host.desktop.read/reap` | no | no | yes |
| daemon health | `host.daemon.inspect` | no | no | yes |

Daemon 的 `/v1/capabilities` 返回协议版本、允许的 capability、Gateway generation 与受控 filesystem roots。CLI 在副作用前校验 capability；缺失时返回 `capability_unavailable`。

Sandbox adapter 独立声明 `sandbox.inspect`、`sandbox.wake`、`sandbox.keepalive`。它运行在 box 外，不由 daemon capability 隐式授予；能经 daemon 执行命令不代表能取得 Cursor account token 或维护 AnyRun lease。`profile capabilities` 对仅配置了 secret reference 的 Sandbox 项返回 `provider-authorization-dependent`，而不是已授权的 boolean `true`。`box status` 成功只验证 inspect；wake 必须由真实 `EnsureSandBox` 成功验证，keepalive 还必须通过 brokered no-op 和外部长时证据。

Quota adapter 同样独立声明 `quota.read`。静态 Profile 只能报告 `provider-authorization-dependent`；真实成功只证明该 OAuth credential 对 quota endpoint 的当前方法级授权，不授予 Gateway、daemon、App storage 或 Sandbox lifecycle 权限。

## 7. Grok Bot 命令

### 7.1 Agents

`agents list/show` 只处理非 Group agent，并保留当前紧凑、脱敏投影。`agents show` 只返回对象详情，不附带 transcript tail；历史搜索与读取分别由 `history search/tail/thread` 拥有。`groups list/show` 只处理 Group，两个领域不提供重复别名或 kind filter。

管理命令支持：

```text
--name
--description / --instructions
--title
--avatar-shape
--avatar-color
--notify on|off
--hidden on|off
```

名称解析规则：精确 ID 优先；否则匹配大小写不敏感的 name/title；零命中为 `target_not_found`，多命中为 `target_ambiguous`。破坏性命令默认要求交互确认；非 TTY 必须显式 `--yes`。

### 7.2 Groups

Group 是 roster 中 `isGroup=true` 的产品对象，不是 CLI 自建文件格式。正常 writer 是 Gateway。成员命令拒绝 nested group、重复成员和超过 Gateway 当前限制的集合；Gateway 拒绝仍是最终事实。

### 7.3 Send

```bash
grokbox send <id-or-name> --text <text> [--expect-kind agent|group] [--nonce <uuid>]
printf '%s' '<text>' | grokbox send <id-or-name>
```

`send` 映射 Human `sendPrompt`，不伪造 peer sender。CLI 先解析 target kind，再发送固定 body。nonce 在重试中保持不变；无法证明投递结果时返回 `send_delivery_unknown` 和可对账 nonce，不回显 prompt。

文本输入规则对 `send` 和 `fs write` 一致：显式 `--text` 存在时永远不读取 stdin，并且在非 TTY/CI/agent runner 中正常工作；只有未提供 `--text` 时才读取非 TTY stdin。两者都缺失时返回 `invalid_usage`；显式参数与可读 stdin 同时存在时，以显式参数为唯一输入。

### 7.4 History, Memory, Events, Running

- `history search` 搜索 transcript 内容，不属于 agent roster 搜索。
- `history tail` 支持 `--limit` 与 `--before-seq`。
- `history thread` 读取指定 root thread，不激活对象。
- `memory list <agent>` 默认只输出 metadata；`--content` 显式读取正文。
- `events` 输出统一 NDJSON，source 只允许 `gateway,job,daemon`，Gateway channel 使用 registry allowlist。
- daemon Profile 使用 `<daemon-generation>:<sequence>` cursor 读取 bounded journal；首次读取 retained window，restart/eviction 先输出 explicit gap 再继续。`--limit` 每页 1-128，long poll 不把断线解释为空区间。
- direct Gateway Profile 只支持 `gateway` source；cursor resume、disconnect、malformed/oversized SSE 均输出 non-resumable gap。
- event payload 由 channel-specific allowlist projector 构造。prompt、transcript/Memory content、filesystem/process data、environment 与 auth material 默认不出现；只有 memory channel 的 `--include-memory-content` 可显式投影 Memory content。
- `is running` 返回 roster projection；false 仍是成功退出。

### 7.5 Quota

`grokbox quota [--json|--table] [--timeout-ms <n>]` 从 selected Profile 明确声明的 `quota.source:"cursor-web"` 读取一次 fresh account-quota fact。adapter 固定调用一个 HTTPS endpoint、拒绝 redirect、把响应限制为 64 KiB，并严格验证 availability、included-limit、percentage、UTC period/reset 与 bounded plan label。输出只含 normalized snapshot、`freshness:"fresh"`、`source:"cursor-web"` 和 `accountBinding:"source-local"`。

首版没有 cache、stale fallback、host/Gateway/daemon route、macOS App bridge 或跨 source fallback；provider/credential 失败不触发 SSH、wake、App launch 或另一 secret reference。盒内进程跑同一命令时，缺失完整 quota 配置仍在 Gateway/daemon/SSH/host/App/Sandbox 副作用之前 fail-closed。长期盒内产品路径仍等待已广告的 host-owned Gateway 方法；在此之前，仅允许 Human 明确批准的临时路径：operator 把 **access token 本身** 一次性写入 box 内 owner-only regular file，并由 `quota.access_token_ref` 显式引用。grokbox 不发现、抓取或刷新该 token，refresh token 永不进入 box；这项临时授权不成为自动 fallback 或默认 onboarding。`hasNonZeroIncludedLimit:false` 是成功事实，此时两个 percentage 都为 null；`remainingPercent` 只由 `100 - usedPercent` 得出。账号、email、JWT subject、token、Machine ID、headers、raw body 与 usage events 均不进入普通输出。

Quota、Sandbox inspect 和 Sandbox wake 是彼此独立的方法级 authority。一个凭据在其中一条路径成功，不得被解释为其他路径已获授权。

## 8. 云电脑文件命令

`fs` 只经 daemon/local host capability 执行，不经 Gateway 假装成通用文件 API。

Daemon 公布命名 root，例如 `workspace`, `home`, `agent-data`。所有路径先 canonicalize，再检查 root、symlink escape 和操作权限。默认不开放 secret、Gateway discovery、系统 pseudo-filesystem 和其他用户目录。

- `read` 有 bytes 上限，并区分 text/binary。
- `write` 使用 pinned parent descriptor 下的同目录临时文件、flush 和 atomic rename；支持 expected hash 防覆盖。daemon 按 canonical target 串行化并在 rename 前复核 descriptor baseline；不受 daemon 管理的外部 writer 仍有一个 Node v1 无法消除的 syscall 级竞态。
- `upload/download` 使用 chunk、size 和 SHA-256 验证；upload chunk 有序，只有完全相同的重复 chunk 才幂等接受。
- mutation 使用 client-generated operation ID 和有界 daemon ledger；lost response 查询 committed/not_committed/conflict/unknown，不盲目重放。
- `remove` 默认移入 root-local、owner-only、调用者不可直接寻址的 recoverable trash；非空目录要求 `--recursive`、独立 `remove-recursive` policy/capability 和确认。CLI 不提供 permanent delete。
- stdout 不承载任意 binary；binary 使用文件目标或结构化 base64 明示模式。

## 9. 云电脑执行与 Jobs

`exec run -- <argv...>` 默认传结构化 argv，不经 shell 展开。argv 第一项是 operator policy 中的 executable alias，不通过 ambient `PATH` 搜索。`--cwd` 必须位于带 `exec` operation 的允许 root；`--env NAME=value` 只能增加 allowlist key，且 child 使用固定最小环境，不继承 daemon secrets。`--run-timeout-ms` 是 process hard deadline；`--timeout-ms` 仍是 RPC/前台等待窗口。输出、运行时间、队列和并发都有 policy 上限。

Shell 默认不可用；只有 daemon 单独配置 shell 且 handshake 同时公布 `host.process.shell` 时，`--shell` 才接受单个 command string。允许 executable 代表 daemon user 级执行权限，不是 cwd sandbox。

前台命令在 deadline 内返回结果。`--detach` 或超过前台窗口的命令返回稳定 `jobId`：

```json
{
  "ok": true,
  "data": {
    "jobId": "...",
    "state": "running"
  }
}
```

Job 状态至少包括 `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`, `unknown`。Job ID 在 spawn 前由 client 分配并持久化；相同 ID 与相同 fingerprint 不重复 spawn，不同 fingerprint 返回 conflict。daemon restart 后不能把遗失进程谎报为 failed；无法证明的 prior-generation nonterminal Job 进入 `unknown`。

`jobs logs` 返回有界 base64 NDJSON records，`--follow` 用 exact offset 长轮询；subscriber disconnect 不取消 Job。stdout/stderr 到达 cap 后继续 drain 并丢弃，避免 child 阻塞。`jobs cancel` 使用独立 operation identity，TERM process group 后有界升级 KILL。每个 Job 的 cancel caller 进入 FIFO，并在 durable persist 或完整 rollback 后才释放；daemon shutdown 等待该 FIFO 收敛。process authority 只在 Linux daemon 上启用：TERM/KILL 前以 `/proc/<pid>/stat` 的 leader start identity 和原始 group member identity 防止 stale PGID reuse。Node 不提供 pidfd-backed group signal，因此最终 identity recheck 到 signal syscall 之间仍有一个 syscall-sized race；无法验证的 group fail closed。Job metadata 不持久化 argv、environment values 或 output content。

## 10. Cursor Sandbox 生命周期

```text
grokbox box status
grokbox box wake
grokbox box keepalive run [--interval-ms <n>]
grokbox box keepalive status
```

`box wake` 执行一次受控 `EnsureSandBox`，并用 bounded brokered exec no-op 验证当前 descriptor；不承诺持续在线。`box keepalive run` 是外部 foreground keeper：周期刷新 Sandbox descriptor，并通过 Cursor/AnyRun brokered exec 执行一个有界 no-op；它不调用 `sendPrompt`，目标模型 token 消耗为零。`box status` 使用独立只读 run-state RPC，不以 Ensure 冒充 inspect。

当前实现将 keeper state 存在 selected Profile 的 owner-only runtime directory，只允许 exact typed projection；单实例 lock 在 provider/credential resolution 前取得。每 tick 最多三次 provider attempt，429 `Retry-After` 与指数退避均有上限；exec descriptor 401 只 remint/replay 同一个 no-op identity 一次。仓库的独立外部 observer 将无凭据 reachability baseline、lease、stop-to-freeze 和 wake-recover 分开，并拒绝小于两小时的 qualification（显式 development override 除外）。Evidence version 3 在 Cursor 报告 freeze candidate 前只做只读 state polling；外部 BatchMode SSH 仅用于候选确认，Tailscale ping 只是辅助。Freeze 必须同时有 Cursor `hibernated/absent` 和严格分类的 SSH network timeout/nonresponse；认证、host-key、DNS、配置或本地 executable 失败均为 inconclusive；wake 还必须通过显式 recover、daemon 与 `doctor.data.ok`。本地或私有环境观察不能证明 App-free wake、keeper lease 或自动 daemon 版本恢复。

Tailscale ping、daemon RPC、本地 process spawn 和 Gateway SSE 都不能冒充 Sandbox lease。keeper 默认带 jitter、单实例锁、有限重试和退避；401、限流、provider outage 与 descriptor 轮换进入稳定状态，不产生请求风暴。初始 10 分钟只是待实验默认，必须由 [Sandbox 控制面](cursor-sandbox-control-plane.md) 的 A/B 验证后才能宣称替代常驻 App。

## 11. Daemon

`daemon serve` 是前台 composition root，拥有：

- local socket/HTTP listener；
- daemon RPC auth 与 capability policy；
- Gateway discovery watcher 和 generation cache；
- filesystem/process adapters；
- job registry、command-specific streams 和 shutdown；
- redacted audit log。

`daemon status` 是 daemon 生命周期的窄读操作；`daemon ensure` 是确保已安装 daemon 正在运行的窄写操作。v1 remote daemon 使用一个高熵、可轮换的共享 credential；本地 socket 依赖文件权限。端到端诊断只由顶层 `doctor` 拥有。

外部 `doctor` 按以下顺序执行只读探测：Profile/config 与 secret/session source、MagicDNS/Tailscale peer reachability、Serve HTTPS/TLS、daemon HTTP、daemon auth/capabilities、box 内 Gateway generation/health。若 Profile 配有 Sandbox access token reference，Tailscale 不可达时它追加只读 control-plane status，但不能仅凭 SSH timeout 宣称已 freeze。没有远端执行通道时，它只能报告 `serve_state_unverified`；只有本地、SSH、Sandbox exec 或已连 daemon 提供证据时，才能区分 `serve_not_configured`、`serve_mapping_drifted`、`daemon_not_running` 与 `daemon_listener_mismatch`。

`doctor` 不安装、启动或唤醒，也不提供 mutating flag。诊断命令完成本身返回 exit 0；目标健康性由 `data.ok` 和各 boundary 的 stable status/code/action 表达，因此 automation 不得只检查进程退出码。独立的 `recover` 是显式组合恢复 use case，顺序固定为：必要时执行 Sandbox wake，等待 Tailscale/IPv4 恢复，恢复 bootstrap 曾创建并记录的精确 private endpoint mapping，再使用 SSH adapter 幂等启动已经安装的 daemon，最后重新检查 Gateway。`recover` 不首次安装 Tailscale、执行 `tailscale up`、创建 Funnel、修改 ACL/tag 或接管其他 mapping。首次 daemon/endpoint 配置或版本缺失必须显式 `daemon ensure --bootstrap --yes`，也可以由 TTY `init` 确认后组合调用；SSH 永远不是普通业务命令的 fallback。

安装、自启动、Tailscale Serve 与 SSH bootstrap 属于部署适配，不改变 daemon RPC。

Daemon 默认只监听 Unix socket或 `127.0.0.1`。远程暴露优先由 Tailscale Serve 将 tailnet HTTPS 转发到 loopback；不得默认监听公网 `0.0.0.0`。

## 12. 输出与错误

除 Markdown 内容和 streaming 命令外，成功 stdout 是一个 JSON object：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "profile": "default",
    "transport": "daemon",
    "operationId": "..."
  }
}
```

`meta` 允许观察实际路径，但调用者不需要据此改变业务逻辑。Gateway metadata 可增加 `{pid,startedAt}`，不得包含 URL/token/header。

失败时 stdout 为空，stderr 是一个脱敏 JSON object。稳定 code 至少覆盖：

```text
invalid_usage
profile_not_found
profile_invalid
capability_unavailable
authentication_failed
credential_unavailable
credential_locked
credential_invalid
discovery_unavailable
transport_unreachable
tailscale_not_ready
daemon_endpoint_unavailable
bootstrap_unavailable
daemon_credential_required
daemon_credential_failed
sandbox_unavailable
sandbox_wake_failed
sandbox_keepalive_degraded
recover_unavailable
recover_failed
runtime_unsupported
quota_unavailable
quota_authorization_failed
quota_protocol_unsupported
quota_provider_unavailable
desktop_unavailable
gateway_*
daemon_unreachable
daemon_unauthorized
serve_state_unverified
serve_not_configured
serve_mapping_drifted
daemon_not_running
daemon_listener_mismatch
target_not_found
target_ambiguous
target_kind_mismatch
send_delivery_unknown
operation_outcome_unknown
fs_path_invalid
fs_forbidden
fs_not_found
fs_not_file
fs_not_directory
fs_too_large
fs_transfer_invalid
fs_hash_mismatch
fs_destination_exists
fs_conflict
fs_not_empty
fs_upload_invalid
path_outside_root
file_conflict
process_forbidden
process_invalid
job_not_found
job_conflict
job_interrupted
```

Timeout 只说明调用窗口结束，不证明远端副作用没有发生。所有写操作需要 operation identity、幂等策略或明确的 unknown outcome。

## 13. 安全边界

- Sandbox 与 quota refs 独立按用途解析；同一个 OAuth 的 quota 成功不授予 `EnsureSandBox`，任一失败也不触发另一引用或 App-private discovery。盒内缺失完整 quota 配置不得刮 host/App 私有存储或新增 credential-sync 命令。
- Quota adapter 固定 HTTPS endpoint、拒绝 redirect、禁止 cache、限制响应为 64 KiB，只返回 fresh sanitized DTO；subject、token、Machine ID、headers、raw body、account identity 与 usage events 不离开 adapter。
- Cursor access token 与 exec/VNC descriptor 只由外部 Sandbox adapter 使用，不传入 box daemon。
- keeper 不调用 agent 或模型；不能用 `sendPrompt` 伪装 keepalive。
- Gateway Bearer 与 routing headers 只留在拥有对应连接面的 adapter，不经 daemon RPC 返回给客户端。
- Tailnet identity 是网络边界，不替代 method/path capability auth。
- 远程 daemon profile 默认权限小于 Gateway 全权 Bearer。
- SSH 不是自动 fallback，避免语义、审计和权限静默变化。
- 不开放 raw Gateway、raw shell、任意绝对路径或凭据读取。
- 直接 Gateway transport 是兼容/诊断路径；它不获得 host filesystem/process 能力。
- 文件离线修复是显式维护模式，不与 Gateway writer 自动互换。

## 14. Bundled Skills

CLI 发布物携带与版本匹配的 `core` skill。根 help 首先给出：

```text
Start here (for Agents):
  grokbox skills get core --full
```

命令 registry、help、capability metadata 和 full skill reference 必须同源，不能维护四套漂移文案。

## 15. 验收与失效条件

完成态至少证明：

1. 无配置的 `default` Profile 在 box 内自动工作。
2. 同一命令经 local daemon、Tailscale daemon 和 direct Gateway 得到兼容输出。
3. Gateway-only Profile 对 `fs/exec` 明确返回 `capability_unavailable`。
4. Gateway restart/token rotation 后 daemon 重新发现且不泄漏旧 token。
5. daemon/Tailscale 断线、重启和 box hibernation 后 job 状态诚实恢复。
6. path traversal、symlink escape、超限传输和未授权 exec 被拒绝。
7. Profile、日志、错误、snapshot 和 audit 不泄漏 Cursor/Gateway/daemon token、Sandbox descriptor、prompt 或 Memory。
8. 外部 keeper 在不产生 agent turn、transcript 或模型 token 的前提下通过 A/B 实验证明 wake、lease、停止后 freeze 和恢复行为。
9. 外部 doctor 能区分 Sandbox、Tailscale、daemon、auth 与内部 Gateway 故障且始终无副作用；显式 `recover` 按 wake → Tailscale → daemon ensure → Gateway 顺序恢复。
10. npm pack/install、box daemon 启动和内外真实链路有独立可运行证据。
11. parser、help、registry、bundled skill 与文档只暴露一套命令面；被替换的路由没有兼容别名，且每个 leaf 只接受 registry 声明的 options。
12. `send --text` 与 `fs write --text` 在无 TTY 环境不读取 stdin；位置 target 的 missing、ambiguous 与 kind mismatch 均有稳定测试。
13. TTY bootstrap 与 headless `--bootstrap --yes` 只创建一次 bounded Serve spike 已证明可隔离、可回滚的 private mapping；`recover` 仅恢复 bootstrap 记录的精确 mapping，并保留所有其他配置。
14. macOS App descriptor/Keychain、Cursor access token、shared daemon credential bootstrap、免登 SSH discovery 和 manual no-echo fallback 均有无泄漏成功/失败测试。
15. 外部真实证明由独立 runner 执行 packed client；freeze/wake observer 在 box 不可调度时仍持续运行并把脱敏 evidence 保存在 box 外。
16. `quota` 以显式独立 Profile ref 在外部 Node runner 通过真实 provider；repository evidence 只保留方法/schema/DTO 断言，且 malformed/expired/401/5xx/oversize/timeout 均有 fail-closed 测试。

下列变化会使本文需要重审：Gateway 方法或 token scope 改变；Cursor `EnsureSandBox`/exec/VNC descriptor 或 AnyRun lease policy 改变；box lifecycle/Tailscale identity 不再持久；filesystem/process trust policy 改变；Profile 配置格式或 daemon RPC 出现不兼容版本。
