# Box-runtime tickets

本页按责任发现来源票，不复制当前实现进度、协议版本、测试计数、部署状态或工作树清理清单。当前实现由源码/schema/可执行测试证明；来源票拥有该范围的实现、离线、独立 review 差额；[LIVE-integration-validation](LIVE-integration-validation.md)是当前现场结果唯一入口，[固定报告](../reports/README.md)保留每次观察的限定事实。

## 使用与身份

完整文件路径是票据身份。历史 T32 和 T43–T50 有多个领域复用编号，引用时必须带主题和链接，例如 [T43 · modeld authority](T43-modeld-authority-baseline.md) 与 [T43 · native Webhook](T43-native-webhook-contract.md)，不能仅凭裸 T43 或“T43–T50”确定任务。保留已有文件名/外部引用，不批量重编号；新工作优先使用清楚的领域名。

不要从 open 推断完全没有代码，也不要从旧 done 推断当前版本已获原生/生产资格。完成范围与剩余义务由具体来源票解释，索引不重写结论。依赖按本次受影响用户结果选择，不把历史阶段当成重建起点；产品/运行时合同从 [文档地图](../README.md)进入。

## Agent-first 命令、架构重建与 Web UI 交付

[本轮 Spec 与决策](../roadmap/agent-first-cli/README.md)以命令合同为前置，整体覆盖统一后台、已有能力重建、Web UI 与最终交付。合同票完成不等于代码交付；CLI-05 负责跨域收束，既有领域票继续拥有各自差额。施工期不要求持续可用；功能工程先行、视觉后置，整合候选集中验收后由用户确认，再进入吃狗粮。旧 LIVE 不是重建前置。

| 来源票 | 范围 |
| --- | --- |
| [CLI-01](CLI-01-discovery-and-targeting.md) | 按需发现、真实身份、稳定引用与机器输出 |
| [CLI-02](CLI-02-operation-contract.md) | 提交、幂等、未知结果、并发与恢复 |
| [CLI-03](CLI-03-observation-and-wait.md) | 活动读面、来源覆盖、等待与快照续流 |
| [CLI-04](CLI-04-command-cutover.md) | 完整命令目录、旧入口去向和切换合同 |
| [CLI-05](CLI-05-implementation-follow-through.md) | 架构重建、消费者迁入、旧边界退出与端到端交付 |
| [WEB-01](WEB-01-visual-baseline.md) | V0 参考与后续视觉定稿，不阻功能工程 |
| [WEB-02](WEB-02-web-foundation.md) | Web 工程、状态/请求归属、SSR 与访问安全 |
| [WEB-03](WEB-03-functional-prototype.md) | 信息架构、真实功能页面与浏览器验收 |
| [DATA-01](DATA-01-memory-project-files.md) | Memory/Project/文件来源、检索索引和受支持修改 |
| [T29](T29-runtime-webui.md) / [T15](T15-webui-ops-config-storage.md) | 共享合同/API、并发修改保护与 Web 交付总责 |

## 集成、验收与公共工作入口

| 责任 | 入口 |
| --- | --- |
| 固定候选、场景、当前结果、阻断和下一步 | [LIVE — 长期现场清单](LIVE-integration-validation.md) |
| 窗口步骤、对象/费用/退路与清理 | [Live 执行手册](../maintainers/live-end-to-end.md) |
| 跨域验收不变量 | [V01–V30](../runtime/acceptance.md)、[F/E](../maintainers/managed-context-continuity.md) |
| 文档冲突、引用与新鲜度 | [文档维护](../maintainers/documentation.md) |
| 公共提案与缺陷 | [Issue tracker](../agents/issue-tracker.md) |

来源票不另建当前 live 表；将非 live 缺口留在来源票，仅把影响哪个场景的阻断链接到 LIVE。合入不是现场授权，单次 green 不关闭长期索引。

<a id="voice-delegation"></a>
## 语音委托：当前阶段之后的独立事项

