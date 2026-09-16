# Documentation Map

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

This documentation separates source truth, accepted contracts, interoperability facts, future candidates and dated evidence. The repository keeps its established Product/Architecture files and maintainers/decisions/tickets homes; roadmap retains the active Spec/strategy, `roadmap/future/` owns unstarted product extensions, and `reports/` owns historical explanations. No new synonym documentation tree is introduced.

## Current homes

- [Agent 操作入口](../skills/grokbox/SKILL.md)：默认只读小入口，以 `grokbox skills get grokbox --topic <name>` 按能力展开；Host 恢复、运行时诊断与 canary 验收不进入模板启动正文。[分层与维护约束](product-contract.md#15-bundled-skills)由入口预算、主题清单、链接和安装包测试保护。
- [Product contract](product-contract.md): commands, Profiles, capabilities, output, and security boundaries.
- [Architecture](architecture.md): modules, transports, daemon, Sandbox, and verification boundaries.
- [Compatibility](compatibility.md): unofficial status, stability classes, trademarks, and revalidation policy.
- [Upstream integration](upstream-integration.md): minimum interoperability facts required by the implementation.
- [Sandbox control plane](cursor-sandbox-control-plane.md): lifecycle terminology, trust separation, and validation requirements.
- [Quota](quota.md): implemented explicit source, normalized output, and failure boundary.
- [Box-local model runtime](box-runtime.md): accepted createSession seam, inject/watchdog/guardian, modeld, window semantics, and evidence ladder. Not an implementation-complete claim. Product obligations are in the [product contract](product-contract.md) §12.
- [Box-runtime strategy plan](roadmap/box-runtime-plan.md): Phases 0–4, product exits and scope.
- [Managed Compact evolution](reports/2026-09-12-managed-compact-evolution.md): historical reasons and rejected alternatives; not a current plan or permission. Old brief/path links now route here.
- [Box-runtime Current Implementation Spec](roadmap/box-runtime-impl-spec.md): **S0 owns Server-authoritative, Host-only stable delivery and V01–V30**; [S9.1.1](roadmap/box-runtime-impl-spec.md#ownership-release-proof) lists planned proof cases, not existing commands. [Tickets](tickets/README.md) route T37→T38→T24→T39→T40 alongside existing stream/compact/Working mechanisms. No parallel ME spec or implementation-complete claim.
- [Modeld execution-core Spec S10](roadmap/box-runtime-impl-spec.md#modeld-effect-core): one Effect service/STEP program, source-versus-waiter lifetime, durable identity and bounded authority waiting. [T43–T50](tickets/README.md#modeld-effect-core) own implementation exits; [ADR](decisions/2026-09-16-modeld-effect-core.md) and [boundary audit](maintainers/modeld-authority-boundaries.md) distinguish necessary integration, self-introduced problems and unproven native coverage. No default freshness relaxation or automatic live deployment.
- [T37 ownership admission](tickets/T37-server-ownership-admission.md): turn the implemented inspection into a real Host gate with scope/freshness/revocation proof; current core consolidation is scoped in S10/T43–T49 rather than reopening this historical implementation slice.
- [T38 identity alignment](tickets/T38-identity-write-alignment.md): retire implicit harness writes; preserve/block test2 before separately approved native calibration.
- [T39 native model roundtrip](tickets/T39-native-model-roundtrip.md): same-session official/A/B/official, durable native-state return and original-App journey.
- [T40 persistent release](tickets/T40-persistent-release-and-rollback.md): normal service lifecycle, scoped production release and distinct unpatched-Host exit, reusing T25/T28.
- [T41 continuous observation](tickets/T41-continuous-observation-and-alerting.md): local CLI/collector, incremental SQLite transactions, incident/Alert indexing and tested crash/maintenance boundaries are implemented. Persistent installation, current native Host qualification and external/client delivery remain separate gates; observation never grants admission.
- [T42 upstream Host session lessons](tickets/T42-upstream-host-session-lessons.md): record of grok-bot-setup Host ABI pitfalls vs grokbox; not an S0 implementation ticket.
- [Host seam ops recognition](roadmap/host-seam-ops-recognition.md): forward-only upgrade recognition, private corpus replay, candidate review/publication and phased offline gates. Runtime SHA/literal application and separate adopt confirmation remain unchanged.

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
- [T32 live-enable readiness](maintainers/t32-live-enable-readiness.md): current candidate/artifact evidence, scoped experience vs stable checkpoints, normal persistent enable vs fault injection, and install/exit gates. Historical GATE permission is not standing global rollout authorization.
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
