# 2026-09-16 — Template Bot 告警、诊断与受限静默运维

**状态：接受用户补充后的设计方向；实现与本机部署未授权于本文件。** 施工细节唯一归 [Template Ops Spec](../roadmap/template-ops-automation-spec.md)，本页只保存决策及其对既有规则的精确修订。总运行时仍归 [主 Spec](../roadmap/box-runtime-impl-spec.md)。

**2026-09-17 后续裁决：** [默认能力/支持/Routine 决策](2026-09-17-ops-defaults-support-and-routines.md)补充 D8–D12；当前默认为正常服务启用后 user 轻量观察、配对后最小提示，不是默认模型排障。T51–T53 扩展配置、用户确认后 issue 与通用 Routine CLI。本页保留初始设计，不再作为默认值的唯一说明；有限维护授权和单 controller 边界不变。

## 问题与用户结果

仅能发现 Host/profile 变化但必须用户自己查看 CLI，不足以满足日常使用。用户接受：不能静默处理时由 grokbox template bot 主动告警；该 Bot 可以通过带 Payload 的原生 Webhook 定时任务被唤醒，自动做有限排障后报告，也可参与极低风险、高确定性的静默维护。后台持续采样不应变成一个永远 Working 的 Bot 任务。

现有基础值得复用：HSO 的来源与 replay、T41 的观察/incident、T28 的唯一 controller、T40 的服务生命周期、按能力渐进加载的模板技能。原生 Webhook 的具体 DTO/认证/克隆语义须由 T43 核实，不能从用户确认功能存在推导出完整接口合同。

## 决策

### D1 — Bot 是用户运维入口，不是常驻传感器或唯一安全执行器

确定性 collector 无模型地采样；Bot 由有限事件唤醒，用官方模型解释证据、选择受限诊断、提出计划并报告。正常无变化不唤醒。观测、诊断、执行和用户交付各自有持久状态与有界生命周期；没有通用 shell 运维平台。

### D2 — 通知不是命令，Payload 不带授权

所有监测源经有身份和 scope 的 adapter 形成内部事件，再向精确配对的原生 Webhook 出口投递安全 envelope。Bot 必须通过本地 claim 读取真实证据，不能将 Payload 的文本、URL 或「已批准」当操作指令。outbox、原生接收、Bot 领取、报告交付和用户已读分别记录；重复通知不能重复执行维护。

### D3 — 接受有限的预授权自动化，而不是逐个动作都人工确认

用户可以针对安装与动作类建立 `maintain-low-risk` grant。已资格化组合的轻量对齐、满足已审核等价规则的新 SHA profile 派生，以及预授权的安全退出，允许在所有运行条件通过后自动执行。资格由确定性程序与限定测试证据决定，Bot 的 confidence 不是批准者。

这精确修订 HSO 的「所有 profile 发布都必须本次人工审核、所有 adopt 都必须本次独立人工确认」：**对 Spec 指定的低风险动作类，可用可撤销、作用域明确、版本/预算/到期绑定的预授权替代逐次点击；profile 发布与 adopt 仍是独立事实。** 超出类别、改变补丁语义或依赖覆盖未知时，原人工审核与独立 live 授权规则继续生效。

runtime 精确 source SHA、唯一性、全变换 SHA、Server 归属门、Host session/tool/SendToUser 语义与 J13 均不放宽。不自动批准新 recipe，不把新的低风险分支藏进旧 `confirmed:true`。

### D4 — 维护交接必须避免 Bot 操作自己的 Host

Bot 将不可变 plan 交给独立维护角色后结束本回合。维护角色只能调用已有唯一 controller，必须确认真实安全边界，不能忽略提出者的 running 状态。不能让 Bot 等自己的 Host 重启再返回；不能把后台挂起任务当作解决方案。

### D5 — 模板分发能力蓝图，不分发活连接与权限

内置 Webhook 的产品结果采用禁用、无 secret 的蓝图加安装后配对。原生导入不支持安全禁用/重新生成时，由随模板的 bootstrap 指引在配对后创建原生任务。各导入实例获得独立 endpoint/绑定/secret；从不共享发布者 Bot ID、旧交付记录或 grant。模板 Bot 保持官方模型。

### D6 — 保留一个事实 owner，不建第二控制栈

HSO 保留源码与资格证据，T41 扩展原 SQLite 管理交付与诊断，ConfigurationWrite 管理绑定/策略，controller store 管理 plan/operation。维护调度只负责持久交接和调用，不实现另一个注入/停止流程。通知/观测故障不能阻断已有推理，也不能自动解除原有 circuit。

### D7 — 自动化建立在真实权限和恢复证据上

原生 Bot 拥有任意 shell 时，文字约束不构成能力隔离。T46/T47 必须证明工具边界；证明不了就只做固定只读报告。Host idle 采样不能替代原生 admission/drain 屏障；证明不了安全窗口就告警等待。整个 Box 离线、原生 Webhook 不幂等或不能证明用户已读等限制必须明确披露。

## 拒绝的替代方案

不采用定时拼接 `doctor && upgrade --yes`、让模型自己批准 replacement、在通知重试中重做维护、在旧 watcher 中恢复直接 TERM、为了自动化改官方 supervisor/更新 channel，以及收到 Payload 就运行其中的命令。

也不把「任何新 SHA 都永远只能人工」作为目标：可审核的等价规则和完整覆盖证明是开放有限自治的正式路径；失败则回到告警，不以无限谨慎否定用户希望的低风险静默处理。

## 衔接与失效

主 Spec S0 路由本专项；T43–T50 是新任务，不改写历史票 Done 的含义。T41 仍拥有一般观测/通知，新增原生 Bot 出口不使其成为控制 authority。自动执行完成前，现有 CLI 的无确认 reconcile 和人工 live 边界保持不变。

原生任务/模板复制/认证、Host 或 modeld 契约、工具权限、策略作用域或 controller ownership 变化时，需重新资格化受影响动作。文档建立不等于自动化开启，本轮也不发布模板或创建真实定时任务。
