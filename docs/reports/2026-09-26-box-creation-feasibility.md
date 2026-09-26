# 2026-09-26 — Box 创建核心前提：原生对照与完整客户端编码链

## 当前结论：已取得真实登记及普通私聊，尚未守住完整体验（08:05 UTC 补查）

本次发现并对齐了此前中断阶段留存、尚未进入本报告的真实回执。后文“未取得BOX实际请求结果”等描述保留为当时历史，不能再作为当前停点。

- **06:06 UTC：fresh路径的正确BOX请求，最初Server响应为Temporal。** 原认证客户端记录harness=encodedHarness=1、caller=5、intent=1，且启动被明确抑制。原observer与加载代的helper摘要一致；该测试对象在原窗口已清理。
- **06:17 UTC：local-first普通Bot登记实际得到Box。** 原`createBackgroundAgent`先创建真实普通本地对象，再通过原`ensureServerBacked`，caller=2/intent=2保持真实登记语义，原始编码harness=1，最初Server确认Box；原登记者随后写回相同Server ID和Box归属。这不再是合成Server对照。
- **06:30 UTC：普通私聊真实自定义Loop已执行。** 两次DeepSeek请求执行原生Memory writer与乘法工具，将合成长期代号存入该Bot原生Memory，计算19×27=513；同一原生私聊历史读回用户t0u及回复t0s0。不是群容器，不依赖官方模型先委托或最后提交。

同一已绑定身份在本次读回时为Temporal；profile修改时间07:41:34不能直接视作准确服务端迁移时刻。当前Host源码`f945b1a2`，原POC加载标记已不在现役源码。服务端首次接受、后来本地身份变化和具体变化原因要分别看待；本轮尚未确定变化的触发者，未修改任何服务端政策或把profile改回Box。

真实私聊后还出现了ack-redrive：原helper只写回复正文，没有把原options.ackToken带入send-message，原native fulfill函数因此不结清义务。结果不是多次用户续聊，而是两次额外完成回合及一次中断回合。**本次修正私有helper透传原token，并用当前原mint/fulfill/retire/timer方法及修改后的事件块验证：错/缺token不清义务，正确token只结清本Bot、撤销补发计时器、重复结清不产生第二次事件。** 不增加新的救援入口、不删除义务、不关闭保护。源码语法检查通过，尚未在线重新加载；不以该回归代签真实修复。

私有证据根为现有`grokbox-ordinary-bot-entry-poc-20260926/`：`full-create-evidence/original-client-request.json`、`local-first-evidence/{local-created,original-client-request,registration-complete}.json`、`runtime/{evidence/host-events.ndjson,api-evidence/,state/requests/}`；observer helper摘要逐一与其loaded.json核对。原历史和未知回合保留；已将旧runtime binding停用，防止把已Temporal的对象继续当当前Box目标。

本次新完整窗口plan写入被工具安全层拦截，文件未创建；另一次迁移源码/日志组合查询被拦截，均未换工具或包装规避。本次未创建Bot、发送消息、调用模型、修改现役Host或重启。**完整群成员回合、Bot自身Routine、原版客户端跨端切换、未选择Bot对照、官方推理/额度以及跨更新持续承接尚未通过。** 当前真正缺口已从“能否取得一次Box”收窄为“能否持续拥有合法执行入口并完成全套原生工作”。不要重新重复fresh创建、扩大群替代或用原函数计数冒充整体POC。

## 05:01 UTC：普通本地 Bot（非群）仍有原生工厂与客户端分流

用户不希望把群当长期替代。本轮转向原生普通对象：实际执行当前来源 `1ee741f9` 的 `materializeSession/createSession/mintAgentSession/createBackgroundAgent`，在明确替代IO的隔离环境中产生普通未绑定对象，并关联同一Bot ID的Memory与Routine store；不是群，不需要先有模型回复。原`buildSummary`保留有用户身份的普通对象、过滤无足迹空白fallback。该结果不签真实数据库、Server、实际App或模型运行。

