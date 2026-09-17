# CTX-00 — Pi compact 组件复用资格与采纳决定

Status: **Planned / Spec-only** · M0，CTX主链前置。规划从v2 `02a6d81`切出 `feat/pi-context-reuse`；本轮只核对发布包并完善文档，没有添加依赖、实现算法adapter或改变Node发布基线。先前公共导入/prepare探针是局部调查，不是本票Done。

## Goal / authority

在写新compact算法之前，以实际公开包确定可复用部分和最小必要差异。唯一实现合同为[主Spec S12.0](../roadmap/box-runtime-impl-spec.md#pi-compaction-reuse)，[ADR](../decisions/2026-09-17-local-context-maintenance.md)固定优先顺序；包/导出/哈希事实归[Pi参考](../maintainers/pi-compaction-reference.md#core-package-reuse)。不另建一份复用Spec。

每个函数/责任按公共API直接复用→最小接口/策略补丁→受控源码提取→有否定证据的局部重写决定。不可因为serializer有一处限制就重写整个core，也不可因为prepare能import就批准整个依赖。最终production只选一个确定的实现，不保留出错时自动切换算法的双轨。

## Depends on / scope

以当前v2配置/模型/执行核心和S12产品预算为约束，先验证 `@earendil-works/pi-agent-core@0.85.1` 发布包；换版本须说明差异并重验。CTX-01可并行准备纯配置/预算反例，但算法集成等本票决定；CTX-02/03/04消费本票。pi-ai模型传输、T30 RPC、完整Pi Agent和真实Host部署都不是前置。

## Module / deliverables

- `runtime-kernel/src/ports.ts`及 `internal/contract/context-maintenance.ts`：一个 `ContextCompactionAlgorithm` 替换边界，使用grokbox的只读材料/sourceRef/候选DTO和受限Effect请求能力；不得导出Pi类型、Models、Entry或credential。
- `box-runtime/src/internal/context/pi-compaction.ts`：唯一第三方算法adapter；`pi-projection.ts`：有界只读投影与源引用回映射。Host材料/metadata仍权威；库返回retainedTail只作为计划，不直接覆盖root。
- 先尝试公共compact()/Models/Provider桥，将所有摘要请求交给现有执行根。不能用假Models强制类型转换来规避真实契约；涉及未导出的caller-owned API时选择可复现最小导出补丁，而非生产deep import。序列化截断若发生在callback前，须在更早策略边界解决。
- 只有选型需要时建立 `internal/context/vendor/pi-compaction/`，保留来源版本/hash、许可/归属、原函数、精确差异和升级说明。patch通过项目可复现机制维护，不手改全局node_modules、不发布新fork包。本票只对必要部分提取，不引入另一套会话/Agent运行时。
- 新测试 `box-runtime/test/context-reuse.test.ts`、`context-reuse-packed.test.ts`，合成材料在 `test/fixtures/context-reuse/`；注册现有verifier有限case `context-reuse`。这些文件和case目前均未创建。
- 收尾在本票证据段记录source-bound选择表、实际依赖/patch/source清单、成功与失败向量、adapter规模/维护差异、Node/制品成本及未证项。只补最小兼容事实到upstream-integration，不复制私有资料。

## Acceptance — CTX-R01–R07，可执行目标

实现后执行 `bun scripts/verify-runtime-rebuild.mjs context-reuse`，按仓库声明的工具链运行。缺依赖/文件/制品、未知case、zero/skip、只有mock算法都不得通过：

1. **R01公共入口**：独立锁定安装的package version/integrity与实际exports/types；从批准入口调用真实shouldCompact/estimate/findCutPoint/prepare/compact，不借全局Pi路径。内部有export但根未导出的callback接口必须被反例识别，不把源码可见当包可用。
2. **R02源事实**：多语言/代码/summary/user-contained工具结果、完整工具组与未知metadata；投影不突变原输入、所有保留/摘要区间可映射原sourceRef/rootRevision。超大材料有界分区，不无界生成Pi Entry数组；未知形状明确拒绝。原生接受检查的完整性在CTX-02继续验证。
3. **R03单请求边界**：真实Pi摘要组件→有类型的caller桥→现有Effect/ModelBackend→本地HTTP。取消前/中/回调返回后、迟到、库返回错误/throw、history/prefix多调用分别计数。显式关闭库内retry并注入失败证明无额外fetch；没有ambient credentials、目录刷新、隐藏provider/failover。无owner Promise/fork或每次回调新Runtime为失败。
4. **R04材料与终态**：工具结果第2000字符后的sentinel必须进入合法摘要段或保留/可检索原始引用，否则不允许该候选通过。验证请求回调前的serializer实际材料，不在回调里“恢复”已经丢掉的内容。空白、length、未知终态及畸形摘要不以库ok接受；截断标记不是覆盖证明。
5. **R05预算差异**：同500K能力/128K本地、threshold等于/+1、无usage、输出O大于reserve、system/tools/新输入/图片开销与summary默认输出差异；实际最终HTTP遵守S12预算。Pi只是候选计量，不能伪造精确tokens/隐藏降effort/输出。
6. **R06发行边界**：真实Node制品验证目前>=20.17.0合同与候选声明>=22.19.0的差异、ESM入口、bundle依赖/体积/冷启动/import-time行为；Host/preload与kernel无Pi导入，CLI纯读不加载模型/工具/会话副作用。Bun成功、Node22探针或忽略engines不等于Node20支持。需要升最低版本时先给明确决定，未批准保持受影响选型blocked，不偷偷改基线。
7. **R07维护收益**：逐能力标直接复用/薄适配/patch/提取/局部重写及证据；许可、补丁/提取可重建，改变上游接口/serializer的坏变体能让向量失败。重写项必须说明前面路线何处不成立，不能把风格差异当理由。生产无多算法fallback/双真实推理，升级比较只用合成离线输入。

Fake只替模型服务和受限Host能力，不替Pi被测算法；expected独立定义，不能调用同一函数生成两侧结果自证。测试运行前正常准备锁定依赖，测试本身无下载/真实外网/用户配置/生产路径。新依赖准入可在实现票完成，本轮文档工作不安装。

## Decision / bounded exit

一次公共API纵切先给成功/具体缺口，随后只验证必要补丁或提取；不无限等待上游合并，也不同时造三套生产实现。可按部分能力选中不同来源函数，但一个adapter/一套生产计划固定组合，无runtime fallback。最低Node版本、许可或公开API缺口未解决时是本票的明确阻断，不是LIVE任务。

Done要求选型已可运行复现、CTX-R全部适用断言执行、实际制品、来源/许可清单和独立固定提交review。结果区需填：`candidate`、`adoptedFunctions`、`adaptations`、`rejectedAlternatives/evidence`、`nodeBaselineDecision`、`artifactImpact`、`proofCommit`、`notProven`。当前均 **not-recorded**，仅安装包事实已经核对。即使本票通过，也不代表旧会话下一输入已恢复；CTX-A01仍由CTX-04关闭。

## Non-goals

不跑Pi CLI、创建Agent/SessionManager/AgentHarness或读取用户Pi配置，不接管Host工具/root/checkpoint，不更换AI SDK、不升Node、不对外发布patch/fork/PR，不重启现役服务、不运行真实摘要。独立[PI-AI-01](PI-AI-01-model-backend-qualification.md)不阻塞本票。
