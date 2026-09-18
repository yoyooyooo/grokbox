# Documentation Map

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

This documentation separates source truth, accepted contracts, interoperability facts, future candidates and dated evidence. The repository keeps its established Product/Architecture files and maintainers/decisions/tickets homes; roadmap retains the active Spec/strategy, `roadmap/future/` owns unstarted product extensions, and `reports/` owns historical explanations. No new synonym documentation tree is introduced.

## Current homes

- [Configuration](configuration.md): source candidate config v4, two human entry points, local context and storage policy, nested edits, successive migration/recovery and consumer receipts. Existing v2/v3 deployments require explicit migration and matching runtime adoption; allocation arithmetic is not a global physical quota.

- [Agent 操作入口](../skills/grokbox/SKILL.md)：默认只读小入口，以 `grokbox skills get grokbox --topic <name>` 按能力展开；Host 恢复、运行时诊断与 canary 验收不进入模板启动正文。[分层与维护约束](product-contract.md#15-bundled-skills)由入口预算、主题清单、链接和安装包测试保护。
- [Product contract](product-contract.md): commands, Profiles, capabilities, output, and security boundaries.
- [Architecture](architecture.md): modules, transports, daemon, Sandbox, and verification boundaries.
- [Compatibility](compatibility.md): unofficial status, stability classes, trademarks, and revalidation policy.
- [Upstream integration](upstream-integration.md): minimum interoperability facts required by the implementation.
- [Sandbox control plane](cursor-sandbox-control-plane.md): lifecycle terminology, trust separation, and validation requirements.
- [Quota](quota.md): implemented explicit source, normalized output, and failure boundary.
- [Box-local model runtime](box-runtime.md): accepted createSession seam, inject/watchdog/guardian, modeld, window semantics, and evidence ladder. Not an implementation-complete claim. Product obligations are in the [product contract](product-contract.md) §12.
- [Box-runtime strategy plan](roadmap/box-runtime-plan.md): Phases 0–4, product exits and scope.
- [默认本地上下文维护 Spec S12](roadmap/box-runtime-impl-spec.md#context-maintenance)：旧失败会话下一条输入先compact、本地128K与Host持久root；[CTX-00–CTX-04](tickets/README.md#context-maintenance)已实现Pi受控提取、config3/wire8、原生维护和操作入口。[Pi来源](maintainers/pi-compaction-reference.md#core-package-reuse)与[离线报告](reports/2026-09-17-context-maintenance-offline.md)区分实际Node/SDK/原生隔离证明、支持限制和独立review缺口；源码通过不等于现役会话已恢复，当前部署只看LIVE。
- [PI-AI-01 模型适配资格](tickets/PI-AI-01-model-backend-qualification.md)：独立评估进程内pi-ai实现ModelBackend，不是T30 RPC、不阻塞compact、不默认替换AI SDK或改变Node基线。
- [Managed Compact evolution](reports/2026-09-12-managed-compact-evolution.md): historical reasons and rejected alternatives; not a current plan or permission. Old brief/path links now route here.
- [Box-runtime Current Implementation Spec](roadmap/box-runtime-impl-spec.md): **S0 owns Server-authoritative, Host-only stable delivery and V01–V30**; [S9.1.1](roadmap/box-runtime-impl-spec.md#ownership-release-proof) lists planned proof cases, not existing commands. [Tickets](tickets/README.md) route T37→T38→T24→T39→T40 alongside existing stream/compact/Working mechanisms. No parallel ME spec or implementation-complete claim.
- [Modeld execution-core Spec S10](roadmap/box-runtime-impl-spec.md#modeld-effect-core): one Effect service/STEP program, source-versus-waiter lifetime, durable identity and bounded authority waiting. [T43–T50](tickets/README.md#modeld-effect-core) own implementation exits; [ADR](decisions/2026-09-16-modeld-effect-core.md) and [boundary audit](maintainers/modeld-authority-boundaries.md) distinguish necessary integration, self-introduced problems and unproven native coverage. No default freshness relaxation or automatic live deployment.
- [Ownership evidence availability follow-up](tickets/AUTH-ownership-evidence-availability.md): same-STEP evidence reuse under the unchanged five-second original-age limit, explicit sampling-frequency tradeoff, differentiated expiry/budget explanations and shared CLI/STEP guidance. Source-bound offline/native-copy proof stays in AUTH; actual loaded-Host/tool/App acceptance stays in the LIVE backlog.
- [T37 ownership admission](tickets/T37-server-ownership-admission.md): turn the implemented inspection into a real Host gate with scope/freshness/revocation proof; current core consolidation is scoped in S10/T43–T49 rather than reopening this historical implementation slice.
- [T38 identity alignment](tickets/T38-identity-write-alignment.md): retire implicit harness writes; preserve/block test2 before separately approved native calibration.
- [T39 native model roundtrip](tickets/T39-native-model-roundtrip.md): same-session official/A/B/official, durable native-state return and original-App journey.
- [T40 persistent release](tickets/T40-persistent-release-and-rollback.md): normal service lifecycle, scoped production release and distinct unpatched-Host exit, reusing T25/T28.
- [T41 continuous observation](tickets/T41-continuous-observation-and-alerting.md): local CLI/collector, incremental SQLite transactions, incident/Alert indexing and tested crash/maintenance boundaries are implemented. Persistent installation, current native Host qualification and external/client delivery remain separate gates; observation never grants admission.
- [单盒状态塑造、替身与交接 Spec S13](roadmap/box-runtime-impl-spec.md#ownership-continuity)：北极星是尽力保真恢复后新Bot边接活、程序/旧Bot边交接，持续监控旧入站直至条件式退役；[CONT-00–11全程规划](tickets/README.md#ownership-continuity)包含分档保护、默认暂停Routine、duplicate/clone/replace、唯一当前context和受管指令spawn。没有多session/跨机器；[CONT-02/11首个真实存储消费者](reports/2026-09-18-continuity-recovery-store.md)已通过限定的材料发布、保护、unknown去重与Node进程验证，[CONT-07当前状态协调](reports/2026-09-18-continuity-current-state.md)已补捕获/初始化/对账和Node故障验证，但官方原生binding未安装，完整产品链仍未交付；现场只看 [LIVE-OWNERSHIP-CONTINUITY及关联维度](tickets/LIVE-integration-validation.md#live-ownership-continuity)。
- [T42 upstream Host session lessons](tickets/T42-upstream-host-session-lessons.md): record of grok-bot-setup Host ABI pitfalls vs grokbox; not an S0 implementation ticket.
- [Host seam ops recognition](roadmap/host-seam-ops-recognition.md): forward-only upgrade recognition, private corpus replay, candidate review/publication and phased offline gates. Runtime SHA/literal application and separate adopt confirmation remain unchanged. [HCR-01–04](tickets/README.md#host-capability-recovery)实现必需桥能力观察、受控同源配方升级和显式操作元数据恢复；[离线回执](reports/2026-09-18-host-capability-recovery-offline.md)保留工具版本、独立review与未部署边界，现场只看LIVE。

- [原生 Bot 运维、故障证据与有界存储 Spec](roadmap/template-ops-automation-spec.md)：[OBS-00–06](tickets/README.md#incident-evidence)补最低证据、未知/无STEP入口、固定现场、分层脱敏、容量稳态与安全退役；T43–T56收口为默认单目标提醒、原生Routine及后续受托自主/维护。**接受设计，尚未交付；自动Issue退出，T52/T56延期。** [本轮决策](decisions/2026-09-18-observable-native-bot-ops.md)区分默认提醒与自主目标，[操作手册](maintainers/template-ops-automation.md)区分当前命令和规划。通知配对不是诊断/维护授权，关闭通知不关闭必要存储维护。

- [统一配置与命令面重建 Spec](roadmap/configuration-rebuild-spec.md)：AH-99/AH-100 + T57–T60 的两文件入口、config v2、canonical durable/alias、单一 writer、作用域与迁移合同。取代 ops-policy 第三配置与旧通用命令草案；运维业务仍归 Template Ops Spec。[设计取舍](decisions/2026-09-17-unified-configuration-rebuild.md)。配置实现与隔离验证见操作指南；现役迁移和 Reset 验收另归 LIVE 队列。

- [同通道模型推理设置](tickets/FEAT-model-reasoning-policy.md)：schema v2 assignment、capability gate、不可变 TURN 选择、最终 HTTP effort 校验与分层证据；[ADR](decisions/2026-09-17-model-reasoning-policy.md)说明版本切换与非目标。

## Cross-worktree live acceptance

**[LIVE — 现场集成验收唯一索引](tickets/LIVE-integration-validation.md)** 集中回答各维度已经验证什么、还缺什么、被什么阻断以及下一步。当前 live 进度只更新这张表；来源 Spec/Ticket 保留功能合同与实现/离线/review，maintainer 文档保留操作方法，日期 report 保留当次固定制品与原始结论，均回链对应稳定条目。默认验证已合入 `feat/box-runtime-v2` 的固定组合制品；索引不是重启、模型消费或发布授权，部分现场证据不豁免其他门禁。

## Roadmap

[Roadmap](roadmap/README.md) distinguishes current Spec/Tickets, the specialized HSO contract, [future product/extensions](roadmap/future/README.md) and [historical reports](reports/README.md). Web UI is accepted but not scheduled; its page/interaction contract lives in [future/webui-console](roadmap/future/webui-console.md). T41 monitoring/storage arrives before pages. Future presence is not permission or an implementation claim; old filenames retained as short redirects do not own content.

## Maintainers

- [持续观测与本地 incident](maintainers/continuous-observation.md): explicit monitor init/run, pure snapshot/event/incident queries, revision-bound ack/snooze, incremental disk SQLite transactions, failure/cursor recovery and automatic retention; local-only, no execution authority or automatic business replay.

- [运行结果与 App 警告观测](maintainers/run-outcome-observation.md): 金丝雀路径是 `send` + `history outcome --nonce … --runtime`；outcome 状态为 recorded/failed/progress/delivered/expected_result_observed/unknown，无 accepted 成功词；send 回执 `accepted` 只表示入队。

- [Source provenance review](maintainers/provenance.md)
- [Official Host inbound → Agent loop](maintainers/host-inbound-agent-loop.md): source-pinned admission, context/pins/compact, inference/tools, delivery, ledgers and settlement map; includes corrected research claims and explicit evidence gaps, not fix designs.
- [Host / App live projections](maintainers/host-app-projections.md): Bot-wide running, current-session Working/typing, named activity and per-message streaming are distinct scopes; generic Working does not require currentActivity. T36 is a required semantic gate, not a pixel-only residual.
- [持续 Working 诊断、停止与验收](maintainers/working-state-recovery.md)：分开父回合、原生监听子任务、外部 worker 与 App 发送状态；只读分流、授权停止、维护消息模板、跨有效期验收和复发边界。重启或父回合停止不代表后台子任务已结束。
- [Composer Working acceptance](maintainers/composer-working-status.md): current-session/run/generation, waiting/terminal/reconnect and original-App evidence. Host fields alone are insufficient; App patches or routine cache clearing are outside scope.
- [Transcript harness: box vs temporal](maintainers/transcript-harness-box-vs-server.md): implemented `agents ownership` reads official Server registrations through the native Host and classifies agreement/conflict/unknown; production send/read route ownership, CLI harness sampling, Host persist scope, and the actual desktop cached-restore/server-roster conflict. It affects App input as well as history; CLI-only success is not desktop qualification. Private source/versioned replay stays in private interoperability notes (not distributed) / `docs/24`; no private build dependency. Always-emit and persist still require the correct loaded Host artifact.
- [Official Host rollback acceptance](maintainers/official-rollback-acceptance.md): daily per-Bot official selection versus full unpatched-Host exit; native state, identity and original-App evidence, including loss of the inspection bridge. T40 closes implementation/operations; documentation does not execute rollback.
- [Managed context continuity](maintainers/managed-context-continuity.md): F/E safety and daily-pipeline acceptance; implementation partly exists and must be reused. Verifier supports/notProven distinguish proved source/packed subsets from pending full/native qualification; historical cause remains closed-notProven.
- [External PromptSession reference](maintainers/grok-bot-setup-session.md): bounded `grok-bot-setup` session-contract evidence; not product or architecture authority.
- [T32 旧 readiness 路由](maintainers/t32-live-enable-readiness.md)：只引导到 LIVE 和原有合同，不再承担当前候选、现场进度或发布结果账本；既有 compact 与新 CTX 验收分开登记。
- [E07 Path B Host admission](maintainers/e07-path-b-host-admission.md): D2-approved purpose slices and source/packed admission proofs; full E07/native qualification remains partial.
- [T29 command/API boundary incubate](maintainers/t29-command-boundary-incubate.md): shared commands/status/ConfigurationWrite inventory; browser still deferred, T41 observation DB allowed under its separate scope, no UI config SoT or speculative CAS.
- [Chat provider compatibility](maintainers/chat-provider-compatibility.md): MiniMax inline history, qualified continuation normalization, safe tool/schema witnesses, final delivery behavior, and separate offline/provider/native acceptance gates.
- [Publication privacy](maintainers/publication-privacy.md): full-history privacy gates, isolated validation, guarded branch-only publication, and remaining-copy limits.
- [Release runbook](maintainers/release.md)

Public bugs and proposals use [GitHub Issues](https://github.com/yoyooyooo/grokbox/issues). Security reports follow [`SECURITY.md`](../SECURITY.md). Machine-local execution notes, raw operational evidence, credentials, provider dumps, and private research do not belong in this repository.

## Authority

Current behavior is owned by source and executable tests. Product and architecture documents may describe accepted targets. Compatibility observations can invalidate assumptions but do not silently redefine product behavior.

The [2026-09-08 Host seam adjudication](decisions/2026-09-08-host-seam-normalization-and-roadmap.md) records binding normalization, patch-surface and execution-scope decisions. They are incorporated into the [strategy plan](roadmap/box-runtime-plan.md) and [implementation spec](roadmap/box-runtime-impl-spec.md); the ADR is not a second roadmap. The spec records this rebuild's explicit single-track policy without turning earlier POC implementation details into compatibility obligations.

## Freshness

统一配置 schema/根、bootstrap、支持 writer 版本、consumer revision、client/target scope 或模型新字段变化时，按 [配置重建失效条件](roadmap/configuration-rebuild-spec.md) 复核；不要用旧 parser 丢弃新字段或按新文件存在自动选择 SoT。

本地窗口/计量/摘要预算、Host安全点/root/队列、SDK编码、Pi包/exports/传递依赖/补丁/提取、Node基线或部署版本变化时，按[S12/CTX-R与CTX-A](roadmap/box-runtime-impl-spec.md#context-maintenance)重验；普通功能gate退场与注入隔离分别取证，旧T32成功或库能import均不签新的默认主动能力。

原生routine/模板复制/Payload/调用身份、证据字段与分类/关系算法、脱敏catalog、容量/保留/安全退役、目标模型/数据/费用/路由或用户授权来源变化时，复核[专项资格与失效条件](roadmap/template-ops-automation-spec.md#baseline)。模板配对不等于维护授权，通知只是默认提醒；后续用户决定公开的gh支路另行启动，不能恢复旧自动Issue默认。

Review the relevant current homes when any of these change:

- Gateway methods, schemas, discovery, generation, or token scope;
- Sandbox, quota, or desktop compatibility behavior;
- daemon protocol, filesystem/process policy, or network transport;
- Profile format, package layout, runtime requirements, license, or bundled dependencies;
- Host PromptSession/`SendToUser` contract, or box-runtime config root / local-only boundary;
- `runtime deactivate` / watchdog live-writer / official Host rollback path;
- Host `activity-bridge` / App coordinator Working chrome;
- Host `profile.harness` persist / always-emit / createSession managed path;
- Host Compact wait-point / `runStep` order vs custom-model overflow recovery.
