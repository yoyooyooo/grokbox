# Host 更新与身份变化：固定证据和因果边界

本页提炼截至 2026-09-26 10:57 UTC 的已结算观察；后续 program-update 等实验有独立活动资产，不因本页存在而被签为完成。最新结论应看 [LIVE](../../tickets/LIVE-integration-validation.md)及对应日期报告。

主要来源为普通 Bot POC 的 `p0-lifecycle-evidence/` 与 `controlled-window/evidence/`，目录导航见[独立 POC 索引](independent-poc-atlas-2026-09.md)。

## 1. 先分清六种事实

| 事实 | 它回答什么 | 常见误判 |
| --- | --- | --- |
| 官方 bundle 版本和原始摘要 | 观察到哪个程序/worker 来源 | 版本名相同就是所有字节相同 |
| 磁盘 transformed source | 补丁写到了哪个文件 | 文件改了就是新进程已加载 |
| 实际进程与 loaded marker | 哪个进程运行哪次接入 | 旧 PID 或旧 marker 能代表现在 |
| 升级 operation / applied 结果 | supervisor 实际做了哪次切换 | 它就是 Bot 的迁移回执 |
| 原 Server 同身份读回 | 官方此时认定谁执行 | 本地 profile 或 Gateway 投影已经足够 |
| 本地 writer / 执行许可 | Host 如何同步和使用身份 | 文件 mtime 就是 Server 改变归属的时间 |

这些事实相关，但 owner 和时间点不同。历史 source SHA 主要用于复盘，不是未来部署资格；source 恢复也不自动恢复服务端身份。

## 2. 官方更新链由 Host 与 supervisor 分工

被检查的原生版本中，Host 内的更新扩展发现新版本、下载/校验并暂存 bundle，然后提交升级命令；外部 supervisor 验证并替换 bundle、停止/重启 Host、处理正常恢复并记录 applied marker。Host 后续读取该记录，进入自己的升级恢复流程。

原 opt-out 会让 Host 自动准备分支在来源解析、下载和 staging 之前返回，也影响相应自动 image update。它不取消已经暂存的命令，不约束原手动 updateHostNow，也不排除外部升级。supervisor 的首次 boot-fetch 还有自己的环境判断；普通 child restart 不等于重启整个 supervisor。

因此“停止自动切换”和“持续发现上游变化”不能被视为同一个开关。受控窗口暂时减少自动变更变量，不构成旧版本兼容数日、独立 Server 迁移不存在或永久保持 Box 的保证。

## 3. 原源码中的迁移候选链

原 AppliedMigrationBarrier 读取 applied operation；没有该 operation 的普通重启，不由这个读取动作制造一次升级。带 operation 的恢复窗口会调用 EnsureGrokBotBoxHarnessMigrationPass，再按实际结果走后续流程；reconcileWithMigration 可在迁移结束后再次读服务端身份，原 writer 将结果写入本地。

这个 RPC 是会启动或查找 migration pass 的操作，不是任意调用都无副作用的诊断读面。源码能说明路径存在，不能说明每次服务器内部都作同一个决策。本文不提供伪造状态、删除 marker 或关闭身份检查的“恢复方法”。

## 4. 两次固定观察的不同价值

**较早的生命周期调查**沿原认证客户端，两次确认已经成功登记过的同一 Bot 现在是 Temporal。这排除了“只是本地标签写错”的解释。旧升级记录与 profile mtime 时间相近，但没有该次 pass 的完整响应，不能据此唯一归因。

**完整受控窗口**进一步分开了变量：

| 动作 | 同一身份的观察 |
| --- | --- |
| 暂停自动准备更新并运行私聊、多群、Routine | Server Box 和自定义执行均有正例 |
| 显式 identity reconcile | 原 Server 仍为 Box |
| 普通 Host 重启 | 原 Server 仍为 Box，之后手机续聊成功 |
| 原生 394046b → 8ae66c3 升级 | 同一 Bot 及两个群随后为 Temporal；Bot 有两次原 Server 独立读回 |

升级前的原官方来源是 `4eafc5d62e7331c445b2eb084dae6a7717729533aebea31271f77f26cf44ddf8`，升级后是 `31d937e0ad4557db56ae121c042ed3d3245bdf4fce746edd275eafcfc88366d6`。两者完整字节均保全；升级后只读观察器最后撤回到新版原文，没有将旧版本覆盖回去。测试身份/历史保留，自定义 binding 和 Routine 停用。

这支持“当次普通版本升级没有保持执行归属”，不支持“任何重启或同步都会失权”，也不支持“所有受控维护方式均不可能”。

## 5. 为什么仍缺变化过程

原 POC 接入随着新版 bundle 消失；归属变化之后才加载的新观察器，能够记录最终 Server 状态，却没有覆盖新版首次启动的原请求/响应全程。旧 marker 被正常消费后，不能从一个空的当前 migration window 反推过去从未发生迁移。

后续观察应在新运行代的首次执行前具备相应记录能力，以正常原流程产生的请求/响应和同一身份读回为依据；不要为了观察而另发一次迁移操作。服务端未暴露的原因保持未知，员工内部接口不存在访问资格时不调用。

“升级程序”“应用补丁”“发起归属迁移”“确认身份与许可”是不同边界。能否独立管理它们属于后续有界实验；当前档案只提供已观察的输入和反例，不在 B 仍执行时提前采纳其未结算结果。

## 6. 可以移植的观察最小集合

保留来源/worker 摘要、实际 loaded generation、原 upgrade operation、原生迁移调用是否被观察到、原 Server UUID/绑定及 harness 前后、local writer 和缺口时间。未观察到调用不等于没有调用；陈旧或读取错误不等于失权。

来源变了、形状变了、Server 创建规则变了、既有身份失权，是不同事件。创建源头 canary、AST、加载见证和身份时间线互补，不相互代签。通知沿原 OBS/incident/outbox；只证明事件入库不等于用户或维护 Bot 已收到。

当前负责采集与维护的 Issue 和实现计划不在此重复维护。固定窗口失败不变，后续结果另给其日期、source、运行代、Server 回执和支持范围。
