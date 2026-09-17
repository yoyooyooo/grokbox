# 同通道推理设置的 v2 线性集成回执

日期：2026-09-17。范围：补全 live-only 验收依赖、变基到最新 v2、解决统一配置交叉影响、复验并快进合入。不包含生产配置迁移、Host/modeld 切换、真实模型消费或远端发布。

## 实际 Git 集成

初始功能分支 `feat/model-reasoning-policy` 为 `1108011`，基于 `f8c82c0`；本轮首次核对 v2 为 `efa6557`。变基过程中逐处合并六个冲突文件，保留统一配置、ownership availability 与本功能，不恢复旧 `runtime models` 命令族。

全库验证期间，v2 并行新增了文档回执 `fa476b1`。第二次变基到该最新 v2，仅带来三份配置集成文档变化；逐项核对源码/锁/构建输入完全相同，build sourceDigest 保持不变。没有用旧分支测试掩盖代码差异。

| 原来源 | 最新 v2 上的映射 | 内容 |
|---|---|---|
| `1e9a76a` | `ac73435` | 结构化 assignment、推理能力/编码/证据、wire v7 |
| `1108011` | `697fe0c` | 原功能验证回执与 live 待办 |
| 本轮组合修复 `4560f03` | `0f2cd0a` | 新装 model v2 种子、迁移预览身份、单一命令面及跨域回归 |
| 本轮新增 `e82d116` | 原哈希保留 | 与统一配置协调的 live-only 依赖和命令文档 |

在两个工作区干净、v2 HEAD 仍为 `fa476b1e726fc65349b5cfa8e195d3cd66e4227b` 时，执行 `git merge --ff-only e82d116114de501dd6fb99b01adeea72a0db7757`，实际快进成功。该区间 merge commit 数为 **0**。本报告与最终状态是后续文档提交，不改变已验收的代码。

## 组合修复的必要差额

统一配置的新装 bootstrap 与无既存模型文件的迁移，原来仍生成 model v1。现在生成空 model v2，迁移预览 digest 也绑定将生成的模型文档。已有模型文件仍保持原字节，不借 general `config migrate` 改写其 schema 或 effort；模型显式迁移继续归 `models migrate --confirm`。

顶级 `models use/reset` 保留必须且只能指定一个 `--for`/`--default` 的合同，新 effort、show、migrate 接入同一族；旧 runtime 别名没有复活。补充五个集成测试，验证 schema v2 模型在 general 迁移/中断恢复后不丢 policy、空文件初始化、general config 与 reasoning 相互不改写，以及实际 CLI 的档位/标题/显式默认行为。原有 bootstrap 用例增加新种子的 schema 断言。

## 本轮验证与制品

使用 pinned Bun **1.3.14**，本轮 PATH 的 Node 为 **20.17.0**；AI `5.0.253`、OpenAI provider `2.0.125`、Effect `4.0.0-beta.107`、esbuild `0.28.2` 未升级。部分既有测试按自己的合同选固定 Node；不能将它们全部描述为最低 Node 执行。新增 reasoning Node bundle/CLI 用例在本轮限定 PATH 下运行。

| 检查 | 实际结果 |
|---|---|
| Frozen install、类型检查、构建 | 通过；两个工作区均复验，锁文件没有额外改写 |
| 组合代码全库 | **2190 pass / 6 native-default skip / 0 fail**，284 文件、18051 assertions |
| modeld `release-offline` | **516 pass / 0 fail**，53 文件、3119 assertions；passed-offline |
| 最后变基后的只读原生源码资格 | **28 pass / 0 fail**，6 文件、209 assertions；包含默认跳过的六个 native-source case |
| 合入后 v2 `config-unification` | **205 pass / 0 fail**，1308 assertions；类型、构建、真实临时文件/进程、source/packed 和 Host import fence 通过 |
| 合入后 v2 reasoning + E09 制品专项 | **37 pass / 0 fail**，7 文件、262 assertions |
| 本地文档链接 | 首轮检查 376 个本地目标无缺失；最终新增回执链接另复查 |

