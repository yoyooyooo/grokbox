# 显式单次原生通知发送 · 2026-09-18

本片实现提交为 `45d77c519d820cbc4773c2eb2f7f6e4dd6de01d9`，基于接收者预检候选 `e3b7aa9`。它把原有配对和outbox接到真实HTTPS发送器，不再只有测试driver。合同归[Template Ops Spec](../roadmap/template-ops-automation-spec.md#payload)、[T43](../tickets/T43-native-webhook-contract.md)、[T45](../tickets/T45-template-webhook-delivery.md)；现役采用与接收者回合仍只在[LIVE](../tickets/LIVE-integration-validation.md#live-ops-routines)登记。

## 本片出口，不是默认自动启用

```bash
grokbox ops notifications send <work-id> --expect-binding-revision <n> --expect-model-revision <sha256> --confirm --json
```

只选择一条已经保全现场的真实work，不接收任意JSON、URL、key、正文或模拟Human消息。用户确认涵盖本次可能产生的原生模型用量；binding revision来自配对状态，model revision来自用户已检查的receiver预检。Routine必须已由另一项明确操作启用，且相比配对时禁用定义只变化enabled位。发送命令不启用Routine、不重新领取凭据、不改变Bot模型/persona、不授予后台发送能力。

程序经既有 `runOpsNotificationDelivery`执行：读取并二次核对prepared私有绑定、managed ID/定义、固定提醒prompt、当前Host/模型和Server所有权；同一SQLite先预留既有work、attempt及唤醒额度，再在锁外发送，实际传输结算后写回。调用两次、并发调用、换别名或结果unknown不会获得第二次POST。CLI的correlation仍是原work，不能新造work绕过去重。

## 实际边界

`ops-explicit-delivery.runtime.ts`装配本次显式driver，不新增队列/数据库。`nativeExplicitReceiverReader`复用同帧模型/Host观察；本地预检不成立时不扩大为Server读取。成立后使用既有Host官方读取与`decideManagedOwnership`核对当前Box身份、稳定账户scope、local可执行状态和原始证据年龄。模型revision必须匹配调用方确认值，配对与Gateway代际及受管定义必须相符。所有权读取不是claim/harness写入。

模型及权限见证保持原时间，不能因本地读取结束而续鲜。发送前改变model/定义/账户scope/配对/通知策略时停止，已预留但被拒绝的attempt不返还为新的重试资格。预检仍不是实际接收者回合、工具权限沙箱或未来永久资格。

私有capsule owner新增内部发送方法，凭据不交回CLI或通知载荷。实际HTTP只允许原项目生产backend `https://api2.cursor.sh`，路径由Agent和Routine身份计算并与保存值比较。密钥只放Authorization Bearer头。Node HTTPS正常验证证书、不接环境proxy、不跟随redirect、不重试。测试注入的request工厂不属于CLI/Profile/config输入。

`validateNotificationBody`在秘密边界重构并核对canonical envelope、route身份、原始byte digest、固定摘要、命令和期限，最多8KiB；不能用一个自己重算的hash夹带任意正文。响应最多读取32KiB，仅计数并丢弃，不持久保存body/headers/Location/错误原文。完整200为native-accepted；受限4xx拒绝为definitely-not-accepted，其他成功码、redirect、5xx、过大/残缺响应、断连和取消为unknown。请求和响应描述符关闭后才结束传输，不留后台晚写。

官方[Routines说明](https://cursor.com/help/grok-bot/routines)在本日核对，定义POST、Bearer sender key、可选JSON以及200接受但非完成的边界。最低事实已实际写入`docs/upstream-integration.md`，关闭以前未落盘的Current Home同步项。公开文档不替代本机真实TLS/接收者回合验收。

只读list/show现在区分nativeTransport=not_probed、explicitDelivery=single-confirmed-attempt和automaticDelivery=unavailable；查询不运行POST、初始化、领取密钥或修复旧配置。diagnostics按需Skill同步实际命令和unknown处理。J1接口与CONT的恢复/交接/退役owner不变。

## 固定验证

固定Bun1.3.14、原依赖与Node基线。可重复组合：

```bash
bun scripts/verify-runtime-rebuild.mjs native-notification
```

在干净提交45d77c5上实际完成 **122 pass / 0 fail**，9文件、967断言；类型、构建、导入边界、隐私检查均通过。前后source指纹相同：`c5563924a1ffd55cc79b87d949c40390bf88070d6b5701fd49169466d5b6255a`（796个源码/测试/锁文件）。实际preload SHA-256为 `b01a16e01f4ad0a49b94afa6bb1deb3d49f96c482aed826b1dcbfa6093372f78`，拒旧pin据真实构建固定。

最终回归按不重叠范围：

| 范围 | 实际结果 |
|---|---|
| 全CLI/test目录，70文件 | 736 pass / 0 fail，5991断言 |
| packages排序1–87 | 576 pass / 4 skip / 0 fail，3884断言 |
| packages排序88–174 | 598 pass / 16 skip / 0 fail，4636断言 |
| packages排序175–261 | 702 pass / 0 fail，9374断言 |

合计 **2612 pass / 20 skip / 0 fail**，没有重叠计数。跳过的原生资格不计通过。此前receiver切片遗漏的末86文件也先在未改源码的rebase基线上独立完成697项，无失败；不能继续把该项作为阻断。

新23项运行时HTTP测试使用真实临时配置/SQLite/capsule、原生与Server事实的合成边界、真实loopback HTTP和独立Node传输worker。验证attempt先落盘、网络期间本地锁可用、Bearer仅上线、payload约束、并发单发、指定模型/ownership/ref变更拒绝、redirect不外跳、异常结果不重投及取消关闭。另2项source/packed Node CLI测试验证确认与参数限制、未配对拒绝无网络/新attempt；同帧reader新增2项Server读取界限测试。J1原14项继续通过。

### 开发中真实发现与未掩盖的失败

初次HTTP测试发现Bun的node:http可能先发request close、再发response end。原实现过早把200写成unknown；改为等待实际响应结束和双方close，并以真正Node进程验证，不放宽状态判据。body替换测试最初误从仅metadata的work清单读payload，已改用现有固定notice读取器；生产投影未放宽。

首次完整packages运行的两个Bun子进程崩溃测试未到预定阶段而被deadline SIGTERM。单独重跑通过，但未计全量成功；随后把这些测试改为构建并运行真实Node/native-SQLite worker，明确断言start已提交、runtime=node和SIGKILL，保留原期限与无重播要求。第二次整目录运行遇到一个既有架构检查子进程deadline，未计通过；未改生产门禁或增大该期限。架构文件单独26项通过，最后三组完整回归全部通过，残留同进程整目录超时现象仍作为测试宿主限定记录。

独立Astra审查在180秒窗口内未返回报告，随后确认无该审查进程残留；没有取得独立review结论，也没有把过往503写成本次结果。

## 未采用与后续门槛

本轮没有POST到原生生产端点，没有读取真实配对密钥或操作真实Bot/Routine，没有迁移现役schema、切换全局shim或重启Host/modeld。所有测试网络均为自己创建的loopback服务；Node真实TLS目标、生产key、实际自动任务模型/工具/用户提醒尚未验。

此出口可服务后续固定v2候选的单次真实验收，但不是automatic pairing activation。默认自动通知还需持久授权/接收者资格、自动worker宿主、原生run/report/unknown对账以及备份恢复fence；整安装容量和CONT/执行安全退役按原票继续。schema4的集成与live仍先固定旧制品和配置退路，再协调成套采用；不因HTTP文档、J1或Git提交自动部署。
