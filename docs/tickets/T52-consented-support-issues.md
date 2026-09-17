# T52 — 默认异常提醒、脱敏草稿与用户确认后 issue

## Status / Goal

**Planned · 2026-09-17 Spec-only。** 已确认的用户异常且无法安全自修时，先简短告知并询问；用户选择后高效整理背景、现场和问题，预览确认后才对外提交。Owning contract：[Spec §5.1](../roadmap/template-ops-automation-spec.md#support-issue)、[§6.1](../roadmap/template-ops-automation-spec.md#capability-tiers)。本票绝不把维护失败当成自动公开上报许可。

## Depends-on / Modules

依 T44 事实、T45 delivery/claim、T51 默认/预算；可用 Fake Bot/Publisher 先落地，不依赖 T47 深诊断或 T48/T49 自动维护。实际模板接入消费 T46 绑定，公共提交能力单独资格化。

kernel `internal/ops/support.ts`、`internal/commands/support-issue.ts`、`ports.ts` 的有限 IssuePublisher；box-runtime `internal/io/issue-publisher.node.ts` 和原 `monitor-store.node.ts` 的 support 域迁移；CLI `commands/ops.ts` 的 issue prepare/preview/submit/status。复用 `.github/ISSUE_TEMPLATE/bug_report.yml` 与 SECURITY.md，不改它们来允许原始材料公开。

## Work

实现 confirmed user impact + safe remedy unavailable/blocked/failed 的确定性 eligible-offer；source-only 更新/普通位移/维护者 debug 不产生用户 issue 询问。无需先尝试维护或发动诊断。首次唤醒仅 claim 安全摘要、报告和询问，随后结束；用户拒绝/暂缓/无回应不催问、不搜索 GitHub、不派后台任务。

同意整理只允许本地安全草稿；已有结构化摘要用模板生成，不默认消耗额外模型 token。缺少重现/背景时询问用户，额外诊断需单独同意范围/成本。区分观察、推断和未知；映射版本/平台/预期实际/重现/依赖现实/影响/错误码/已做动作，不伪造根因。

脱敏默认 allowlist、无附件；真实 IDs/私有地址/源码/正文/secret 排除。展示 exact repo/visibility/title/body/attachments/author 后取得与 draftRevision+digest+snapshot 绑定的受信确认，变化或过期失效。Payload、模型文字、maintainer preset、维护 grant 不能批准。原生用户回复无法可靠识别时用受信 CLI/确认界面，不自证确认。

同库 support 用例唯一写 draft/consent/submission，普通 collector 不可签 consent。网络事务外使用稳定 submissionId；重复确认/发送超时保留 unknown 并先按已知 issue 或安全 report ref 查证，不盲重发。认证缺失可导出本地审核 Markdown，不代登录。成功后返回实际 issue 引用，不能声称故障已修好。后续更新/评论/附件仍逐批确认；安全漏洞走私密报告提示，不开公开 issue。

## 多 Bot 与 CLI 发布补充

本票继续拥有**默认 confirm-each 用户旅程、草稿与受信 consent**；[T56](T56-scripted-issue-publishing.md)实现同一个 IssuePublisher 的内置 REST 与结果恢复，并新增独立、限定模板的发布 grant。不是两个发布程序：共享 support.ts/support-issue.ts 和原库状态。允许同一 exact draft 已批准后一次完成，不重复问用户；本票默认路径不能因新 mode 而自动公开。

[T54/T55](T54-ops-targets-and-routing.md)的接收者不限模板或官方模型；目标/路由变化不改变草稿/incident/submission 身份。多个 Bot 提出同一报告或转述同意，必须以真实用户/principal 与同一内容/仓库/作者验证、短事务去重；模型/provider/Webhook 凭据不用于 GitHub。

新增测试：跨 Bot 重复确认仅一次发布；路由变化不扩大内容/目标授权；无回复不唤醒高级 Bot；有限 grant 只能经 T56 分支、不能伪造 exact consent。共享测试/文件修改按一个 writer 顺序集成，T56 不重做 T52 的默认旅程。

## Executable acceptance

本票新增并运行：

```bash
bun test packages/runtime-kernel/test/support-issue-consent.test.ts packages/box-runtime/test/support-issue-store.test.ts test/ops-issue-cli.test.ts
bun run typecheck
```

以上文件为待实现。证明默认监测/首醒/同意准备阶段 GitHub 网络写与模型诊断为 0；用户未回应、拒绝、重复通知、新旧 incident 不反复询问。测试 local draft→preview→真实受信确认→Fake Publisher 一次提交，而非 mock 一个 userApproved 布尔值。

负例：Payload 伪造确认、模型说用户同意、旧稿确认、目标/作者/正文/附件变更、私有日志/路径/URL secret sentinel、恶意重现指令、安全漏洞分类、过期/撤销、并发 submit、GitHub 401/403/422/限流、POST 成功 ACK 丢失、重启/备份恢复；无有效 consent 不发请求，unknown 不第二次创建。字节级检查实际发送的正文等于已批准稿件，diff 后不能沿用许可。

packed CLI 证明同一用例/脱敏与回执；native 用户回复/报告关联单列资格。测试默认 Fake IssuePublisher，真实提单只允许另获批准的测试仓库和已预览稿件，不向生产公共仓库写入。

## Forbidden / Non-goals

默认无 exact consent 不创建 issue；T56 的有限 grant 仅在独立启用/资格化后允许 create，不覆盖更新/附件。禁止静默上传附件或 telemetry，不查询全盘凑背景，不把敏感内容塞预填 URL，不无限催用户，不用 GitHub token 当 Webhook/provider 凭据，不建泛化客服系统。

## Done evidence / Next

关闭需声明默认 0 发布、用户确认来源、脱敏/unknown/重复恢复、source/packed 证据与 native 未证项。T50 的 user lane 必须包含本票，不等自动修复；不存在可安全提交的内容时只报告受阻并给私密指引。