全库和 modeld verifier 的固定执行提交为第一次变基后的 `4560f03`；最后变基的代码对应 `0f2cd0a`，两者仅差最新 v2 的三份文档，构建输入一致。合入后在 v2 再次执行配置和 reasoning/制品专项，而非仅依赖 Git 快进。各项测试有交集，不相加作为独立用例总数。

只读原生 lane 检查既有 native source pin，限临时副本变换/语法编译及隔离 VM 消费者；源文件与相关 PID 快照未改变，受保护临时副本已清理。它不启动完整原生 Host，也不证明新制品已被现役进程加载或原 App 已成功交付。

- Build sourceDigest：`82aaf3e43024f82e8d382734315e6208db5eb956d4d522e89d3b93c310f16750`。
- v2 CLI SHA-256：`cfa34e8b2c0de82576483824dbb3b93069322765d48a0388e0ffe299def1cb69`。
- v2 preload SHA-256：`de365fe5b3ebac1fc58ff576965c30228ba8755eeac73018b9658af48195a0ae`；E09 pin 未放宽。
- v2 配置专项的 source/test/lock 验收输入摘要：`f5587bdf49362095eda9b2f0be009f2459ba704855f2e8f4b144894dc05e3659`，656 个文件，前后一致；与 build sourceDigest 是不同输入集合。

## LIVE 与独立门禁

唯一现场验收入口仍为 [LIVE 账本](../tickets/LIVE-integration-validation.md)。下列三条已映射到 v2，但仍 blocked：

- [REASONING CUTOVER](../tickets/LIVE-integration-validation.md#live-reasoning-cutover)：与 CONFIG CUTOVER/CONSUMERS 协调 old-writer 退出、canonical/home 别名、general config 与 model schema 的分工、v7 成套加载及匹配旧制品/旧配置恢复。
- [REASONING PROVIDER](../tickets/LIVE-integration-validation.md#live-reasoning-provider)：原通道真实 effort 透传与上游执行档位证据。缺可信回报仍 unknown，tokens/时延/标题不是档位证明。
- [REASONING HOST APP](../tickets/LIVE-integration-validation.md#live-reasoning-host-app)：已有 TURN 不混档、下一 TURN 改档、原生工具/Memory/compact/交付及原 App 显示。

实际 live candidate、对象、额度、窗口与加载身份均未选择或未记录。独立代码复审仍留在 [FEAT 来源票](../tickets/FEAT-model-reasoning-policy.md)，不会因合入转为已完成。其他并行配置、ownership、modeld 与 ops 条目的状态和历史回执保留。

工作树公开内容扫描为 **0 findings**。全可达历史扫描不是绿色：基线 `fa476b1` 与合入后 HEAD 均为 **16 findings / 6 commits**，命中集合完全一致，本次没有新增。涉及既有 `3b45e36`、`4e494fd`、`8760d3a`、`90346bb`、`c84e421`、`cf4a06e` 的提交邮箱元数据，未复制具体私人值到回执。该历史隐私问题是发布前的非 live 门禁；本次没有借线性集成擅自改写此前 v2 历史，也没有 push。

## 源码 shim 与运行边界

已只读确认全局开发 CLI shim 跟随 v2；快进后下一次 CLI 调用使用新代码。没有修改 shim 文件不等于其后续行为没变。普通模型保存会写 model schema v2，不能在旧 Host/modeld 仍运行时把保存成功当作上线资格；现场仍需先保护配置并安排批准的成套切换。

本次没有迁移现役配置、修改现场 Bot、重启/领养 Host/modeld、调用真实 Provider、发消息、推送 Git 或更新 Linear。源码集成、磁盘构建、隔离测试与原生源码只读资格，不构成 live 发布。
