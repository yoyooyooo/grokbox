# grokbox

[English](./README.md) | [中文](./README.zh-CN.md)

`grokbox` 是以受支持的 Grok Bot 云电脑内执行为主的非官方 CLI 与控制面。既有远程 Profile 保留明确支持的命令；新增本地 runtime 能力不承担远程等价义务。规范命令是 `grokbox`，`gbox` 是完全等价的别名。

本项目与 Anysphere、Cursor、xAI 或 Grok Bot 没有隶属或背书关系。Grok Bot、Cursor 及相关名称仅用于标识兼容产品，其权利归各自所有者。

> **Alpha：** 当前源码版本是 `0.1.0-alpha.6`。npm 的 `next` dist-tag 目前指向 `0.1.0-alpha.5`；`0.0.1` 仍是 `latest`。`v0.1.0-alpha.1` 到 `v0.1.0-alpha.4` 只存在于 Git tag。只有通过发布检查及明确范围的外部验收后，才会发布新的预发布版本。

> **规划中：原生 Bot 协助与故障提醒。** 已接受的下一阶段会保全有界诊断现场，向独立配对的目标Bot发送简短告警、incident ID与取证命令。自动告警默认只提醒；用户委托后，Bot可自主排障、管理Bot或换模型。**本次文档变更没有交付或启用通知链，也不会自动创建Issue。** 原生Bot唤醒可能消耗模型额度；数据范围、保留期限和关闭入口均属于发布合同。详见[实施规划](docs/roadmap/template-ops-automation-spec.md)。

## 它能做什么

```text
Profile -> 本机 daemon -> 本机 Grok Bot Gateway
        -> 通过用户自管网络连接已配置的 HTTPS daemon
        -> 显式 direct-local 或 Gateway 兼容路径
        -> 显式 Cursor Sandbox 或 quota 兼容适配器
```

已实现的命令族：

```text
init  skills  profile  daemon  doctor  recover  box  quota
agents  groups  send  history  memory  events  is
fs  exec  jobs  desktop
```

主要能力：

- 严格区分本机与远端 Profile，并分离不同凭据权威；
- 有限的 Unix socket/loopback daemon 与用户自管的外部 endpoint；
- Agent/Group 管理、消息发送、Transcript、Memory 和有界事件读取；
- 通过命名根目录治理文件读取与变更；
- 字面量结构化执行、持久 Job 和有界日志；
- 分层只读诊断与显式恢复；
- 可选的 Sandbox 生命周期、quota 与桌面兼容适配器。

Daemon 不提供通用 raw RPC 或任意 shell。仅有 Gateway 权限的 Profile 不会获得 host 文件系统或进程权限。

## 两条路径

1. **操作官方产品** — Profile、daemon、`agents` / `send` / `history`。以 Box 内执行为默认，既有远程命令按原有支持范围保留。
2. **给单个 Bot 换大脑** — 在电脑上：`grokbox on`，`grokbox host start`，`agents create`，`models use --for <agent>`。grokbox 更新后：`grokbox upgrade --yes`。App 新建在不少账号上是 **temporal**，走不了自定义模型通道。

给 Agent：先读 `grokbox skills get grokbox` 的小型入口，再按能力加载，例如 `grokbox skills get grokbox --topic models`；`grokbox skills list` 可发现所有主题。`--full` 是显式查阅全部专题，不是默认启动步骤。文档与安装的 CLI 同版本，不要把完整指南拷进 Bot；模板只保留[`加载桩`](./skills/stubs/grokbox.md)。完整命令清单仍是 `grokbox skills get core --full`。

## 前置条件与平台支持

- 发布版 CLI 运行时需要 Node.js 20.17.0+（与原生 monitor SQLite 依赖的最低版本一致）。
- 源码开发与发布前源码 shim 需要 Bun 1.3.14。
- 需要一个你拥有或获准使用的 Grok Bot 云电脑。
- 远程命令需要可达的用户自管 HTTPS endpoint 与 daemon 凭据引用；Tailscale 是可选基础设施，不是 CLI 前置依赖。
- 已安装 daemon 的远程恢复可显式配置 BatchMode SSH。只有旧 peer/bootstrap 兼容入口依赖 Tailscale；旧 bootstrap 另需 npm 或 Bun。

| 角色 | 支持或已测试平台 |
| --- | --- |
| 源码开发 | Linux 与 macOS |
| Node CLI | Linux 与 macOS |
| Box daemon、文件、Jobs、desktop | Linux |
| Keychain secret reference | macOS |
| Windows | 当前不支持，也未测试 |

## 五分钟源码快速开始

```bash
git clone https://github.com/yoyooyooo/grokbox.git
cd grokbox
bun install --frozen-lockfile
bun run typecheck
bun run grokbox -- --help
bun run grokbox -- doctor
```

`doctor` 是只读命令。它会分别报告各项边界，不会唤醒 Sandbox、修改 Tailscale Serve、启动 daemon 或轮换凭据。

在运行中的 Grok Bot box 内，没有 Profile 文件时，`default` Profile 会从 `/home/box/sand-data/gateway.json` 发现 loopback Gateway。若既没有本机 Gateway，也没有已配置 Profile，命令会安全失败。

## 安装

```bash
npm install --global grokbox@next
grokbox --version
gbox --help
```

需要 Node.js 20 或更高版本。发布后的 package 不需要 Bun。

## 源码驱动的全局 shim

若要验证尚未发布的 checkout，可把 `grokbox` 和 `gbox` 安装到 `~/.local/bin`，并让它们通过 Bun 直接执行 TypeScript 入口：

```bash
bun run shim:install
grokbox --version
gbox --help
grokbox doctor
```

