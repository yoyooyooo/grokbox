# Bot 生命周期、保护与交接

本页说明已注册的有限 clone/replace/spawn、lifecycle、protection 和 handover 操作。语义与剩余产品边界归 [连续性合同](../runtime/continuity.md)，当前状态的 capture/initialize/reset/recover 归 [当前状态指南](current-state-control.md)，官方式 duplicate 归 [复制指南](native-agent-duplicate.md)。这些不是同一条复制命令的别名。

命令源码：[管理命令](../../packages/cli/src/management-registry.ts)、[共享管理用例](../../packages/server/src/lifecycle.ts)、[持久分阶段程序](../../packages/box-runtime/src/internal/roots/bot-lifecycle.runtime.ts)。当前迁入状态与验证归 [CLI-05](../tickets/CLI-05-implementation-follow-through.md)；[早期生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)只描述其原窗口，现场结果在 [LIVE](../tickets/LIVE-integration-validation.md#live-ownership-continuity)。

## 前置条件与影响

clone/replace/spawn 和原操作续接已使用新版绑定安装的管理 Server；服务不可用时不回退到 CLI 本地或旧 daemon。内部原生执行仍在该 Box，要求匹配的已加载 Host、账号 scope、原生 worker/profile 与配置；缺失时不自动升级 Host。模型来自配置目录并满足原准入。独立 current-state、Compact 与 handover 也已进入管理 Server，旧 CLI 直连入口及 handover 适配别名已退出，不能用历史命令绕过主体授权。

先明确源对象、材料/Memory 的去向、模型费用、激活/启动及交接发言范围。预览读取原生能力、源 profile 和模型选择，不创建目标、初始化 CONT 库、调用模型或发交接消息。`lifecycle.write` 允许生命周期预览与执行；请求程序启动还需 `lifecycle.start`，允许用户身份的交接消息还需 `lifecycle.messages`，实际阶段前重新验证。确认后的失败可能已经创建目标，不能因没有最终成功就删除重建。

| 入口 | 真实边界 |
| --- | --- |
| bot clone | 固定源与材料计划，默认到 ready，不激活/启动；结构化输入的 activate/start 分别请求释放准备和程序启动 |
| bot replace | 激活后进入 active_with_handover；不等于关系全部迁完或源已删除，start 独立显式选择 |
| bot spawn | 无源 ID，要求明确 name；初始化后激活并请求一次程序启动，不伪造用户任务或承诺自动到期删除 |
| operation list/get/resume --domain lifecycle | 查询当前主体的保留历史，或按原 request/scope/plan 明确续接；不把 unknown 创建变成可重试新操作 |

输入从 `--input @file` 或 `--input -` 读取严格 JSON。`description` 是 profile 文本，`instructions` 是受管初始指令，分别限16KiB/32KiB UTF-8；指令不进入普通回执、页面或日志。`modelId` 缺省继承源的已解析选择，null 明确使用原生模型；它不创造新的跟随关系。`snapshotRef` 必须是本安装/原账号 scope 的准确材料引用。maxRunMs 是启动预算，不是业务完成、交付或清理证明。旧 `--system-prompt-file` 及独立副作用 flags 不作为新版别名。

## 预览、执行与原操作续接

先检查安装版本 help。以下是人工选择对象与范围后的步骤，不是一键批量创建脚本：

输入文件由调用方保留 requestId，例如包含 `requestId`、`name`、`instructions`，以及必要的 activate/start/modelId 等字段。命令已指定 kind 和源对象，不得在文件内重复声明同一字段；requestId 可在文件或 `--request-id` 提供，但不能重复。

```bash
grokbox bot clone <source-bot-ref> --input @lifecycle.json --preview
grokbox bot clone <source-bot-ref> --input @lifecycle.json --scope-id <scope-from-preview> --expect-plan <plan-from-preview> --confirm
grokbox bot spawn --input @startup.json --preview
grokbox operation list --domain lifecycle --limit 20
grokbox operation get --domain lifecycle --scope-id <original-scope> --request-id <original-uuid>
grokbox operation resume <lifecycle-operation-ref> --domain lifecycle --expect-plan <original-plan> --confirm
```

预览返回 scopeId、planRevision、原操作引用、选模和指令摘要；不持久化计划。提交重新读原生状态并比对同一计划。源 profile、模型或指令改变必须重新审阅，旧摘要不授权新输入。请求正式保存在原 CONT 工作流后不可改目的；相同提交仅返回历史，继续未完阶段必须显式 resume。HTTP 断线不取消已受理程序；管理服务关闭会取消原生读写并等待原领域结算，重启后查询原身份再续接。不是所有阶段都可自动重试。

replace 的 `allowHandoverMessages: true` 允许在独立权限齐备时以用户身份发送明确的群/DM交接说明，不伪造旧 Bot 作者。没有发言许可的职责保持 blocked。继任激活后 resume 只继续原交接职责，不再次 capture/create/initialize。`ready` 或 `active` 可能只是下一阶段之前的检查点，实际续接以请求的最后阶段回执为准。

list/get 经管理 API 只读当前主体的原工作流，保留账号 scope；分页是有界 keyset，不是全安装或冻结历史。Web `/lifecycles` 只展示原/目标身份、阶段和交接链接，不提供创建、任务发起或续接按钮。原生当前可用性、业务成功、源退役与历史阶段完成分开。

步骤的 claim、原生效果、结果写回与阶段推进分别记录。创建结果未知时不换 requestId 再 create，不根据相同名称猜目标；缺少可证明的原生对账保持阻断。已完成初始化的历史重放不能用 B0 覆盖后续 B1/B2。旧 `agents clone/replace/spawn` 和 `agents lifecycle status/advance` 已退出，原生与后台适配也不继承新人工操作的主体权限。

## 保护与关系交接

保护意图在 `runtime.continuity`，由共享配置 writer 发布，不另建手写状态文件。当前默认开启对已核验属于本账号 Box 的 Bot 的发现、观察与恢复材料保全；默认 mode 为 alert、tier 为 resume，实际材料能力缺失显示 snapshot_unavailable，不制造快照。prepare/auto-replace 需要显式策略，通知仍须独立授权。各 Bot 的材料档位、暂停 Routine、关系权限与费用约束分开。显式关闭或排除的 Bot 不被默认发现重新开启。

```bash
grokbox config schema runtime.continuity
grokbox system protection get
grokbox bot protection get <original-bot-ref>
grokbox bot protection set <original-bot-ref> --input @policy-patch.json --request-id <uuid> --expect-revision <config-revision> --confirm
grokbox bot protection reset <original-bot-ref> --request-id <uuid> --expect-revision <config-revision> --confirm
grokbox system protection set --enabled false --request-id <uuid> --expect-revision <config-revision> --confirm
grokbox bot snapshot list --bot <original-bot-ref> --limit 20
grokbox bot snapshot get <snapshot-ref>
grokbox bot handover get <handover-ref>
grokbox operation get --domain protection --target <original-bot-ref-or-system> --request-id <original-uuid>
grokbox bot handover advance <handover-ref> --request-id <uuid> --expect-revision <handover-revision> --confirm
grokbox bot handover observe <handover-ref> --request-id <uuid> --expect-revision <handover-revision> --confirm
grokbox bot handover attest <handover-ref> --item-id <observed-duty-uuid> --evidence-ref <observed-duty-evidence-ref> --request-id <uuid> --expect-revision <handover-revision> --confirm
grokbox bot handover retire <handover-ref> --evidence-ref <original-observation-operation-ref> --request-id <uuid> --expect-revision <handover-revision> --confirm
grokbox operation get --domain handover --scope-id <original-scope> --request-id <original-uuid>
grokbox operation reconcile --domain handover --scope-id <original-scope> --request-id <original-uuid> --confirm
```

新版 get/list 只读原存储和进程状态，不调用原生、初始化或采集；快照页只读元数据。配置修改使用原 request-id 和 config revision，提交不证明后台已采用；丢回复后查询原主体/目标/request-id，不重放旧许可。Web `/protection` 使用同一权限、CSRF 和恢复定位。旧 `agents protection status/observe/advance` 已退出，不作为兼容别名。

后台保护现由管理 Server 的 Scope 持有。默认发现每30秒轮转至多32个原生所有权目标，累计至多128个受保护主体；观察、材料/继任推进、关系交接是独立串行通道。`runtime.continuity.intervalMs` 已供观察通道消费；容量与轮转覆盖独立显示，不宣称所有 Bot 同一时刻完成采样。同根 fd gate 保证单个后台 owner；停止先取消原生读取并结算实际回调和本地写入，不删除恢复材料、重启被暂停 Routine 或证明 Box 自启。状态、快照和模型执行资格分开。

原 Bot 引用不自动指向继任者；页面分别展示 original/current/previous。继任激活后，未完交接仍以原 workflow 引用可查；最近16条导航链接与更早省略说明只是有限展示，不回收原操作或授予退役权限。每个关系保存真实进度：群成员、DM说明、Routine停旧启新、外部依赖、旧入站覆盖不是一个成功布尔值。新 Bot 可用可以与部分关系 blocked 同时成立；活动、失败、unknown 和缺少权限必须保留。监控失败/长断档不计 quiet，近期转录没有附件也不证明目标不依赖源资源。

交接动作固定 handoverRef、当前 CONT revision、主体和 request-id。`handover.write` 不代替 `handover.messages`、`handover.attest` 或 `handover.retire`；人工操作必须属于原主体，默认保护工作流仍需当前保护策略和 `protection.write`。每次真正原生写入前都重新核对已激活继任者、原账号和权限。

`advance` 由原程序按职责依赖推进有界批次，不让调用方按数据库 UUID 顺序反复猜测。每个已声明未知效果只读回、不重发；管理批次 completed 不等于全部职责完成。`observe` 不写原生，只保留有界职责观察和入站覆盖；新的用户文本即使包含交接标记仍计入活动。`attest` 仅接受同主体原 observation 中的准确 evidenceRef，并再次读取该职责、核对输入摘要和依赖；任意人工 hash、模型自述或未支持的外部依赖不能置为 complete。

退役仍须源资源独立性和删除前屏障。当前原生 adapter 没有可靠的条件删除/入站排空能力，因此显式或自动退役都会保留对应 blocker，不绕回普通 delete。`operation reconcile --domain handover` 对退役只核原持久删除回执，没有 native port，不新采样或删除。`resume` 仅在原职责/退役 guard 下推进；未知单项不被重放。只有尚未派发的管理 preparation 可以 cancel。

Web `/protection` 与 `/operations` 共享上述用例，冲突保留原选择，刷新后先查原请求。浏览器仅保留安装、主体、handover 定位和请求 UUID，不保存审批、证据输入、材料正文或凭据。原生失联不影响已保留历史读取。实现与固定验证见[管理交接报告](../reports/2026-09-21-handover-management.md)。

## 验收与停止边界

先验证创建/初始化/激活/启动各自对应的 native 回执，再验证实际请求、原生 checkpoint、后续输入、用户交付与清理；程序 startup 的返回不替代完整官方 loop/Provider/App 证明。固定离线样例与原生选定代码资格只证明其命名范围。

全附件/引用资源迁移及源独立性、self-reset安全排队、完整外部任务与逐职责效果约束、多代关系、临时 Bot 结果交付/清理、安全墓碑退役仍需来源票实现或资格；不能统称只差现场测试。不要扩大到未授权业务 Bot，也不为验证本指南触发现役模型、创建对象或删除源。出错先保留原 ID、阶段和未知结果，继续授权内只读检查与精确对账。
