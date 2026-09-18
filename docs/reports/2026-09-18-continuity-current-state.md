# 唯一当前状态：捕获、初始化与中断对账 · 2026-09-18

本报告固定在CONT持久层`722bb4a`之后的一个实现切片。合同归[CONT-07](../tickets/CONT-07-current-context-control.md)、[CONT-02](../tickets/CONT-02-continuity-snapshots.md)、[S13](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。当前现场状态只看[LIVE-CURRENT-CONTEXT](../tickets/LIVE-integration-validation.md#live-current-context)，不是本页的历史测试结果。

## 实际新增及未接入边界

`openContinuityCurrentState`提供capture、initialize和显式reconcile，程序在`roots/continuity-state.runtime.ts`；纯合同在kernel `internal/continuity/current-state.ts`，Effect-free接缝校验在`host/continuity-import.ts`。复用上一片真实CONT SQLite/内容存储和operation，不建立第二个存储、模型loop、session列表或GC。

**这是可执行协调程序和有限native port，不是已安装的官方Host适配器。** 当前没有生产`NativeCurrentStatePort`注册，没有新Gateway/CLI命令、自动capture、reset/recover/spawn/clone或原生模型请求。测试的native端是有独立落盘的合成协议；生产codec验证窗口形状，但不因此宣称官方schema/字段闭包已被解码或Agent loop已跑通。

原生绑定必须另外资格化：非修复且稳定的checkpoint读取边界、有上限的真实闭包解码、准备中的目标独占写入、候选仅暂存、原生提交与可持久读回的application凭据、受控reopen、cleanup不确定时持续阻断。`NativeApplicationMarker`是本接口要求的凭据合同，**不是声称官方已经有这个结构**。不能用CONT管理表或模型回答制造原生成功证据。此次现场源码摘要与历史资格pin不同，直接读取受工具路径范围限制；没有改历史pin来让旧探针冒充新版通过，也没有用另一读取路径绕过限制。

## 捕获与目标写入

capture先查询同requestId是否已保全，已发布则返回固定材料，不重新读源；未完成发布返回明确reconcile_required。首次捕获只调用受约束read lease，预算传至原始读取方，在异步边界前复制材料字节并验证声明图/hash，核对source identity/schema、实际root hash、原生context revision、host generation和effects缺口。前后版本不一拒绝发布；根缺失不调用salvage、导出或上传。两次相同head不是原生稳定读锁的替代品。

初始化仅接受empty/prepared且无未决执行的目标，其他状态不能被借此覆写。流程是：核对权限→在真实安全账本准备操作并保护源快照→目标原生hold→原生候选校验→重新核实权限/状态→持久领取一次派发→再次核对原始归属证据年龄→原生commit→保持hold下reopen→应用凭据和实际root核对→正常释放准备屏障→结算本地记录。

Authority port必须接现有config/ownership事实，保留原始采样时间；复用5秒证据上限，不因SQLite等待或慢原生head读取延长。actual dispatch前再次检查年龄，native writer仍必须实施它自己的真实准入。`dispatch`是本地单次领取，不是执行授权；本模块没有model/permission默认放行实现。

此次初始化范围是唯一当前工作上下文；目标身份、长期Memory、真实文件、Routine和外部任务不随之回滚。Memory/展示转录/附件的完整clone导入属于后续范围。没有以Human消息或hidden任务prompt启动业务，没有自动激活。

## 不确定性与后续进度

领取或native提交后发生异常，操作保留effect_unknown；异常/坏回执不会转成“没执行”，缺native应用记录也不会授予再试机会。显式reconcile只向native读取证据，再写CONT结算，因此它不是GET。正常只读仍由store.operation/publication等接口提供。

fresh initialize需要reopen、应用marker和实际root一致且cleanup完成，才返回prepared。reconcile只确认历史应用，不修复hold、不授予ready或activation；即使仍位于导入revision，也只返回at_imported_revision。若目标已经发展到B2，则报告advanced；同一初始化请求重入只返回原操作，不回读源、不再次生成摘要、不用B0覆盖B2。未知的旧副作用继续由实际职责用例对账。

资源由Effect拥有。只对有限原生调用/派发边界屏蔽取消，调用结算后才能释放；原生方法必须有可验证的有限资源约束，不在prepare中调用模型或网络重试。cleanup失败单独可见，不能将已读回结果当ready。真实Host强杀后准备屏障与原生收据的持续性仍需原生资格，不能由fixture替代。

## 实际验证

使用Bun **1.3.14**和Node **20.17.0**，未改变依赖锁、config schema4/models2/wire8。新增可重复组合：

```bash
node scripts/verify-runtime-rebuild.mjs continuity-current-state
```

| 范围 | 实际结果 |
|---|---|
| 新纯合同、当前状态协调、独立进程 | 35 pass / 0 fail，193断言 |
| CONT材料/存储/进程与OBS J1 | 46 pass / 0 fail，251断言 |
| 上下文维护、事务边界及制品回归 | 24 pass / 0 fail，267断言 |
| 合计 | **105 pass / 0 fail，711断言，11个文件** |

类型、构建、Host import边界与包含未跟踪文件的隐私扫描通过。验证前后source摘要为`7b0749885e340aa2d699c9082d3146ff384d433f693bb36eb73823f7cb7881f9`，765个source/test/lock文件，前后稳定；preload为`490daedbf2e6afa7b7e5b5c53c065d9686ef9cb0b7648545585f854e02c2ee7e`。pin来自实际构建；制品中来源身份改变，不等于已启用新Host hook。

主要反例：源版本漂移/缺root/预算越界、变动buffer、目标active/unresolved/并发变化、权限撤销/旧证据/慢读取超过门限、native提交丢回执、错误marker/reopen、cleanup失败、管理COMMIT丢回执、取消时等待真实写步骤。独立打包Node在领取后、native落盘后、reopen后对自身执行SIGKILL，新进程不重发；正常新进程使用已安装的合成状态经生产window codec组装，B2新进度及源材料删除也不导致重导B0。

没有全仓回归或独立复核回执。没有读取真实Bot内容、修改其状态、运行真实模型、切全局shim、迁移配置、重启Host/modeld。历史原生8探针未在这个新版Host上重签；整个J2、告警/旧入站/交接/删除仍未验收。

## 下一实施边界

先取得可合法访问的当前原生接口证据，完成CONT-00所需decoder/prepare fence/writer/reopen资格，再把这份应用程序接到真实native binding；不是在此继续用更多fixture代替这一步。然后证明真实新Box身份初始化后的第一轮请求、Host重启后第二轮继续目标最新状态，继续CONT-03和逐职责交接。现阶段缺生产绑定会明确拒绝，不创建看似可用的新CLI。
