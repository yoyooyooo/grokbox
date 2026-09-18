# 2026-09-18 — 原生 Bot 自主运维、默认提醒与有界证据

**状态：接受；本轮仅Spec/Ticket，不是已实现、已启用或真实操作授权。** 详细合同唯一归[Template Ops Spec](../roadmap/template-ops-automation-spec.md)，新证据/存储切片为[OBS-00–06](../tickets/README.md#incident-evidence)。

## 目标

让用户通过Grok Bot本身完成grokbox使用、Bot运维、模型管理和排障。原生Bot理解用户目标并自主编排；grokbox提供可信工具、证据、动作与验收回执，不重建Agent loop、原生scheduler或第二Host控制器。

## 本轮取舍

1. 当前主链收为持续发现→固定关键现场→通知配置目标Bot，带incident/所需执行ID及真实可用JSON取证命令。默认Bot只提醒并结束，不自动执行命令、分析、询问Issue或催促用户。
2. “只提醒”仅限默认告警回合。用户委托或独立预授权后，Bot可自主取证、选择工具、执行范围内操作并核验；正常只读步骤不重复询问，新增花费/中断/数据去向/公开须另行决定。
3. 自动Issue退出本阶段；T52/T56延期。将来用户主动决定公开时只复用可用gh认证，无gh/认证/权限就本地保留并跳过，不自动登录、不提取token、不换身份、不建设官方接收服务，不追补历史积压。
4. JSON可生成不是观测完备。先补独立未知tray、队列failed、无STEP与未收束检测；按E01–08定义最低证据，缺口与副作用边界必须可见。分类器可升级，不改写源事实；不以LLM推测补齐身份。
5. 先保全现场后发提醒。用户稍后读取相同revision；轮转后明确summary-only/expired，不空成功。命令由可信registry生成，不让payload指定任意shell/URL/root。
6. 源头只收必要结构。local、bot-notice、bot-diagnostic、public视图分开；精确ID仅在取证所需且已配对范围内，公共材料用报告内一致别名。默认无对话/Memory/工具正文/凭据，不先发Bot再脱敏。
7. 全链路观测不等于永久全量历史。普通日志轮转、观测DB/事故分层GC、执行安全状态协议退役、制品/备份按引用清理。诊断全安装共用容量预算；ack/open/pin不无限保留明细，GC不删除执行权限/去重/未知提交事实来制造空间。
8. 复用原T41 SQLite、T40服务宿主、统一ConfigurationWrite、原controller与models owners。CONT的接管通知接入同一出口，恢复快照仍由S13维护，不拿诊断JSON冒充原生resume材料。

## 被替代的口径与保留的约束

9月16–17日的默认“确认用户影响且不能自修→询问是否整理Issue”、内置REST publisher和有限自动发布grant不再作为当前施工范围。其独立授权、去重、未知结果对账、模板隔离、原生资格、唯一controller和安全排空原则继续有效；实现细节只在当前Spec维护，不让历史ADR拥有第二份默认值。

当前源config3中的support字段仍是实现事实，目标由T51作显式迁移退役；文档变更不伪称解析器已改变。CLI/schema/安装/原生能力与当前部署分开验收；需LIVE的项目只登记[唯一索引](../tickets/LIVE-integration-validation.md)。

## 本轮交付边界

新worktree从v2 `8139339`建立。仅调整合同、票据和文档路由；不修改源实现、生产配置、模板recipe或安装Skill，不创建Bot/Routine、不调用真实模型、不发送通知、不查gh认证、不重启/切换Host/modeld、不清理现役数据、不创建Issue或发布模板。
