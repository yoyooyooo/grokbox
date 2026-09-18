# HCR-02 — 实际加载能力与生命周期回执

Status: implemented / Bun 1.3.14 offline verified; independent review blocked by reviewer availability. Depends-on: HCR-01.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 区分服务ready和必需桥能力。Host reader/wrapper共同返回有限版本声明，operator只读检查实际响应，生命周期沿用原controller并做后置观察。

## Acceptance

- applied synthetic wrapper + installed reader报告native-local能力；旧wrapper/旧reader/缺失/畸形响应不误报ready。
- 无目标能力探测不枚举Bot、不读Server注册、不发送模型请求；能力声明不是STEP许可。
- doctor unknown、不完整能力、服务blocked都有下一步；协议状态和Host来源独立，不把missing当pass。
- upgrade回执区分requested、observed和blockers；signaled=false不自动算失败，enable-requested不自动算恢复。
- 包内CLI与Host import fence回归通过。

## Forbidden / non-goals

不替代执行时ownership gate；不因doctor调用而补写profile、重启、获取新token或调用Provider；不承诺原App/Provider成功。

## Evidence

实现与Bun1.3.14完整清单验证已完成；独立审查服务返回503，未取得审查报告。最新工具链、文件清单及失败复验记录见[补充窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-pinned-qualification)。当前live状态唯一入口：[LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
