# 2026-09-19 本机原生来源只读资格核验

## 范围与授权

用户明确授权本机只读来源核验：最多 12 次请求，单次不超过 10 秒；仅当前安装、身份和原生元数据，不读正文、不修改服务或数据、不发送消息、不调用模型。目标无法确认时停止。该授权不包括部署、Host 切换或六格模型 E2E。

本轮在 `2026-09-19T14:40:46Z` 前后观察。机器身份、执行用户和既有目录链接相互符合 Box 环境；未创建同名目录补足证据。既有 CLI 版本为 `0.1.0-alpha.6`，launcher SHA-256 为 `dbaed0815f78ac2d1f7995b3a8533d3be40e4ad5f365b8b140ac8642b1265dbd`，未发现其引用本施工 worktree。launcher hash 不等于完整安装制品资格。

默认 Profile 为 auto，但没有远端 Server/Gateway URL 或 SSH host，原生发现位置符合本机布局。实际 HTTP 核验使用本仓受限原生适配，独立约束仅 loopback、固定只读方法、无重定向和请求期限；没有启动管理 Server 或改全局入口。

## 观察

- 两次 `listAgents` 和两次 `getHostStatus`，共 4 次 HTTP 请求，均返回 200；后者的一次重复只检查响应字段形状。
- 原生 Bot 投影共 48 项，未发现截断身份文字。列表的 harness 声明均为 temporal；这不是独立的执行所有权证明。
- 观察到的原生 generation 为 `a9258ba33b5bed448490386db12ff080a45de2805aabb1b50688cfd8cc2b8c0b`。
- HostStatus 的可见顶层形状为 `hostVersion`、`latestHostVersion`、`hostUpdateAvailable`、`isBusy`、`capabilities`；未返回管理所有权适配所要求的 `grokboxOwnership`。当前适配因此报告 `source_invalid`，没有将 200 或本地 harness 当成准入证明。
- 文件系统仅做目录枚举和 stat，没有读取材料正文。Agent 目录 57 项，user-memory 分片目录 3 项，Project 目录 6 项；有限样本与既有 Agent Memory、user shard、Project Memory 布局相容。
- 文件夹数量与 API Bot 数量不是同一覆盖面，不能据此推导原生 membership、删除状态、全账号覆盖或材料已进入 TURN。

## 边界与后续

当前 HostStatus 响应不满足所有权观察合同，原因尚未进一步确认。不得据此修改 harness、采用 Host、重启服务或宣布身份迁移。受管执行的当前原生资格仍未验证；需要固定候选、明确变更目标与恢复路径后，另获授权再处理。

本轮未调用 Memory 正文端点，未读取 Project 描述正文，未执行材料修改、索引扫描/重建、SSE 订阅或通知。没有凭据、原始响应、Bot 身份、原生正文或私有 Host 代码落入本报告。没有创建需要删除的原生测试对象。

本轮工作树仍为 dirty，候选检查只得到 planning-only 的结构结果；不签新 CLI/API/Web、部署、独立 modeld 寿命或模型矩阵通过。源码与实际制品、来源能力与完整产品资格分别判断。

来源与后续责任：[CLI-05](../tickets/CLI-05-implementation-follow-through.md)、[DATA-01](../tickets/DATA-01-memory-project-files.md)、[LIVE](../tickets/LIVE-integration-validation.md#live-materials-search)。
