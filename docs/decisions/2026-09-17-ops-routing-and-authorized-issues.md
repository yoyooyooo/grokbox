# 2026-09-17 — 可配置接收 Bot、多目标分流与授权后 issue 自动化

**状态：接受用户本轮补充，Spec-only；未实际启用或授予任何安装权限。** 本决策在同日 [分层/支持/Routine 决策](2026-09-17-ops-defaults-support-and-routines.md)之后生效，精确修订单模板接收和全部发布逐份确认的限制。唯一实施合同仍为 [Template Ops Spec](../roadmap/template-ops-automation-spec.md)，新施工增量为 T54–T56；旧 T43–T53 不因新文件成为 Done。

配置遵循 [统一配置决策](2026-09-17-unified-configuration-rebuild.md) 与 [配置 Spec](../roadmap/configuration-rebuild-spec.md)：偏好位于 config.ops，真实 bindings/grants 由受信机器状态程序维护。config 管配置，models 管模型，ops 管通知与执行用例。

## D1 — 单目标默认，多目标按需；接收者不限模板

任何有权管理本安装的用户均可选择自己创建/获授权的 Bot 接收原生 Webhook，包括采用低成本 custom model 的 Bot。内置 grokbox 模板保持默认官方模型与不自行改模型的约束；不再将其推广为所有接收者必须官方。模型分配仍归现有模型配置与原生选模，ops 只引用目标，不建第二份 modelId/provider catalog。

默认只配命名目标 default，所有已满足功能/用户影响门的工作流向它。进阶再开有限规则，按 intent/source/severity/audience/incident rule 分流；有序首条命中，未命中走 default，不广播。严重告警不自动等于贵模型/深诊断，cheap/analysis 是用户偏好，不是模型等级认证。

## D2 — 目标、路由、执行和数据权限分开

routing 决定谁处理，allowedIntents/dataPolicy 决定能拿到什么，诊断/维护开关与 grant 决定能做什么。绑定身份与 native routine/secretRef/已同意选模指纹在安装私有区；导出只有别名和偏好。路由、备用或 model change 不能偷换数据供应商、跨账号传播现场或提高权限。

逻辑角色和真实账号不是一回事：maintainer preset 不自动向项目维护者发信息；高级模型也没有 GitHub 或 Host 写权限。Payload/模型输出不指定任意目标/命令，不从 Bot 转述生成用户许可。

## D3 — custom 接收者的故障域必须可见

custom Bot 可能依赖发生故障的补丁/modeld/provider；检测明确不可用后只能按事先配对的备用规则处理，不先重启 Host 来保证通知可达。官方备用不消除共用 Host/Box 风险。timeout/ACK 丢失是 unknown，禁止因此同时唤醒一群备用。安装级、真实原生 Bot 和工作级预算不会因为增加 alias 而放大。

跨 Bot 诊断升级通过本地受控 handoff，最多一层；不是 Bot 互相发消息或无限讨论。结构化结果和 evidence refs 代替整个 transcript。默认在处理 Bot 对用户报告；可显式设置集中 reportTarget，但额外唤醒与新数据去向需计费/授权。

## D4 — 用户允许后的支持流程应由 CLI 完成

默认继续「轻量提醒 → 用户同意整理 → 脱敏预览 → 对 exact draft 确认」。批准同一份内容后，CLI 自动执行提交/对账，无需用户手动复制粘贴或重复批准。无凭据也能本地准备/export。

另接受用户显式开启的 `preauthorized-summary`：限定仓库 ID/可见性/作者/incident rules/模板与脱敏版本、create-only、有效期和预算的 issue grant。只发布确定性结构化公共摘要，不接受自由模型正文、附件、评论、更新/关闭。超范围或敏感即回人工。此项是未来可配置能力，不是本轮对真实公开发布的授权，也不是 maintainer preset 的默认。

## D5 — 内置 GitHub adapter，不让 Bot 拼 shell

默认项目目标由包内 repository/bugs 元数据固定为 yoyooyooo/grokbox；当前工作目录 remote 只能生成待审候选，不能悄悄改变上报对象。实际提交前核对远端 repo ID、公开性、Issues 状态与作者权限；包元数据不等于已在线验证。

内置 Node REST adapter 复用唯一 support 用例，使用独立 GitHub secret ref 与范围受限身份；不要求用户装 gh/临时脚本。未知 POST 不自动重发，更不能退回另一个工具重复创建。多个接收 Bot 与配置变更不改变 report/submission 的唯一身份。脚本化减少重复手工，不削弱真实授权与未知结果处理。

## 文档与实现落点

专项 Spec §5.2、§6.3–6.5 是上述新增细节的唯一 Current Home。T54 负责目标/路由/配置规则，T55 负责 custom 接收者资格、预算/备用/交接的实际通知链，T56 负责 CLI 支持流水线与有限发布 grant；T50 验收单目标/custom/分流及默认/预授权发布的不同 lane。

保留 user 默认小提醒、独立诊断/维护开关、精确 SHA/Server 准入、原生 Routine CRUD、唯一 controller、T41 单库和 Effect/Host import fence。实现前不改生产模板、自定义模型、Webhook、配置、认证或 GitHub 远端内容。
