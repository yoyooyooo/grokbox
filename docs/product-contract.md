# `grokbox` CLI 产品合同

本文是 `grokbox` 命令、Profile、输出和能力边界的 Current Home。它描述已经接受的**未来完成态**，不是当前源码能力清单。当前实现已覆盖 agent-first CLI、Profile/init、local/remote daemon、agent/group management、governed filesystem、structured exec/durable Jobs、generation-aware unified events/recovery、显式 OAuth quota adapter、Cursor Sandbox lifecycle adapter、实验性 desktop 管理，以及 layered doctor/explicit recovery；最终外部 evidence matrix 仍由后续本地 Ticket 跟踪。交付进度必须由本地 Issue tracker 与源码/测试证明，不能只从本文的未来完成态推断。

实现边界见 [CLI 架构](architecture.md)。当前 quota source、DTO、错误和真实证据见 [Quota Current Home](quota.md)。Cursor Sandbox、`EnsureSandBox`、freeze 与外部 keeper 背景见 [Sandbox 控制面](cursor-sandbox-control-plane.md)。当前 Gateway 与 box 信任事实见 [上游集成](upstream-integration.md)。非官方身份、商标和上游私有接口的稳定性等级见 [兼容性边界](compatibility.md)。Box-local 模型运行时义务见 §12；设计见 [Box-local model runtime](box-runtime.md)。

## 1. 产品定位

`grokbox` 是 Grok Bot 云电脑的统一控制面 CLI。同一条命令可以在云电脑内外执行，调用者只选择 Profile，不需要知道背后使用 Unix socket、loopback Gateway、Tailscale daemon RPC 还是直接 Gateway。`gbox` 是完全等价的短别名；帮助、输出、配置与行为均以 canonical name `grokbox` 表述。

发布的 CLI 与 daemon 运行时合同是 Node.js 20.17.0+，与固定的原生 monitor SQLite 依赖最低版本一致；这是显式的发行兼容变更，不是执行次数或业务配额。不得依赖 `Bun.*` globals 或要求最终用户安装 Bun。两个 executable name 共用一个 pre-bundle Node shim；Node 版本低于 20.17.0 或不可解析时，在加载 bundle 前返回稳定 `runtime_unsupported`/59。仓库仍使用 Bun 执行依赖安装、`bun run`、测试和其他开发流程；开发工具选择不进入用户运行时合同。

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

CLI 统一这些能力：

1. Grok Bot 产品能力：agent、group、消息、transcript、Memory 和 events。
2. 云电脑能力：受控文件读写、命令执行、长任务和 artifact 传输。
3. Sandbox 生命周期能力：从外部唤醒、维持 lease 和观察 Cursor/AnyRun 状态。
4. 账号额度能力：由显式 credential-owning source 返回 fresh sanitized quota，不从 transcript 推算。
5. 连接与运行能力：Profile、doctor、daemon 和版本匹配的 bundled skills。
6. Box-local 模型运行时：仅在目标 Box 本机替换 ordinary main 的模型执行；不经 Profile/daemon/SSH 转发。

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

## 3. 完整命令树（对外目标面）

本节是 **收口后的使用侧命令面**。电源是顶级 `on` / `off` / `upgrade`；Host 通道是独立的 `host start` / `host stop` / `host restart`；状态进 `doctor`。`runtime *` / `daemon *` 实现可暂留，不写进 Skill/README。停服务不用 `--confirm`。切换 Host 用 `host start` / `host stop` / `host restart`（运行中 Bot 须 `--force`；`start`/`stop` 已到位则 no-op）。

