# CTX-04 — 旧会话下一消息恢复、操作入口与整体验收

Status: **Planned / Spec-only** · M4。2026-09-17规划基线 `7994b92`；新功能implementation commit、offline proof、review均 **not-recorded**，不是仅剩live的收尾票。

## Goal / release blocker

**CTX-A01不可替换：** 一份已有过长历史、最近以error/aborted/无有效usage结束的会话，在新能力正常部署并生效本地128K后，用户只输入一条普通消息；系统发送主模型请求之前已完成必要compact，保留/处理新输入一次，旧失败STEP不复活、旧工具不重做。新建短会话、手工compact、先制造上游400或一条摘要回复，都不满足这个出口。

全部产品/命令/状态/算法/证明合同唯一归 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)。本票只组织接线、验收、退旧和证据，不复制另一套阈值。

## Depends on / integration

依赖CTX-01配置/计量、CTX-02原生owner及CTX-03有界摘要；消费现有T32/T35、continuity F/E、S10/S11与config-unification证明。尽早将旧会话入口反例写红，不等待全部实现才发现safe point接错。固定集成源码、schema、wire、profile和构建，不用移动的worktree签字；不同历史票的绿色计数不拼成新候选资格。

## Module / change set

- CLI `commands/agents.ts`、`registry.ts`、`config-registry.ts`：实现S12的context只读与显式compact操作，沿既有Agent目标/作用域/确认/operation合同。没有远端有限capability时明确拒绝，不以generic exec补洞。
- Host真实新输入、恢复root、工具后、维护事件/错误和modeld预算回执接线；原版App沿已有Host活动更新表示维护。状态/FailureSummary/outcome/journal只用安全字段，不记录prompt/摘要或把错误放进Memory。
- schema2→3、当前下一wire、CLI/preload/Host/modeld成套资格；保留models schema2及effort。删除正常功能 `GROKBOX_MODELD_HOST_COMPACT` 环境门、其启动传递和默认off测试，改用auto/manual+capability；故障注入仍off，删除旧门不等于放宽authority或重试条件。
- 目标 `box-runtime/test/context-maintenance-{pipeline,packed}.test.ts` 与既有CLI/config/Node/import/privacy tests；最后注册 `context-maintenance` 汇总case，只在本票完整公共矩阵实际执行后通过。
- 更新配置指南/skills必要入口、维护状态说明和T32/T35实施事实，不能保留两个“当前怎么开启”口径。本轮这些新增命令/字段仍planned，实施时再升级为当前指南。

## Acceptance — complete public matrix

实现后 `bun scripts/verify-runtime-rebuild.mjs context-maintenance` 执行S12.8的CTX-A01–A15；必须有真实SDK/local HTTP、Unix、临时磁盘、独立新进程、实际打包Node入口，Fake只替外部能力不替业务程序。

首要旅程：从合成旧root启动，包含合法历史工具组、早/中/晚事实、最近失败消息且无新usage；本地128K、Fake provider总接受500K。发一条带唯一nonce的新输入，断言首次主HTTP未收到旧过大窗口、摘要请求被独立计数、当前输入完整且仅一次、旧工具结果关联仍在、旧失败仍为失败。随后正常续聊不因陈旧usage重复压缩，再经历至少10次维护与进程退出/重开；每次只从持久root恢复，不能以测试RAM伪造。

还必须完成：无assistant首输入/无usage；新消息及工具跃增；policy/模型切换/其他Bot隔离；manual与session歧义/合法空session；并发取消/pending摘要；巨型材料/无改善；未提交/已提交/unknown故障；确认溢出窄恢复和所有负对照；正常功能env退场、old schema/wire拒绝、import fence、敏感sentinel不出日志。不能以只看最终答对或HTTP200替代结构、次数、root和输入状态证明。

测试入口未知case、缺文件、zero/skip或缺制品均非零；摘要Fake必须从实际输入提取事实，坏变体包括跳过preflight、usage清零、静默slice、提交前漏fence、未持久化、新输入丢失、旧STEP重发、永远blocked以及使用旧dist。固定Pi参考向量仅作行为对照，不是全局安装或网络依赖。

## Native / live gates

原生隔离consumer/profile/合法root处理的离线资格与独立review留在本票或CTX-02，不能因为运行官方代码就统称live。最终oracle已按规划提交 `15a0594` 预登记为 [ADOPTION](LIVE-integration-validation.md#live-ctx-adoption)、[NEXT-INPUT](LIVE-integration-validation.md#live-ctx-next-input)、[DURABILITY](LIVE-integration-validation.md#live-ctx-durability)，分别证明现役能力、已有失败会话普通输入和原生重启。三条的当前已验/未验、阻断与下一步只在 LIVE 更新；implementation commit 与离线资格继续由本票维护。进入窗口前逐条补固定实现source→v2映射、制品、对象、预算与停止条件，不把预登记当功能实现。

上线前保护原配置和原生状态，核对所属Server/Host、旧writer已退出、所有参与组件的实际版本/能力。schema3或新wire发布不等于Host已经采用；默认auto只属于已正常启用的受支持managed运行范围，不借配置迁移给别的Bot选模型。无本次明确授权，不切换Host/modeld，不发用户业务消息，不制造大prompt消耗。

原会话实际受影响样本可在明确授权窗口作最终验证；不能拿历史失败STEP重放，必须用新的普通输入。日志只记录安全统计和身份，私有正文、token、原始provider错误和真实事故证据不进公共Git。

## Non-goals / evidence receipt

不重建完整Pi客户端、App、Host Agent loop/Memory/store，不用后台预生成或另选摘要模型延后基本恢复；不承诺不可压缩单条输入、模型服务不可用或未知持久状态下仍成功回答。

关闭回执必须分开列出：实现source commits、实际offline cases/断言/坏变体、packed摘要、独立review及范围、原生隔离资格/缺口、live各条结果和被保留未完成项。代码和离线可单独完成；发布只有所声明范围的全部门满足才可签。文档规划、一次成功重启或本票索引存在均不构成能力已启用。
