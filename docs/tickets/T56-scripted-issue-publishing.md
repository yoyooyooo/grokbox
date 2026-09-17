# T56 — CLI 内置 issue 流水线与有限发布预授权

## Status / Goal

**Planned · Spec-only。** 用户允许后不再手工复制/提交：同一个 CLI 程序完成安全稿件、预览、授权、GitHub create、未知对账与回执；额外允许明确范围的确定性摘要预授权。Owning contract：[Spec §5.2](../roadmap/template-ops-automation-spec.md#issue-automation)。本票不在本轮创建真实 issue 或 grant。

## Depends-on / Modules

依 T52 草稿/consent、T51 ConfigurationWrite、现有包 repository/bugs、bug_report.yml/SECURITY.md；不依 T47 模型诊断、T49 Host 维护或 T54 多目标。T54/T55 只决定报告接收者，不成为发布 authority。

kernel `internal/ops/support.ts`、`policy.ts`、`internal/commands/support-issue.ts`、ports IssuePublisher；box-runtime `internal/io/issue-publisher.node.ts`、`ops-policy.node.ts`、`monitor-store.node.ts`；CLI `commands/ops.ts`。唯一内置 Node REST adapter；不依赖 gh 或模型拼 shell，不新增 npm 包/通用 HTTP 执行端。

## Work

实现 prepare/preview/submit/reconcile/status/export 与 target inspect，所有 CLI/Bot/后台消费者调用同一 support 程序。默认 confirm-each：用户对未变化的 exact target/visibility/author/title/body/附件 inventory 确认一次后完成自动提交，不重复询问。无授权的非交互调用返回 approval-required，不默认 yes 或无限等 stdin；无 GitHub 认证仍可本地 draft/export。

在独立 grant 命令中预览并以 expected-preview-digest + policy revision/CAS 保存 preauthorized-summary 的 repo ID/作者/可见性/incident rules、create-only、固定 public-summary 模板/字段/脱敏版本、有效期、每日/总量/周期限额。config mode 只是 desired，不造有效授权。默认 7 天、2 次/24h、总量 10 次；严格字段模板不得接受模型自由正文、用户 transcript/日志/私密源码、附件/评论/更新/关闭。变模板或身份、疑似漏洞、缺证据或字段越界都回人工。生效后新周期才可自动处理，历史批量上报需另外确认。

固定包默认仓库 yoyooyooo/grokbox；runtime 只读核验 GitHub repo ID/可见性/Issues 状态/认证作者/权限。任意当前工作目录 remote 不能覆盖目标；显式 from-remote 只产生脱敏候选，不执行 URL/remote helper。目标迁移/可见性/作者变化使现有许可失效。

REST 只访问批准的 GitHub API 路径，version 固定并资格化；secret ref 仅 publisher 能消费。最小 Issues 权限而非 push/admin；默认只 title/body，labels/assignee 不能被静默忽略而声称已设置。投稿文件/正文不在 argv/URL/普通日志；网络在短事务外，stable report/submission id 和额度 reservation 先提交，201 后保存真实 issue ID/URL/author/readback。

重复跨 Bot/事件重放/用户确认命中同一个 submission；有限只读对账不能凭搜索零结果推定创建失败。timeout/取消/5xx/201后存储失败保持 unknown，无自动第二次 POST/gh fallback。401/403/410/422/429 分类，按 Retry-After/限额收敛，不换身份逃逸。撤销只阻止未发作业，unknown 保留只读恢复；本地删除不撤销公开披露。

## Executable acceptance

实现时创建并运行：

```bash
bun test packages/box-runtime/test/github-issue-publisher.test.ts packages/runtime-kernel/test/issue-publishing-grant.test.ts test/ops-issue-cli.test.ts
bun run typecheck
```

首两项本票创建，CLI/support 复用 T52。FakeIssuePublisher + 本地真实 HTTP stub + 临时 SQLite 验证：exact consent 一次完成、非交互缺授权、有限 grant 正例与不匹配 rule/模板/作者/过期/超额反例、两个 Bot 并发只一次、旧配置/备份不复活、raw secret/source/prompt/link sentinel 不外泄、safe template unknown 不造根因、预览后 repo/作者/模板变化拒绝、已拒绝周期不被 grant 复活、repo 移动/可见性变、201 回执丢失、401/403/410/422/429/5xx、搜索迟到/不完整、auth 缺失可 export。unknown 重试对写 API 计数为 0。

真实 GitHub 测试仅在另行明确指定的测试仓库、已预览的合成 draft 与当前授权范围中执行；常规 CI 不能对公共项目创建垃圾 issue。Grant 型 live 资格也使用一次性低额度测试 grant，撤销并保留回执，不假装测试已授予生产许可。

## Forbidden / Non-goals

不在本轮创建 issue、不读取 provider/Gateway token 给 GitHub、不靠 LLM 自述用户同意、不支持无预算永久 autoSubmit、任意报告正文自动化、评论/附件/代码 push、自动删除公共 issue 或恶意同 UID 隔离承诺。

## Done evidence / Next

提交默认与有限授权两个模式共用程序/REST/CLI 的证据，记载 API 版本/权限、受控身份、未完成 native GitHub 范围。T50 的用户支持 lane 可以先只签 confirm-each；脚本化交付与是否开启 grant 分开验收。
