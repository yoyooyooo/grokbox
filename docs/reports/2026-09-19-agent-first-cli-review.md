# Agent-first CLI 多视角审查

日期：2026-09-19。状态：固定审查结果，具体合同仍待讨论。范围为 [CLI 候选方案](../roadmap/agent-first-cli/README.md)，不包含新命令实现或 Web UI 像素审查。

## 结论

Agent-first 与实现收束的方向成立。本轮未发现足以要求推翻对象划分、统一后台或独立 modeld 寿命的证据，但方案仍不能作为完整定版合同。去重后有 5 项 P2 发现，集中于失败恢复和端到端用户意图。

P2 在本文指命令合同定版前需要解决的具体缺陷或缺失，不表示现役产品出现生产事故。本轮没有证实 P0/P1。发现都附具体场景；未实现的新命令、205 个候选 leaf 的数量、实现占位未写数据库结构均不作为缺陷。

182/182 映射只证明旧 leaf 名称都出现了，不能证明每个参数分支、目标范围、权限与成功条件已经保留。后续迁移验收应以用户意图为单位，命令名只是索引。

## 审查组织与证据范围

用户授权四个并行 subagent，分别独立阅读方案和有关源码，再交叉核对重复发现。主 Agent 复核了关键合同、默认清除的实际分流与数据规则、通知启用程序、模型捕获与 revision 组成。所有检查只读；未操作现役服务、发消息、安装补丁或调用模型。

| 审查视角 | Agent | 原始有效发现 | 汇总去向 |
| --- | --- | --- | --- |
| Agent 使用体验与可组合性 | cli_agent_experience | 外部操作恢复、默认清除 | R05、R02 |
| 领域模型与命令语义 | cli_domain_semantics | 通知首装、默认消费者、目录写入影响 | R03、R02、R04 |
| 幂等、并发与可靠性 | cli_operation_reliability | 重放与准入检查顺序 | R01 |
| 迁移完整性与架构收束 | cli_migration_coverage | 默认清除分支遗漏 | R02 |

审查对象是基于 commit `6f0473d54b16885568e85c2850bc1bde02f58579` 的未提交方案文件，不能仅用该 HEAD 或普通 git diff 代表本次内容。关键文件的审查前 SHA-256 如下。此次只新增审查记录和来源票的待处理项，未修改这些正文。

| 文件，均在 docs/roadmap/agent-first-cli 下 | SHA-256 |
| --- | --- |
| spec.md | `a763d6a0b3844a0b0f5f03fedb3f64af93bd19d943e44ef82b9970fff6d141cd` |
| command-contract.md | `39b9c48ebc60353fbc82f7bc0299f62ce99974281903b7de6214214f6541a861` |
| command-catalog.md | `46702a91e87446221db7cd4a3d16f76bcb042c605c77bfa49d389e9d028348eb` |
| migration-map.md | `d925ceeaf35353abcae368520903a6daa9c38328abfa53085f8d4240231a697c` |
| decisions.md | `b1bb9d91659c239c8aacf619164fd64b8b08329d2f36d705fdef3322e40e57d6` |
| implementation-impact.md | `678db37eccc515357f0b61f3bdd5384ce484cad33ceae3d22bd8f250acf32a57` |

源码说明实际行为，不自动证明这些行为正确或应该永久保留。报告引用旧行为，是为了找到不能被名义映射掩盖的用户意图；取舍仍由新合同明确决定。

## 发现

| 编号 | 优先级与类型 | 问题 | 处理归属 |
| --- | --- | --- | --- |
| R01 | P2，协议顺序缺失 | 已接受请求的重放可能被新的 revision/plan 检查拒绝 | D04、D05；CLI-02 |
| R02 | P2，迁移漏项与语义缺失 | 默认模型的消费者与清除意图未闭合 | D01、D10；CLI-04 |
| R03 | P2，用户旅程缺失 | 健康系统首装通知，没有取得测试 work 的正常路径 | D01、D05；CLI-04、CLI-02 |
| R04 | P2，影响范围未定义 | 更新/删除模型目录条目怎样影响已绑定 Bot | D01、D05；CLI-04、CLI-02 |
| R05 | P2，恢复定位缺失 | Box 管理服务不可达时怎样找回外部操作回执 | D04、D08；CLI-02、CLI-04 |

<a id="r01"></a>
### R01 · 先区分重放与首次准入

位置：[command-contract](../roadmap/agent-first-cli/command-contract.md) 第 164、166、194、196 行。合同同时承诺同幂等键返回原 operation，以及提交时重新检查 revision、计划有效期和运行代，未规定两者的适用顺序。

具体序列：Agent 用 request-id R、revision 10 提交；操作成功把 revision 改为 11；响应丢失；Agent 复用 R 和原输入重试。若先按首次提交检查 revision，就得到 conflict，违背返回原操作的保证。计划在回执丢失后过期、操作本身改变运行代时同理。

