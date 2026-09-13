# T39 — 官方/自定义原生会话往返与真实 App 旅程

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status / boundary

**Partial / open closeout · 2026-09-12：已有选择纵切，并新增独立原生消费者回程的隔离资格；完整原生持久化/真实旅程仍未关闭。** 本票拥有V23/V26及V16/V19的完整旅程证据，不重写T24选择、T26流、T32恢复或T35生命周期程序。原连续性F1–F6/E01–E11仍是数据安全合同；本票把已证子集连接成能关闭产品义务的双向往返，不能据此把旧历史失忆因果改成已知。

目标：同一确认Box的Bot，在原版App和CLI中执行**官方→A→B→官方→A**，不改harness、不换Bot/session/store、不合并显示历史，也能在custom保存后由原生官方消费者继续。

## Dependencies / inputs

正向真实试验前须满足T37归属门、T38无隐式身份写入、T24逐Bot选择及本次T26/codec源与packed资格。T32/T35合格恢复为长会话/小窗口子集前置；不为了普通往返红测先等待所有未来provider。T36提供活动状态语义证明，T40提供独立的持久服务/退出证明，两者与本票互不作为开发前置；最终发布由T40在全部必需证据齐备后合取。

A为已定生产入口`ccs-sub2api-xai/grok-4.6`。B必须是已批准且具备实际协议/凭据/能力资格的另一个模型；只跑合成B可以证明逻辑，不能宣称真实多模型往返完成。官方指原生Box模型，不是Temporal；独立summary/子代理原有选择不因main切换被擅改。

## 已有选择纵切证据（2026-09-12）

新增 `packages/box-runtime/test/model-switch-pipeline.test.ts`，由T24的 `model-selection` case收录：production配置写入、Host hook/client、Unix/kernel及真实Chat/Responses SDK mock HTTP，证明保存下一模型时旧TURN和工具续步不漂移；逐Botreset返回exact originalSession且其它Bot不变。owned状态写入JSON后，新modeld lifetime加载继续，metadata/工具关联保留且工具counter恰好一次。

这是本票可复用的前置夹具，不是完整原生往返：官方消费者是独立自写对象；没有原生官方provider、原生checkpoint writer、新Host OS进程、真实Memory/工具/App证明。不能将 `model-selection` 改名或将其一条通过记录直接升级为 `model-roundtrip` Done。下一步仍是下面原生消费者与完整旅程。

## Native message-state consumer qualification（2026-09-12，有限子证明）

私有研究新增`grok-bot/scripts/verify-native-message-roundtrip.cjs`，读取固定的原生`ProtoPromptSession / ProtoPromptExecutor / BasePromptBuilder`与`CoreMessageSerde2 / Utf8Serde`原代码，只在隔离VM执行选定类，不运行完整Host。使用实际packed preload的state adapter完成native→custom A→custom B→native，将原生serializer产生的message bytes写入自有临时blob/manifest，再由全新Node进程执行原生反序列化/消费者并交回packed custom B。普通reasoning、工具ID/0/false/空字符串/中文结果、summary metadata与先前executor隔离均保留；非法root的getter不能产生可提交状态。

该探针已通过，准确依赖/运行命令留在私有`private interoperability notes (not distributed)`，公共测试不依赖私有source。native SHA是保留版本`2ede71e2…`，不是现役`307de399…`；preload为`8d6cb41f…`。持久容器为owned临时manifest，**不是原生conversationState/checkpoint/blob-store事务**；未调用原生provider编码/推理、隐私包装serde、真实工具/Memory或App，不能升级为完整`model-roundtrip`通过。

探针初版两个失败都是观测夹具问题：append实际延迟到getter报非法状态；隔离VM JSON.parse会制造外realm对象，而真实Host与preload同realm。已按实际合同修正观察入口并共享原生JSON实现，不改生产状态/放宽plain-object检查或经JSON清洗输入换取通过。

## 原生消费者的第一层回程资格（2026-09-12）

本轮在私有研究中实际使用固定旧Host版本的原生PromptSession/builder/executor、request转换与response consumer，跨5个独立Node进程连接原生→实际packed managed A→B→原生→A。summary/system元数据、工具ID/参数/结果及plain reasoning保留，合成工具仅执行一次；原生回程真实转换函数能处理managed保存的窗口，回程生成的原生消息也能再次送入packed managed adapter。不是把先前owned official对象换名后宣称原生。

资格仍有限：protobuf容器和native服务stream为透明替身，持久文件是owned JSON而非原生blob/checkpoint writer；没有真实provider/完整Host loop/Memory/App。来源是固定保留版本，不等于当前live Host SHA。私有方法与版本见 `private interoperability notes (not distributed)` §9，入口为该研究仓库的 `scripts/verify-native-model-return.cjs`；公共构建/CI不依赖这个script或私有源。当前状态仍不允许签V23/V26或借此解除T37部署前门。

`model-selection`继续只支持其原有public fixture范围；`model-roundtrip`完整入口仍待原生checkpoint与实际旅程补齐，不能让新研究报告冒充这个尚未实现的case。

## Required journey

