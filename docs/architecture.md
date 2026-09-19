# grokbox 架构

本页拥有模块、事实写入权、资源寿命和信任边界。实现位置以源码为准；接受但未完成的扩展归 [roadmap](roadmap/README.md)。不要从旧阶段目录图重新创建已经存在的组件。用户语义归 [产品合同](product-contract.md)，运行时细节按 [runtime](box-runtime.md) 展开。

## 1. 主链与组合根

```text
CLI registry / parser / input
  → application use case
  → resolved Profile + required capability
  → local Gateway | direct Gateway | daemon RPC
  → original product writer or governed host adapter

Box model path
  native Host / original Agent loop
  → pure Host bridge + bounded IPC
  → runtime-kernel STEP / authority / context programs
  → Box adapter / ModelBackend / provider
  → validated stream/tool material
  → native Host tools / checkpoint / delivery
```

Sandbox 和 quota 使用各自的显式外部能力，不借 daemon/Gateway 凭据。连接软件和网络策略是部署前提，不进入 kernel。CLI/runtime 以单 Box 为主要工作面；已有远程适配不会使本地 runtime mutation 自动可远程调用。

## 2. 事实和写入权

| 事实或副作用 | 最终 owner |
| --- | --- |
| 命令、选项、能力元数据 | `packages/cli/src/registry.ts`；parser/help/reference 派生 |
| config/preferences/当前 Profile | kernel ConfigChange；Box protected IO 发布 canonical 文件 |
| 每 Bot 模型 assignment / catalog | models writer；在途 TURN 保留捕获选择 |
| Server 执行归属 | 原生 Server registration；Host 桥给出 scoped 观察，不创造租约 |
| 活跃会话 root、tools、Memory、Transcript、checkpoint、SendToUser | 原生 Host/worker；modeld 不成为第二 writer |
| STEP 身份、claim、尝试与结算 | kernel execution history/ledger，经唯一 STEP 程序消费 |
| provider 凭据 | modeld BackendAuth/受控 secret reference 解析 |
| Host 部署与补丁操作 | 唯一 controller、精确 identity/recipe、guardian 和原生 supervisor 边界 |
| 文件、进程和 Job | daemon policy 下的 host adapter/Job manager 和真实 OS 观察 |
| incident、ack/snooze、采集 cursor、通知 outbox | 单 Box monitor store；不拥有执行准入 |
| 通知 binding/grant、provision 回执 | 各自受保护机器状态 owner；不是普通 config 或诊断缓存 |
| CONT 恢复材料与管理操作 | continuity 私有 store；活状态仍由原生 writer 接受 |
| Sandbox allocation/lease、账号 quota | 对应外部能力的有界观察，各自授权 |

只读投影不反向写入所属事实。缺记录不等于从未执行，当前查询不能伪造事故时状态。没有跨 Server、Host、文件和 SQLite 的隐式分布式事务。

## 3. Repository Shape

一个发布包、三个 unpublished workspaces。精确 package 名、exports、依赖、Node engines 和 Bun pin 由各 `package.json` 与 [根配置](../package.json) / [锁文件](../bun.lock) 拥有，不在架构副本中手写版本。

```text
bin/                         shared Node entry for grokbox / gbox
packages/cli/                registry, application, connections, daemon, adapters
packages/runtime-kernel/     pure contracts, policies, command/inference programs
packages/box-runtime/        Host leaf, Node IO, backends, runtime composition roots
skills/                      packaged operator topics and generated command reference
test/                        CLI / integration / packaging tests
scripts/                     build and explicit proof runners
```

发布清单不是空 dependencies：原生 SQLite/LevelDB 依赖由 package/build/安装测试一起保护。Node 生产路径不导入 `bun:*` 或 Bun globals；Bun 可运行开发脚本和测试。`dist` 是构建输出，不是源码权威。

依赖方向：CLI 调公共 kernel/Box 门面；kernel 不导入 CLI、Host 私有模块或 provider SDK；Box adapters 实现 ports；Host/preload 仅有纯合同、同步必要 bootstrap 和有界原生/IPC leaf，不导入 Effect、SDK、SQLite 或 CLI。纯规则无需为对称性创建 Service。未来 UI 调共用命令，不另写配置或运行时。

