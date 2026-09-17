# 2026-09-17 UTC — CTX v8 成套采用、503 与备用模型验证

本报告固定 **CTX-V8 窗口**的实际操作、结果和证据边界；后续当前进度只维护在 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md#window-context-v8-20260917)。不要将这里的有限控制面通过解释成原业务长会话、原版 App、独立复审或全部发布门通过。

## 1. 用户授权与结果摘要

用户明确允许剩余代码/离线工作完成后 rebase v2、切换 Host/modeld、重启 modeld，并进一步接受上游503作为异常路径测试，指定 `sub2api-xai/grok-4.6` / `high` 作为备用测试模型。本窗口按这份授权推进，**没有把失败的独立review改成通过**，也没有取得npm发布、平台Reset、原生二进制升级或修改任意业务Bot的许可。

实际完成 config2→3显式迁移、旧回执保全、匹配profile/preload、v8 modeld和custom Host采用，以及一次正式v8 modeld replacement。doctor读回custom/ready/next=none。只创建一只隔离测试Bot并核对confirmed_box，分别保存主模型与备用high选择；最终撤销该Bot的assignment并删除，models回到原始**相同字节**。

真实端点的503与备用200通过原ModelBackend/BackendAuth执行，**不是完整原生Bot旅程**。向测试Bot发送消息的工具调用被平台安全检查拦截，没有accepted回执；只读outcome为unknown、没有echo或关联STEP。没有绕过拦截改用另一个发送接口，也没有重放旧失败业务消息。因此真实长上下文触发、native compact checkpoint和原版App仍缺证，不能从成功部署推导已经验收。

## 2. 固定源码、制品与证明现实

| 层次 | 本窗口记录 |
|---|---|
| 实际采用的v2源码 | `6fb4b48343d25f86010a832f8a9155a955ef7ea1`，已在 `feat/box-runtime-v2`，不是直接加载未合入feature |
| 基础实现与补强 | `883e224`、`269f1e2`、`358c057`、`f4b3a18`；本轮 `87463c9` 修复profile recipe比较并补summary/main503边界，`6fb4b48`固定打包pin和真实profile CLI证明 |
| 新增连续失败恢复验证 | `b77ceb0`，只增加503后下一TURN显式切模型的完整测试与verifier映射，不更改生产行为 |
| 测试稳定性收口 | `3ec15c3`，按有界异步完成检查cooler和socket背压；不强制生产同步、不删除背压/去重判据 |
| 配置/模型/协议 | config schema3 / models schema2 / wire8；普通provider retry仍off，maxExtraRequests=0 |
| 原生源身份 | `dfd1d0773c07…e33c7`，未升级或直接改写原生二进制；新profile transformed SHA `9b79e8663a35…3f7cc` |
| preload SHA-256 | `1ec09f4451c20dfd1cd783783cc477648250f9db00df0ef1961d865d2ae3db53` |
| CLI SHA-256 | `f066163307f45bafc98c03df2a0101ce7d4e782890cad734284895360f83305f` |
| 工具链 | Bun1.3.14；生产入口为集成v2的打包Node CLI。未改变公布的Node20.17最低基线 |

本轮结束前后续提交仅为测试/文档时，不要求为了让Git HEAD变化再重启生产。实际采用仍绑定上表runtime源码和制品指纹，不能把晚到的文档提交号当成运行中的新二进制。

### 非live验证

`context-maintenance` 的真实算法/SDK/Unix/Host能力测试 **56通过、332断言**，另 **11项packed/wire测试、99断言**；typecheck、build和Host import fence通过。`context-summary` **31通过、194断言**。新增连续切换测试单独执行 **2通过、37断言**。固定原生方法的隔离VM资格 **1通过、28断言**，没有真实模型或原生存储服务调用。

全库组合回归实际观察 **2248通过、7跳过、0失败，18485断言**，295文件；跳过不算通过。其后异步cold-store/背压两份测试的收口差异另执行 **15通过、61断言**。不同suite有重叠，不能相加成独立测试总数。实际源码/Node/原生隔离与真实Host部署分别取证。

## 3. 真实503与备用模型：证明到了哪一层

UTC 16:26 的限定端点检查通过生产 `ModelBackend`、`BackendAuth` 和SDK，读取已有credential引用，不在argv/普通日志复制key，不改变Bot assignment。

| 模型与请求 | 观察结果 | 能证明 / 不能证明 |
|---|---|---|
| `sub2api-codex/gpt-6-astra` / high | **1次POST，HTTP503，约535ms**；BackendFailure/provider_error，fetch资源归零，未自动重试 | 能证明实际上游503被现有backend分类并收口；不能称为Host compact失败、App警告已显示或endpoint恢复 |
| `sub2api-xai/grok-4.6` / high | **1次POST，HTTP200，约2954ms**；stop终态、预期结果匹配，fetch资源归零 | 能证明显式备用选择的backend可用；不能替原503通道签成功，不能证明真实Bot同会话切换已执行 |

请求均明确输出上限1024，实际sent模型/effort与选择相符。reported effort未知，不能以耗时或token数声称provider内部执行了某个档位。没有shadow双请求或自动失败切换；两次调用是显式不同测试。

另一次对固定源码的备用模型review取得HTTP200，但 **150秒期限到达后TimeoutError**，没有完整报告。它证明“已收HTTP头不等于语义完成、超时仍须取消收口”，**不证明代码已获独立认可**。此前Astra review的503同样保留为未完成review，不重复无限发起。review调用与canary预算单列，不把它算成Bot业务成功。

## 4. 新增离线旅程：503不能把整个会话永久堵死

`context-maintenance-provider-switch.test.ts` 用真实Pi衍生算法、Host session/facade、Unix、kernel、SDK和两个loopback模型身份执行以下连续场景。模型返回从实际材料中提取事实，不伪造摘要包含未收到的内容。

