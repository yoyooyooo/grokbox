# 配置重建与运维 Spec 的 v2 线性集成回执

日期：2026-09-17。范围：用户明确要求补充 live-only 待办、rebase 最新 v2 并线性合回；不包含生产配置迁移、Host/modeld 切换、模型/Webhook 测试或对外发布。

## 实际 Git 结果

集成前 v2 为 `6f2fcd1af88a530e6a9fe32e58b99862f231a63f`，运维分支为 `52e76eb`，两个工作区均干净。新增 live 待办提交 `efa65571e5cd70a0058ecdc70d1db05fa84e9c4f` 后，再次执行 `git rebase feat/box-runtime-v2`，确认分支已基于当前 v2，无需重放，无冲突、无 hash 改写。

在 v2 工作区核对分支、预期 HEAD 与 tracked/untracked 均干净后，执行 `git merge --ff-only efa65571e5cd70a0058ecdc70d1db05fa84e9c4f`，实际快进成功。`6f2fcd1..efa6557` 范围 merge commit 数为 **0**，原实现 `80fe393`、收口 `9dbddb1`/`52e76eb`、live 待办 `efa6557` 原哈希保留。后续本回执与状态更新是文档提交，不改变集成代码。

本次包含统一配置的实际实现与 T43–T56 的规划文件，不将这些规划文件混算为运维执行代码。AH-99/AH-100 之前的关闭范围和 [实现验收](2026-09-17-unified-configuration-closeout.md) 保持；本次没有再次修改 Linear 或推送远端。

## 本次实际复验

工具链：Bun **1.3.14**，Node **22.22.0**。两个工作区 frozen-lockfile 安装不改锁文件。功能分支和合入后的 v2 分别验证，而不是只靠 Git 快进沿用测试结果。

| 项 | 本次结果 |
|---|---|
| 功能分支 `config-unification` | 200 pass / 0 fail，包含类型检查、构建、实际临时文件/进程、source/packed CLI 与 Host 依赖边界 |
| 合入后的 v2 `config-unification` | **200 pass / 0 fail**，1271 assertions；类型检查、构建、边界检查通过 |
| 两工作区各自的 tarball/Node CLI/E09/配置迁移与别名专项 | 各 **15 pass / 0 fail**，221 assertions；与配置专项有重复，不合并为独立测试总数 |
| live 文档检查 | 初次补充时 3 份文档、72 个本地链接及 live 显式锚点无错误 |
| 新公开入口 | source-backed `grokbox config --help` 可启动；未执行生产配置修改或服务命令 |
| 全仓历史回执 | 先前同代码字节记录为 2152 pass / 6 native skip / 0 fail；**本次未重跑全仓**，严格 all 门仍未因这些跳过被放宽 |

两工作区 Git tree 相同，检查的 646 个源码/测试/锁文件内容逐一相同。源码验收摘要包含权限位，部分文件在原功能工作区为 0664、在 v2 为 0644，因此摘要不同；没有通过 chmod 或修改验收器掩盖差异，而是在 v2 重新执行专项并核对前后稳定。

- 功能分支源码验收摘要：`66d9ac8494bc5eb720722cc79be729a99684e078a51067745fdcda08ad67028a`。
- v2 源码验收摘要：`f42199394cf927bed86bbafd680e5037d59d154d2fd4832e00ec91547b5bf469`；验收前后相同。
- v2 CLI `dist/index.js` SHA256：`806082af9082853c65216fc187d82e84924decd4615f8f979af5bde7d1e84aee`。
- v2 preload SHA256：`db93a6e2707037155ea76f0ed61d581343c655bd3ae9d399c2638bb78674b78f`；E09 oracle 未放宽。

这些摘要证明本次磁盘候选，不代表现役 Host/modeld 已加载。

## live 待办的精确落点

唯一入口仍是 [LIVE integration backlog](../tickets/LIVE-integration-validation.md)。配置已集成，但独立复审与授权窗口未满足，三条均为 blocked：

- [CUTOVER](../tickets/LIVE-integration-validation.md#live-config-cutover)：现役配置来源、旧 writer 停写、生产迁移和源码 CLI 的实际采用。
- [CONSUMERS](../tickets/LIVE-integration-validation.md#live-config-consumers)：真实消费者的 domain revision、正常重启、模型/凭据读路径与最终交付。
- [HOME-RESET](../tickets/LIVE-integration-validation.md#live-config-home-reset)：可丢弃 Box 的真实平台 Reset、durable/home 重建及模型和客户端凭据分别存续。

运维原生验收按 ROUTINES、RECEIVERS、OBSERVER-LIFETIME、ISSUE-PUBLISHING、MAINTENANCE 五条预登记，均为 **blocked-implementation-prerequisite**。原生接口实现、受限权限、离线/打包验证和独立复审仍属于来源票；清单没有把它们包装为「代码已完成，只差 live」。现有 modeld/AUTH 的 live 条目及阻断保持不变。

## source-backed shim 与恢复边界

现场全局 CLI 使用跟随 v2 的源码 shim。本次没有改 shim 文件或启动/停止服务，但源码快进后，下一次 CLI 调用已经使用 config v2；仍有旧配置时可能返回 config_migration_required。不能把“没有改 shim 文件”写成“没有影响 CLI 的下次调用”。config path/validate/migrate 的独立初始化入口和源/打包回归已存在；实际迁移仍须授权窗口。

为避免丢失旧配置的操作入口，合入前额外保留了固定在 `6f2fcd1` 的本机 detached recovery worktree，执行 frozen install/build 和 Node `--version`/`doctor --help` 启动验证。旧 CLI SHA256 为 `38c3b54b6b1716fefcec6c64d88174f8542d628517dff7554a1a8de6decaf051`。该恢复副本未指给全局 shim，未启动旧 daemon/Host/modeld，不代表已经完成任何 live 回滚；具体本机路径不属于公共配置合同。

本次仅完成源码集成、构建、隔离测试和文档回填。独立代码复审留在 T60；没有选择/运行 live candidate，没有更换实际 profile、迁移数据、创建 Bot、消耗模型额度、投递 Webhook 或创建公开 issue。
