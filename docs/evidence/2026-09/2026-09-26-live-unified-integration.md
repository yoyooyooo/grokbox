# 统一集成接收与正式候选准备

2026-09-26。AH-187 总控；领域结果归 AH-186/AH-192、AH-190/AH-193、AH-143。当前现场结论仍由 [LIVE](../../tickets/LIVE-integration-validation.md) 维护。本报告记录本候选准备期间的实际观察，不继承 POC 的加载、业务或更新成功。

<a id="candidate-preparation"></a>
## 接收、来源与运行状态

从干净 `abb9da9c7e61bf91803f01421ad5daa17e59b3c3` 接收。A/C 已停止源码与现场写入，无待回流提交或其新增的 live 尾巴；统一集成者使用自己的工作树并独占后续共享现场。此前 program-update POC 已恢复收场，不是当前等待条件。

初读官方版本为 `e805e59`；准备期间官方自行更新到 `75c8f81`。新 Host SHA 为 `37c4bb33ff6f722cf0b49030e337970e320e5bd75614833c9622e8b37b828105`，worker SHA 为 `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。当前源由原 `runtime profile observe --from` writer 完整保留，未执行 prune。没有覆盖旧来源、发布更新命令、加载补丁或停止官方 supervisor。

全局 CLI 仍指向较早固定制品，管理服务不可达，原 modeld owner 记录 stopped。旧 CLI 与新构建 CLI 的只读 operation-recovery 均记录 controller/identity 锁缺失、0 running、8 unknown；unknown 未被结清或重放。当前系统没有可用 systemd user manager，不能把前台验证寿命写成开机持久性通过。

## 首个 recipe 差额

新构建 CLI 的正式 profile 分析在 `alert-main-decision` 返回 `recipe_unapplicable / find-missing`。完整切片诊断还发现 automation 告警及 native checkpoint/current-state 区域需重新核对；没有跳过这些切片后宣称完整候选可采用。

本源码小包仅调整告警描述局部绑定的当前拼写，保持同一 recipe、唯一锚点、原 epoch 判定、原 Tray writer 和自动任务限流。独立合成告警夹具先复现拒绝，再验证有/无观察器、旧 epoch、清理和自动任务抑制语义不变。没有新增旧版本运行分支。

声明 Bun 1.3.14 下，告警切片与 Local-first 公共用例共 12 pass / 0 fail，告警事件链及观察器审查回归另有 17 pass / 0 fail；显式选择当前原生声明的 Local-first 隔离用例另有 1 pass / 0 fail、41 assertions。后者执行当前工厂/登记声明并使用合成外部 IO，验证单次 Box 字段、原 writer、Temporal 与丢回复分支；没有真实账号或模型效果，不是创建 canary。

## 当前 Host/worker 的有限配对验证

后续修复仍使用原 recipe/worker/current-state owner：边界锚点去掉不必要的生成编号，同时保持全局唯一匹配；原 checkpoint writer 现为 `async` 方法，其完整写入由原 current-state 屏障包住，未增加另一个 writer。原生 disposer 仅内部失败函数由 `fail` 改名为 `fail2`；原 LIFO、receiver、异常合并和同步 disposer 拒绝用例重验后，替换唯一当前原生 ABI 摘要，不添加历史回退。原生模型预览单独重新验证。

隔离夹具同步当前摘要管线的 `async` 声明，移除已不使用的 generator helper；transcript 尾页带入原新增窗口对齐、可见性函数和常量，保留原 SQL、关联、writer、分页和冷重开断言。未将其替换成总返回成功的 stub。

| 验证 | 实际结果与上限 |
| --- | --- |
| 原 `native-pair` | 40 pass / 0 fail；完整 63 切片、四项 Rust 语义检查及四项合法 JS 负例、原生声明/worker/SQLite/生命周期范围 |
| 原 `native-runtime` | 4/4 commands、88 个外层测试通过；原摘要提交、独立进程 checkpoint/模型切换、实际 modeld/SDK 对自有上游、管理/工具/compact 范围；内层 Node 数不再相加 |
| 当前接收模型预览 | 1 pass；不启动原生 session、不读认证、不把实验标记成已应用 |
| 公共受影响回归 | 78 pass / 1 显式 native skip / 0 fail；Rust lease-lifetime 另有 9 pass。该跳过用例在显式 `native-runtime` 中另行执行 |
| 类型与构建 | 声明 Bun 的根 TypeScript、CLI/Server/Web/原生 verifier 构建通过 |

配对的 Host/worker 字节均为上文所列来源，窗口结束仍 unchanged。各原生验证器继续返回 `qualified:false` / `passed-in-selected-scope`；没有执行完整 Host 或调用真实 Provider，不证明安装、加载、App 或费用。首轮缺失绑定、旧 helper 摘要和夹具依赖错误均保留。公共组合中的两个 lifecycle 夹具还暴露了未关闭安装级观察的问题；在其自有配置中显式关闭与用例无关的观察后，完整 source/owner 32 项通过，业务断言和 freshness 门未放宽。

## 尚未形成的现场结论

尚未安装或加载本阶段候选，真实静默哨兵未运行。盘点发现旧 adoption owner 虽为 complete，原资源 journal 仍为 `deactivate-term`；其 Host/监督者与原 attested archive 相符。旧 controller 的八条 unknown 保留，当前恢复入口只读检查未完成物理退出结算，不能手改 journal 或据此重放操作。

正式模型/DM/工具/compact、Memory/群/Routine/结算、通知用户出口与受控更新连续性均未由本阶段验收。下一步沿原恢复路径核对退出资源边界，固定正式候选，经原 controller 采用后先跑源头哨兵。session 钩子仍在官方模型解析/构造之后，独立于其前置条件的差额在正式模型业务前解决。费用继续 `billing not observed`。
