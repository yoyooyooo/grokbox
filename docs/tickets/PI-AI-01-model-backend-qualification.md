# PI-AI-01 — 进程内 pi-ai ModelBackend 独立资格

Status: **Planned / independent qualification**。本票不是CTX compact主链前置，不是T30的Pi RPC Agent backend，也不是批准替换当前AI SDK。规划基于v2 `02a6d81`；没有候选adapter、运行依赖变更或live结果。

## Goal / authority

验证直接调用 `@earendil-works/pi-ai` 的模型能力能否满足既有ModelBackend合同并减少provider适配维护；通过有证据的比较决定是否另行提议采纳。唯一边界见[Spec S6.2.1](../roadmap/box-runtime-impl-spec.md#pi-ai-qualification)，Effect、Host所有权、reasoning及错误/工具合同保持。核心compact组件的复用按[CTX-00](CTX-00-pi-compaction-reuse.md)独立推进，继续用AI SDK也能交付。

## Depends on / baseline

复用已实现T23–T26/S10/S11与当前provider/dialect反例。起始候选pi-ai 0.85.1的包/engine事实见[Pi参考](../maintainers/pi-compaction-reference.md#core-package-reuse)；未来换版本先记录导出、类型、依赖/Node和行为差异。普通模型身份/通道/凭据不因adapter变化被迁移或重新命名。

## Module / bounded scope

候选只放 `packages/box-runtime/src/internal/backends/pi-ai.ts`，通过同一ModelBackend注册/测试能力接入；private helper确有独立责任才拆分。Pi类型只留该adapter，kernel/Host不导入Pi；不增加执行根、会话store、model registry或credential writer。测试放 `packages/box-runtime/test/backend-pi-ai-conformance.test.ts`，沿已有SDK/stream/fixture框架，注册 `scripts/verify-runtime-rebuild.mjs pi-ai-backend`（目前未实现）。

首片离线证明一种已支持Chat和一种Responses编码，然后只对需要的现有qualified dialect扩展；不能以Provider支持名单推断所有当前渠道都适配。库中models catalog、OAuth/ambient auth、默认HOME配置、自动refresh、retry、图片或工具子请求等潜在效果逐项审计/禁止或显式约束，单纯传apiKey不能作为整包无副作用证明。

## Acceptance — source-bound adoption proposal

实现后 `bun scripts/verify-runtime-rebuild.mjs pi-ai-backend` 应实际执行：

1. **选择/认证**：原endpoint/API/wire model、捕获的effort、原BackendAuth lease/指纹、Header策略保持；不读Pi用户配置/ambient credentials，不执行login/refresh或换provider。unsupported档位拒绝，不能使用库的clamp帮助函数静默降级；默认/provider-reported仍分开。
2. **实际HTTP**：用同一合成输入分别跑现有AI SDK与候选，截获各自本地HTTP body/headers/次数；golden由共同合同独立给出，差异逐项解释。验证具体provider真的支持fetch注入及出站预算/工具/effort审计；不靠全局fetch mock漏掉私有SDK客户端。隔离网络边界无意外外发。
3. **工具/协议**：Chat/Responses、序列/并行批次、ID与结果关联、user-contained结果、reasoning续聊、当前MiniMax dialect、system/tools/图片等支持形状；缺字段、畸形参数、未知工具、重复结束或缺terminal不能变成成功。Host独占工具执行，候选不运行tools或自动继续Agent loop。
4. **usage/错误**：input/output/cache/reasoning归一化、未知不填0、reasoning子集不重复累计；401/429/quota/5xx/网络未知/stream错误/空输出/length按既有FailureSummary与终态规则。实际错误证据有界且不暴露正文/secret，不通过宽松容错掩盖现有失败反例。
5. **effect/取消**：单请求边界、第一次响应前后/迭代中/最终提交前取消及迟到、socket关闭；library/provider SDK内retry都要实际计数验证。provider pre-output recovery/overflow由kernel独占，不能把Pi内部多次HTTP藏成一次attempt。模型已发生未知effect不得自动切回AI SDK或重跑TURN。
6. **打包/Node**：锁定版本/依赖闭包、真实Node最低版本/ESM/bundle/冷启动/内存及import-time副作用，preload/kernel import fence。候选包的>=22.19.0要求不能无意提高项目>=20.17.0合同；升版另做明确决定，不能只测Bun/开发机。
7. **收益与反例**：报告可删除与新增的映射/补丁/依赖、当前问题是否由可复现反例覆盖、升级成本和不支持范围。比较只在离线两个隔离请求中进行，不建立生产shadow双发或失败时双backend竞速。

缺环境/文件/实际case/制品、skip、未知case都非零；公共夹具不用真实Bot/凭据或上游历史。Fake只替外部HTTP/Host，不替被测Provider实现或把期望事件直接送入kernel。

## Exit / production decision

输出 `adopt-proposal / changes-required / reject / blocked` 的固定提交报告，包含精确版本/范围、实际请求与stream oracle、Node/制品决定、独立review及notProven；这不是发布开关。离线通过后再决定是否用它替换AI SDK、限定范围和旧adapter退场，修改同一registry/配置/发布合同；未批准保留当前生产路径，CTX继续不受阻。

只有正式采纳后需要的真实Provider/原生Host/App采用才进入LIVE，并带单独source→v2映射/成本/回退边界。源码/打包/无网络资格缺口保留本票，不因登记而变ready。当前实现提交/测试/review/采纳结论均 **not-recorded**；不创建推理任务、服务或自动化。
