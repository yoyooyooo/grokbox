# CTX-03 — 有界摘要、长材料与溢出恢复合流

Status: **Planned / Spec-only** · M3。2026-09-17规划基线 `7994b92`；没有发起模型请求、修改Bot或开启旧恢复gate。

## Goal / authority

确保“需要compact”的窗口能够通过有预算的摘要计划变为合格候选，而不是把同样超大的历史再发给摘要模型。主动维护与T32确认溢出恢复共用实际维护程序，但不混淆主请求重试、摘要请求和工具副作用。唯一合同为 [Spec S12.2/S12.5–S12.6](../roadmap/box-runtime-impl-spec.md#context-maintenance)。

## Depends on / reuse

依赖[CTX-00](CTX-00-pi-compaction-reuse.md)选定的真实Pi算法/最小差异、CTX-01预算/meter及[CTX-02](CTX-02-host-context-maintenance.md)的root准备/接受/operation寿命；复用现有ModelBackend/BackendAuth、S11最终编码和T32安全规则。以集成Pi合法切点/摘要更新组件为主，不重写完整摘要框架；T30 RPC或PI-AI-01模型传输资格不是前置，当前AI SDK保留。

## Module / change set

- kernel `context-maintenance.ts` 协调有界计划/请求预算，调用 `ContextCompactionAlgorithm`，不复制Pi prepare/compact算法。`box-runtime/internal/context/pi-compaction.ts` 集成真实core公共API或CTX-00批准的最小patch/提取，`pi-projection.ts`负责只读材料与源引用。没有独立模型客户端或Agent工具循环。
- `host/{aux-request,aux-purpose,auxiliary,session-hook,compact}.ts` 明确增加可信 `conversation-compaction` purpose及独立request身份。它由维护operation/root能力授权，不借memory-extraction/episode的已完成parent STEP资格，也不通过正文识别。
- `backends/{context-meter,prepared,ai-sdk}.ts` 对每次摘要的system/材料/输出上限/effort/实际编码/字节限制复核，真实fetch前才计effect。所有Pi请求经现有Effect/ModelBackend；caller callback或公共Models桥不能开启default auth/retry/refresh。无业务tools的摘要出现工具输出必须失败；不要把摘要作为主回复或Memory。
- `step-program/overflow-recovery` 把合格失败恢复送入同一个维护程序，保留原主模型/binding/STEP/selection，不由Host外层新TURN绕预算。已有普通provider恢复共享总STEP预算，不产生乘法重试。
- 目标测试 `box-runtime/test/context-maintenance-summary.test.ts` 与既有overflow/SDK/provider-recovery测试；注册有限case `context-summary`。

## Acceptance — executable targets

实现后 `bun scripts/verify-runtime-rebuild.mjs context-summary` 覆盖CTX-A08/A09/A10/A13并与owner链联测：

1. 摘要使用捕获主模型/effort的独立无工具请求，明确purpose/operation/requestId、凭据指纹、取消与authority；不依赖暂停业务STEP的执行槽。无资格purpose/旧root/假parent/重复请求在effect前拒绝，已发未知请求不补发。
2. 待摘要材料超过单次摘要H时，按Host合法组约束调用真实Pi计划/生成组件完成有界分段/合并；每个实际HTTP输入/输出/字节均合格，指令和前一摘要计入。Pi内部history/prefix各次request和必要纠正均计入同一总预算，关闭且实测库内retry，无递归auto-compact。CTX-R03/R05必须在这条实际调用链上复验。
3. 同一长TURN可在已完成工具组之间压缩；未闭合调用、结果关联、carrier/control metadata、新用户输入的保护不变。连续多次摘要更新而非堆叠旧摘要全文；覆盖材料区间有archive/summary映射。
4. 超大单工具结果由真实owner完整归档+可检索引用，内联预算与数据来源可验证；不支持该能力明确material_too_large，不伪造文件/检索工具。固定system/tools/最新用户输入不能容纳时给准确原因，不无效重压旧历史。
5. empty/畸形/length/未知完成原因、无改善或仍超resumeThreshold不提交root，库Result.ok不是资格证明。针对core默认工具结果2000字符截断，在serializer前采用CTX-00批准的分段/策略差异，验证尾部sentinel的实际输入覆盖；不能在后置callback补回已丢材料。preferredTarget/headroom按S12报告，摘要故障/取消/unknown不进入主正文或Memory，不丢原材料。
6. provider始终支持500K、不产生overflow的本地128K主路径仍可完成；另造可信structured overflow验证原STEP一次compact及一次额外主请求。普通400/401/429/413/5xx/EOF、已有正文/思考/工具、重复/迟到/身份变化均不触发T32额外恢复。对照中可以独立存在本地预算理由，但不能把这些错误本身解释为恢复授权。
7. 断言主请求数、摘要请求数、工具实际执行数、唯一terminal及资源归零分别正确；故障后新输入不复活旧STEP。Pi被测算法真实运行，只有Provider返回被合成替换且必须从实际收到材料推导结果；删早期事实/工具尾或关联、隐藏重复fetch、迟到接受等坏变体必须被杀死。

## Forbidden / non-goals

不隐藏切换到native external/provider，不为方便开通另一模型/credential，不允许provider SDK自己auto-compact/retry/failover。允许复用Pi的摘要算法，但不把公开函数不足/Promise返回作为整套重写理由；新策略差异回记CTX-00的单一采纳清单，不在本票私建第二套vendor/算法。禁止无限递归摘要、未经Host归档的截断、把延迟/空输出当成功、将文本指令执行为工具。明确另一摘要模型、后台预生成、多provider泛化不是本票出口前置；第一版同模型独立摘要必须可工作。

## Exit / evidence

Done需source与实际SDK/本地HTTP/Unix/owner合流、预算及安全负例、固定提交独立review。真实provider tokenizer/实际摘要质量资格与原生提交/App另分层；离线缺代码/fixture/review保留本票，不塞LIVE。本票当前实现/测试/review **not-recorded**；历史T32成功不替本票的本地主动路径背书。