安装器可幂等运行，以原子方式写入两个别名，拒绝覆盖无关命令，并从仓库外验证每个命令。它记录 checkout 与 Bun 的绝对路径，因此仓库或 Bun 可执行文件移动后需要重新运行。该路径用于验证本机真实源码，不替代 Node tarball 验证。

## 本地初始化与用户自管 endpoint

`grokbox init` 只初始化本地 Box，不发现 Tailscale peer，也不自动选择远端 Profile。使用既有远程命令时，显式配置已部署的入口；凭据只传引用，不把值放进 argv：

```bash
grokbox profile add remote --transport daemon --server-url https://box.example.invalid:9443 --daemon-token-ref env:GROKBOX_REMOTE_TOKEN
grokbox profile use remote
grokbox doctor
```

普通 DNS、MagicDNS 与 IP 使用同一 URL 字段，均须通过正常 TLS 校验。VPN、DNS、ACL、证书与代理由用户管理。daemon 保留 Unix socket/loopback 监听；用户自管 HTTPS 入口可转发至 loopback，非 loopback HTTP 仍被拒绝，不要求开放公网。

`doctor` 判断 endpoint 与应用健康，不判断 Tailscale/Serve 状态。`recover` 对健康 endpoint 直接 no-op；不健康时可通过已声明的 SSH ensure 已安装 daemon。默认不修复网络，只有控制面确认休眠才可唤醒 Sandbox。

### 仅保留旧部署兼容

显式 `init --peer`、`daemon ensure --bootstrap --yes`、`recover --legacy-tailnet` 保留旧的有界 Tailscale/Serve 部署路径，不再是推荐入口，也不扩展为网络管理。既有映射和凭据不会自动删除。Bootstrap 仍须确认，`--admit-home-read` 仍是独立扩权。详见[网络与兼容合同](docs/product-contract.md#22-网络与旧部署兼容边界)。

未来 Web UI 服务运行在 Box 内，外部浏览器通过用户自管入口访问；不因此实现远程 runtime 或 Tailscale SDK。应用会话认证、授权及 Origin/CSRF 边界仍须落实。

## 常用安全探针

```bash
grokbox profile list --table
grokbox doctor
grokbox daemon status
grokbox agents list --table
grokbox groups list --table
grokbox history tail <target> --limit 20
grokbox memory list <agent>
grokbox export agent <agent> --out ./export
grokbox fs stat workspace:/artifact.txt
grokbox jobs list --table
grokbox desktop status --table
```

变更命令需要显式 capability；破坏性操作还需要显式确认。`desktop prune run` 默认 dry-run；传入 `--yes` 后会调用上游 stop-window 路径，并删除该 fork 的 Chrome profile。

## 凭据

不要把 Gateway、daemon、Sandbox、quota、SSH 或 tailnet 凭据放进 argv、Issue、fixture、snapshot 或普通日志。

Secret reference 按用途区分：

```text
env:<NAME>
file:<absolute-path>
keychain:<service>/<account>
```

`file:` 必须指向当前 POSIX 用户拥有、group/other 无权限位的普通文件；拒绝符号链接。Profile 不保存 inline token。Gateway、daemon、Sandbox 与 quota 凭据是分离的 capability，不能互相替代。

## 实验性兼容表面

Grok Bot Gateway method、Cursor Sandbox RPC、Cursor Web quota endpoint 和 Grok Bot desktop 布局都不是上游公开 API，可能无预警失效，也不表示 provider 背书或授权。

尤其需要注意：

- 已观察到官方 Cursor OAuth 可读取 Sandbox 状态，但调用 `EnsureSandBox` 会收到 401；
- 无 App 唤醒及 24–72 小时 keeper 行为不是稳定承诺；
- quota 需要显式独立来源，并受来源本地账号绑定；
- desktop prune 依赖 Linux/布局，确认执行时具有破坏性。

使用这些表面前，请阅读[兼容性与上游边界](docs/compatibility.md)。用户需要自行遵守其账号和环境适用的条款与政策。

## 开发与验证

```bash
bun install --frozen-lockfile
bun run check
```

Package 测试会在本机构建和打包，把产物安装到隔离的系统 Trash fixture，用 Node 验证两个别名，核对精确 package allowlist，并确认项目与第三方许可证存在。`Release candidate artifact` workflow 只生成可下载产物，不会发布。

只有精确版本 tag 才会触发独立的 OIDC Trusted Publishing workflow：预发布版本进入 npm `next`，稳定版本进入 `latest`；registry 版本、channel 与 provenance 回读成功后才创建 GitHub Release。详见[发布手册](docs/maintainers/release.md)。本机 release 命令只做预检与推送不可变 tag，不会从维护者机器发布 npm。

真实外部验证保持独立，并要求显式注入获授权的目标。设置 `GROKBOX_EXTERNAL_PACKAGE=grokbox@<version>`，可验证用户实际安装的精确 registry 版本，而不是本机 tarball。Fake-provider 或 local-real 结果不能证明 provider 授权、长期 lease 行为或破坏性恢复能力。

## 文档

- [文档地图](docs/README.md)
- [产品契约](docs/product-contract.md)
- [架构](docs/architecture.md)
- [兼容性边界](docs/compatibility.md)
- [上游集成事实](docs/upstream-integration.md)
- [安全策略](SECURITY.md)
- [支持](SUPPORT.md)
- [贡献指南](CONTRIBUTING.md)
- [变更日志](CHANGELOG.md)

当前行为由源码和可执行测试决定。产品与架构文档可能描述已接受目标；roadmap 和 GitHub Issue 不能证明功能已经交付。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。发布包中的第三方归属见 [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES)。
