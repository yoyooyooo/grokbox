# Roadmap：接受的差额与未来候选

本目录只路由尚需交付的目标和未排期候选，不维护当前实现或现场结果。实现事实从源码和来源票读取；长期合同已归入 [产品](../product-contract.md)、[架构](../architecture.md)和 [runtime 专题](../box-runtime.md)。旧 Spec 路径仅保留稳定锚点跳转，不再定义另一套当前合同。

## 已接受目标的剩余交付

| 目标 | 合同与差额入口 |
| --- | --- |
| 同 Bot 原生官方/自定义模型往返、长上下文和实际 App 体验 | [Execution](../runtime/execution.md)、[context](../runtime/context.md)、[T39](../tickets/T39-native-model-roundtrip.md)、[跨领域验收](../runtime/acceptance.md) |
| 正常服务生命周期、可恢复采用和完全卸载退路 | [Host compatibility](../runtime/host-compatibility.md)、[T40](../tickets/T40-persistent-release-and-rollback.md)、[HCR](../tickets/README.md#host-capability-recovery) |
| 原生默认提醒与长期有界运维 | [Operations](../runtime/operations.md)、[OBS/ops](../tickets/README.md#incident-evidence)；sender、collector 常驻、native 送达和全安装容量分别证明 |
| 单一当前状态、材料保护、逐职责替身与关系交接、旧入站收敛和安全退役 | [Continuity](../runtime/continuity.md)、[CONT](../tickets/README.md#ownership-continuity)；已实现基础不等于完整终局 |
| 已有配置/模型/上下文能力的进一步资格 | [Configuration](../configuration.md)、[CTX](../tickets/README.md#context-maintenance)、[reasoning](../tickets/FEAT-model-reasoning-policy.md) |
| Host 来源感知、候选语义和受控发布 | [HSO/HCR 合同](../runtime/host-compatibility.md)；复用原 publisher/controller，不引入第二升级器 |

本表不声称这些领域完全未实现，也不要求每次修复重开全部旧票。选择本次交付的用户结果和必要依赖；各来源票拥有具体实现/离线/review 差额，[LIVE](../tickets/LIVE-integration-validation.md)拥有被选发布范围的实际现场判据。

## 未排期与独立候选

| 方向 | 入口与边界 |
| --- | --- |
| 单 Box Web UI | [页面/交互目标](future/webui-console.md)、[共享命令边界](../maintainers/t29-command-boundary-incubate.md)；复用现有 writer/DTO，不另建 UI 配置权威 |
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
