# CTX-00 — Pi compact 组件复用资格与采纳决定

Status: **Implemented / controlled extraction selected / offline proof recorded / independent review pending**。功能提交 `883e224`；后续组合修复 `269f1e2`、`358c057`、`f4b3a18`。不是仅有公共导入探针，也不是完整 Pi Agent/Provider 运行时已接入。

## Goal / authority

以成熟 Pi compact 组件减少自研算法责任，保留 Host 唯一历史 writer 和 kernel 请求/预算/权限边界。唯一规格为 [S12.0](../roadmap/box-runtime-impl-spec.md#pi-compaction-reuse)，固定发布包事实见 [Pi 参考](../maintainers/pi-compaction-reference.md#core-package-reuse)。原优先级仍为公共 API → 最小接口/策略补丁 → 受控提取 → 有证据的局部重写；本票已作出单一选择，不在生产保留多种算法 fallback。

## Decision / actual modules

选择 `box-runtime/src/internal/context/vendor/pi-compaction/` 中的 **Pi core 0.85.1 受控纯代码提取**。保留来源文件 SHA、原函数/模板、MIT 原文及归属、精确差异和升级方法；没有新增 Node>=22 的运行依赖，也没有绕过 exports 的绝对 deep import。

| 能力 | 实际采纳 |
|---|---|
| findCutPoint / prepareCompaction、近期保留和split-turn | 保留纯算法；由 `pi-projection.ts` 转换有界只读材料，并独立维护 sourceRef/工具闭包与原生保留边界 |
| estimateTokens / estimateContextTokens / shouldCompact | 保留来源与golden；生产最终预算采用带来源/余量的完整unicode-envelope计量，不把Pi字符估算当真实tokenizer |
| 原summary/update/split-turn模板 | `prompts.ts`保留；`pi-compaction.ts`通过caller-owned Effect请求执行分段/更新，不直接调用整个Pi Agent |
| serializer/请求预算/终态 | 显式适配完整分段覆盖、输出预算、零隐藏retry和空/length/未知终态拒绝；不采用默认工具结果前2000字符截断 |

否定直接整包的具体证据：0.85.1要求Node>=22.19而项目保留>=20.17；独立请求callback未公开且无compact子路径；公共Models桥前已发生材料截断，单独导出callback不能补回内容。选择提取必要纯部分而非伪造Models、扩展大依赖闭包、实例化Session/Agent或改Node发布合同。包调查、hash与适配理由不等同于全量直接包集成通过。

kernel只定义 `ContextCompactionAlgorithm` 的本项目DTO/Effect边界，box-runtime实现唯一adapter；Pi类型/配置/凭据/Entry/retainedTail不进入Host或wire。来源/许可实际位于vendor的 `PROVENANCE.md`、`LICENSE` 与根 `THIRD_PARTY_NOTICES`。

## Acceptance / proof

已实现有限入口：

```bash
bun scripts/verify-runtime-rebuild.mjs context-reuse
```

入口真实执行 `context-reuse.test.ts`、`context-maintenance-summary.test.ts`、`context-maintenance-packed.test.ts` 和import fence，不需要全局Pi、用户配置、真实provider或运行时下载。CTX-R01–R07的目标仍由S12.8定义；Fake只替外部能力，算法来自上述真实采纳代码，expected不是调用被测函数生成。

[离线收口报告](../reports/2026-09-17-context-maintenance-offline.md)记录实际SDK/local HTTP/Unix、超过2000字符后的工具事实、sourceRef保留、Node20实际制品十轮维护/新进程回读、失败反例和工具链。没有将Node22可import冒充Node20支持，未将仅检查源文本的测试冒充完整运行。

## Remaining / exit

采纳和source/packed证明已经存在；**固定提交独立review未完成**，两次Astra只读请求均503而无报告。此项不是LIVE任务。后续Pi来源/模板/serializer/Node/制品改变须重跑相关R/A向量；不能因选择受控提取就免除升级差异审查。

完整旧会话下一输入与原生存储/App发布由CTX-04及LIVE对应门关闭，本票不把算法通过提升为已部署。PI-AI-01仍独立非阻断；这里没有替换AI SDK、发布fork/PR或接入Pi SessionManager。
