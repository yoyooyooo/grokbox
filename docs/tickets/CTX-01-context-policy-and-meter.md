# CTX-01 — 本地工作窗口、配置与计量

Status: **Implemented / source and packed proof recorded / independent review pending**。主要实现 `883e224`；连续迁移修复 `358c057`、TURN policy/auth一致性修复 `f4b3a18`。现场采用另归LIVE，保存配置不等于现役进程已读取。

## Goal / authority

128K本地工作预算独立于500K/1M模型声明；初始/失败/无usage会话也能检查。配置、默认、覆盖、schema3、生效和预算公式由 [Spec S12.2–S12.3](../roadmap/box-runtime-impl-spec.md#context-maintenance)唯一拥有；[CTX-00](CTX-00-pi-compaction-reuse.md)记录实际Pi复用决定。本票不修改原生历史。

## Actual implementation

`runtime-kernel/internal/config/context-policy.ts` 负责纯验证/覆盖/预算/revision，`internal/contract/context-maintenance.ts` 提供有界DTO及完整输入估算。config schema3、显式v2迁移、统一writer/alias/application、CLI schema/validate/get/set均已接通，models维持独立schema2及原字节。

`context-selection.ts` 在原TURN锁及ExecutionHistory内捕获模型/策略与安全credential fingerprint，首次main与后续maintenance必须一致。已存在main binding的policy不会被新全局值替代，关闭/撤销TURN与已终态parent STEP不能被缓存选择复活；scope变化撤销仍写原TURN域，不另建authority库。普通client/ops/其他Bot编辑不改变本Bot有效policy revision。

`context-budget.ts` 与 `backends/context-meter.ts` 在prepare/最终SDK请求检查预算及实际输出；Host前置遍历不导入Pi/SDK/Effect。生产meter明确是unicode-envelope估算及保守余量，包含system/tools/消息/附件开销，不伪造provider usage或零成本。Pi估算是参考/候选，不承诺跨tokenizer精确上界；未知上游容量仍可执行显式本地预算。

连续schema迁移可以在前次retired之后开始，旧manifest和备份保留，preview绑定其指纹；unfinished、改变指纹、归档冲突或active writer均拒绝。迁移不启动服务、不发摘要、不给其他Bot选模型、不重写credential/models。

## Acceptance / evidence

```bash
bun scripts/verify-runtime-rebuild.mjs context-policy
bun scripts/verify-runtime-rebuild.mjs config-unification
```

这些case均有真实测试映射；unknown/缺输入/zero/skip不作通过。实际政策/配置证明包括128000/16384的严格边界、500K与128K对照、输出大于预留、invalid/小窗口/无容量声明、无assistant/无usage与Unicode/tools、model→Bot覆盖、schema2拒绝及显式迁移、alias/CAS/作用域、current-vs-next-TURN和credential轮换拒绝。组合Node制品和具体运行计数见[离线报告](../reports/2026-09-17-context-maintenance-offline.md)。

source tests在 `runtime-kernel/test/context-policy.test.ts`、`context-selection.test.ts`、`unified-config.test.ts`、`box-runtime/test/config-migration.test.ts` 和既有config CLI/packed家族。预算策略扩展不另建配置writer或第三文件。

## Remaining / non-goals

固定提交独立review尚无返回报告；原生consumer adopted/captured状态、实际迁移与已授权重启需要[LIVE-CTX-ADOPTION](LIVE-integration-validation.md#live-ctx-adoption)取证。未知provider token开销不说已精确预测，不通过改目录容量、静默truncate或新tokenizer服务掩盖。当前没有因这些源码改动自动修改生产config或加载新Host/modeld。
