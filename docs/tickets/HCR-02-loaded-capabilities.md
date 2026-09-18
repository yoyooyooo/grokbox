# HCR-02 — 实际加载能力与生命周期回执

Status: linearly integrated into v2 / implementer-reviewed / Bun 1.3.14 full-inventory and installed Node20 CLI verified; independent review unavailable, not passed. Depends-on: HCR-01.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 区分服务ready和必需桥能力。Host reader/wrapper共同返回有限版本声明，operator只读检查实际响应，生命周期沿用原controller并做后置观察。

## Acceptance

- applied synthetic wrapper + installed reader报告native-local能力；旧wrapper/旧reader/缺失/畸形响应不误报ready。
- 无目标能力探测不枚举Bot、不读Server注册、不发送模型请求；能力声明不是STEP许可。
- doctor unknown、不完整能力、服务blocked、committed缺失/不可用/恢复未提交都有下一步；协议状态和Host来源独立，不把missing当pass。
- upgrade回执区分requested、observed和blockers；signaled=false不自动算失败，enable-requested不自动算恢复。
- 包内CLI与Host import fence回归通过。

## Forbidden / non-goals

不替代执行时ownership gate；不因doctor调用而补写profile、重启、获取新token或调用Provider；不承诺原App/Provider成功。

## Evidence

固定实现 `aefe851` 已线性合入v2，Bun1.3.14完整311文件2408 pass/15 native skip/0 fail，含实际Node20安装包。新增doctor CLI反例先复现`recovery_pending`仍给`next=none`，修正后通过；`operator.committed`公开有限状态，不作为STEP许可。提交映射、实现者复查与固定集成证据见[集成窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-v2-integration)。当前live状态唯一入口：[LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。

<a id="independent-review-residue"></a>
## 独立复审残项（非 live）

HCR-01–04的独立复审残项在此统一记账。本轮对`d2fb583`的主/备用通道各一次仍HTTP503，无报告；历史四次属于上一窗口。实现者已复查并修正具体反例，但这不等于独立签收。独立复审在服务不可用时保持`unavailable`，不反复启动空任务，不把它转记为live或宣称豁免。

可执行的实现、指定工具链/安装包验证和源码集成已完成；当前没有登记未实现功能。剩余动作是由可用的独立审查者检查固定范围 `3e285fe..aefe851`，尤其锁恢复/取消、受控配方发布和加载/提交状态；如发现问题，整改并对新头复验。源码集成按用户本轮指令完成，不签公开发布或现役采用。macOS不作为本次Linux Box修复的额外阻断，仓库原CI矩阵不变。
