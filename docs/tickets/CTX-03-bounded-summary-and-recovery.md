# CTX-03 — 有界摘要、长材料与溢出恢复合流

Status: **Implemented / SDK–Unix–Host offline proof recorded / independent review pending**。功能提交 `883e224`，提交读回校验 `269f1e2`，同TURN凭据/生命周期补强 `f4b3a18`。没有因此替换AI SDK、开启额外provider retry或部署现役服务。

## Goal / authority

超出本地预算的普通长历史能够通过有限摘要计划生成可接受候选，摘要自身也不超预算。主动维护与T32确认溢出共享维护程序，但主请求重试、摘要请求和工具副作用分账。完整合同只归 [Spec S12.2/S12.5–S12.6](../roadmap/box-runtime-impl-spec.md#context-maintenance)；实际算法采纳见[CTX-00](CTX-00-pi-compaction-reuse.md)，原生接受见[CTX-02](CTX-02-host-context-maintenance.md)。

## Actual implementation

`context/pi-compaction.ts` 使用Pi衍生准备/模板及完整材料分段，kernel `context-maintenance.ts`提供唯一有界请求回调，经已有BackendAuth/ModelBackend调用真实SDK。每次子请求有独立身份、父维护预算及取消，捕获相同模型/effort和credential指纹；无业务工具、默认凭据发现、库内retry或隐藏provider切换。维护索引在实际effect之前持久声明，重复/未知操作先对账，不自动再发。

`pi-projection.ts`将最新用户输入、system、完整工具组和图片等固定材料保护，旧内容按合法sourceRef分区，长工具结果第2000字符后仍进入实际摘要材料，不从后置回调伪造被截掉的尾部。已完成长TURN可以分区，尚未完成的工具调用与关联结果不得拆散。超出支持传输或不可保留的固定输入准确拒绝，不假造检索文件/引用。

分段及必要合并都计入同一个请求/输入量/期限上限；每次真正编码前检查完整指令、摘要、材料和输出额度，不能无限递归auto-compact。空白、length、未知终态、工具输出、缺finish或无改善不作为成功摘要提交。最终native carrier再次计量，满足目标余量且写入/回读事实一致后才继续主请求。

确认的上游溢出仍由T32窄条件授权同STEP一次额外主请求；新的本地preflight不先撞provider、不占或放大失败恢复次数。普通400/鉴权/429/413/5xx/断流本身不授予摘要/重放权。已有正文/思考/工具不能因compact而回滚，主TURN/STEP和旧工具不复活。

## Executable proof

```bash
bun scripts/verify-runtime-rebuild.mjs context-summary
bun scripts/verify-runtime-rebuild.mjs context-maintenance
```

实际测试使用选定算法、真实SDK/本地HTTP/Unix与原生facade，只有外部能力替换；摘要返回依据实际收到的事实材料生成，不硬编码最终答案。覆盖工具尾部sentinel、早期事实、当前输入、bounded分段/合并、空输出/工具输出/缺finish、请求预算耗尽、同请求并发取消、source/material读回不符、十轮压缩/新进程恢复和key轮换之后零额外主HTTP。原T32/stream/provider-recovery负例继续回归；具体计数与依赖现实见[离线报告](../reports/2026-09-17-context-maintenance-offline.md)。

## Remaining / scope

独立review未获得报告，503记录留在源码交付域，不当作live-only残留。实际provider tokenizer限制及摘要质量、真实原生archive/checkpoint和App后续执行由[LIVE索引](LIVE-integration-validation.md#live-ctx-next-input)记录未证范围。当前没有图片摘要策略，图片原样保护；不保证任何单条巨型输入或不可用摘要服务都可成功。

PI-AI-01独立非阻断；没有新Agent loop、Pi Session、额外历史writer或不可见模型切换。后续采纳算法/模板、最终请求编码、输出语义或sourceRef合同变化，重新核对CTX-R及CTX-A相关向量，不能复用旧构建绿色给新版本签字。
