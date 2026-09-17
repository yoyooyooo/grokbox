# CTX-01 — 本地工作窗口、配置与计量

Status: **Planned / Spec-only** · M1。2026-09-17规划基线 `7994b92`；本票无实现提交、无新case执行或运行配置修改。

## Goal / authority

使128K本地预算独立于500K/1M目录声明，失败/无usage的旧会话也能测量。唯一算法、字段、默认、覆盖、schema3与生效合同为 [Spec S12.2–S12.3](../roadmap/box-runtime-impl-spec.md#context-maintenance)，决策见 [ADR](../decisions/2026-09-17-local-context-maintenance.md)。[Pi对照](../maintainers/pi-compaction-reference.md)给出固定参考和适配差异，不是CI依赖。本票不改Host root。

## Depends on / starting point

消费已合入的统一配置T57–T60、models schema2/reasoning S11与S10执行核心，不要求这些历史票重新全部Done。开工先固定当时v2提交/配置schema/wire，核对与本基线差额；模型目录、credential引用和其他领域必须保留。后续CTX-02消费本票的纯合同和捕获策略。

## Module / change set

- 新增 `runtime-kernel/src/internal/config/context-policy.ts` 与 `internal/contract/context-maintenance.ts`，经现有 `config.ts/contract.ts` 导出纯数据/规则；按S12精确锁定解析、合并、窗口/输出预留、headroom、typed错误和版本。
- 扩展同一配置schema/path/revision/runtime与现有 `config-store/config-migrate/config-application`；config2→3显式升级，普通reader/writer拒绝不支持版本，不另建compaction文件。models保持v2字节与领域writer，不以config写模型。
- 新 `box-runtime/internal/backends/context-meter.ts` 拥有provider投影计量；`host/context-budget.ts` 为有界本地根遍历/最小预算DTO消费者。共享纯规则，Host不导入完整配置、SDK或Effect。
- 修改现有 `ConfigurationRead` 和binding捕获最小policy/contextPolicyRevision，保留selectionRevision的S11含义。schema/模型跨文件捕获有限复核，配置保存不冒充运行采用。
- 在现有 `scripts/verify-runtime-rebuild.mjs` 注册 `context-policy` 有限case。测试放 `runtime-kernel/test/context-policy.test.ts`，计量/CLI/迁移反例沿现有config和backend测试家族；不提前打印其余CTX case通过。

## Acceptance — executable targets, not existing commands

实现后运行 `bun scripts/verify-runtime-rebuild.mjs context-policy`；该入口此前不存在时必须非零，不能拿本票文档当执行结果。必须覆盖CTX-A02/A03/A05/A06的本票子集：

1. 精确meter下128000窗口/16384预留：111616不触发、111617触发；同一输入500K本地窗口不触发、128K触发。模型声明比本地小取较小；声明未知但显式本地仍可工作且reported unknown；不能伪造上游容量。
2. O>reserve按实际O扣预算；未显式O落实可验证请求默认；极小W、无输入空间、超大固定内容、safe integer/map/file上限、非法覆盖与引用分别拒绝。summary预算无循环定义。阈值与压缩后目标/headroom清晰分离。
3. 有效usage+尾部估算、全部无usage、error/aborted/零值、Unicode/代码/tools/schema/reasoning/图片支持或缺口；cache与reasoning不重复计数。旧root/旧模型/旧编码usage不得回填新root，估算不标exact。
4. schema2→3 preview/apply/recover与旧writer拒绝；alias安全、重复操作、CAS冲突、取消/结果丢失、未知字段/版本和跨client/target作用域。普通读不写文件、不ack；升级不重启、发送、改模型或secret。
5. 同Bot相关策略进入contextPolicyRevision且冻结于TURN；另一Bot/client/desktop/ops修改不失效；config提交、configured-next-turn与实际captured/application分开。当前TURN仍旧策略、下一TURN新策略的跨接证明交CTX-02/04。
6. Pi行为使用独立合成golden，不调用全局安装包或下载main。实际SDK投影用本地mock；本票必须保留无网络、零root写/工具/模型effect的反例。

## Forbidden / non-goals

不以修改模型contextWindowTokens冒充本地策略；不使用第三配置/环境覆盖、按名字猜tokenizer、usage缺失填0、provider fetch后才记预算、provider adapter裁剪或反写Host state。不引入Pi Agent loop/backend、新配置writer或完整tokenizer服务框架。新命令/Host维护、摘要生成和live不由本票签署。

## Exit / evidence

本票Done需实现与旧入口处理、所有要求的离线/source/packed配置计量子集及固定提交独立review。记录source commit、meter版本、实际case/断言、负例和未证边界；不能用纯meter绿声明CTX-A01旧会话已恢复。当前实现/离线/review均 **not-recorded**，不把这些工作移入LIVE。
