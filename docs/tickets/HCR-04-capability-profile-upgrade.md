# HCR-04 — 受控能力配方升级

Status: implementing. Depends-on: HCR-01, HCR-02.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 增加显式能力selector。`host/profile-capabilities.ts` owns有限能力包及依赖；`process/profile.node.ts` 在原writer内组装、校验和基线复验；CLI analyze/write使用相同selector。

## Acceptance

- 默认完整当前recipe行为保留；显式 `ownership-local` 从同源且可验证的durable profile升级schema/api及resume依赖。
- 原非目标切片逐字保留，不静默删除或跳过。未登记selector、基线缺失/变换失败/source不符均拒绝。
- 旧profile+无关alert匹配失败的合成fixture可以通过受控局部路径；目标自身失配仍拒绝。
- envelope exact review与原子protected publisher复用；基线在发布前改变则拒绝，旧profile不被覆盖。
- analyze和write使用同一配方，输出基线/更新能力的有限receipt；无第二注入路径，无隐式live切换。

## Forbidden / non-goals

不提供任意skip/外部JS配方，不声称任意历史Host支持全部当前能力；局部升级不是权限豁免或Provider成功证明。

## Evidence

实施后记录测试与review；当前加载、App和新STEP验收只看 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
