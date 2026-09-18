# HCR-01 — 配方与 local-witness 诊断

Status: implementing. Depends-on: existing HSO writer and strict-observation-v2.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 修复 analyze→write 死路及 local-only 拒绝解释。`host/profile.ts` owns recipe matching；`process/profile.node.ts` owns shared authoring preflight；kernel ownership/stream diagnostic owns finite reasons；CLI 仅投影。

## Acceptance

- 失配 fixture 保留准确 slice ID/code；analyze 不建议已知不能执行的 write，writer 在发布前拒绝且旧 artifact 不变。
- schema/source、scope、目标行、时钟/过期分别有有限子原因；原安全门保持拒绝，未知字符串/getter/原始响应不泄露。
- coordinator→stream diagnostic→incident-compatible projection保留细因；正常、旧 peer、scope 变化和过期回归通过。
- doctor unknown 的 next 修复及对应集成由 HCR-02 完成。

## Forbidden / non-goals

不放宽 freshness，不用完整注册快照替代 local-only，不重放业务，不推断 Provider 故障，不输出 Host/provider 原文。

## Evidence

实施后记录固定测试命令与结果。当前真实加载与App验收只看 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)，这里不另维护live进度。
