# NET-01：V2 线性集成与合入后复验

本报告保留 2026-09-19 的固定源码与离线复验结果，不是当前现场状态表。实现与兼容变化归 [NET-01](../tickets/NET-01-box-local-network-boundary.md)；现场结果唯一归 [LIVE-NETWORK-BOUNDARY](../tickets/LIVE-integration-validation.md#live-network-boundary)。

## 固定源码与授权

本次重新连接后，实际 V2 HEAD 为 `303926dddfe4f35b914ee524838ba0f74daa6efa`，工作树干净。此前授权的线性集成已完成，无需再次应用功能补丁：

```text
02a4b5f  V2 集成前基线
  → e2908af  网络边界实现；原始提交 8d900af
  → c2b39bd  来源登记；原始提交 ab62db3
  → 303926d  对齐 V2 最新文档结构与链接
```

`git merge-base --is-ancestor 303926d HEAD` 返回 0，`git rev-list --count --merges 02a4b5f..303926d` 返回 0。功能分支与 V2 在此提交相同。上一轮冲突以 V2 为准的结果保留；本次不重做冲突处理，也不改动功能代码。

用户授权范围是本地线性合入与补齐验证/登记，不包含 push、发布、现役采用、Host/modeld 重启、全局 shim 切换、Sandbox wake 或网络配置变更。

## 合入后的实际验证

以下检查实际在 V2 的上述固定提交运行，不仅是合入前功能分支的结果。工具为 Node `v22.22.0`、Bun `1.4.2`；未修改仓库的 `packageManager` 或锁文件，也不据此宣称全部支持版本已重新验证。

| 检查 | 固定结果与范围 |
| --- | --- |
| `bun run typecheck` | 通过，严格类型检查。 |
| `bun test ./test/profile.test.ts ./test/recovery.test.ts ./test/daemon.test.ts` | 65 pass / 0 fail；3 文件，408 assertions。 |
| `bun run check:docs` | 23 pass / 0 fail；3 文件，1395 assertions。覆盖文档引用、LIVE 结构与解析、来源票发现。 |
| `bun test ./test/cli.test.ts ./test/skills.test.ts ./test/bot-handover-cli.test.ts ./test/packaging.test.ts` | 103 pass / 0 fail；4 文件，2352 assertions。包括 CLI/registry/Skill、既有交接回归和真实 tarball 构建、隔离安装、Node 两个别名与原生依赖加载。 |
| `node dist/index.js recover --help` | 通过；构建制品保留普通恢复和显式 `--legacy-tailnet` 选项。 |
| `node --check scripts/verify-external.mjs` | 语法通过；未执行真实外部验收脚本。 |
| `git diff --check` | 通过；上述复验未产生 tracked 源码变更。 |

三组测试共 191 项、10 个不同文件、4155 assertions；后续文档回填的重复检查不再累计。两次组合命令均明确设置 180 秒工具时限，实际完整返回且退出码均为 0；没有用缺少最终汇总的执行认定通过。

## 证明边界与后续

本次没有运行全仓 `bun test`，不将专项通过升级为全仓通过。DNS/MagicDNS/IP/IPv6 场景仍使用受控响应；本地 socket/HTTP 和隔离安装有真实进程验证，但不证明外部 TLS、实际尾网、休眠唤醒或现役 Host 已采用。

网络收敛代码已经集成，LIVE 不应继续显示 `awaiting-integration`；其实现状态可为 `integrated`，现场结果仍是 `not-run`。独立代码审查尚无结论，后续实际 endpoint/SSH 及高影响兼容验证需要各自环境和授权，不能标为 ready 或 passed。剩余差额留在 NET-01，场景阻断只在 LIVE 保留其影响。

本次补充提交只更新上述来源票、LIVE 条目及报告发现入口；不调整其他场景的候选、结果或权限。
