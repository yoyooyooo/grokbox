# 主题证据：机制、反例与设计演变

与[日期窗口](../2026-09/README.md)同属 [Evidence](../README.md)。这里回答跨实验的问题：尝试过哪些构造、为什么保留或放弃、哪些细节可以移植。主题提炼不更新旧窗口的通过范围，也不能替 LIVE 签收。

| 主题 | 内容 |
| --- | --- |
| [独立 POC 导航与证据链](independent-poc-atlas-2026-09.md) | 独立目录里的实验阶段、源码/回执关系、正式实现可复用部分和短期保留依赖 |
| [官方客户端入口与自定义执行](official-client-ingress-poc-2026-09.md) | 自有会话、官方工具委托、客户端分流和本地群切口的差别；为何最终回到普通 Bot |
| [普通 Box Bot 与 Local-first](box-local-first-poc-2026-09.md) | 同源创建正反例、完整业务窗口与官方升级失权反例 |
| [原生运行接线](native-runtime-poc-contracts-2026-09.md) | 原输入绑定、ackToken、Routine 子父回传、共享 Memory、模型隔离和未结算结果 |
| [更新、归属与观察证据](host-update-identity-poc-2026-09.md) | 程序更新、归属迁移、Server 读回与本地投影分层，首次启动观察的缺口 |
| [运行时重建基线](runtime-rebuild.md) | 可恢复的历史源码、已退出的布局/阶段及保留义务 |
| [Managed compact 演变](managed-compact-evolution.md) | 为什么晚注册、pending summary 和仅计时器修补不够；原始历史定位 |
| [里程碑审查残留](milestone-review-residue.md) | 固定发现与后续限定收口，不把旧模型编排变成现行机制 |
| [外部 session 研究](external-session-research.md) | 完整旧研究的 Git 回读方式与适用范围，不充当当前架构权威 |

当前合同在 [Documentation](../../README.md)，工作在 [Roadmap](../../roadmap/README.md)／[来源票](../../tickets/README.md)，当前现场只在 [LIVE](../../tickets/LIVE-integration-validation.md)。独立 POC 尚被使用不妨碍提炼，但归档不能成为自动删除它的理由。
