# AH-138 原生产品管理：修复与交付验证

## 本轮续接结论

原 WIP 检查点后的三处已复现问题均已修复并进入正式 Node HTTP 回归：管理授权在最终原生传输前复核；roster 与关系读取以同代际、前后账号/目标身份采样约束；回执验证 action、目标、派发、读回与清理字段的相容性。先运行的七个反例全部失败，再在修复后全部通过；没有降低原断言或恢复旧写入口。新鲜度与采样不是跨 App 原子锁。

扩大调用方检查后，删除了无调用者的旧 `gateway-duplication`、CLI management helpers 和七个通用 Gateway 写包装。原 `openAgentDuplication` 和 CONT 原始记录仍保留；旧历史查询只读。明确 title sync 的模型标签刷新仍归原标题 owner，用户 profile update 只保留已有元数据，不隐藏刷新。相应旧测试已经迁到共享管理入口；跳过原因中的实际 Bot ID 投影也修复。

只读核对当前原生 roster 的结构（不输出内容或身份）发现 52 个对象中有 6 个头像字段为 null。解析已保留原生 null；资料更新省略尚未设置的头像字段，不将缺省误写成空字符串，也不向原生 `.trim()` 传 null。新增读取/更新/显式设置头像的隔离回归。此次只读探测没有原生写入，也不能代签真实修改或 App 验收。

新发现的消息域管理撤权问题已单列 Linear AH-163：在实际管理 HTTP 和合成原生端点，名单读取期间撤销 messages.write 后仍尝试 sendPrompt。它不反向锁住独立产品管理，作为明确必要修复进入核心候选依赖。该消息回归不由本报告冒充已修复。

原生来源仍为下文明确的 Host/worker。新的 current guide 是 [原生产品管理](../maintainers/native-product-management.md)。本报告记录实现和验证；是否合入与可解锁关系由 Linear 的精确提交回执决定，以下历史检查点保留。

## 修复后的实际验证

- 首次负例窗口：原 35 个 Node 用例通过，新增 7 个安全反例全部失败；修复后反例全部通过，保留原失败日志。
- 最终产品/CLI/desktop/title/identity 八文件：143 个外层测试通过；产品 wrapper 内部为 50 个真实 Node HTTP/CONT SQLite/打包 CLI 用例，0 fail/skip，不重复累计。
- 根/Web 类型、完整 build、runtime boundaries、docs 16 项、diff 检查均通过。较早的修复窗口交叉七文件 59 项通过（Server wrapper 内部 36 项），原生 product/duplicate 6 项隔离验证通过；各窗口独立，不相加冒充覆盖率。
- 原生 roster 的只读结构观察仅报告字段类型计数，发现并修复 nullable-avatar 与合成 fixture 的差异。没有输出人设、消息或账号标识，也没有实际用户写入。

本报告不代替新的 V2 合流回执、独立整候选审查或 LIVE 签收。上述验证与下方历史失败分开，工具被拒的可选变更不算已经实施。

## 历史 WIP 检查点（已被上述修复续接）

## 结论与范围

本回执记录 D2-A 工作树的阶段结果，**不是 Done、合入 V2 或生产采用证明**。执行状态和依赖关系仍由 Linear AH-138 管理。未解决项属于本票实现，不是新增外部依赖；没有为了停工建立人为 Blocks。

基线：`13f2296f701faa670d15e39ee9a9d2e25e1e0339`。工作分支：`feat/ah-138-native-relations`。本轮未切换 Host/modeld、全局 shim 或现役服务，未操作用户 Bot、Group、Routine、桌面，也未调用收费模型。

源码涉及共享 client/Server、Box 原生 adapter、原 CONT 请求记录和 CLI/daemon 迁移。管理请求使用原 installation/principal/scope/request；duplicate 委托原 `openAgentDuplication`，不替代原生生命周期。单次 profile/settings/member 操作分开，不隐藏额外写入。旧通用产品 daemon RPC 和 CLI 写入口退出；保留的原生 title/template/CONT 消费者仍分别由其原路线收口，不能据此宣称整个 daemon 已删除。

## 已执行验证

