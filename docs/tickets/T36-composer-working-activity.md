# T36 — Composer Working / currentActivity on managed path

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · required production semantics (V24), not deferred cosmetics.** 2026-09-12路线治理：普通Working/typing、活动和消息streaming必须与当前执行一致；只改Host/CLI生产投影，官方App保持不变。本票可并行做状态夹具，最终与T39原生旅程一起验收。

## Goal
On managed / `harness=box` bots, the current chat's Working/typing/activity/streaming reflects the correct live execution, selected conversation and route. Generic Working uses running/composing facts; `currentActivity` enriches the label but is not a required trigger in App 0.47. Sidebar Bot-wide activity and per-message streaming remain distinct scopes.

## Module / dirs touched
- grokbox activity-bridge / Host `sessionActivities` projection (tip may already emit first-chunk thinking-delta).
- Optional CLI/raw roster honesty if `runningProjection` drops `currentActivity`.
- App/desktop consumers仅作原版观察和版本资格，不修改/注入/重签。源研究留在grok-bot。Cmd-Q结束旧Map但缓存可重建错误分类，不作生产修复；UI无法观测时保留缺证，不以Host字段替代。
- Maintainer map: `docs/maintainers/composer-working-status.md`, `host-app-projections.md`.

## Depends-on
已有activity-bridge可复用但不是充分证明。T37提供归属/运行代，T26提供native消息与活动接点，T39编排真实原版App旅程；本票独立签活动状态。普通Working夹具不依赖T35整票Done，涉及compact的活动交错再消费T35已证子集。T40最终发布必须取得本票必需语义证据，不因T29 WebUI后置而跳过。

## Forbidden
Faking Working without a real in-flight turn; unloading Host only to “refresh chrome”; treating harness always-emit as a fix for Working; test1 opt-in; inventing App menus/click-paths without verifying grok-bot docs.

## Acceptance (executable)
1. Preserve the distinction among Bot-wide running, current-session running/composing/named activity, per-entry streaming and local pending-send state. An absent `currentActivity` alone is not a failed generic-Working oracle.
2. In the same bounded real observation, correlate selected Bot/session/route/Host generation and live fields with App content. Cover pre-first-chunk wait, thinking, tool execution, SendToUser streaming and permission wait. A valid pending-send or waiting-permission indicator is not forced to spin.
3. End/fail/cancel clear the matching execution's Working; stale events cannot revive an old run or terminate a new one. Disconnect/expired observation is unknown/reconnecting, not a manufactured success or permanent stale spinner.
4. Reconnect and route changes must not use a different temporal run's activity for a managed box chat. Preserve official and legitimate temporal behavior, and correctly scope parent/subagent/other-session activity.
5. Update owning maintainer docs with actual App evidence and notProven. A source fixture, a Gateway field or a generic animation alone does not close the ticket.
6. 同一原生会话官方→A→B→官方时不遗留先前模型的busy/typing；模型选择saved与当前TURN实际状态不混合。恢复/权限等待/取消阶段活动有明确来源和结束条件，未知数据不能伪造动画。
7. 复用现有verifier/Host fixture增加乱序、过期、不同session/子代理和断连负例；原版App不可达或不显示预期时报告具体失败。不新造UI、不改客户端来让测试绿，完整现场证据交T39/T40。

## Non-goals
HostCompact resume ([T35](T35-host-compact-wait-point.md)); transcript/consumer implementation remains T26，归属门归T37、身份writer校准归T38。 Legitimate temporal activity is a required negative control, not a new runtime to implement.

## 2026-09-12 evidence correction

The exact retained App 0.47 renderer's `Ibt/Nbt` derives working from running/composing without requiring activity. `yW` can replace live state when the row is temporal; the final indicator also checks pending/failed sends and permissions. The research-only replay in grok-bot passed 7 assertions. It did not run the complete React mount or a new live UI turn. See [Host/App projections](../maintainers/host-app-projections.md) and private research `private interoperability notes (not distributed)`. Ticket remains open; no production deployment in this investigation.

## Related
[composer-working-status](../maintainers/composer-working-status.md) · [host-app-projections](../maintainers/host-app-projections.md) · L4 receipt `PRIVATE_EVIDENCE`