0.58原`DL/XC/Vk`消费原summary形状，五项现行声明的私聊发送、历史读取、Routine列表、手动运行和中断均走Gateway；另一Temporal对照仍走Server。旧资料的getAgentMemories未在当前声明中找到，已剔除，不能因generic dispatcher会转发未知方法就签为可用。旧Temporal ID仅省略harness不会变成本地，global legacy server-history模式仍会丢本地历史；完整renderer、冷启动、手机/网页未验。

现场只读profile身份元数据发现61个UUID目录：55个有Server ID，5个普通对象与1个群未绑定；5个普通对象均名New Agent、没有harness字段且未列在本次Gateway名册。未读取其历史/Memory正文、未改名唤醒或复制；不能把它们当成有资格执行的现役Bot或可复活资源。这修正的是名册覆盖范围，不是否认此前可见普通Bot全Temporal的观察。

原identity `mint`隔离对照说明真实本地profile可以进入`register-existing-local`生命周期；无profile、写入关闭、已有Server ID分别不提交。合成Server答Box/Temporal时原流程分别stamp对应值，tombstone不stamp。因此“真实本地先创建、再原生登记”是不同于fresh remote-first的候选，但不保证Server会认可Box；本轮没有发送登记网络请求。只改origin=dev在原Host生成相同远端payload，已证伪它是现成的Box捷径。

优先候选为普通本地生成→正常官方登记→同一身份的私聊/群/Routine；明确未登记的普通本地模式仅作为第二候选，需另证完整客户端可达、实际Routine调度及身份同步生命周期，不能伪装Server认可或关闭原政策。正常重载查询与后续一项backfill搜索遭工具拒绝，未改包装重试。本轮没有真实新建Bot、调用模型、客户端/Host补丁或部署。私有脚本和详细结果在原工作目录旁的 `grokbox-ordinary-bot-entry-poc-20260926/`；原AH-124不重开。

## 04:17 UTC：房间级模型前接入已实现，实际加载被工具阻断并收场

本轮不再重写Agent引擎。在独立私有POC实现了按准确房间ID分流的Host接入：原SendPipeline保存用户消息并执行本地权限/BOX政策检查后，在`dispatchGroupSend`的原排队回调处分支，早于GroupChatOrchestrator及Temporal成员调用。自有loop消费准确原userMessageId/clientNonce，用原`postGroupMemberMessage`写回这个房间；发言者明确为房间自定义运行时，不冒充B成员或其私聊。普通房间保留原callback，失败/撤权不回退官方模型。

四类原函数实验通过：目标房间的两条输入与重复输入、普通对照、自有执行失败、原生执行权撤回。原调度/回复方法实际执行，但数据库、队列和模型端口为自有替身；零真实模型/网络，不能计作原App端到端成功。还验证相同正文的不同回复按新增entryId区分，不以历史正文重复判失败。

实际新建一只空闲、空历史的专用本地房间后，对准确`1ee741f9`原生源暂写两处修改，临时摘要`8fd74b6b`，Node语法检查通过。**准备重启步骤的工具写调用被安全层拒绝，没有创建/运行重启程序，没有信号、模型请求或用户消息。** 随即反向撤回两处修改，源摘要恢复原始值；Gateway仍为同一运行代，未产生hook加载标记。未改supervisor、账号门或客户端，不改包装重试受限动作。

空房间首次删除遇到transport reset，原未知尝试保留；重新读回准确对象仍空闲、历史为空后，同一UUID做一次有界的幂等清理收口，04:15 UTC返回成功。04:17 UTC名册恢复原51 Bot/4群，原ID/harness/type保持、无额外对象；活动UI选择未测。私有binding已禁用，无常驻监听；v2生产实现和旧controller历史未改。

这是一条有明确源码落点的房间形态备选，尚不是普通Temporal主私聊接管、手机/网页覆盖或零官方账单证明。下一段只值得取得获准加载后的原入口→自有loop→原生回复及续轮，不扩建验证框架、不恢复工具委托。私有实现及完整收场位于`grokbox-local-room-loop-poc-20260926/RESULT.md`，该目录在操作者私有工作区，不是公开运行时依赖。

## 03:49 UTC 新分支：原生本地群入口仍可创建，但不是普通 Bot 接管

