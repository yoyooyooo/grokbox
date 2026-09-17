# 默认本地上下文维护，而非等待上游溢出

日期：2026-09-17。状态：**accepted target / documentation-only**。本次固定产品与实施规划，没有实现新配置/命令、启用能力或批准现役 Host/modeld 切换。

## 问题与决策

长会话可能在模型请求失败后持续携带过大的窗口；只在成功响应后读 usage，或只等待 provider 的溢出错误，会使已失败会话无法自行前进。已有 T32 恢复内核不等于默认主动维护已交付。产品必须覆盖：**已存在、最近失败且没有新有效 usage 的长会话，在下一条普通输入时先按本地预算维护，成功后处理同一条新消息**。不要求新建 Bot、清历史、手动 compact 或先再撞一次上游。

本地工作窗口独立于模型/端点声明容量。上游即使接受 500K，本地选择 128K 也按本地阈值维护；未知上游容量不阻止明确本地预算工作，不把本地预算说成已验证的上游能力。计量的不确定性和服务器更小的隐藏限制仍然存在，窄条件的溢出恢复保留为兜底。

## 冻结的边界

1. **默认自动。** 支持范围内的 managed 会话使用 `auto`；普通输入、restore/模型切换、工具结果之后的下一请求都有发送前检查。`manual` 只关闭主动维护，不关闭本地硬预算。旧会话与新会话同等支持，不以最近 assistant 存在或成功作为前提。
2. **唯一配置域。** 两个入口继续是 `config.json` 与 `models.json`。本地策略在 `config.runtime.context`，模型声明、凭据、reasoning assignment 仍在 models。模型级与 Bot 级预算覆盖不授予 managed 选择或新的数据/执行权限。默认值、公式、版本与生效规则只由 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance) 定义。
3. **Pi 是实现参考，不是运行依赖。** 采用新输入检查、usage+增量估算、失败不清零、安全切点和持久压缩边界；覆盖新增输入、固定开销、工具结果和最终编码。固定参考与差异见 [Pi 对照](../maintainers/pi-compaction-reference.md)。公共 CI 不要求安装 Pi、访问网络或取得私有 Host 材料。
4. **Host 仍写历史。** Host 拥有 root、归档、carrier、工具关联、队列、Memory 和 checkpoint。kernel 拥有本地预算及统一维护程序；Host 经资格化的窄能力准备/接受候选，不从 UI、展示库或整个 archive 拼另一份 prompt。预算不是静默裁剪许可。
5. **一个维护流程。** 主动阈值、硬预算、手动和确认上游溢出进入同一维护程序，reason 不同。先实现安全点的有界阻塞维护；后台预生成只是后续延迟优化。已有后台摘要须按真实 owner 收口，不能永久 `blocked` 或抹掉 Promise。
6. **摘要也有预算。** Host 提供合法分区；独立 `conversation-compaction` 推理复用 modeld 的 auth/ModelBackend，默认使用捕获的已选模型，不回到等待中的业务 STEP。显式另一摘要模型必须走 models 的选择/凭据合同及成本披露。长历史使用有界分段/合并，不能把超长历史原样发给同样放不下它的摘要请求。
7. **验证后提交。** 新候选先证明结构/目标预算/保留边界，再由 Host 在 root 版本和运行身份 fence 下接受并 checkpoint。新窗口、实际发送窗口及持久化状态分别核验。仅数量下降、digest 变化或摘要返回不算完成。
8. **新消息与旧执行分开。** 维护成功后当前输入只处理一次；旧失败 STEP 不复活，旧工具不重做。取消/失败保留原历史及新输入的真实状态；跨崩溃无法确认的写入和请求先对账，不自动重放。

## 对既有裁决的精确扩展

本决策扩展 2026-09-08 ADR D3/D11 中的预算触发与 Host 委托范围：Host 仍是上下文最终 writer，但 managed 本地维护不再仅由 provider 错误触发；`HostCompact` 不再限定为只有活跃 STEP 的恢复消费者。新的空闲会话维护拥有独立 operation 身份，不伪造 STEP。

专用摘要过去显式走 native external，是旧接线事实；目标中改为 Host 材料/接受策略 + 独立且明确的摘要推理选择，不是主模型 fallback。这需要新的 purpose、协议与原生接点资格，不以文档更新宣称已接通。官方未 opt-in 与 temporal 路径不变。

`GROKBOX_MODELD_HOST_COMPACT` 是现有未完成交付的实现开关，不是新产品合同。CTX 交付时删除这条正常功能开关及对应默认关闭分支，使用版本化配置与能力就绪检查；故障注入仍默认关闭且与正常能力分离。不在本次文档工作中提前打开旧开关。

## 不采用的方案

- 仅重启或开启旧 gate：不能补齐 preflight、目标预算、pending 收口和 checkpoint。
- 把模型声明容量改成假值：混淆能力与使用策略，导入目录会覆盖用户意图。
- 先发超预算主请求以获得一次报错：浪费请求并依赖具体 provider 分类。
- 在 adapter 中按条数/字符截断、删工具结果或写第二份历史：破坏 Host 的状态与恢复语义。
- 完整移植 Pi Agent loop/session store 或先引入 Pi backend：不符合当前 Host 所有权，也不是这次需求的前置。
- 先堆后台并发、无限摘要/重试或大量阈值参数：增加等待环和无界成本；第一版先提供可证明的安全点维护。

## 文档与交付 owner

产品义务归 [产品合同 §12.2](../product-contract.md#context-maintenance-product)，模块与全部算法/预算/错误/验收唯一归 [主 Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)。[CTX-01–CTX-04](../tickets/README.md#context-maintenance) 保存施工范围与证据，不重复定义公式。T32 保留失败恢复次数/零放行合同，T35 保留原生生命周期与原有未证门，两者的新实现差额由 CTX 系列接收，不重做已过子集。

源码、离线证明、独立 review、原生隔离资格、live 采用分开。新功能全部仍为 planned；仅真正依赖现役系统的最后验收预登记到 LIVE，代码/测试/review 不转成 live-only 余项。实现、集成及 live 切换时按 S12 的版本失效条件重验。摘要是有损表述，不承诺逐字记忆或不可用摘要服务下必定成功；承诺可压缩普通历史有有界推进路径，失败清晰、原始材料不被暗删。
