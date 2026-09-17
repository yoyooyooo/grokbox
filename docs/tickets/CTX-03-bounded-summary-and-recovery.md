# CTX-03 — 有界摘要、长材料与溢出恢复合流

Status: **Planned / Spec-only** · M3。2026-09-17规划基线 `7994b92`；没有发起模型请求、修改Bot或开启旧恢复gate。

## Goal / authority

确保“需要compact”的窗口能够通过有预算的摘要计划变为合格候选，而不是把同样超大的历史再发给摘要模型。主动维护与T32确认溢出恢复共用实际维护程序，但不混淆主请求重试、摘要请求和工具副作用。唯一合同为 [Spec S12.2/S12.5–S12.6](../roadmap/box-runtime-impl-spec.md#context-maintenance)。

## Depends on / reuse

依赖CTX-01预算/meter和 [CTX-02](CTX-02-host-context-maintenance.md) 的root准备/接受能力与operation寿命，复用现有ModelBackend/BackendAuth、S11 reasoning/最终编码、T32 tuple/零放行/一次额外主请求、F/E工具/metadata保真。参考Pi的合法分区和更新摘要，不要求T30 Pi backend实现或全局Pi可用。

## Module / change set

- 在同一kernel `context-maintenance.ts` 中执行有界分段/合并计划，复用既有backend/auth执行根；没有独立模型客户端或新的Agent工具循环。
- `host/{aux-request,aux-purpose,auxiliary,session-hook,compact}.ts` 明确增加可信 `conversation-compaction` purpose及独立request身份。它由维护operation/root能力授权，不借memory-extraction/episode的已完成parent STEP资格，也不通过正文识别。
- `backends/{context-meter,prepared,ai-sdk}.ts` 对每次摘要的system/材料/输出上限/effort/实际编码/字节限制复核，真实fetch前才计effect。无业务tools的摘要出现工具输出必须失败；不要把摘要作为主回复或Memory。
- `step-program/overflow-recovery` 把合格失败恢复送入同一个维护程序，保留原主模型/binding/STEP/selection，不由Host外层新TURN绕预算。已有普通provider恢复共享总STEP预算，不产生乘法重试。
- 目标测试 `box-runtime/test/context-maintenance-summary.test.ts` 与既有overflow/SDK/provider-recovery测试；注册有限case `context-summary`。

## Acceptance — executable targets

实现后 `bun scripts/verify-runtime-rebuild.mjs context-summary` 覆盖CTX-A08/A09/A10/A13并与owner链联测：

1. 摘要使用捕获主模型/effort的独立无工具请求，明确purpose/operation/requestId、凭据指纹、取消与authority；不依赖暂停业务STEP的执行槽。无资格purpose/旧root/假parent/重复请求在effect前拒绝，已发未知请求不补发。
2. 待摘要材料超过单次摘要H时，按Host合法完整交互组有界分段和合并；每个实际HTTP输入/输出/字节均合格，指令和前一摘要计算在内。maxSummaryRequests/maxSummaryInputTokens/父期限包含分段、合并和纠正，预算耗尽立即停止，不递归auto-compact。
3. 同一长TURN可在已完成工具组之间压缩；未闭合调用、结果关联、carrier/control metadata、新用户输入的保护不变。连续多次摘要更新而非堆叠旧摘要全文；覆盖材料区间有archive/summary映射。
4. 超大单工具结果由真实owner完整归档+可检索引用，内联预算与数据来源可验证；不支持该能力明确material_too_large，不伪造文件/检索工具。固定system/tools/最新用户输入不能容纳时给准确原因，不无效重压旧历史。
5. empty/畸形/无改善/仍超resumeThreshold摘要不提交root；preferredTarget未达但满足S12明确headroom的候选如实报告，不把任意变短当成功。摘要服务故障/取消/请求结果unknown不会进入主正文或Memory，不丢原材料。
6. provider始终支持500K、不产生overflow的本地128K主路径仍可完成；另造可信structured overflow验证原STEP一次compact及一次额外主请求。普通400/401/429/413/5xx/EOF、已有正文/思考/工具、重复/迟到/身份变化均不触发T32额外恢复。对照中可以独立存在本地预算理由，但不能把这些错误本身解释为恢复授权。
7. 断言主请求次数、摘要请求次数、工具实际执行数、唯一terminal及资源归零分别正确；故障后的新输入重新维护不复活旧STEP。所有摘要替身从实际材料计算结果，删早期事实/丢tool关联的坏变体必须被杀死。

## Forbidden / non-goals

不隐藏切换到native external/provider，不为方便开通另一模型/credential，不允许provider SDK自己auto-compact/retry/failover。禁止无限递归摘要、未经Host归档的截断、把延迟/空输出当成功、将文本指令执行为工具。明确另一摘要模型、后台预生成、多provider泛化不是本票出口前置；第一版同模型独立摘要必须可工作。

## Exit / evidence

Done需source与实际SDK/本地HTTP/Unix/owner合流、预算及安全负例、固定提交独立review。真实provider tokenizer/实际摘要质量资格与原生提交/App另分层；离线缺代码/fixture/review保留本票，不塞LIVE。本票当前实现/测试/review **not-recorded**；历史T32成功不替本票的本地主动路径背书。