本轮通过正常 Gateway 的 `createGroup`，明确 `creationRoute.kind=box`，只引用现有专用 B 作为一名成员。未补丁 Host 返回 HTTP200、明确新群身份、准确成员、空历史及空闲状态；没有发送消息、唤醒成员或主动发起模型调用。随后只删除该准确且再次读回为空闲的自有群，名册回到原 51 个 Bot + 4 个群，ID/harness/isGroup保持、无新对象残留。创建/删除可能改变活动会话选择，App投影与账单未测。返回回执的harness/serverId投影为null，合并了缺失与显式null，不据此冒称Server确权。

另一次原生元数据读取发现，既有四个群中三个harness=temporal、一个省略harness；不读取这些原群历史。由当前保全 `1ee741f9` 可确认：本地群创建绕开普通Bot的远端创建链，直接物化本地session；但群至少需要一个已有成员，原生默认又会把Temporal成员的回合送回Server。因此“群创建成功”不等于“换模型成功”。原clone直接拒绝群，移除最后成员也不将群转为普通Bot；没有为已被源码否定的行为再创建对象。

0.58原始 `DL/XC/Vk` 函数重放确认：新群省略harness的形状可被认定box并发向Gateway；后来同ID收到temporal声明则改走Server；全局legacy server history开启会丢掉Gateway transcript。显式harness=null是unsupported，不等同省略。此为原函数与自有外部传输的控制流检查，不签实际App/手机/网页发送、切换或像素。本轮新群独立历史读取及部分迁移材料读取遭工具层拒绝，未执行、未改包装重试；清理沿独立授权的准确对象删除完成。

**这是一条不同对象形态的备选：以官方App中的专用本地房间承载自有完整loop，可能不依赖普通Box Bot的新建。** 它仍需真正的Host-only前置执行与原生历史回程，且改变了普通主私聊的入口形态；未获这一范围的完整证据前，不替代用户目标、不宣布90%覆盖。当前没有加载群接管补丁、没有自定义模型群回复，没有确认Server身份同步或长期不迁移。下一段应只测这一个前置输入/结果闭环，不能用description工具委托、standalone网页、伪造成员执行权或清缓存代替。常规BOX=1创建的服务端初始结果仍未完成，AH-124不重开。

私有原生回执在同一模式POC目录的 `local-room-evidence/`，解释和接手范围在 `LOCAL-ROOM-RESULT.md`。生产代码未改。

## 03:15 UTC 补充：按 Bot 分流的目标是避免官方推理额度

用户明确根本目标是：始终使用未修改的官方 App，部分 Bot 走自定义模型、其他 Bot 保留官方路径；自定义 Bot 的主推理、工具决策及回复不能再由官方模型承担。官方 Server 的身份/收发/存储和 Host 的纯执行代码可以复用，并非“经过官方服务”就等于“调用官方模型”。不把官方模型委托工具或自有聊天页面当作这一目标的完成。

本轮当前 Gateway 名册 51 个 Bot 均投影为 Temporal，包含原 test0/test1；不是独立 Server List。实际模型配置还有 12 个逐 Bot assignment，其中 8 个身份在本名单中为 Temporal，4 个不在当前名单，0 个可见 Box。配置意图不等于已生效路由，不修改这些原记录，不用旧 Box 成功作当前正对照。

对当前 v2 原实现执行了三个现有定向文件：`host-selection-unavailable`、`host-session-hook`、`model-selection`，27 pass/0 fail/197 assertions。已证实限定范围内逐 Bot 官方→自定义→官方不改其他选择、坏配置不静默回退官方、已捕获选择不被未来配置重绑。**同一批测试也直接保留了“没有 Bot 身份的专用原生摘要会话返回原官方 session”。所以既有主模型接管不提供整轮零官方推理保证。** 这是当前合同的真实差额，不是本轮实际产生了官方扣费。

复用0.58.0原始客户端mapper新增三例：`ACCEPTED_BOX`、`ACCEPTED_TEMPORAL`、`DUPLICATE`最终全变成相同`{status:ok,value:{accepted:true}}`；四例原路由重放继续通过。故API受理、UI气泡、自定义正文、Gateway在线、modeld无请求，均不能单独证明Server没有推理或本轮没有扣额度。实验是原函数+自有外部传输，不是实际投递证据。

