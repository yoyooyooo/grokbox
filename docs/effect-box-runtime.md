# Box-runtime Effect 标准

本标准约束 `packages/box-runtime` 及其 CLI composition roots 的后续改动：**重副作用必须由 Effect 拥有执行、失败、取消和资源生命周期，不只是返回类型换皮。** 依赖安装不代表迁移完成；当前实现以源码和测试为准。产品与权限仍由 [产品合同 §12](product-contract.md#12-box-local-model-runtime)、[运行时设计](box-runtime.md) 和 [架构 §17](architecture.md#17-box-local-model-runtime) 拥有。

## 强制范围与普通 TS 边界

| 执行面 | 规则 |
|---|---|
| coordinator / re-adopt | lease、operation lock、guardian 创建/释放、身份核对后的 signals、spawn/wait、commit/read-back/recovery 必须由同一 Effect operation 管理 |
| modeld | 服务端 listener/已接受的 client sockets、admission 等待、authority/config 读取、immutable pin、TTL、disconnect/stop、credential 与真实 driver 生命周期必须由 Effect 管理 |
| 文件写入 | journal/attestation、protected artifact、配置发布、合同 snapshot/retention 等重 IO 必须逐步纳入 Effect；Host terminal journal 的未决放置见下节 |
| 普通 TS 可保留 | hash、path、parser、envelope、binding/identity/topology 判定、纯投影、Host 同步 handle/replay 与有界 IPC 桥接；只读观察不得偷偷 repair |

最底层 Node syscall/Promise adapter 可以保留 TS，但不得在 Effect 旁另行编排重试、计时器或资源生命周期。不为每个纯函数创建 Service。模型数据和 SDK 类型保持分离。

## 版本与唯一生产路径

- `effect` 精确固定 **`4.0.0-beta.107`**，根 Bun named catalog 为 **`effect-v4-beta`**；workspace 使用 `"effect": "catalog:effect-v4-beta"`。禁止 caret/tilde、dist-tag、RC 或混用 v3；升级必须显式更新 catalog、生成锁并复验。
- E0 只增加 `effect`。不安装 AI SDK、`@effect/platform-*`、Vitest 或另换测试框架；发布目标仍是 Node 20+，Bun 是开发工具。
- Fake/Live **Layers 替换能力，不替换业务程序**。既有 CLI → coordinator、Host IPC → `createModeld` 仍是唯一执行路径；无第二 reconciler、第二 admission kernel 或 `effectMode`。
- 每个真实进程/命令生命周期一个执行根；callback 需要时复用其 ManagedRuntime 并明确 dispose。Promise facade 只在宿主边界调用同一 Effect 实现，不在每个 helper/Bot/request 自建 Runtime。
- 后续 AI SDK 只能实现 modeld 内的 **ModeldDriver Service**。Effect 拥有调用及整个流的 lifetime、interrupt、资源；SDK 接收取消信号，不另执行工具/Agent loop、写 Transcript/Memory 或调用 SendToUser。SDK/credential snapshot/streaming 协议须另行核定，不能把 response-only stub 当作真实 streaming 证据。

## Host import fence 与 J13

**preload / Host 保持 Effect-free、SDK-free。** 在首次向 Host 可达模块引入 Effect 前，先隔离 server/client 和纯合同的 value imports；验证 preload 实际 bundle contribution、external imports 及 import-time side effects，不只检查 `preload.ts` 的直接 imports，也不把被 tree-shake 的 parsed input 当作已执行代码。

Host 不读 models/attestation，不拥有 provider credential。保留 pinned-profile/exact compile 所需的最小同步 bootstrap 与成功编译后的 marker；marker 不是 committed attestation。外部 operation 负责等待、核对和签字。

**J13 决策门：当前保留 Host append-only terminal journal，watchdog 仍唯一 compactor。** Journal-via-modeld 尚未接受：不得迁移 writer、新增 terminal-report IPC method 或在 Host 加 Effect。现有锁等待/fsync 是明确的 **decision-gated gap，不是永久豁免**；完整重副作用收口不能跳过它。未来放置变化必须先获 owner 决定，并更新同日志的并发、去重、ack/gap、拒绝/断线/重启合同；模型完成不能冒充 Host normalized delivery。日志失败只影响证据，不改变 Host 回复或工具循环。

## 渐进迁移顺序

这些标签表示局部接缝，不表示交付状态或 live 授权。每步接回相同生产入口；临时 Promise 边界不得变成永久双执行器。

| 接缝 | 最小闭环 |
|---|---|
| **E1：artifact IO** | `runtime-artifact.ts` 的 acquire/write/read-back/sync/close/rename，接回 attestation/adopt journal；不顺带搬 terminal journal 或重写所有 store |
| **E2：coordinator** | 分步迁移 lease/lock、guardian/signal/wait、commit/recovery 和所用 control-event IO；复用现有 manual/coordinator，保留独立 deadman |
| **E3：modeld** | 先 scoped server acquire/stop 与 CLI signal bridge，再同一 kernel 的 authority/pin/admit/TTL/disconnect；只改外壳不算完成 |
| **J13：放置待决** | owner 决策后才实现相应 journal 方案；不阻塞无关接缝，也不被它们的通过掩盖 |
| **E4：SDK driver** | 后续一个 AI SDK-backed ModeldDriver，加上必要的 credential/streaming 合同与验证；真实 provider 调用另需授权 |

其余配置/合同重 IO 在后续触及的切片中迁移，不把整个模块清单塞进 E1。迁移不改变已接受的 generation/operation identity、pending 与 unavailable 区分、dispatch 前 authority 复核、immutable pins、重复拒绝/tombstone/capacity 或有界 shutdown。不得重新握手重投旧 invocation；不得静默回官方。

## 拒绝的反模式

- 只用 `Effect.tryPromise(() => legacyWorkflow())` 包住旧流程，内部仍是无 owner 的 Promise/timer/AbortController 编排；或只在 offline fake 路径使用 Effect。
- 同一重能力长期暴露 `Promise | Effect` 双制式 API、Service 内部偷偷 `runPromise`、每请求重建 Layer/Runtime、第二 registry/reconciler 或无界队列/脱离 owner 的 Fiber。
- 在 Host hook 导入 Effect/SDK；把纯 helper 全部 Service 化；为 adoption 顺带重写 Schema、Daemon 或 CLI framework。
- 把 **Scope 当作跨文件原子事务或 crash safety**；删掉独立 guardian，改成随父进程一起死亡的 Fiber。正常资源由 Effect 管理，硬崩恢复仍须独立进程证据。
- 全流程 uninterruptible、无限等待 finalizer、SDK × Effect 双重 retry；timeout/interrupt 被当成外部操作已撤销。保留 unknown、真实 `signaled`/已读回 receipt，不伪造回滚，不因超时 SIGKILL 官方/竞争进程。
- 吞掉 release error 或把失败/defect/interrupt/unknown 统统变成空成功；输出原始 provider Cause/body、credential、prompt 或工具正文。

## PR 如何合规

1. **声明一个接缝及其 owner。** 列出真实入口、能力边界、资源关闭路径和保留的不变量；修改实际实现及该入口的测试，不只增加孤立 demo。需要拆文件时只隔离受影响的 import 边，不扩散到纯逻辑。
2. **保留范围与授权。** E0 仅 catalog/dependency/generated lock；非 SDK 切片不加 SDK，J13 未决不改 placement/协议。标准不授权 live Host/G1、provider spend 或自动接管；不运行未经隔离的 Host/guardian/full live-shaped process suites。
3. **按版本验证。** 用根 `packageManager` / CI 声明的 Bun 生成锁，执行 `bun install --frozen-lockfile` 与 `bun run typecheck`。工具版本不一致须在 PR/commit 中记录未验证的目标版本门禁，不夹带改 packageManager/CI pin，不声称目标工具 merge-green。
4. **针对性质补证据。** 沿用 `bun test`，在 capability 边界替换 Layer；用 pin 版本的 `effect/testing` TestClock 和 barrier 验证预算/TTL/并发，用 success/failure/interruption 验证 finalizer 与部分 acquire。覆盖实际 CLI/Unix composition，不重新实现测试专用 admission。停机须关闭 owned Fiber/socket/listener，但不等待不配合的外部 driver 永远结束；记录其未知结果。
5. **检查影响并诚实交付。** Host 可达依赖变化时验证 import fence；打包变化时在隔离环境验证 Node20 package。报告命令、工具版本、依赖现实与未证实项；精确审查/stage 文件，不把无关 WIP 或私有机器证据带入提交。

Effect pin、Host/IPC 合同、journal 放置或 execution owner 改变时同步复核本标准；产品与架构规则仍维护在各自 Current Home，不复制实施报告或机器本地交付账本。
