# HCR-03 — Controller / identity 中断恢复

Status: implemented / offline and installed Node20 CLI verified; independent review pending. Depends-on: existing Effect controller / adopt journal; HCR-02 presentation.

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

`hcr-operation-recovery.test.ts` 的14项隔离测试覆盖持有进程退出、并发恢复、PID身份、损坏/替换文件、持久化失败与后续恢复；源码及安装包CLI复用同一断言，Node20入口实测通过。仅使用临时root与一次性子进程。取消、旧版不协作写者与真实提交窗口的证明范围不扩大；独立review仍待完成。详见[离线报告](../reports/2026-09-18-host-capability-recovery-offline.md)。真实中断/attestation窗口只登记 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