额度源仅检查配置元数据：当前执行profile未声明quota source或credential reference，没有解析凭据，没有查询到账单。现有quota实现针对`get-sand-usage-status`，只有账号级百分比/周期等，不提供按Bot或请求归因；百分比不变不足以证明小额调用为零，其他Bot同时使用也会污染总量对比。Grok Bot与普通Cursor模型/API额度不能混算；正式计量口径参考官方Grok Bot FAQ与Plans and billing，不把普通Cursor BYOK条款直接套到此产品。

下一次真正的正向POC应依次取得：合法前置本地投递；对指定Bot主会话及其有模型成本的子调用全部选择自定义且失败不转官方；未选择的Bot保留原路径；最后用能辨别本请求的官方使用记录或限定窗口账单做经济结果核对。元数据/认证RPC不是模型调用；但不推造“它们保证零产品收费”。没有计量入口时标为计费未观测，不为了账本再建设一套观测系统。

本轮普通候选/生命周期帮助与额度读取的组合调用、部分原生源码区段读取被工具层拒绝，均未执行；未换包装重试同一受限动作。没有新建Bot、发送消息、调用任何模型、改客户端、部署或重启。既有本地路由能力有可复用基础，但当前账号的本地执行入口与整轮零额度仍未证明，继续只验证这个前提，不重开AH-124，也不提前实现更多外围能力。

## 结论及边界

**续查到 2026-09-26 01:02 UTC：仍未取得明确 BOX=1 的实际服务端创建回应，没有新建对象，也没有新部署。** 新发现官方具有独立的 BOX 回合退役开关；两次新鲜认证 bootstrap 缓存中该开关均为 false，而 shared identity 为 true。这不能签为可创建/可执行，也不支持“所有 Box 回合已全面禁用”的断言。详见末节。当前可用工具的正常认证/受控执行入口不足，是本轮继续该决定性实验的具体限制，不是服务端拒绝证据。

**当前标准新建路径仍未交付可由本机 Box 承接的 Bot。** 本轮实际执行了一次不经过 grokbox 管理 Server、preload、modeld 或恢复路径的原生 Gateway 创建：明确 `harness=box`，抑制 introduction/kickstart，返回 HTTP 200 与明确原生身份，但结果为 Temporal；两次独立列表读回一致。测试对象随后由原生删除接口清理，最终列表恢复原来的 51 个 Bot、ID/harness 均保留，无新增残留。本轮未发送任何模型消息、未迁移现有 Bot、未改现役 Host 或模型配置。

这证明“创建错误只是我们管理／恢复重建造成的”不足以解释现象；**仍不证明官方所有合法 Box 路径已关闭**。本轮原生路径和此前含参数修复的 C 结果，都没有取得与真实请求对应的最初服务端响应及最终出站 BOX 枚举。不得把下面的隔离编码结果伪装成实际网络抓取。

## 实际原生对照

时间为 2026-09-26 00:33:19 UTC。正式 runtime 读面事前确认 `actual=official / origin=official / desired=disabled`，modeld 未启用。调用原生 `/api/createAgent` 一次，使用原发现／凭据读取者，不输出凭据、不采用调试器或修改运行中函数。Gateway 进程代在提交与返回之间一致；观察器记录的磁盘／保全来源是 `75aa6d77`，不据此伪造未补丁 Host 的内部加载摘要。

首次 Bun 只读名册预检超时，没有创建。相同协议程序使用固定 Node 22.22.0 后正常完成预检、单次创建、读回与清理；没有提高超时或重试写请求。`transportAttempts=1` 是本程序到 Gateway 的计数，不声明官方内部没有重试。后续另一个只读迁移元数据查询超时，不视为迁移功能不可用或服务端拒绝。

原 A unknown、B/C 的既有 Temporal 结果不重放、不改写。新对象身份、原请求、返回、两次读回、删除与非目标对比均保存在私有 POC 目录；本报告不包含私人 Bot 清单。最终再次读取时 Gateway 已由官方更换运行代，目标仍不存在、原 51 个 ID/harness 保持。原生创建/删除可能改变 App 活动选择，本轮未验该投影；保全结论不是任意用户状态逐字节不变。

