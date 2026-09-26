# 官方客户端入口与自定义执行：独立 POC 的边界

证据时间：2026-09-26；以三个已保存阶段记录和客户端 0.58.0 原函数实验为依据。当前路线仍由[实施计划](../../roadmap/agent-first-cli/local-first-reintegration.md)管理；这里不授权恢复已停用的描述、服务或旧测试身份。

原始材料索引见[独立 POC 导航](independent-poc-atlas-2026-09.md)。本文区分实际网络/模型、原函数加替身、源码分析及未执行，不把一个阶段的成功外推成下一阶段成功。

## 1. 自有会话 POC：先证明模型与跨机器状态，不证明官方 App 接管

历史入口是一个自有 HTTP 会话服务，引用已经存在的官方 Bot 身份。它复用了原模型配置、凭据 owner 和 provider/AI SDK 适配；原生 Gateway 只作为身份工具。其会话、Memory 与任务结果由自有存储负责，没有写入官方 Bot 的 Memory 或官方私聊。

```text
自有客户端 → 自有会话 API → 自定义模型 Loop
                          ├─ runtime_context → 原生身份读取
                          └─ remember → 自有 Memory
                         → 自有任务结果与会话文件
```

原 `RESULT.md` 记录的真实窗口为 01:51–02:03 UTC：3 个完成任务、6 次模型 HTTP 请求；Box 与 Mac 经同一服务继续，重启后读取相同历史与 Memory。重复原 requestId 返回完成结果，没有增加模型请求；未认证读取被拒，非绑定 Bot 请求被拒。简单 HTML 页存在，但手机/完整浏览器交互未验。

**它解释了后来“官方 App 为什么没有消息”**：身份来自官方不意味着会话也写在官方。历史可恢复和跨机器读取的正例属于自有服务，不属于未修改官方 App。它的复用价值是 provider、精确任务身份、可恢复结果和状态作用域，不是一个可以代替官方客户端的产品。

原实现也承认 JSON 会话与任务两份文件没有完整事务保证；进程中断后未知任务不能自动重放。不要把“相同请求已完成后不重复模型调用”扩大成所有崩溃点的 exactly-once。

## 2. 官方工具委托 POC：官方历史可见，但主推理仍属官方

后续 `UI-RESULT.md` 记录了不同的实际构造：暂时修改一个准确测试 Bot 的描述，使它在正常官方回合中使用终端工具调用桥接程序。桥接程序读取原用户消息与 nonce/requestId，交给自定义模型，最后由官方回合使用 SendToUser 写回原生历史。

```text
官方 App / 原生输入 → 官方模型回合
                     → 终端工具 → 自定义模型
                     → 官方回合 SendToUser → 原生历史
```

三次自定义任务共新增 5 次 provider HTTP 200；最终文本与对应原生历史匹配；再次消费完成任务不增加 provider 请求。Memory 仍归自定义执行器，不能写作官方 Memory 已接通。Mac 曾读取真实 renderer，但发送/切换的完整点击没有在该阶段完成；用户后来看到消息不代替该阶段所缺的执行归属证据。

这条路线被明确放弃：提示词“每次都委托”不是不可绕过的硬路由，官方模型仍负责工具选择和回复提交，不能满足省官方推理额度的主目标。原始后续记录 `PRE-MODEL-TAKEOVER.md` 确认临时描述已恢复并独立读回，原历史保留。`UI-RESULT.md` 后部仍留着较早“尚未恢复”的当时文字，不能据此重新启用描述；后续带回执的恢复事实优先。

可保留的细节是原输入关联、原生历史作者/请求定位、工具输出与回复逐字核验。不能把这个桥继续藏在正式产品中当自定义主循环的 fallback。

## 3. 未修改客户端的路由，才决定 Host 是否有控制位置

客户端 0.58.0 固定来源：

| 构件 | SHA-256 |
| --- | --- |
| node-agent-coordinator | `fec719dad6d8eab8da23295e6f54506a57c05b1ceab23c6a41d46bc37dc3ada7` |
| electron-main | `3e60dafbc16d9baeb58835aa733f5624787636a02456f782481d08353d6eae89` |

`pre-model-routing-058.test.mjs` 提取原 dispatcher、规范化器和发送 mapper，外部传输为自有止点：Temporal 主私聊走 Server action；Box 主私聊走 Gateway；Temporal 的远端 unimplemented 不回退 Gateway；次会话仍保留其 sessionId。此为原函数控制流实验，没有运行整个客户端或发送真实消息。

原规范化器会剔除未声明的 model/runnerUrl/doNotRunOfficialModel 字段；已检查的普通消息合同没有外部 runner 或只存储不调度开关。不能在调用参数里塞一个字段就假设客户端会转交它。

另外三个原 mapper 对照把 ACCEPTED_BOX、ACCEPTED_TEMPORAL、DUPLICATE 都映射成相同的 accepted=true。因此受理成功不能区分执行者、是否新执行或是否产生模型费用。接口名包含 session、handoff、computer request 也不等于主循环交接：已读 session 是会话元数据，computer request 是电脑工具任务，handBack 是交还电脑控制。这些结论不宣称穷尽全部服务端实现。

**关键教训**：能改 Host 代码，不代表原请求一定经过它。对已经由客户端直达 Server 的 Temporal 输入，增加本机 Gateway 处理逻辑无法证明接管；必须先有真实可达的模型前入口。

## 4. 本地房间切口：真实可达的位置，但不是最终对象模型

原生本地群走 SendPipeline 的权限检查与用户消息保存，然后进入 dispatchGroupSend 的运行队列，再由群编排派发成员。独立房间 POC 在已保存消息、未开始成员推理的排队回调处，按一个准确 roomId 替换执行；其他房间沿原回调。

自有 handler 绑定原 userMessageId/clientNonce，而不是任意最新文本；复用已有 Loop，但使用独立房间状态根；回复经 GroupChatGlue.postGroupMemberMessage 的原历史/事件路径写入。作者明确是房间运行时，不冒充其 Temporal 成员的私聊。

原函数实验覆盖目标/重复输入、非目标、模型错误、原执行许可撤回；队列、数据库与模型为替身。实际创建过一个空房间，并暂改 Host 源码通过语法检查；加载准备被工具层拦截，随后恢复原源码和清理房间。**该房间级整体替换没有实际加载或在线自定义聊天正例**，不能和之后普通 Box 成员在两个群中的成功混为一谈。

这条路线的价值是找到模型前派发与原生回复回程，以及 later 可复用的成员级分流位置。它的不足是把群当自定义身份容器，不能自动覆盖普通私聊、Bot 自身 Routine、统一长期 Memory。最终没有选择以单人群替代普通 Bot。

## 5. 为什么最后回到普通 Local-first

普通本地 Bot 的原生工厂与登记仍然存在。真实 local-first 登记取得 Server Box 身份之后，原客户端原有的 Box→Gateway 路由才成为可利用的真实入口；无需修改 App，也无需自建聊天账本替换官方显示。后续受控窗口把私聊、群成员、Bot Routine 和原生 Memory 接回同一身份，详见[固定 Local-first 证据](box-local-first-poc-2026-09.md)。

归档不能把路线演变写成所有先前工作都是失败：自有服务证明模型/状态，工具委托证明官方历史回程，客户端实验定位流量边界，房间实验定位前置调度。它们分别解决了不同问题；只有符合用户完整目标的组合才能作为产品方向。新请求的实际入口、执行 owner、存储 owner、回复 writer 和客户端读取必须分别说明。
