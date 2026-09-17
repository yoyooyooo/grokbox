# 2026-09-17 — 默认用户保护、维护者配置与 Routine CLI

**状态：用户补充后的接受方向，Spec/Tickets 更新，不是功能已实现或现役已启用。** 细节唯一归 [Template Ops Spec](../roadmap/template-ops-automation-spec.md)。本页补充 [2026-09-16 决策](2026-09-16-template-ops-automation.md)，仅修订默认能力与支持/配置/通用 Routine 边界；精确补丁资格、独立 grant、唯一 controller、Bot 先结束再维护自己的 Host 等规则不变。

**同日后续修订：** [多目标与授权发布决策](2026-09-17-ops-routing-and-authorized-issues.md)取消「只能单个官方模板接收」限制，默认 user 小能力保持；D10 继续拥有默认 exact-consent 路径，另增仅限固定公共摘要、独立明确授权的 issue grant。D11 的 singular binding 扩为命名 targets/routing/private bindings，模型仍归原 owner。新细节只在专项 Spec §5.2、§6.3–6.5 维护，不从旧语句排除新范围。

## D8 — 默认小能力，维护者手动扩展

新安装在正常启用 grokbox 服务后默认提供轻量本地采样；模板完成独立配对、通知能力和成本告知后，默认只对已确认的用户影响且无法安全自修的事件发一次简短提醒，并询问是否整理 issue。正常 source 更新、无影响位移、深 replay、维护者调试不打扰普通用户。不需要先试一次修复或发动模型才能判定「没有合法自修路径」。

这替代上一版「所有安装一律 off」的目标说法，但不意味着仅安装 CLI、GET 或模板 import 可以安装服务/产生费用。未配对显示 blocked-unpaired；旧安装已明确 off 或关闭某能力的选择保持，软件升级不自行扩大预算。

命名 preset 为 user/maintainer；它不是安全角色或超级权限。维护者可多开 source/helper/资格细节与离线分析，自动诊断、主动探针、Host 维护各自 opt-in。preset 不签署维护 grant，不批准公开 issue，不把用户现场自动发给发布者。

## D9 — 节省 token，不是假称零 token

常态采样、分类、去重、准备安全证据用确定性程序，不调用模型。普通用户默认首醒只领取安全摘要、简短告知并询问，随后结束，不主动深排障、跑 canary、查询 GitHub或定时催问。Webhook 原生 Bot 推理可能产生费用，配置分别显示请求预算与无法证明的原生 token 上限。去重/周期/预算不可因通知重试被绕过。

## D10 — 用户同意整理不等于同意公开

本地支持流程分开：提醒/询问 → 用户同意准备 → 脱敏结构化草稿 → 显示目标仓库、可见性、完整正文、附件与作者 → 用户对 exact draft 确认 → 提交/对账。无回应或拒绝不追问。提交超时保留 unknown，不自动再次创建；已创建不代表问题解决。后续评论/新附件另行确认。

维护 grant、maintainer preset、Webhook 字段与 Bot 推断都不能代替受信用户对稿件的同意。默认无附件，只携带 bug report 所需的安全事实；安全漏洞/敏感内容按 SECURITY.md 走私密渠道。不将原始 transcript、Memory、provider body、私有 Host 源码或凭据当作高效报障所需材料。

## D11 — 自然配置，不增第二套权威

偏好存入统一 config.ops，由唯一 ConfigurationWrite 程序处理版本化 preset 和显式叶覆盖。实际 binding、维护与 issue grant 存在各自受信机器状态；support consent 不是配置布尔值。requested/effective/来源/阻断原因分别展示，升版本、换 preset 和恢复备份不能授予权限或增加 token 消耗。

普通配置入口可以看预览后应用 preset，进阶可做 leaf override 或声明式 apply；可移植导出不含 endpoint、secret、身份、grant、consent。关闭自动能力不等于撤回当前补丁或取消正在运行的用户任务。

## D12 — Agent/Routine 管理必须通过通用 CLI 打通

当前 agents create/update 仅有 profile/settings，template routines 为空、agent export 的 automations 只是备份，不能声称已经支持原生 Routine CRUD。新增 T53 交付统一的 routines list/show/apply/enable/disable/delete/invoke/outcome，并让 create/update 的 --routines-from 复用相同程序。模板配对和 E2E 也复用，不直接写产品文件或建立私有调度器。

Routine 默认 disabled，Webhook trigger 不附带周期性 schedule；创建 Agent 成功而 Routine 失败必须保留原 Agent ID 和阶段，不能删掉重来或报告全成功。原生没有 CAS/幂等时明确并发/未知边界，不靠本地锁冒称能拦住 App writer。

E2E 必须经实际发布 CLI 创建测试 Bot、设置/启用 Webhook Routine、真实 HTTP POST、原生 run/报告核对、更新再验证、禁用并清理。请求只含合成标识；测试对象与花费单独授权，不自动开启 Host 维护或向公共仓库提 issue。清理仅针对本次拥有且任务已结束的资源，不能用 finally 或 HTTP 200 自证完成。

## 交付分工与失效

T51 拥有分层/配置，T52 拥有确认后支持上报，T53 拥有通用 Agent/Routine CLI；T43–T50 补相应依赖与反例。主 Spec/产品/架构与维护手册路由同一专项，不另建默认值文档或 issue 工作流平台。

原生任务/模板/认证、用户回复来源、GitHub 提交接口、preset 默认与成本、配置 schema 变化会使对应资格或同意失效。本次仅落文档；上线按 user、diagnose、maintain 三条 lane 分别验收，基础支持不等待全自动维护完成。
