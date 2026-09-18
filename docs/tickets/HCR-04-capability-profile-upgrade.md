# HCR-04 — 受控能力配方升级

Status: linearly integrated into v2 / implementer-reviewed / Bun 1.3.14 full-inventory and installed Node20 CLI verified; independent review residue in HCR-02. Depends-on: HCR-01, HCR-02.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 增加显式能力selector。`host/profile-capabilities.ts` owns有限能力包及依赖；`process/profile.node.ts` 在原writer内组装、校验和基线复验；CLI analyze/write使用相同selector。

## Acceptance

- 默认完整当前recipe行为保留；显式 `ownership-local` 从同源且可验证的durable profile升级schema/api及resume依赖。
- 原非目标切片逐字保留，不静默删除或跳过。未登记selector、基线缺失/变换失败/source不符均拒绝。
- 旧profile+无关alert匹配失败的合成fixture可以通过受控局部路径；目标自身失配仍拒绝。
- envelope exact review与原子protected publisher复用；写入必须携带分析回执的`--expected-reviewed-sha`，分析到写入及写入到发布之间基线改变均拒绝。
- analyze和write使用同一配方，输出基线/更新能力的有限receipt；无第二注入路径，无隐式live切换。

## Forbidden / non-goals

不提供任意skip/外部JS配方，不声称任意历史Host支持全部当前能力；局部升级不是权限豁免或Provider成功证明。

## Evidence

固定实现 `aefe851` 已线性合入v2并复验，见[集成窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-v2-integration)。本票无已登记未实现功能；独立复审外部依赖统一见[HCR-02残项](HCR-02-loaded-capabilities.md#independent-review-residue)。实际profile采用与新STEP资格仍在LIVE，不由离线发布成功推定。

`hcr-profile-upgrade.test.ts` 的7项测试覆盖无关alert变化下的局部升级、目标失配、基线校验/竞争、依赖完整性和系统gate；`test/hcr-cli.test.ts`与安装包复用同一断言。缺少可测golden的历史基线仍拒绝，不能由能力selector绕过。Bun1.3.14完整清单及安装包通过，独立review服务503未签收；详见[补充窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-pinned-qualification)；当前加载、App和新STEP验收只看 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
