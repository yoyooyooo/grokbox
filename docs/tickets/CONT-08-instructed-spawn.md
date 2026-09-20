# CONT-08 — 受管初始指令与临时 Bot 启动

**状态：partial implementation；已实现受管指令、准备状态创建、显式程序startup及持久去重，完整临时生命周期未完成。**

[本轮集成证据](../reports/2026-09-19-continuity-lifecycle-integration.md)覆盖CLI→生命周期账本→原生owner/worker及选定原生启动接点。已修复空resume无turn直接返回的问题，使用新turn的空文本simulated事件载体，并在私有启动范围内不向模型追加用户任务提示；普通输入不受影响。该窄接缝证明不等于完整原生handler、Provider首请求或用户已收到结果。

maxRunMs仅约束一次启动；完整费用/TTL、结果交付、孤儿和未结任务清理仍是实现任务，不以只差Live关闭本票。

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-07、CONT-11与CONT-00创建/启动资格。列入完整交付范围，但不阻塞已合格的替身导入和交接主线。

## 目标与模块

当前 `bot spawn --input ... --preview/--confirm` 复用受控创建、初始化和 activation，不通过用户身份发一条任务消息。旧 `agents spawn` 入口已退出。真实Box身份在首次推理前配置好持久指令、初始材料、模型、工具/费用边界和结果接收者，再以程序startup事件进入原生Agent loop。

CLI 经统一管理 Server 和共享客户端提交，原 CONT 程序与 Host 的 CONT-07 writer/runner 继续负责效果，不增加第二模型 loop。`lifecycle.write` 与 `lifecycle.start` 分别控制生命周期和可能收费的程序启动；私有声明绑定原管理主体，阶段前重新核权。`operation get/resume --domain lifecycle` 只定位并续接原工作流，查询不启动模型；Web `/lifecycles` 仅观察，不创建/启动。初始化材料、运行指令和启动意图分开，原生规则保持独立。[CLI-05](CLI-05-implementation-follow-through.md)维护本次管理迁入的固定测试与未证项。

## 行为要求

创建显式关闭原生introduction/kickstart，保持hold并核实无提前推理；官方创建路径不同默认值不可靠。优先验证background materialization避免抢用户活动聊天。初始化、ready、started和completed独立，actual ownership/模型/指令版本必须读回。

现有`--instructions`是description别名，原生kickstart是介绍流程，不包装冒充本能力；hidden prompt不等于非Human startup。启动有稳定activationId、实际发起者与政策，失败/重启重入先对账，不再派一份相同工作。线上协议中环境载体和伪用户任务区别取证，严格模式不支持则明确失败，不能暗退为sendPrompt。

持久受管指令在后续TURN、compact和Host重启后仍被装配，不只临时prepend一次请求。初始数据不能升格为授权；临时身份不自动继承创建者Memory、工具/告警或诊断权限。

临时lifecycle有时间/模型费用/创建次数预算、结果交付和清理规则；未结任务/未交付结果不因TTL到达就删。共享云电脑不是新沙箱，结果交给指定合法接收者，不套自我介绍强迫向用户发问。

## 验收出口

新增真实生产装配/owned provider/原生资格与packed测试：初始化前零推理，第一请求即正确模型/指令，无Human任务条目；指令跨compact/reopen保持；重复startup、丢回执、所有权变更、预算耗尽、结果未交付和TTL清理。

实际Server/Host/下一回合及临时Bot清理在[LIVE-CONTINUITY-SPAWN](LIVE-integration-validation.md#live-continuity-spawn)取证。功能路径未实现不建立空壳green verifier。

## 非目标

不替换全部官方system规则，不造权限，不复制外部运行句柄，不用恢复动作或compact冒充首次启动，不开跨机器或多会话平台。
