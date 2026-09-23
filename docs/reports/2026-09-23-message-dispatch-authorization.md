# 消息派发前的管理授权复核

## 已修复的边界

原 `/v1/messages` 只使用请求进入时的 Principal。名单、原生 ownership 和 pending 回执准备期间撤销 messages.write，仍可能尝试 sendPrompt。隔离管理 HTTP / 原生端点已复现 1 次不应发生的尝试；没有真实账号或消息效果。

初始修复提交 `13a3b9f4` 将同主体授权复核放在 pending 持久化之后，保留原 requestId/clientNonce/native identity 与 unknown/accepted 回执。后续审查再将最终授权能力贯穿原 ContinuityGateway，在管理原生 IO 已读取并核验 discovery 后、真正 fetch 前调用。该回调是可信进程内能力，不能从 HTTP JSON 输入指定，也不会进入原生请求正文。

域入口复核与传输边界复核分别覆盖较早撤权和最终读取间隙；没有宣称跨进程账户锁、原子 native CAS，或改变原生 ownership 的判定。最终未发出的请求仍保守保存原 unknown，不通过删记录或更换 nonce 自动发送。

## 原请求和寿命

读取要求当前 messages.read，发送要求当前同主体 messages.write。历史 GET/replay 不产生新写权限。成功/未知派发后撤权不重发；恢复权限也不把未知记录变成新的派发许可。客户端断开后已受理用例继续由 Server Scope 承载；Server 关闭中断实际运输并保留原 unknown。

## 验证

原始修复经过独立实施；本次续接复验了根类型、原 32 个 Node 消息用例和 8 个 client 合同用例。随后新增两项管理域最终间隙反例，以及三个使用生产 management Gateway IO 与自有 HTTP 服务的回调顺序/拒绝/取消用例。

最新定向组为 34 个内部 Node 消息用例、11 个原生 Gateway IO 用例和 8 个 client 合同用例，均无失败；Node 的外层 Bun wrapper 不另累计。其余 Server、CLI、文档与打包组合在交付回执中记录，不使用历史计数代签新组合。

## 证明上限与入口

真实 Node HTTP、原配置/回执文件与自有存储；native backend、授权策略变化和读写目标均为隔离测试能力。未改动现役 Host/modeld、用户 Bot/Group/App/桌面，未执行原生模型请求。不是完整候选独立审查或 LIVE 通过。

源码入口：`packages/server/src/messages.ts`、`packages/server/src/server.ts`、`packages/box-runtime/src/internal/io/continuity-gateway.node.ts`、`packages/box-runtime/src/internal/io/management-gateway.node.ts`。操作合同仍见 [CLI-03](../tickets/CLI-03-observation-and-wait.md)。Linear AH-163 的精确 merged-v2-sha 拥有交付和解除阻塞记录。
