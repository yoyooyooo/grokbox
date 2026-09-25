# T44 — 持续来源感知与共用 incident 接线

## Status / Goal

**Partial implementation / scoped source-change episodes；2026-09-25。** [Spec §4](../roadmap/template-ops-automation-spec.md#chain)。将HSO/source/loaded/component健康作为OBS intake来源；不再以“不可安全自修”作为进入告警的硬条件。

## 当前切片

`monitor.runtime.ts`已将远端采样、本地journal drain、周期维护分成同一Effect生命周期的三个有界子任务，网络不持本地writer许可；DB提交/发布串行，取消等待各任务结算后才finish collector。once仍合并为一次输出；持续drain逐批发布不累积无限结果数组。`monitor-scheduling-review.test.ts`加入挂起RPC时本地原生失败仍ready、随后source收到取消的实测反例，并保留6000条积压不加速ownership读的原有测试。

canonical runRoot/目标集合及daemon所属collector已接通，原生run-observer同帧健康进入周期检测；读取文件成功仍不代表producer存活。Host与control journal独立游标/状态，未创建来源、失联、截断和实际退役分开。配置移除/停用/改目标时先结算旧collector才替换，坏配置不复活默认采集。HSO其他来源、动态目标、Box开机安装和完整原生现场仍未闭合，不把daemon子任务或手工重启当boot资格。[限定回执](../reports/2026-09-18-observation-storage-followup.md)。

必要存储维护另已接入实际modeld listener的子Scope，不再仅依赖本collector；其固定回执、闲置日志回收和真实Node/退出证明归[OBS-04](OBS-04-bounded-observation-storage.md)与[回执](../reports/2026-09-18-modeld-storage-lifetime.md)。这不是把modeld变成新collector，也没有因此完成目标集合、原生告警或通知投递。

`runtime monitor install`仍仅经明确确认初始化观测库并提交统一`daemon.observation`配置，不启动服务。新架构下，已运行的管理 Server 按该配置持有原 collector 的 Scope；旧 daemon 接线和 `runtime monitor service` 已退出，状态由 `system service get server` 读取。当前 Node 管理集成验证启动、竞争、关闭取消和恢复，见 [CLI-05](CLI-05-implementation-follow-through.md)。原 daemon 窗口的 CLI 退出后采集、强杀恢复及无晚写证据保留在[固定回执](../reports/2026-09-19-pre-e2e-observation.md)，不迁为新版现场通过。

## HOST-01 新架构接入（2026-09-20）

`host-health.runtime.ts` 已由管理Server Scope持有：安装根单producer互斥、目录dirty＋周期hash backstop、来源和重分析分道、固定artifact/checker身份缓存、换代后拒绝迟到结果。无Bot列表仍能进行安装级来源观察；公开fixture显式声明测试来源，其他领域隔离测试不读取机器真实Host。停止取消并结算所属Rust子进程和provenance写入，不关闭合法modeld执行。

原provenance先留存有界receipt，原OBS事务后索引；新receipt发布会清除前一receipt的intake成功标志，防止“新结果已展示但尚未入库”被报为committed。进程重启补入已留存未索引项，同一个condition和通知准备不重复。磁盘源和worker重哈希复核；同size/同毫秒mtime的变化不能凭stat继续用旧证据。当前loaded/attachment/exercised明确未证，通知coverage为local-only。

生产管理/恢复证明由 `test/host-health-management.test.ts`，真实子进程协议/退出证明由 `test/host-verifier.test.ts` 与 `test/host-verifier-boundaries.test.ts` 承载；实际来源静态资格用 `scripts/qualify-host-health.ts` 明确指定文件。完整运行见证和实际安装常驻仍是后续，不以首次静态纵切关闭本票。

## 运行编译来源增量

管理 Server 已独立读取原 preload-marker 的严格正负编译观察，核对真实 PID/start/UID/exe/argv；磁盘静态结果、运行代结果和两路 OBS intake 分别显示。原 marker 回滚、进程退出、缺 marker 不修复失败；恢复需要准确较新编译正证据。运行事件复用 provenance 和 OBS，停 Server 不 signal Host。固定测试与范围见[编译健康报告](../reports/2026-09-20-host-compilation-health.md)，完整 attachment/exercised 及实际来源适配仍由 HOST-01 承接。

## 同代注册见证接线

管理Server已从原getHostStatus的只读challenge采样原preload注册引用和有限实际边界，独立于Bot/ownership采样。实际handle/method替换与检测器读取故障分别入原OBS；读心跳不追加持久事件，缺证不消除注册失配。前后准确marker/进程核对覆盖负回复，停用/关闭结算实际请求，不signal Host。注册引用与真正调用机会分开，未触发不判bypass；固定实现和验证见[同代见证报告](../reports/2026-09-20-host-capability-witness.md)。

<a id="source-change-events"></a>
## Host 更新分级与可消费证据（AH-188）

继续由原 `host-health.runtime.ts` 采样、原 provenance 先留存、原 OBS 事务索引；没有第二个 watcher、事件库或修复器。`HostHealthEvidence.sourceChange` 的正式类型由 [host-source-change.ts](../../packages/runtime-kernel/src/host-source-change.ts) 定义，经原 `host-health` 导出。旧证据缺该字段时不补造分类。

| classification | 可证明的范围 | 消费方式 |
| --- | --- | --- |
| `no-intersection` | 前后实际 recipe 窗口和整 worker 未变，覆盖一致且固定证据可用；覆盖外 Host 字节可以不同 | 留证、零新分析唤醒；独立的准确正证据仍可解除原健康条件 |
| `related-same-shape` | 窗口或 worker 已变，实际 recipe 仍适用 | 必须产生分析 occurrence，不宣称 JavaScript 逻辑等价 |
| `structural-change` | 实际 recipe 失配，或已有静态负证据 | 新风险/分析 occurrence；不把不同 SHA 本身解释为逻辑损坏 |
| `unknown` | 无基线、覆盖变化、不完整输入、证据缺失或保全容量不足 | 明确保留待判断任务，不静默伪装安全或恢复 |

事件 `version=1`，包含 `episodeId`、有限 `reason`、`before/after`、`changedSlices`、`running`、`userImpact=not-established`、`executionAuthority=false`。每个 `HostSourceWindow` 固定 sourceSet/sourceSha/workerSha/profileDigest/recipeSha、recipeState、`coverage=recipe-windows-and-worker`、实际 slice 哈希与私有 `evidenceRef`。这不是全部未来 checker 的覆盖；原 `sourceEvolution` 仍表达完整维护配方和有限 ABI/静态检查，不能与所选 profile 的观察范围混称。

候选身份/分析结果继续在父事件，运行代仅来自独立 compilation 观察；`running=null` 不表示新磁盘已运行。episode 由安装身份与原 producer 序列固定：同一次重试/重启不换 ID，A→B→A 是新的观察 episode；迟到静态完成沿原 episode 以 `sourceState=snapshot` 留存，不能派工或恢复当前条件。原 OBS 的任务键包含安装、episode、classification，以 `category=occurrence/status=recorded` 进入原证据/outbox；原 `category=condition` 仍保存故障与准确恢复，但不再代替每次更新的分析任务。风险升级有独立 occurrence，旧 open incident、ack 或旧任务不吞掉新相关来源。

私有材料仍归 provenance：`host-bundles/source-evidence/<evidenceRef>.json` 内容寻址、0700/0600、原子发布，保存压缩的固定 Host 来源、实际窗口/配方和 worker。`readHostSourceEvidence(root, ref)` 核对摘要与范围，`hostSourceEvidenceBytes` 解压原来源；只读精确引用，不以当前磁盘替代丢失材料。公开事件/CLI/Web/通知不带源码、私有路径或 worker 正文。

附件最多 68 份、单份 8 MiB、合计 64 MiB；原 receipt journal 仍按 64 项和 1 MiB 双界滚动，仅退役已索引旧项。GC 同时保护 journal 前后两侧、活动/排队分析及原 outbox 固定 revision 引用；先筛选有效工作/证据租约再应用 200 项上界，过期历史不永久阻断清理。活动引用不可读或上界不能证明完整时不删材料，容量不足留下 `unknown`。已提交观察先入 OBS，清理错误或缺 pin 不阻断 intake；不变来源也重试延期清理。附件暂时失败只对匹配全部不可变窗口的当前 AFTER 重取并产生新观察，同 episode 的旧缺失记录不改，历史 BEFORE 不被最新来源冒名替代。这是有限保全，不保证永久全局 exactly-once，也不新建 pin/通知数据库。

`startHostHealth` 提供动态 `observationEnabled` 端口：只读观察不再由 `runtime.desiredMode` 控制，明确停止观察才撤销采样、分析和所属 gate；配置读取失败为 `observation-config-unavailable`，不回退启用。AH-143 拥有公共 `ops.observation.enabled` schema/配置入口、`server.ts` 回调接线以及通知/接收者/outbox；双方已在同候选验证实际配置开/关/读取失败及取消，没有另写配置。该观察许可不授予自动采用、修复、Bot 唤醒或外发权限。

定向入口为 `test/host-source-change.test.ts`（已进入原 core 清单）及 `test/host-health-management.test.ts`。前者涵盖分级、浏览器公共合同、固定私有输入与失败/容量/GC；后者使用实际 Node Server、packed Rust、原 provenance/OBS 和自有 JS 来源，覆盖连续任务、风险升级、旧故障恢复、重启、迟到结果和开关独立性。它们不代签真实官方来源、用户接收者或部署；现场仅登记原 [LIVE](LIVE-integration-validation.md) 观察/证据/隐私/容量场景。

**联合候选已通过本阶段组合检查与必要分段复核。** 公共观察配置与 producer 在同一候选生效，普通与 packed 领域 fixture 分别显式隔离；原 handover 20 项保持原断言/超时通过，先前 `handover_wait:0` 失败保留。新增真实公开来源 producer → OBS/outbox → 自有 HTTP 维护接收端 → 认领/结果回执纵切通过，无关更新零额外投递，相关同形和结构变化分别生成任务。复核提出的保全/清理与恢复队首问题已在原边界修正并复查接受；早期审查超时未计通过。准确提交、测试和原生/现场限制见[联合集成回执](../reports/2026-09-25-host-notification-integration.md)，实际合流由原两票记录，不因此切换现场或签全部用户通知完成。

## Depends-on / Modules

新架构的完整静态识别、Rust/Oxc sidecar 与能力合同由 [HOST-01](HOST-01-patch-health-verifier.md)承接；本票继续拥有管理 Server 所属的来源/loaded/检测器健康 producer 和共用 OBS 接线。源码不适用、加载负回执等确定故障可以先入库，不等待全部 AST 检查完成；但一个已接通的故障例子不代表完整能力覆盖已经交付。插入时点由 [CLI-05](CLI-05-implementation-follow-through.md#下一实施边界)协调，不恢复旧 daemon 或旁路 heal writer。

依OBS-00/01、T51配置合同；不依赖Webhook、诊断或维护。复用HSO `ops/host-seam/watch.ts`、T41 `roots/monitor.runtime.ts`及原provenance；CONT-01归属判定独立，只共用源接口/出口。

## Work

事件dirty＋周期backstop＋启动/换代重同步；区分advertised/staged/installed/loaded，固定来源/receipt而非猜最新SHA。原生读取、journal drain、健康检测和GC有界子Scope，慢上游不阻塞本地失败。runRoot从受信安装清单接线，不能仅依赖交互shell临时环境。

按OBS-01通用规则提交：有影响的源契约/加载失配、组件不可用和未知异常进入incident；无影响更新本地留存。记录未覆盖对象、source schema漂移和observer不可用；恢复要正证据，旧代缓存不当当前健康。

跨provenance与SQLite使用稳定receipt引用、幂等索引和缺口恢复，不宣称跨库事务。采样不启动Provider/canary、发signal或调用官方更新RPC。源范围/游标/retention与OBS-04协调，缺monitor不能阻塞原生推理/撤权门。

## Executable acceptance

已落地的Host健康集成使用上述实际测试入口；其余来源继续按实际实现增加场景，并回归`packages/box-runtime/test/monitor-scheduling-review.test.ts`、`monitor-source-lifecycle.test.ts`。验证无变化零Bot唤醒/零模型/零Host mutation；变化一次入库、scope切换不伪造迁移、慢RPC不拖日志、断源有gap、重启不重播已处理工作。

真实常驻是T50安装出口，不以一个run调用或GET绿色签署。实际窗口只看[LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)与[LIVE-OPS-OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)。

## Forbidden / Non-goals / Exit

不另造HSO报警库/controller，不定期LLM扫描，不从旧计划推导权限，不把采集失联当官方接管。交付source→OBS-01接线表和离线故障/周期证明；事件投递另归T45，长期资源治理归OBS-04。
