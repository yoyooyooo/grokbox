# CONT-02 — 分档保护与有来源的恢复材料

**状态：Partial implementation。真实私有vault、manifest/字节发布、引用保护与回收及J1 owner接线已有；原生capture、四档配置和自动安全点保全尚未完成。**

合同：[S13材料与档位](../roadmap/box-runtime-impl-spec.md#continuity-material)。依赖CONT-00/11和CTX-02原生提交边界，可与CONT-01/06并行。

## 已实现切片与边界

`openContinuityRecoveryStore`通过生产Effect程序维护CONT私有`continuity/state.sqlite`、content-addressed对象和staging；recovery/safety共用该管理DB，不受OBS诊断TTL支配。显式初始化、完整声明图/hash验证、先reservation后发布、unknown读回、引用与GC共同事务、先退役metadata后unlink、最近两份及最后可靠原生点保护已实现。GET无写入，不安装新timer或自动捕获真实Bot。

实际入口、114项组合证明和未证项见[固定报告](../reports/2026-09-18-continuity-recovery-store.md)。新增验证入口`node scripts/verify-runtime-rebuild.mjs continuity-store`使用声明的Bun/Node。材料是synthetic opaque bytes；`nativeImportProven=false`，声明依赖闭包不证明原生隐含引用/格式已齐。真实capture与导入、Memory范围/附件映射、canonical保护策略消费、持续owner安装和全安装物理预算仍需后续实现，不把该存储切片标为整票Done。

## 目标与模块

平时增量保全、不常驻另一个活Bot；接管时固定最后可靠点与可读增量，不靠日志猜RAM。kernel continuity定义manifest/质量，Host adapter仅作明确无修复读取，`io/continuity-store.node.ts`协调私有vault和管理引用，不成为活会话writer。

档位为observe、memory、resume（新保护默认）、archive，另有off。级别增加材料覆盖，不扩大自动操作权限；resume必须保存root必要的完整依赖，archive不是整盒备份或多会话。

**后续接线切片：** [CONT-07当前状态协调](CONT-07-current-context-control.md)已通过有限原生read port把捕获接到本存储，验证预算、原始root字节、前后revision和复制后的不可变材料；重复请求返回原快照，不再次读源。所用原生端仍是owned合成协议，未接官方decoder、自动安全点或四档生产配置，不能将其称为真实Bot capture已经完成。[限定证明](../reports/2026-09-18-continuity-current-state.md)。

## 材料与恢复质量

具体原生引用捕获已在`host/native-checkpoint.ts`实现并接到CONT协调/存储：完整遍历限定schema的引用，包含原生GC省略的历史root/摘要归档，处理嵌套map与循环；字节/编码/依赖不合法拒绝native候选，不静默丢边。当前已用原生Host/worker对及新Node进程取得[限定证明](../reports/2026-09-18-continuity-native-checkpoint.md)。后续已接入原生worker同连接串行事务和读取前长度预算，正式profile/RPC手动捕获入口见[当前操作指南](../maintainers/current-state-control.md)。主Host与worker的实际安装、真实Bot采集仍须LIVE；全Memory/展示历史/附件采集与四档自动触发仍是本票实现工作，native引用图通过不等于整Bot材料齐备。

root槽位ID可不变而字节变化，compact rootRevision也不是完整Bot版本。快照记录实际root/闭包hash、Host/schema、Memory分层版本、转录和关系水位、model/effort/配置、必要资源与未决动作。原生最近提交、最后完整保全、各职责安全续接点分开；保存pending/partial不等于允许重放。

best-effort默认优先native_checkpoint，必要时按授权预算使用semantic_resume，最少材料可形成memory_only且只开放可明确负责的工作。未知工具结果不编造。重建固定输入、角色/因果去重、摘要与近期合法窗口/未决清单；生成结果保存一次，重启不重新摘要旧材料。

agent Memory按计划复制/合并；共享user/project保留来源、不新增重复全局事实。旧Bot的Temporal增量与最后Box状态分别标来源。源删除前核验目标不依赖旧目录/附件/blob；普通日志和脱敏incident不是完整恢复材料。

## 发布、保留与验收

先验证内容再发布manifest；跨文件/DB使用明确恢复协议，不声称一笔事务。至少最近两份完整版本与有界增量，交接pin受配额限制，GC保留有效引用；磁盘不足保留最后可靠点并降级报告，不影响原生正常checkpoint。复用OBS总容量/普通日志策略，安全台账不被日志轮转删掉。

实现时新增fixture/独立进程测试：固定ID不同内容、闭包缺失、并发root变化、错误schema/metadata、跨材料水位、重复历史/tool配对、摘要不重复生成、symlink/路径边界、空间不足、发布前后崩溃及GC。真实Bot保护档位、材料水位和重启读回在[LIVE-CONTINUITY-MATERIAL](LIVE-integration-validation.md#live-continuity-material)。

## 非目标

不在观察时修复源或上传状态，不复制活动网络/工具权限，不用memory_only冒充精确旧窗口，不建立第二在线context store或跨机器同步。无完整包是可见质量缺口，不用假成功掩盖，也不必阻止无冲突的其他职责。