## 4. Registry、输入与输出

registry 每个 leaf 统一定义 path、usage、target role/kind、required capability、可用选项、stdin/table/timeout 规则和确认策略。实现显式绑定用例，不由 registry 拼任意 Gateway method。一个命令在 parser、help、Skill reference 和验证路由中保持一致。

`--text` 的存在决定输入来源，不以 `stdin.isTTY` 猜是否有正文。普通名称解析与要求 exact UUID 的安全操作分别遵守其合同。typed 结果在边界投影，有限 JSON 与 NDJSON 不夹原始 provider body、prompt、环境或凭据；错误保持已发生的 operation identity。

## 5. 配置、选择和迁移

精确 schema、版本和路径定义归 [configuration](configuration.md) 与 source links。kernel 拥有 schema/path/revision/ConfigChange；Box IO 拥有 no-follow、权限、锁、发布、读回与恢复；领域便利命令和 bootstrap 共用该程序。Profile transport DTO 是配置派生值，不是第二磁盘格式。

全文件 CAS 与 consumer dependency revision 分开。committed、configured-next-turn、captured、applied 和 running 不混用；查询不替消费者写采用凭据。Host 只读必要的有界 model/纯策略快照，不导入完整配置/ops 子系统。

迁移是受保护、可恢复的多阶段操作：先确定唯一来源/fence 旧 writer，固定计划和备份，按阶段提交并读回。出现不兼容 schema 或未知字段时不能按文件存在或默认值静默选择；恢复不能覆盖后来的用户编辑。机器 grant、pairing、writer floor 和执行 identity 不从配置复制获得。

## 6. 连接和授权

Profile resolver 输出不可变连接描述；应用只依赖能力形状，不认识网络发现 DTO。daemon transport、direct/local Gateway、Sandbox、quota 和桌面适配各保留有限接口。显式 remote 失败不改走更高权限的 local/SSH 路径。

secret reference 在有权消费它的 adapter 解封；连接 ref 的平台形式与 provider ref 的窄形式不同。file 读取检查 no-follow、regular file、owner、mode、大小与编码。App descriptor 仅是 Gateway-only 兼容来源；不能从其成功推出 Sandbox/quota 权限。独立共享 daemon credential 可轮换，网络身份不代替 capability auth。

已有 init/SSH/peer/endpoint bootstrap 实现在 CLI 部署层，按当前源码保留；只检查已配置前提或操作明确拥有的目标，不修改无关映射/策略。它不进入 Box 模型执行链。后续网络边界变更需要与源实现同步，不因文档收敛假称旧适配已删除。

## 7. Daemon 与 Gateway

`daemon serve` 组合 listener、auth/policy、Gateway discovery、host adapters、Jobs、有限流和 shutdown。Unix socket 权限与认证 loopback HTTP 分开；禁止默认公网 listener。常驻和自启动由实际部署 owner/资格决定，不能依据某台开发机的进程列表写成长期架构。

Gateway discovery 在启动与明确的认证/代际失效后重读；wildcard bind 只拨 loopback，非本机发现须由显式连接授权。有限 method allowlist 和 typed projection 在 adapter 边界执行，unknown management write 不重放。完整 profile 更新按原生语义合并遗漏字段，但不回填 harness。收到对象 ID 后投影失败必须保留该身份。

## 8. 文件、进程和事件

文件 root 是 policy object，不是字符串前缀。通过 canonicalization、no-follow 和 Linux descriptor 验证取得受限对象；传输不重新打开已经授权的 pathname。变更在 pinned parent 下执行，按物理目标串行化，受控 staging/flush/rename/readback 与 expected hash 防止本系统丢更新；外部 syscall 级竞态明确保留。recoverable trash、transfer/operation identity、取消 tombstone 与有界 ledger 各有独立职责。

