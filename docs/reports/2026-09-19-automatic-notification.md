# 自动通知执行与 v2 交叉整合回执 · 2026-09-19

本报告记录本轮已执行的源码验证，不是原生服务部署或用户送达证明。来源为 [T45](../tickets/T45-template-webhook-delivery.md)，当前现场仅归 [LIVE](../tickets/LIVE-integration-validation.md#live-ops-observer-lifetime)。本轮接续了中断会话留下的未提交实现，没有覆盖其他 worktree；先验证后提交，再与 v2 的 CONT 增量整合。

## 提交与实现范围

实现提交初始为 c38aed0，基于最新 v2 5c7a56c rebase 后为 3db3149。五份已由 v2 接入的公共提交被 Git 识别为重复，没有重复执行迁移或创建第二套接口。其余 Routine、outbox、配对、接收者预检、显式 HTTP 与本轮自动发送按线性历史整合。最终集成提交以 Git 回执为准，本报告不自动移动分支或改变安装。

新增源码为 `notification-activation.ts`、`ops-activation.runtime.ts`、`ops-automatic-notification.runtime.ts`，并扩展既有私有 capsule、notification outbox 和 daemon 组合。新增 CLI 为 `ops targets activate` 和只读 `ops notifications worker`。没有增加第二个凭据存储、事件队列或 daemon。

授权数据与交付证据严格分开。程序核对原 outbox 的 accepted 测试记录与当前精确绑定；操作人是否看到提醒作为独立声明保留，不由 HTTP 状态、模型文本或预检结果推断。授权不启动服务或采集、不启用原生任务，也不生成发送副作用。单次发送继续复用既有固定正文、预算、原生状态复核和未知不重放路径。自动任务只选创建时间晚于记录边界的新 work，不补发旧积压。

运行宿主为已经启动的本地 daemon。空闲检查与实际发送分开：无有效授权、无新 work、配置关闭或预算耗尽，不请求原生接口。每轮至多一条，完成后才进入等待；空闲5秒，阻断30秒起退避，最多5分钟。停止时通过 signal 中止并等待真实 HTTP/本地提交结算，不留下脱离生命周期的发送。关闭绑定清除权限；模型、Host代际、身份、定义或作用域变化均阻断，不自动切备用或重签。

## 本轮发现并修复

新增并发激活测试发现，明确没有拿到配置锁的竞争者也会被投影成 activation_outcome_unknown。现在将确认发生于锁接纳之前的 config_conflict 分类为 activation_busy；可能已落盘的失败仍保持 unknown。没有增加锁轮询或自动重试。并发操作最终只形成一份固定授权，同操作再次读取不会延长原边界。

另增测试验证激活期间解绑不能被晚到权限覆盖，以及阻断退避与空闲恢复。共28项自动链/CLI测试通过。此前48项以及本轮51项集中结果是不同子集，不能与全仓分组累加制造总数。

## 固定验证

工具链保持 Bun 1.3.14，依赖、models v2 与 wire v8 未升级。最终整合源码上的组合：

```bash
bun scripts/verify-runtime-rebuild.mjs automatic-notification
```

结果为 **131 pass / 0 fail**：74项自动链/HTTP/outbox测试与57项配对/J1/daemon/制品回归，共833断言。类型、构建、导入边界与隐私扫描通过。组合执行前后源码摘要稳定为 `b0011355f624090076e4ba66f402502dae986c3eed9ea4c5e8dbf92452083edd`。实际整合 preload 为 `d0d6fa26eb72d4f313861108d7f4d1939b8afeea79a288f880c6f09914b8adc9`，采用重新构建结果，不选择冲突任一方的旧指纹。

CONT 的 current-state wire、迁移、原生 owner、协调器及 CLI 交叉回归 **52 pass / 0 fail，224断言**，没有代做替身、关系迁移或 Bot 删除。架构测试冲突同时保留 v2 的同步 Node 检查器与 OBS 的结构化 verdict：超时/崩溃不是负例通过。

全仓不重叠分组的实际执行状态：

| 范围 | 结果 |
|---|---|
| ./test，72文件 | 748 pass / 0 fail，6106断言 |
| packages，第1–92文件 | 633 pass / 4 skip / 0 fail，4200断言 |
| packages，第93–184文件 | 619 pass / 37 skip / 0 fail，4709断言 |
| packages，第185–276文件 | 工具安全检查拦截，未执行，不计通过 |

已执行互不重叠部分合计 **2000 pass / 41 skip / 0 fail**；这不是最终全仓通过。131项专项和52项交叉回归部分重叠，不再加到此合计。跳过的原生资格不计通过。没有改用别的工具或等价拆分重跑被拦截的末组。

测试使用真实私有文件、SQLite、loopback HTTP、实际 daemon 与打包 Node；用户声明和原生模型/所有权来源为受控 fixture，不是现场用户确认。独立 Astra 只读复核在120秒工具窗口内未返回报告，因此没有独立审核结论。T46 本轮文档同步调用也被工具拦截，未落盘，未将拒绝内容搬到其他路径补写。

## v2 集成结果

本轮已将整合提交 `e7ab660` 从 `5c7a56c` 快进合入 `feat/box-runtime-v2`，没有 merge commit、push 或部署。随后在 v2 工作区运行自动发送/CLI、J1、当前状态命令及LIVE结构五文件复验，**57 pass / 0 fail，356断言**。候选与并行CONT源码已合流，之前长期分叉的Routine/outbox/配对/发送代码不再只停留在旁支。

最后的状态与索引检索调用被工具安全检查拦截，未改用等价读取绕过。T45和本报告记录当前实施；其他来源票的旧状态仍需后续对照清理，不能把源码已集成写成原生验收已完成。

## 安装与现役边界

只读核对得到：v2 已包含 schema4 的公共源码，但现役全局 CLI 仍使用独立旧 checkout，配置为schema3，modeld为wire8且采样时可达/activeSteps=0。瞬时空闲不等于维护屏障，也不代表新Host或自动通知已加载。源码合入不自动改变该shim指向。

没有修改生产配置、全局shim、原生Bot/Routine、凭据或Host/modeld，没有发生产Webhook或创建Issue。live仍需固定已集成v2制品、旧配置/制品退路、明确对象与费用，并按唯一LIVE索引验收。

尚未闭合：完整末组回归、独立review、当前生产TLS/原生接收者模型与工具/报告资格、collector的持续生产与daemon/collector开机安装、备份恢复重放防护、全安装物理预算及native unknown对账。sender能够运行不等于collector已经安装，也不等于已有用户数据允许公开。本轮自动发送不改变默认提醒任务的只提醒行为；后续用户委托的自主排障/维护仍按原权限范围进行。
