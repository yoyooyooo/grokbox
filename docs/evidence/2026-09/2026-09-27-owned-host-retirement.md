# 已知失败 Host 的单次受控退场

2026-09-27，AH-187；延续[正式采用失败](2026-09-27-formal-adoption-unresolved.md)。当前现场入口仍为 [LIVE](../../tickets/LIVE-integration-validation.md)。

恢复读取确认原失败 row、journal、marker、archive、owner claim 与创建/launch 证据一致，但同一 Host 生命周期仍存活。另读 guardian 自己的回执发现 reason=released、原 wrapper 已继续；controller 最终却记 expired。因此最终诊断不足以解释最初触发清理的原因，原失败不能被后来的 readiness 改写。

新增恢复能力位于原 controller/CLI：`runtime operation-recovery --retire-owned-host <original-id> --confirm`。它复用原失败证据校验与 controller/identity 双门，并取得原 modeld service gate。要求同一 boot/creator、已结束的原 controller、原 wrapper 与唯一当前官方监督链、临时资源已退场、desired=disabled、modeld 已停止，以及同代原生 idle。提交前再次检查原文件实例、摘要与资源门。

有界 helper 先取得准确进程的 Linux pidfd 并检查原 launch/operation 环境；父 owner 独占发布一次 SIGTERM 意图后，才允许向该句柄发送普通 SIGTERM。无 SIGKILL、升级或自动重试。失去信号结果仍保留意图，重复调用不会重发；helper 结束前不释放资源门。退出观察不等于官方恢复，必须由原 restore-operation 另行观察并发布物理退出证明。原 journal、attestation、unknown 与用户数据不被重写。

验证范围：恢复、原退出证明、CLI 和真实 Linux 句柄共 129 项通过；新 helper 的打包夹具更新后，后续 63 项定向检查通过。覆盖同代/异代、exec/boot/父链/证据变动、modeld 占用、原生 busy/缺失状态、取消、并发意图、失去信号结果和不重复发送；真实 Node 子进程验证一次正常 SIGTERM 与该句柄的退出。类型、完整构建、文档及 publication 检查通过。早先打包夹具漏复制新 helper 的失败保留，不记为行为通过。

此记录提交时，能力尚未对现场原 Host 执行，不签已退场、官方回程或采用成功。仍不运行创建、模型业务或更新矩阵；费用继续 billing not observed。
