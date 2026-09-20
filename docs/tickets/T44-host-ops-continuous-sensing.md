# T44 — 持续来源感知与共用 incident 接线

## Status / Goal

**Partial implementation / local scheduling isolation；2026-09-18。** [Spec §4](../roadmap/template-ops-automation-spec.md#chain)。将HSO/source/loaded/component健康作为OBS intake来源；不再以“不可安全自修”作为进入告警的硬条件。

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
