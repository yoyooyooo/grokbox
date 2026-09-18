# 原生当前状态控制与 v2 集成 · 2026-09-19

本报告固定CONT-00/02/07的手动当前状态基础能力。产品终局仍归[Spec S13](../roadmap/box-runtime-impl-spec.md#continuity-north-star)，操作方式归[当前状态控制](../maintainers/current-state-control.md)，动态现场状态只在[LIVE-CURRENT-CONTEXT](../tickets/LIVE-integration-validation.md#live-current-context)。这不是完整clone/自动替身/交接已经交付的声明。

## 实际实现

新增有限原生worker协议capture/prepare/apply/observe/release，通过既有worker连接、握手和队列运行。capture先读取长度再分配，在原worker SQLite读事务中遍历完整引用；apply在同一数据库事务写原生root/依赖和应用记录。准备期间阻止普通worker写入和GC，保护状态跨原worker重启保留。官方源码只在明确资格测试中内存转换，不复制到仓库。

主Host适配器绑定已创建/加载的原生AgentStore及其metadata writer，维护实际TURN/未完成checkpoint边界。新目标必须真正未启动：不能仅凭没有root认定空白，还要核对展示历史、请求/结算记录和未结Routine结果。先持久保留准备状态，再调用worker；随后CAS发布主库root指针，重载和核验内容，保存主Host应用记录。worker提交和主库发布不是同一个事务，任一中间状态保持unknown/blocked，不伪造全局回滚或再次导入。

当前基础CLI为`agents state show/capture/initialize/operation/reconcile/activate`，目标使用精确ID，变更显式确认。单次远端initialize调用拥有完整的原生准备/写入/释放生命周期，客户端不跨网络持有原生锁。CLI保存精确初始化请求，CONT管理库从v1到v2只在显式写入时迁移；只读operation不迁移。正常输出只有状态与引用，没有原始prompt/blob正文。

`agents create --harness box --defer-start`明确抑制介绍和kickstart，但不虚称已经隔离全部入站。activate只解除已经证明的准备状态，允许后续正常输入，不以用户身份补发任务、不触发一次模型推理。`runtime profile ... --capability current-state`通过既有同源reviewed baseline流程增加完整依赖组，保留原baseline，未加载者不可用。

## 收口中修正的两个竞态

原生worker事务提交期间，目标可能被另一条原生入站路径写入结果或历史。现在worker返回之后、主库指针发布之前再次核对目标是否仍为空白；不满足时保留已写worker内容和双层阻断，不能覆盖新入站、也不能宣称未执行。

准备成功与最终activate之间，root指针/字节可能仍匹配，而某个依赖已损坏。worker释放保护前会在同一事务中重读完整引用图、比对原候选摘要；不匹配则保持保护。仅root相同不能授权开放后续工作。

补齐的反例直接经过生产协调器/worker适配器；先触发错误状态，再验证不发布、不释放、不重放。目标B0之后已产生B2时，旧初始化操作重入只查原凭据，不用旧材料覆盖新进度。

## 验证与依赖真实性

开发工具固定Bun1.3.14，产品相关Node20.17.0。官方原生worker自有`node:sqlite`依赖，其资格测试单独使用原生Node22.14.0，不提高grokbox发布最低版本。

最终专项入口：

```bash
node scripts/verify-runtime-rebuild.mjs continuity-native-binding
GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-native-binding-qualified
```

第一组 **70 pass / 0 fail / 346 assertions**，覆盖有限CLI/RPC、管理库迁移、实际CONT存储、准备/初始化/激活与中断对账。第二组 **22 pass / 0 fail / 87 assertions**，包含固定Host/worker源码对、原worker线程和真实原生SQLite、持久保护与重开、既有原生格式/新Node往返。不是整主Host/App实际业务回合；第一轮真实模型输入仍需现场取证。

最终线性rebase到`a2fe878`之后，代码提交为`d040e53`，两组专项再次得到70/22 pass。最终source指纹均为`b05cde05a71558771b5dee47944bd1dc8e6de38aece4848a96e6ced584e8d8da`，801个source/test/lock输入，执行前后未漂移。实际preload摘要`99931096d84058f433d91ed1ef2c23ba56ffbeb923e1efff4f35792459a3fae9`；类型、构建、依赖边界及含未跟踪文件的隐私检查通过。最终diff清理改变构建来源指纹，旧制品pin反例确实拒绝；根据真实新构建更新制品pin后整组重验，未修改原生源码资格pin或放宽校验。

同轮较早候选完成按目录/文件分组的全仓覆盖：kernel+CLI package 266 pass，顶层test 731 pass，runtime六组1601 pass/40 skip，独立architecture 25 pass，共 **2623 pass / 40 skip**。之后新增上述两个竞态测试并用最终70/22专项重验；不能把各组合重复累加为一个更大的独立测试数，也不声称最终源码单进程完整全仓通过。

两次整批全仓/runtime运行超过工具窗口，未取得完成回执，不算通过。缩小分组后覆盖了337个测试文件；一次架构最小fixture出现esbuild超时，独立重跑25项全部通过，无业务断言放宽。已有journal锁fixture增加子进程启动握手，使等待准备锁的计时不包含模块装载延迟；未改变生产锁策略。未获得独立外部review，本轮仅完成代码检查、真实依赖限定测试与回归。

## 集成与运行边界

本线继承了J1公共接口、schema4候选和存储维护代码；线性rebase到`a2fe878`保留HCR代码及对方最新原生通知/接收者验收记录。rebase后的业务源码没有额外差异，仅LIVE的两项通知记录取最新版本；共同维护信息保留。合并代码不隐式采用新schema或新Host。

检查时日常CLI已指向单独的schema3保留分支，固定源码为`9f6b001`，现役配置读取仍为schemaVersion3。该入口不再随v2分支代码前进；本轮不迁移运行配置、不重启Host/modeld、不调用真实Bot写操作。后续schema4与current-state profile需要沿既有成套采用流程另开LIVE窗口。

## 实现缺口与现场验收分开

本次手动状态控制的真实Host加载、官方创建空目标、首轮模型请求、Host强杀/更新后续轮，以及实际App与输入边界，维护在LIVE-CURRENT-CONTEXT及关联行。

完整Memory/展示转录/附件迁移及新身份语义转换、best-effort语义重建、非空当前状态reset/recover、官方式duplicate产品入口、受管初始指令spawn、分档自动保护、逐职责替身/关系交接、旧入站收敛和退役，仍是对应CONT票的实现工作。不能把这些未写完的能力改标为“只差Live”。当前状态基础链完成并可独立集成，不等于CONT-00–11全部关闭。