| 步骤 | 实际动作 | 独立证明 |
|---|---|---|
| 1 官方基线 | 同一原生session建立事实、读取合成随机文件并实际SendToUser | 原生provider/Host工具结果/发送关联；提示中不直接给出期待答案 |
| 2 切A | 下一TURN读取上一轮事实、执行工具并生成后续内容 | 当前TURN捕获A；官方历史metadata/tool关联仍存在，非UI回填 |
| 3 切B | 处理上轮工具结果；在活动A回合中保存B配置的反例单独测试 | 旧A TURN不漂移，下一TURN才B；其它Bot选择不变 |
| 4 custom checkpoint重启 | 从custom阶段提交原生checkpoint，退出进程后新进程加载 | 真持久root/summary/Memory可读，不从测试RAM、App/Server气泡补prompt |
| 5 回官方 | 不卸载bridge，原生官方session继续工具与最终回复 | 原生消费者能读custom写过的持久状态，证明回程而非仅passthrough函数 |
| 6 再回A | 同Bot继续；查询原版App与CLI同一条会话 | 归属/身份/历史未变，多STEP终态/交付/状态对应，无重复工具或发送 |

真实旅程使用安全的测试文件/工具和有限调用预算；预期从独立challenge/实际工具结果来，不由被测mapper生成golden。必要Memory/episode必须真正经过原生consumer；error/partial不能成为有效Memory。总结/压缩可以改变原生选窗，但展示历史/PromptSession分清，不把“请求必须有所有气泡”作为错误oracle。

## Provider compatibility and cache

- 原生state保留id、顺序、metadata、summary carrier、tool result和支持的reasoning；provider投影单向，不替代Host持久结构。opaque签名/itemId不伪造；确实无法保真支持的模型明确不合格，不静默忽略part。
- 改小窗口的目标模型先验证实际容量与预算，走T32/T35已证原生compact，或在新增provider效果前明确不支持。失败不把原选择/原root改成半份，也不能换个Bot跑短对话冒充。
- App历史来源变化、重连、Server镜像先返回，不应改变Host为相同原生窗口编码的历史前缀。timestamp/content去重不能修改正式记录；相同entry ID跨来源不是同一条消息。
- Prompt cache与会话正确性分层：稳定请求前缀/缓存标识可检查；缓存usage按实际字段投影，缺失为未观测。冷缓存/换模型/逐出也必须完整上下文继续；不把延迟或相似回答当命中证明，不伪造provider会话标识。
- cache命中率不是无条件发布门，但“缓存/历史读取影响正确性”和“未知usage伪零”是阻塞。对上游确实不返回的cache字段可有有界未观测说明，不能夸大性能承诺。

## Original App / consistency subcases

App安装保持不变，不注入DevTools/重签/清缓存制造通过。至少一段请求由真实App发出，使用实际可取得的关联标识与Host记录匹配；不能手造nonce然后声称App已携带它。CLI只作发送对照及观测，不替代App输入。

覆盖正常打开、关闭后重开、Gateway换代/重连、已有同源旧缓存、延迟副本和晚到活动/terminal。UI若无可读窗口就记录该门未证；不可按按钮后等待固定秒数视作成功。由T26验证消息输入/展示同源，T36验证当前会话Working/typing/权限等待/结束，不要求所有动画同步。

如果原版App在Server/local均一致后仍绕开Host，本票输出该Bot/App版本不兼容，不能暗中改App或扩大到Server执行接管。test2冲突不得作为本票正向候选；T38的保留与校准是另外的反例路径。

## Executable proof and evidence ladder

计划扩展现有`verify-runtime-rebuild.mjs`的`model-roundtrip` case；source/actual-packed由同一程序和owned Host/原生store fixture运行，不另开产品执行loop。复用`context-continuity*`、`responses-continuation`、`host-session-hook`、ownership和outcome测试。case未落地前只列计划，不伪造命令输出。

依次给证据：①公共自包含合成模型/真实SDK编码+Unix+owned writer；②精确原生消费者隔离资格；③真实官方/A/B模型+真实Host工具/持久会话；④原版App显示/输入；⑤T40冷启动与全卸载关联收据。每层记录实际source/packed/profile/模型/执行代和NotProven，不能跨候选借绿。

新增负例应杀死：官方回程读不了custom checkpoint、一次工具执行两遍、当前TURN重绑、另一Bot变更导致本TURN失效、Server旧消息反写prompt、截窗后假成功、Memory写入错误文本、旧终态关闭新TURN、冷缓存丢上下文。

## Closeout / next responsibility

V23无必需未证项，实际原生往返和两个真实目标协议均确认，V26正确性通过且性能可观测边界如实报告，T26/T36的原App门齐备，才可交T40发布。仅官方↔A可形成受控阶段证据，但不能把用户要求的B回程删除出最终范围。

本票只对完整旅程签证；发现源码缺陷回其owning ticket修复，再用同一未改写的oracle复验。下一动作：把已验证的原生消费者回程推进到当前版本的原生blob/checkpoint实际写入与新进程读取，再在T37/T38合格后进行真实模型/App旅程。不把owned JSON落盘当原生checkpoint，也不因部署前专项受阻而降低门。
