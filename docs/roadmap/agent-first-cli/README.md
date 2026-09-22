# Agent-first CLI、架构重建与 Web UI 交付

当前在 W3，统一管理架构及多个领域已实现。最终目标仍是完整新版、唯一现行合同和 writer；运行核心先完成完整质量/范围验收，由用户确认后逐 Bot 切模型日用，其余管理能力和自有 Web 并行完成，再收束全产品 W4/W5。原版 Grok Bot App、正常辅助链、长会话、持久恢复和必要保全不随自有 Web 后置。

| 要回答的问题 | 唯一正文 |
| --- | --- |
| 为什么做、做到哪里、什么条件可以先日用？ | [Spec](spec.md#core-runtime-adoption) |
| 并行 Agent 各管什么，哪里阻塞/汇聚，怎样回流 v2？ | [并行交付拓扑与路线卡](parallel-delivery.md) |
| W1–W5及已接受的模块责任是什么？ | [重建骨架与工作链路](implementation-impact.md) |
| 命令输入、身份、输出、操作、等待如何统一？ | [候选命令合同](command-contract.md) |
| 完整候选命令树与参数归属是什么？ | [命令目录](command-catalog.md)；实际命令仍以源码registry为准 |
| 现有每条命令去哪里？ | [迁移映射](migration-map.md) |
| 哪些已决定，哪些还有合同工作？ | [决策清单](decisions.md) |
| 当前实现差额、核心与全产品采用结果在哪里？ | [CLI-05](../../tickets/CLI-05-implementation-follow-through.md)、[核心LIVE集合](../../tickets/LIVE-integration-validation.md#core-runtime-lane) |
| Web 功能边界与原生来源能达到什么程度？ | [页面目标](../future/webui-console.md)、[固定研究记录](../../reports/2026-09-19-webui-source-feasibility.md) |
| 早期多视角审查与视觉参考在哪里？ | [固定review](../../reports/2026-09-19-agent-first-cli-review.md)、[V0视觉](../../design/webui/v0/README.md)；均不充当当前资格/最终批准 |

## 接续方式

交给并行实施者：分配[一张路线卡](parallel-delivery.md#先找到自己的路线)，从当前`feat/box-runtime-v2`切独立worktree，核对相应来源票/源码与依赖出口；每完成一个可验工作包回流v2，不另起方案或重做已闭合管理迁移。共享装配/合流与现场窗口由Q负责，实际采用只用固定制品，不使用施工worktree。

当前优先链是A/R/F/E与D1汇聚运行核心，经J2受控采用、J3真实工程验收、J4用户核心范围确认后日用。B/C/D2/E2/F2/W并行继续；未完成全产品义务不因核心可用而删除。合理工程默认解直接收口，只有真实能力不足导致承诺变化或授权扩大时再对齐。

合同差额继续归CLI-01～CLI-04，跨域集成归CLI-05，共享API/Web归T29和WEB-02/03，材料归DATA-01，模型/CONT/OBS/安装由原来源票拥有。文档是路线，不代替源码/原生/现场证据；验收只进入原LIVE索引，不建立第二个状态系统。
