# 同通道推理设置：结构化 assignment 与最终请求校验

Status: accepted implementation direction; deployment and provider qualification remain separate.

## 决策

模型身份与 Bot 的推理设置分开。`models.json` v2 的 assignment 是 `{ modelId, reasoning?: { effort } }`，catalog 记录仍拥有 wire model、endpoint、凭据引用和能力声明。`models use --effort` 不生成 `@high` 等派生记录、不伪造 wire ID、不切换通道。真实上游变体仍是普通 catalog 模型。

`use MODEL` 和 `--effort default` 完整替换该 assignment 并清除显式档位；default 表示不发送 effort，不代表 medium/high/none。`none` 是需能力明确支持的真实取值。`reset --for` 删除本地 override，保留现有下一 TURN official 语义，不更改 harness。

本地模型在 `capabilities.reasoning` 声明 `false` 或非空、去重的 `{ efforts: [...] }`；缺字段是 unknown。协议为 OpenAI-compatible、模型名称像 reasoning model、Pi `reasoning: true` 都不足以建立档位白名单。Pi 适配只接受显式 `thinkingLevelMap` 的身份映射；数字预算、降档映射不作为支持证据。声明是配置管理员的请求合同，不是上游已经执行的证明。

## 不采用派生 catalog 的原因

复制 record 会复制 endpoint、context window、credential reference 和 dialect；之后基础 catalog 更新不会自然传给这些副本。再增加生成、删除、alias 截断及碰撞机制，只是将 assignment 的结构复杂度转移到持久目录。保留同一个 modelId 也避免仅因改档而触发模型身份变化。

## 唯一执行链

纯 parser/resolver 生成 detached、deep-frozen `ResolvedModelSelection`；policy 和 capability 参与 `selectionRevision`。Host 只携带已有薄身份字段，不加入 SDK/Effect；modeld 仍是唯一 admission、auth、STEP 与 Provider owner。当前 TURN 使用原绑定，新 TURN 才读新配置。冷存储保留完整选择，恢复时校验 record 与 revision；不以当前配置替代旧绑定，不改变旧 epoch 拒绝或同 STEP 去重。

SDK 获得与其他设置合并的 `reasoningEffort`（包括 none 所需的采样语义），但不拥有最终参数真相。当前锁定 `@ai-sdk/openai@2.0.125` 对 Grok Responses 的模型名识别会省略 effort；[生产路径回归](../../packages/box-runtime/test/reasoning-backend.test.ts)同时保留这个反例和修复证明。现有 guarded fetch 在实际 HTTP 前完成白名单投影：Chat 为 `reasoning_effort`，Responses 为 `reasoning.effort`；缺失可以由该专用 adapter 补入，冲突/错模型/错协议字段必须拒绝。最终大小、工具声明和取消门禁不撤除。不用通用 body override、模型名伪装、node_modules 补丁或另一套请求循环。

## 证据与兼容

保存意图、TURN 捕获、提交给 fetch 的参数、Provider 自报执行档位是不同事实。配置查询明确 `configured_next_turn/not_observed`；终态带 selectionRevision 及 bounded/redacted `stream.reasoning`、SDK warnings。`providerReported` 当前固定 unknown，没有经过资格验证的回报解码器就不猜。tokens、时延、标题及模型自述不能确认 xhigh。

`reasoningTokens` 只保留 Provider 报告的非负整数且不超过 completionTokens；它是 completionTokens 的子集，不再累加到 total。缺失或非法值保持 unknown/缺字段，零是明确报告的零。

models v1 只作为读取和迁移输入，内存归一化不写文件；所有明确授权的模型保存都写 v2，也提供 `models migrate --confirm`。未知字段拒绝，旧 CLI 遇 v2 明确失败，不能悄悄丢失 policy 再写回。升级前必须由维护者保存受保护的原配置；这不是自动备份或降版工具。不顺带迁移配置根，统一配置根工作通过同一个 RuntimeStore 接口衔接。

Unix 执行协议升为 v7，防止旧严格客户端拒绝 reasoning usage 而将成功误读。v4/v5/v6 仅保留有限只读身份诊断，不能执行 v7 STEP。CLI/preload/Host/modeld 必须在批准的集成窗口成套升级；旧运行 TURN 不能跨服务代复活。退回旧程序必须同时恢复相应旧 schema 配置备份，不能靠删除 effort 字段伪造无损降版。prompt envelope 与工具循环 ABI 不因此新增任意参数。

## 非目标与验收

不实现逐消息 effort、任意 providerOptions、thinking budget 换算、preset 继承、官方大脑档位控制或新的 Provider API；不改变 MiniMax inline reasoning/history 合同；不新增重试执行器或放宽 ownership/预算门。现有 Provider recovery 在选择改变时仍 fail-closed，而非借重试换档。

源实现与离线出口见 [功能票](../tickets/FEAT-model-reasoning-policy.md)。真实网关透传、已加载原生 Host/App 与成套切换/回滚只登记在 [LIVE 集成账本](../tickets/LIVE-integration-validation.md) 的功能条目。代码合并、配置声明、测试绿色和登记本身均不授权部署、发送消息或模型消费。
