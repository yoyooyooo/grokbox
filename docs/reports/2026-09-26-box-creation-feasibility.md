# 2026-09-26 — Box 创建核心前提：原生对照与完整客户端编码链

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