[语音 Spec](../roadmap/voice-delegation-spec.md)拥有 Box-only 自定义推理与结果交付的后续范围，[Roadmap](../roadmap/README.md#voice-delegation)拥有排程。方向已接受，用户回访时再启动；不插队 HOST-01/CLI-05，不作为现有 W4/W5 或 LIVE 的新增前置。以下票尚未实施，研究线索不代表当前客户端、Host 或账号路径已获资格。

| 来源票 | 范围 |
| --- | --- |
| [VOICE-01](VOICE-01-route-and-host-qualification.md) | 实际 Harness 路由、Box 执行入口、来源资格与可复现缺口 |
| [VOICE-02](VOICE-02-managed-execution-and-delivery.md) | 复用受管模型、wake/steer 关联、正确通话交付及失败/重拨边界 |
| [VOICE-03](VOICE-03-live-acceptance-and-coverage.md) | 官方客户端真实闭环、分层交付证据与独立委托覆盖评估 |

## 执行、控制与原生往返

合同：[Execution](../runtime/execution.md)、[Host compatibility](../runtime/host-compatibility.md)、[Context](../runtime/context.md)。下列票仍保留各自边界与证明，不继承旧阶段的一键执行顺序。

| 来源票 | 责任 |
| --- | --- |
| [T20 · 布局切割](T20-runtime-layout-cut.md) | workspace、import、旧入口退场 |
| [T21 · Codec 保真](T21-runtime-codec-fidelity.md) | 输入内容、工具与双向协议投影 |
| [T22 · Raw 输出](T22-runtime-raw-output.md) | Host fd 输出与隐私边界 |
| [T23 · ModelBackend](T23-runtime-model-backend.md) | 唯一模型能力和后端适配 |
| [T24 · RouteBinding](T24-runtime-route-binding.md) | 单 Bot 下一 TURN 选择、原绑定与安全回官方 |
| [T25 · Effect root](T25-runtime-effect-root.md) | 服务资源、Unix transport 和关闭 |
| [T26 · Host fullStream](T26-runtime-host-fullstream.md) | 原生消费者、工具/流/终态与实际交付 |
| [T27 · 状态 facets](T27-runtime-status-facets.md) | status、journal、各事实面的边界 |
| [T28 · Controller](T28-runtime-controller-cut.md) | 唯一控制程序、原生写入与恢复 |
| [T32 · 内核溢出恢复](T32-runtime-confirmed-compact.md) | confirmed-overflow、一次受控恢复与零重复副作用 |
| [T32 · Host compact seam](T32-host-compact-seam.md) | 原生安全点、摘要接受及原生资格；不同于上一票 |
| [T33 · 诊断](T33-runtime-diagnostics.md) | 来源限定的深层观测与交付缺口 |
| [T34 · 审查残留路由](T34-astra-milestone-residue.md) | 已关闭历史与仍需当前资格的事项分离 |
| [T35 · Host 等待点](T35-host-compact-wait-point.md) | provider 前准备、pending/摘要寿命、取消与原生 retry |
| [T36 · Working](T36-composer-working-activity.md) | 当前会话/run/代的 App 活动与结束语义 |
| [T37 · Server 准入](T37-server-ownership-admission.md) | 原始归属、scope、新鲜度和执行门 |
| [T38 · 身份写入](T38-identity-write-alignment.md) | 普通更新无隐式 harness、创建确认、冲突保护 |
| [T39 · 原生往返](T39-native-model-roundtrip.md) | 同 Bot 官方/A/B 回程、checkpoint 和原版 App |
| [T40 · 持久发布/退路](T40-persistent-release-and-rollback.md) | 服务安装、受控采用和完整未补丁退出 |
| [T41 · 持续观测](T41-continuous-observation-and-alerting.md) | 共享采集、SQLite、incident 和通知事实 |
| [T42 · 外部 Host 经验](T42-upstream-host-session-lessons.md) | 有版本来源参考，不是新的执行权威 |
| [AUTH · 取证可用性](AUTH-ownership-evidence-availability.md) | 同 STEP 复用、原始年龄、有限等待与共同诊断 |
| [FIX · Host reapply](FIX-host-lifecycle-reapply.md) | 生命周期重应用的已知修复及对应回归 |
| [NET-01 · 本地执行与网络边界](NET-01-box-local-network-boundary.md) | 用户自管 endpoint、默认诊断/恢复与显式旧部署兼容 |
| [FEAT · 推理设置](FEAT-model-reasoning-policy.md) | 同通道 effort、不可变选择与最终请求证据 |

<a id="modeld-effect-core"></a>
## Modeld 执行核心

合同：[modeld execution](../runtime/execution.md#one-step-program)。此处 T43–T50 仅指下列 modeld 文件，不指后面的原生运维同号票。

| 来源票 | 责任 |
| --- | --- |
| [T43 · Authority baseline](T43-modeld-authority-baseline.md) | 原生责任与可执行基线 |
| [T44 · Service lifetime](T44-modeld-service-lifetime.md) | 唯一 acquisition、owned/borrowed 资源 |
| [T45 · Evidence lifetime](T45-modeld-evidence-lifetime.md) | typed evidence、共享 source 与独立 waiter |
| [T46 · State/durability](T46-modeld-state-and-durability.md) | 执行身份同步、claim 和有界维护 |
| [T47 · Authority state machine](T47-modeld-authority-state-machine.md) | 同 STEP 等待、最终 effect fence、一次终态 |
| [T48 · Causal observation](T48-modeld-causal-observation.md) | 失败因果、诊断独立与制品证据 |
| [T49 · Qualification/release](T49-modeld-qualification-and-release.md) | 固定策略、性能、review、原生与发布资格 |
| [T50 · Review residue](T50-modeld-review-residue.md) | 非重复实施的审查残留与责任 |
| [FIX · Tool contract evidence](FIX-tool-contract-evidence.md) | 工具声明、tool_choice、分层流证据与执行旁支吸收 |

<a id="context-maintenance"></a>
## 本地上下文维护

合同：[Context](../runtime/context.md)；来源/许可：[Pi reference](../maintainers/pi-compaction-reference.md)。算法复用不等于采纳 Pi Agent loop；模型传输候选独立于本能力。

| 来源票 | 责任 |
| --- | --- |
| [CTX-00](CTX-00-pi-compaction-reuse.md) | 公共 API、提取/适配选择、Node/许可与实际算法证明 |
| [CTX-01](CTX-01-context-policy-and-meter.md) | 本地策略、继承、计量与版本捕获 |
| [CTX-02](CTX-02-host-context-maintenance.md) | 原生安全点、operation、接受/checkpoint/读回 |
| [CTX-03](CTX-03-bounded-summary-and-recovery.md) | 有界摘要、巨型材料与溢出恢复合流 |
| [CTX-04](CTX-04-context-entrypoints-and-proof.md) | 普通下一输入、手动入口、原生/制品/用户旅程 |
| [PI-AI-01](PI-AI-01-model-backend-qualification.md) | 独立进程内 ModelBackend 传输资格；不是 T30 RPC |

<a id="ownership-continuity"></a>
## 当前状态、生命周期与交接

合同：[Continuity](../runtime/continuity.md)。操作：[当前状态](../maintainers/current-state-control.md)、[生命周期/交接](../maintainers/bot-lifecycle.md)、[duplicate](../maintainers/native-agent-duplicate.md)。实现状态按当前源码及各来源票读取，不从早期存储切片推断所有 native binding 仍未接通，也不从有限生命周期接口推出完整终局已交付。

| 来源票 | 责任 |
| --- | --- |
| [CONT-00](CONT-00-native-clone-feasibility.md) | 原生能力、材料闭包与版本资格 |
| [CONT-01](CONT-01-ownership-loss-notification.md) | 归属丢失、保护观察、暂停与通知 |
| [CONT-02](CONT-02-continuity-snapshots.md) | 分档材料、恢复存储与引用保护 |
| [CONT-03](CONT-03-native-box-clone.md) | 新身份的有来源状态 clone |
| [CONT-04](CONT-04-automatic-replacement.md) | 替身创建、激活与逐职责接替 |
| [CONT-05](CONT-05-continuity-acceptance.md) | 完整北极星及日用验收，基础切片不代整项关闭 |
| [CONT-06](CONT-06-native-duplicate-cli.md) | 官方式 duplicate 及持久创建事实 |
| [CONT-07](CONT-07-current-context-control.md) | 唯一当前状态 capture/initialize/reset/recover/reconcile |
| [CONT-08](CONT-08-instructed-spawn.md) | 持久初始指令、startup、临时任务结果与清理 |
| [CONT-09](CONT-09-relationship-handover.md) | 群/DM/Routine/外部依赖的机械与辅助交接 |
| [CONT-10](CONT-10-inbound-convergence-retirement.md) | 旧入站连续覆盖、多代关系与安全源退役 |
| [CONT-11](CONT-11-policy-and-operation-contract.md) | 配置、授权、质量/预算与操作协议 |

<a id="incident-evidence"></a>
## 故障证据与有界存储

合同：[Operations](../runtime/operations.md)。OBS 复用原有观察/执行 owners；诊断 GC 不取得恢复或执行安全状态的删除权。

| 来源票 | 责任 |
| --- | --- |
| [OBS-00](OBS-00-evidence-contracts.md) | E01–E08 字段、关系、实际边界与 coverage |
| [OBS-01](OBS-01-incident-intake-and-detection.md) | 未知/无 STEP/未收束入口与 incident |
| [OBS-02](OBS-02-incident-evidence-snapshots.md) | 不可变快照、固定 revision 与查询 |
| [OBS-03](OBS-03-evidence-privacy-views.md) | 本地/Bot/公共视图与源头隐私 |
| [OBS-04](OBS-04-bounded-observation-storage.md) | 跨 owner 容量、轮转、物理回收与租约 |
| [OBS-05](OBS-05-safe-state-retirement.md) | 旧请求失效、unknown 与安全状态退役 |
| [OBS-06](OBS-06-integration-and-soak-proof.md) | 故障/容量稳态、制品和分层整体验证 |

<a id="template-ops-automation"></a>
## 原生 Bot 通知与自主运维

合同：[Operations](../runtime/operations.md)；操作：[原生运维指南](../maintainers/template-ops-automation.md)。此处同号 T43–T50 指 ops 文件。默认提醒、用户委托、独立预授权维护和公开动作彼此不借权。

| 来源票 | 责任 |
| --- | --- |
| [T43 · Native Webhook](T43-native-webhook-contract.md) | 原生接口、HTTP 接受与实际回合边界 |
| [T44 · Host sensing](T44-host-ops-continuous-sensing.md) | 共用持续来源感知与本地故障采集 |
| [T45 · Delivery](T45-template-webhook-delivery.md) | 固定现场、outbox、显式/自动发送与对账 |
| [T46 · Pairing](T46-template-ops-pairing.md) | 私有配对、资格采用、默认提醒与模板 |
| [T47 · Diagnosis](T47-bounded-ops-diagnosis.md) | 原生 Bot 受托自主排障和操作核验 |
| [T48 · Qualification](T48-low-risk-host-qualification.md) | 低风险动作/完整配方与依赖资格 |
| [T49 · Maintenance](T49-policy-host-maintenance.md) | 唯一 controller、排空、预授权与安全退出 |
| [T50 · Release](T50-template-ops-release-proof.md) | 持久服务、提醒首发与分层验收 |
| [T51 · Policy/configuration](T51-ops-capability-presets.md) | 配置、存储预算及各 consumer 采用 |
| [T52 · Support draft](T52-consented-support-issues.md) | 延期的用户主动支持草稿，不恢复默认 Issue 询问 |
| [T53 · Agent/Routine CLI](T53-agent-routines-cli.md) | 通用原生管理、provision 与组合入口 |
| [T54 · Targets/routing](T54-ops-targets-and-routing.md) | 单目标配对及后续有限路由 |
| [T55 · Receiver qualification](T55-custom-receiver-delivery.md) | 接收者模型/能力、故障域和交接 |
| [T56 · Publishing](T56-scripted-issue-publishing.md) | 延期的用户决定后 gh 路径，不自动公开 |

<a id="configuration-rebuild"></a>
## 统一配置

合同与操作：[Configuration](../configuration.md)。精确 shape/version/defaults 由源码 schema 拥有；普通 config、models 和受限机器状态的 writer 不混同。

| 来源票 | 责任 |
| --- | --- |
| [T57](T57-unified-config-schema-layout.md) | 配置根、schema 与领域边界 |
| [T58](T58-config-command-single-writer.md) | 唯一提交、scope、CAS 和生效回执 |
| [T59](T59-config-migration-cutover.md) | 迁移、bootstrap、恢复和旧 writer 退役 |
| [T60](T60-config-ops-integration-proof.md) | 配置集成、发布边界与交叉消费者证明 |

<a id="host-capability-recovery"></a>
## Host 能力与中断恢复

合同：[Host compatibility](../runtime/host-compatibility.md#hcr-current-controlled-capability-and-operation-recovery)。profile 发布、实际加载、当前准入和用户结果分别证明。

| 来源票 | 责任 |
| --- | --- |
| [HOST-01 · 健康验证内核](HOST-01-patch-health-verifier.md) | Rust/Oxc 静态识别与健康链集成；新架构 W3 插入建议，复用 HCR/T44/OBS 与原 controller |
| [HCR-01](HCR-01-profile-and-witness-diagnostics.md) | 配方/见证诊断与共同拒绝原因 |
| [HCR-02](HCR-02-loaded-capabilities.md) | 实际 wrapper/reader 能力与回执 |
| [HCR-03](HCR-03-operation-recovery.md) | 原操作元数据、失主锁与中断对账 |
| [HCR-04](HCR-04-capability-profile-upgrade.md) | 同源基线绑定的局部配方升级 |

## 未排期扩展与历史范围入口

[Roadmap](../roadmap/README.md)拥有晋升条件。以下票保留独立范围，不因此成为每次修复或发布的默认前置。

| 来源票 | 范围 |
| --- | --- |
| [T30](T30-runtime-pi-backend.md) / [T31](T31-runtime-cursor-backend.md) / [T16](T16-model-backend-adapters-pi-cursor.md) | Pi RPC / Cursor backend 的独立资格 |
| [T13](T13-status-honesty-after-adopt.md) | 原状态产品范围；执行差额由 T27/T33 拥有 |
| [T14](T14-managed-context-compact-on-model-switch.md) / [T14b](T14b-host-reuse-compact-on-confirmed-overflow.md) | 原上下文/溢出问题；现行合同见 Context 与 T32/T35 |

## 历史交付票

这些文件是原交付范围和证据入口，状态保持原时间/版本意义。POC 的内部 API/wire、旧模型/Bot/权限或审查编排不是当前施工合同；演变理由见 [Archive](../archive/README.md)。历史测试对象使用合成标识，新的现场对象和权限只能从实际窗口取得。

| 来源票 | 历史范围 |
| --- | --- |
| [T1](T1-host-provenance.md) / [T2](T2-land-step-seam.md) / [T3](T3-live-g1.md) | Provenance、初始 STEP seam 与 G1 窗口 |
| [T4](T4-m3-as1.md) / [T4b](T4b-ai-sdk-openai.md) | A+S1 与初始 AI SDK 路径 |
| [T4c](T4c-modeld-openai-admit.md) / [T4d](T4d-route-openai-admit.md) / [T4e](T4e-route-session-modelid.md) | composite/route admission 与 modelId 接线 |
| [T5](T5-s2-c1.md) / [T5a](T5a-c1-credentials.md) / [T5b](T5b-s2-streaming-ipc.md) | credentials 与初始 IPC framing |
| [T6](T6-runtime-start.md) / [T7](T7-wait-official-replacement.md) | 初始 start facade 与官方 replacement 证明 |
| [T8](T8-sub2api-live-smoke-recipe.md) / [T9](T9-live-sub2api-smoke.md) | 原 provider recipe 与固定 smoke 窗口 |
| [T10](T10-per-bot-official-passthrough.md) / [T11](T11-pre-dispatch-passthrough-visible-errors.md) / [T12](T12-adopt-preserves-official-capabilities.md) | 原 passthrough、可见错误与官方能力保护 |

查历史可以读取原票和固定报告，普通任务不必顺序通读。归档不关闭未完成义务，也不重新派发已经关闭的旧问题。
