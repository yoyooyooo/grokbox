# 原生 Bot 故障提醒与自主运维操作入口

**2026-09-18：接受设计，完整链尚未交付。** 本页解释操作和故障分流；字段、权限、预算与模块只归[专项Spec](../roadmap/template-ops-automation-spec.md)。[OBS票](../tickets/README.md#incident-evidence)与[运维票](../tickets/README.md#template-ops-automation)拥有实现，当前现场只看[LIVE](../tickets/LIVE-integration-validation.md)。

## 当前可用的入口

在目标Box使用已安装版本的help核对参数：

```bash
grokbox runtime incident <step-id> --agent <agent-id> --json
grokbox runtime incident <step-id> --agent <agent-id> --from monitor --json
grokbox alerts trace <tray-id> --agent <agent-id> --json
grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
grokbox runtime monitor snapshot --json
grokbox runtime monitor incidents --json
```

`runtime incident`接收STEP而非monitor incident ID；monitor分支只读既有库，不初始化或采样。history outcome需要原生读取且可能包含实际回复，不能整体作为公共报告。没有STEP时不要拿最近执行凑身份。

当前状态检查不证明事故时加载的制品，源缺失不能建空库制造健康。现有monitor本地输出也不证明目标Bot收到；配置已保存与服务常驻分开。

## 实现后的默认旅程

正常服务负责持续采集、分类、固定现场和有界维护。用户选择一个有权使用的Bot，经独立Routine配对确认数据和费用；绑定不改模型或其他任务。模板不能复制活绑定，真实测试POST需单独限定对象、次数和清理范围。

告警只发送简短事实、时间/范围、必要ID、固定证据revision、一条主要取证命令与必要补充、可用期限和缺口。Bot提醒后结束，不执行附带命令、不分析、不询问Issue、不催问。取证入口由可信命令注册表产生，不接受事件文本指定任意操作；标注Box本地执行条件。

原生Bot唤醒可能收费；未配对、目标不可用或预算耗尽明确显示阻断/延迟，不能宣称每条都已送达。默认无模型采集不等于原生提醒零费用。

## 用户委托后自主处理

用户随后要求排查、管理Bot或换指定模型，Bot从同incident接续，按需加载Skill，自主完成范围内步骤和验收，不逐条询问常规读取。默认只提醒不是通用Bot永久只读限制。

仅要求排查不包含共享Host重启或公开现场。新增中断、费用、数据去向或公开范围需要决定。后续预授权维护仍经唯一controller和真实安全屏障；Bot先持久交接并结束，不能等待自己的Host重启占busy。模型文字不是完成回执。

## 证据与保留

未来主查询为`runtime monitor incident <incident-id> --evidence-revision <n> --json`，由[OBS-02](../tickets/OBS-02-incident-evidence-snapshots.md)实施，当前不能假定可用。通知只引用安装版实际支持的命令。查询不采集、回收或续租；过期明细返回摘要与原因，不把空结果当没故障。

有需要时受托任务显式申请有期限、预留容量的证据保留；普通读取不延长。全安装诊断预算、日志轮转、事故分层与物理空间回收见[存储合同](../roadmap/template-ops-automation-spec.md#storage)。ack、snooze、未解决不永久锁定明细；关闭提醒不关闭必要维护。执行安全状态和CONT恢复引用不能由日志GC删除，用户数据不在范围。

## 故障分流

| 现象 | 先看什么 | 不能推论 |
|---|---|---|
| evidence有异常却无incident | intake来源/规则/无STEP入口与schema覆盖 | 写入事件不等于已识别故障 |
| 有incident无消息 | preparing/ready、binding、费用、attempt与原生回执 | HTTP接受不等于用户已读，unknown不盲重发 |
| 查询过期或缺材料 | 原revision、保留tier/期限/gap | 不能改查最新错误冒充原现场 |
| Bot一直Working | 父回合、子任务、审批和队列，见[Working手册](working-state-recovery.md) | 父任务结束不证明子任务结束 |
| 磁盘持续增长 | DB索引/辅助文件、事故租约、安全账本、备份和临时空间 | 删除行或移入Trash不证明释放空间 |
| 观察器/数据库失联 | scope、epoch、heartbeat、writerHealth和gap | 不能从旧快照恢复执行权限 |
| 整盒离线 | 如实保留本机无法及时发通知的边界 | 不承诺无条件高可用或恢复后逐条重播积压 |

## 配置与支持边界

当前config3的实际命令见[配置指南](../configuration.md)；新storage字段、目标命令和下一版schema仍是规划。偏好、实际binding和执行授权分开，旧off/预算保持；关闭通知不取消用户任务，也不等于卸载Host补丁。完整退出遵循[回退手册](official-rollback-acceptance.md)。

T52/T56延期；默认不提Issue、不询问是否建单。未来用户决定公开时仅复用已有可用gh身份，没有认证/权限就本地保留并跳过，不自动补报旧积压。公共材料仍需按用途审核，敏感问题遵循SECURITY.md。

## 验收

首发先验OBS证据/隐私/容量/安全退役和原生单目标提醒；受托自主、高级路由、自动维护与连续性恢复各有独立出口。新增命令与测试只有真实实现后才注册。

Routine真实验证必须经过发布CLI的disabled创建、读回、启用、合成POST/run/报告、更新、禁用和限定清理。费用、对象与清理独立授权，测试替身不代表原生资格。当前进度只更新LIVE，不在本手册复制现场账本。