建议在 D04/D05 明确：认证当前主体并检查回执读取权限后，先按原 key 和固定语义指纹查找已接受记录。命中且语义一致则只返回原回执，不执行首次准入、不推进业务；语义不同返回冲突。未被接受的新请求才检查执行前置条件。之后的显式 resume/cancel 是另一个控制请求，不能借重放恢复副作用。

这补充的是现有 D04/D05 的具体协议冲突，不新增一套审批或通用事务系统。后续反例必须覆盖“成功本身改变 revision”和“plan 过期但操作此前已接受”。当前[通知激活程序](../../packages/box-runtime/src/internal/roots/ops-activation.runtime.ts)也有在 revision 核验前返回既有自动激活回执的局部分支，但这不证明所有领域已满足统一合同。

<a id="r02"></a>
### R02 · 默认模型需要明确消费者和清除语义

位置：[command-catalog](../roadmap/agent-first-cli/command-catalog.md) 第 33、77 行，[migration-map](../roadmap/agent-first-cli/migration-map.md) 第 55 行，[command-contract](../roadmap/agent-first-cli/command-contract.md) 第 132、136 行。

新目录只有 model default get/set；整个旧 models reset 被映射到 bot model reset。后者改变一个 Bot 的选择，不能表达“清除安装默认值，保留所有 Bot 的显式选择”。

这不仅是遗漏一个动词。目录又要求 bot model set 显式提供 modelRef，create/clone/replace/spawn 没有说明何时消费默认值。默认值究竟是创建时拷贝、持续跟随、由调用者明确请求采用，还是维护工具的预选，尚未决定。

源码核对：

- [registry](../../packages/cli/src/registry.ts) 第 424、427 行声明 --for/--default 两个分支。
- [program](../../packages/cli/src/program.ts) 第 439、441 行将默认清除交给未指定 Bot 的用例。
- [runtime command](../../packages/cli/src/commands/runtime.ts) 第 259、263 行调用模型变更 owner。
- [模型数据规则](../../packages/runtime-kernel/src/internal/selection/models.ts) 第 446、448 行清除 assignments.main，并保留 agents；第 455 行起还保留 route 模式阻断。这是当前受限行为，不应写成所有模式均可清除。
- 同文件第 562、570 行附近的默认解析与逐 Bot 原生路由是不同逻辑，旧字段存在不等于未来普通 Bot 会消费它。

建议先决定默认值的实际业务用途，再给无默认、更新、清除及未来新 Bot 的结果定合同。如果没有正式消费者，明确退役对象；若保留，则提供唯一清除表达并按参数分支修正映射。现有 route 模式限制是否仍合理也须明确取舍，不机械继承。

<a id="r03"></a>
### R03 · 通知首装不能依赖先发生一次故障

位置：[command-catalog](../roadmap/agent-first-cli/command-catalog.md) 第 40、41、95、96 行，[command-contract](../roadmap/agent-first-cli/command-contract.md) 第 144 行。

场景：新安装已配置 disabled Routine、完成 bind/verify 并单独启用 Routine，但系统健康，还没有 incident/work。notification send 只发送既有 work，verify 明确不发送，enable 又需要测试接收证据。调用者没有正常的首装路径可取得这份证据。

