# 普通 Box Bot 与 Local-first：2026-09 固定 POC 精华

本页按问题归档已验证的事实和失败教训，不是现役配置、执行脚本或新版本资格。固定证据止于 2026-09-26 10:57 UTC；当时仓库报告由 `6ae46579f37aa2a8b8784f32e04c7b45cfeadb40` 保存。原始日期报告仍在[创建与运行可行性报告](../reports/2026-09-26-box-creation-feasibility.md)，不把它复制或搬离原路径。

后续实施顺序归[Local-first 回归主线](../roadmap/agent-first-cli/local-first-reintegration.md)，当前运行事实只归 [LIVE](../tickets/LIVE-integration-validation.md)。归档里的“通过”只指注明的窗口与行为，不给未来 Host 或当前已变化身份授予执行权。

## 1. 原问题与没有改变的目标

官方 App 不修改，用户仍与普通 Bot 私聊、让同一 Bot 参加多个群并运行自己的 Routine；身份和长期 Memory 尽量沿原生系统，即时上下文按会话隔离。按 Bot 选择自定义模型，未选择的 Bot 保留官方路径。主推理、工具决策和回复不依赖官方模型委托，目标包含避免不期望的官方模型额度消耗。

POC 起因不是 Agent Loop 无法实现，而是先前可用的 Box 创建路径在后续集成时失效。只在 CLI 声明 harness、通过 AST、成功加载补丁或看到自定义正文，都不能单独证明这个源头仍可用。

## 2. 创建：不同生命周期得到不同真实结果

同一官方源码基线 `26415f574d3136f23bbc57335116ecef2e13f13960eebdb1132c3435ca4a0a98` 下取得两项对照：

| 时间（UTC） | 真实过程 | 首次 Server 结果 | 结论范围 |
| --- | --- | --- | --- |
| 2026-09-26 06:06 | 原 remote-first 新建，最终请求编码 BOX=1，FRESH=1 / PRODUCT_CREATE=5 | Temporal | 显式字段正确不保证该新建路径兑现 Box 意图 |
| 2026-09-26 06:17 | 原生工厂先物化真实普通本地 Bot，再由原 ensureServerBacked 登记；BOX=1，原 caller/intent=2/2 | Box；原登记者写回相同服务端绑定 | Local-first 在该账号与窗口可行，不是本地标签伪装 |

后一个实验确实先创建本地对象，不是给远端 fresh 请求随意更换 caller。`register-existing-local` 反映真实生命周期；服务端返回、原生写回和之后的执行各有独立记录。普通创建的默认值、Temporal 请求、账号权限与服务端拒绝权不能随补丁被抹掉。

此前隔离编码实验还发现：原生 Box 意图会在某段基础请求中被省略，最终编码 UNSPECIFIED=0；已有字段修复可使所选完整客户端链编码为 BOX=1。但该局部修复不等于 remote-first 的端到端修复。只根据那一条路径失败推断所有 Box 创建都已关闭，曾经超出了证据范围。

## 3. 执行：普通私聊、多群和 Bot 自身 Routine 已在受控窗口连通

后续窗口基于官方原文 `4eafc5d62e7331c445b2eb084dae6a7717729533aebea31271f77f26cf44ddf8`，以原生 opt-out 语义暂停 Host 自动准备更新，保留身份同步、执行许可及官方 supervisor。另一个新普通 Bot 通过 Local-first 登记为 Box。

| 真实范围 | 固定结果 | 不应外推 |
| --- | --- | --- |
| 普通私聊 | 自定义 DeepSeek Loop 决定原生 Memory 写入与计算工具，结果写入该 Bot 原生私聊 | 不是正式 v2 安装/采用已验收，也不是所有工具已覆盖 |
| 两个正常群 | 同一 Bot 作为成员读取私聊长期 Memory，第二群写入另一合成事实；作者身份一致，两群即时上下文分开 | 不是以单人群替代普通私聊；未签全部群 UI 跨端行为 |
| Bot 自己的 Routine | 原定义/调度器的手动及真实定时运行，子任务和父回合都使用自定义模型并读取共享 Memory | 实际定时晚于先前 nextRunAt 投影，未签严格准点性 |
| 原 App | 用户确认 Mac 输入、切换回看、手机读取历史/Routine 结果及普通重启后续聊；nonce 与原生回复关联 | 网页及群界面的跨端点击未单独验证 |
| 官方对照 | 未切换的 Temporal Bot 经原路径回答，未进入自定义 Loop | 具体官方模型 ID、服务端隐藏辅助推理未完整观测 |

窗口内共 12 个完成的自定义 Loop 调用、21 次 DeepSeek HTTP 200。包含原生群 pass 和停用 Routine 产生的独立事件，不把它们算成用户续聊。三次普通私聊 ack 正确结清，无 ack-redrive。模型/工具的真实日志与官方计费是不同事实：**billing not observed**，没有签零扣费。

### 两个值得移植的实现教训

**回复确认必须接回原 token。** 早期 helper 只写可见回复，漏传 ackToken，原生系统认为仍欠回复并多次 redrive。后来通过原 token 的输入/fulfill 摘要、义务与计时器清除取得在线正例。修法是保持原确认链，不是删除义务、关闭重发保护或另造确认库。

**Routine 子任务不应直接冒充可见父回复。** 原 parent-mediated 子任务需要通过 finalAssistantText / automationParentWake 返回原结算链；父回合接收对象形状的提示后继续自定义推理，再由原 writer 写入私聊。保留原 scheduler、子父任务身份与生命周期，没有新增通用任务调度器。

