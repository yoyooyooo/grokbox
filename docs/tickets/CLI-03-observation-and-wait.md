# CLI-03 · 读取实时状态并等待可证明的条件

状态：持久观察、全局检索及后台异常跟踪方向已接受，精确事件/等待/检索合同待细化。依赖：[CLI-01](CLI-01-discovery-and-targeting.md) 的引用与读输出；operation 等待依赖 [CLI-02](CLI-02-operation-contract.md)。完成合同不代表实现交付，跨域实施由 CLI-05 的 W3 承接；本票以下区分已经接通的用例与仍未闭合的合同。

## 用户结果

Agent 或未来页面先读取 Bot 快照，再接续变化；断线后能识别缺口。它可以等待一次真实提交的回执，但不会把 Bot 待命、最后一条回复或 elapsed time 当作完整任务成功。

## 方案范围

收口[决策 D07、D09](../roadmap/agent-first-cli/decisions.md)。覆盖 Bot activity、message/run/operation/job 等待、持久观察快照/事件、Memory/Project 跨授权来源检索、管理异常和有界日志。采集与异常跟踪由常驻管理服务承担；模型执行仍归独立 modeld。数据依据见[固定研究记录](../reports/2026-09-19-webui-source-feasibility.md)。

## 验收产物

- 区分执行状态、活动描述、来源健康与数据年龄；缺 currentActivity 不等于 idle。
- 每个 until 枚举绑定可证明的对象与事件；未支持的精确关联直接声明缺失。
- 统一快照/cursor/filter/generation/gap 语义；原生缺 replay 不伪造历史。
- 断连、重连、乱序/重复、旧代事件、慢消费者、截断和缺源有有限输出与恢复动作。
- 普通 get 不启动采集或修复；显式 refresh 只接受有预算的观察请求；关页面不结束后台工作。
- Memory 的 agent/user/project、Temporal 同步延迟、正文权限和 Project fileRef 在统一读面中有位置；检索结果能定位原来源并披露索引年龄与缺失范围。
- 状态快照、变化与必要证据持久保存；派生索引可重建，但已采集的历史和不可重建回执不能一律当作缓存；保留细节待定。
- 管理异常发生/变化/恢复与 ack/snooze、通知 attempt 分开；后台规则有事实依据，恢复不是人为改成绿色。
- Memory/Project/文件写能力范围已接受；本票只定义检索与观察合同，逐源写入、并发与结果由 CLI-02/CLI-04 收口。
- 待命与 unknown/stale 各有呈现规则；低频归属采样不标成逐毫秒实时。
- 与 WEB-02 确定 SSR 快照到浏览器订阅的交接，以及 URL/远端缓存/草稿/订阅的单一职责；与 DATA-01 明确来源、索引与必要历史边界，不复制后端采集或靠组件轮询拼出状态。

## Job 观察与等待（2026-09-22）

[Job 管理用例](../reports/2026-09-22-job-management.md)已接入管理 Server、共享客户端与 Web：`job get/wait/logs` 绑定安装、主体及原 Job，等待只在声明窗口观察，不重新执行、延长期限或随页面关闭取消。已知接纳不标作执行成功；未知或缺日志不能宣称输出完整。列表及精确读取使用同一已发布记录，不用正在写入的内存终态签成功。原请求及取消分别以 `operation get --domain job|job-cancel` 恢复，缺当前策略不抹去原历史。

旧 daemon Job RPC、`events --sources job` 与 Profile 的 process capability 承诺已退出；既有 Job 状态等待及有界输出由上述管理用例接管，不提供空的旧事件源或再挂一个 daemon writer。其他 Gateway/消息事件的统一接续、全域事件关联及全仓最终验收仍按本票/CLI-05 推进，不能从本片外推为所有事件域已迁完。

## 文件观察与原请求（2026-09-22）

[文件管理](../reports/2026-09-22-file-management.md)提供准确根/目录snapshot与有界正文、固定下载描述符/完整SHA、独立file operation查询。目录cursor绑定当前metadata窗口；目录revision不代表递归文件内容，原文件来源的新鲜度和文本索引追赶分别呈现。浏览器仅保存安装/主体/源引用/原request定位，不缓存可重用审批或二进制。查询历史不检查当前源才能返回，不隐式修复/补投；原暂存上传取消是写动作，不伪装GET对账。

原生Project fileRef、账号/同步与跨域变化订阅仍归DATA-01及本票剩余合同；不能把二进制下载或一个现行file receipt称为所有材料已被原生Bot采用。

<a id="消息关联与对账2026-09-22"></a>

## 消息关联与对账（2026-09-23）

`message send` 在原 native writer 前保存 management request/submission、clientNonce、Gateway generation 和 `nativeIdentity`（账号 scope 摘要、Server Bot id、harness）。复用同一 pinned continuity gateway，发送前后核对当前身份；成功 ACK 仅证明 native acceptance，显式 queue 字段才证明 queued。对账的 ownership 读前/读后与 transcript 来源必须同原绑定；scope、Server id、harness、进程代际变化或失权只返回 unknown，不跨账号/跨 Bot 猜测，不补投。身份前后采样不是全局账户锁，不代签未观察到的中间状态或原 native writer 的外部业务完成。

`message get` 无需原生来源在线即可读回保留的原请求。旧记录缺 nativeIdentity 时仅投影为 null，保留原状态且不重发；这不授予在当前账号下重新认领它的资格。损坏记录不作为“不存在”。历史读取适配不恢复旧 writer 或第二消息实现。

`message delivery get|wait` 的有界精确关联是用户 echo 的 clientNonce → 唯一原生 requestId → 同 requestId 的已持久化文本 send-message。当前原生记录为 `kind=send-message`、`message.type=text`，不写 isStreaming；API 保留其 `isStreaming=null`，另报 `deliveryEvidence=persisted-text`，不捏造 false 或 run 终态。明确 streaming=true、非法字段、作者归属不符、普通 assistant、仅同 thread/位置、错 request 或歧义 nonce 均不构成交付证明。公共 client 与 Server 复用同一个纯关联判定。非文本卡片/附件可在窗口中出现，不在该文本资格中伪装为已完成回复。

`send` 与 `history search|tail|thread` 的既有便捷语法复用该 management client，其 registry 也标记 management，不再根据旧 --profile 跳到 daemon/Gateway。目标只接受本段已交付的 Bot；错误使用管理回复/退出码，原始发送仍只有一个 native sendPrompt。group/其余产品扩展归 D2，不以旧夹具恢复第二发送路径。

当前原生 Node/SQLite 的 factory→request 关联→原写入→重开→tail→管理投影、scope 稳定/变化和公开反例由 `native-message-qualification.test.ts`、`messages.test.ts` 及 `message-contract.test.ts` 承接；原生测试只在显式 opt-in 的 `verify-host-health.mjs native-pair` 中执行。真实 App 的输入/详情显示和运行 Working/终态仍走 [T39](T39-native-model-roundtrip.md) 与对应 LIVE，不以隔离原声明或自有 Web 代签。

## 实施前验证

持续采集与存储差额继续归 [T41](T41-continuous-observation-and-alerting.md)。本票不复制 collector 实现票，也不宣称新增 Host 补丁已通过资格。