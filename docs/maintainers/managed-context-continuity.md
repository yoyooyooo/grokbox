# Managed context continuity：F/E 合同与资格

本页拥有额外上下文损失的 F1–F6 不变量和 E01–E11 验收要求，不保存另一套实现进度或旧缺陷清单。当前机制归 [execution](../runtime/execution.md)和 [context](../runtime/context.md)；源码、所选 verifier lane 与来源票说明实际支持范围。原生/App/重启现场结果只在 [LIVE](../tickets/LIVE-integration-validation.md#live-context-native-continuity)。

早期“历史上下文究竟何时、为何消失”的因果调查保持 closed-notProven；只有新的直接前态/写入证据才可改变结论，不能从文件覆盖时间反推 compact。前向预防与完整连续性资格是独立工作，不因历史因果未证而停止，也不以一个适配器缺陷解释全部历史事故。

## 不变量

### F1 — 每个 executor 的原生状态独立且保真

两种 executor accessor 都创建独立 builder：无参为空，有参是合法窗口的独立快照。append/bind/getter 不与调用者或其他 executor 共享可变消息；共享的 transport/选择/去重能力不能因此变成重复 STEP 执行。

Host 边界安全 clone 保留支持的 own-data 字段、id、providerOptions、summary/user-info/request metadata、content 与工具顺序。不可安全表示的形状明确拒绝，不执行 getter、不通用解封 opaque 值。provider canonical envelope 是 stream 时的投影，不反写为 Host state，不新增会话库。

### F2 — 非法状态不产生可提交的空或半窗口

完整验证 bind/append 批次再改变 state。invalid executor 的 state/message getter 必须给出有界错误，直到原生明确 clear 并提供完整合法材料；不能返回 [] 或仅新 system 冒充有效 root。一个 executor 的失败不破坏另一个。

非法 bind、clear 后非法 append、错误 checkpoint/取消必须保留最后完整已提交 root。原生合法 clear/compact 的真实语义仍有效，不以保护历史为由忽略明确的原生操作。未知提交不是已回滚。

### F3 — 声明容量、实际用量与本地策略分开

canonical ModelRecord 的 contextWindowTokens 和 selection revision 已有实现，不再是“parser 不支持”的待建字段。声明容量必须来自合资格模型/endpoint 事实，不从名称、输出上限、其他模型或 fixture 数字猜测。旧 TURN 保留捕获模型/窗口。

unknown usage/window 保持未知，不造零或已资格化容量。**已知本地预算仍可基于有来源、带余量的估算执行维护**；未知上游容量不再意味着永久停止所有本地预算检查。三道门、实际输出预留和估算支持范围由 [context](../runtime/context.md)拥有。原生 S/P 用例中的合成阈值不是本地新策略的另一份默认值。

保留真实 input/output/cache 字段及已资格化能力，不伪造 self-summary 能力。缺统计在实际发生阶段披露，不能回头声称 provider 未执行或重试以补统计。

### F4 — 错误不是生成正文或 Memory

fullStream/response/usage 不能一个失败另一个假成功。本地拒绝不发伪模型 text-delta；辅助失败/取消不把错误句或 partial extraction 写成成功 Memory。原生已经产生的 partial assistant/tool 状态据实保留，不假称所有失败后都零副作用，也不直接写库修历史。

### F5 — 辅助推理有可信 purpose 和独立身份

[Host purpose seam](e07-path-b-host-admission.md) 已获采纳且存在源码/packed admission，不再等待旧 D2 起步决定。完整 E07/native consumer 资格仍独立。

memory-extraction/episode 使用独立 executor 和 auxiliary request identity，关联真实 Host/Agent/parent TURN/已完成 parent STEP/捕获选择；purpose 来自实际调用点和 wrapper，不由正文、模型名、无 STEP 或无 tools 猜测。辅助请求只有推理、无业务工具，仍经过原 modeld/auth/backend 权限/取消/去重；不新建模型 loop、凭据库或 Memory writer。

过期/错误 parent、generation、选择、重复或取消不能 re-pin；已知受管辅助请求失败不静默回官方。专用 external summary 与带 STEP 的 self-summary 按各自已核验路径处理。无目的地放开所有无 STEP 调用和只测试拒绝都不满足正向 Memory 能力。

### F6 — 实际制品和原生资格

source 与本次 built/packed preload/modeld 都要经过实际被声明的路径。固定 source、工具链、产物和 profile，旧制品不能借新源码描述通过。正常 require 的 preload 不因测试需要导出 session factory。构建不是加载，packed 不是原生消费者，原生隔离不是当前 App 或重启事实。

## E01–E11 验收矩阵

| ID | 场景与直接 oracle |
| --- | --- |
| E01 factory/state law | 同 session 两种 accessor、多 executor、metadata/mixed tool-result、返回副本修改、交错 bind/append/clear 与重复 STEP；证明独立完整 state、捕获不变和零重复 effect，杀 singleton/浅 clone/drop-metadata 变体 |
| E02 invalid checkpoint | 合法旧窗口后注入 unsupported part、坏 metadata/accessor、末项非法、bind 和 clear→system→非法 append；getter 不执行、不输出可提交半窗，旧持久 root 字节/引用不变；拒绝前零 provider effect |
| E03 long window without CAP | 合法预算内至少600条、256KiB材料、64KiB工具正文和早中末 sentinel/Unicode，展示表放 decoy；实际序列化请求与独立 golden 一致、工具尾完整、decoy 从未进入，mock 仅从所收请求导出答案 |
| E04 native compact/reload | 独立 Host policy fixture 启动并接受摘要，保留 carrier/isSummary/epoch、归档/尾部、checkpoint；退出再以新进程从同一实际 store 读回续聊，不能 RAM 假重启或用 UI 全历史填回 |
| E05 declared W/U | 固定原生规则的合成 W=200000、usage 179999/180000/190000与 barrier，分别验证 mid-loop S 和 tail P；启动、接受和提交独立，W不是输出maxTokens，mid-loop不能统一误套tail阈值。仅是该原生用例，不是当前默认预算 |
| E06 unknown/model switch | 缺/非法声明容量、unknown usage、下一TURN小窗口和旧TURN；不猜已资格容量、不假usage、不暗裁历史，当前本地估算策略按context合同处理，selection pin保持 |
| E07 auxiliary | main后真实extraction/达到interval的episode成功、拒绝和半流失败；独立Memory结果不改main，失败无错误句/partial事实提交；recordMemoryEvidence分支无aux，external/self各走正确路径；伪purpose/旧binding/重复无dispatch |
| E08 budget/cancel/fault | snapshot/envelope/finalencoded预算边界、取消/迟到、root发布前后与mirror故障；完整提交才可读回，mirror失败不倒称原生回滚，迟到不污染新main或重放工具/交付 |
| E09 source/artifact | 实际built/packed与source执行所声明E01–E08，旧error-text制品/错误profile/旧SHA必须失败；验证真实字节与行为，不从测试名或元数据构造绿灯 |
| E10 full journey | 多TURN/真实SDK编码的工具回传→compact→Memory/episode→checkpoint→全新进程→早期fact→SendToUser；检查实际provider材料、root/Memory分属、工具一次和owned显示写入，settlement另证，正确答案不是唯一oracle |
| E11 scope/CAP negatives | 默认无截断；未来显式支持CAP只能独立降级车道；不合资格profile、缺nativefixture、真实数据/secret访问必须拒绝。owned隔离测试没有真实Host writes/signals/adopt/外网effects，缺fixture不算绿色skip |

E01/E02 可用合法操作序列补边界；E04/E08 用新进程和真实受控存储。fault 只作用于 owned fixture，不能对现役 Host、业务数据库或官方备份注入。成功 native compact 本来允许摘要替代原文，零暗裁不等于无限窗口或逐字召回保证。

## 实际执行路径与证明上限

```bash
bun scripts/verify-context-continuity.mjs --lane contract-e2e --json
bun scripts/verify-context-continuity.mjs --lane artifact-e2e --json
```

入口和判定在 [verifier](../../scripts/verify-context-continuity.mjs)。实际 suite 复用 Host hook/session、context codec、production Unix/modeld/kernel/auth、真实 SDK 编码到 owned mock HTTP/SSE，再经独立 Host-shaped consumer/store/new process；不能替换被验证的 grokbox 程序或让 fake 无条件回预期答案。版本取 package/lock，结果保留 supports/notProven。

只在所选 lane 的 oracle 真实执行通过时声明该范围；缺依赖、零测试、全 skip、超时和异常退出不是 pass。E07 admission 已存在但总体完整 matrix 不由此闭合。E09 状态由实际 lane/pin/packed factory 结果决定，不把旧报告红或绿写成永恒状态。当前独立 review、native、E10/E11 和完整连续性边界以对应输出、来源票和 [T34责任路由](../tickets/T34-astra-milestone-residue.md)为准。

原生 qualification 使用固定版本的真实消费者和隔离差分/方法证明，不能把公共合成 Host 称为原生完整 loop。私有材料不是公共 CI 依赖；没有合资格隔离入口就记录缺口，不能改叫只剩 live。真实运行、App、官方↔自定义往返和重启由 [T39](../tickets/T39-native-model-roundtrip.md)与 [LIVE](../tickets/LIVE-integration-validation.md#live-session-roundtrip)分别签范围。

## 历史与失效

旧机制排序、source/dist旧行号、阶段起步指令与当时计数保存在精确历史对象，不再作为当前缺陷地图：

```bash
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/maintainers/managed-context-continuity.md
```

源/制品、Host ABI/root/aux、模型容量/编码/usage、writer/持久协议或取消资源边界改变时重验相应F/E，不重开无新证据的历史归因。保留未完成产品义务，连续完成授权范围内的实现和隔离验证；现役采用、费用和不可逆数据操作仍需对应窗口范围，旧“继续”不是新的授权。
