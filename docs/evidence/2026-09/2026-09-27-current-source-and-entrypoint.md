# 当前来源、入口识别与首次失败证据

2026-09-27，AH-187。延续[官方回程](2026-09-27-original-adoption-restored.md)，当前状态仍以 [LIVE](../../tickets/LIVE-integration-validation.md) 为准。本包没有现场采用、Host 信号或模型请求。

## 已闭合的源码差额

- 原恢复审查者对 `2e6f823673c1c9f629d950505027c7dba54e7e07` 复看确认两项问题闭合、限定范围无新增发现。审查是静态只读；97 项测试等执行证据由实施方提供，原官方物理回程不在复看范围内。
- 原 classifier 将全 argv 中的文件名当角色，反例中的 `grokbox … --from host-main.cjs` 被当成 Host。修复按受支持执行入口识别，跳过明确取值的 Node 参数、拒绝 eval/check 和未识别的取值形状，实际程序后面的数据参数不再参与角色判断。保留官方 shell wrapper、Node supervisor、Host、temp-supervisor 入口。当前真实只读 census 得到唯一官方 wrapper → supervisor → Host；没有第二 Host。
- 原采用失败诊断会在清理后读取 guardian 状态。反例证明：先观察 marker mismatch，再于清理时到期，原始原因会丢失。现在在清理前保存 `initialFailure`，并将其带过原 controller store/parser 与原 journal；最终 ownership/cleanup 事实独立保留。旧操作不改写、不重放。这只证明诊断缺陷，不能倒推 `84c3000e` 首次采用的原始失败原因；旧编译回执与原 profile 当前读回一致，也不是当时 readiness 的证明。

## 当前固定来源资格

当前官方 `0b67642`：Host `7acd9a7e9272833758f2f7aad72a4a9146da7f6098a692fb4f60e16390978797`，worker `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。63 切片锚点、materialization / duplicate 绑定与 disposer 表达式均复核；本包配对 pin 替换旧来源，未加历史 fallback。

完整候选验证初轮 90 秒超时，单独复跑又收到信号终止；退出细节不足以归因。验证 driver 现在显式限制 Node old-space 为 1536 MiB，并检查退出信号；原 90 秒期限、正例和四个合法 JS 语义反例全部保留。有界运行通过后，完整组合再次通过：

- controller / 恢复 / 真实进程 / 入口回归：104 pass。
- native-pair：40 pass；native-runtime：4/4 commands、88 个外层测试。
- Local-first 原生声明及原生模型预览：2 pass / 113 assertions。
- typecheck、build 通过。

这次隔离候选 transformed SHA 为 `f279cb7d9ee7e0162ff0acf4b0ded1dcf636159532359cade4dd624dc341e0a4`，结论仍是 `qualified:false / passed-in-selected-scope`。没有执行完整 Host、发布 profile、安装/加载该候选或完成采用。正式 session 入口仍晚于官方模型解析和 session 构造；后续业务前需完成该差额并对最终配方重新资格。

静默创建未发送。desired=disabled，原服务已停止；官方回程不授予业务重放，10 条 unknown 保留。费用继续 billing not observed。
