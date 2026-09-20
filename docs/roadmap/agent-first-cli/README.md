# Agent-first CLI、架构重建与 Web UI 交付

本轮已对齐核心能力、复用骨架、一次性采用与数据兼容边界。CLI 合同是前置，整体规划覆盖重建、Web 功能工程、安装与集中验收；视觉参考未定稿，不阻塞信息架构和真实功能原型。施工期间可不完整或不可用，整合后集中 E2E、用户验收，再开始吃狗粮。精确合同和施工细节仍待推进，本目录不是当前 CLI 使用指南，尚未启动业务重组或浏览器开发。

| 要回答的问题 | 唯一正文 |
| --- | --- |
| 为什么做、做到哪里、怎样验收？ | [Spec](spec.md) |
| 命令输入、身份、输出、操作、等待如何统一？ | [候选命令合同](command-contract.md) |
| 完整的候选命令树与参数归属是什么？ | [命令目录](command-catalog.md) |
| 现有每条命令去哪里？ | [迁移映射](migration-map.md) |
| 哪些已决定，哪些先讨论？ | [决策清单](decisions.md) |
| 如何从合同推进到重建、Web UI 与完整交付？ | [重建骨架与工作链路](implementation-impact.md) |
| Web UI 功能边界与数据能达到什么程度？ | [页面目标](../future/webui-console.md)、[固定研究记录](../../reports/2026-09-19-webui-source-feasibility.md) |
| 命令方案的多视角审查发现在哪里？ | [固定 review 报告](../../reports/2026-09-19-agent-first-cli-review.md)；处理项归 CLI-02/CLI-04 |
| 已暂定的视觉 V0 与图片在哪里？ | [V0 视觉基线](../../design/webui/v0/README.md) |

## 工作顺序

下一阶段的细化任务由 CLI-01～CLI-04 来源票承接，具体产物写回本目录对应正文；不另开外部独立方案。合理默认解按已确认原则直接收口，只有产品范围、核心体验或能力证据导致承诺变化时再对齐。

已确认方向见 [Spec](spec.md) 和 [决策清单](decisions.md)，不再重复询问同一架构分叉。接下来由 [CLI-01 身份与发现](../../tickets/CLI-01-discovery-and-targeting.md)、[CLI-02 操作与结果](../../tickets/CLI-02-operation-contract.md)、[CLI-03 观察与等待](../../tickets/CLI-03-observation-and-wait.md) 补齐具体合同，再用 [CLI-04 命令去向与切换](../../tickets/CLI-04-command-cutover.md) 收口整棵树及直接切换的迁移证据。

[CLI-05 端到端收束](../../tickets/CLI-05-implementation-follow-through.md)承接跨域重建、消费者迁入与集中验收，[T29](../../tickets/T29-runtime-webui.md)拥有共享 API 和浏览器总责，[WEB-02](../../tickets/WEB-02-web-foundation.md)/[WEB-03](../../tickets/WEB-03-functional-prototype.md)分别承接工程基础和真实功能页面。[DATA-01](../../tickets/DATA-01-memory-project-files.md)承接材料来源、检索及受支持修改，[WEB-01](../../tickets/WEB-01-visual-baseline.md)保存视觉参考和后续定稿。现有领域票继续拥有自己的差额，不重做仍适用成果；旧 LIVE 不是重建前置，新版验收只进入原 [LIVE 索引](../../tickets/LIVE-integration-validation.md)。

本次使用 `to-spec` 与 `to-tickets` 的目标、依赖、验收结构，按用户要求落在仓库文档中；未发布外部 Issue。合同票完成意味着方案可据以实施，不代表代码交付。