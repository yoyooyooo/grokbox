# T49 — 唯一 controller 的预授权维护、排空与安全退出

## Status / Goal

**2026-09-18范围：独立后续M，不阻塞默认提醒首发。** 默认通知不启动本票动作；用户任务/独立预授权与原控制门都满足时才处理，原操作状态的GC只由OBS-05及controller owner批准。

**Planned · Spec-only。** 在已有唯一 controller 内兑现有限预授权自动变更，而不是另造一个能杀 Host 的 watcher。模板 Bot 持久交接后结束；维护可独立完成并给后续 Bot 留回执。Owning contract：[Spec §7](../roadmap/template-ops-automation-spec.md#execution)、[§9](../roadmap/template-ops-automation-spec.md#layout)。

## Depends-on / Modules

依 T48 的限定资格、T47 的 plan/handoff 合同和 T51 的独立 maintenance grant/config；复用 T28 operation/lease/guardian 和 T40 当前生命周期。T43/T44 的原生安全能力与当前事实是执行门，不要求其它整票全部 Done。

kernel `internal/commands/controller-operation.ts`、`internal/commands/ops.ts`、`ports.ts`；box-runtime `internal/roots/controller-program.node.ts`、新增 `ops.runtime.ts`、现有 process/adopt/official rollback 能力；CLI `commands/operator.ts`、`runtime.ts`、`ops.ts`。原 Host 退出流程也归并同一控制准入，不保留自动化私有 signal 路径。

## Work

扩展不可变 MaintenancePlan、现有 controller operation 存储与授权 provenance：manual-confirmation 和 policy-grant 分开；Bot 无法用 `confirmed:true` 绕过。grant 校验绑定完整 plan digest、scope/revision/有效期/预算，每次执行前重读；拒绝不影响已有用户配置。

统一 host start/stop/restart、upgrade、re-adopt 的 running/admission/drain 预检到共用控制边界。显式人工中断和自动静默维护有不同策略；自动模式无 `--force`。需要已资格化原生暂停/排空或等效 fence，不能只采样一次 idle。缺能力就 blocked/告警，不添加未经批准的 Host patch 来凑屏障。

Bot submit 的回执只证明持久 handoff；Bot 随后结束。独立维护 Scope 观察提出者回合与所有相关子任务实际终结，再申请/验证维护屏障；不能把提出者从 busy 名单排除。已有未决操作、待审批、子任务、活动 tools/stream/compact 或 modeld active steps 未清楚时延后至预算后报告。

按原 controller 做精确 PID+start/拓扑/source/profile/policy 复核、guardian、一次 attempt、进度前缀、读回与恢复。new source/ABA/撤销会 supersede 计划。区分 verified/partial/unknown/rollback_unverified；取消后不自动再次 signal。退出回到当前官方安装的未注入 Host，不执行 corpus 或回滚官方版本，不在同 STEP 偷换供应商。

运行时维护完成不依赖 T41 SQLite 存活；原 controller 保存权威结果，通知恢复后通过 stable operation ref 补索引。观测 DB 坏时不产生新自动计划，但不使已经发生的动作丢失结果或无限等待通知。

## 2026-09-17 补充：preset 不授权，失败不自动提单

user 和 maintainer 都默认 maintenance off；切 preset、打开 deepReplay、配对模板、收到 issue 确认都不能建立维护 grant。maintenance mode 已设但无 grant 时明确 blocked-no-grant，不能修改 desired 回避解释。T51 的 config revision/权限撤销须在计划准入与执行前检查。

无法执行/退出受阻的真实收据进入OBS共用incident/证据链，按T45通知目标Bot，不附带Issue询问。T52/T56延期；维护权限不包含公开，用户决定公开也不授权维护重试。operation unknown先对账，不借切preset或新通知身份复活计划。

追加测试：maintainer切换、无grant mode=low-risk、与维护无关的用户决定均不改写计划/配置；controller→incident→默认提醒不产生诊断、公开或新的Host attempt。

## 多接收者的控制边界补充

[T54/T55](T55-custom-receiver-delivery.md) 可有多个不同模型 Bot 提出同一个 incident 的维护候选；plan/operation 身份不随 target/route/delivery 变化而重建。controller 对授权、当前证据和已发生前缀仍唯一串行判定，昂贵模型不等于可信批准者。

所有参与本次交接的真实回合/原生子任务都应结束，不能只排除 default 模板 Bot 或只检查最初提出者。custom 接收路径故障本身不授权重启 Host，备用切换不修改 grant 或未知 operation。T56已延期，任何未来公开权限仍不得替代维护grant。

追加回归：两个 Bot 重复/相反 proposal 不双重 signal；换路由不重放 unknown；receiver model/身份改变不能借旧 grant；报告目标尚忙不反向制造无穷维护等待或取消用户任务。

## Executable acceptance

新增并执行以下目标文件，必须使用 Fake ports 或本测试创建的 disposable 进程：

```bash
bun test packages/runtime-kernel/test/ops-controller-policy.test.ts packages/box-runtime/test/ops-maintenance-handoff.test.ts test/ops-host-gates.test.ts packages/box-runtime/test/controller-generation.test.ts
bun run typecheck
```

覆盖所有入口 gate 一致；Bot 自占 busy、parent 已停 child 尚存、未知 roster、quiet 后突然新任务、拒绝暂停、屏障过期、policy 撤销、profile/source 临界换代、旧 plan/repeated submit、双 executor、SIGTERM 后 receipt 丢失、guardian/finalizer 失败、controller/DB 重启与错 PID reuse。越界动作 signal/spawn 为 0；合法同 plan 最多一次；unknown 对账不重放。

原生 canary 需独立授权，先 qualified 同代 no-op，再 idle 有屏障的一次切换/退出，证明 official no-preload、loaded tuple 与原生用户路径。未实际验证 UI/工具/退出时标 not_proven，不以 marker 或退出码代替。不能对生产 Bot 做故障注入。

## Forbidden / Non-goals

不恢复旧 `observeAndHeal`，不新增并行控制器，不把 `ops run` 变成第二 reconciler，不自动清 circuit，不强杀用户任务、不删状态、不改 official update command/ack/channel、Server harness 或产品 SQLite。不用 Bot 的文字自证修复。

## Done evidence / Next

关闭需同一程序的策略/手动路径、全入口安全门、取消/硬崩/交接证明；实时 native qualification 单列。T50 才签署受支持安装和用户闭环，实施 green 不自动为任何生产安装开 grant。