Job 在 spawn 前持久声明，字面 argv/executable alias、最小环境和 named-root cwd 由 policy 决定；admitted executable 不是 filesystem sandbox。进程组 signal 核对原始 start identity，无法核验则 fail closed；Node 没有 pidfd-backed 原子组信号承诺。Job lifetime 不属于 follower；日志有界且持续 drain，重启后无法证明的非终态为 unknown。

事件只汇聚声明的 source，带独立 daemon/Gateway generation 和 cursor。retention、断线和不支持 resume 的直接 Gateway 都产生 gap；未知不是空成功。capability、字节/数量/时间上限以实际 source/test 为准，不在本页复制旧常数。

## 9. Sandbox 与 quota

[Sandbox adapter](cursor-sandbox-control-plane.md) 必须在 Box 无法调度时仍有外部 observer；模型调用、SSH 活动、ping、Gateway SSE 不是 lease 证明。wake、keeper、freeze 和恢复单独观察。quota 只读取一个明确来源并验证有界响应，失败不借另一 token/source、Host 私有存储或 wake 路径。

## 10. Verification

源码合同、fake integration、真实 Node packed、原生隔离、外部 runner、Provider/App、重启与长期运行是不同证据面。[LIVE](tickets/LIVE-integration-validation.md) 决定当前场景及证据范围，[执行手册](maintainers/live-end-to-end.md) 提供实际窗口方法。

静态检查须覆盖 registry 派生、Node import fence、包文件、原生依赖和 source contract；fake 不能证明真实 tailnet/Host/Provider。外部资格需测试进程实际在外部运行，不能在同 Box 套 SSH 伪装。测试修改维护所证明的性质，不固定某天 `not-run` 等可变业务状态。

## 17. Box-local model runtime

本节保留外部引用锚点。细节的唯一归属按职责拆开：

| 领域 | 合同 / 代码发现入口 |
| --- | --- |
| STEP、authority、服务/等待寿命、stream、恢复 | [execution](runtime/execution.md)；`runtime-kernel/src/internal/inference`、`box-runtime/src/internal/modeld` |
| 本地窗口、Pi 算法、摘要与 Host 接受 | [context](runtime/context.md)；`internal/context`、Host context bridges |
| 当前状态、复制、材料、未来交接 | [continuity](runtime/continuity.md)；kernel continuity、Box continuity roots/native worker |
| incident、通知、存储和受托操作 | [operations](runtime/operations.md)；kernel observation/commands、Box ops、CLI daemon sender |
| profile/source/能力与中断恢复 | [Host compatibility](runtime/host-compatibility.md)；Box host/process/roots |

Server registration 是归属权威，但不是所有产品事实的中央存储。Host 原生 writer 保留同 Bot 上下文/工具/Memory/提交。managed ownership 补充检查不替代原生迁移/暂停屏障；快照不是租约。普通模型选择只改未来 TURN，撤销 execution authority 和新 config 意图是不同事件。

Config/modeld/Host 需要相容的 schema/wire/profile；精确 wire 常量在 [wire.ts](../packages/runtime-kernel/src/internal/contract/wire.ts)，不能把旧 proof 用的版本写成当前生产路径。旧 peer 可被有限只读诊断，不借此授权新执行。

持久模型服务验证使用构建后的 Node 制品：`bun run modeld:run` 最终运行 `node dist/index.js runtime modeld run`，不把 worktree TypeScript 路径当已安装包。此命令是服务入口而非本页要求执行的检查；启动/替换仍受窗口授权约束。

短效 runtime 状态、durable configuration/material 与 CLI 安装树分开；实际布局由 [path source](../packages/runtime-kernel/src/internal/config/path.ts) 和配置指南拥有。路径被命名为 durable 不证明平台 Reset 一定保留它。契约切片和保留 bundle 仅是受保护本机证据，不作为公开 Git 依赖、不恢复未知 Host、不成为第二补丁 writer。

历史 POC 内部 API、阶段图、旧 review 编排不再是兼容义务；有用理由与精确基线见 [archive](archive/README.md)。不得重新建立第二 admission/Agent loop/配置投影 writer 来满足旧施工叙述。
