# AH-138 原生产品管理：施工验证与未解决审查项

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
