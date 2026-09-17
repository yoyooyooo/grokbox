# T48 — 低风险 Host 组合资格与等价 profile 派生

## Status / Goal

**Planned · Spec-only。** 让极低风险变化可由明确规则获得自动维护资格，同时拒绝「锚点没变但语义已变」；不把所有新 SHA 永久锁成手工，也不让模型自批补丁。Owning contract：[Spec §6](../roadmap/template-ops-automation-spec.md#policy)、[ADR D3](../decisions/2026-09-16-template-ops-automation.md)。

## Depends-on / Modules

依 T43 的能力/版本表示、T44 的稳定 source/loaded/component 证据与 T51 的 deepReplay/预算配置；T47 的模型诊断不是资格前置，纯规则路线可无模型进行。复用 HSO 精确 apply/replay/provenance 和现有 profile writer。

kernel `internal/ops/qualification.ts`、`policy.ts`；box-runtime `internal/ops/automation/qualify.ts`、`internal/ops/host-seam/*`、`internal/process/profile.node.ts` 及 ConfigurationWrite/IO 的相应 CAS adapter。profile runtime apply 保持不变。

## Work

以实际 profile 切片集合生成版本化能力清单，区分执行依赖、观察片与对应行为 oracle；不能用 2 knife/19 envelope 的绿灯冒充全部覆盖。QualificationRecord 固定 source/component、完整 patch set/recipe/profile/preload、modeld wire/相关 build、规则/测试 revision、scope/freshness 与依赖覆盖。

先实现已审核同组合的 `realign-qualified-generation`；再为 `derive-equivalent-profile` 建立极窄规则。新 source 可以自动派生 exact-SHA profile，但必须保持已批准 recipe，不新增切片或改变 replacement，证明全部生效执行片及已界定依赖闭包/必要 companion 合同等价。解析失败、动态依赖无法界定、缺金样或超界差异只能候选+告警。

profile publisher 是唯一 writer，新增 `human | qualified-policy` 审批来源与 qualification/policy refs，在 expected current profile digest 下 CAS 发布；不得同时保留一个绕过批准记录的自动 writer。发布后还没有 adopt 权限，资格被新证据/撤销/换代否决时立即失效；对 A→B→A 可复用机械 cache，不复用旧 episode 许可。

LLM 仅解释、推荐候选或否决；规则资格不得读取模型 confidence 或 payload 自带 approval。独立 fixture 提供负例标签，不由被测 matcher 自动重写 golden。

## 2026-09-17 补充：观察资格与维护权限分离

维护者手动打开深 replay/资格分析，不代表自动发布 profile 或允许 Host 切换；user 轻量观察也不默认扫描全 corpus。T51 控制是否/何时运行分析，QualificationRecord 只证明受限组合性质，实际 publisher/Host 动作仍要求对应 grant 或 exact 人工批准。

新 source 无影响时资格缺失只留本地，不自动骚扰普通用户；已确认用户影响且没有合法安全修复路径时向 T52 提供安全摘要及缺口，不能靠一轮昂贵分析当作 issue 询问的强制前置。缺资格不得伪装「已尝试修复失败」。

追加测试：preset=maintainer + 深分析通过但无 grant 的发布/信号为 0；user 默认不深扫；同一结果不能作为 support consent；分析预算或 scope 变化使后续工作停止而非提升权限。

## Executable acceptance

新增并执行：

```bash
bun test packages/box-runtime/test/host-low-risk-qualification.test.ts packages/box-runtime/test/policy-profile-publication.test.ts packages/box-runtime/test/host-seam-envelope-drift.test.ts packages/box-runtime/test/transform.test.ts
bun run typecheck
```

首两项为待交付文件。必须有一个外围布局变化的新 SHA 正例可获限定资格，以及以下反例：anchors 唯一但调用顺序变化、stream terminal/取消契约变化、共享依赖变化、29 切片只验 19 个、companion/wire-only 变更、动态引用未知、旧 recipe/test 缓存、golden 缺失、concurrent profile writer、source 发布前变化、撤销后复用授权。

每个拒绝都保留机械与语义证据差别；unknown 不算通过。对未知 source 使用旧 profile 必须仍返回 `unknown-sha`；新派生 profile 只有在唯一 publisher 和策略审计通过后可供后续动作消费。全测试零实际 Host signal、零执行 corpus、零真实 provider 请求。

## Forbidden / Non-goals

不改精确 runtime SHA/唯一性门，不让 AST/Agent 进入 preload，不自动批准新 recipe，不执行私有 Host，不通过改测试来扩大等价范围，不升级官方 Host/channel/image，不把静态资格称作 live 行为完全证明。

## Done evidence / Next

关闭需规则版本、覆盖清单、独立正反例、CAS/撤销/失效证明；自动规则未通过独立 review 时只能发布 candidate-only 子集。T49 消费已资格化的组合并重新检查执行安全，不能凭本票结果直接 adopt。
