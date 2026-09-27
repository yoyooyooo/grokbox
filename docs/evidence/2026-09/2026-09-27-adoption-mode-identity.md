# 正式采用的模式声明与前置拒绝

2026-09-27，AH-187。延续[当前源码重绑](2026-09-27-official-exit-and-source-rebind.md)；当前现场入口仍为 [LIVE](../../tickets/LIVE-integration-validation.md)。

`0d0f3281f3bd333ba7fbd5ed58a2f3cce48051ea` 已固定构建、pack 和安装，98 个发布文件摘要一致，安装依赖在 Node 22.22.0 下完成 sqlite3 与 classic-level 实际读写。该安装制品发布的 63 切片 profile，变换摘要与已验证的 `a22d48c` 候选相同；新 Server/modeld 启动前，原固定制品服务按准确 PID/start 和进程句柄退出，未信号 Host。

## 正式入口得到的结果

本轮先设置 `observe`，随后在完整来源、worker、profile、supervisor、wrapper、Gateway 和空闲核对后执行一次 `host start`，未使用 force。入口返回 `host_mismatch / still_official`。原操作 `40e95da0f817f118dcd88a92b272357c990c7f09f9b91ee48b0579b07bace8f1` 的持久记录为 unknown，诊断是 `launch-strategy-unavailable / preflight`，signaled/spawned/guardian 均 false，guardian 未 armed。官方 Host 与监督链未改变，创建请求未发送。

源码核对显示，现有控制器在 `route` 下选择 transient 接管，在其他模式下选择 direct；当前官方 supervisor 具备 transient 接管能力，但不支持测试监督者的 direct-overlay。`observe` 不能据此宣称已经采用。

正式入口的操作 ID 原先只绑定 Host 生命周期、profile 与 preload，模式却参与冻结命令的启动策略。隔离入口反例证明：同一进程及制品下先得到 observe 的 unknown，改为 route 后仍复用原 ID，无法表达新的模式声明。修复在原 ID 派生函数加入原 desired writer 返回的模式；没有新增 controller、状态 writer、重试 nonce 或历史执行分支。

回归验证同模式再次调用仍读原记录，模式改变才形成不同声明，原 unknown 不被改写。原资源围栏回归还验证，新代/新声明不能向仍未结算的旧物理资源发信号或覆盖原 journal。此修改本身不授权重放历史 unknown。

## 验证与环境限制

入口、controller generation/ownership、真实 Node 采用及恢复回归共 126 pass / 0 fail。类型检查首次被 SIGKILL；768 MiB 限额下明确耗尽 V8 heap，1.5 GiB 限额下类型、文档 16 项及 publication 均通过，未放宽断言。原生配方与当前 Host/worker 字节未变化，不重复统计上一报告的配对成功。

管理服务一次退出，日志仅保留 `Killed`，未确证具体终止来源；已按原正式入口用有界 heap 恢复。机器一次观察约有 3.2 GiB 可用内存，无 swap，系统 OOM-kill 累积计数发生增长；该计数不能单独归因到某一进程。modeld 始终观察到 accepted=0、activeSteps=0。

只读核对历史逐 Bot 模型选择：12 项中 8 个对象当前在原生名册中为 Temporal，4 个不在名册，无运行中回合。保留这些历史配置；本窗口不以其授予旧目标新的执行许可。后续正式采用仍需重新检查当前来源、对象、空闲和运行代，零模型请求预算不变。

此记录未宣称 Host 已加载新候选、静默创建通过、业务或通知通过。原八条 unknown 加上本次前置拒绝记录均保留；费用继续 `billing not observed`。