```text
grokbox (alias: gbox)
│
│  连接
├── init [<name>] [--local | --peer] [--bootstrap] [--admit-home-read] [--yes]
├── skills list | get grokbox [--full] | get core [--full]   # 与当前 CLI 同版本；不要拷进 Bot
├── profile list|show|use|add|update|remove|capabilities
│
│  这台电脑上的 grokbox（电源）
├── doctor                          # 含通道 official|custom|unknown+reason、服务是否在跑、next
├── on                              # 开服务：daemon、title 定时、闲时息屏（座位表对齐，不改表）；不改 Host
├── off                             # 停本命令拉起的服务和闲时息屏；不改 Host
├── host start [--force]            # ensure grokbox 补丁 Host（自定义模型通道）；已是 custom 则 already_started。运行中 Bot 须 --force
├── host stop [--force]             # ensure 官方 Host；已是 official 则 already_stopped。运行中 Bot 须 --force
├── host restart [--force]          # 先 stop 再 start，总是打算 Host kill。运行中 Bot 须 --force
├── upgrade --yes                   # grokbox 更新后对齐这台电脑（通道 + 闲时息屏）
│
│  换脑（按 Bot；须 confirmed_box）
├── models list
├── models use <provider/model> --for <agent>
├── models reset --for <agent>
│
│  Bot / 群 / 消息
├── agents list [--ownership]
├── agents show <agent> [--ownership]
├── agents ownership <agents...>
├── agents title show <agents...> | --all
├── agents title hide [agents...] | --all     # 无名字 = 清场
├── agents title sync [agents...]             # 只刷新已 show 的 trailer
├── agents create --name <name> [...]
├── agents update <agent> [...]               # --title 只改用户段；show 时与 trailer 共存
├── agents delete <agent> [--yes]          # 删花名册；若座位 ≥2，盒子上 stop-window 并从座位表摘掉该 agent（主屏不误伤）
├── groups list|show|create|update|delete
├── groups members list|add|remove|set
├── send <target>
├── history search|tail|thread|outcome
├── memory list <agent>
├── alerts list
├── export agent <agent> --out <dir>       # 盒内文件快照；与 template pack 共用读盘/打码
├── template pack <agent> --out <file>     # 只组官方 recipe JSON，不上传
├── template stage <agent> --visibility team|public [--from <file>] --yes
├── template publish <shareId> --rev <n> --yes
├── template show <shareId> --rev <n>
├── template visibility <shareId> --visibility team|public --yes
├── template delete <shareId> --yes
├── template import <shareId> --name <name> --rev <n> --yes
├── events
├── is running <target>
│
│  云电脑文件 / 进程
├── fs stat|list|read|write|mkdir|upload|download|remove
├── exec run -- <argv...>
├── jobs list|show|logs|cancel
│
│  桌面（查座位 + 保登录态；闲时息屏走 on/off，不在本族开关）
├── desktop status                    # 座位表：谁坐 :N、亮/闲、是否 keep
├── desktop keep add <agent>
├── desktop keep remove <agent> --yes
│
│  Cursor Sandbox（与 Host 自定义模型通道无关）
├── box status|wake
├── box keepalive run|status
│
│  额度
└── quota
```

不进入本树（实现可暂留，不写进 Skill 正文）：`daemon *`、`runtime *`（含 re-adopt / watchdog / modeld / monitor / profile 切片工具）、`desktop prune *`（闲时息屏由 `on`/`off`/`upgrade` 开关）。`skills get grokbox` 是 Agent 入口；`skills get core --full` 给人看整棵 CLI。

Title trailer：`[<用户字>][ | owner=box|temporal|conflict[,m=<alias-or-model>]]`。无参数 `title show` 非法；`hide` 无参数清场；`sync` 不把 hide 变成 show。`models use --for` 会给该 Bot 刷 trailer 并保留用户标题；`reset --for` 只刷新已在 show 的 trailer 并去掉 `m=`。

**Export 与模板：** 共用对某个 Bot 的只读材料（profile、约定 Memory、automations、可打包的 skill 散文）和 secret 打码。`export agent` 写成盒内目录；`template pack` 写成官方 recipe JSON。`stage` = aiserver `CreateGrokBotTemplate` + PUT blob（不是 Gateway）；`publish` / `import` / `visibility` / `delete` 走 Gateway。`listBotTemplates` 是空 stub，不做 `template list`。Skill 散文进 recipe，不把 grokbox CLI 捆绑 skill 拷进模板。

**Target 解析（所有 `<agent>` / `<group>` / `<target>` / `--for`）：** 先精确 ID（大小写不敏感），再唯一 name；name 零命中时才看 title。多名 → `target_ambiguous` 并列出候选 ID+name，提示改用 ID。零命中 → `target_not_found`，说明没匹配到 Bot 还是群，并指出 `agents list` / `groups list`（可加 `--include-hidden`）。找到了但 kind 不对 → `target_kind_mismatch`，指向对应命令族。`--for` 与位置参数同一套解析；内部 ownership/选模只用解析后的 UUID。

顶层不提供 `raw` 或任意 `/api/<method>` fallback。新增能力必须先获得命令语义、权限、输出和恢复合同。

## 4. 全局选项

