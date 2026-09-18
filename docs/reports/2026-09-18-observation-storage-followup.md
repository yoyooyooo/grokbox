# 故障证据、SQLite容量与采集调度增量 · 2026-09-18

本报告保存`b9b7277`规划之后的第二段实施范围，不维护当前live状态。第一段见[首片回执](2026-09-18-observation-evidence-first-slice.md)，合同归[Template Ops Spec](../roadmap/template-ops-automation-spec.md)，当前现场仅归[LIVE索引](../tickets/LIVE-integration-validation.md)。本次是未合入工作树的离线切片，不是现役采用或独立review结论。

## 实际改动与边界

| 对象 | 已实现 | 未因此证明 |
|---|---|---|
| incident修订 | 最多3份可读修订，活跃通知/lease保护；没有可回收项则拒绝capture；持久revision水位防止回收后复用ID | 所有原生工具/checkpoint边界已接线 |
| 证据租约 | 同revision共享一个保护槽，累计期限与安装活动槽数量有界，回拨不续期；普通GET不写 | 操作系统级隔离、跨Bot私有数据授权 |
| SQLite文件 | 每writer应用max_page_count，默认128MiB；新诊断写入预留元数据余量，压力批次原子提交cursor与gap/丢弃计数 | 整安装512MiB总预算已生效；rollback journal/备份/其他owner也被该页数限制 |
| 保留 | 过期明细/修订、终态且可对账通知、孤儿history水位按不同条件清理；unknown投递不按年龄变成未执行 | 全部management/source/执行安全状态已安全退役 |
| storage status | 只读返回主文件/页/空闲页/辅助文件、增长策略与压力计数；scope=monitor_database_only，installationBudgetEnforced=false | 全盘占用或操作系统底层安全擦除 |
| collector | 同Effect生命周期中远端采样、本地drain、维护分离，短事务/发布串行；积压不加速Server RPC，取消后各任务退出 | 自启安装、全部来源注册/真实心跳、原生Bot推送 |
| 历史事件 | 能查询历史失败，但超过通知新鲜窗口不把它当新Bot唤醒 | 自动回补历史告警或自动Issue |
| 发布检查 | 显式include-untracked检查未纳入Git索引的新增源文件，不改index、不回显敏感匹配值 | 已执行Git提交、全历史扫描或公开发布 |

没有修改Host执行叶、执行去重/上下文账本、Server归属、模型选择和原生数据。SQLite护栏不是累计事件寿命限额；真实安全账本失败的严格处理保持原owner语义。

## 可复用的验证入口

固定项目Bun 1.3.14和frozen lock后：

```bash
bun scripts/verify-runtime-rebuild.mjs observation-evidence
```

该组运行类型/构建、真实SQLite/文件/打包Node CLI、迁移与崩溃、边界检查和含untracked的隐私扫描。notProven显式包含完整原生观察、整安装容量、日志轮转、执行状态退役、Webhook/配对、持久服务、独立review和live采用。只写所运行子项的证据，不以组名替代T50/OBS-06全部验收。

新增/扩展测试：`observation-storage-pressure.test.ts`、`incident-evidence-store.test.ts`、`monitor-scheduling-review.test.ts`、`monitor-incident-cli.test.ts`、`publication-privacy.test.ts`。512KiB真实库连续接收120个独立失败时主文件始终不越限，压力丢弃计数/游标可见且重试不加倍；分步推进32个TTL维护周期后，不重启就可以接收新的故障。这个测试不等于32天真实生产负载或全安装稳态。

挂起RPC测试证明本地failed事件不等待10秒源超时，取消到达该源并正常释放collector。原有6000条积压/迟到本地事件测试继续证明不放大所有权读取次数。修订测试连续新增10个revision后只保留3个、原通知引用不变；全被保护时capture回滚，GET保持字节不变。

## 本轮回执

类型检查及14文件的集中回归：72 pass / 0 fail / 518断言。含未跟踪文件的只读发布扫描通过，未发现敏感匹配；Git diff whitespace检查通过。该集中回归包含实际Node命令读取测试，但不等于最终完整制品资格。

随后最终构建/指纹核对调用被工具安全检查拦截，没有结果；未换入口重试。新注册的observation-evidence验证组因此尚未完整运行，也没有本次最终全仓或preload固定指纹回执。第一段2285通过的数字、source digest和E09 pin均属于上一段源码，不能作为本增量成套制品的证明。当前代码未提交、未合入v2，尚无独立review；没有通过修改指纹文件绕过构建门。LIVE索引已记录相关实现/制品阻断。

文档同步后的独立只读检查通过：两个验证脚本的node --check、含untracked的923文件隐私扫描（零命中）、git diff --check。脚本语法通过不代表其构建/测试子进程已经运行；这些检查未重试被拦截的构建，也未变更Git索引、分支或现役服务。

### 后续固定候选复验

继续实施时重新执行完整 `bun scripts/verify-runtime-rebuild.mjs observation-evidence`：类型检查、实际构建、两组64项测试（39+25，0失败）、import边界、含untracked隐私扫描均通过，verification source前后均为`003282516690de7062177d6a25a7ee391e6f3eff3036da4c77c81b9c8b6e4bac`。构建源码摘要`a988959992f0febdb3d99ae4b83135aceb7e1664900b934280bfbbeddf29cd45`，实际preload SHA-256为`1fe1e2c2c176e2d071d242a43183bd7319d97027446175cebeba33a191deb42c`，更新E09 pin后仍须执行其拒旧制品测试。这次成功不抹除前次工具阻断记录，不沿用旧全仓数字，也不构成独立review/live证明。

## 剩余施工与采用条件

OBS-00/01/02/03仍有完整原生边界、跨来源/异步prepare/授权方面的剩余范围；OBS-04尚缺跨owner配置和整安装容量、进程长期fd/journal分段、Jobs/备份/Trash及常驻维护；OBS-05未改执行安全退役。T43/T53/T54/T45/T46的原生接口资格、配对和实际投递没有被本次SQLite测试替代；T51新配置仍未实现。T47自主运维及T48/T49仍按各自合同推进，T52/T56保持延期。

未运行真实Webhook、模型请求、Bot/Routine创建、公开Issue或市场发布；未切换live或重启modeld。现役采用须先完成相关实现/review、进入固定v2集成候选，再按LIVE窗口证明，不从未合入的切片改全局shim。
