# Box-runtime tickets

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

[策略 plan](../roadmap/box-runtime-plan.md) 拥有 Phases 0–4；[单轨重建实施规格](../roadmap/box-runtime-impl-spec.md) 拥有唯一目标树、ports、执行与证明；**当前交付/施工顺序以 [Spec S0](../roadmap/box-runtime-impl-spec.md#stable-delivery) 为准**。原交付使用同一序列T20–T41，当前 modeld 执行核心扩展由下方 T43–T50 承接；T37–T40承接归属门、身份writer/test2、原生往返和持久发布，T41新增浏览器前的持续观测/SQLite/incident。R2的ME-*只作历史映射，不新增第二套进度账。源码/测试说明实现事实，Ticket 保存范围、缺口与关闭证据；open 不等于完全没有代码。

## Cross-worktree live acceptance — continuing ticket

**[LIVE — 现场集成验收唯一索引](LIVE-integration-validation.md)** 集中维护所有已登记维度的现场进度、具体未验项、阻断、下一步和日期回执链接。本页及各来源票只做路由，不复制当前 live 状态。功能实现、离线/打包资格和独立 review 留在来源票；操作方法留 runbook，固定窗口结果留 report。登记不授权部署，单项通过不关闭长期索引。

[W17 窗口及证据](LIVE-integration-validation.md#window-20260917)和 [Host reapply 修复对应的重启条目](LIVE-integration-validation.md#live-modeld-restart)均从该索引进入；修复实现与离线证明归 [FIX — Host lifecycle reapply](FIX-host-lifecycle-reapply.md)。

<a id="host-capability-recovery"></a>
## Host 必需能力与中断恢复 — HCR-01–04

[Spec §11](../roadmap/host-seam-ops-recognition.md#capability-recovery) 固定原 writer/controller 的补强合同：[HCR-01 配方与witness诊断](HCR-01-profile-and-witness-diagnostics.md) → [HCR-02 实际加载能力](HCR-02-loaded-capabilities.md)，[HCR-03 操作恢复](HCR-03-operation-recovery.md) 与 [HCR-04 受控能力升级](HCR-04-capability-profile-upgrade.md)。不放宽ownership gate，不引入第二注入路径；实现/离线/review归来源票，当前现场只看 [LIVE-HOST-CAPABILITY-RECOVERY](LIVE-integration-validation.md#live-host-capability-recovery)。

<a id="modeld-effect-core"></a>
## Current change — modeld execution-core consolidation

[Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) is the sole implementation home for this branch; [ADR](../decisions/2026-09-16-modeld-effect-core.md) records accepted boundaries. This new series consumes existing T24/T25/T26/T37/T40 implementation rather than reopening historical tickets or creating a parallel execution kernel. Original product/native/rollback gates remain in force.

| Milestone | Ticket | Progress (proof details stay in ticket) | Exit |
|---|---|---|---|
| M0 | [T43 authority/native baseline](T43-modeld-authority-baseline.md) | offline baseline verified / review pending | source/attribution matrix and executable baseline |
| M1 | [T44 service lifetime](T44-modeld-service-lifetime.md) | implemented / offline verified / review pending | one acquisition program; owned/borrowed/cleanup proof |
| M1 | [T45 evidence lifetime](T45-modeld-evidence-lifetime.md) | implemented / recovery integrated / independent review pending | typed evidence, shared source versus waiter, bounded demand/cancellation |
| M2 | [T46 state and durability](T46-modeld-state-and-durability.md) | implemented / offline verified / review pending | identity synchronization, claim-before-effect, bounded maintenance |
| M2 | [T47 authority state machine](T47-modeld-authority-state-machine.md) | core/v6 and single-deadline integration verified / independent review pending | same-STEP bounded wait, actual side-effect fences, one terminal |
| M3 | [T48 causal observation](T48-modeld-causal-observation.md) | implemented / Unix-journal-SQLite-CLI proof verified | causal wire/Host/CLI/monitor chain, diagnostic independence, packed/privacy |
| M4 | [T49 qualification/release](T49-modeld-qualification-and-release.md) | linearly integrated into v2 / combined offline tests passed / review pending / native-live unrun | separately proven policy/performance/native/review/live gates |
| Non-main-chain | [T50 review residue](T50-modeld-review-residue.md) | open process | append-only nonblocking re-look concerns; no auto-dispatch |

```text
T43 → T44 → T45 ──────┐
        └→ T46 ──────┴→ T47 → T48 → T49
                                   T50 (residue, not a dependency)
```

Each ticket owns its implementation/offline/review evidence; current live completion and remaining proof are maintained only in LIVE. This table is a route, not a copied test or live ledger. The [v2 integration receipt](../reports/2026-09-17-modeld-v2-integration.md) records the explicitly authorized rebase/fast-forward, source mappings and combined-candidate checks; the earlier [fixed-candidate report](../reports/2026-09-17-modeld-effect-core-offline.md) retains its own historical scope. All scoped verifier cases route to executable suites; unknown or missing cases still fail. Offline implementation, source integration, independent review, native qualification and live release are distinct. Source integration did not push or switch Host/modeld; the continuing [LIVE ticket](LIVE-integration-validation.md) retains the actual pending native/live gates.

### Follow-up — ownership evidence availability

[AUTH — ownership evidence availability](AUTH-ownership-evidence-availability.md) owns the post-core same-STEP evidence reuse, finite expiry/budget explanations and shared CLI/STEP guidance. It retains the five-second original-age limit and explicit observation-frequency tradeoff under policy v2. Its `verify:modeld-core availability` suite is included in `release-offline`. The feature is now linearly integrated and reverified in v2; the [integration receipt](AUTH-ownership-evidence-availability.md#v2-integration-receipt) records unchanged commit mappings and proof boundaries. Code-review obligations remain non-live, and feature-scoped native/tool/App acceptance remains blocked in LIVE. The ticket, not this index, owns source-bound test counts and remaining gates.

<a id="context-maintenance"></a>
## Current implementation — Pi组件复用与本地上下文维护（CTX-00–CTX-04）

**默认Box会话主链已实现，源码/制品及固定原生隔离证明已记录；独立review与现场采用分开。** 实现 `883e224`、读回 `269f1e2`、连续迁移 `358c057`、TURN credential/lifecycle `f4b3a18`，详见[固定离线报告](../reports/2026-09-17-context-maintenance-offline.md)。[主Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)是唯一实施合同，[ADR](../decisions/2026-09-17-local-context-maintenance.md)固定默认自动、Host写入及复用优先，[Pi参考](../maintainers/pi-compaction-reference.md#core-package-reuse)区分0.85.1 core公共API与coding-agent用户行为。CTX-00已根据公共API/serializer/Node差异选择受控Pi纯代码提取；后续升级仍遵循公共包→最小补丁→提取→有证据局部重写，不另写平行Agent。首要出口是已有失败长会话的下一条普通输入：先按本地128K检查/compact，再处理这条新消息一次，无需新Bot/手动清理/再撞provider。功能编号不占用并行T序列。

| Milestone | Ticket | Start / exit |
|---|---|---|
| M0 | [CTX-00 Pi组件复用资格](CTX-00-pi-compaction-reuse.md) | 先固定公共API/请求桥/序列化/Node/制品/许可，CTX-R01–R07决定单一采纳路线 |
| M1 | [CTX-01 本地策略与计量](CTX-01-context-policy-and-meter.md) | CTX-00选定算法＋统一配置/模型选择；config3、独立窗口、估算适配、策略pin |
| M2 | [CTX-02 Host维护owner](CTX-02-host-context-maintenance.md) | CTX-01；安全点/operation、pending并发、候选验证/接受、取消与checkpoint回读 |
| M3 | [CTX-03 有界摘要与恢复](CTX-03-bounded-summary-and-recovery.md) | CTX-00/02；集成真实Pi生成及最小策略差异，同模型独立请求、分段预算、T32合流 |
| M4 | [CTX-04 入口与完整证明](CTX-04-context-entrypoints-and-proof.md) | CTX-00–03；真实算法的CTX-R与CTX-A01–A15、Node制品/CLI、旧gate退场及分层发布 |

T32保留既有零放行/一次额外主请求合同，T35保留原生寿命与旧未证范围；新实现差额由本系列承接，不再平行排一份compact施工队列。模型仍schema2/独立writer；当前源码config3/wire8，已有config2安装需要显式迁移和匹配制品采用，不能以代码保存冒充已生效。T30 Pi backend、完整WebUI、后台预生成和更多摘要模型不是前置。

主链CTX-00→CTX-01→CTX-02→CTX-03→CTX-04；配置/用户入口反例可先并行准备，但算法实现先过M0。Node最低版本仍为项目当前合同，采纳包的engine差异须显式解决，不能在文档中暗升Node或下载依赖。当前代码、有限verifier和命令均已存在，原生范围与实际测试证据归来源票。review请求503没有独立结论，不改成live-only；现场三个CTX条目的进度只在LIVE。旧会话恢复仍不可由新建短会话回复或仅一条摘要替代。

### 独立候选 — pi-ai 模型传输

[PI-AI-01](PI-AI-01-model-backend-qualification.md) / [Spec S6.2.1](../roadmap/box-runtime-impl-spec.md#pi-ai-qualification)研究进程内pi-ai能否在同一ModelBackend后替换当前AI SDK。它不是T30的Pi RPC Agent backend，不阻塞CTX，不默认切换生产、双真实请求或另造model/credential store。core的传递依赖出现pi-ai不等于选用了其Provider执行。资格/Node/性能/维护差异有明确采纳提案与独立review，切换与live另行批准。

<a id="ownership-continuity"></a>
## 单盒 Bot 状态塑造、替身与交接 — CONT-00–11

[Spec S13](../roadmap/box-runtime-impl-spec.md#ownership-continuity)是唯一实施合同，固定保真尽力而为、新替身接活同时机械/旧Bot辅助交接、持续观察旧入站直至条件式退役。单Bot长期Memory身份只保留一份当前工作上下文，不建sessions、不做跨机器。**CONT-00历史8探针及CONT-02/11真实恢复存储/安全意图的部分实现已有；完整产品链仍未交付。** [首个真实消费者报告](../reports/2026-09-18-continuity-recovery-store.md)固定114项离线/独立进程/J1接线证明，未证明原生Bot恢复或live。

| 阶段 | Ticket与具体出口 |
|---|---|
| M0 | [CONT-00 原生资格](CONT-00-native-clone-feasibility.md)＋[CONT-11 策略/逐职责合同](CONT-11-policy-and-operation-contract.md)：最小公共类型、权限和原生能力资格 |
| M1并行 | [CONT-01 发现/暂停/通知](CONT-01-ownership-loss-notification.md)、[CONT-02 分档材料](CONT-02-continuity-snapshots.md)、[CONT-06 原生duplicate](CONT-06-native-duplicate-cli.md)：独立保护和基础能力先交付 |
| M2 | [CONT-07 唯一当前上下文](CONT-07-current-context-control.md)→[CONT-03 状态clone](CONT-03-native-box-clone.md)：原生初始化/重置/恢复、持久读回和真实新身份续接 |
| M2b | [CONT-08 初始指令与临时spawn](CONT-08-instructed-spawn.md)：公共内核的独立消费者，不阻塞已合格替身主线 |
| M3 | [CONT-04 逐职责接替](CONT-04-automatic-replacement.md)＋[CONT-09 机械/辅助关系交接](CONT-09-relationship-handover.md)：新旧并行、群/DM/Routine/job与handoff投影 |
| M4 | [CONT-10 旧入站与退役](CONT-10-inbound-convergence-retirement.md)：健康覆盖/收敛/依赖/安全删除及多代替身 |
| M5贯穿 | [CONT-05 北极星验收](CONT-05-continuity-acceptance.md)：全部接受范围的source/packed/native/App/通知/重启和日用存储 |

依赖细节、完整矩阵和禁止事项以[S13.8](../roadmap/box-runtime-impl-spec.md#continuity-delivery)为准，不把阶段交付说成整项关闭；实现、离线、独立review归来源票。所有当前现场状态仅在[LIVE-OWNERSHIP-CONTINUITY及关联维度](LIVE-integration-validation.md#live-ownership-continuity)，通知复用OBS/Template Ops，Routine复用T53，不等待整套恢复才发布感知。

## Prior delivery baseline — 2026-09-12 documentation governance

**已定边界：Server归属优先；不改官方App；同Box会话换模型不换harness；test2仅冲突样本。** 查询已存在，执行门/可逆日用/全卸载不能据此算完成。现场缺口与日期证据统一从 [LIVE](LIVE-integration-validation.md)进入，历史计数留原来源票/报告；本页不复制产物和当前验收表。

| 顺序 / owner | 当前实现基础与真正差额 | 下一责任 / 退出条件 |
|---|---|---|
| 1 · [T37 Server归属准入](T37-server-ownership-admission.md) | 共享判定已进production kernel/modeld与模型配置；source真实Unix拒绝/时效/恢复fence已过 | 原生scoped读取、迁移屏障、完整packed及独立review；未部署不冒充现役门 |
| 2 · [T38 身份写入/校准](T38-identity-write-alignment.md) | CLI更新/创建确认已有；候选已移除五个身份写入slice并拒绝旧profile | source退场未部署；先原生gate资格/冲突保全，再新profile；test2现场不动 |
| 3 · [T24 可逆选模](T24-runtime-route-binding.md) | 单Botroute reset/旧TURN保留已有；不可读配置和无资格no-STEP不再默回official | 当前候选部署、原生官方回程与实际生效观测；不拿保存回执当生产成功 |
| 4 · [T39 原生往返](T39-native-model-roundtrip.md) | public选择纵切＋固定原生消费者/packed adapter五进程往返隔离资格 | 原生blob/checkpoint writer与当前版本/真实模型/App；owned JSON不签原生持久化 |
| 合流 · [T26](T26-runtime-host-fullstream.md) / [T32](T32-runtime-confirmed-compact.md) / [T35](T35-host-compact-wait-point.md) | 流/恢复/摘要/错误安全已有子集；不得重做或丢失旧证明 | 分别补原生消费者、真实恢复、pending-background/outer retry；交T39 |
| 必需 · [T36 Working](T36-composer-working-activity.md) | 原App谓词已理解、producer桥部分已证；完整UI语义未证 | 当前session/run/代一致，失败/取消/迟到/重连不假busy；不是后置美化 |
| 5 · [T40 持久服务与发布](T40-persistent-release-and-rollback.md) | start实际CLI/Unix与Node制品start→borrow→orderly restart已证；listener丢失结算、T27同数据根status已补，固定全仓见来源票/日期报告 | 继续受支持持久owner/安装自启、T37/T38当前原生资格与保全、T39 checkpoint和现场；不重复修占位，不把前台重启当整机恢复 |
| 并行 · [T41持续观测](T41-continuous-observation-and-alerting.md) | 首片已落地：显式前台批量采集、真实SQLite镜像、事件/incident分页、ack/snooze与冷Node读写 | 补安全crash锁恢复、维护/共享优先调度与通知receipt；T40安装自启/live scoped桥仍待，DB不决定准入 |
| 延后 · [T29及future](../roadmap/future/README.md)、T30/31/33扩展 | 浏览器、多盒/高级通知、更多backend不是先决条件 | 各未来页有晋升门；不把T41与安全准入一起拖到Web UI |
| 记录 · [T42 外部Host会话坑](T42-upstream-host-session-lessons.md) | grok-bot-setup 对照：已对齐的 ABI 坑 vs 换 Provider/隐私模式再展开 | 不进 S0 主链；不授权改补丁形态或整盒开关 |

**依赖图（实施不是等待所有旧票重关）：**

```text
T37 → T38 → T24选择差额 → T39 ──────────────┐
              T26 / T32 / T35 → T39        ├→ T40最终生产签署
                    T36(V24) → T39        │
           T25 / T28 → T40隔离服务/退路 ──┤
           T37事实 → T41最小监控/incident ┘
                      └→ T29未来页面（独立排期）
```

T41与T38/T24/T39可并行，其collector复用T25/T40服务能力但不等整票发布；T37不依赖SQLite/incident/通知，T29不反向阻塞T41。T39夹具、T24单元、T40服务隔离可提前按当前程序开发；真实使用遵守相应准入前置。T39不等待T40整票Done，T37不等待T38，避免循环依赖。共享文件一个writer；先固定候选再验证/集成，不让多Agent同时更新dist污染证据。

新增verifier case有已实现子集和仍规划的完整门：[Spec S9.1.1](../roadmap/box-runtime-impl-spec.md#ownership-release-proof)列出真实oracle与未实现状态。Ticket Done仍需本范围实现/负例/独立review；Release还需原版App、真实模型、持久状态与退路证据，不能由某个case绿直接升级。

### 本轮旁支语义核对与收口

删除 worktree 与吸收提交是两件事；先核对 dirty/untracked/活跃引用，再保全/清理。不删除主仓库 Git 数据和 v2 工作树。

| 旁支 | 已核对的内容事实 | 收口条件 |
|---|---|---|
| `feat/t32-live-enable` @ `9d9e7e9` | GATE/env 已 patch-equivalent；`e2af2b1` 历史解锁不是新授权 | 当前 GATE 回归；保留历史引用后清理 |
| `feat/t32-host-control-frames` @ `592cd27` | WIRE_VERSION pin 已 patch-equivalent | 当前回归；不复活 late-register 正确性假设 |
| `feat/agent-export` @ `5c20378` | **已由 `pre-publication-revision` port 到 `packages/cli`**；两个生产文件逐字相同，测试仅改用 canonical EXIT_CODES；包括 sand-data 修复 | export 回归后清理；不重复 cherry-pick，不引回 root src |
| `feat/t32-ccs-overflow` / `feat/t32-live-enable-readiness` / `feat/t32-v4-cutover` | 本轮 `HEAD..branch` 均为 0；无独立提交 | 仍须确认活跃使用/引用后清理 |
| 旧 `feat/box-runtime` / main 工作面 | 旧 runtime 有 dirty/untracked POC；main 有 staged 变更，不能强删 | 审查实际差额并保全可恢复本机快照；不把私有草稿塞入公开产品代码 |

本节为当前收口入口，不将 branch 数量作为稳定发布门。2026-09-13本窗口正常Git写入口可用：V2的203文件继承成果已保存私有完整快照，并经固定验证提交为`pre-publication-revision`；早先Git写入受限属于历史，不再作为当前阻塞。主仓库 + 4 个linked worktree尚原样保留；main的15个staged及old-runtime的14项dirty/untracked未覆盖。现役modeld只引用保留的V2路径，Host使用原生路径；其它工作树的保全/清理仍须完成，不据此宣布已删除。

## 同通道模型推理设置

[FEAT-model-reasoning-policy](FEAT-model-reasoning-policy.md) 拥有本 feature 的代码、离线验证和复审出口，Spec S11/ADR 已归位；原生 Provider/App/成套切换只由 LIVE 对应条目记录。使用功能命名空间，不抢占并行 worktree 的 T 编号。

## Rebuild ticket allocation / formal closeout

下表保留原票的正式关闭状态，不据已有文件批量改成 Done，也不再声称“全部未实现”。Done 必须满足该票 executable proof 与独立复审；offline Done 不等于 live-qualified。当前实现进度和发布缺口见上表及各 owning ticket。

| id | status | phase | scope |
|---|---|---|---|
| [T20](T20-runtime-layout-cut.md) | open | 0 | 骨架/package/import cut，撤旧入口与 proof runner |
| [T21](T21-runtime-codec-fidelity.md) | open | 0 | Host/CCS codec 输入保真：A3fu/A7 |
| [T22](T22-runtime-raw-output.md) | open | 0 | 独立关闭默认 raw Host fd：A6；保留 T12 |
| [T23](T23-runtime-model-backend.md) | open | 1 | 一个 Effect ModelBackend/auth port；AI SDK + Fake/echo |
| [T24](T24-runtime-route-binding.md) | partial / open closeout | 1 active | RouteBinding已有；逐Bot官方/A/B选择与当前TURN捕获差额 |
| [T25](T25-runtime-effect-root.md) | open | 1 | 长寿命 Effect root/A9/v3 Unix transport |
| [T26](T26-runtime-host-fullstream.md) | open | 1 | A8 Host fullStream/双向端到端整合 |
| [T27](T27-runtime-status-facets.md) | open | 1 early | T13 最小 facets/J13 角色，主排期 T21 后立即做 |
| [T28](T28-runtime-controller-cut.md) | open | 1 | 单 Controller program/安全 IO/整合与占位清零 |
| [T29](T29-runtime-webui.md) | open | 2 deferred | CLI/API 共享命令边界、第二 writer CAS；浏览器 MVP 另标 deferred，非 T28 后默认施工 |
| [T30](T30-runtime-pi-backend.md) | open | 3 | pi RPC 独立 qualification 与 adapter |
| [T31](T31-runtime-cursor-backend.md) | open | 3 | Cursor SDK 独立 qualification 与 adapter |
| [T32](T32-runtime-confirmed-compact.md) | partial | 4 active | 内核/v4 已有；期限/新窗口/真实稳定恢复差额 |
| [T33](T33-runtime-diagnostics.md) | open | 4 | source-scoped 深层诊断与 delivery gaps |
| [T34](T34-astra-milestone-residue.md) | open | process | Astra 里程碑终审残留积累；不交 grok 主链；owner 最终审视 |
| [T35](T35-host-compact-wait-point.md) | in progress | 4 active | 已授权实施：provider 前 scope、摘要协调/接受 fence、native retry |
| [T36](T36-composer-working-activity.md) | open | required product | V24当前会话Working/typing/streaming同源与结束语义 |
| [T37](T37-server-ownership-admission.md) | partial | active | Server共享判定/source准入已接；原生/packed/现场仍待资格 |
| [T38](T38-identity-write-alignment.md) | partial | follows T37 | CLI更新/创建确认已接；Host writer退场/test2保全校准仍未执行 |
| [T39](T39-native-model-roundtrip.md) | open | integration | 官方/A/B/官方原生持久回程、真实App、cache正确性 |
| [T40](T40-persistent-release-and-rollback.md) | open | release/lifecycle | 持久服务、两种回官方、限定生产合取与安全退场 |
| [T41](T41-continuous-observation-and-alerting.md) | open / local vertical slice | pre-WebUI | 共享采集/变化、单盒SQLite观察与管理事实、incident/通知、cursor/故障边界 |
| [T42](T42-upstream-host-session-lessons.md) | record / incubate | not S0 | grok-bot-setup Host 会话坑记录；已对齐项不重做，Redacted/tool-id/内部 model id 待撞上再展开 |

原重建依赖链 **T20 → T21 → T27 → T23 → T24 → T25 → T26 → T28** 不要求重做已有实现；当前主链见 Spec S0.5。T22 不 gate 保真/内核。T27 尽早。Phase 1 出口停在 T28；T29 不自动开工。T30/T31 的资格失败只阻塞本 adapter，不阻塞 T32/T33。Astra 复审/授权边界统一见[规格 S9](../roadmap/box-runtime-impl-spec.md#review-live)。里程碑「审→修→复看→交 grok」之后的异步终审残留只进 [T34](T34-astra-milestone-residue.md)，不交 grok。

<a id="incident-evidence"></a>
## 故障证据与有界存储 — OBS-00–06（2026-09-18）

**全部Planned / Spec-only，不重开T41或modeld已完成切片。** 唯一合同为[Template Ops Spec](../roadmap/template-ops-automation-spec.md)，[本轮决策](../decisions/2026-09-18-observable-native-bot-ops.md)固定默认提醒/受托自主/有界保留。新编号只承担本轮增量；source/tests决定实现事实，LIVE决定现场资格。

| 阶段 / Ticket | 唯一职责 | 前置 / 出口 |
|---|---|---|
| M0 [OBS-00](OBS-00-evidence-contracts.md) | E01–08最低字段、真实边界/关系/缺口与覆盖矩阵 | 原Host/modeld/context事实；不只新增JSON字段 |
| M1 [OBS-01](OBS-01-incident-intake-and-detection.md) | 未知tray/queue failed/无STEP与未收束检测、同库incident | OBS-00；真实异常不得只进evidence不触发 |
| M1 [OBS-02](OBS-02-incident-evidence-snapshots.md) | 不可变manifest、同源查询、真实可用取证命令 | OBS-00/01；Gateway不可用/日志轮转仍诚实可查 |
| M1 [OBS-03](OBS-03-evidence-privacy-views.md) | local/Bot/public视图、隐私非干扰与诊断价值 | OBS-00，和OBS-02联合接线；实际网络bytes检查 |
| M2 [OBS-04](OBS-04-bounded-observation-storage.md) | 全安装诊断预算、fd轮转、DB/证据GC和租约 | OBS-00/02及T51合同；物理空间稳态而非只删行 |
| M2 [OBS-05](OBS-05-safe-state-retirement.md) | 原执行owner安全遗忘、恢复/制品引用与退役 | OBS-00/原owner；GC后旧ID/unknown不复活 |
| M4 [OBS-06](OBS-06-integration-and-soak-proof.md) | source/packed/真实DB/故障注入/稳态组合证明 | OBS-00–05与最小通知链；不假签原生/live |

先冻结OBS-00/T51/T43/T54合同，再并行M1与Routine；M2存储是完整首发门，M3通知可先做离线集成。完整DAG与限定预算只在[Spec §11](../roadmap/template-ops-automation-spec.md#tickets)。现场引用[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)、[STORAGE](LIVE-integration-validation.md#live-obs-storage)、[SAFE-RETIREMENT](LIVE-integration-validation.md#live-obs-safe-retirement)，不在本索引复制进度。

<a id="template-ops-automation"></a>
## 原生 Bot 通知与自主运维 — T43–T56（2026-09-18收口）

[专项Spec](../roadmap/template-ops-automation-spec.md)及[主Spec S0.1.5](../roadmap/box-runtime-impl-spec.md#template-ops-automation)明确：默认固定现场后发到配置Bot，Bot只提醒；用户委托后可自主操作并验收。自动Issue退出，T52/T56延期；[维护手册](../maintainers/template-ops-automation.md)严格分当前命令与目标命令。

| Ticket | 状态 / 范围 | 依赖与独立退出 |
|---|---|---|
| [T43](T43-native-webhook-contract.md) | Partial：固定源函数隔离资格已跑；真实HTTP/认证/配对/提醒仍未证 | 与OBS-00/T51并行，为T53/T45提供合同 |
| [T44](T44-host-ops-continuous-sensing.md) | Partial：本地drain与慢RPC隔离；HSO/loaded/component接线仍待完成 | OBS-00/01、T51；不等诊断或Webhook |
| [T45](T45-template-webhook-delivery.md) | Planned：持久outbox、固定证据、原生投递/unknown | OBS-02/03、T43/T51/T54；不等Issue/维护 |
| [T46](T46-template-ops-pairing.md) | Planned：配对、只提醒入口、独立ledger模板 | T43/45/51/53/54；模板不永久限制自主能力 |
| [T47](T47-bounded-ops-diagnosis.md) | 独立后续A：受托自主排障/换模与验收 | 证据/权限底座；不反向阻塞默认提醒 |
| [T48](T48-low-risk-host-qualification.md) | 独立后续M：全切片/依赖等价资格 | 原HSO/qualification；不是首发通知门 |
| [T49](T49-policy-host-maintenance.md) | 独立后续M：唯一controller、排空/交接/恢复 | T48/T47/T51与原控制程序 |
| [T50](T50-template-ops-release-proof.md) | Planned：服务常驻与分lane原生验收 | 首发OBS+单目标；自主/维护分别签署 |
| [T51](T51-ops-capability-presets.md) | Partial：schema4共享storage意图、2/3迁移及support退役、monitor/process/journal采用 | 复用T57–T60；全安装物理预留/统一applied、自启与成套现场仍未完成 |
| [T52](T52-consented-support-issues.md) | **Deferred**：用户决定后的草稿 | 不属于首发，不再默认询问Issue |
| [T53](T53-agent-routines-cli.md) | Partial：list/show/enable/disable/delete与按需Skill；apply/provision/invoke/outcome待完成 | 只依T43，不要求ops开启；local/daemon共享程序 |
| [T54](T54-ops-targets-and-routing.md) | Planned：单目标先行、有限路由后置 | T51/T43/T53合同；最小模式独立出口 |
| [T55](T55-custom-receiver-delivery.md) | 所选目标最小资格必需；高级备用/交接后置 | T54/T45/T53；unknown不广播 |
| [T56](T56-scripted-issue-publishing.md) | **Deferred**：未来gh-only用户发布 | 无认证就跳过，不建设自动发布平台 |

所有新增命令/测试路径在实现后才注册；规划不授予实际安装、费用、原生对象写入、清理或模板发布权限。CONT-01消费同一通知链，CONT-02恢复快照遵循自己的私有引用闭包，不与诊断报告混用。

<a id="configuration-rebuild"></a>
## 统一配置与命令面 — T57–T60（AH-99 / AH-100）

**配置实现和离线/打包验证已落地，独立复审与生产切换仍待。** [配置指南](../configuration.md)描述当前可运行命令；[统一配置 Spec](../roadmap/configuration-rebuild-spec.md)拥有数据、作用域、writer 和恢复合同。当前证据不包含实际 Reset、现役服务迁移或原生运维 worker。

| Ticket | 映射 | 交付 |
|---|---|---|
| [T57 schema/布局](T57-unified-config-schema-layout.md) | AH-99 | config v2 聚合 Profiles/daemon/desktop/runtime/ops；models 独立无损；偏好与授权/机器状态分离 |
| [T58 命令/唯一 writer](T58-config-command-single-writer.md) | AH-100 + AH-99 写入面 | 顶级 config、路径/schema/权限、锁/CAS、全领域 writer、saved/applied 与 scope |
| [T59 迁移/退旧](T59-config-migration-cutover.md) | AH-99 | 显式计划/旧 writer fence、partial 恢复、别名/冲突、bootstrap 和新版 consumer |
| [T60 集成验收](T60-config-ops-integration-proof.md) | 两票配置工程 | 已注册 config-unification 验收器；顶级 models、schema/领域写入、按域失效、skills 与 Node package；运维 worker/现役切换独立 |

运行 `bun scripts/verify-runtime-rebuild.mjs config-unification` 复验 T57–T60 的配置链。T51/T54 消费 config.ops 的已实现 schema 和提交程序，T43/T53 原生 Routine 独立实施；保存偏好不代表后续执行能力已经启用。模型 parser/secret 路径保持，Host 不读取 ops；floor/minIdle 行为未改变。配置现场验收分别索引到 [CUTOVER](LIVE-integration-validation.md#live-config-cutover)、[CONSUMERS](LIVE-integration-validation.md#live-config-consumers) 和 [HOME-RESET](LIVE-integration-validation.md#live-config-home-reset)，复审等非 live 阻断保留在来源票。

## Historical delivery and product-scope trackers

以下 done/partial 历史保持原意义，不意味着重建已通过同样证明，也不要求保留 POC 的内部代码。旧 open 票为产品范围入口，执行已转给新票据。

| id | status | title / rebuild routing |
|---|---|---|
| T0 | superseded | 旧 tracker/sequencing 已由实施规格与本索引接替，不另开实现票 |
| T1 | done | Host full-bundle provenance + diff + patch impact |
| T2 | done | Land offline STEP-slot / envelope seam work |
| T3 | done | Live G1: grokbox test0 luna bubbles; T12 official bots/create-bot |
| T4 | done | Real model A+S1 inside modeld |
| T4b | done | AI SDK OpenAI chat+responses driver (sub2api baseURL) |
| T4c | done | Default modeld composite stub∪openai admit + minimal C1 |
| T4d | done | Route activate admits openai* (offline) |
| T4e | done | Route Host/preload session modelId follows models.json |
| T5 | split | T5a done / T5b framing done；重建 stream 由 T25/T26 关闭 |
| T5a | done | C1 credentials productization (modeld Effect seam) |
| T5b | framing done | 历史 Unix framing；重建 T25/T26 不保留旧 wire |
| T6 | done | Unified runtime start facade (ensure modeld/watchdog + activate) |
| T7 | done | Prove official replacement via Gateway pid |
| T8 | done | Offline CCS sub2api recipe; spend superseded by T9 / test0 luna |
| T9 | done | Live CCS modeld smoke (luna + grok Responses) |
| T10 | done | Per-Bot official passthrough (selective route) |
| T11 | done | Pre-dispatch official passthrough + STEP-correlated visible errors |
| T12 | done | Adopt preserves official Host renewer env (create-bot / other bots) |
| [T13](T13-status-honesty-after-adopt.md) | open | 产品范围；执行 T27/T33 |
| T14 | observation done | 历史 enums-only observation；当前分类/恢复执行 T23/T32 |
| [T14b](T14b-host-reuse-compact-on-confirmed-overflow.md) | open | 产品范围；执行 T32，不能拿 T14 的 done 当恢复授权 |
| [T15](T15-webui-ops-config-storage.md) | open | 产品范围；执行权在 T29 边界合同，浏览器 MVP deferred |
| [T16](T16-model-backend-adapters-pi-cursor.md) | open | 产品范围；基础 T23，候选实现 T30/T31 |

## Live canary bots

Stable ids（App名称会变）。下表是最新角色，不从名称推断归属。模型opt-in由`assignments.agents[id]`决定，Server harness决定是否有本地执行资格，两者不得混为一件事；后续每个窗口重验归属。missing key的合法未配置路径为official，不继承main，不把损坏配置当明确official。

| App name | id | route boundary |
|---|---|---|
| grokbox test0 | `00000000-0000-4000-8000-000000000114` | Server/local box已查；正向候选，窗口内重新确权/核验模型 |
| grokbox test2 | `00000000-0000-4000-8000-000000000115` | Server temporal/local box冲突；仅T38保全/诊断/本地拒绝，不再heavy正例、不从App发任务验门 |
| grokbox test1 | `00000000-0000-4000-8000-000000000113` | Server/local box已查；保持未opt-in官方负对照 |
| 另一个批准Box测试对象 | 创建确认后记录，不预造ID | 仅在明确批准创建、Server回读box后承担多managed/B模型资格，不默认使用业务Bot |

A1/A2/A4 在 POC 源码已关闭，A3 tool-role 修复已存在；A3fu/A5–A10 是研究缺口标签，不是第二执行系统。所有 live adopt、provider spend、额外 Host patch 与旧文件/fd 处理均需独立授权；docs/离线 green 不授予这些权限。
