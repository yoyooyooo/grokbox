# T52 — 用户主动决定后的支持草稿（延期）

## Status / Goal

**Deferred · 2026-09-18；不是首发前置。** [当前Spec §5.5–5.6](../roadmap/template-ops-automation-spec.md#support-issue)。默认告警只提醒，不询问是否整理Issue，不自动诊断或公开。原先的默认offer流程退役，不以历史票语句恢复。

用户以后明确要求整理/公开时，Bot可自主获取已授权证据并准备可审核草稿；整理不等于公开，发布仍由用户决定。OBS-02/03提供通用取证与公共视图，不能把本票重新变成其依赖。

## Depends-on / Modules

未来依OBS-02/03与受信用户任务入口；T56为唯一gh发布adapter。可复用kernel support草稿/确认用例、原SQLite独立support域和薄CLI；本阶段不新增表/命令/后台worker。

## Deferred acceptance

实施时先重新确认产品范围。至少证明：无用户任务零草稿/零Issue询问/零公开；确切repo/可见性/标题正文附件/作者与用户确认绑定，改稿失效；实际网络bytes等于批准视图；用户拒绝或无回复不催问。

缺复现/根因明确unknown，不编造；敏感问题按SECURITY.md私密入口。Bot输出和Webhook不能自证用户确认，维护grant不批准公开。无gh或认证/权限时本地保留并跳过，不自动登录/换身份。

## Forbidden / Non-goals

不自动Issue、不默认grant、不自动附件/评论/关闭，不把首发通知变成支持工作流。公开方向以用户新任务为唯一触发，不追补旧积压。

## Exit / LIVE

本票保持Deferred，不能标Done或作为M3/M4阻断；保留[LIVE-OPS-ISSUE-PUBLISHING](LIVE-integration-validation.md#live-ops-issue-publishing)稳定锚点但标延期。未来启动后才添加实际测试文件和原生/公开测试授权范围。
