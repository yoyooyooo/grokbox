# 文档收敛合入 v2 与源码口径对齐 · 2026-09-19

本报告保存文档集成与限定验证，不声明新的现场通过。此前切片见 [原报告](2026-09-19-documentation-convergence.md)，本次原生能力基线见 [生命周期报告](2026-09-19-continuity-lifecycle-integration.md)。当前现场结果仍由 [LIVE](../tickets/LIVE-integration-validation.md)拥有。

## Git 集成与冲突

原文档改动从 `4181e5e` 保存为 `1502685`，对齐 v2 的 `6bf4f61` 后为 `2351c84`，再吸收 v2 最新 LIVE 口径 `b753be0` 后为 `d1c0dfa`。第一轮仅 `docs/README.md` 有 Git 内容冲突；保留新的任务导航，连续性事实从对应合同、来源票和固定报告发现，不恢复首页中的重复状态表。两笔连续性代码提交 `da8e673` / `6bf4f61` 与 `b753be0` 的 LIVE 更新保留。

目标 v2 在分支、HEAD 和 tracked/untracked 干净校验后，已从 `b753be0` fast-forward 到 `d1c0dfa`。没有 merge commit、push 或部署。随后收尾继续在同源文档 worktree 中进行；本报告所在提交的最终合入由 Git 快进结果确认，不能从文件存在推出分支已移动。

## 语义对齐范围

- `runtime/continuity.md` 对齐有限 clone/replace/spawn、外部空闲 reset/recover、保护/关系/旧入站程序；区分 ready、active、startup、业务完成、关系迁移和源可删除，不把全附件、self-reset、外部职责、临时结果清理或自动退役写成已交付。
- 新增 [生命周期指南](../maintainers/bot-lifecycle.md)，更新 [当前状态指南](../maintainers/current-state-control.md)、产品和维护者入口；命令例子来自实际 registry/CLI，不调用真实 Bot 验证文档。明确保护 intervalMs 未消费、原生退休屏障缺失和未知创建不重放。
- [Ticket 索引](../tickets/README.md)改为领域/完整路径导航，去掉重复进度、旧配置/协议版本、历史工作树和测试身份表。所有来源票仍可按完整文件名发现；T32、T43–T50 的同号文件不混成一个 ID。
- [旧 strategy plan](../roadmap/box-runtime-plan.md)退为当前合同和历史理由入口，不再含“立即执行 T20/T21”的旧重建指令。
- CONT-02/04/09/10/11 与 T54 的实际状态对齐新源码；仍未完成的职责/材料/安全/原生资格继续留在各来源票，不自动关闭它们。

上轮未成功写入的 Ticket 索引与 strategy plan 本次均已落盘。早期报告中的工具失败、旧缺口和测试事实保持原时间范围，不追改成当时已经成功。

## 验证

工具链为 Bun 1.3.14 与 Node v22.22.0；没有修改项目 Node 最低版本或锁文件。检查使用整合后的源码树，build 仅在隔离文档工作树运行，不替换 v2 的现役制品。

```bash
bun run typecheck
bun run build
bun test test/docs-governance.test.ts test/live-e2e-checklist.test.ts \
  test/live-validation-harness.test.ts test/modeld-core-verifier.test.ts \
  test/ah92-admit-observation.test.ts test/ah97-followups.test.ts \
  test/outcome.test.ts test/skills.test.ts test/packaging.test.ts \
  test/bot-handover-cli.test.ts packages/runtime-kernel/test/bot-lifecycle-contract.test.ts
node scripts/check-publication.mjs --include-untracked
git diff --check
```

联合运行 **147 pass / 0 fail，2399 assertions，11 文件**；包含文档/稳定 LIVE 锚点和所有命令覆盖、配置示例实际 schema、每张来源票可达、生命周期示例注册、结果观察、Skill、原生依赖安装包与合成关系/生命周期回归。类型、构建和含新增文件的隐私检查通过。早期文档检查发现两处沿用旧 Spec 锚点的链接，已改到新专题真实标题并重验；不削弱链接规则换绿。

新检查不固定 LIVE 当前结果为 not-run，也不把任何未执行的模型格变为 passed。147 项是一次联合运行，不与首轮21项或旧139项叠加。没有重跑全仓、声明独立审核完成、执行 opt-in 原生/live 资格或签 Node 最低版本完整运行矩阵。

Git 对照 `b753be0` 的 `packages/`、`scripts/` 和 `bun.lock` 无改动：现有业务实现保持不变。此次新增测试及 package 的 check:docs 属于文档验证面，不开启产品副作用。

## 本次保留的限制

[CONT-01](../tickets/CONT-01-ownership-loss-notification.md)顶部 planned 状态的写入被工具安全检查拒绝，两次同一编辑均未落盘；没有改用其他写入路径。该旧状态与现有保护程序有差异。本次以实际源码、[连续性合同](../runtime/continuity.md)、来源固定报告和操作指南判断已实现的有限范围，不据旧 planned 重做保护程序，也不把保护字段存在当作完整现场闭环。本报告不宣称所有文档漂移已清零。

没有改变现役配置、全局 shim、Host/modeld/daemon、Bot/Routine/凭据或 LIVE 结果，没有模型费用、业务消息、删除或远端发布。源集成、配置/制品采用、原生用户效果与生产发布仍是不同事实。
