# T44 — 持续来源感知与共用 incident 接线

## Status / Goal

**Partial implementation / local scheduling isolation；2026-09-18。** [Spec §4](../roadmap/template-ops-automation-spec.md#chain)。将HSO/source/loaded/component健康作为OBS intake来源；不再以“不可安全自修”作为进入告警的硬条件。

## 当前切片

`monitor.runtime.ts`已将远端采样、本地journal drain、周期维护分成同一Effect生命周期的三个有界子任务，网络不持本地writer许可；DB提交/发布串行，取消等待各任务结算后才finish collector。once仍合并为一次输出；持续drain逐批发布不累积无限结果数组。`monitor-scheduling-review.test.ts`加入挂起RPC时本地原生失败仍ready、随后source收到取消的实测反例，并保留6000条积压不加速ownership读的原有测试。

源adapter/HSO接线、canonical runRoot/目标集合、实际source-liveness、安装自启与原生Webhook尚未闭合，不把子任务拆分当完整常驻资格。[限定回执](../reports/2026-09-18-observation-storage-followup.md)。

## Depends-on / Modules

依OBS-00/01、T51配置合同；不依赖Webhook、诊断或维护。复用HSO `ops/host-seam/watch.ts`、T41 `roots/monitor.runtime.ts`及原provenance；CONT-01归属判定独立，只共用源接口/出口。

## Work

事件dirty＋周期backstop＋启动/换代重同步；区分advertised/staged/installed/loaded，固定来源/receipt而非猜最新SHA。原生读取、journal drain、健康检测和GC有界子Scope，慢上游不阻塞本地失败。runRoot从受信安装清单接线，不能仅依赖交互shell临时环境。

按OBS-01通用规则提交：有影响的源契约/加载失配、组件不可用和未知异常进入incident；无影响更新本地留存。记录未覆盖对象、source schema漂移和observer不可用；恢复要正证据，旧代缓存不当当前健康。

跨provenance与SQLite使用稳定receipt引用、幂等索引和缺口恢复，不宣称跨库事务。采样不启动Provider/canary、发signal或调用官方更新RPC。源范围/游标/retention与OBS-04协调，缺monitor不能阻塞原生推理/撤权门。

## Executable acceptance

待新增`packages/box-runtime/test/ops-sensing.test.ts`，并回归`packages/box-runtime/test/monitor-scheduling-review.test.ts`、`monitor-source-lifecycle.test.ts`。验证无变化零Bot唤醒/零模型/零Host mutation；变化一次入库、scope切换不伪造迁移、慢RPC不拖日志、断源有gap、重启不重播已处理工作。

真实常驻是T50安装出口，不以一个run调用或GET绿色签署。实际窗口只看[LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)与[LIVE-OPS-OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)。

## Forbidden / Non-goals / Exit

不另造HSO报警库/controller，不定期LLM扫描，不从旧计划推导权限，不把采集失联当官方接管。交付source→OBS-01接线表和离线故障/周期证明；事件投递另归T45，长期资源治理归OBS-04。
