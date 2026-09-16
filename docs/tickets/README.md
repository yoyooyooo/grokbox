# Box-runtime tickets

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

[策略 plan](../roadmap/box-runtime-plan.md) 拥有 Phases 0–4；[单轨重建实施规格](../roadmap/box-runtime-impl-spec.md) 拥有唯一目标树、ports、执行与证明；**当前交付/施工顺序以 [Spec S0](../roadmap/box-runtime-impl-spec.md#stable-delivery) 为准**。施工使用同一序列T20–T41；T37–T40承接归属门、身份writer/test2、原生往返和持久发布，T41新增浏览器前的持续观测/SQLite/incident。R2的ME-*只作历史映射，不新增第二套进度账。源码/测试说明实现事实，Ticket 保存范围、缺口与关闭证据；open 不等于完全没有代码。

<a id="modeld-effect-core"></a>
## Current change — modeld execution-core consolidation

[Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) is the sole implementation home for this branch; [ADR](../decisions/2026-09-16-modeld-effect-core.md) records accepted boundaries. This new series consumes existing T24/T25/T26/T37/T40 implementation rather than reopening historical tickets or creating a parallel execution kernel. Original product/native/rollback gates remain in force.

| Milestone | Ticket | Initial state | Exit |
|---|---|---|---|
| M0 | [T43 authority/native baseline](T43-modeld-authority-baseline.md) | in progress | source/attribution matrix and executable baseline |
| M1 | [T44 service lifetime](T44-modeld-service-lifetime.md) | planned | one acquisition program; owned/borrowed/cleanup proof |
| M1 | [T45 evidence lifetime](T45-modeld-evidence-lifetime.md) | planned | typed evidence, shared source versus waiter, bounded demand/cancellation |
| M2 | [T46 state and durability](T46-modeld-state-and-durability.md) | planned | identity synchronization, claim-before-effect, bounded maintenance |
| M2 | [T47 authority state machine](T47-modeld-authority-state-machine.md) | planned | same-STEP bounded wait, actual side-effect fences, one terminal |
| M3 | [T48 causal observation](T48-modeld-causal-observation.md) | planned | causal wire/Host/CLI/monitor chain, diagnostic independence, packed/privacy |
| M4 | [T49 qualification/release](T49-modeld-qualification-and-release.md) | planned | separately proven policy/performance/native/review/live gates |
| Non-main-chain | [T50 review residue](T50-modeld-review-residue.md) | open process | append-only nonblocking re-look concerns; no auto-dispatch |

```text
T43 → T44 → T45 ──────┐
        └→ T46 ──────┴→ T47 → T48 → T49
                                   T50 (residue, not a dependency)
```

Each ticket's evidence section is the completion source; this table is a route, not a copied test ledger. Planned verifier cases fail until their required suites exist. Offline implementation, independent review, native qualification and live release are distinct. No implicit merge into v2, push or live Host/modeld changes.

## Prior delivery baseline — 2026-09-12 documentation governance

**已定边界：Server归属优先；不改官方App；同Box会话换模型不换harness；test2仅冲突样本。** 查询已存在，执行门/可逆日用/全卸载不能据此算完成。历史计数与现场receipt留在[readiness](../maintainers/t32-live-enable-readiness.md)，本索引不复制会过时的产物和测试数量。

| 顺序 / owner | 当前实现基础与真正差额 | 下一责任 / 退出条件 |
|---|---|---|
| 1 · [T37 Server归属准入](T37-server-ownership-admission.md) | 共享判定已进production kernel/modeld与模型配置；source真实Unix拒绝/时效/恢复fence已过 | 原生scoped读取、迁移屏障、完整packed及独立review；未部署不冒充现役门 |
| 2 · [T38 身份写入/校准](T38-identity-write-alignment.md) | CLI更新/创建确认已有；候选已移除五个身份写入slice并拒绝旧profile | source退场未部署；先原生gate资格/冲突保全，再新profile；test2现场不动 |
| 3 · [T24 可逆选模](T24-runtime-route-binding.md) | 单Botroute reset/旧TURN保留已有；不可读配置和无资格no-STEP不再默回official | 当前候选部署、原生官方回程与实际生效观测；不拿保存回执当生产成功 |
| 4 · [T39 原生往返](T39-native-model-roundtrip.md) | public选择纵切＋固定原生消费者/packed adapter五进程往返隔离资格 | 原生blob/checkpoint writer与当前版本/真实模型/App；owned JSON不签原生持久化 |
| 合流 · [T26](T26-runtime-host-fullstream.md) / [T32](T32-runtime-confirmed-compact.md) / [T35](T35-host-compact-wait-point.md) | 流/恢复/摘要/错误安全已有子集；不得重做或丢失旧证明 | 分别补原生消费者、真实恢复、pending-background/outer retry；交T39 |
| 必需 · [T36 Working](T36-composer-working-activity.md) | 原App谓词已理解、producer桥部分已证；完整UI语义未证 | 当前session/run/代一致，失败/取消/迟到/重连不假busy；不是后置美化 |
| 5 · [T40 持久服务与发布](T40-persistent-release-and-rollback.md) | start实际CLI/Unix与Node制品start→borrow→orderly restart已证；listener丢失结算、T27同数据根status已补，固定全仓见readiness | 继续受支持持久owner/安装自启、T37/T38当前原生资格与保全、T39 checkpoint和现场；不重复修占位，不把前台重启当整机恢复 |
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
