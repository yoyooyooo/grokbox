# HCR-04 — 受控能力配方升级

Status: linearly integrated into v2 / implementer-reviewed / Bun 1.3.14 full-inventory and installed Node20 CLI verified; independent review residue in HCR-02. Depends-on: HCR-01, HCR-02.

## Goal / owner

按 [HCR Spec](../roadmap/host-seam-ops-recognition.md#capability-recovery) 增加显式能力selector。`host/profile-capabilities.ts` owns有限能力包及依赖；`process/profile.node.ts` 在原writer内组装、校验和基线复验；CLI analyze/write使用相同selector。

## 当前唯一维护配方（2026-09-22）

默认writer、只读envelope、显式能力升级与健康分析使用同一`HOST_RECIPE`。之前按SHA选择旧布局/套用变量名字映射的适配已并入当前canonical slices，旧选择器与旧配方回退退出。原生idle/actionOnly、resume、受信manual和startup语义继续分别验证，未知布局必须明确失败。当前实测Host为ebd92f0d…、worker为4c154a34…；61片全量有序变换、四个Rust规则及四项合法JS语义反例通过，原schema/AgentStore与生产fence、原worker自有SQLite完成隔离复验。生产仅保留这一当前配对，不自动发布或采用profile；A1实现的Q集成状态只看Linear，不由本技术说明签收。当前合同见[HOST-01核心接缝](HOST-01-patch-health-verifier.md#核心接缝交付合同)，完整摘要与复验命令见[核心ABI窗口](../reports/2026-09-22-current-host-core-abi.md)。前代6be750…仅见[历史收束](../reports/2026-09-21-current-host-contract-convergence.md)。

## Acceptance

- 默认完整当前recipe行为保留；显式 `ownership-local` 从同源且可验证的durable profile升级schema/api及resume依赖。
- 原非目标切片逐字保留，不静默删除或跳过。未登记selector、基线缺失/变换失败/source不符均拒绝。
- 旧profile+无关alert匹配失败的合成fixture可以通过受控局部路径；目标自身失配仍拒绝。
- envelope exact review与原子protected publisher复用；写入必须携带分析回执的`--expected-reviewed-sha`，分析到写入及写入到发布之间基线改变均拒绝。
- analyze和write使用同一配方，输出基线/更新能力的有限receipt；无第二注入路径，无隐式live切换。

## 当前原生配对升级（2026-09-22）

有限原生ABI资格与显式同源baseline→有限依赖→完整apply/envelope保持分开；当前生产配对不再接纳前代Host或其worker。两处native owner注册与worker使用同一当前来源身份，wrong worker/未知Host拒绝。当前变换保留39个core、3个checkpoint、19个current-state切片及其顺序；blob owner边界、原checkpoint awaiter与session路径依赖均按当前来源绑定，没有删切片求绿。独立原生测试预期与生产admission仍分开，核心Host测试共用该独立预期，缓存命中也须重核源字节。原Golden/review/CAS与非目标切片保全不变；保留一份可应用的已审baseline不是恢复旧运行实现。前一配对窗口仅见[固定历史](../reports/2026-09-21-native-checkpoint-pair.md)，不作为现在仍兼容该Host的声明。

## Forbidden / non-goals

不提供任意skip/外部JS配方，不声称任意历史Host支持全部当前能力；局部升级不是权限豁免或Provider成功证明。

## Evidence

当前来源更新的入口为`node scripts/verify-host-health.mjs native-pair`及`bun run test:native-host`（均需各自显式原生opt-in；前者还需指定原生Node），完整命令和观察边界见[核心ABI窗口](../reports/2026-09-22-current-host-core-abi.md)。A1不是材料/退役新接缝、A2全覆盖或真实Host切换验收。只读候选的profileDigest不是发布回执，沿用原writer的审核、基线CAS与scope约束。

以下是能力升级本体的历史集成证据，不是当前来源自动签收。固定实现 `aefe851` 已线性合入v2并复验，见[集成窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-v2-integration)。本票无已登记未实现功能；独立复审外部依赖统一见[HCR-02残项](HCR-02-loaded-capabilities.md#independent-review-residue)。实际profile采用与新STEP资格仍在LIVE，不由离线发布成功推定。

`hcr-profile-upgrade.test.ts` 的7项测试覆盖无关alert变化下的局部升级、目标失配、基线校验/竞争、依赖完整性和系统gate；`test/hcr-cli.test.ts`与安装包复用同一断言。缺少可测golden的历史基线仍拒绝，不能由能力selector绕过。Bun1.3.14完整清单及安装包通过，独立review服务503未签收；详见[补充窗口](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-pinned-qualification)；当前加载、App和新STEP验收只看 [LIVE](LIVE-integration-validation.md#live-host-capability-recovery)。
