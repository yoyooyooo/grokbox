# 单盒当前状态操作

本页说明手动当前状态控制，包括空白目标初始化和外部空闲目标 reset/recover；完整复制、生命周期和关系交接另见 [生命周期指南](bot-lifecycle.md)。它不代表完整替身自动接替或现场采用已经完成。产品仍是一个长期Memory身份、一份当前工作上下文，没有会话列表或切换。合同归 [S13](../roadmap/box-runtime-impl-spec.md#continuity-primitives)，实现范围归 [CONT-07](../tickets/CONT-07-current-context-control.md)，现场只看 [LIVE-CURRENT-CONTEXT](../tickets/LIVE-integration-validation.md#live-current-context)。

## 前置边界

仅限本云电脑的原生Gateway和已加载、已注册的默认Bot。当前候选通过`current-state` profile能力增加有限RPC、主Host准备屏障及原生worker事务；没有这些接缝时明确返回unavailable，不自动更新Host或改profile。使用现有同源reviewed baseline升级流程，保留所有已有接缝，不能拿测试中删减过的baseline安装到现役。

当前运行配置为旧schema时先安排成套配置/消费者采用，不能只运行新版源码迁移其中一个对象。`runtime profile analyze/write --capability current-state`是已有profile工作流的显式新能力选项；其写入和后续re-adopt仍遵守原来的确认、基线摘要与LIVE窗口。

## 命令与效果

| 命令 | 实际效果 |
|---|---|
| `agents state show <id>` | 读取当前head及profile绑定策略版本，不创建CONT库，不授执行权 |
| `agents state capture <id> --operation-id <uuid> --confirm` | 将有界原生checkpoint闭包保全到本机私有CONT库；不修复源、不调用模型 |
| `agents state initialize <target-id> --snapshot-id <uuid> --expect-revision <sha256> --operation-id <uuid> --confirm` | 按材料清单导入同scope的空白目标，包括声明的 Memory/历史补充；保持准备屏障，不启动任务 |
| `agents state reset <target-id> --expect-revision <sha256> --operation-id <uuid> --confirm` | 先保全当前状态，再通过原生空闲屏障替换工作上下文；不清长期 Memory/真实文件，不启动任务 |
| `agents state recover <target-id> --snapshot-id <uuid> --expect-revision <sha256> --operation-id <uuid> --confirm` | 先保全当前状态，再从固定快照建立恢复候选并读回；不重放过去工具，不把恢复当成会话切换 |
| `agents state operation <target-id> --operation-id <uuid> --scope-id <sha256>` | 离线读取本地初始化操作，不访问Host、也不升级旧CONT库 |
| `agents state reconcile <target-id> --operation-id <uuid> --confirm` | 使用已保存的原请求对账原生应用凭据，更新本地安全记录；不重做导入、不解除未知屏障 |
| `agents state activate <target-id> --operation-id <uuid> --confirm` | 对已读回的初始化解除准备屏障，允许后续普通输入；不发送Human消息，不主动开始推理 |

所有目标使用精确UUID。创建、捕获和初始化是不同操作；各自固定UUID，丢回执后继续检查原操作，不能换ID盲重试。输出仅含head、引用和收据，原始prompt/blob不进入普通stdout。正常CLI只做本机管理，不支持远端Profile伪装成同盒初始化。

## 手动验证顺序

先show源Bot再capture，记录snapshot引用、scope和质量缺口。新版捕获在原生引用图之外可携带有界agent Memory、历史补充及受管指令；初始化会按材料清单应用这些补充，不再统一承诺只改模型窗口。共享user/project Memory和完整附件未被整体复制；pending/未知效果不能直接导入成新的待执行任务。

通过`agents create --harness box --defer-start`显式请求关闭自我介绍和kickstart，核实新ID/归属。这个开关不构成入站隔离，不等于prepared；不要在初始化前给目标发业务消息。新目标已运行、存在转录/请求/结算记录或待处理Routine结果，即使没有root也不再是本入口允许的空白目标。

show目标，使用其exact revision和已保存snapshot初始化。原生worker在同一事务写root/依赖与应用凭据；主Host随后CAS发布指针、重新装载并写自己的应用记录。只有两层读回与准备状态完成才返回prepared。没有跨两个数据库的虚构原子事务：任何中间失败保持unknown/blocked并可对账，不以worker成功单独宣布Bot准备好了。

检查prepared结果后，再按已有权限显式activate。激活不启动任务；之后的正常输入才进入目标Agent loop，继续产生B1/B2。旧初始化操作重入不能把B0重新灌到B2。已加载正式Host/实际模型/客户端上的首轮、重启后续轮，需要LIVE取证，fixture通过不替代。

## 外部 reset / recover

这两个入口由外部操作者用于空闲、已加载目标；self-reset 的持久安全排队仍未交付，不能在 Bot 自己的控制回合中以同步调用冒充该能力。先用 show 获取实际 contextRevision，明确本次替换工作上下文的授权；reset/recover 要求已有 root，不能用来隐式创建一个 Bot。

同一 operation 固定 backupSnapshot 和候选引用，备份必须先于原生替换。reset 构造不带旧对话的合法新上下文；recover 使用指定快照，候选含 unknown_effects 时构造有来源的受限摘要候选，不将 pending 工具重放。读取 coverage 和原生应用回执，而非将 snapshot 存在当作完整恢复。

两者复用初始化接受/读回/对账程序。结果与 scope/operation 一起保存；确认 prepared 后，解除准备仍使用相同操作的 activate，不以 reset/recover 返回推导任务已启动。长期 Memory、模型配置和已发生外部文件/任务不回滚。源 revision 变化或不确定原生写入应检查原操作，不能换 UUID 重做。

## 故障处置

`source_changed`重新读取状态并重新评估，不能自动覆写新版本。`not_prepared`表示目标或在途状态不适合初始化，不使用clearConversation清掉记录来通过门禁。`commit_unknown`与`cleanup_unknown`先查询原操作和reconcile；原生凭据缺失不是未执行证明，禁止改operationId再尝试。仅worker已提交而主Host应用记录未完成时，对账仍可能unknown；保持屏障，不擅自补写或激活。

接缝不支持、worker握手不匹配或Host源码换版时拒绝该能力，沿现有profile诊断/重新资格流程处理。普通GET不修复数据库，不把首次读取Temporal伪称刚刚发生迁移。

## 明确未交付的产品范围

生命周期、外部空闲Bot reset/recover、受管指令startup及保护/关系交接已有有限源码切片，范围和证明见[固定回执](../reports/2026-09-19-continuity-lifecycle-integration.md)，操作见[生命周期指南](bot-lifecycle.md)。全附件/资源迁移、self-reset安全队列、完整外部任务与职责约束、临时结果交付/清理、可靠旧Bot退役仍归来源票，不改标成只差Live。精确参数以registry/help为准，实际现场结果只归唯一索引。
