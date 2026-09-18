# HCR-03 — Controller / identity 中断恢复

Status: linearly integrated into v2 / implementer-reviewed / Bun 1.3.14 full-inventory, cancellation and installed Node20 CLI verified; independent review residue in HCR-02. Depends-on: existing Effect controller / adopt journal; HCR-02 presentation.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 在原操作链增加系统advisory gate与持久owner证据。`io/operation-lease.node.ts` owns syscall adapter；controller root owns scoped lease与显式metadata恢复；原re-adopt仍唯一执行器。

## Acceptance

- 独立临时子进程证明：持有者活着时竞争者拒绝；硬退出后系统gate释放，但普通acquire不删除stale owner。
- 显式恢复同时持有controller→identity gate；活owner、EPERM/身份未知、symlink/文件替换均拒绝。
- 旧PID-only记录只有确定无该进程时才可恢复；新记录绑定pid/start/uid/boot与实例nonce。
- 仅持久running→unknown；不伪造attested/clear，不发Host signal，不改model assignment，不重放操作；随后原controller按当前facts决定。
- acquire写失败、取消、release与竞争测试；不依赖无界等待或读取真实Host。

## Forbidden / non-goals

不把Scope当硬崩事务；不裸unlink活锁，不按进程名kill，不自动恢复未知owner；不引入第二执行器或npm原生依赖。Linux primitive不可用必须拒绝，不能降级为弱锁。

## Evidence

固定实现 `aefe851` 已线性合入v2并复验，见[集成窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-v2-integration)。本票无已登记未实现功能；独立复审外部依赖统一见[HCR-02残项](HCR-02-loaded-capabilities.md#independent-review-residue)。macOS不是本次Linux Box恢复验收的额外前置；实际Host提交与恢复仅归LIVE。

`hcr-operation-recovery.test.ts` 的14项隔离测试覆盖持有进程退出、并发恢复、PID身份、损坏/替换文件、持久化失败与后续恢复；源码及安装包CLI复用同一断言，Node20入口实测通过。`f3b831b` 将CLI取消接入原Effect根，增加 `hcr-operation-lifetime.test.ts` 5项生产lease测试：持锁与申请中取消、预取消零gate、只读取证中取消、提交中取消不提前放锁。取消/失败的回执明确保留元数据可能已提交的未知结果，不承诺回滚。

Bun1.3.14完整清单验证通过。以上只使用临时root与一次性子进程，不扩展为旧版不协作写者、真实adopt提交或macOS执行证明。独立审查调用返回503，未取得review报告；详见[补充窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-pinned-qualification)。真实中断/attestation窗口只登记 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
