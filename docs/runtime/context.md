# 本地上下文维护

本页拥有 managed Box 会话的计量、摘要、原生接受和续聊合同。它不拥有模型选择、部署或另一套会话 store；这些分别归 [execution](execution.md)、[Host compatibility](host-compatibility.md) 和原生 Host。实施及独立审查差额归 [CTX 来源票](../tickets/README.md#context-maintenance)，当前现场结果归 [LIVE](../tickets/LIVE-integration-validation.md#live-ctx-adoption)。

## 当前实现与源码入口

默认维护、手动入口、Pi 受控提取、有限协议和原生安全点已经有源码实现；这不等于任意 session、tokenizer 或现役 checkpoint 已全部合格。当前生产 meter 是完整 Unicode envelope 估算与余量，不是所有模型的精确 tokenizer。图片保留原材料；无法覆盖的形状明确拒绝。手动入口仅对已加载且合资格的默认 Box session 开放，named/server/subagent 不因参数存在就自动支持。

| 责任 | 源码/操作入口 |
| --- | --- |
| 配置覆盖、预算与 policy revision | [context-policy](../../packages/runtime-kernel/src/internal/config/context-policy.ts)、[configuration](../configuration.md) |
| 选择、计量和维护状态 | kernel `internal/inference/context-*`、[维护合同](../../packages/runtime-kernel/src/internal/contract/context-maintenance.ts) |
| 算法和材料映射 | Box `internal/context/pi-compaction.ts`、`pi-projection.ts`、`vendor/pi-compaction/` |
| Host 材料、安全点与写入 | Box `internal/host/context-maintenance.ts`、`compact.ts`、`context-control.node.ts` |
| modeld 请求寿命与有限 wire | Box `internal/modeld/context-maintenance.node.ts`、`internal/wire/context-wire.ts` |
| 复用来源、许可、差异及升级 | [Pi 来源](../maintainers/pi-compaction-reference.md#core-package-reuse)及 vendor provenance |

独立 pending 摘要由原 owner 取消并等待；同 STEP 自依赖或未资格化 pending 保持有界 busy，不能称为通用死锁恢复。原生函数隔离测试不自动证明真实部署的全部存储外围和 App 旅程。

## 用户目标与触发

**旧失败长会话的下一条新输入是首要验收目标。** 新能力正常采用后，本地超预算的旧历史先维护，再完整处理这条输入一次；不要求新建 Bot、清历史、手动 compact、先成功回复或再次触发 provider overflow。原失败 STEP、已执行工具和已发送结果不因此重放。

auto 只作用于已经 opt-in、归属和原生能力合资格的 managed Box 会话。新输入、restore/换模型、工具结果进入下一主请求之前都检查；没有 assistant、缺 usage 或连续失败不能按零用量放行。manual 关闭主动摘要，但不关闭硬预算。维护不是定时唤醒，没有新意图/新状态就不循环生成摘要或空闲花费。

原生接收/队列 owner 保持新输入的 nonce、顺序、正文、附件引用和处理状态。新输入不是可被摘要丢弃的旧材料，压缩不会创建第二次 send。失败/取消保留其未执行、部分执行或未知事实；未知提交先对账。

## 一份策略、三道发送前门

精确字段、默认值、数值上限和版本由 [configuration](../configuration.md) 及 context-policy 源码维护，不在专题复制另一份 JSON schema。合并顺序是内置默认、公共 context 叶、精确模型覆盖、Bot 覆盖；unset 恢复继承，不加入凭据或模型选择。

contextPolicyRevision 绑定解析后的本 Bot 策略与算法版本，selectionRevision 仍表示模型/effort 选择。当前 TURN、工具后 STEP 和已开始维护保留捕获值；下一 TURN 才采用新策略。无关 Bot、client、desktop 或 ops 修改不失效本运行。config/models 的双版本捕获与复核不是跨文件原子事务。

预算关系如下，未知容量或输入上限不填零：

```text
W = min(本地窗口, 已知模型容量)       # 模型容量未知时仅使用本地窗口
R = max(输出预留, 最终实际输出上限)
H = min(W - R, 已知独立输入上限)    # 未知独立上限不参与 min
U = 完整待发材料计量 + 保守估算余量
自动触发：U > H                    # 等于边界不触发
```

实际输出上限不是目录最大能力；未显式设置时应采用有披露且能在最终请求落实的默认。不能把未知输出视为零或暗裁较大的显式输出。preferredTarget 与 resumeThreshold 由当前策略计算：前者是优化目标，后者是继续主请求所需余量；达到 headroom 且确有改善可报告 targetMet=false，不能把“压过一次”当成功。

keepRecent 按完整合法交互组处理，不从 token 中间切开；固定 system/tools、新输入和未闭合工具组不能丢。摘要有独立输入/输出预算，先确定输出上限再算输入容量，扣除摘要指令、固定材料和合并成本，避免循环公式。

三道门共享预算含义但各自守住真实边界：

1. **Host preflight** 在大 JSON/IPC 之前有界遍历真实 root，保留原生分区和输入引用；未知材料不能补空或删掉以通过 IPC。
2. **modeld prepare** 按实际 snapshot/编码和捕获预算复核；本地超限是 `context_budget_exceeded`，不是伪造 HTTP overflow，也不消耗失败恢复的额外主请求次数。
3. **实际 egress** 在 SDK/dialect/effort 编码之后、fetch 之前检查完整结构、字节、输入和输出预算。fetch 不 compact、不改 root、不启动第二执行器。

计量附带 method、版本、root/encoding/selection、coverage、组件统计与不确定性。只在同模型/编码/root lineage 下复用有效 usage 基线；旧 compact、模型/system/tools/前缀变化使其失效。错误/零 usage 不覆盖有效基线，cache 与 reasoning 计数按实际 adapter 语义只计一次。估算不是账单或任意端点的严格 tokenizer 保证。

## Pi 复用与请求所有权

生产只使用一个受控提取的 Pi compaction adapter。算法提出估算、合法切点和摘要候选；Host 保有原始材料、metadata、sourceRef 映射和接受权。升级按公共 API、最小补丁、可追溯提取、有否定证据的局部重写评估，不把一次 serializer 不合格解释为必须重写全部算法。

每个算法视图项绑定 operation/rootRevision/sourceRef。覆盖与保留区间须映回真实合法消息/工具组；未知形状拒绝，不无界物化整份历史，不把 Pi 虚拟 ID 或 retainedTail 当原生事实。完整覆盖是全局性质，不由每段分别通过推导。

每次真实摘要请求经已有 Effect/ModelBackend/BackendAuth，使用本次捕获的模型、effort、credential 指纹和可信 conversation-compaction purpose；没有业务 tools。算法回调没有独立 credential discovery、重试、Runtime、Pi Agent、SessionManager 或持久历史库。多段合法请求全部计入同一维护预算，不谎称只发生一次 HTTP。

库返回成功仍须检查空/length/未知终态、输入覆盖、取消/换代和预算；摘要文字是不可信材料，不执行其指令。调用前截断必须在算法投影前解决或明确拒绝，不能靠 request callback 补救已经丢失的材料。来源包、许可、提取差异和 Node/import 资格只在 [Pi 来源](../maintainers/pi-compaction-reference.md)及 vendor 记录，不依赖全局 Pi、用户配置或隐式运行时下载。

pi-ai 作为 ModelBackend 传输的候选是 [独立资格](../tickets/PI-AI-01-model-backend-qualification.md)，不是这条维护链的前置，也不是 Pi RPC Agent backend。

## 原生操作、并发与持久化

阶段表达实际发生的事：checking → waiting-safe-point → preparing → summarizing → validating → committing → committed；另有 unchanged、blocked、cancelled、failed、commit_unknown。summarizing 不表示 root 已保存，committed 不表示用户问题已回答。

固定原生 session/Host 代/root lineage、原输入、模型/策略/凭据和操作预算后，在安全点取得版本化维护能力。同 operation/同材料只加入或查询原操作，材料不符冲突；空闲手动维护有独立 operation，不伪造业务 STEP。

每个 root 只有一个摘要接受 owner，等待者取消不误杀其他需求；不同 root 独立。原 pending/self-dependent 工作由原 owner 处理，无真实停止证明就不竞争写。摘要需要独立有界资源槽；主请求保留逻辑 claim，但不能占着所有已静止 producer 槽等摘要。支持不了的依赖环明确 busy，而非抹掉 Promise。

Host 提供合法分区，算法只生成候选；接受前重验 source root、scope、归属、取消、工具关联、metadata、固定材料与新输入预留。Host 按版本和 operation 走原生 archive/carrier/checkpoint，再从同源持久事实读回并重新计量。回执丢失而已确认提交时只读回，不生成第二摘要；未知则保持阻断，不重放业务。

提交前取消阻止 accept；提交后取消不能声称回滚。原生 clear/append 一旦开始，即使 append 未返回，也属于 publication-started；后续 checkpoint 失败或 socket 取消为 commit_unknown。cleanup 未确认时保留 native_cleanup_unknown，不能靠换 operationId、后续输入或 GET 清除原生屏障。已知写入前的 summary 503/早期取消与此不同，新的用户意图可重新检查。

root 前缀变化使候选失效，只允许当前合同的有界重评估，不拼接未经验证的尾段。操作期限不因阶段、重连或 waiter 加入续期；自动/overflow 从父剩余预算中保留主请求和结算空间。多段摘要用尽预算如实停止，不承诺任意长历史一次必定完成。重启只恢复已提交 root，不复活旧 service 的 STEP。

## 巨型材料与失败恢复

按完整、已结束 user/assistant/tool 组分段，可在一个长 TURN 的已完成工具组间切分，但不能留下孤立结果或丢未完成调用。每段、合并和纠正都计入同一请求/费用预算；更新既有摘要而不是无限叠加摘要全文。

巨型单条工具结果只能由原材料 owner 保存完整数据，再使用真实可读取的有界引用；没有合资格引用能力则 `context_material_too_large`。固定 system/tools、新输入或未闭合组装不下时为 `context_fixed_input_too_large`；无法形成继续所需余量时为 `context_target_unreachable`。不能为压缩目标造引用或暗删数据。

confirmed-overflow 仅在结构化真实原因、原 attempt 静止、零正文/思考/工具释放、身份/取消/权限合格时，复用同一维护程序并允许原 STEP 一次额外主请求。普通 400/401/429/413/5xx、断流和已输出不是此授权。preflight 不算失败后 retry，摘要不是主 attempt，但成本仍计数；显式 HTTP recovery 不能与 compact 相乘扩大预算。

无改善、无模型、非法/空摘要、迟到、stale root、预算耗尽、取消或 commit_unknown 都通过安全 FailureSummary 保留阶段、provider 是否开始和真实提交状态；日志本身不触发维护，不改全局模型目录或隐式切 provider。

## 操作与状态

```bash
grokbox bot context compact <bot-ref> --preview
grokbox bot context compact <bot-ref> --scope-id <account-scope> \
  --request-id <uuid> --expect-revision <preview-revision> --confirm
grokbox operation get --domain compaction --scope-id <account-scope> --request-id <uuid>
```

preview 只读，不发模型、初始化 CONT 或读取正文；compact 是独立 `context.compact` 权限下明确可能有成本的原生维护，不是给 Bot 发一句“请总结”。审批 revision 固定账号、加载 Host 代、模型选择与费用策略，不是假定未来 root 已被冻结；原生 runner 在安全点选择当时的默认 Box current root。named/server/subagent 不隐式映射。CLI/Web 共用管理 Server、原 Host facade 与 modeld 维护程序；旧 `agents context/compact` 和 CLI 直连 writer 已退出，不能用 generic exec 模拟。

`operation reconcile/resume/cancel --domain compaction <operation-ref> --bot <bot-ref> --confirm` 只作用于原请求：未派发的准备可按不可变计划续接或取消；未知派发只查原生结果，不重新调用。modeld 提交与原生 shell 结束分别取证；Server 关闭取消自己持有的 HTTP 并结算 CONT，不冒称已停止独立 Host 工作。已完成 no-op 也永久消费其原请求；安全失败与未知 checkpoint/cleanup 不混同。具体实现和测试范围见[当前管理切片](../reports/2026-09-21-compaction-management.md)。

状态分开 configured/captured、声明/有效容量、meter/余量/coverage、capability、operation/root/parent、before/after、摘要/主请求次数、accepted/persisted 和新输入阶段。不输出材料、摘要、prompt 或凭据。原版 App 的压缩活动和结束需要实际 Host 事件及可见验证，不制造 thinking token 或永久 Working。

## 证明矩阵

稳定 CTX 标识保留；表格是判据，不是当前通过表。

| ID | 必须证明的性质 |
| --- | --- |
| CTX-A01 | 旧失败长历史的一条新消息，第一主请求已维护；旧 STEP/工具不重放，新输入一次 |
| CTX-A02 | Provider 即使接受大窗口，本地小窗口仍触发；边界相等/+1、manual 硬预算 |
| CTX-A03 | 无 assistant/usage、连续错误、有效基线加新增材料；unknown 不填零 |
| CTX-A04 | system/tools/新输入/附件/工具跃增通过三道门，巨型未维护材料不先跨 IPC/fetch |
| CTX-A05 | 非法窗口/输出预留/未知容量、schema/alias/CAS/迁移/旧 writer；普通配置不改模型 |
| CTX-A06 | 旧 compact usage 失效；同 TURN 旧策略、新 TURN 新策略，无关域不误失效 |
| CTX-A07 | 同会话大模型换小模型先维护，不复用旧 meter、不换 harness/历史或隐藏 effort |
| CTX-A08 | 多工具、长 TURN、未完成调用、metadata/carrier 与结果身份完整 |
| CTX-A09 | 摘要自身超限时有界分段/合并；巨型结果、膨胀/空摘要；实际每次 HTTP 和总成本受限 |
| CTX-A10 | 同 root 共享、多 root 独立、取消、pending/self 依赖和满槽；明确支持/拒绝而非假称通用恢复 |
| CTX-A11 | prepare/生成/accept 前后取消、撤权/换代/root 变化，真实已提交结果不被称为回滚 |
| CTX-A12 | 连续 compact/checkpoint、退出与新进程读回；旧历史不复活，事实实际进入后续请求 |
| CTX-A13 | 窄 overflow 一次恢复；普通错误/断流/已输出负例，不增加工具效果或重复终态 |
| CTX-A14 | 手动/排队/重连、同 operation 重入和回执丢失先对账，空闲无伪 STEP |
| CTX-A15 | 实际 Node 制品、旧功能 gate 退场、当前 config/wire 旧执行拒绝、import/privacy |
| CTX-A16 | 固定原生 Host/profile/制品、真实 root/摘要/工具/App/重启，独立于合成证明 |
| CTX-R01 | 固定来源和实际公共 exports/类型，不借全局路径或内部 export 冒充公共 API |
| CTX-R02 | 真实算法只读投影、完整 sourceRef/metadata 回映射、未知拒绝、有界物化 |
| CTX-R03 | 真实摘要组件经 caller-owned Effect/ModelBackend 到替身 HTTP，取消/重试调用计数真实 |
| CTX-R04 | 工具结果较长尾部 sentinel 被覆盖或明确拒绝；回调前截断、空/length/未知 finish 不假成功 |
| CTX-R05 | 独立预算 oracle 覆盖 system/tools/新输入/图片/输出，不用被测函数生成期望 |
| CTX-R06 | 声明 Node 基线的实际制品/import/冷启动；Host/kernel 无 Pi 运行时和隐式网络/写入/子进程 |
| CTX-R07 | 单一 composition、可复现依赖/patch/vendor、许可和升级负例，无双真实推理 |

现有 `scripts/verify-runtime-rebuild.mjs` 的 context-reuse/policy/owner/summary/maintenance 是有限离线入口；context-native 有单独原生隔离前提。实际套件位于 kernel context-policy/selection、Box context-reuse/context-maintenance-*、context-native-qualification 和 CLI context-commands。替换外部能力而非被验证的算法/程序；摘要替身从实际材料推导结果，缺材料不得硬编码 sentinel。

配置/模型、meter、Host root/队列/purpose、安全点、wire/SDK、持久化、Pi 提取/许可/Node 或部署制品变化时，复核相关 CTX-R/A。保留多轮维护、取消和重启反例；source、packed、原生、review、live 分层，不把既有通过或本页文字当部署授权。