[通知激活 owner](../../packages/box-runtime/src/internal/roots/ops-activation.runtime.ts) 第 48 行查询 accepted seed，并核对绑定和有效期。[现有验收步骤](../maintainers/live-end-to-end.md#webhook-journey)需要预先准备测试 work，不能安全触发来源故障时保持 blocked。当前实现没有替新命令合同解决此旅程。

建议先明确自动启用的产品承诺和必要证据。若保留测试接收前置，应提供针对既定接收者、固定内容的显式测试操作，产生真实 test work/attempt。测试不伪装成 incident，原生 accepted 与实际接收仍分开。也可以选择等首条真实 work 后启用，但必须把这一限制作为产品取舍说明，不能让 Agent 猜测或制造故障。

此处不决定采用哪个新动词，也不因旧代码已有门槛就认定它永远正确；具体选择进入 D01/D05。不得把副作用偷偷塞进 verify。

<a id="r04"></a>
### R04 · 模型目录写入要说明受影响的 Bot

位置：[command-catalog](../roadmap/agent-first-cli/command-catalog.md) 第 32、91 行，[command-contract](../roadmap/agent-first-cli/command-contract.md) 第 132、136 行。

场景：Bot A、B 都选择 modelRef M，A 正在运行。Agent 执行 model apply M，修改 endpoint、capability 或 credential reference，或删除 M。合同只称其为目录声明，没有决定 B 下一 TURN 是否随之改变、是否需重新选择、删除如何处理已有引用，以及已捕获 TURN 所需信息如何继续成立。

[selection revision](../../packages/runtime-kernel/src/internal/selection/selection-revision.ts)第 4 行起纳入 provider、endpoint、capability 和凭据引用；[模型捕获](../../packages/runtime-kernel/src/internal/selection/models.ts)第 547 行起复制并冻结选中记录。这说明目录内容参与实际执行身份，不是展示名称。当前代码无需成为未来实现模板，但未来公开写命令必须定义影响。

建议决定 assignment 是固定 revision 还是跟随目录值，并明确何时采用。model apply 返回影响范围与生效时机，model delete 选择拒绝被引用对象、退役或显式迁移，不能靠“committed”替代这些业务结果。在途 TURN 的 captured 事实保持不变；凭据撤销等权限变化另按真实授权规则处理，不能因此承诺被撤销的权限仍可用。

这属于新增写能力的产品合同，不能推迟到存储实现时由编码者随意决定。

<a id="r05"></a>
### R05 · 外部恢复的回执必须在恢复完成前可定位

位置：[command-contract](../roadmap/agent-first-cli/command-contract.md) 第 154、158、164、168、308 行，[command-catalog](../roadmap/agent-first-cli/command-catalog.md) 第 62、63、99、103 行。

场景：外部 Agent 对冻结 Box 提交 box wake，控制面已接受，但响应丢失，Box 中的管理服务仍未启动。统一合同要求 operation get --request-id 找回；目前没有说明该命令怎样选择外部 owner、使用独立控制权限，或在 server 不可达时返回哪一种状态。“恢复后按原身份对账”不足以处理恢复尚未完成的时段。

建议为服务优先原则的例外入口定义完整定位材料。调用者应凭提交前保存的控制来源、目标与 request-id 找回同一 owner；不能要求先拿到可能已丢失的 operationRef。可以由统一 operation 入口明确路由，也可以采用其他有限表达，但不得默默查询错误的本机账本，不能因为没有查到就再次 wake/recover。

同样的规则需覆盖停止/重启管理服务的回执，保留生命周期 owner 自己的寿命。此项是在 D08 已承认的故障入口问题下补一个具体旅程，不要求引入第二个万能后台。

## 已确认合理的边界

- Bot、Group、message、run、job、operation 各自有身份与结果。duplicate/clone/replace/spawn 的差异有真实语义，不宜只为减少动词强行合并。
- 名称先解析、写入使用稳定引用，self 不信任环境变量；旧 Bot ref 不自动指向继任者。
- 不用 idle、最后回复、经过时间或一个 STEP 的结果冒充完整任务成功；没有原生关联就不开放精确完成条件。
- 生命周期、保护和 handover 的确定性推进归后台；普通 Agent 不需要循环调用内部 advance。
- CLI、未来 Web/API 共享用例，modeld 与管理服务分寿命；观察索引不夺取配置、Host 或 CONT 的事实权威。
- 本地快照/cursor 的一致性不被夸大成全上游原子事实；collector 没收到的历史不能伪造。
- exec/jobs 合并保留 shell 的独立能力、执行期限与观察期限的区别。verify、配对、投递授权也没有混成一个隐式发送动作。

这些是方案边界检查结果，不代表对应新服务或迁移已通过实现验收。

## 未计为新缺陷的事项

| 项目 | 本轮处理 |
| --- | --- |
| request-id 是否用于 preview/refresh、控制动作自己的请求与回执 | 已在 D04/CLI-02 待定，记录具体场景但不重复算新增发现 |
| 旧请求 GC、epoch、过期拒绝的具体机制 | 合同已有目标，实现策略未选择；不能因未展开 DB 设计判错 |
| file download 是否污染 JSON stdout | 未证实。现有 download 使用显式本地目标，候选没有承诺二进制 stdout；输出参数待细化 |
| 同一 plan 是否允许不同 request-id 执行 | 先决定它是可重复声明还是一次计划；重复 clone 可能是第二次合法意图，不直接判重复副作用 |
| ref 与 connection 不匹配、nextActions 的完整目标上下文 | CLI-01 已要求错安装拒绝；具体表达待定，未证实一定写错目标 |
| SSH/bootstrap 与冻结网络兼容路径 | D08/D10 已保留迁移取舍；没有把旧适配形状当成必须保留的产品合同 |
| 新候选尚未实现、命令数量增加 | 不属于此次方案缺陷 |

## 下一步

优先补 R01/R05 的恢复协议，再一起决定 R02/R04 的模型引用语义，最后闭合 R03 的通知首装旅程。具体命令名字服从这些结果，不先从 205 个名称里删词凑数量。

[CLI-02](../tickets/CLI-02-operation-contract.md)和[CLI-04](../tickets/CLI-04-command-cutover.md)拥有后续处理，报告保持固定。建议尚未作为已采纳设计写入合同；用户本轮要求的是 review。

此次只有文档与源码审查、反例走查，以及新增审查记录的文档检查。没有执行新 CLI 或原生端到端验证，也没有把 subagent 审查称作用户批准或生产资格。