## 当前源码检查及可执行编码实验

复用已运行观察器保存的 `75aa6d77` 完整证据，不为新摘要重新打包部署。与前次 `13740b50` 比较：普通 mintAgent、createRemoteAgentFirst、mintRemoteFirst、requestMint、最终远端 adapter、harness 枚举映射与普通 backend client 这些所选完整声明字节相同。外层 proxy 有变化，但当前没有覆盖普通 createAgent；`creationRoute=box` 的分流消费仍在 createGroup，不是普通 Bot 的强制选项。

本轮不再停在 requestMint 的 mock 输入。使用当前原生的三个 identity 方法、最终 create adapter、枚举、CompactMessage/protobuf 运行时和消息类，执行到原始二进制编码／解码。没有运行完整 Host、没有账号请求；传输和重试调度为自有止点，头像渲染替代为固定输出，不伪造服务端成功。

| 客户端输入 | 原生未修改的编码值 | 套用已有参数修复的编码值 |
|---|---:|---:|
| 明确 Box | UNSPECIFIED = 0 | BOX = 1 |
| 明确 Temporal | TEMPORAL = 2 | TEMPORAL = 2 |
| 未选择 harness（实验策略允许 Temporal） | TEMPORAL = 2 | TEMPORAL = 2 |

六例中 agentId 保留，FRESH=1、PRODUCT_CREATE=5 与 introduction=true/kickstart=false 正确编码、读回。旧切片确实能修正这个客户端字段缺口，编码器不会在所选链中吞掉 BOX。**但这仍不证明此前 C 实际走到了这条修正链，或服务端接受 BOX。**

另一项直接语义事实：原生 mintRemoteFirst 只对“要求 Temporal 却得到非 Temporal”做不匹配拒绝，没有对 Box 作对称约束。官方成功创建一个对象不等于满足调用者 Box 意图；grokbox 后续 mismatch 判断不是多余障碍。

## 其他正常入口的范围

- 普通 Update 的当前请求合同没有 harness，不能用它切换归属。
- 当前 Temporal 源的 duplicate 明确调用 Temporal 创建，不是有依据的 Box 后门。
- 模板创建请求没有可选 harness，取决于服务端返回。Host 保留 shared-identity 未启用时的 local-only 导入分支，但未证明当前账号会走该分支；本轮未导入模板，也没有伪造 feature gate。该分支不能自动列为已排除或已通过。
- `register-existing-local` 是有真实本地身份的登记情境，不是新建时可任意伪造的 caller/intent。
- 已查看的迁移 operator 合同为 Box→Temporal，没有从这些入口取得受支持的反向 setter；未调用任何管理员迁移接口。
- 可创建本地群、保留本地执行代码或使用云电脑，不等于取得 server/local 一致的 Box 普通 Bot。

## 最短决策与下一步

把后续依赖新 Box 身份的实施保持在前提待解状态，而非继续堆普通修复。唯一尚未闭合的决定性边界是：通过获准的正常账号客户端，实际送出 BOX=1/FRESH/PRODUCT_CREATE 后，最初服务端响应和同一身份的登记是什么。

若服务端最初明确拒绝或返回 Temporal，当前账号／该合法路径不能满足产品前提；只评估有真实合同与授权的其他路径。若先 Box 后 Temporal，转向创建后的生命周期；若出站仍非 BOX，修实际接线。不要通过伪装 caller、改本地标签、循环新建或关闭权限检查换取表面成功。

本轮未取得上述 BOX=1 真实服务端请求结果，也不声称全文件语义已穷尽。已有来源保全和账号／调试相关调用曾被工具安全层拒绝，本轮未用另一包装绕过；新的实际对照走的是不同的标准原生 API 路径。

当前主线仍归 AH-186，总控 AH-187；AH-124 历史恢复不重开。源码资格、真实原生对照、修后实际网络请求、服务端登记和业务回合是不同结论。本轮没有新增生产切片、controller、诊断框架或全仓验证前置。

## 继续追查：创建许可、回合许可和认证入口分别判定

### BOX 回合退役机制已经存在，但本账号缓存尚未启用