**摘要503 → 新TURN显式备用high。** 首次只有一次失败摘要HTTP，原root和最新输入保持，checkpoint为0；显式保存下一TURN模型选择并追加新消息后，重新生成合格摘要，再发一次主请求。最后只有一个成功checkpoint，早期事实与当前消息完整，旧失败维护回执仍是原值。

**主请求503 → 新TURN显式备用high。** 已成功compact并checkpoint后，主模型失败不能撤销已经提交的root；下一TURN继承该窗口，不因旧503再次无谓摘要，只用备用模型处理新输入一次。

两种场景还验证：所有备用实际HTTP均为fallback model和`reasoning_effort=high`；没有隐藏failover；错误私有明文不进入后续prompt；旧维护操作不被重写为成功；第三条普通输入不因陈旧错误/usage再次compact。它们关闭的是可重复的运行算法/状态链反例，不冒充真正的原版App或现场会话。

## 5. 实际迁移与成套加载

先保全旧打包CLI/preload、canonical config/models、安装信息、coordinator、profile和迁移回执。旧配置writer不退出时，preview正确返回blockedWriters。首次旧modeld停机后发现daemon仍阻断，原窗口恢复了备份wire7服务；没有在半迁移状态强行写新配置、删锁或删ledger。

继续时先由旧CLI `off`停daemon并临时关闭desktop idle reclaim，再按生产PID/start/UID/socket身份守卫停止已确认idle的旧modeld。第二次preview得出 **canApply=true、conflicts=[]、blockedWriters=[]**，才用该精确digest apply，最终phase为**retired**。前次retired manifest保存到原operation目录，原models字节未改。迁移本身没有启动服务或调用模型。

用新CLI `on`恢复daemon/titleSync/desktop回收，读回原desktop偏好恢复；最终config除schemaVersion之外与备份内容语义相同。

profile作者比较原recipe与当前recipe。旧分析给出的过宽slice-review列表被write明确拒绝，无写入；依write当前返回的**精确7项**进行有限复核后，正常作者路径成功，profile源SHA与当前保留原生源一致。单独的profile analyze工具调用曾被安全检查拦截，不能说它在该次成功；profile writer自身的比较/拒绝和后续成功回执分别保留。

启动固定v2的wire8 modeld后，执行正常 `host start`，结果custom/started、**forced=false**、原生忙碌门所见running=[]。doctor随后返回custom、modeldAdmission=ready、next=none；bridge观察actual=route、origin=grokbox-attested。这证明选定组合被采用，不从一次有限roster采样扩展成任意业务零中断或所有原生接点完整资格。

## 6. 备用选择、发送拦截与资源清理

创建一只hidden、notify off的隔离测试Bot，原生归属readback为confirmed_box。先通过正常model writer保存Astra/high，再显式保存用户指定的Grok/high并 `models show`读回，scope为**configured_next_turn**、currentTurn/effectiveUse仍not-observed。标题同步与单Botblast radius有回执，未触碰既有业务Bot的选择。

拟发送的是一条只回复固定标记、不运行外部工具的测试消息，但发送工具调用被平台安全检查拦截，没有accepted回执。只读history outcome显示unknown、echoObserved=false、无关联STEP/交付；未据此推导允许重新发送或改走其它API。一次context状态查询也被工具拦截。**这些是执行工具层的阻断，不是grokbox已发出HTTP503或已观测到原生compact失败。**

不继续扩大对象、改提示词绕过拦截或用另一个接口投递。测试Bot在清理前isRunning=false、isRunningTurn=false、awaitingUserResponse=false；按正常CLI撤销assignment并删除，roster后读不存在，desktop回执no_seat。models最终SHA与窗口前**逐字节相同**：`56bcf1d233ae…d5d8a`；config非schema字段也与原备份一致。没有新增残留定时任务、文件副作用或后台Agent任务。原业务Bot没有被清空历史、换模型或重放事故STEP。

## 7. 真实modeld重启与证明上限

已加载wire8后，通过正式 `runtime modeld replace --expect-epoch … --confirm`再完成一次受控replacement，旧epoch/PID换为新epoch/PID，返回replaced=true、hostRestarted=false、oldRequestsReplayed=false。新服务ready、wire8/expected8、accepting=true、activeSteps=0，普通重试仍off；读取执行历史可用，无清理失败。

这关闭的是**同v8制品modeld替换、身份换代和恢复ready的现场子项**，不关闭“真实compact后的原生Host checkpoint跨重启”——本窗口没有一次被允许投递的Bot消息，也没有真实成功compact，自然没有这种checkpoint可验。不能为了补这一行直接编辑原生root，或把临时store十轮测试和一次modeld restart拼成完整native证明。

## 8. 本窗口仍未证明的事项

在窗口结束时，真实已失败长会话的下一条普通输入、实际native摘要/accept/checkpoint、原Host重启后的该摘要续聊、原版App输入/活动/Working/交付仍未观察。测试通道的发送/状态调用被工具安全检查拦截，原版App也没有操作与视图证据。独立review没有完整结论，正式发布资格仍不成立。

后续从 [LIVE-CTX-ADOPTION](../tickets/LIVE-integration-validation.md#live-ctx-adoption)、[NEXT-INPUT](../tickets/LIVE-integration-validation.md#live-ctx-next-input)、[DURABILITY](../tickets/LIVE-integration-validation.md#live-ctx-durability)读取当前状态与动作。本报告不随未来窗口重写历史，也不授权重跑本次已成功的迁移、重建已删除Bot或复用旧nonce。任何新窗口先核对源码/原生代/配置和在途工作，保留所有unknown及用户新编辑。