| 验证 | 结果与证明上限 |
| --- | --- |
| 根 `bun run typecheck` | 通过；静态检查不证明原生行为 |
| 产品、CLI、management、duplicate、desktop 五文件定向回归 | 118 个外层测试通过；其中产品 wrapper 在独立 Node 中执行 35 个 HTTP/SQLite/打包 CLI 用例，不能把 wrapper 与内部用例重复累计 |
| 固定原生 product + duplicate 隔离资格 | 6 个测试通过、无跳过；选定原生声明实际执行，外部账号/manager/IO 使用隔离替身，不是实际账号现场 |
| daemon/ownership/template/export/gateway/client/Server 七文件交叉回归 | 59 个外层测试通过；其中 Server wrapper 内部为 36 个真实 Node 用例，均无失败/跳过，不与 wrapper 重复累计 |
| `bun run check:docs` | 更新命令映射后 16 个测试通过；LIVE 现场结果未改变 |
| `bun run typecheck:web` 与 `node scripts/check-runtime-boundaries.mjs` | 均通过 |
| `bun run build` | CLI/runtime/Web 构建通过；未安装或切换现役服务 |
| 额外审查探针 | 3 个问题已在自有临时 HTTP/SQLite fixture 中复现；详见下节，不计入“全部通过” |

原生来源 Host：`bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`；worker：`da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`。选定声明摘要随隔离测试输出保存，未把原生私有源码写进仓库。

命令映射首次检查发现 LIVE 清单仍引用退出的写入口；已更新当前 LIVE command-coverage、migration-map、相关 Skill 和 [duplicate 指南](../maintainers/native-agent-duplicate.md)。没有把任何 LIVE 结果改成 passed。

## 需要修复的三个已复现问题

### 1. 最终原生读取期间撤销管理权限，仍发生一次派发

`submitNativeProduct` 在调用 `native.dispatch` 前复核管理权限；后者又执行一次原生 preview。隔离探针在这段最终 roster 读取期间撤销 `products.write`，随后观察到原生写次数为 **1**，预期为 **0**。原生读回前的再次授权太晚，不能代替发送前授权。

修复出口：最终原生调用前复核同主体管理权限，取消或失权保留可证明的未派发结果；补对应回归。原生本身没有全局账号锁，修复也不得宣称原子授权。

### 2. 客户端/持久记录校验接受互相矛盾的结果字段

以真实 fixture 生成的合法回执为基础，仅将结果改为 `nativeReceipt=not-dispatched` 且 `readBack=matched`，`assertProductReceipt` 仍接受。当前字段逐项合法检查不足以证明组合语义。

修复出口：验证未派发与读回/清理/目标的相容关系，以及回执目标与原 action/target 的对应关系；不能只检查枚举成员和字段形状。

### 3. roster 读取中的账号 scope 切换未被预检识别

隔离探针在 roster 序列化期间改变 fixture 账号 scope，preview 仍成功返回。当前 snapshot 顺序为 roster 后 ownership，缺少前置账号身份观察，无法拒绝该已知跨 scope 窗口。

修复出口：以同一原生代际的前后账号/目标身份观察限定 roster 和关系读取，观察不一致时拒绝混合视图；缺来源不能降级为空集合或当前成功。

## 回执与继续点

本轮尝试补强上述 guard 及 duplicate 原计划绑定的编辑调用被工具安全检查拦截，**未落盘**；没有改用其他通道重试这次编辑。独立的文档修正和隔离探针正常执行。

本机 `.scratch/ah-138/` 保留 `targeted.log`、`native.log`、`review-probes.node.ts`、`review-probes.json` 和检查日志。探针只使用仓库 `product-fixture.node.ts` 创建的合成端点与临时数据，没有真实账号效果。后续必须把这些问题修复并纳入正常回归，再完成全消费者/打包/文档检查、对齐最新 V2、独立审查和串行合入。

AH-139 当前仍需要本票交付；AH-142 另有 AH-137 前置；AH-140 还需 AH-139、AH-137。AH-111、AH-118、AH-133 已完成，不应重新设成未完成依赖。工具调用中断不是这张 DAG 的新业务依赖。