`de590344` 固定保全来源中，`grok_bot_box_harness_turns_blocked` 的定义明确用于退役 BOX 回合；注释覆盖服务端消息入口、Host 发送路径和 runner 启动。实际 Host 实现把同一 gate 交给 `refuseBlockedBoxHarnessSend` 与 `gateBoxHarnessRuns`：开启时发送拒绝，普通 runner 和 automation-as-subagent 均返回 aborted，而不执行模型。它不是创建参数的一部分。

通过原生 `loadCachedBootstrap` 的文件格式及 Statsig V1 的字面名/DJB2 查找规则，只读投影了官方保存的认证配置（不读凭据、不改 gate）：

| 服务端 bootstrap 获取时点（UTC） | 读取时点（UTC） | BOX回合禁用 | shared identity | durable identity / writes |
|---|---|---|---|---|
| 00:53:13.301 | 00:55:39.944 | false | true | true / true |
| 00:58:23.886 | 00:58:48.664 | false | true | true / true |

01:02:15再次读取第二份缓存，选定值一致。额外旧 gate `sand_create_temporal_agents`、`grok_bot_temporal_harness` 为 false，`grok_bot_temporal_harness_rollout` 动态配置未返回。**不能据此倒推服务端当前创建许可：正常 Host 优先消费 GetGrokBotRuntimeCapabilities，仅 Unimplemented 时退回 legacy gate。** 也没有测量运行中所有 override 或服务端随后某次请求的授权决定。原始来源引用、缓存摘要及安全字段投影在私有 POC 目录的 `policy-readback-20260926.json`。

这改变验收目标：不仅要 Server/本地均为 Box，还要合法回合被允许并实际承接。官方可在不改变切片形状的情况下改变执行策略；这属于能力可用性变化，不能要求自动修复 Agent 修改/绕过官方禁用策略。

### 其他入口的可达性

当前 shared-identity 缓存为 true，与模板走服务端创建相符；旧 local-only 条件分支不能作为当前可用后路。普通 Update、Temporal duplicate 和 group creationRoute 的边界已逐一核对。默认主 Bot、Cursor main Bot 等服务声明存在，但不是当前 Host Gateway 暴露的任意 Box 创建选择器，未调用这些会改默认对象的接口。没有为这些不满足目标的路径再新建测试对象。

本次核对了 Box 终端可见的正式 Host 认证配置项：未提供原生 dev-token/renewal provider。另只读核对 Mac 已安装 grokbox 的当前 remote profile，也没有 sandbox/quota 后端凭据引用；未读钥匙串、浏览器登录材料或 App 内部令牌，未修改 App。它们只证明这些已暴露配置不提供本轮所需的正常账号客户端，不能断言用户没有任何已登录客户端。

临时 debugger 方案此前被工具拒绝，未重试；本轮受控 profile/lifecycle 入口的查询也被工具层拒绝，未通过其它包装重发同一动作。正常原生 Gateway仍是已实测的路径，但它丢失明确 Box 意图，继续相同创建不能解决最后一个问题。官方公开创建/复制/模板说明未提供 Box harness 选择或此后端的外部认证开发接口；模型API不是这里的Bot管理API。

### 停止条件与仍需补的事实

本轮在现有获准接口下没有找到可继续的真实 BOX=1 创建入口，因此不再重复源码枚举、变换 caller/intent、增加诊断框架或重放创建。**这只是当前可执行探索到达了明确边界，不是证明平台上所有 Box 路径不可能。**

下一步需要的是一个实际获准、已认证的原生创建客户端，或可正常运行的现有受控加载入口，以完成同一请求的 BOX=1/FRESH/PRODUCT_CREATE → 最初服务端响应 → 独立登记 → 最小合法执行。不需要继续增加通用工程前置。若该正常请求被服务端明确拒绝，才把当前账号/具体路线按产品前提失败收口；若接口/认证不可用，记录 AUTH/TOOL 未完成而不是 SERVER 拒绝。

此段没有新增模型调用、Bot、生产修改、Host/modeld控制或账号策略变更。最新管理名册查询返回 unavailable，不能把空投影的0当作当前清单；最后一次成功保全仍是前段原51个ID/harness。
