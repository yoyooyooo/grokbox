# CONT-02 — 分档保护与有来源的恢复材料

**状态：planned；复用S12捕获/codec，恢复vault和完整快照仍需实现。**

合同：[S13材料与档位](../roadmap/box-runtime-impl-spec.md#continuity-material)。依赖CONT-00/11和CTX-02原生提交边界，可与CONT-01/06并行。

## 目标与模块

平时增量保全、不常驻另一个活Bot；接管时固定最后可靠点与可读增量，不靠日志猜RAM。kernel continuity定义manifest/质量，Host adapter仅作明确无修复读取，`io/continuity-store.node.ts`协调私有vault和管理引用，不成为活会话writer。

档位为observe、memory、resume（新保护默认）、archive，另有off。级别增加材料覆盖，不扩大自动操作权限；resume必须保存root必要的完整依赖，archive不是整盒备份或多会话。

## 材料与恢复质量

root槽位ID可不变而字节变化，compact rootRevision也不是完整Bot版本。快照记录实际root/闭包hash、Host/schema、Memory分层版本、转录和关系水位、model/effort/配置、必要资源与未决动作。原生最近提交、最后完整保全、各职责安全续接点分开；保存pending/partial不等于允许重放。

best-effort默认优先native_checkpoint，必要时按授权预算使用semantic_resume，最少材料可形成memory_only且只开放可明确负责的工作。未知工具结果不编造。重建固定输入、角色/因果去重、摘要与近期合法窗口/未决清单；生成结果保存一次，重启不重新摘要旧材料。

agent Memory按计划复制/合并；共享user/project保留来源、不新增重复全局事实。旧Bot的Temporal增量与最后Box状态分别标来源。源删除前核验目标不依赖旧目录/附件/blob；普通日志和脱敏incident不是完整恢复材料。

## 发布、保留与验收

先验证内容再发布manifest；跨文件/DB使用明确恢复协议，不声称一笔事务。至少最近两份完整版本与有界增量，交接pin受配额限制，GC保留有效引用；磁盘不足保留最后可靠点并降级报告，不影响原生正常checkpoint。复用OBS总容量/普通日志策略，安全台账不被日志轮转删掉。

实现时新增fixture/独立进程测试：固定ID不同内容、闭包缺失、并发root变化、错误schema/metadata、跨材料水位、重复历史/tool配对、摘要不重复生成、symlink/路径边界、空间不足、发布前后崩溃及GC。真实Bot保护档位、材料水位和重启读回在[LIVE-CONTINUITY-MATERIAL](LIVE-integration-validation.md#live-continuity-material)。

## 非目标

不在观察时修复源或上传状态，不复制活动网络/工具权限，不用memory_only冒充精确旧窗口，不建立第二在线context store或跨机器同步。无完整包是可见质量缺口，不用假成功掩盖，也不必阻止无冲突的其他职责。
