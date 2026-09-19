# NET-01 — Box-local execution and operator-managed networking

## Scope and authority

实现提交 `8d900af` 基于 `feat/box-runtime-v2` 的 `4181e5e` 收敛默认网络边界。该来源提交已经包含本票列出的代码、测试与合同；后续来源登记只修改文档。产品范围唯一归 [Product §2.2](../product-contract.md#22-网络与旧部署兼容边界)，组合与源码职责归 [Architecture §13](../architecture.md#13-deployment-and-operator-managed-networking)。本票只拥有实现、兼容变化和离线证明；当前候选现场状态只看 [LIVE-NETWORK-BOUNDARY](LIVE-integration-validation.md#live-network-boundary)。

Box 内执行是主要路径。既有远程能力按原范围保留，不要求新增 runtime/Host/模型/观测命令远程化；不建立网络 provider 框架。用户自管 DNS/IP、VPN、ACL、TLS 与入口代理。未来 Box-hosted Web UI 的外部浏览器访问归 [T29](T29-runtime-webui.md)，本票不实现或启动 Web UI。

## Implemented changes

| Entry / source | Boundary enforced |
| --- | --- |
| `packages/cli/src/commands/init.ts` | 默认/`--local` 不运行 Tailscale；无本地 discovery 给 `discovery_unavailable` 与 `profile add/use` 指引；不自动挑选 peer 或已有远程 Profile。只有显式 `--peer` 进入旧路径。 |
| `packages/cli/src/diagnostics.ts` | HTTP/TLS、应用认证、capability、Gateway 决定健康；无 Tailscale/SSH/Serve 探测或 IPv4 前提；不从 HTTPS 成功声明尾网身份已验证。 |
| `packages/cli/src/commands/recover.ts` | 健康 endpoint 无需 SSH 即 no-op；其余情况先拒绝认证/协议/权限/监听器错误，仅通过已声明 SSH ensure 已安装 daemon。endpoint 失败且控制面确认 `hibernated/absent` 才 wake；未知状态/网络故障不授权 wake。 |
| `packages/cli/src/registry.ts` | 旧 peer/bootstrap 明示兼容；`recover --legacy-tailnet` 是旧 mapping 恢复的显式 opt-in。 |
| `scripts/verify-external.mjs` | 显式旧部署验收不再错误要求普通 doctor 的 tailnet/Serve 为 pass；仍要求全部应用检查通过。未执行该 live 脚本。 |

Unix socket/loopback listener、非 loopback HTTPS、共享凭据、capability/root policy 和 runtime local-only 不放宽。旧 bootstrap 的 recorded ownership、第三方占用/漂移拒绝、摘要验证、回滚与凭据保护保持原有实现；既有配置、映射与凭据不自动删除。

## Compatibility and operator migration

默认 `init` 不再自动发现或选中远程节点。远程用户显式 `profile add <name> --transport daemon --server-url <https-url> --daemon-token-ref <reference>` 后 `profile use <name>`；已有 Profile 可直接 `profile use`，无需重建凭据。普通域名、MagicDNS 与 IP 使用同一 URL/TLS 规则，不新增网络厂商字段。

旧 `init --peer` 仍可显式使用；`init --bootstrap` 现在必须指定 `--peer`，TTY 仍需确认，headless 仍需 `--bootstrap --yes`。`daemon ensure --bootstrap --yes` 保留旧部署兼容边界。扩张 Tailscale 功能不是后续计划。

**普通 `recover` 不再恢复 Serve。** 只有操作者明确希望检查/恢复已记录的旧映射时，才使用 `recover --legacy-tailnet`；包装脚本不可因为 endpoint 含 `.ts.net`、IP 或配置了 `sshHost` 就自动追加此选项。该模式仍拒绝 unrecorded/drifted/occupied 映射，不接管他人配置。

`doctor` 保留 JSON 字段以避免静默移除：endpoint 路径的 `tailnet` / `serve` 是 `skipped`、code 为 `network_operator_managed`；`tailnetIdentity` 为 `unverified`。连接失败改为 `daemon_endpoint_unreachable`。自动化应读取 `data.ok` 和应用层检查，而不是要求尾网字段通过；诊断完成的进程 exit 0 不等于目标健康。

## Offline proof

本票的回归来自 `test/profile.test.ts`、`test/recovery.test.ts`、`test/daemon.test.ts`。覆盖无网络工具的 DNS/MagicDNS/IP/IPv6 endpoint、普通失败与权限拒绝、健康 no-op、确认休眠后的 SSH 恢复、未知/RUNNING 状态不唤醒、旧精确 mapping 恢复与漂移拒绝。地址场景使用受控 HTTP 响应，不是实际外部 DNS/TLS/IPv6 可达证明；daemon 测试另有真实本地 socket/HTTP listener 与认证检查。

2026-09-19 的验证工具为 Node `v22.22.0`、Bun `1.4.2`；不是一次对仓库声明的所有 OS/Node/Bun 版本的重新资格认证。

| Check | Result / proved scope |
| --- | --- |
| `bun run typecheck` | 通过；最终源码与新增测试严格类型检查。 |
| `bun test ./test/profile.test.ts ./test/recovery.test.ts ./test/daemon.test.ts` | 65 pass / 0 fail，408 assertions；最终连接、恢复与旧 bootstrap 安全回归。 |
| CLI/Skill/权限/observer 扩展组（下方命令） | 185 pass / 0 fail，13 文件；未运行真实外部验收脚本。 |
| `bun test ./packages/runtime-kernel/test` | 270 pass / 0 fail，31 文件；既有共享配置/能力/执行边界回归。 |
| `bun test ./test/packaging.test.ts` | 6 pass / 0 fail；真实构建、tarball、隔离安装与 Node-only 两个别名，原生 SQLite 加载和 bundled skills。 |
| `bun test ./test/live-e2e-checklist.test.ts ./test/live-validation-harness.test.ts ./test/skills.test.ts ./test/cli.test.ts` | 110 pass / 0 fail；最终 LIVE 新行/链接/唯一命令映射以及 help/registry/Skill 一致性。与扩展组重叠，不重复累计。 |
| `bun run build`；`node dist/index.js recover --help` | 通过；真实制品只暴露一个 recover leaf 与显式兼容选项。 |
| `node --check scripts/verify-external.mjs`；`bun run check:publication`；`git diff --check` | 语法、公共文本隐私与补丁格式通过；不等于授权发布。 |

扩展组的实际命令（Bun 路径筛选同时命中 Box-runtime 的 events 测试，故共 13 文件）：

```bash
bun test test/cli.test.ts test/skills.test.ts test/box.test.ts test/events.test.ts \
  test/capabilities_local_server_url.test.ts test/capabilities_gateway_server_url.test.ts \
  test/capabilities_desktop_probe.test.ts test/live-e2e-checklist.test.ts \
  test/live-validation-harness.test.ts test/publication-privacy.test.ts \
  test/sandbox-observer.test.ts packages/cli/test
```

全仓一次 `bun test` 超过执行工具时限，未取得完整结果，不据此宣称全套通过；拆分验证只证明实际跑过的用例。代码/diff 自检不等同独立 reviewer 的结论；没有独立 code-review 凭据。

## Integration and remaining qualification

合入固定 V2 候选后，按 [LIVE-NETWORK-BOUNDARY](LIVE-integration-validation.md#live-network-boundary) 选择相关现场范围：普通 Box init、无 Tailscale CLI 的外部自管 HTTPS endpoint、受控 SSH 恢复，以及明确选择的旧 mapping 兼容验证。旧脚本断言/恢复选项与候选必须匹配。不能从模拟通过签真实 TLS、休眠唤醒或第三方网络兼容。

本票没有授权 merge、push、发布、安装到现役、Host/modeld 重启、全局 shim 切换、Sandbox wake 或 Tailscale/Serve/ACL 变更。T40/T41 的持久进程生命周期仍是各自义务，不由网络收敛关闭或延期。