```text
--profile <name>       选择执行 Profile；`runtime *` 拒绝此选项并返回 `runtime_local_only`
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

Daemon 的 `/v1/capabilities` 返回协议版本、允许的 capability、Gateway generation 与受控 filesystem roots。CLI 在副作用前校验 capability；缺失时返回 `capability_unavailable`。`auto` 与本地 `daemon` Profile 的 `profile capabilities` 对 `host.desktop.read/reap` 以本地 daemon handshake 为准：socket 可达且 advertised 则为 true；不可达时回退静态投影（未配置 `server_url` 的 `auto` 为 false）。远程 daemon Profile 仍按静态 transport 投影，不在 capabilities 命令里拨号。本地 daemon 不可达时，desktop 等 `host.*` 命令返回 `daemon_unreachable`，`next` 为 `grokbox on`。

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

Roster只读投影保留`harness: box|temporal|unknown`；字段缺失不假报box，也不从serverId推断。它是Gateway声明，不证明桌面实际选源。**2026-09-12目标合同：普通`agents update`不得发送/回填harness，显式修改既有归属写前拒绝；Create可请求类型，但Server确认/回读才构成资格，未知不重新create或强写本地。** 当前隐式写入仍待[T38](tickets/T38-identity-write-alignment.md)收口，文档更新不是已实现声明。

App Label (`title`) is display-only. User text is optional; grokbox may append ` | owner=box|temporal|conflict[,m=<alias-or-model>]`. Trailer presence is the show switch. `agents title show` (named Bots or `--all`) paints from live ownership and `models.json`; `hide` strips the trailer; `sync` refreshes trailers already showing. Create does not paint. `models use --for` paints that Bot's trailer and keeps the user title; `models reset --for` only refreshes an already-showing trailer and omits `m=`. Title write failure does not undo model assignment. `agents update --title` replaces the user segment and, when showing, refreshes the trailer. Unconfirmed Bots are skipped on show/sync. The daemon interval only syncs showing Bots. CLI/daemon `title sync` and Host profile writes refresh a showing trailer from local harness and models.json, and leave hidden titles unchanged. A missing models snapshot, unresolved assigned token, or non-UUID Host agentId preserves existing `m=`; only a confirmed empty assignment clears it. The same preserve/clear rule applies to `agents update --title` on a showing Bot.

`agents ownership <targets...>` is a read-only Host-backed inspection of official Server registrations, not a harness setter. It accepts 1–32 named/public-UUID targets, makes one native Server List call, and compares finite Server identity/harness fields with local before/after observations. Server credentials stay inside the Host; the explicit getHostStatus extension does not run on ordinary status calls. Unknown bridge/auth/identity, duplicates, unstable local evidence or Gateway changes must not produce a confirmed result. Classes are confirmed_box / confirmed_temporal / conflict / unconfirmed; App route and migration observations are separate facets. When the Host channel is official, the projection adds blocker `host_channel_not_enabled` and `next` is `grokbox host start` (aligned with `doctor.next`), not identity-lost wording. When live Host SHA does not match the reviewed profile, the projection adds blocker `host_source_mismatch` and `next` is a copy-paste `grokbox runtime profile observe --from /home/box/sand-host/host-main.cjs then grokbox runtime profile write --sha` plus the full 64-hex live digest (never a placeholder). If the live digest is not yet known, `next` is observe-only. confirmed_box is not production approval, ownership inspection never reconciles/migrates/repairs, and the command does not yet automatically guard send/models-use. Implemented across direct Gateway and daemon transports; [harness current home](maintainers/transcript-harness-box-vs-server.md#read-only-ownership-inspection-contract) owns details.

### 7.2 Groups

Group 是 roster 中 `isGroup=true` 的产品对象，不是 CLI 自建文件格式。正常 writer 是 Gateway。成员命令拒绝 nested group、重复成员和超过 Gateway 当前限制的集合；Gateway 拒绝仍是最终事实。

### 7.3 Send

```bash
grokbox send <id-or-name> --text <text> [--expect-kind agent|group] [--nonce <uuid>]
printf '%s' '<text>' | grokbox send <id-or-name>
```

`send` 映射 Human `sendPrompt`，不伪造 peer sender。CLI 先解析 target kind，再发送固定 body。nonce 在重试中保持不变；无法证明投递结果时返回 `send_delivery_unknown` 和可对账 nonce，不回显 prompt。

文本输入规则对 `send` 和 `fs write` 一致：显式 `--text` 存在时永远不读取 stdin，并且在非 TTY/CI/agent runner 中正常工作；只有未提供 `--text` 时才读取非 TTY stdin。两者都缺失时返回 `invalid_usage`；显式参数与可读 stdin 同时存在时，以显式参数为唯一输入。

回执 `accepted:true` / `status:accepted` **只表示 Gateway 已入队**，不是回复成功。回执必带 `clientNonce`（Agent 主句柄）。send 没有 `--wait`。观测同一发送只用：

```bash
grokbox history outcome <id-or-name> --nonce <clientNonce> --runtime [--wait-ms 60000] --json
```

这是金丝雀唯一路径。`--request-id` 是同一 SendAttempt 的次查找，不是第二主键。没有 `alerts list --nonce`，也不新增 `correlationId`。

### 7.4 History, Memory, Export, Events, Running

`history outcome` 是只读投影，不是第二套生命周期。支持 `--step-id <id> --runtime` 直接查询截图中的模型 STEP，与 `--nonce`、`--request-id` 三选一；不把 STEP 冒充首个 display request ID。`assessment` 分开记录交付、主运行、辅助推理与证据质量。显式 runtime 读取有缺口且无已知失败时，保留真实 delivery 但顶层为 unknown；明确关联失败仍为 failed，不因其余日志有 gap 被抹掉。实际读取根/字节窗口、retention 缺口及 writer 健康快照必须可见。`data.state` 只准：`unknown`、`recorded`（仅 echo 或 journal bind，等待中）、`failed`（durable 拒绝 / 相关 terminal / 相关 live tray）、`progress`、`delivered`、`expected_result_observed`。**outcome 无 `accepted` 成功词**；旧 `acceptedObserved` 已改为 `echoObserved`。send 回执仍可带 Gateway 的 `accepted:true`（入队）。`--runtime` 以本机 journal 为失败权威；空 trays 不得把 `failed` 改回 `recorded`。`requestId` 在早期 admit 失败时可为 null。`--wait-ms` 只把 `failed|delivered|expected_result_observed` 当 settled；`recorded` 继续等。`executionCompleted` 保持 `not_proven`。`--expect-harness box|temporal` 在每次采样前后核对声明来源；本机 `--runtime` 隐含 box 要求。跨 harness、缺声明或不符时不得用另一账本的相同 entry/预期正文判成功，保持 unknown。前后采样不是原子快照，也不读取 App 的本地缓存；详见 [结果观测](maintainers/run-outcome-observation.md)。

- `history search` 搜索 transcript 内容，不属于 agent roster 搜索。
- `history tail` 支持 `--limit` 与 `--before-seq`。
- `history thread` 读取指定 root thread，不激活对象。
- `memory list <agent>` 默认只输出 metadata；`--content` 显式读取正文。
- `export agent <id-or-name> --out <dir>` 是盒内离线只读导出：不走 Gateway、不解析 Profile、不写产品 SQLite/Memory。默认只打包 **owned**：roster 投影（id/name/kind）、profile/settings（无 secret）、Agent Memory 文件、若存在的 user-memory shard 与 project-memory shards、automations JSON。stdout 是 JSON envelope 中的 manifest 摘要；完整分类写入 `--out/manifest.json`。
- skill / workflow / plugin **没有** per-bot 结构化归属。`settings.json` 样本只有 `notifyOnAgentUpdates` / `hiddenFromSidebar`；`grokbox skills` 是 CLI 捆绑 skill，不是 Bot 账本；MCP/plugin 属于 Gateway catalog；`agent-data/workflows/` 是全局投影。manifest 必须写 `association: none`，仅把 automation 正文里扫到的 workflow 名标为 `related` 引用（引用不是所有权）。不要默认打包全局 workflows、`~/.agents/skills` 或 MCP 账号。`--include-related-workflows` 只追加被引用且存在的 workflow `SKILL.md`。transcript `store.db` / `conversation-blobs.db` 默认省略。
- Memory 只使用三层：`agent` / `user` / `project`。目标存在且非空、路径逃逸、secret 路径（含 `gateway.json` 与 token/Cookie/key 文件）fail-closed。默认根是 `/home/box/agent-data`；canonical 名是 `sand-data` 时仍允许导出 owned allowlist。`--agent-data` 只覆盖本地根。测试必须用夹具，不得把真实 sand-data 当测试源。
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

## 12. Box-local model runtime

**2026-09-13观测扩展（本地CLI/SQLite子集已实现，T41未完整关闭）：** 持续观测在Web UI之前交付；共享采集、单盒SQLite变化/incident、有界通知与管理操作由[Spec S0.1.4](roadmap/box-runtime-impl-spec.md#continuous-observation)约束。Box与Bot分别标识，Server登记仍决定执行归属，SQL投影不能授权执行、改模型配置或替代Host历史。lastKnown与stale/unavailable分开，查询失败不伪造归属迁移；ack/snooze不等于问题恢复、不改变执行准入。

SQLite中的current projection/日志索引可按仍存在的来源重建，observed history及用户确认/通知回执是本域持久事实，不能一概清除为cache。通知默认不外发，渠道需显式配置与授权，重试只发通知；普通GET不启动采集/建库/迁移/repair。已有Host `alerts list` tray与新monitor incident分别表达。页面关闭后monitor仍运行，整机离线的主动监测需要future外部observer，不能承诺本机自报死亡。

当前本地入口为`runtime monitor init --confirm`、`run --agents <uuid,...> --confirm [--once]`、纯读`snapshot/events/incidents`及带requestId/expectedRevision的`ack/snooze`。只在显式init/run/管理中写观察域，GET不建立数据库、不打Server。前台run输出提交后的稳定ID变化；目前是local-only，没有外部通知投递/自启/硬崩溃锁回收的完成承诺。存储有限、错误与分页合同见[持续观测维护页](maintainers/continuous-observation.md)。

Web UI是未来grokbox自己的控制台，不修改官方Grok Bot.app；按[future页面合同](roadmap/future/webui-console.md)展示Box/Bot、supported/desired/effective、历史/告警与操作回执，修改仍走共用commands/ConfigurationWrite。前端暂缓不推迟T37安全门或T41最低观测闭环；未来多盒/高级通知按各自晋升门实施。

本节是已接受义务，不是当前源码已实现清单。**2026-09-12：以Server登记为执行归属权威，只改Host、不改App；在同一确认Box的原生会话内可逆切官方/A/B模型。** [Spec S0](roadmap/box-runtime-impl-spec.md#stable-delivery)定义V01–V30；新增T37–T40分别拥有归属准入、身份writer/test2、完整往返、持久发布，T24/T26/T32/T35/T36继续本域实现。不会修改Server harness来实现模型切换，也不另建ME路线。更多 provider、全 WebUI、完整 Harness 不作先决条件；工具、多 TURN、实际会经过的 Memory/episode 与 checkpoint/reload 不得为验收静默停掉。

`grokbox runtime *` 是 **Agent-first、盒内机器接口**，不是给人点的日常 UI。用户日用入口是**真实 Grok Bot**；未来盒内 WebUI/VNC 仅为配置/运维入口，必须调用同一套 use case，不能另写一套 mutation。不接受 `--profile`，不经 daemon、SSH 或 generic exec 转发；盒外返回 `runtime_local_only`。同 UID 能执行代码的主体仍可能改文件，不得宣称硬隔离。

Agent 只设 **desired** 和读观察：`activate` / `deactivate` / `models *` 写意图；`status` / `log` / `contracts` 只读，不得偷偷 repair。离线审 profile：`runtime profile write --sha <retainedSourceSha>`（从 retain 目录取字节；`--from` 仅配合 `--allow-unretained --confirm`，receipt `unretained_source=true`。逃生只豁免谱系绑定，不豁免 envelope 拒漂。基线是当前 `reviewed.json` sourceSha256 代的 golden；无 previous reviewed 时首针放行，有 pin 无 golden 则拒绝并要求对该代 re-observe。拒漂谓词为 windowSha/count/find.inWindow，名单须与漂移 slice id 精确相等。校验已批准切片及 source/transformed SHA，以私有临时 profile 文件原子发布长效 `profiles/reviewed.json`；author 路径不回写 retain、不 inject / 不 TERM / 不 re-adopt）。`runtime profile analyze --sha` 在无 Agent runner 时仍可 `settled: missing_runner`，但必须给出 write-gate 拒绝 slice id 与可执行的 `write --sha`（需要时带 `--slice-review`）next，不得交空 artifact。失败可留下未发布的 protected staging，reader 只读 canonical artifact；并发成功写入以最后一次原子 rename 为准，生成不等于人工审核或 live 授权。自愈（切片快照、作废 attestation、未知 SHA 不注入、注入普查、`stale-patched` 一次 TERM 旧 attested PID）只在 watchdog 内。禁止 Agent 命令：`inject` / `heal` / `kill`。**No live unless authorized**：`runtime re-adopt --confirm` 是唯一带 live Host adopt 权限的公开 CLI composition root：缺 `--confirm` 或非本机在构造 live ports 前拒绝；匹配的 canonical 身份、`attestation.diskSha === liveDiskSha()` 且 reviewed profile 一致时是零信号 no-op；所有权仍精确但 SHA 过期（`reason=stale_attestation`）才允许一次手动 deactivate→official→transient-adopt；已经是 route 且所有权与 `diskSha` 仍匹配、只是 reviewed profile SHA 变了时，确认后可再 refresh 一次。缺 `--confirm` 的 watchdog 对后者保持零信号 `route_mismatch`。一次调用最多一次 attempt。它不是 `activate` 的隐藏路径；本 slice 的 `watchdog run` 不接 live mutation ports，不能自动改 Host。`watchdog run` / `modeld run` 是进程入口，进 registry 与打包测试。`runtime start`的稳定目标是复用T25/T28唯一程序确保所选配置、持久凭据及服务生命周期，重复启动不重复实例；该产品闭环由[T40](tickets/T40-persistent-release-and-rollback.md)关闭。旧“启动stub＋一次tick”是POC历史。当前入口复用production root和Effect Scope：route配置先验、匹配根后借用或新建、保存desired、未确认reconcile及status；新建时打印ready回执后继续前台至signal，borrowed直接返回。`configRevision`不是运行生效证明，准备命令不安装自启、不批准生产；异常退出不会伪造配置回滚。源码接线、实际CLI/制品资格与持久部署分别由T40报告，不把局部单测当可生产。默认不借查询隐式re-adopt/canary，不把watchdog另并入daemon执行一套控制。本 slice 的 route 承认 `stub/echo` 或 openai*（http(s) endpoint + `apiKeyRef`）：`activate --mode route` 与 desired=route 下的 `models use` 对其它 provider 赋值 fail-closed。seam 不再在 modeld 前因非 stub modelId 拒绝；modeld composite 再 admit。默认 assignment 仍是 stub。

Unix modeld 复用唯一 `runtime-kernel` admission / RouteBinding / STEP ledger / Effect 程序，经当前 v5 transport 执行一个逻辑 STEP 的 `ModelBackend` Stream。AI SDK Chat/Responses 在 box-runtime adapter；Host leaf 与 CLI 保持 SDK-free，Host 拥有工具循环，不默认启用 provider agentic tools。旧 A+S1 `complete()/StreamPart[]` 是 POC 历史，不是当前兼容义务或实现架构。错误 generation/authority/selection/auth 在相应 effect 前拒绝；重复 STEP 不重新 dispatch，不确定执行不跨断线/重启盲目续传。health只证明服务响应；真实runtime status再通过service-info确认当前数据根，报告scope/serviceEpoch，错根或缺失身份不能显示安装ready。这仍不是Host已加载、Bot有执行权或用户已收到结果的证明。`stub/echo` 是显式无网络 backend，不是静默 fallback；实际资源上限见 canonical contract，而非旧阶段常数。

**v5 失败与受控恢复合同（2026-09-16）**：Host/modeld 成套升级；v4 仅允许显式替换工具使用有限只读 service-info/execution-status 核验，不能授权 v5 的模型执行。错误终态和初始拒绝都可携带 kernel 的安全 `FailureSummary`，绑定 Agent/TURN/STEP/Host generation/service epoch；未知或损坏的摘要只降低诊断精度，不把已知失败升级为成功或变成新的流结构错误。HTTP、认证、限流、额度、资格、资源预算与流完整性分别呈现；用户看到的提示不依赖实时反查日志。旧日志继续读取且不回填未采集事实。

默认每 STEP 不自动重试。显式 `GROKBOX_MODELD_PROVIDER_RECOVERY=pre-output-http` 启用 kernel 内的模型请求恢复，接受重复上游推理/费用的可能性：仅在未发布任何非空文本、思考或工具材料时，针对明确 HTTP 429（非额度错误）/502/503/504，在本 STEP 的时间和额外请求预算内等待并再次请求。每次 attempt 独立持久声明，使用同一 snapshot 和 binding，并再次检查 ownership、取消、原凭据指纹及模型选择；检查之后再次核对剩余恢复时间。最终成功只放行一次，持久结算失败不释放成功终态。未知网络结果、流不完整、工具参数错误、已输出的请求不自动恢复；不重发 sendPrompt、不重放整个 TURN 或工具、不切备用模型、不跨重启复活旧请求。进度事件只报告状态，不授予执行权。模型 backend 自身仍是单次调用，monitor 不拥有恢复器。详见[恢复与错误呈现](maintainers/run-outcome-observation.md#v5-失败摘要与受控模型恢复)。

长效根为 `/workspace/.grokbox/box-runtime/`（配置、PatchProfile、合同切片、事件日志；云电脑重置不丢）。不得占用 CLI 安装目录 `~/.grokbox/runtime/`。现有 grokbox Profile 仍在 `~/.grokbox`，本次不搬家。`models.json` 持久化的凭据字段（`credentials` 与本地 `apiKeyRef`）只接受 `env:<NAME>` 与 `file:/absolute/path`；`file:` 放长效树 `secrets/`；literal secret 与 `$VAR` 为 schema error。`externalCatalog` 含 `pi` 时，内存中的适配记录可使用 `pi-provider:<name>` 指向 Pi `models.json` 里该 provider 的 string `apiKey`，不得把该密钥明文写入 grokbox `models.json`，也不得执行 command-form `!/` 键。短效 live state 固定 `~/.grokbox/run/`（含 `attestation.json` 与 `modeld.sock`），不读 `XDG_RUNTIME_DIR`。daemon socket 仍按 §5.2：默认 XDG runtime 路径，缺失时回退 `~/.grokbox/run/daemon.sock`。

`assignments.agents.<id>` 是 route 下唯一的 managed opt-in（稳定 agent id；CLI `--for` 写入该覆盖）。**没有覆盖的 Bot 回官方 Host session。** `assignments.main` 可选，不是未覆盖 Bot 的回退。`activate --mode route` 允许 agents-only（`main` 可为 null）；已出现的赋值须为 `stub/echo` 或 openai*（http(s) endpoint + 非空 `apiKeyRef`，含 `env:` / `file:` / 适配得到的 `pi-provider:`）；其它赋值 fail-closed。`models use` / `activate --mode route` 必须披露：provider/endpoint、数据类型、下个 turn 生效、改的是默认还是某一 Bot。省略 `--for` 的 `use` 写 `main`，不把其它 Bot 拉进 modeld。**目标：route期间`models reset --for <bot>`必须支持仅该Bot下一TURN回原生official，不全局deactivate、不改harness。** 当前源码仍拒绝route reset，是[T24](tickets/T24-runtime-route-binding.md)的待修差额，不继续作为长期限制。合法未opt-in和用户明确official，与损坏/不可读配置导致decline严格区分；配置saved与当前TURN captured分开投影。

**R2 选择承诺覆盖旧 T11 隐式预 dispatch fallback。** 已选择 managed 的 Bot 若桥/资格/准入不可用，应明确 unavailable，不偷偷切官方主模型；尚未配置的 Bot 才是正常 official passthrough。当前实现中旧预 dispatch fallback 的剩余差额归 T24/Spec S0，不因更新文档就视作修好。managed 错误保持身份/阶段关联，不能转换为模型正文或写入有效 Memory。test0为每窗口重新确权的正例候选；**test2已证Server temporal/local box，仅用于冲突诊断/阻断，不能再作heavy/managed正例**；test1保持未opt-in官方对照。实际live仍须符合当次候选与授权边界，test2安全校准另行确认且不合并历史。

长效 `contracts/` 保存 Host **合同切片**快照（不进 git）：仅在 live source SHA 变化时写入，最多保留 5 个 SHA，默认不存整份 `host-main.cjs`。快照用于报告切片 drift，不自动打补丁、不还原官方 Host。

MVP / 可发布声明的 ordinary main envelope：

- 支持 text/system/history、tool schema、serial tool call、true streaming、abort；
- image/attachment：所选模型声明视觉能力则必须送达；未配置视觉能力则在 provider effect 前失败，并尽量以 Bot 可见消息告警（Host 执行 `SendToUser` 或等价），不得静默；
- parallel/interleaved：默认可请求 `parallel_tool_calls=false` 减少生成并行，但该生成偏好不是 Host 的批次大小上限。production managed seam 使用 `validated-batch`：整步工具 ID、声明名、完整参数及成功终态全部通过后，按首次出现顺序将完整调用批次交给原生 Host；不得仅因多于一个调用报错、丢弃后续调用、拆成多个模型 STEP 或自动重试。任何批次内结构错误或提交前取消保持零工具材料释放。权限/审批、实际并发、执行失败、结果和 checkpoint 仍归 Host；批次放行不等于副作用原子事务或已执行；
- mixed user content：文本/图片与工具结果按原始顺序分段投影，不能按类型全局重排；目标协议无法安全表示时可见拒绝。
- 失败观测：`invalid_stream` 可带固定拒绝位置与有界事件摘要；本地 IPC 失败使用 `transport_error/transport`，与 provider HTTP 失败区别。日志、读取、保留、诊断均无执行/重试权限，不抓取正文或暗中回填旧证据。
- 未补丁/不可用窗口：在已声明父预算内等待或明确拒绝；不把该 managed 用户句改送另一个主模型，不重放未知副作用。官方 Bot 独立保持原行为。

证明按 source / 实际 packed / 原生隔离资格 / live 合成触发 / 真实 provider 分层。旧 response-only S4 描述不再是当前源码事实；当前实现与未证项由原 verifier/Ticket 给出。错误作为错误交给 Host，不产生假 assistant 正文、空成功或假 tool call；工具、Transcript/Memory 的写入仍归 Host。

`runtime status` 使用同一 status projector 的 installation/circuit 与 bridge、modeld、controller、mutation、recovery、hostDelivery facets；缺来源/错代/陈旧记录保持 unknown/gap，不用历史成功冒充当前 delivery。disabled 但仍 patched 不能显示 rollback-done，desired 写入不等于已卸载。只读命令不 repair/清 circuit/发模型请求；字段与上限由 canonical contract/source tests 验证。稳定版本还须固定 source/packed/Host profile 与运行代、支持模型/Bot、正常持久启用/停用及安全退路；临时 env canary 演示不是可持续配置，故障注入始终不作为正常功能。

**发布合同分层**：T37必须保护实际Host的新managed准入，不仅CLI预检；T38先保全/门禁再退错误writer；T39证明同Bot官方→A→B→官方→A和custom checkpoint的原生回程；T36证明当前会话Working与真实执行一致；T40证明持久服务及完整未补丁退出。读取副本可以先到/落后，但不能改变prompt事实或执行归属；Server迁移发生时不得继续假称本地接管。Prompt cache未命中影响性能，不应改变上下文正确性。最终批准使用readiness现有记录，不由某个绿色测试或ownership结果直接生成。

## 13. 输出与错误

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
runtime_local_only
runtime_ownership_unavailable
runtime_ownership_unconfirmed
runtime_ownership_temporal
runtime_ownership_conflict
host_switch_blocked
host_mismatch
host_source_mismatch
runtime_config_invalid
runtime_window_open
model_capability_mismatch
model_invocation_unknown
quota_unavailable
quota_authorization_failed
quota_protocol_unsupported
quota_provider_unavailable
desktop_unavailable
export_path_invalid
export_forbidden
export_destination_exists
export_source_unavailable
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

## 14. 安全边界

- Sandbox 与 quota refs 独立按用途解析；同一个 OAuth 的 quota 成功不授予 `EnsureSandBox`，任一失败也不触发另一引用或 App-private discovery。盒内缺失完整 quota 配置不得刮 host/App 私有存储或新增 credential-sync 命令。
- Quota adapter 固定 HTTPS endpoint、拒绝 redirect、禁止 cache、限制响应为 64 KiB，只返回 fresh sanitized DTO；subject、token、Machine ID、headers、raw body、account identity 与 usage events 不离开 adapter。
- Cursor access token 与 exec/VNC descriptor 只由外部 Sandbox adapter 使用，不传入 box daemon。
- keeper 不调用 agent 或模型；不能用 `sendPrompt` 伪装 keepalive。
- Gateway Bearer 与 routing headers 只留在拥有对应连接面的 adapter，不经 daemon RPC 返回给客户端。
- Tailnet identity 是网络边界，不替代 method/path capability auth。
- 远程 daemon profile 默认权限小于 Gateway 全权 Bearer。
- SSH 不是自动 fallback，避免语义、审计和权限静默变化。
- 不开放 raw Gateway、raw shell、任意绝对路径或凭据读取。
- `export agent` 不得把 `gateway.json`、token、Cookie、provider key 或 transcript 整库写入导出包；失败路径 fail-closed。
- 直接 Gateway transport 是兼容/诊断路径；它不获得 host filesystem/process 能力。
- 文件离线修复是显式维护模式，不与 Gateway writer 自动互换。
- Box-local runtime mutation、provider credential 与 Gateway bearer 是三种能力；`runtime *` 不经 daemon 转发。provider secret 只在 modeld 内解封，语法仅 `env:` / `file:`。

## 15. Bundled Skills

CLI 发布物携带与版本匹配的 `core` skill。根 help 首先给出：

```text
Start here (for Agents):
  grokbox skills get core --full
```

命令 registry、help、capability metadata 和 full skill reference 必须同源，不能维护四套漂移文案。

## 16. 验收与失效条件

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
17. `runtime *` 在非本机返回 `runtime_local_only`；`models.json` 拒绝 literal secret；ordinary main envelope（含图与并行工具的可见失败）有离线合同测试。现役 Host 注入不在无离线 transform/guardian 证据时宣称完成。

下列变化会使本文需要重审：Gateway 方法或 token scope 改变；Cursor `EnsureSandBox`/exec/VNC descriptor 或 AnyRun lease policy 改变；box lifecycle/Tailscale identity 不再持久；filesystem/process trust policy 改变；Profile 配置格式或 daemon RPC 出现不兼容版本；Host PromptSession/`SendToUser` 合同或 box-runtime 配置根/本机边界改变。
