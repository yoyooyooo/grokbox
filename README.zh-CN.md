# grokbox

[English](./README.md) | [中文](./README.zh-CN.md)

`grokbox` 是一个非官方 CLI 与控制面，用于从 Grok Bot 云电脑内部或外部进行操作。规范命令是 `grokbox`，`gbox` 是完全等价的别名。

本项目与 Anysphere、Cursor、xAI 或 Grok Bot 没有隶属或背书关系。Grok Bot、Cursor 及相关名称仅用于标识兼容产品，其权利归各自所有者。

> **Alpha：** 当前源码版本是 `0.1.0-alpha.2`，尚未发布。npm 的 `next` dist-tag 目前指向 `0.1.0-alpha.0`；`0.0.1` 是更早且不再支持的快照。`v0.1.0-alpha.1` 只存在于 Git tag。只有通过发布检查及明确范围的外部验收后，才会发布新的预发布版本。

## 它能做什么

```text
Profile -> 本机 daemon -> 本机 Grok Bot Gateway
        -> 通过私有 Tailscale Serve 连接远端 daemon
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
- 有限的 Unix socket/loopback daemon 与私有 Tailscale Serve 映射；
- Agent/Group 管理、消息发送、Transcript、Memory 和有界事件读取；
- 通过命名根目录治理文件读取与变更；
- 字面量结构化执行、持久 Job 和有界日志；
- 分层只读诊断与显式恢复；
- 可选的 Sandbox 生命周期、quota 与桌面兼容适配器。

Daemon 不提供通用 raw RPC 或任意 shell。仅有 Gateway 权限的 Profile 不会获得 host 文件系统或进程权限。

## 前置条件与平台支持

- 发布版 CLI 运行时需要 Node.js 20+。
- 源码开发与发布前源码 shim 需要 Bun 1.3.14。
- 需要一个你拥有或获准使用的 Grok Bot 云电脑。
- 远程 bootstrap/recovery 需要 Tailscale 与 BatchMode SSH；bootstrap 还需要本机 npm 或 Bun，以便重新打包已安装运行时并传输。

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

## 远程初始化

先发现和诊断，再显式执行特权 bootstrap：

```bash
grokbox init remote --peer <tailnet-peer>
grokbox doctor --profile remote

# 安装或替换 grokbox daemon、轮换 daemon 凭据，并且只应用被记录的
# 私有 Serve 映射。需要 BatchMode SSH 与明确确认。
grokbox init remote --peer <tailnet-peer> --bootstrap --yes
```

读取 home 是单独的权限变化，不会由 bootstrap 隐式开启：

```bash
grokbox init remote --peer <tailnet-peer> --bootstrap --admit-home-read --yes
```

启用 host 能力前，请审阅命名文件系统根目录和进程 allowlist。

## 常用安全探针

```bash
grokbox profile list --table
grokbox doctor
grokbox daemon status
grokbox agents list --table
grokbox groups list --table
grokbox history tail <target> --limit 20
grokbox memory list <agent>
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
