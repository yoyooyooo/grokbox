# Box-runtime tickets

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

[策略 plan](../roadmap/box-runtime-plan.md) 拥有 Phases 0–4；[单轨重建实施规格](../roadmap/box-runtime-impl-spec.md) 拥有唯一目标树、ports、退场顺序与证明。**施工只用 T20–T33**，不重用历史 POC 票号，不在票据间另造架构。下表是范围/状态索引；真依赖与排期见[规格 S8](../roadmap/box-runtime-impl-spec.md#tickets)。

## Rebuild — open

所有票据均未实现；Done 必须满足指定 executable proof 与独立复审，offline Done 不等于 live-qualified。命令/目标文件由相应票据创建，当前文档存在不代表命令已可运行。

| id | status | phase | scope |
|---|---|---|---|
| [T20](T20-runtime-layout-cut.md) | open | 0 | 骨架/package/import cut，撤旧入口与 proof runner |
| [T21](T21-runtime-codec-fidelity.md) | open | 0 | Host/CCS codec 输入保真：A3fu/A7 |
| [T22](T22-runtime-raw-output.md) | open | 0 | 独立关闭默认 raw Host fd：A6；保留 T12 |
| [T23](T23-runtime-model-backend.md) | open | 1 | 一个 Effect ModelBackend/auth port；AI SDK + Fake/echo |
| [T24](T24-runtime-route-binding.md) | open | 1 | RouteBinding/selection fence/STEP 与 epoch/TTL 拒绝 |
| [T25](T25-runtime-effect-root.md) | open | 1 | 长寿命 Effect root/A9/v3 Unix transport |
| [T26](T26-runtime-host-fullstream.md) | open | 1 | A8 Host fullStream/双向端到端整合 |
| [T27](T27-runtime-status-facets.md) | open | 1 early | T13 最小 facets/J13 角色，主排期 T21 后立即做 |
| [T28](T28-runtime-controller-cut.md) | open | 1 | 单 Controller program/安全 IO/整合与占位清零 |
| [T29](T29-runtime-webui.md) | open | 2 | 共同 API/WebUI/第二 writer CAS/浏览器证明 |
| [T30](T30-runtime-pi-backend.md) | open | 3 | pi RPC 独立 qualification 与 adapter |
| [T31](T31-runtime-cursor-backend.md) | open | 3 | Cursor SDK 独立 qualification 与 adapter |
| [T32](T32-runtime-confirmed-compact.md) | open | 4 | confirmed overflow/Host compact/一次恢复/v4 |
| [T33](T33-runtime-diagnostics.md) | open | 4 | source-scoped 深层诊断与 delivery gaps |

默认先 T20 → T21；T22 不 gate 保真/内核。T27 尽早，随后完成 Phase 1 核心。T30/T31 的资格失败只阻塞本 adapter，不阻塞 T32/T33。Astra 复审/授权边界统一见[规格 S9](../roadmap/box-runtime-impl-spec.md#review-live)。

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
| [T15](T15-webui-ops-config-storage.md) | open | 产品范围；执行 T29，依赖 T27/T28 |
| [T16](T16-model-backend-adapters-pi-cursor.md) | open | 产品范围；基础 T23，候选实现 T30/T31 |

## Live canary bots

Stable ids（App 名称会变）。Route 由 `assignments.agents[id]` 显式 opt-in；missing key = official，不继承 main。

| App name | id | route boundary |
|---|---|---|
| grokbox test0 | `00000000-0000-4000-8000-000000000114` | 唯一允许申请本轮 live canary 的 Bot；实际模型/授权每次重验 |
| grokbox test1 | `00000000-0000-4000-8000-000000000113` | unassigned / official；本轮不 opt-in |

A1/A2/A4 在 POC 源码已关闭，A3 tool-role 修复已存在；A3fu/A5–A10 是研究缺口标签，不是第二执行系统。所有 live adopt、provider spend、额外 Host patch 与旧文件/fd 处理均需独立授权；docs/离线 green 不授予这些权限。
