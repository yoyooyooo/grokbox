# F · 安装、独立服务寿命与系统入口收束

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-system-cutover`，从当前v2切出。F1是运行核心关键路径，F2/F3不阻已通过的核心日用。

## 目标与入口

固定制品在目标Box可安装、持续运行、准确采用/停止/恢复；管理服务故障时仍能定位原生命周期操作。先读[T40](../../../tickets/T40-persistent-release-and-rollback.md)、[T25](../../../tickets/T25-runtime-effect-root.md)、[T28](../../../tickets/T28-runtime-controller-cut.md)、[官方退出判据](../../../maintainers/official-rollback-acceptance.md)、[CLI-02](../../../tickets/CLI-02-operation-contract.md)和[核心LIVE集合](../../../tickets/LIVE-integration-validation.md#core-runtime-lane)。

## 模块与owner

原`internal/roots/controller-program.node.ts`、`internal/roots/runtime-services.runtime.ts`、`internal/io/runtime-services.node.ts`、modeld生命周期/安装根、配置owner、CLI系统/连接/访问入口和打包。复用已存在的精确进程身份、socket/lease、发布回执和Effect资源寿命，不新建supervisor或第二服务writer。

A拥有Host配方/原生ABI；R拥有执行语义；E拥有worker业务规则；F只装配/管理其正式生命周期。跨域配置schema和服务合同变更由F协调后一次性回流，不在其他路线未接入时全局重命名`daemon.*`迫使全部停工。根依赖/lock变更先与Q登记。

## 出口与依赖

| 出口 | 现在可做 / 依赖 | 必须交付 |
| --- | --- | --- |
| **F1 核心可安装与可恢复** | J0即可做真实宿主只读核对、隔离安装和服务程序；采用时消费A/R | 明确实际支持的服务owner，安装离开源码可运行；Server/modeld独立，父shell退出/进程重启不重放工作；管理服务不可达时凭原owner/target/request恢复；精确采用与安全停止、单Bot回原生和完整未补丁Host退出方法。交J2，现场 loaded/重启/退出与持续运行交J3 |
| **F2 完整系统管理** | F1可独立交付后继续；领域API已进入v2 | 完整system/connection/access/config/credential/model维护入口，复用原writer；离线恢复与普通业务权限分开，Web消费同一能力。来源票继续拥有精确语义 |
| **F3 最后旧宿主退出** | D2、桌面收尾、E2及所有剩余daemon消费者已经给退出证据 | 逐项删除旧daemon RPC/worker/事件接线、旧配置实时兼容和拒绝型占位，更新脚本/Skill/安装/命令发现。不是先删入口再宣布功能不需要；交J5 |

2026-09-22只读观察曾为PID1=tini、systemd user manager=offline；这是必须开工重核的宿主缺口，不是永远成立的环境结论。不能仅凭存在systemctl签支持，也不能长期停在ENV标签。沿既定明确宿主方案解决实际条件；涉及官方supervisor或平台配置变更须取得对应授权，不用nohup/tmux冒充开机资格，不擅建多套fallback。

桌面管理的全部源码与旧消费者修正已作为[全量接入工作包](../../../reports/2026-09-22-desktop-v2-intake.md)进入v2基线。F从v2继承并完成剩余系统/实际宿主资格，不再依赖原施工worktree的未提交文件，也不重做普通桌面迁移。Bot删除后的seat cleanup与D按原生命周期边界统一，不保留第二清理writer；F3仍须核对这项原生边界和其余daemon消费者。

## 验证与停止条件

按影响运行`test/runtime-services-packed.test.ts`、`packages/box-runtime/test/modeld-packaged-lifecycle.test.ts`、`test/packaging.test.ts`及原config/controller/进程恢复组合。固定制品/协议一致性、错误安装/根/epoch、竞争owner、busy拒绝、取消/强杀后的原回执、不可达恢复与持久凭据分别证明；打包通过不等于目标宿主已注册。

不要求J2前就有首次采用后的真实加载或24小时结果；先完成采用前隔离资格、数据保全及可执行恢复方案，Q授权窗口内再完成现场门，避免“没采用不能证明→没证明不许采用”的循环。

安全退出不是恢复旧DB或旧开发版；已发生工具/网络效果不可回滚，unknown不清除。部署只用v2固定候选的不可变安装制品，不指向施工worktree或覆盖现役构建。Git合并不授权现役切换、凭据修改或发布。

## 回流

每个出口提供base/tip、安装manifest、当前命令/服务owner和运行根合同、实际可用宿主证据、失败/恢复范围，以及尚未退出消费者。F1先回流解除核心采用依赖，不等F3完成整棵系统命令树。
