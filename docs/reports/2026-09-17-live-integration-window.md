# 2026-09-17 — v2 live integration window

本报告记录一次用户明确授权的现役维护与有界验收，不是全功能生产发布签字。跨 worktree 条目状态与后续排程仍由 [LIVE 账本](../tickets/LIVE-integration-validation.md#window-20260917)拥有。原始配置、真实 Bot/nonce/进程身份、日志、导出和备份只留在受保护的本机证据中；本报告用 `W17-A`、`W17-B` 和 `C01–C12` 指代，不发布私有路径、账号、端点、凭据或业务文本。

## 1. 实际结果

现役已从旧 modeld wire v5 切到 v2 的 **wire v7、models schema v2、统一 config schema v2、strict-observation-v2**。Host、modeld 和 daemon 均实际换代；最后一条 managed canary 的 Host 与 modeld 终态报告相同的修复后 source digest，随后 doctor 返回 `host=custom`、`modeldAdmission=ready`、`next=none`。

不是仅构建或重启：本轮执行了迁移、真实配置应用、官方 passthrough、MiniMax 主回合/工具/Memory、同通道 effort、在途 TURN 固定选择、逐 Bot 官方回程、modeld 替换、完整 Host 退出尝试、同制品再次启停和清理。官方未补丁路径的完整原生/App 证明、长审批撤权、受控慢取证、平台 Reset 与独立复审仍未完成。

回退演练还发现并修复了一个真实控制缺陷：**同样的制品在 stop 后第二次 start 被旧 operation ID 吸收，CLI 却报告 started。** 修复已线性合入 v2，并在相同修复制品上再次 stop → start → already_started 实测通过。实现与非 live 出口由 [Host lifecycle 修复票](../tickets/FIX-host-lifecycle-reapply.md)拥有。

## 2. 授权、边界与实际消耗

用户本轮明确允许切 Host、重启 modeld，并要求尽可能执行积累的 live 验收。只创建两个专用 confirmed-box 测试 Bot；没有改业务 Bot 的模型分配，没有改 Server ownership、重放历史失败消息、清去重库、放宽五秒权限年龄、启用 Provider 自动重试或清全局 circuit。

本轮共发送 **12 条新的 canary 消息**，每条使用独立 nonce。结果为 **9 条 `expected_result_observed`、2 条真实上游 HTTP 503 失败、1 条 stock Host 回程的持久回复已读回但关联 outcome 仍 unknown**。不是 12 次全部通过。

按这些 nonce 关联的 TURN/STEP 去重，modeld 记录 **19 次 HTTP 调用：17 次成功、2 次 HTTP 503**。成功请求报告的 usage 合计 input 424424、output 2909 tokens，包含原生 Memory 辅助请求与历史上下文，不能当作独立用户输入量或美元账单。官方原生请求、无 usage 的失败请求和外部 reviewer 不在这份 modeld 成功 usage 合计中；没有推算总费用。Provider 恢复策略始终 off，每个已观察 STEP 的 backendAttempts/HTTP 调用均为一次；多 STEP 工具回合不是重试。

在继续阶段明确收紧为最多三条新测试消息，用于 modeld 重启、stock 回程和最终 custom 恢复。之后没有再发 canary。独立 reviewer 另有一次只发送公开源码、关闭工具/扩展/会话保存的有界调用，返回 HTTP 503，没有复审报告。

**维护影响并非零。** 原有 temporal Bot 持续报告 child-only 活动；一次恢复前另有既存 Bot 的 running 标志。Host 切换在已授权维护窗口显式使用了 force，并保留被列出的活动对象回执。没有向它们发送停止/重试消息，不能从 Host 重启推断服务端子任务已取消，也不能声称所有业务执行完全未受影响。模型分配未变与执行没有被中断是不同命题。

## 3. 两组固定制品与失效边界

| 项目 | W17-A：集成基线 | W17-B：现场缺陷修复后 |
|---|---|---|
| 代码候选 | `7994b92`；运行中并入的 `15a0594`/`02a6d81` 只改文档 | 修复 `338cf83`、pin `fe05442`，维护回执 tip `dc03066` |
| source digest | `82aaf3e43024f82e8d382734315e6208db5eb956d4d522e89d3b93c310f16750` | `f2226ccb9938221054693e94ca27308c62cc25d289c9cf40fec3e1ddc167fc59` |
| preload SHA-256 | `de365fe5b3ebac1fc58ff576965c30228ba8755eeac73018b9658af48195a0ae` | `0d31637d0524acaffab59b1d8da75244badedbf61bdeaced0a0ab61a84718ffd` |
| 最终 CLI SHA-256 | 不用旧制品替代 B 的身份 | `4e3d034ffe0f50b1d63b71eadd062aef0b1a990c59b997b793b458fbee63b27b` |
| 固定原生 Host SHA-256 | `7920c2f6e28a4f9790d802d60f4b036cbf92676409ebb8b180c7ee6a53834192` | 同一原生文件，未升级官方二进制 |
| profile / transformed SHA | `ca5c2dda9405abf0c295949f64c90d20a6971a873d0528986b3b86bff8dd6901` / `7765ddb39d27dd8923b8c263d6cf3c6e63c7d5c08ea9ba6501fa2d05158a3bbf` | 原生切片配方未改变；最终加载另由 Host 终态佐证 |
| wire / policy | v7 / strict-observation-v2 | v7 / strict-observation-v2 |
| build tools / SDK | Bun 1.3.14；esbuild 0.28.2；ai 5.0.253；OpenAI provider 2.0.125；Effect 4.0.0-beta.107 | 相同锁定依赖 |

B 只修复 controller/CLI 生命周期和相应回归，没有修改推理、ownership 策略或 Provider 编码。A 上的 effort、配置应用等回执保留为它实际测试的制品范围；**不能把它们改写成 B 上重新运行过全部向量**。B 另取得同制品再次启停、最终 managed 主回合/Memory、服务换代和完整离线回归。下次相关源代码、原生版本、策略、schema/wire 或部署 tuple 变化时，按条目重新判定覆盖，不照抄这次绿色结果。

## 4. 迁移与消费者

预检确认全局源码 shim 已跟随 v2，但现役 modeld 仍是旧 wire v5。迁移 preview 最初正确阻断仍在写旧格式的 daemon/modeld。先保全旧固定 CLI 制品、配置、models、profile/preload 及恢复资料，再停止旧 writer；再次 preview 的 canApply=true、conflicts=[]、blockedWriters=[]，才用精确 plan digest apply。

迁移进入 **retired**；general config 成为 schema v2，两个 home 别名指向原 durable canonical 文件。迁移前后 models 的原始 SHA 相同，证明 general config 迁移没有趁机规范化模型或改凭据引用。之后单独执行 `models migrate --confirm` 写 model schema v2；最终逐项对比 model catalog、原有 assignment 的 v1→v2 归一化值及 main assignment 均保持不变。

真实 desktop 配置试验把 minIdleMs 从 600000 增到 660000（缩小而非扩大回收范围），得到 committed 后的 **applied** 回执；该次修改期间 models 字节不变。随后恢复 600000，也得到 applied。独立读取真正消费者的记录，核对 PID/start 与 dependency revision；不是 config 查询替消费者自签。

最终再次 off/on 重启 daemon，Host 保持不变。新 daemon 的 desktop 采用记录具有新的进程身份，start 与当前进程匹配，domain revision 仍是恢复后的值。最终配置为 desktop enabled=true、minIdleMs=600000；旧配置迁移状态仍 retired、migration writer absent。MiniMax 与 Responses 成功请求另外证明其所选凭据在新消费者链可用，**不代表所有目录内凭据或平台 Reset 后凭据都已验证**。

## 5. 消息与执行证据

| 回执 | 制品与路径 | 实际结果及边界 |
|---|---|---|
| C01 | A / patched official，对照 Bot 无 managed assignment | 精确测试回复；没有关联的 managed STEP。证明该对照走官方 passthrough，不给所有官方路径签普遍零副作用 |
| C02 | A / MiniMax 基础 | 主回合与 Memory 两个 STEP 均成功，各一次 HTTP；精确 SendToUser 投递。观察到 qualified inline dialect 的空 continuation 规范化与原生空 Memory 完成 |
| C03 | A / MiniMax 原生工具 | 三个主 STEP 加一个 Memory STEP，各一次 HTTP；实际 shell 等待 6 秒后以禁止覆盖方式写入并读取唯一临时标记，独立文件读取与投递一致。**shell 等待不是审批等待，也不是最后执行门撤权证明** |
| C04 | A / Responses 通道 A，high | emitted=high，HTTP 503，一次调用、零工具释放；分类 upstream_http，不归因为 ownership 丢失 |
| C05 | A / 同一 Responses 通道 A，xhigh | emitted=xhigh，HTTP 503，一次调用；独立新探针，不是 C04 自动重试。随后停止该 lane；没有换模型冒充它通过 |
| C06 | A / 独立 Responses 通道 B，high | 含一次只等待/打印的有界 shell 与 Memory，共三个成功 STEP。运行中把配置改为同 modelId 的 xhigh 后，后续本 TURN 的三个 STEP 仍 requested/emitted=high |
| C07 | A / 同一通道 B，下一 TURN xhigh | 主回合与 Memory 均成功，requested/emitted=xhigh；精确投递 |
| C08 | A / 同一通道 B，default | 主回合与 Memory 均成功，requested/emitted=default，移除标题 e；未伪造 wire model 或另造通道 |
| C09 | A / 逐 Bot reset 到 official | 保留用户标题，清 m/e；官方回复能从同会话历史取回早先实际工具标记。没有 managed STEP，但不证明 compact checkpoint 往返 |
| C10 | A / 正常 modeld 替换后 | 新 service epoch 的 MiniMax 主回合和 Memory 各一次成功 HTTP；从旧会话取回工具标记，原 STEP 未重放 |
| C11 | A / 完整 stock Host 区间 | stock 进程无 preload 启动参数/Node options，原生 SHA 不变。发送被接收；未补丁 roster 缺少合格 harness 观察，所以当时 outcome unknown。恢复 bridge 后能读回具有 stock 区间时间戳的精确持久回复，但强关联 outcome 仍 unknown；不冒充完整退出成功 |
| C12 | B / 最终恢复的 custom Host | MiniMax 主回合与 Memory 各一次成功 HTTP，Host/modeld 同 source digest，精确回复包含先前工具标记；Bot 两个 running 标志均 false |

额外负例：在无 qualified effort 白名单的 MiniMax record 上选择 high，CLI 返回 reasoning_capability_unknown，model 文件字节不变。官方对照 Bot 的配置保持 official。high/xhigh/default 的 Provider 报告均 **providerReported=unknown**；HTTP 200、推理 token、耗时或模型自述不能证明网关内部执行了对应档位。

在真实 Gateway/native 读取链观察到 source/STEP/cache 的区分、原始证据过五秒后的新读取，以及同 STEP 内复用；没有把结束时间续成权限年龄。慢读注入、pause/unbound、换代中的共享等待者取消与长审批撤权没有安全的独立注入/观察条件，仍未证明。

## 6. 重启、回退及现场修复

旧 wire v5 modeld 在 activeSteps=0 和精确身份检查后退出。新 v7 使用原 LevelDB，不复制 service epoch/内存 permit，不删账本。后续正式 `runtime modeld replace --expect-epoch … --confirm` 成功换代，启动时 accepted/active/hot/pinned 均为零；再次携带旧 epoch 被拒绝，未更换当前服务。活动 Bot 存在时 replace 的 running guard 也曾正确阻断。

第一轮旧制品 Host stop 曾返回 replacement-unproven；后续读回才确认官方进程已经恢复。保留这次未知窗口，不从首次命令退出码签成功。

随后 A 的完整 stop 成功，但相同制品再次 start 命中旧 terminal operation，暴露 `started + actual=official` 缺陷。没有删 ledger 或伪造 operation 记录。修复先在隔离 worktree 完成，再以 `338cf83 → fe05442 → dc03066` 原哈希快进 v2，零 merge commit、零远程 push；现役从未采用未合入 feature 的入口。

B 将 apply 去重键绑定只读核对的 Host/supervisor PID/start/UID 运行代，同时保留制品摘要和原 controller 门禁；不能取得稳定运行代时，在写 desired 前拒绝。start/restart/stop 必须读回目标通道，否则报 host_mismatch 并保留可用的操作关联。

B 部署后又执行 **相同 preload 摘要的 stop → start → start**：第一次 start 获得新的操作关联并确实到 custom，第二次为 already_started 且无再次切换。C12 证明最终制品仍能真实推理和投递。最后 daemon 重启没有切 Host。

这不是完整旧 schema/旧制品恢复演练，也没有证明旧 v5 回滚仍能读新 v2 模型配置。保护的旧资料仍保留，不能通过删除 effort 字段冒充无损降级。原版 App、stock 区间独立 ownership 与原生 compact checkpoint 的完整回退合同仍缺证。

## 7. 离线复验和复审缺口

| 范围 | 结果 |
|---|---|
| A 类型、构建 | 通过 |
| A release-offline | 516 pass / 0 fail |
| A 全库 | 2190 pass / 6 default native skip / 0 fail；最初一次外层 300 秒有界执行未取得汇总，后续独立运行通过，不把超时算绿色 |
| A native-source | 28 pass / 0 fail |
| B 类型与控制/命令回归 | 类型通过；73 pass / 0 fail |
| B 重建制品与包装 | 12 pass / 0 fail，含实际 npm tarball/Node 入口与 E09 旧制品拒绝 |
| B native-source | 28 pass / 0 fail，覆盖普通全库默认跳过的原生 case；不改原生文件 |
| B 最终 v2 全库 | **2196 pass / 6 default native skip / 0 fail**，284 files |

B 的第一次全库运行有一项 E09 pin 失败：source provenance 改变后，旧 pin 仍指向 A。明确更新为重复构建所得 B 摘要，保留严格相等与 drift 拒绝断言，然后重跑包装、native-source 和最终 v2 全库。没有删除测试、增加 skip 或以旧分支计数代替最终结果。

T49/T60/AUTH/reasoning 的独立复审义务仍归来源票。此次修复的固定源码 review 也只取得 HTTP 503，无报告。**维护动作和 live 成功向量不补成独立 review，也不把这些非 live 阻断包装成只剩 App 验收。**

## 8. 清理与尚未完成

两个测试 Bot 均在执行空闲后撤销 managed assignment、导出其 owned profile/settings/Memory 留证，然后由正式 CLI 删除；最后 roster 回到 51，两个测试 ID 均不在其中。最终 model catalog、所有原有 Bot assignment 和 main assignment 与迁移前归一化值一致。未创建 Routine、Webhook、GitHub Issue、定时任务或长期测试监听，测试用 Python 交互进程已显式结束。

受保护的旧制品/配置备份、私有回执和两个导出保留供审计。唯一 23 字节合成工具标记也作为审计样本保留；没有扩大 daemon 的只读 filesystem root 权限来清它。正式 Host/modeld/daemon 是本次要求保留的服务，不属于临时测试资源。

继续保持未通过的范围：

- 独立固定提交 review；Provider 明确档位回报；A 通道的 HTTP 503 资格。
- 原版 App 的当前会话/侧栏/失败/等待实际视图；stock Host 缺桥期间独立 identity 与 strong run correlation；compact checkpoint 回退及旧 schema 恢复。
- 受控真实慢 List、pause/unbound/取消/跨代失效；长审批后的最终原生工具执行门，不能用 sleep 或离线 fixture 代替。
- 平台 Reset：没有可丢弃 Box 与单独 reset 窗口，不对生产 home 做破坏性模拟。
- Template Ops 五条及 CTX 三条：当前仍是实现前置未满足，不运行不存在的功能；本次普通重启不代表默认 128K 主动 compact 已上线。

上述范围在 LIVE 各条逐项回填。本报告不关闭整个长期 backlog；后续只需补对应缺口，而不是把本次已取得的功能事实重新标成 not-run。
