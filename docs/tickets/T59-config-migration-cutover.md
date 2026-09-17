# T59 — 配置迁移、bootstrap 与旧 writer 单向退役

## Status / Goal

**Planned · 2026-09-17 Spec-only。** 完成 AH-99 的新装与旧安装收口：只保留新版日常 SoT，迁移可恢复，不丢 models/secrets/用户关闭设置。唯一合同：[配置 Spec §7](../roadmap/configuration-rebuild-spec.md#migration)。

## Depends-on / Modules

依 T57，复用 T58 的 schema/提交组件并串行修改 shared IO。box-runtime `config-migrate.node.ts` / `config-layout.node.ts` / 现有 configuration reader；CLI bootstrap、init/upgrade、config migrate；旧 profile/daemon 解析器仅供迁移，不继续正式运行路径双读。

## Work

preview 枚举实际 v1 global、profile 树、daemon/live/bootstrap 种子、desired、models 与可能存在的 ops 原型；固定 source/plan digests，分别列冲突/未知与服务影响。不存在 ops 原型就不创建迁移义务；未知字段不可经旧 parser 静默丢弃。

apply 前验证 legacy writer fence：相关旧 daemon/bootstrap/CLI 确已停写或换到支持新协议的 owner。新锁不能约束老程序；证明不足就 blocked，不默认停生产。models 与 secrets 物理不动，profile/desktop/runtime/ops 意图按映射收敛，安全状态分离；旧 grant 默认 suspended 复核而非晋升许可。

使用受保护 backup 与 migration manifest，prepared→publishing→published→activated→retired，每步幂等和可恢复。多文件 publication 后崩溃报告 partial；不宣称旧文件永远不变、不以新版存在/mtime 自动决定谁赢。新的 layout 未激活时消费者不能按半套配置做新危险动作。

新 owner 确认 canonical 读取/相关 revision、secret 引用、models 无损后才退旧路径；bootstrap 调唯一新根程序，不再复制 daemon-config.json 或内联 node 改 JSON。home alias 只在身份明确后创建，冲突保全不覆盖。upgrade 只提示需要迁移，真正 migrate 必须批准 exact plan 与必要中断范围。

## Executable acceptance

创建并执行：

```bash
bun test packages/box-runtime/test/config-migration.test.ts packages/box-runtime/test/config-migration-crash.test.ts test/bootstrap-config-v2.test.ts
bun run typecheck
```

用临时完整旧树/真实子进程验证每个 publication 和 activation 边界硬崩，重复 recover 不丢偏好/重复授权。覆盖空安装/旧安装/混版本 writer/两份配置冲突/home alias 替换/源在预览后变化/不支持 filesystem sync/不可读 secret/旧 bootstrap 重建文件。新装只种 canonical 新意图，旧机器现有 off/预算保留，备份不复活授权。

models 文件与 secret 引用前后 bytes/digest 保持；v2 chatDialect 与未知新字段不掉失。canonical 模型 no-follow 不因 home alias 放松；client-only 恢复不误生 Box 模式。生产 Reset 和 native/modeld 切换仅独立批准后验证，临时模拟不能证明平台持久性。

## Forbidden / Non-goals

不自动选择新文件赢，不双写保兼容，不强杀未归属 writer，不改 server harness/原生数据、不搬 retained Host/CLI 制品、不执行 production Reset 或隐式迁移。不用 finally 成功假装硬崩已恢复。

## Done evidence

提交迁移阶段/恢复矩阵、旧 writer 退役检查与 bootstrap 真实路径测试。AH-99 的文档/两文件入口/迁移/消费者 gate 全满足后再请求关闭，不在本票文档创建时改 Linear。
