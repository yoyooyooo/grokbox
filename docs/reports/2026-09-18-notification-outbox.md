# 单目标策略、事务化通知与固定现场 · 2026-09-18

本片基于`b19b947`继续T45/T54，未更改J1既有CONT接口参数/业务边界。合同归[Template Ops §6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)，实现状态归[T45](../tickets/T45-template-webhook-delivery.md)/[T54](../tickets/T54-ops-targets-and-routing.md)。当前现场状态只看[LIVE-OPS-ROUTINES](../tickets/LIVE-integration-validation.md#live-ops-routines)及[LIVE-OBS-EVIDENCE](../tickets/LIVE-integration-validation.md#live-obs-evidence)。

## 实际范围

新增纯`notification-contract.ts`、`OpsNotification` port与`runOpsNotification`程序，box-runtime用`runOpsNotificationDelivery`装配。唯一default目标取自经过配置schema验证的effective ops，不从告警/Payload/模型输出选目标。routing关闭仍使用default；通知关闭、目标未配置或disabled、数据/意图不符明确阻断。高级路由、digest、重复投递和额外critical reserve尚不启用。

`NotificationBinding`由显式受信的`PairedNotificationDriver`提供，约束本安装database/scope、别名与真实Agent、原生Routine及revision、model/qualification、data/policy和有限观察窗口。它不包含secret或endpoint，不能从普通config或用户JSON生成授权。本片提供真实可消费的driver端口，但**原生配对/凭据owner尚未实现，默认driver unavailable**。未创建活绑定或公开可执行的send CLI，不将合成adapter视为原生配对。

同一work的实际发送步骤是：

```text
原固定incident revision
→ 配对前置读取
→ 原SQLite事务预留attempt和额度
→ 再读配对
→ 现有config写锁内检查当前policy并提交attempting
→ 释放所有本地锁后调用driver
→ 等待真实返回并记录结算
```

SQLite复用原`notification_work/notification_attempts`，未新增配置、router数据库或业务执行账本；config4/models2/wire8和monitor DB3版本保持。事务方法为`notificationScope/notificationDelivery/reserveNotification/beginNotification/settleNotification`。新预留最多4096条，受原数据库文件空间门保护；安全标记不因诊断TTL过期而变成可重发。已结算元数据仅沿既有保留期/incident退役规则回收，不删除unknown腾位置。

额度按安装与**真实Agent ID**计算滑动24小时，不按alias分别赠送。所有预留（包括未发/丢回执/unknown）保守占用普通额度，无自动退款。本片每work至多一次attempt，明确未接收也暂不重试；有界失败重试、critical reserve独立策略与原生对账仍待交付。

实际body再投影为固定白名单摘要/有限ID/一条只读取证命令，最大8KiB，冻结body digest和精确字节数。摘要必须来自程序catalog，命令必须匹配已注册的固定incident/revision查询；多余字段不透传，不能把原文、恢复blob、任意shell/URL或凭据塞入发送。新证据revision不会改变已预留通知指向的旧revision。

进程/取消在预留后不放弃正在执行的IO；请求设有限AbortSignal并等待driver真正结算，不用Promise race遗留晚写。提交回执丢失或发送结果未知保留unknown；既有attempt即使改目标、改alias或重启也不再次dispatch。配对/模型/scope/配置变化、ack、过期在未发边界阻断，不控制CONT任务生命周期。开始以后的关闭不是在途取消；这个边界不被包装成跨原生/本地store原子事务。

native-accepted仅表示driver报告的原生接受边界，不证明Bot完成或用户已读。返回值严格投影，异常正文和陌生receipt字段不保存。没有原生对账能力时unknown不能被本地随意升级为成功；备份恢复后的重放隔离也仍待真实配对/安全owner完成。

## 可用只读入口

```bash
grokbox ops notifications list --json
grokbox ops notifications show <work-id> --json
```

它们只读取已有本地库和当前目标偏好，不初始化、迁移、获取凭据、唤醒Bot或安装worker；绕过Profile初始化，坏配置不遮盖可读通知事实。列表明确100条近期窗口而非完整历史。`route=selected`与`binding=not_checked/nativeTransport=unavailable`分别显示。新增入口已进入diagnostics按需Skill，不把诊断内容加入默认启动正文。

## 固定执行证据

固定Bun1.3.14、原依赖与Node下限，组合：

```bash
bun scripts/verify-runtime-rebuild.mjs ops-notification
```

最终完整组合 **87 pass / 0 fail**，9文件、524断言；类型、构建、运行时边界与含未跟踪文件的发布隐私检查通过。前后源码摘要相同：`c0f47f02705cea09949655f51373a67dc5757cc8ae7d7961021166019397b9b4`（762文件）。实际preload为`5251491fcc9e3df77821a2e517ff312c8d89c323342421c35e4b6c8a6bef77e0`，pin由真实构建更新并复验。

全仓不重叠覆盖：

| 范围 | 结果 |
|---|---|
| CLI目录 | 690 pass / 0 fail，67文件，5643断言 |
| packages排序文件[0,85) | 537 pass / 4 skip / 0 fail，85文件，3774断言 |
| packages排序文件[85,170) | 566 pass / 15 skip / 0 fail，85文件，4439断言 |
| packages排序文件[170,252) | 671 pass / 0 skip / 0 fail，82文件，9133断言 |

合计 **2464 pass / 19 skip / 0 fail**。所有252个包测试文件仅计一次，19个默认跳过的原生资格不计通过。依赖为真实私有临时SQLite/配置文件/配置锁、owned配对与发送adapter、真实子进程SIGKILL和打包Node只读CLI；没有真实Webhook、业务模型或Bot数据操作。

27项新增测试覆盖：单work并发与不同work最后一份额度竞争、共享alias额度、三阶段本地提交回执丢失、发送后不确定、旧revision保留、配对/模型/policy/ack/期限变化、坏配置不回落默认、退出结算、两阶段真实writer死亡、白名单body/回执及source/packed只读命令。J1的14项真实DB/owned恢复owner合同回归保持通过。

首轮组合中两个强杀用例未走到预期SIGKILL，最终由测试deadline终止；原fixture依赖stdout callback触发强杀，改为同步descriptor写出阶段后立即注入SIGKILL，未改生产逻辑或放宽信号断言。随后单独/组合/全仓均通过。首轮CLI回归还发现root命令白名单缺新`ops`，补入已注册入口后完整CLI目录重跑通过。

独立Astra只读复核本轮仍返回503，未取得审核结论。绿色测试和实现者检查不是独立review。

## 剩余门槛

T46真实配对/凭据保护与T55接收者模型资格、T43真实HTTP认证/接受边界、自动宿主/队列轮询安装、原生unknown对账/有界明确拒绝重试、备份恢复fence及Bot报告仍未完成。不把可注入driver当作已安装原生sender，不复制第二CONT名单、保全store或业务controller。

本轮没有创建Routine/替身、迁移关系或删除Bot，没有模型消费、Issue发布、Host/modeld切换或schema迁移。schema4候选仍须独立review、固定旧制品/配置退路后按原成套v2集成与现场窗口采用；代码合并或handoff不自动部署。
