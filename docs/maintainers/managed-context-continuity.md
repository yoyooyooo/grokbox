# Managed context continuity：前向修正与端到端验收

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**状态（2026-09-12）：部分已实现/有界验证；B 仍未 closed。** 当前交付归 [Spec S0](../roadmap/box-runtime-impl-spec.md#stable-delivery)、恢复归 [T32/T35](../tickets/T32-runtime-confirmed-compact.md)，本页保留 F/E 合同的唯一 owner。基线 `pre-publication-revision` 已有 F1 executor 隔离、F2 invalid getter 拒绝、F3 canonical window/selection/usage 投影，以及 F5 purpose admission；E01–E06/E08 source 与 packed 主体通过，E07 admission 通过但完整矩阵 partial。本轮未提交工作树已修复 E09 过期 pin：Bun 1.3.14 两次相同构建，source 61 pass、packed 35+11 pass，packed E09 pass；verifier 新增 toolchain/worktreeDirty 证据。E10/E11/native 仍未完整资格化。不要按下文 2026-09-10 旧缺陷快照重做现有实现。 本页只拥有“managed 额外上下文损失”的预防修正和验收，不复制 [Host 主链地图](host-inbound-agent-loop.md)，不重排历史 tickets，不启动 [HSO](../roadmap/host-seam-ops-recognition.md)。源码基线 `pre-publication-revision`，核对日期 2026-09-10。

Owner 已选择 **B：修正可复发机制并以新 e2e 关闭** 为主。A（test0 早期上下文究竟何时、为何消失）记为 **closed-notProven**；只有新的直接前态/写入证据才重开，不再从 archive 覆盖时间反推 compact 执行时间。

依据：[D1 双向保真 / D3 Host context与Memory所有权](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md)、`PRIVATE_EVIDENCE`（R1）、`PRIVATE_EVIDENCE`（R2）及主链地图。R1优先于早期amnesia census的冲突判断。原收据/证据保留，本页不搬运私有会话或原生Host源码。

## 当前施工与新增往返门（2026-09-12）

本页F/E保持数据安全的唯一合同；新增[T39](../tickets/T39-native-model-roundtrip.md)承接官方→A→B→官方→A、custom checkpoint的原生回程与原版App完整旅程，不另定义F/E。T24提供可逆选择，T26提供原生双向流，T32/T35提供合格压缩/恢复；T37/T38先保证归属与writer不会制造分支。

| 既有合同 | T39补的完整证据 |
|---|---|
| F1/F2、E01/E02/E08 | custom保存的合法原生state由官方消费者新进程读回，非法窗口不会替代旧root |
| F3、E05/E06 | A/B窗口不同与旧TURN固定选择；真实usage未知不归零，回官方不重新猜容量 |
| F4/F5、E07 | 同原生会话Memory/episode实际经过；错误/半输出不成为Memory，切模型不换writer |
| F6、E09 | 同候选source/packed/profile/原生版本，输入漂移不能借旧绿 |
| E04/E10/E11 | 真恢复后续聊和checkpoint重启，原版App与官方回程，不用UI历史填prompt |

Prompt cache属于性能证据，不是会话SoT：同原生窗口的历史投影不因App/cache来源变化而重写；冷缓存不损上下文，未知缓存统计不造0。完整矩阵、真实B与失败oracle归T39；本页旧计数为历史窗口，本轮没有新跑用例。

## 1. 产品锁与“关闭”的精确含义

- **默认零截断。** 不按条数/字符数/token预算/关键词丢弃Host给定的窗口；CAP只有显式支持、显式设置并披露降级时才可能生效。本票不新增或恢复CAP；未设置绝不能裁剪。当前源码/dist未发现该near-window CAP，live unset仅沿用R1的日期观测，不冒充新进程检查。
- **Host选窗，grokbox传窗。** 正常compact允许Host用summary/carrier替代旧消息；验收不是让每个模型请求永远包含App全部历史。不得prepend `store.db`、UI jsonl、archive或另做grokbox摘要补偿。
- **零截断≠无限制。** 超出已声明的编码/传输限制时明确拒绝，不能截短后报成功；被拒绝的转换不能产生可发布的空/半份root。provider已发生的effect不伪称“未发送”，不盲目重试。
- **两个不变量：**（a）每个executor按Host合法的bind/append/clear序列保存自己的窗口，完整保留支持的Host控制metadata；（b）provider边界只做已审语义投影，不反写其canonical视图为Host state。成功checkpoint→新进程restore后仍满足它们。
- B覆盖合资格Host profile、受支持消息形状/模型/预算及本页用例；不承诺模型语义召回百分百、任意未来Host ABI、外部数据库损坏或合法Host compact后逐字全历史。单元/合成green、改一行maxTokens、仅重建dist、仅不再抛missing-step，都不是B关闭。

## 2. 可复发机制排序：不是历史归罪排序

H为主链地图中固定SHA的`host-main.cjs`。这里“已证”指源码和有界合成探针证明了适配器行为/消费者条件，**不指已证明它就是历史A的写入者**。

| 排序 / 机制 | 已证的第一处错误与后果 | source / dist / 验收映射 |
|---|---|---|
| **M1 高：executor共享可覆写main窗口** | 两个getExecutor访问器返回同一对象，共享messages；aux append/clear或另一次有参bind会改变原main getter看到的窗口。官方Proto每次new builder | `session.ts:163–232`；dist `1374–1456`；H:687857–687869。新探针确认无参aux带入main、aux追加改变main。→ F1 / E01,E04,E07 |
| **M2 高：Host控制metadata在state边界丢失** | `hostStateToMessages → parsePromptMessages`投影只回role/content，id/providerOptions不保留。isSummary、userInfoSummarizationEpoch等直接参与Host分区/rerender/prefix判断；正文没截短也不等于Host语义保真 | kernel `context.ts:94–138`、host `context-codec.ts:45–54`；dist `507–547`。R1及新探针确认。→ F1 / E01,E03,E04 |
| **M3 高：拒绝状态仍可读成正常空/半窗** | 非法bind catch清messages；clear后append失败只记invalidState，但getState/getMessages仍成功返回数组。上层checkpoint从getState序列化，这条出口没有传播invalid状态 | `session.ts:170–179,221–231`；dist同形；H:591201、600493–600503。新探针用JSON-safe unsupported part证明空/半窗可序列化；**未执行原生checkpoint，也未证明历史持久丢失**。→ F2 / E02,E08 |
| **M4 中高：容量/用量信号损坏** | toHostStreamResult强制`maxTokens=0`、cache字段归零，部分Host能力字段不透传；普通S/P在W=0为false，即使U很大。它阻断正常compact反馈，**自身不执行删除旧消息** | `session.ts:76–97,122–156`；dist `1329–1373`；H:508516–508544、738103–738241。当前ModelRecord没有context-window字段，parser会丢新增未知字段。→ F3 / E05,E06 |
| **M5 中高：main辅助推理被STEP门禁拒绝** | memory/episode复用main session，调用无STEP；managed拒绝，正常事实提取/episode可能不能完成。它们不是专用external summary；后者缺agentId而official，generic self-summary则有STEP | H:697672–697744、751873–751931；`session.ts:181–220`。R1逐条用途是关联证据，新探针只证拒绝行为。→ F5 / E07,E10 |
| **M6 高但有源码修正：旧制品把错误当生成内容** | 旧dist的visibleFailureHandle发error text-delta，文本收集型memory consumer可当模型输出。新source已改抛出/拒绝，**不能以HEAD代替实际制品** | source `session.ts:99–156,292–309`；dist `1517–1533`；H:697672–697683。R1有Memory聚合匹配；新探针对比source无错误文本/拒绝，旧dist仍有文本/fulfilled。→ F4,F6 / E07,E09 |

[session.ts](../../packages/box-runtime/src/internal/host/session.ts) · [Host codec](../../packages/box-runtime/src/internal/host/context-codec.ts) · [kernel context](../../packages/runtime-kernel/src/internal/contract/context.ts) · [model schema](../../packages/runtime-kernel/src/internal/selection/models.ts) · [selection revision](../../packages/runtime-kernel/src/internal/selection/selection-revision.ts)。完整source/dist hashes与探针在本机收据。

不是新增病因：模型root从blob图恢复而非展示表；UI行数不能证明输入缩短；当前CAP未设置不能解释历史改写；普通SendToUser/settlement/tray只是不同观察面。R1对这些已作纠正，不重新沿用amnesia census的B/E总论。

## 3. 最小修正集

### F1 — Host状态保真 + 每次factory独立executor

- 将可变messages/invalid状态放在**executor实例**，`getExecutor()`与untracked访问器每次新建；无参为空，有参为该窗口的独立快照。共享的仅是既有transport/选择/去重能力，不因factory分离削弱同STEP不重复effect门禁。
- Host state采用Host边界的有界安全clone，保留本profile支持的全部own-data字段（至少id、providerOptions及其中summary/user-info/request标记、content blocks）。未知不可安全表示的形状明确拒绝，不静默丢字段、不执行getter、不通用解封opaque wrapper。
- `getState/getMessages`返回独立副本，append/bind不alias调用者对象。**provider canonical envelope仍由stream时产生**；不为了保留Host metadata把任意私有字段发给provider，也不把CCS投影反写Host builder。不建立第二会话store。

### F2 — 非法状态不得变成可checkpoint的成功值

- 完整验证一个append/bind批次再提交，失败不部分追加；失败标记必须被state读取/序列化边界感知。禁止`getState()`在invalid时返回`[]`或仅新system，冒充完整有效窗口。
- 选择明确策略：invalid executor的`getState/getMessages`抛有界typed错误，直至Host明确clear并重新提供完整合法窗口；不由grokbox从产品库恢复/拼接。已有合法executor不因另一个实例失败而变化。
- 非法bind/clear+非法append、provider前拒绝、error/abort checkpoint都验证**旧持久root不被空/半窗覆盖**。Host主动合法clear/compact保持原语义；不以“保护历史”为由忽略它。

### F3 — 恢复Host容量/用量合同，不伪造阈值

- 为已解析的canonical `ModelRecord` 增加 **`contextWindowTokens`**（目标字段），正的safe integer，代表该model/endpoint的已资格化context window，不是generation `maxTokens`。同步parser/CLI校验、capture、selection revision、binding pin及Host extendedUsage投影；当前parser不保留该字段，不能只改JSON就声称修好。
- 优先使用受支持且可信的adapter容量元数据；没有就使用该canonical模型记录中的已核验值。不得根据模型名字猜、借官方旧模型窗口、硬编码200k到生产或取本次输出上限。改窗口参与selection revision，TURN内不静默换窗口/模型。
- 未知window在qualification/admission明确不可用；未知usage不伪造0/0成功。若请求后才发现usage不可用，按真实阶段一致地失败/披露，保留已发生effect与合法state，不用重试补造统计。stub的合成用量只算fixture，不当真实模型资格。
- 保留实际input/output/cache统计及已资格化Host能力字段；不向所有模型伪造`supportsSelfSummary=true`或early-h。Host仍拥有S/P、图片/错误分支与摘要接受，**本修正不调用新compact RPC**，也不实现 [T32](../tickets/T32-runtime-confirmed-compact.md) 的confirmed-overflow恢复。

### F4 — 错误只作为错误，不作为Memory/历史正文

沿用并核验c48dc32已做的throw/rejection，补齐actual artifact与辅助consumer的回归。response、fullStream、usage的终态不能一个错误另一个假成功；本地拒绝不发伪model text-delta。辅助推理中途失败不提交部分“提取结果”或错误句为Memory。允许Host保留真实已产生的partial assistant/tool状态，不假称所有失败后上下文必须为空；不伪造tray/settlement或通过直接写库修历史。

### F5 — 辅助推理正向能力：必须显式purpose，不能全放开无STEP

**2026-09-11 局部进展：** Owner 已批准 D2；`pre-publication-revision` 落地 [Host purpose seam](e07-path-b-host-admission.md)，source/packed Host admission 已有证明。下列完整 F5/E07/native 验收仍未全部闭合；本页其余 B 关闭门不因这片而取消。

**F1/F2/F4能阻止辅助调用污染main，但不能恢复Memory生成。M5不得被偷偷从B的验收中删掉。**

选定的最小方向是：保留专用external summary的official routing；memory-extraction/episode在新独立executor上走**同一已选managed模型的inference-only辅助请求**，Host仍负责提取策略与Memory写入。主STEP fence原样保留，不以无STEP、无tools、prompt文本/模型名、executor调用次数来猜purpose，不静默回官方模型。

实现前的窄接口gate：

1. 固定Host profile必须能从真实memory/episode调用点携带可信的`memory-extraction|episode` purpose，经usage wrapper到executor；现有mainSessionOptions无法区分这两个调用。候选薄接缝是H:751873–751931两处辅助getExecutor调用及H:738199–738245包装透传，**不是已存在的新API**。
2. grokbox辅助请求具有自己的**aux request id**和独立request lifetime，关联可信Host generation/Agent/parent TURN/已捕获selection；不得把自造id伪装成Host STEP/TURN、使用常量STEP或借旧STEP重放。权限与取消仍经既有modeld/auth/backend程序，不能另建模型/工具loop、第二auth store或Memory writer。
3. 辅助请求仅允许已审用途和无tools输入；工具调用输出为可见拒绝。旧generation、选择不符、过期父binding、重复/取消等保持fence，不为aux自动re-pin。purpose是adapter的可信调用事实，不是provider返回字段或消息正文。
4. 这会触及Host接缝/ABI和request-kind合同：**须D2精确证据、schema/validator/tests与独立批准后才实施该部分**。不绕当前两slice校验，不顺手借T32的v4版本号/恢复权限，不靠HSO全量实现解围。owner未批准或qualification缺失时输出`auxiliary_unqualified`，保持main数据安全，但**B整体仍pending**。

### F6 — 制品与资格门禁，而非顺手live refresh

新回归既跑source也跑本次构建/打包的真实preload/modeld；receipt固定commit、Bun/Node、产物SHA和compiled profile。不能source通过后继续拿旧dist标兼容，也不能将完成build当已加载。当前pass不重建/部署运行中的Host；后续如确需live refresh，先写完offline证据与精确blocker，再等owner「继续」。

## 4. 新e2e必须经过的真实边界

**不能只在codec输出端断言，也不能让fake直接返回预期答案。** public测试使用独立自写Host contract fixture，不复制私有Host；真实grokbox preload → session/hook → context codec → modeld Unix transport/production composition → kernel/binding/auth →真实AI SDK adapter →owned mock HTTP/SSE →Host-shapedconsumer →owned blob/root store →进程退出/重开→下一TURN。Host policy/tool/Memory/store writer是fixture，grokbox程序不许替换；数据库与Unix socket为local-real，provider为Fake，不宣称native Host已跑过。

当前 `host-fullstream.test.ts` 的`serve/dispatchLayer/produceFor`、真实SDK mock与`host-entry.test.ts`的exact hook可以复用，不复制另一套grokbox调度。先把Host fixture的builder/policy oracle与固定源码接口独立核对；**expected不能调用被测codec/compact算法来生成自己**。现有`host-session.test.ts`只证明同一executor的getter副本，不证明factory隔离；现有stream green不覆盖root持久化→重启→summary/memory→下一轮。

每案至少观察：

- Host选窗与executor state的count、role分布、字节/digest、控制metadata（synthetic payload可在断言内比较）；每个state commit有明确Host操作来源。
- 真正序列化的Chat/Responses请求：独立golden投影保留所有应送内容/顺序/tool关联；metadata仅在应属于Host的边界保留。
- summary启动/接受/epoch、root/message/archive引用的读回；新进程只能从owned root恢复，不能继承测试RAM或把UI喂回去。
- provider/aux/tool/delivery调用次数、关联id、禁用side effects的attempts及实际effects、异常/退出码；不以最终文本或计数大于0当完整证明。

### 验收矩阵（合同要求；实际已证子集与缺口见本页顶部和 verifier，非全部待实现）

| case | 输入/动作 | 必须直接断言 / 会杀死的坏变体 |
|---|---|---|
| **E01 factory + state law** | 同session取两个有参/无参/untracked executor；含summary、user-info metadata、id和mixed tool-result；修改返回副本，交错append/clear/bind；包含重复STEP | executor不同且互不修改，metadata/value/order全保留；每STEP提交快照不被后续修改；跨executor同STEP仍不重复effect。杀singleton、浅clone、drop-metadata变体 |
| **E02 invalid state → checkpoint** | 先保存合法长窗口，再unsupported JSON part、坏metadata/accessor、批次末项坏值；覆盖有参bind与clear→system→失败append，然后触发error checkpoint与重开 | 验证失败可见、getter不提供可提交空/半窗；旧root bytes/refs不变；getter未执行；provider前拒绝0effect。杀“只记invalid却返回[]/partial”变体 |
| **E03 zero-CAP长窗** | ≥600条、≥256KiB且仍在合法snapshot/request预算的选窗（配对工具消息、64KiB工具正文）；早/中/末seed可重放sentinel、中文/Unicode、user-contained result；UI/展示表额外放decoy | 实际request与Host选窗独立golden一致，sentinels和工具尾完整；decoy从未出现；getter/root不变。mock只从收到的请求推导回复，缺输入即报错，不能无条件echo预期。杀truncate/filter/store-prepend变体 |
| **E04 Host合法compact→reload** | Host fixture按独立policy启动并接受摘要，保留summary carrier/metadata与尾部、归档原材料；checkpoint后结束owned Host进程，另起进程读同一store继续工具/下一TURN | root引用、carrier及isSummary/epoch保持；早期fact由本次summary生成并在下一请求；不要求已被Host压缩的原文仍在；UI全历史不参与restore。杀把canonical state回写、drop-carrier、RAM假reload变体 |
| **E05 W/U反馈真实穿链** | 合成qualified W=200000，usage跨179999/180000/190000；用barrier控制summary完成时机，分别测mid-loop与TURN-tail | W不是0/输出maxTokens，U/cache计数来源正确；S在180000可启动，tail P在190000接受；**mid-loop可按S接受，不能统一强套P**。启动≠接受≠root commit。杀zero-W/错误单位/输出上限冒充window变体 |
| **E06 unknown/model switch** | 无window、0/负数/非整数、unknown usage；下一TURN切小窗口，旧TURN仍在；试改canonical window | 未知不报qualified成功；真实effect阶段诚实；窗口在selection pin中、旧TURN不换模型/预算；Host当前窗口原样送或明确拒绝/由Hostcompact，绝无自动chop。杀猜window/漏revision/假usage变体 |
| **E07 auxiliary正反向** | main正常STEP后独立extraction和达到interval的episode；每个成功/拒绝/半流失败；另测recordMemoryEvidence分支、dedicated external与self-summary | 成功aux恰执行并产生Host-owned合成Memory，main state不变；失败不写错误句/partial facts；recordMemoryEvidence分支只记录evidence且不跑aux；external仍official，self-summary仍带STEP。无purpose的main缺STEP、正文伪造purpose必须0dispatch；旧binding/aux重复也拒绝。杀“全部允许无STEP”与“只测拒绝”变体 |
| **E08 budget/cancel/fault** | near-boundary/超限envelope与encoded request、取消、迟到response，root发布前/后及mirror阶段故障 | 成功不裁剪；拒绝不发布缩短root；重开只读实际完整已提交root，root已提交而mirror失败不能倒称回滚；迟到旧executor不污染新main，不重复工具/delivery |
| **E09 source vs artifact** | source套件与真实built/packed preload在独立owned Host fixture分别运行E01–E08；故意送旧error-text dist/错误profile/旧SHA | 旧制品不能通过；compile/产物SHA与被测输出匹配；新source错误不能被旧dist“已修”标题覆盖；未知Host SHA拒绝，不改字面/SHA门禁 |
| **E10 whole continuity journey** | 多TURN+真实SDK Chat/Responses工具回传→普通阈值compact→memory/episode→checkpoint→全新Host进程→询问早期fact→SendToUser | 同一全链收据证明早期材料在Host窗/summary/Memory各自规定位置，provider实际收到、工具只一次、delivery确写owned展示条目；settlement单独核对，最终答案正确不是唯一oracle |
| **E11 CAP/权限负对照** | CAP unset主车道；若将来存在支持的显式CAP则单独opt-in车道；无资格profile/缺native fixture/试读真实产品根或秘密 | 默认dropCount=0；unsupported CAP不暗中启用；显式cap降级不混算B资格；真实Host writes/signals/adopt/外网effects=0，缺fixture非绿色skip |

E01/E02用property-based合法操作序列补边界；E04/E08新进程不能用同一测试内存map伪装重启。fault只作用于owned fixture，不对live Host、真实库或官方备份操作。

### 执行入口与证据上限

已存在的单一 verifier（执行输出必须保留 supports / notProven；入口存在不等于全矩阵通过）：

```bash
bun scripts/verify-context-continuity.mjs --lane contract-e2e --json
bun scripts/verify-context-continuity.mjs --lane artifact-e2e --json
```

目标测试放在 `packages/box-runtime/test/context-continuity.test.ts`、`test/context-continuity-e2e.test.ts` 及其owned fixture；F1/F2低层反例回落到现有host-session/codec tests，F3进selection/binding tests，F5进独立request-kind qualification tests。复用原codec/backend/binding/stream/layout gates；Bun按锁定1.3.14，packed Node lane按项目支持矩阵。root write/readback不得替换成纯mock返回值。

verifier先明确reality与范围，逐案输出assertion/failure/mutant结果及各境界证据；0只允许所选lane全部要求实际执行通过，断言/超时/异常退出非零；缺依赖/未实现/skip/零测试明确unavailable，不能算pass。source路径过后还须artifact lane；换Fake不能代替原本声明的native lane。

**native-consumer qualification单独列证据。** public Host fixture证明grokbox合同全链，不冒充官方完整loop。声称“此官方profile不会复发”前，还要有固定Host消费者的差分/离线隔离资格：覆盖其真实root/compact/memory/错误消费者，而非另一套复制算法。私有材料不成为公共CI依赖；该lane的可运行隔离入口若未建立，记`native_qualification_pending`，不编造已可用harness，也不转为live测试。执行完整Host只可在另获批准、无真实产品路径/凭据/外网能力的owned隔离环境；本轮不执行Host或请求该权限。

## 5. 施工切分与关闭门

1. **先F1/F2并把E01/E02/E03改成真正红→绿**：最早错误在Host-state出口，不先改数据库、阈值或prompt补偿。
2. **F3 + E05/E06**：需要实际model window资格值；只能用合成值开发，未知test0生产值是部署资格缺口，不猜填。无需实现T32或HSO。
3. **F4/F6 + E04/E08/E09**：已有error修正纳入真实制品；root→restart与相互独立账本必须进入测试。
4. **F5窄接口gate → E07/E10**：明确purpose/aux identity/生命周期与D2批准后落地；没批/没证则该片blocked，前几片可继续，但**不能标整个B关闭**。
5. 完整E01–E11、source/artifact和所声称的native资格均给出实际收据；任何剩余M1–M6未闭合或关键case未执行，输出partial/notQualified。测试与源证明是版本/边界受限的，不把有限测试提升为任意未来代码的绝对保证。

**当前下一步：复用已有F1/F2/F3/F5与已恢复的制品证明；按T37/T38准入条件推进T39的原生回程，补日用必需E07/E10/E11。** 当前E09是否通过按本次verifier输出，不按本文更早的红/绿快照；任何新产物仍须重验。 更广 proactive/更多模型后移，但当前旅程依赖的 usage/Memory/reload 不能删出稳定门。不重开历史 A；live 依 Spec S0/S9 和 readiness 的明确窗口。 F3的真实容量值与F5额外接缝批准是明示的局部gate。部署/Host刷新只有在已完成所需offline资格、写出确切blocker并另获owner「继续」后考虑；本页不是该授权。
