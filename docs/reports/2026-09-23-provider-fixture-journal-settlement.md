# Provider fixture 的日志结算窗口

本窗口基于 V2 `f4839dde348c28039de240a5574ea6a5bd1b7c04`，处理 AH-157 / Q 回归中 `tool-evidence-retention` 的测试同步问题。仅修改公开测试及验证入口，不修改生产日志读取、模型执行、Host 配方或消息投影。

## 已证实的缺口

`waitFixtureRows` 原来看到同一 STEP 的 `host_normalized_terminal` 和 `model_step_terminal` 文本就返回。`appendNdjsonLine` 的字节可见早于其 fsync、分段索引及健康发布结算，因此“终态文本已出现”不是“测试日志已静止”的证明。

新增确定性反例使用自有临时根、原 `appendNdjsonLine` / `withEventsLock` 和健康计数：先写两条合成终态，再用锁阻住同根的另一次原写入。旧等待函数在 pending=1 时已经返回，测试结果为 0 pass / 1 fail。这里的合成记录只用于测试等待契约，不冒充实际 Host 终态或原生执行证据。

修正为终态出现后调用现有 `settleJournalWrites(runRoot)`，等待已经发起的原写入结算，再读取一次快照。受控反例在锁释放前不会返回，释放后读到后续记录且 pending=0。没有轮询生产读面直到 present，也没有允许 partial 冒充完整结果。

该 helper 仅用于没有继续提交下一 STEP 的独占测试根；它不是对仍在运行的任意生产者建立全局快照屏障。原 reader 对并发变化、截断和缺证的判定保持不变。

## 固定验证

- 修复前的新增受控反例：0 pass / 1 fail；修复后与 journal/tool 相关四文件：33 pass / 0 fail。
- 正式 `bun scripts/verify-modeld-core.mjs tool-contract` 已纳入新反例：194 pass / 0 fail，17 文件；正式构建通过。使用仓库声明 Bun 1.3.14。
- 验证入口路由及原 settlement 两文件：9 pass / 0 fail。不同运行窗口的计数不相加。
- 原证据断言保持 `read.state === present`，失败输出保留 coverage/retention/window；未删历史工具身份、错误层次或禁止重发的断言。

历史一次 partial 的具体时刻/触发字段没有完整保存，本报告不声称已经逐字节重放该历史运行，也不把测试同步缺口说成生产数据丢失。它给出了可执行的等待契约反例及其修复；原生消息 type=text、writer/metadata 与账号/App 资格仍由 AH-157 的独立工作包负责，不由本窗口代签。

精确源码/测试/lock 输入摘要、提交和合流 SHA 由本窗口的 Linear 回执记录。未请求真实 Provider、操作用户 Bot、发布 profile 或切换现役服务。
