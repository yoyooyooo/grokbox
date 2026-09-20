# Roadmap：接受的差额与未来候选

本目录只路由尚需交付的目标和未排期候选，不维护当前实现或现场结果。实现事实从源码和来源票读取；长期合同已归入 [产品](../product-contract.md)、[架构](../architecture.md)和 [runtime 专题](../box-runtime.md)。旧 Spec 路径仅保留稳定锚点跳转，不再定义另一套当前合同。

## 本轮方案收束

[Agent-first CLI 与架构重建](agent-first-cli/README.md)拥有命令合同、统一后台、能力重建至 Web UI 完整交付的已接受目标与工作链路。精确合同和施工细节仍待推进，尚未启动业务重组。Web 功能工程与后台一起推进，最终视觉后置；施工期间允许不可用，整合后集中验收，再由用户确认并吃狗粮。Web UI 的[功能边界](future/webui-console.md)、[V0 视觉](../design/webui/v0/README.md)与[来源研究](../reports/2026-09-19-webui-source-feasibility.md)分别拥有各自含义。

[Host 补丁健康识别与监控告警闭环](host-patch-health-proposal.md)面向新架构：Rust/Oxc 静态内核、Node 管理的按任务 stdio/只读FD调用已讨论确认；[包与目录建议](host-patch-health-proposal.md#package-layout)明确五个现有TS包的职责、一个Cargo package和独立wire schema。完整方案仍保留其决策/实施边界；复用HSO/HCR、T44、原OBS与唯一controller，不代表增量已实现或获准现场采用。

## 已接受目标的剩余交付

| 目标 | 合同与差额入口 |
| --- | --- |
| 同 Bot 原生官方/自定义模型往返、长上下文和实际 App 体验 | [Execution](../runtime/execution.md)、[context](../runtime/context.md)、[T39](../tickets/T39-native-model-roundtrip.md)、[跨领域验收](../runtime/acceptance.md) |
| 正常服务生命周期、可恢复采用和完全卸载退路 | [Host compatibility](../runtime/host-compatibility.md)、[T40](../tickets/T40-persistent-release-and-rollback.md)、[HCR](../tickets/README.md#host-capability-recovery) |
| 原生默认提醒与长期有界运维 | [Operations](../runtime/operations.md)、[OBS/ops](../tickets/README.md#incident-evidence)；sender、collector 常驻、native 送达和全安装容量分别证明 |
| 单一当前状态、材料保护、逐职责替身与关系交接、旧入站收敛和安全退役 | [Continuity](../runtime/continuity.md)、[CONT](../tickets/README.md#ownership-continuity)；已实现基础不等于完整终局 |
| 已有配置/模型/上下文能力的进一步资格 | [Configuration](../configuration.md)、[CTX](../tickets/README.md#context-maintenance)、[reasoning](../tickets/FEAT-model-reasoning-policy.md) |
| Host 来源感知、候选语义和受控发布 | [HSO/HCR 合同](../runtime/host-compatibility.md)；复用原 publisher/controller，不引入第二升级器 |
| 单 Box Web UI 与共享后台 | [页面/交互目标](future/webui-console.md)、[T29](../tickets/T29-runtime-webui.md)、[重建骨架](agent-first-cli/implementation-impact.md)；作为本次完整交付的一部分，共用领域用例与合同 |

本表不声称这些领域完全未实现，也不要求每次修复重开全部旧票。新版验收范围来自已接受目标，不能按当前实现进度自行缩小；各来源票拥有具体实现/离线/review 差额，[LIVE](../tickets/LIVE-integration-validation.md)拥有集中验收判据和当前结果。开发中的局部验证不等于每段发布，旧窗口报告不自动签署新候选。

## 未排期与独立候选

| 方向 | 入口与边界 |
| --- | --- |
| 多 Box 和盒外失联观察 | [fleet observation](future/fleet-observation.md)；本地进程不能自报整机离线，不跨机器共享 SQLite |
| 更多通知渠道与升级规则 | [notification escalation](future/notification-escalation.md)；不改变当前单目标提醒或扩大权限 |
| 额外 backend | [Pi RPC](../tickets/T30-runtime-pi-backend.md)、[Cursor](../tickets/T31-runtime-cursor-backend.md)、[进程内 pi-ai 资格](../tickets/PI-AI-01-model-backend-qualification.md)是不同候选，不阻塞本地 compact |
| 连接/生命周期扩展 | [daemon streaming](future/daemon-access-and-streaming.md)、[外部环境](future/box-lifecycle-and-tailnet-hardening.md)；已有适配按源码保留，不把网络产品管理变成 runtime 责任 |
| 受控凭据发现与 quota 新来源 | [credential discovery](future/cursor-credential-discovery.md)、[quota](future/quota-query.md)；不得从另一能力凭据推导权限 |
| 用户决定后的支持公开 | [ops/T52](../tickets/T52-consented-support-issues.md)、[ops/T56](../tickets/T56-scripted-issue-publishing.md)；默认提醒不自动询问或发布 Issue |

候选晋升时确定用户场景、非目标、事实/效果 owner、授权与证据，写回对应合同并链接实现票。新日期、目录存在、旧模型批准和一次测试绿都不自动授予实施以外的现役/费用/发布权限。

## 历史不再驱动施工

旧 Phases 0–4、T20/T21 起步指令、特定模型审查编排、临时 worktree 清理清单和旧配置示例都属于 [rebuild archive](../archive/runtime-rebuild.md)。它们不要求新 Agent 先重走项目历史。

旧入口保留只为已知链接和外部书签；新正文直接指向当前 owner。固定验证回执继续存放于 [reports](../reports/README.md)，与归档的设计历史分工不同，不复制当前 LIVE 状态。维护规则见 [documentation](../maintainers/documentation.md)。