这些是可移植的合同，不要求把临时硬编码 helper 或独立 Loop 原封不动纳入 v2。正式执行 owner、在途选择、compact/checkpoint 与安装寿命需要沿原产品架构重新接通。

## 4. 生命周期：普通重启不等于版本升级

| 对照 | 该窗口的同一身份结果 |
| --- | --- |
| 正常使用、两群、Routine | 保持 Box |
| 显式 identity reconcile | 原 Server 仍确认 Box |
| 普通 Host 重启 | 原 Server 仍确认 Box，之后手机续聊成功 |
| 正常官方 394046b → 8ae66c3 升级 | 同一 Bot 和两个群变为 Temporal；原认证客户端两次读回确认 |

升级后原始源码为 `31d937e0ad4557db56ae121c042ed3d3245bdf4fce746edd275eafcfc88366d6`。临时观察器最终恢复到该新版原文，没有用旧版覆盖它；自定义 binding 关闭，Routine 停用，测试身份和历史保留。

源码存在 applied-upgrade operation → migration pass → reconcile → 原 profile writer 的链路，但本窗口没有捕获首次变化时的完整迁移响应。升级后安装的观察器证明最终 Server 状态，不足以唯一确定内部原因。独立的服务端迁移也未排除。

暂停 Host 自动更新只控制相关自动准备流程，不撤销已有暂存命令、不阻止手动/外部升级、也不是服务端永久保留 Box 的保证。冻结几十分钟的正例不能外推数日；正常升级失败也不能推出所有受控维护方式都失败。

## 5. 已探索但不满足本项目目标的替代

| 方向 | 留存的教训 |
| --- | --- |
| 自有跨端聊天页面 | 可复用模型与状态实现；没有替代官方 App 接管的资格 |
| 官方模型调用自定义模型工具 | 可把结果送进原生历史；官方仍负责调度/收尾，不满足主推理和额度目标 |
| 房间级整体替换 | 有模型前本地入口；改变普通 Bot 心智，不作为长期主线 |
| 仅修改旧 Temporal 的本地标签 | 不改变服务端归属，客户端也可记住旧路由；不是恢复执行身份 |
| dev/helper 标签新建 | 某客户端先走 Host，但后续原远端创建请求未因此改变；无已证实的 Box 捷径 |
| 所有本地文件均为权威 | Temporal 的本地缓存/旧 Memory 不自动代表 Server 当前状态；必须核对实际读写 owner |

## 6. 私有证据目录的相对索引

下列路径相对于原普通 Bot POC 证据根；具体机器位置由操作者的私有交接给出，不成为公开构建依赖。保留原失败、unknown 和首次响应，不用汇总覆盖原记录。

| 证据主题 | 关键相对文件 |
| --- | --- |
| remote-first 负例与清理 | `full-create-evidence/original-client-request.json`、`delete-result.json`、原 final 回执 |
| 首次真实 Local-first | `local-first-evidence/local-created.json`、`original-client-request.json`、`registration-complete.json`、`loaded.json` |
| 早期 ack 缺口 | `runtime/evidence/host-events.ndjson`、`runtime/api-evidence/`、`runtime/ack-contract.test.mjs` |
| 旧身份确实被服务端改变 | `p0-lifecycle-evidence/original-client-events.ndjson`、`lifecycle-findings.json`、`restore-readback.json` |
| 完整受控窗口 | `controlled-window/evidence/execution-summary.json`、`window-events.ndjson`、`registration-complete.json` |
| 跨端与原请求 | `controlled-window/evidence/app-first-client.json`、`app-cross-client.json`、`controlled-window/runtime/api-evidence/` |
| 升级对照与最终恢复 | `controlled-window/evidence/update-boundaries.json`、`official-upgrade-observations.json`、`post-upgrade/original-client-events.ndjson`、`post-upgrade/restore-readback.json`、`final-resources.json` |
| 模型和工具原始结果 | `controlled-window/runtime/state/requests/`、`deliveries/`；区分来源进程、请求和会话作用域 |

原始 Host/worker 完整字节继续由既有内容寻址的 retained corpus 保全；其摘要不是更新后的运行资格。临时加载器的固定路径、旧 PID、Bot ID、disabled binding 和历史源码针脚不得直接拿来重跑。

## 7. 精华归档与实验退役分开

本页完成主题提炼，不声称已搬迁全部原始证据，也不授权现在删除整个 POC 目录。按 AH-194 去依赖和退役：

- **暂留用于集成**：Local-first 工厂/登记接线、controlled-window 已修 ack 与 Routine 接线、模型/工具回执。直到正式 v2 接口可替代且不再 import 临时路径。
- **保留不可再生证据**：最初服务端响应、请求/身份对应、加载/恢复、unknown/失败、客户端确认及必要原生源。先进入私有校验保留集合，再解除临时目录的证据引用。
- **可清理候选**：无引用、无活动进程、无未决效果的旧提案、生成副本、废弃页面/实验构建输出。需要按实际引用核对，不按目录名或年龄推断。

尤其旧 standalone/native.ts 可能仍被后续 POC import；“方案废弃”不代表所有代码都是垃圾。Bot 资料、Memory、官方数据库和身份不属于临时代码清理对象。公开档案只保存可公开的论证、字段级事实与索引，不保存秘密、私有源码或完整聊天。
