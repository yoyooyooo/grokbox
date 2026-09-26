# 独立 POC 导航与证据链：2026-09

本页把已读取的独立实验目录纳入项目检索，保留机制、反例、源码与回执之间的关系。初版归档覆盖 2026-09-26 10:57 UTC，现追加当日 14:05 UTC 已收场的 program-update 固定窗口。它不是全机临时目录清单，也不宣称发现了所有历史实验。

公开目录保留的是提炼和可核对索引，不复制非公开 Host/App bundle、凭据或私人对话。若原始回执以后不可得，下面的摘要只能证明归档时读取了哪份材料，不能代替原始字节。

## 按问题进入

| 想知道什么 | 证据主题 |
| --- | --- |
| 为什么自有模型正常，官方 App 却没有消息？ | [入口与会话 owner](official-client-ingress-poc-2026-09.md#1-自有会话-poc先证明模型与跨机器状态不证明官方-app-接管) |
| 自定义正文可见，为什么还不算接管主循环？ | [官方工具委托的边界](official-client-ingress-poc-2026-09.md#2-官方工具委托-poc官方历史可见但主推理仍属官方) |
| 为什么只修改 Gateway 并非到处有效？ | [未修改客户端的分流](official-client-ingress-poc-2026-09.md#3-未修改客户端的路由才决定-host-是否有控制位置) |
| 同样传 Box，为什么创建结果不同？ | [Local-first 创建对照](box-local-first-poc-2026-09.md) |
| 消息写回、Routine 和 Memory 怎么接？ | [原生运行接线](native-runtime-poc-contracts-2026-09.md) |
| Host 更新与身份迁移能否混为一个事件？ | [更新与身份事实分层](host-update-identity-poc-2026-09.md) |
| 更早的 compact、checkpoint、架构实验在哪里？ | [日期窗口](../2026-09/README.md)、[compact 演变](managed-compact-evolution.md)、[外部 session 研究](external-session-research.md)、[重建基线](runtime-rebuild.md) |

## 实验家族与材料位置

这次实际读取的三组实验位于云电脑工作区的临时证据根。下列完整目录基名和相对文件名用于复盘定位，不含访问凭据，不是产品运行约定；换机后可按基名查找，正式产品不得依赖它们的部署位置。

| 目录基名 | 覆盖范围 | 当前归档处置 |
| --- | --- | --- |
| `grokbox-server-identity-custom-runtime-poc-20260926` | 自有统一会话、官方工具委托、客户端 0.58.0 分流、初始本地房间 | 提炼已收录；原 native.ts 和执行器仍可能被后续实验引用，不删 |
| `grokbox-local-room-loop-poc-20260926` | 房间整体替换的 Host-only 模型前切口、原函数验证、创建/恢复/清理 | 保存其有限正例和未加载边界；旧绑定不能恢复为现役 |
| `grokbox-ordinary-bot-entry-poc-20260926` | 普通本地对象、local-first 登记、原生运行、身份读回、完整受控窗口 | 创建/ack/Routine 合同是产品化输入；原始回执暂留 |

同一目录中的 `RESULT.md`、`UI-RESULT.md` 等可能包含阶段追加和过时操作说明。引用时注明截止窗口，区分后续带原回执的纠正，不把旧“下一步”当当前任务。原始路径定位与当前支持范围是两件事。

## 从问题到源码，再到回执

| 阶段 | 关键实现/研究文件 | 关键回执 | 已取得与未取得 |
| --- | --- | --- | --- |
| 自有跨机器会话 | 第一目录的 runner.ts、server.ts、native.ts、verify.ts | RESULT.md/RESULT.json、state/requests、重启读回 | 模型/工具/状态和跨机器 API 正例；不是官方 App 入口 |
| 官方历史工具桥 | 第一目录的 answer-current.ts、ui-setup、ui-bridge | UI-RESULT.md、UI-official-history.json、official-receipts、ui-restore 回执 | 原生历史有自定义正文；官方仍调度/提交，已退役 |
| 客户端分流 | 第一目录的 pre-model-routing-058.test.mjs、inspect-runtime-contracts-058.mjs | PRE-MODEL-TAKEOVER.md、QUOTA-ROUTING-RESULT.json | 原函数加替身的路由与回执压缩；不是网络或零费用证明 |
| 本地房间 | 第二目录的 patches.mjs、hook.cjs、engine.ts、original-flow.test.mjs | RESULT.md、evidence 中创建/恢复/清理 | 空房间真实创建清理；自定义接入未实际加载 |
| 普通对象隔离 | 第三目录的 ordinary-paths.test.mjs、local-only-census | RESULT.md 相应固定节 | 原工厂/名册/路由与有限元数据；不等于在线登记 |
| Fresh 与 Local-first | 第三目录的 full-create/local-first 相关 helper、原生工厂与登记者 | full-create-evidence、local-first-evidence 的原始首次请求/响应 | 同源 BOX=1 得到不同首次结果；真实 Local-first Box 正例 |
| 普通运行与 ack | 第三目录 runtime 及 controlled-window/runtime/native-hook-routine.cjs | 原 native ack、provider/工具、私聊回执 | 漏 token 的反例和修后在线正例；不关闭可靠性保护 |
| 多群与 Routine | controlled-window/runtime/loop.ts、原父子任务接线 | execution-summary、runtime/state/requests、api-evidence | 同身份/共享原生 Memory、原调度器手动及定时正例；不签全部长期容量 |
| 身份与升级 | p0-lifecycle-evidence、controlled-window 的观察 helper | 原 Server 列表、update-boundaries、post-upgrade/restore-readback | 同身份最终 Temporal 的真实回执；具体历史内部因果未完整获得 |
| 受控程序更新 | controlled-window/program-update 的 policy、原 Loop/接线和整包制品 | 真实 operation、首启/原 Server 读取、80文件清单、业务/故障/恢复原回执 | 同一普通 Bot 跨35733d4→c3282ed保持Box并可用；B未请求、C保留、D首启就绪；不签永久持有或零额度 |

## 归档时核对的内容摘要

以下 SHA-256 是读取时的文件内容摘要，不是执行成功的替代，也不是要求未来文件永远不能更新。表中 S/R/B 分别指上表第一、第二、第三个目录；不是新的产品 ID 或另一套证据注册表。

| 材料 | SHA-256 |
| --- | --- |
| S / RESULT.md | `b00c05dac076beca51eb86433147e3e45d77bf8bad111e3086f00c542d42d483` |
| S / UI-RESULT.md | `1df0aab7184aac4fb5c43982ec484d68be5625215218703f2f1ef47118e3f367` |
| S / PRE-MODEL-TAKEOVER.md | `e80174561d41bed484295526a087d2864403fe4a2b46346a3b9d31886e3b5568` |
| R / RESULT.md | `ebde59d85bc9c51f94b3bba3e336a1976d9043ea53fb61765cb2f4707aefc8c5` |
| B / full-create-evidence/original-client-request.json | `dfeb78444e0520d9a3b72029ae729ba58db368e6fb5b55c6238d62a803179e61` |
| B / local-first-evidence/original-client-request.json | `8de0802a39ff099e0b18bd0e4fdc4700a83cdd3fb0435d397970c4d2b6636517` |
| B / controlled-window/evidence/execution-summary.json | `c50e472dfb38aee4775092d1c2e8f8539a85ec70c070086435aa7afd5d06d0ef` |
| B / controlled-window/evidence/update-boundaries.json | `dbafe9d8920309e344088b2d0b2b3bea5a86a1cdbec9e35d67c6033fff71a923` |
| B / controlled-window/runtime/native-hook-routine.cjs | `72ca383edefafa42b7eb9ac3338bf4b3e6905d4f2a36471e247ab80a55c92341` |
| B / controlled-window/runtime/loop.ts | `27d3fde1cf55852be3f1d7988e8052768cd38778977a4cabe05b654564bdf0e5` |

日期报告、原始请求、实际 loaded source/helper、模型/工具结果、原生 writer/ack、客户端确认和最终恢复互相补充。只有汇总没有原请求，或只有源文件没有运行回执时，应下调结论范围；不能倒填成真实通过。

## 哪些精华已进项目，哪些仍应暂留

已经进入本项目证据的，是机制、对照、成功/失败/未执行边界、关键协议字段、状态 owner、有限恢复教训和原始材料索引。没有复制个人主目录、tailnet 地址、测试身份清单、原聊天正文、认证头或原生 bundle 源码；也没有把普通云电脑目录一律当作秘密。

仍暂留的原始材料包括独有首次响应、unknown、原生恢复和历史回执，以及仍被 A/B 使用的 helper。已查到普通 Bot POC 的 action/live 程序仍依赖第一目录的 native.ts；删除第一目录会破坏后续消费者，即便其最初自有网页方案已不再采用。

program-update 子目录由该实验的实际执行窗口负责；14:05 UTC 来源与运行代恢复已读回，其结算结果现沿[同一日期报告](../2026-09/2026-09-26-box-creation-feasibility.md#program-update-continuity)补入主题。原始计划、首次失败、unknown 和实际效果仍由原文件保留，归档不重写它们；当前角色/操作责任仍归主线安排。

退役顺序为：正式接口替代 → 消费者去依赖 → 独有证据进入可读回且校验过的保留集合 → 确认无活动使用和未决效果 → 清理临时代码/可再生输出。原生 Bot、Memory、数据库和凭据不属于这类删除对象。
