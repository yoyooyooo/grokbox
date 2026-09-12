# Box-runtime 单轨重建实施规格

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Current Implementation Spec · accepted target · baseline `pre-publication-revision`。** 本文拥有目标包/模块树、内部端口、执行合同、退场边界和实施证明。[plan](box-runtime-plan.md) 拥有策略、Phases 0–4 与产品出口；[ADR D1–D12](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md) 保留产品/信任边界；[新票据](../tickets/README.md) 承载切片与证据。源码/可执行测试拥有当前实现真相；本文不是已实现或已部署声明。

本批次采用 owner 指定的**破坏式、单轨重建**。POC 是研究素材，不是 grokbox 内部兼容面。保留 Host 产品行为，放弃 POC 的内部 API、目录、response-only 路径与旧 wire 兼容承诺。本文取代 plan 中旧内核、旧 wire 或旧 status DTO 的过渡保留口径；不削弱 ADR D1–D12 的安全要求。

<a id="scope"></a>
## S1. 实施模式与硬边界

1. **只有一棵目标树、一套业务程序、一份当前 wire 合同。** 禁止 `legacy/`、`vNext/`、平行 kernel、旧路径转导新路径的 re-export shim、`old || new`、`effectMode` 和长寿命 migration flag。
2. T20 先做实体切割：转移仍成立的纯规则/控制机制，移除旧推理执行链及调用入口。旧测试先提取 expected vectors/oracles 到新 owner 的合成 fixtures 并指定后续激活票据，不继续 import 退场 API；未激活向量不可计作通过。尚未接好的推理/控制能力在 composition boundary 显式 `runtime_not_ready`，不能借 POC 兜底或返回 fake success。T26 必须消除推理占位，T28 必须消除控制占位；占位不是可发布功能，也不是保留旧内核的 feature flag。
3. 中间提交可以是**可编译、能力未齐**的单轨版本；不得部署到现役 Host。每票只声明实际证明的能力。删除测试或跳过断言不算恢复能力。逐票从相同目标路径装配，不创建一个完成后再搬家的新实现目录。
4. **Grok Bot Host** 指上游进程，继续唯一拥有 root/上下文选择、compact、session/store、Agent loop、工具、Memory/Transcript、SendToUser、官方 renewal 与 Gateway publication。**grokbox root** 指自己的 CLI/modeld/console 执行根，两者不得混称。
5. Host leaf 做双向归一化，保持 Effect-free、SDK-free。默认两处薄 patch；新增 patch 须按 ADR D2 有版本/收益/耦合/失效证据并获精确批准。没有所需 root/compact 事实就拒绝受影响能力，不编造接口。
6. 持久根仍为 `/workspace/.grokbox/box-runtime/`，live root 仍为 `~/.grokbox/run/`，CLI 安装仍为 `~/.grokbox/runtime/`。不迁走 Host store，不 prepend `store.db`；live 的 `GROKBOX_LIVE_PROMPT_*_CAP` unset。长期事实留给 Host Memory 蒸馏。
7. 本次只交付文档。后续源文件退场按当时安全删除策略移入已验证 trash 后 stage；不使用永久清理、reset/clean 或在 repo 留 `old/` 墓地。不得触碰他人 WIP、现役 fd、现役服务或遗留数据来关闭源码 finding。
8. **运行时 API：Node-portable。** Bun 只作 package manager 与本地 `bun test` / `bun run` / `bun scripts/*`；pin 仍为已声明的 `bun@1.3.14`，本规格不升 Bun/Node engines。published CLI/daemon、Host preload、modeld、CLI runtime、`runtime-kernel` 生产模块只用 Node-portable API，禁止 `import "bun:*"` 与 Bun globals（`Bun.file`、`Bun.serve` 等）。测试 runner 不得把 Bun-only API 泄漏进生产 import。盒上可以本地跑 Node 24；engines 下限仍是既有 Node 20+ 政策，本批次不改。

<a id="layout"></a>
## S2. 唯一目标树

### S2.1 包边界

锁定**一个新增私有包** `@grokbox/runtime-kernel`；保留私有 `@grokbox/box-runtime` 和 `@grokbox/cli`。不再增设 Host、backend、contracts、UI npm 包。npm 仍只发布 `grokbox`，`gbox` 仍是同一 binary alias。

| 包 | 唯一责任 | 不能放进去 |
|---|---|---|
| `packages/runtime-kernel` | 纯数据合同/选择规则；Effect-owned RouteBinding、STEP、控制用例、status 语义及 capability ports | Host 私有 ABI、SDK、fs/net/process 实现、CLI/HTTP/DOM、Live Layer 选择 |
| `packages/box-runtime` | Host leaf；Node/SDK adapters；modeld/CLI runtime/console 的资源装配；独立 guardian helpers | 第二 admission/控制决策器、另一份模型选择规则、私有产品 store writer |
| `packages/cli` | 参数/帮助/JSON 输出；意图交 runtime facade；later/T29-only roster bridge 才复用已有 Gateway 只读客户端 | runtime 配置读改写、adopt steps、模型 credential/provider 选择、status 推断 |

Effect 同 pin `4.0.0-beta.107`，kernel 与 box-runtime 使用现有 catalog。AI SDK `5.0.253` / OpenAI `2.0.125` 只留 box-runtime backend；不顺带升级 Bun `1.3.14`、Node 20+ 发布目标或测试框架。新私有包通过现有 `packages/*` workspace 发现并 bundled 进同一个发布包。生产模块的 Node-portable 禁令见 S1.8；`bun:*` / Bun globals 不是“开发便利可进 Host/modeld/kernel”的例外。

### S2.2 文件落点

以下为**最终必需骨架**，不是要求 T20 建空文件。注明后续票据的叶子到该票才创建；标 **later / T29-only** 的 `console/` 与 browser 资产不属 T20 骨架。小型 owner-private helper 可在同目录内增加，禁止自行增加另一层 `domain/application/services/utils`。顶层入口只显式导出本表规定的符号族。

```text
packages/runtime-kernel/
  package.json
  src/
    contract.ts                  # ./contract：纯 DTO/判别联合/校验器/预算，Effect-free
    hash.ts                      # ./hash：共享确定性 canonical JSON/SHA-256；无 IO/Effect
    selection.ts                 # ./selection：唯一配置解析与有效选择/修订计算，Effect-free
    ports.ts                     # ./ports：唯一 Effect capability Service 定义
    inference.ts                 # ./inference：runStep/cancelStep；唯一推理程序入口
    commands.ts                  # ./commands：配置、prepare、preview/apply/reconcile 用例
    status.ts                    # ./status：观察用例 + 唯一 facets projector
    testing.ts                   # ./testing：仅测试准入的 Fake Layers/control barriers
    internal/
      contract/                  # context.ts, identity.ts, events.ts, errors.ts, status.ts, limits.ts
      selection/                 # models.ts, selection-revision.ts；不包含 IO/SDK
      inference/
        route-binding.ts         # TURN 选择/auth lifetime 与失效
        step-ledger.ts           # STEP/attempt 去重、容量、状态迁移
        step-program.ts          # admission → auth → provider → terminal/unknown
        stream-state.ts          # canonical event 校验、工具门禁、终态聚合
        overflow-recovery.ts     # T32：唯一一次恢复预算，不是独立循环
      commands/
        configuration.ts         # models/desired 用例；T29 加第二 writer 防覆盖
        controller-operation.ts  # T28：一个 confirmed operation program
        target-policy.ts         # 纯 target/preflight 判断，不另执行操作
        operation-state.ts       # 唯一控制状态/receipt 转移
        reconciliation.ts        # 只产生同一 operation 的意图，不另写进程
      status/
        projection.ts            # 六 facets，纯投影
      testing/
        fakes.ts                 # capability 替身；不复制 step/controller 程序
  test/
    selection.test.ts  route-binding.test.ts  step-ledger.test.ts
    backend-contract.test.ts  status-facets.test.ts  controller.test.ts
    overflow-recovery.test.ts

packages/box-runtime/
  package.json
  src/
    runtime.ts                   # ./runtime：命令/长期进程边界的窄 facade
    preload.ts                   # 唯一 Host bundle entry；绝不经 runtime.ts 导入
    internal/
      host/
        profile.ts               # 精确 profile/transform 纯规则
        compile-hook.ts          # CJS _compile 接缝
        self-identity.node.ts    # 仅当前 Host 自身身份，不引入全局 census
        selection.node.ts        # 有界 no-follow models 读取，调用 kernel/selection
        context-codec.ts         # Host ABI → ContextSnapshot/root 完整性
        compact.ts               # T32 资格后：调用 Host 自有 compact 的窄 delegate
        session.ts               # 原 Host session/executor 方法与同步 handle
        stream-codec.ts          # canonical events → Host fullStream/response/usage
        modeld-client.node.ts    # 唯一 Host IPC client；TURN 固定 service epoch
        terminal-journal.node.ts # J13：仅 Host terminal/rejection append
      wire/
        modeld-wire.ts           # 纯帧编解码；当前单版本 DTO 来自 kernel/contract
        modeld-probe.node.ts      # Host/observer/ensure 共享的有界只读 health，无 Effect/SDK
      modeld/
        server.node.ts           # Effect-owned listener/client/frame sink，不做 admission
      backends/
        registry.ts              # root 装配的有限 kind→实现表；不扫描/尝试 fallback
        ai-sdk.ts                # ModelBackend Live Layer；唯一 SDK stream 入口
        ccs-codec.ts              # canonical input → 当前 CCS-safe Chat/Responses 编码
        openai-events.ts          # SDK event → canonical event；id/name 有界关联
        provider-error.ts         # 固定失败类/候选证据，不回传 raw body/Cause
        echo.ts                  # 显式 stub/echo 能力，同一 ModelBackend port
        pi-rpc.ts                # T30 通过 qualification 后才创建
        cursor-sdk.ts            # T31 通过 qualification 后才创建
      io/
        configuration.node.ts    # canonical 文件 read/write；不另定选择规则
        authority.node.ts        # committed/pending/disabled/unavailable 读证据
        credentials.node.ts      # scoped auth lease；值不离开 adapter 可信边界
        artifacts.node.ts        # protected stage/read-back/sync/publish/locks
        journal.node.ts          # 非 Host 事件 append；watchdog 唯一 compactor
        observation.node.ts      # config/进程/receipt 等只读快照
        provenance.node.ts       # 合同切片、整包 provenance 与安全 retention
      process/
        linux.node.ts            # census/inspect/signals，仅显式 ports
        launch.node.ts           # reviewed launch/env/preparation/wait 能力
        guardian.node.ts         # 独立 deadman acquire/release；不并入父 Fiber
        profile.node.ts          # profile authoring/read/验证 IO
        helpers/
          guardian-child.cjs  injector-hold.cjs  grokbox-temp-supervisor.cjs
      roots/
        layers.ts                # 显式选择 Live Layers；无全局实例/隐式 env resolve
        modeld.runtime.ts        # modeld run 及 prepare 的同一服务 scope
        command.runtime.ts       # CLI 一次性命令/foreground prepare
        controller.runtime.ts    # 长期 watchdog 与 confirmed operation ownership
        console.runtime.ts       # later / T29-only：HTTP/操作/borrowed-or-owned modeld lifetime；T20 不建
      console/                   # later / T29-only；T20 不建空目录、框架、假 API 或 Playwright
  test/
    architecture.test.ts  host-codec.test.ts  ccs-codec.test.ts
    host-session.test.ts  host-fullstream.test.ts  modeld-wire.test.ts
    modeld-lifecycle.test.ts  runtime-pipeline.test.ts  host-journal.test.ts
    controller-io.test.ts
    backend-conformance.test.ts  overflow-bridge.test.ts  diagnostics.test.ts
    # later / T29-only: console-api.test.ts console-state.test.ts console-browser.test.ts
    fixtures/                    # 自行编写 Host/profile/SDK/进程 fixtures，绝不放 provider dumps

packages/cli/src/commands/runtime.ts   # 只路由；不吸收当前未提交 WIP
packages/cli/src/commands/runtime-roster.ts # later / T29-only：既有 GatewayClient 的本盒只读 composition bridge
packages/cli/src/registry.ts           # 命令唯一 registry
packages/cli/src/program.ts            # dispatcher，只绑定 facade
scripts/check-runtime-boundaries.mjs   # T20：结构/import/export/退场检查；生产模块 bun:* / Bun globals 失败
scripts/pack-runtime-helpers.mjs       # 唯一打包清单，指向新 helpers/preload；later / T29-only 才加 browser
scripts/verify-runtime-rebuild.mjs     # T20 起维护：有限 case→真实测试命令映射
test/runtime-cli.test.ts               # 既有 CLI 集成测试位置，不另开 CLI test 树
test/packaging.test.ts                # 既有 Node20 发布验证位置
```

`contract.ts` 只转导 `internal/contract` 的纯声明/校验（含共享 identity/authority 判断）；不得从 Effect 模块 `export *`。仅 `hash.ts` 允许 `node:crypto` 的确定性 SHA-256；selection、Host 与 kernel 使用同一 canonical JSON/hash，不把通用 digest 藏在 model selector。除此之外 kernel 不导入 `node:*`、`bun:*`、环境或 wall-clock IO；Effect Clock/ports 提供时间和外部能力。未来 browser 只导入 `contract`，不导入 Node hash/selection；该约束属于 T29，不要求 T20 创建 browser。

`box-runtime` package exports 只有 `./runtime`；移除原 `.` mega barrel。preload 由 pack 脚本直接构建，Host 私有模块不是其它 package 的 API。kernel 只开放上述八个显式 subpath；不导出根 barrel，不开放 `internal/*`。

<a id="imports"></a>
### S2.3 谁可以 import 谁

| Caller | 允许 | 禁止 |
|---|---|---|
| kernel contract | 同目录纯模块 | Effect、Node IO、Host/SDK、其它 package |
| kernel hash / selection | hash：仅确定性 crypto；selection：contract/hash 与自己的纯规则 | provider mapper/SDK、fs、env |
| kernel programs | contract、hash、selection、ports、Effect、同 owner 内部实现 | box-runtime、Live adapters、CLI/HTTP、runPromise |
| Host leaf | kernel `contract`/`hash`/`selection`、host 内部模块、纯 wire/有界 probe、最小 Node builtin | kernel Effect 入口/ports/testing、roots/io/process 全局实现、server、SDK |
| modeld server | contract/wire、注入的 inference public program/当前 Runtime | 选择/credential/复投策略、Host ABI、实例化另一 kernel |
| backend adapters | contract、ports、自己的 codec/auth 实现、所需 SDK | inference/commands/status 程序、Host/store/SendToUser、进程 mutator |
| Node IO/process | contract、ports 与被声明的纯规则 | 调用上层 use case、构造 Runtime、反向导入 roots |
| roots | kernel public programs/ports、Live adapters、有限 framework boundary | 在 wiring 里重写选择、admission、状态或恢复规则 |
| CLI | box-runtime `runtime`、kernel contract、CLI 输出/参数；仅 later/T29 roster bridge 可复用既有 GatewayClient/redaction | kernel internals、SDK、runtime 配置/模型 credential/adopt 决策；任意 Profile roster；`bun:*` / Bun globals |
| console API/browser（later / T29-only） | API：runtime-bound commands/status；browser：安全 contract + client/state | 原始 store/SDK/Host ABI、第二业务程序/SQLite/通用 exec；T20 创建这些文件 |
| 生产 Host / modeld / CLI runtime / runtime-kernel | Node-portable APIs 与上表允许列 | `import "bun:*"`、`Bun.file` / `Bun.serve` 等 globals；把测试 runner 的 Bun API 当生产依赖 |
| 测试 | 所有者包内可测 private；跨包只走 public/testing 或真实进程入口 | 测试专用 admission、生产 Layer 偷用 Fake、绕过 SDK encode 证明请求保真 |

结构检查解析 import/export/require/dynamic import 和 package exports，追踪 re-export；测试必须证明故意加入 forbidden edge 会失败。preload 再检查实际 bundled bytes、external imports、import-time effects；仅“没有直接 import Effect”不够。不能只靠 tree shaking 掩盖错误依赖。

<a id="contracts"></a>
## S3. 核心合同与唯一事实 owner

### S3.1 数据与身份

- **ContextSnapshot**：version、profile/ABI identity、`systemMessages`（包含已解析 root，恰好一次）、`messages`（Host-selected 非 system 有序消息）、tools schema、options、snapshotDigest。system 不同时留在两个分区。没有 SDK session、可执行 tool、secret、store 引用；Host ABI 私有字段只由 `host/context-codec.ts` 读取。服务以同一 canonical hash 重算 snapshotDigest（排除 digest 字段），不信任 caller 自报值。
- **Selection**：`agentId + modelId + selectionRevision`；共享算法对该 Bot 的有效配置规范化后 SHA-256，覆盖 backend/provider/model、endpoint、credential reference 身份、capabilities/codec/limits。排序 object keys，不排序 messages/tools 等语义数组。无关 Bot 的修改不改变此 revision；不含 credential 值，也不把 configRevision 当 selectionRevision。
- **HostEpoch**：compile/source/profile/稳定 Host 身份及 adoption identity，并绑定实际加载的 bridge artifact digest/wire version；**ServiceEpoch**：modeld 本次 incarnation。**TURN** 使用 Host `sessionOptions.invocationId`，**STEP** 使用 executor `stream` 的 invocationId；不得互相回退。内核 ledger key 为 `(HostEpoch, agentId, TURN, STEP)`，binding key 为 `(HostEpoch, agentId, TURN, ServiceEpoch)`。
- **RouteBinding**：服务内部不可变 Selection + resolved config + auth fingerprint/lease + bindingId；不是可写配置。Host 只保留 modelId/revision、固定 ServiceEpoch 与 opaque bindingId，不拿 resolved credential 或 canonical activation。
- **Attempt**：同 STEP 内部 attempt=0；T32 才可增加一次 attempt=1。attempt 不伪装成新的 Host STEP。不向客户端承诺跨服务重启续传或 exactly-once。
- **PreparedCall / AuthLease**：定义在 `ports.ts` 的进程内 opaque handle，**不是 `contract.ts` 的 JSON DTO**。prepare 产物包含安全 size/capability 摘要与 adapter 私有的已编码输入；auth lease 只给受控 backend 使用。不能 stringify/写 wire/日志，不能暴露 SDK 类型。infer 消费同一 prepare 产物，不再重选/裁剪上下文。
- **StepOutcome**：身份、是否开始 dispatch、terminal/unknown、finish reason、usage availability、已放行工具/文本计数、gap；不携完整 output 数组。完整响应由 Host stream reducer 在内存聚合。
- **InferenceEvent**：owned discriminants `text_delta`、`reasoning_delta`、`tool_start`、`tool_delta`、`tool_complete`、`backend_finish`。最后一项只由 stream-state 消费为 outcome，不作为第二个 wire finish 转发；SDK error event 转 typed BackendFailure。wire terminal 唯一，Host reshape 才生成原 ABI 的一次 finish/response。

<a id="ports"></a>
### S3.2 Ports：名称就是合同，不再加同义 Promise interface

这些 Effect Service 的定义统一在 `kernel/ports.ts`；具体实现位置固定如下。名称/操作是边界合同，不要求逐 helper 生成 Service。

| Port / public program | 合同与实现位置 | 禁止 caller / 行为 |
|---|---|---|
| `ConfigurationRead` | 读一次 canonical models/desired 的有界快照；`io/configuration.node.ts`。parser/选择规则只在 kernel selection | inference 不能写配置；Host 不调用这个 Effect Service |
| `ConfigurationWrite` | 为 commands 保存 canonical 文件，返回 source receipt；同一 IO 文件实现，modeld root 不提供此能力 | UI/CLI 不直写；第二 writer 出现前不建通用 CAS 服务 |
| `AdmissionAuthority` | 当前 committed/pending/disabled/unavailable、Host identity、inhibit/recovery 证据；`io/authority.node.ts` | caller 自报 committed、health 或旧日志不能替代权威 |
| `BackendAuth` | `pin` 在 TURN scope materialize；`verify` 在后续出门前核对原身份；返回 opaque lease + 安全 fingerprint；`io/credentials.node.ts` | secret 不进入 contract/wire/status/journal；不 mid-turn remint/换账号 |
| `ModelBackend` | 纯 `prepare(selection, snapshot)` 验证/编码为 PreparedCall（零 auth/网络）；`infer(admittedCall, prepared, authLease)` 为**一个**有界 canonical event Stream + typed failure。实现 ai-sdk/显式 echo/测试 Fake，后来合格 pi/Cursor | 不执行 tools、不自循环/重试、不读取隐藏 history；不得导入 kernel 程序 |
| `RuntimeEvents` | append 受名称/角色约束的安全观察，失败返回 evidence gap；`io/journal.node.ts` | 不从事件行驱动重试、不得代写 Host `model_step_terminal` |
| `ModeldControl` | commands.prepare 请求 ensure；`roots/modeld.runtime.ts` 的 process-owned lifecycle facade 使用共享 probe/唯一 server 返回 owned-or-borrowed receipt，无新 Runtime | status/GET/backend 不可调用 ensure；stop 只由 owning root 收尾，不开放通用进程控制 |
| `ControlResources` | lease/artifact、精确 process/launch/guardian 与 waits；由 io/process adapters 组合提供 | 只有 controller operation 消费写能力；observer/modeld/HTTP 无 signals |
| `ObservationRead` | 同源 config/attestation/进程/服务/事件等只读观察；`io/observation.node.ts` | 不 repair、compact 日志、关闭 circuit 或发模型请求 |
| `runStep` / `cancelStep` | `kernel/inference.ts`：唯一 admission/ledger/producer 程序；event sink 是请求内 Effect 能力，结果为 StepOutcome | 只能 server/test public consumer 调用；backend 不回调此程序 |
| `commands` | `kernel/commands.ts`：models/use/reset、desired、prepare、preview/confirmed apply/reconcile | CLI/API 不重新组合这些业务步骤 |
| `status` | `kernel/status.ts`：ObservationRead → 六 facets；任何环境同一 projector | 没证据不能“最近一次成功=现在健康” |
| `HostSeamCodec` | `host/context-codec.ts` + `host/stream-codec.ts` 的普通 TS 函数，session 是唯一调用面 | kernel 不认识 PromptSession 私有字段；不是第二个 ModelBackend |
| `HostCompact`（T32） | `ports.ts` 定义请求新 Host snapshot 的 Effect capability；v4 server 的**当前 STEP/连接** adapter 发 compact-request/等 resume-step，Host 侧由 `host/compact.ts` 调用批准 delegate | 仅 overflow-recovery 消费；不在进程全局、CLI/API 或 backend 暴露，不成为第二 compact executor |

Auth lease 只在同进程受信任适配边界使用，backend 的 unseal 能力由 root 装配，不用全局 secret registry。验证与 SDK 使用同一已 pin 身份；读取发生变化就拒绝，不拿新的值继续旧 TURN。新 backend 的 auth 差异封装在同一能力后，不强塞 HTTP key 假设。

<a id="config"></a>
### S3.3 配置与第二 writer

保留当前 canonical models/desired 文档的单一格式与路径；不因物理切割强制迁移数据。`provider` 的既有 OpenAI 模式属于产品协议选择，不是旧/新 kernel 分支。`stub/echo` 可保留为**明确选择的无网络 backend**，必须走同一 admission/stream/terminal port；不能当默认异常 fallback、假健康或第二 test executor。

T23 将 provider allowlist/能力描述收回 kernel 的有限数据规则，解除 `models.ts → modeld-openai-map.ts` 反向依赖。root 在 `backends/registry.ts` 装配有限 kind→ModelBackend 实现表，精确查找，未知 kind 拒绝；不是 accepts 扫描、轮流尝试或另一 admission registry。AI SDK Chat/Responses 共用 CCS codec；删掉仅测试走 raw messages、生产走另一编码器的双轨。新 backend 需要的 schema 变化由 T30/T31 在同一 parser 更新；若必须换格式，使用显式一次性离线转换，不留双 parser，也不删除原始用户数据。

当前单 writer 只做 schema/gate、unique protected stage、read-back/sync/rename 和回执。真实第二 writer（未来 WebUI 或其它）出现时，在**同一入口**加短锁 → canonical 重读 → expected configRevision → mutation/publish；CLI 同时接入，不另建 UI-only lock。`configRevision` 用 canonical 内容摘要即可，不建 revision DB/projection 文件族。锁防合作 writer 的丢更新，不宣称对任意外部编辑器的原子 CAS。该 CAS 属于 T29 合同，不是 T20–T28 的默认施工项。

<a id="chain"></a>
## S4. 一条完整执行链

```text
Host queue/root/compact
 → patched createSession → selective gate → Host session/executor
 → Host-selected ContextSnapshot + thin Selection + STEP
 → Host IPC client（TURN 固定 ServiceEpoch）
 → modeld 当前版本 server（Phase 1 v3，T32 后 v4）→ kernel.runStep
 → authority + expected-selection + snapshot/capacity 检查
 → ModelBackend.prepare（纯 codec/能力/大小预检）
 → TURN RouteBinding/auth lease → 单个 ModelBackend.infer Stream
 → canonical stream-state → bounded wire events + terminal
 → Host stream-codec / 同步 fullStream handle / independent response+usage
 → Host tool loop / session-store / Transcript / SendToUser / Memory
```

1. compile/profile 不匹配不注入。非 route、非 ordinary main、未配置 `assignments.agents[agentId]`，按对象身份返回 `originalSession`。main 不是 per-agent fallback。T11 的 createSession 前置本地失败仍可官方 passthrough；一旦创建 managed session，任何失败都可见，不能重新走官方。
2. Host session 构造时抓住有界选择字段，与同步 `getModelId()` 一致。context-codec 接收 Host 已选 state/root/tools，不读 store.db。每个批准 profile 证明 root 的来源和恰好一次；未知不能当空。
3. `stream(ctx, STEP, tools, options)` **同步**返回原 handle。一个 eager producer 开始 IPC；response/usage 不从 fullStream tee 取数据。首个 health 的 ServiceEpoch 缓存于 TURN，不是每个 STEP 重握手。
4. server 只 decode/限流/关联 sink。kernel 先验证 Host authority、配置 opt-in、expected selection、内容、重复及 snapshot/codec 预算；ModelBackend.prepare 不能解析 auth 或发请求。所有 request-specific auth/provider effects 在这些检查后。snapshot/selection hash 使用规范编码；错误 body 不参与身份建立。
5. ledger 在首次等待前占位；每 TURN 最多一个 active STEP（工具并行不是 STEP 并发）。并发不同 STEP 返回 `turn_busy`，重复同 STEP 不启动第二 producer。首个 accepted frame 交回 bindingId；后续 STEP 必须借用它。ack 丢失不授权重新首绑。
6. TURN scope 拥有 config/auth pin；STEP scope 只拥有本次 provider/emit 资源。STEP 取消不会释放并重新选择 TURN；不确定效果可 poison TURN 并明确拒绝后续。普通配置保存只影响新 TURN；generation/deactivation/auth 身份失效可拒绝继续。
7. credential/等待后，在 dispatch 前复核 authority、同一 pin 身份和取消；第一次 STEP 校验选择仍相符。后续 STEP 不因 canonical 选择更新偷偷切模型，也不把无关 Bot 保存判为失效。BackendAuth/SDK 都无隐式 retry。
8. ModelBackend 仅跑一次推理。kernel 消费它一次，把 event 通过一个有界 sink 送给 transport；观测者不能再次求值 cold Stream。canonical validator 校验工具 id/name/参数、sequence、terminal 和预算。
9. 支持流式的 Provider 在 terminal 前即可抵达 Host fullStream。wire terminal 不重带 parts/output；Host reducer 聚合 messages/usage，完成 promises 与 UI reader 进度分离。声明 buffered 的 backend 仍提供同一合同，不另开 complete-only API。
10. Host 再执行工具/SendToUser 并提供下一 STEP 的 selected context。runtime 不自动 append assistant 到 Host history、不代执行 tools。Host normalized terminal 写 J13；provider finish 不等于 Host 交付，更不等于 App 显示。

<a id="binding"></a>
### S4.1 STEP、重复与退休

状态只有 `reserved → admitted → running → terminal`，另有吸收态 `unknown/refused`；实际模型 attempt outcome 与 Host-delivery evidence 分开。每条状态判断使用结构化 tag/code，不从 error.message 分类。

ledger 只保留摘要/身份/有界 outcome，不保留完整 snapshot、PreparedCall、SDK stream 或 output。STEP 结束释放这些 payload；auth/config 仅由 TURN scope 持有。Host client 的 TURN 表只保留薄 binding/拒绝事实，不全局持有所有 session/response/replay；handle 自身的有界 reader 缓存由 Host 持有引用的生命周期管理。

- 相同 key + 相同 snapshot/selection：新 submit 返回 bounded `duplicate`/原 outcome metadata，**不返回可执行工具或完整流重放**。同 key 改 payload 为 conflict；缺 STEP 不能用 TURN、lastHandle 或最近请求补齐。
- 同一个已返回的 Host handle 支持多 reader 游标；另一次 `stream()` 不获取该 handle 的 executable replay。多个 reader 不代表多个 Agent/tool executor。
- client EOF/abort、request timeout、stop：先记确定的拒绝或 unknown，再取消 owned work。后到 success/tool chunks 丢弃；不能从 EOF 合成 finish-success。
- TURN idle expiry 保留拒绝证据，后续 STEP 返回 `turn_expired`，不删除 pin 后新绑。service restart 后旧 TURN 携旧 ServiceEpoch 被拒绝；Host leaf 不重握旧 TURN。新 TURN 才可以选择新服务代。
- 有界 tombstones 保留到已证明 Host epoch 退场；满额显式 capacity，不 LRU 驱逐再重投。没有可靠 turn-close 就不发明它；持续运行超过限额须有单独退休/soak 证明，不阻塞最初 binding 切片。

<a id="wire"></a>
### S4.2 Phase 1 v3 wire 与初始资源预算

**Phase 1 只接受 v3**；请求包含 version，有限类型为 health、run-step、cancel-step。T32 将同一当前 wire 一次性升级至 v4，以支持当前 STEP-scoped HostCompact 能力的同连接 recovery 往返；不维护 v3/v4 并行 server。旧版本明确拒绝，无 feature negotiation 降级、旧 complete codec 或兼容 server。健康探测不读取模型凭据、不验证 activation，也不因旧协议不响应就删除其 socket。

socket/root 权限为 0600/0700。compile binding 是运行时事实核对，不宣称对恶意同 UID 进程的 peer authentication；console 也不提供 raw inference RPC。

run-step 请求携 HostEpoch/agent/TURN/STEP、expected ServiceEpoch/Selection、snapshot，以及后续 STEP 的 bindingId。响应按 accepted → event(sequence, canonical event) → terminal(outcome)；每连接一个请求，exact keys 和严格 UTF-8。cancel 精确指向原 tuple，不取消下一 STEP。

预算唯一落点为 `kernel/internal/contract/limits.ts`，开销超限明确拒绝/终止，绝不截断上下文：

| 预算 | 初始值 / 行为 |
|---|---|
| 配置读取 | 128 KiB，有界 no-follow regular-file reader |
| snapshot JSON / encoded provider request / wire frame | 4 MiB / 8 MiB / 8 MiB；分别计算实际 bytes，frame header 4 bytes 不计入 payload |
| canonical output 与 Host replay | 每 STEP 各不超过 1 MiB / 4096 events；terminal 留独立有界结算空间，不把已达上限变成无终态挂起 |
| server active clients / active STEP | 各最多 64；同 TURN 一次；超额 busy/capacity |
| 单进程 retained payload 总预算 | 128 MiB，所有 incoming/request/queued-output 缓存按实际 bytes 计入；分配/增长前预留，耗尽拒绝新 work，不能靠每连接各自有界隐藏总量 |
| admission wait / partial socket / request wall deadline | 500 ms / 1 s / 30 s；与 TURN lifetime 分开 |
| TURN idle / ledger entries | 5 min / 1024；expiry 拒绝续步，满额拒绝；测试用小值 + TestClock |
| owned shutdown | 默认 2 s cleanup budget；超时关闭本地 transport、记录 unknown/cleanup gap，不等待外部模型永远结束 |

这些是安全资源预算，不是 model context window/token 准确值或 SLA；不得以它们造 `overflow_confirmed`。snapshot/codec 预检在 auth 前；SDK 最终 HTTP body 的实际 bytes 再在 transport egress 前核对，超限零 provider request，不谎称此时凭据尚未读取。模型 token 限额无可信来源时为 unknown，不按名字猜测。buffer/queue 的各份内存都计量，不能另留无界 terminal.parts、全量 pending chunks 或隐藏 replay。

<a id="host-output"></a>
### S4.3 Host 输出合同

`host/session.ts` 提供 `getModelId`、`getExecutor`、`getExecutorWithoutResolvedModelTracking`；executor 提供 append/clear/getMessages/getState/stream。getter 为独立 Array，append 不执行函数，非法输入显式失败。原 ABI 需要的 `extendedUsage/providerMetadata/invocationId` promises 也必须存在。

`host/stream-codec.ts` 是唯一 Host reshape：text/reasoning、tool start/delta/complete、finish/response、camelCase usage 与 modelId 一致。删除内部 `toolCalls` 别名和多套 response normalizer；canonical events 不是 Host `StreamPart` 类型换名。保留已验证 Host wire 字段，不能为了“去兼容”删掉上游真正消费的字段。

工具按调用 id 关联，名字必须属于该 snapshot 的工具声明（Host 最终授权不变），不能缺失后补通用名；interleaving、冲突重复、坏 JSON/未知形状、serial-only 意外多工具有显式拒绝。只将验证通过的 executable calls 释放给 Host；重复 complete 不再释放。失败后可能已经释放过的内容如实记录，不能伪装零副作用。

slow/late/no reader 不阻塞 producer completion；超出有界缓存须明确 failure/gap，不能丢一部分然后成功。关闭一个 reader 只退订它；Host abort 才取消本次模型。真实 usage 缺失在 canonical/status 中为 unavailable；ABI 必须数字时只用声明过的 unknown 投影，不拿 1/1/2 或 cache=0 当真实账单。

## S5. Effect 根、控制与证据

<a id="effect-root"></a>
### S5.1 Lifetime

```text
grokbox process Scope / 唯一 ManagedRuntime（framework callbacks 需要时）
 ├─ owned modeld listener / accepted clients
 ├─ TURN scopes：binding/auth lease（不挂首 STEP scope）
 │    └─ STEP scopes：backend stream、验证、emit、deadline
 ├─ controller operation scopes：lease → preflight → guardian → signals/wait → commit/recovery
 └─ console HTTP / 观察订阅（later / T29-only；无 provider 请求的初始化；T20 不建）
```

资源有 allocation 时即配对 finalizer，成功返回前保证 ownership 注册；必须覆盖 `bind` 未完成时 interruption、listen 后后续步骤失败、late callback、stop 重入。不能 `tryPromise(bindUnixKernel)` 完成后才 addFinalizer，也不能全流程 uninterruptible。Node syscall 可以是窄 Promise adapter，业务程序不能藏回 Promise/timer 链。

停止先拒绝新 work，再结算/取消，最后释放 owned resources。不能移动/替换竞争 socket 来“恢复”它；底层 close 对 pathname 的实际影响必须在 Node20 disposable fixture 证明，无法证明安全就阻塞 A9，而非放宽所有权。取消结果不是 provider 已撤销的证明。释放失败记录安全 cleanup gap；禁止吞掉后声称完全释放。

`runtime modeld run`、`runtime start` 的 ensure 与 console 都使用同一 `modeld.runtime.ts`。已有服务是 borrowed，不拥有 stop 权；prepare 若本进程新建服务，CLI 打印 receipt 后保持 foreground root 至 signal，不悄悄 detach 出另一 daemon。browser 关页只退订，不结束 process/已确认 operation。

<a id="controller"></a>
### S5.2 一个 Controller operation program

T28 将现有 coordinator/adopt/identity 编排收进 `kernel/internal/commands/controller-operation.ts`，用 ControlResources 做 IO。入口都是同一程序：只读 preview；无授权 reconcile 只观察/写已允许意图；`runtime re-adopt --confirm` 或一次 console 确认才提供 mutation capability。未来自动 reconciliation 不获得本次隐式授权。

不可省略 lease → exact ownership/source/profile/compile/topology/gateway/launch 预检 → 首信号前复核 → independent guardian → 精确 signal/spawn/wait → attestation/journal read-back → receipt/recovery。保留 direct-launch 与 transient-adopt **两种真实 launch capability**，但只在同一个 operation state machine 中作有限策略选择，不维护两套 coordinator。无 LegacyWitness、optional unsafe defaults、第二 manual mutator 或旁路 heal。

guardian 仍是独立进程，只对精确 frozen wrapper 幂等 SIGCONT；不是随父进程死亡的 Fiber，不 kill/start/retry。禁止对官方/竞争进程兜底 SIGKILL。日志/签字 IO 失败不能伪造回滚；确认时的 target drift、PID reuse、Gateway 未发布均不能报告成功。

<a id="status-journal"></a>
### S5.3 T13 与 J13

T27 在 Phase 1 开始、无需等待真流/UI，就提供唯一 status DTO：`schemaVersion`、各项 source/observedAt/gap 与六个独立 facets：bridge/activation、modeld readiness、controller liveness、mutation permission/inhibit、operation recovery、Host delivery observation。移除旧 `watchdog.state=degraded` 聚合口径，而不是同时输出新旧解释；circuit 自身事实继续保留。

| 输入证据 | 必须输出 | 不能推导 |
|---|---|---|
| 当前 attested、stored circuit open、无 pending | bridge 有证据 + mutation inhibited；liveness 无证据则 unknown | “全部 degraded”或清 circuit 后绿色 |
| journal pending/invalid/unavailable | recovery-required/unknown，指明来源 | 旧 attestation 覆盖恢复问题 |
| modeld health 成功 | modeld ready | Host 已签字、controller alive、provider 可付费 |
| model terminal / Host normalized terminal | 对应阶段的事实 | SendToUser 已执行/App 已显示 |
| 缺事件/截断/不支持旧记录 | missing/partial/gap | 没有发生过调用 |

J13 **不迁移**：Host 的 `terminal-journal.node.ts` 唯一写 Host normalization/rejection 事实；modeld 写自己的 invocation/provider 观察，controller 写控制观察；watchdog 是同一事件日志的唯一 compactor。共享纯格式/allowlist 不等于共享写权限。旧记录留在原数据根，不能删除历史来达成 single-track；不支持的历史 schema 报 gap，不猜补字段。

所有 STEP/inference 事件从本地已验证 tuple 关联 Host/agent/TURN/STEP/ServiceEpoch/binding/attempt；控制事件关联其 operation/target，不伪造 STEP。不从 provider body、最近时间戳或 UI cache 构造因果。Host append 可缺 service/binding 证据时明确 unknown，不造值。日志失败只影响证据，不阻塞 Host 回复或触发重跑。J13 的 Host-side IO 仍是已记录的有限例外，不能顺带在 Host 加 Effect。

## S6. 后续表面仍只有一个内核

<a id="webui"></a>
### S6.1 T29 内核/API 边界（默认主链外）

T29 **不是** T28 之后的默认下一张施工票，也不要求现在建浏览器控制台。Phase 1 出口停在 T28。内核必须预先暴露、且未来 UI 不得另写的边界：

- CLI 与未来 API 只调用同一 `commands` / `status`；不得出现第二套业务程序、admission 或 controller。
- `ConfigurationWrite` 是唯一配置写 port。单 writer 阶段不做通用 CAS；真实第二 writer 出现时按 S3.3 在同一入口加短锁 CAS，CLI 同时接入，禁止 UI-only lock / SQLite SoT。
- 命令边界绑定本盒 runtime root 与 agentId；拒绝任意 current Profile 拼接或远程 Profile。身份不明不保存。GET/只读观察零 write、零 signal、零模型 spend。
- `console/`、`console.runtime.ts`、roster bridge 与 browser 资产均为 **later / T29-only**；T20 不建空目录、假 API 或 Playwright。

产品三面板、cookie 会话、Playwright MVP 见 [plan Phase 2](box-runtime-plan.md) 与 [T29 deferred UI MVP](../tickets/T29-runtime-webui.md)。本规格只预置边界，不把它们当成近端骨架。

<a id="backends"></a>
### S6.2 T30/T31 backend

pi RPC、Cursor SDK 各自独立 qualification；在证明前只有票据/测试要求，没有假 adapter 文件。具体协议/package/版本、运行面与权限须源证据固定；不从名称猜 API。不能提供一次显式 snapshot 的 inference-only 能力就 blocked/deferred，不把完整 Agent 的最终 string 当 ModelBackend。

复用同一 ModelBackend/BackendAuth/STEP 程序。无隐藏 root/history/Memory、tools execution、auto-compact、retry/failover、仓库修改或后台 Agent loop。native session 是 backend 私有 scoped resource，不是 Host TURN；默认不跨 Bot/turn 复用有状态 session。通过共同事件/取消/auth/usage conformance 后才接有限配置选项。不可阻塞其它 backend 或 T32。

<a id="recovery-diagnostics"></a>
### S6.3 T32/T33 recovery / diagnostics

T32 仅在 typed 当前 attempt outcome + 合格 provider-specific 非冲突证据确认 context overflow，且原 attempt 已 terminal、**没有已释放 executable tools/用户可见内容**时请求 Host 自有 compact。attempt 结束不等于 Host STEP 已结束：先将失败保留在 kernel 内，不能先发 error bubble/STEP terminal 再恢复。

v4 在原 run-step 连接增加一个 server `compact-request`（原 tuple、一次性 recovery nonce、期限与可信目标预算）及 client `resume-step`（原 tuple/nonce、新 snapshot）。Host IPC client 将控制帧交给 `host/compact.ts` 的已批准 Host delegate，不投影成 assistant/tool event；delegate 使用 Host 选上下文，不能自己总结。server 只接受当前连接匹配、未消费且未过期的 nonce；拒绝其它追加请求/旧代/重复回复。重新验证原 binding/authority/snapshot 后同一 ledger 执行 attempt=1，最终才产生唯一 Host STEP terminal。v4 caller/profile/bridge digest 同票切换，旧 v3 拒绝，不留双版本。

compact seam 必须证明能在这个 Host 挂起点调用、不会与等待中的 Host loop 死锁；未知时拒绝，不编造 callback 能力。auth/429/generic 400/500/HTTP too-large/timeout/unknown、取消、无改善、二次失败均停止，零额外 compact/retry。候选日志不是命令；无匹配字段时拒绝，不能从 body 捞 id。T32 不等待所有 T30/T31 或完整 UI。 **Wait-point / first-request overflow live close is [T35](../tickets/T35-host-compact-wait-point.md)** (owner-gated). Composer `currentActivity` App residual is [T36](../tickets/T36-composer-working-activity.md), not a T32 substitute.

T33 扩充只读 source-scoped retention/cursor/gap、operation/交付观察。只有可核对来源/代/序列的 Host 能力才提供 publish watermark；否则 not_observed。缺记录、模型 finish、Gateway PID 不成为 App delivery 证明，不驱动 SendToUser/model replay、re-adopt 或游标写入。

<a id="delete"></a>
## S7. POC 退场清单

以下源路径均相对 `packages/box-runtime/src/`。只保留经过断言证明的性质；不是把整文件包一层、重命名为 service 后宣布完成。旧文件及根 `index.ts` 在 T20 撤销入口后不留 re-export；重建所需向量转移到新测试，历史 done 票据不改状态。

| POC 来源 | 目标 / 处置与截止票据 |
|---|---|
| `index.ts` | **删除** mega exports；CLI/test 改显式入口，T20 不留 alias |
| `modeld.ts`, `modeld-as1.ts`, `modeld-default.ts` | 旧执行器/complete-array/As1GeneratePort **不搬**；由 T23/T24 新 ports/program 替代。显式 echo 只重写成一个 ModelBackend；旧 accepts 扫描/composite/default factories 与 stub kernel 不保留 |
| `seam.ts`, `session.ts`, `replay-stream.ts`, `abort-signals.ts` | Host ABI/有界 reader 性质保留到 host/session 与 stream-codec；旧 StubRouteDriver、submit/stream/parts 三分支、response-only、40ms delay、requireStepId=false、toolCalls 别名、fixture usage **不搬**。T26 出口无内部 PromptSession shim |
| `envelope.ts` | 纯 ContextSnapshot 校验 → kernel contract；Host 私有字段 decode → host/context-codec；T21 丢弃静默解封/丢结果途径，不能保留第二 envelope SoT |
| `modeld-openai.ts`, `modeld-openai-map.ts` | T21/T23 转为 ccs-codec/openai-events/ai-sdk；raw messages 测试旁路、关键词 drop、preview 截断、SDK 错误正文、silent tool schema catch/continue **删除** |
| `models.ts` | 分到 kernel selection/config commands、io/configuration、host/selection.node；main fallback、misnamed stub-only guards、provider mapper 反向 import **删除**，T24 无第二 resolver |
| `modeld-binding.ts` | compile identity 合同 → kernel contract；Host 自身构造 → host；不把 HostBinding 与 RouteBinding 混为一物 |
| `modeld-ipc.ts`, `modeld-serve.ts` | T20 拆掉混合模块；T25 v3 wire/server、Host 独立 client。`callStubModeld`、v2 server、terminal.parts、晚注册 finalizer、竞争 socket 搬移还原逻辑 **不搬** |
| `modeld-credentials.ts`, `modeld-store.ts` | C1 no-follow/fingerprint 性质转到 credentials/authority/config adapters；逐 helper runPromise、默认 process.env/默认 live ports 混注 **不搬**，T23/T25 |
| `provider-overflow.ts` | backends/provider-error + T32 classifier；raw snippet、401 与 overflow 非互斥/只靠 message 匹配的恢复权威 **不搬** |
| `events.ts`, `observation.ts`, `observe.ts`, `coordinator-state.ts` | 纯 DTO/projector → kernel；Host append、普通 append、观察 IO 各归其位；旧聚合 status 与 body logger **不搬**，T27；深层 T33 |
| `coordinator.ts`, `runtime-start.ts`, `identity-op.ts`, `transient-adopt.ts` | T28 合成一个 commands/controller program；LegacyWitness、另一个 manual path、未注入 ports 就默认 live、Promise 编排包 Effect **不搬** |
| `watchdog.ts`, `inject.ts`, `live-inject.ts`, `identity`/`h3` 独立流程入口 | 旧 observeAndHeal/独立 inject/deactivate 执行器退场；真实策略/预检规则合到同一 controller，T28 不留旁路符号 |
| `h3-identity.ts`, `h3-live.ts`, `live-readopt.ts`, `official-chain.ts`, `launch-strategy.ts` | 纯 identity/topology/preflight 规则 → kernel commands；实际 Linux/launch/wait → process adapters；CLI/root 只装配，T28 |
| `process.ts`, `live-proc.ts`, `guardian.ts`, `guardian-process.ts`, `launch-env.ts` | 精确身份/信号、T12 allowlist、独立 guardian 性质保留到 contract/process adapters；Host 只复用 self-identity，不 import 全 census |
| `preload.ts`, `hook.ts`, `argv.ts`, `transform.ts`, `live-slices.ts` | preload entry 保留；精确 profile/compiler 与参数规则移到 host leaf，T20；额外 patch 非默认范围 |
| `reviewed-profile.ts`, `compile-receipt.ts`, `attestation.ts`, `op-lock.ts`, `runtime-artifact.ts` | 纯判断 → contract/commands；IO → profile/authority/artifacts adapters，T20 定位、T28 Effect 收口；J13 不迁 writer |
| `paths.ts`, `ephemeral.ts`, `local.ts`, `runtime-helpers.ts`, `errors.ts`, `hash.ts` | typed root config、local facade、kernel error/hash 归各 owner；无全局 path/env locator，禁止再造 utils 包 |
| `contracts.ts`, `host-bundles.ts` | 纯 provenance DTO → contract；只读/retention IO → provenance.node；不当作 Host 执行依赖，不删除现役/last-reviewed 证据 |
| `guardian-child.cjs`, `injector-hold.cjs`, `grokbox-temp-supervisor.cjs` | 移入 process/helpers，pack 输出名称保留；T22 移除默认 raw Host fd，T12 env 传递保留 |
| 旧测试、root `src/`、机器脚本 | 测试向量按新 owner 移植，不打包 Fake/旧入口；root `src/` WIP 和机器私有材料不吸收，不当实施依赖 |

**允许保留的不是 compat track**：上游 Host ABI 的必要字段、明确选择的 echo backend、Chat/Responses 两个真实协议、direct/transient 两种真实 launch 能力、以及用户现有 canonical 配置/证据。它们必须各自走唯一现役实现，不以 `legacy` 分支接旧 kernel。已知旧符号若出现在新代码，其含义/唯一 caller/截止票据必须逐个审查，不能靠改名逃过清单。

<a id="tickets"></a>
## S8. Phase 与票据顺序

所有 T20–T33 初始为 open；历史 T1–T12 等 done 保持 done。旧 open T13/T14b/T15/T16 只作产品范围索引，执行权转下表。票据中的依赖是真门禁，编号不是强制全序。

| Phase / 排期 | 新票据 | 真正依赖 / 完成边界 |
|---|---|---|
| 0 · 首切 | [T20 骨架切割](../tickets/T20-runtime-layout-cut.md) | 先锁树/exports/检查器，撤旧入口；只承诺结构，不承诺 runtime 可用 |
| 0 · 紧随 | [T21 双向 codec 输入保真](../tickets/T21-runtime-codec-fidelity.md) | T20；优先 A3fu/A7 的实际 SDK body，A6 不 gate |
| 0 · 独立 | [T22 raw fd](../tickets/T22-runtime-raw-output.md) | T20；可在 T21 后穿插，不阻塞 T21/内核工作；任何 live 前必须闭合 |
| 1 · 尽早 | [T27 最小 facets/J13](../tickets/T27-runtime-status-facets.md) | T20；主排期 T21 后立即做，不等待 T25/T26/UI |
| 1 · 内核 | [T23 ModelBackend DI](../tickets/T23-runtime-model-backend.md) | T20/T21；AI SDK + Fake/echo，一个 Effect port |
| 1 · 内核 | [T24 RouteBinding/STEP](../tickets/T24-runtime-route-binding.md) | T23；expected selection、TURN/STEP/epoch、auth 与拒绝证明 |
| 1 · 资源 | [T25 Effect root/A9/v3](../tickets/T25-runtime-effect-root.md) | T24；root acquire/interrupt/close 与生产 transport |
| 1 · 接通 | [T26 A8 Host fullStream](../tickets/T26-runtime-host-fullstream.md) | T21/T24/T25/T27；唯一端到端 producer/Host reshape，无推理占位 |
| 1 · 控制/整合 | [T28 Controller cut](../tickets/T28-runtime-controller-cut.md) | T25/T26/T27；同一 Effect control program/安全 IO，无控制占位；Phase 1 默认出口 |
| 2 · deferred | [T29 命令边界/CAS](../tickets/T29-runtime-webui.md) | T27/T28；共享 commands/status、第二 writer CAS、identity 绑定。浏览器 MVP 另标 deferred，不自动开工 |
| 3 | [T30 pi](../tickets/T30-runtime-pi-backend.md) / [T31 Cursor](../tickets/T31-runtime-cursor-backend.md) | T23–T26；不依赖 T29；彼此无依赖；资格不成立就阻塞本 adapter |
| 4 | [T32 confirmed compact](../tickets/T32-runtime-confirmed-compact.md) | T24/T25/T26；另需 Host seam/provider qualification；不依赖 T29/T30/T31 |
| 4 | [T35 HostCompact wait-point](../tickets/T35-host-compact-wait-point.md) | T32 seam；owner-gated；first-request overflow live |
| — | [T36 composer Working](../tickets/T36-composer-working-activity.md) | product residual；不替代 T32/T35 |
| 4 | [T33 深层诊断](../tickets/T33-runtime-diagnostics.md) | T27/T28；不依赖 compact、WebUI 或所有 backend，缺能力保留 not_observed |

默认主链：**T20 → T21 → T27 → T23 → T24 → T25 → T26 → T28**。T22 独立穿插。T29 与合格 backend、T32/T33 各自满足依赖后推进，**T28 后不默认施工 WebUI**；backend 受阻不堵住 T32/T33。每个写入车道一名 writer，跨 worktree 先后集成；规格不授权创建云端 agent、花费或改现役服务。

<a id="proof"></a>
## S9. 防呆证明与关闭规则

### S9.1 执行面

T20 增加一次性 `bun scripts/verify-runtime-rebuild.mjs <case>`，有限 case 映射下表列出的真实 `bun test <path>`/结构检查，不能根据票号打印 pass。不存在的文件/命令、跳过所有断言、未知 case 必须非零。公共 CI/test 自包含；不得依赖本机 inv-pi、私人 upstream 或 credential。

证明编排统一用已 pin 的 Bun `1.3.14` 跑 `bun install --frozen-lockfile`、`bun run typecheck`、受影响测试、`bun run build`、`bun run verify:package`。这不授权生产模块使用 Bun runtime API。本规格编写不运行 runtime suites；历史 typecheck 失败不是重建豁免。实现前记录基线诊断；触及文件不得新增/留下错误，Phase 1 整体出口必须 typecheck/build/package 通过。禁止缩小 tsconfig、删业务断言或一揽子 skip 取代修复。

| case / 必须断言的性质 | 目标 fixture/test 路径与依赖现实 | 必須能抓到的负对照 |
|---|---|---|
| `layout` | box-runtime/test/architecture + check-runtime-boundaries；真实源码/exports/esbuild graph | 虚拟 forbidden import、残留旧入口/flag、preload 贡献 SDK/Effect、生产模块 `bun:*` / Bun globals 时失败 |
| `codec` | host-codec、ccs-codec；两个自行编写 Host root/state profile + **真实 AI SDK 调用，mock fetch 截获 Chat/Responses HTTP body** | 去掉 user-contained result、长尾、root，或补 Human user/raw tool 后失败；不能用 mapper 自己生成 expected |
| `backend` | kernel/backend-contract + backend-conformance；同一 port 的 Fake/echo/SDK mock | 多消费 cold stream、工具 execute、SDK retry、缺名关联/secret 泄漏被抓住 |
| `binding` | selection/route-binding/step-ledger；Effect TestClock + barriers + counted ports | 选择捕获后换同 id endpoint/ref/opt-in；凭据/provider 次数必须 0；旧 TURN 重握后测试必须失败 |
| `lifecycle` | modeld-lifecycle；Fake allocation barriers + 真实 Node20 disposable Unix process | allocation 后 interrupt、listen 后失败/late completion 留 listener 或动到竞争 path 时失败 |
| `stream` | host-fullstream/runtime-pipeline；真实当前版本 Unix（T25 v3，T32 后 v4）+ 同一 Live graph 的 SDK mock + Host consumer | terminal barrier 未开前未收到首 chunk就失败；拿 final parts 冒充 true stream 不能通过 |
| `status` | status-facets/host-journal；同源/错代/缺失/损坏证据 + counted read/write ports | open circuit 被清、pending 被盖、GET 写入、finish 当 delivery 都失败 |
| `raw-output` | controller-io + helper fixture；受控 child fds / fake renewer env | 默认打开 raw file、stdout/stderr 泄漏 sentinel，或丢掉 T12 env 都失败 |
| `control` | kernel/controller + controller-io + runtime-cli；Fake process tree/文件 + 已隔离 disposable processes | PID reuse、target drift、失败收尾、parent death guardian、重复确认第二次 signal 被抓住 |
| `console`（later / T29-only） | 仅 T29 显式排期后：console-api + 共享 CAS/identity；浏览器路径属 deferred UI MVP | 第二业务程序、UI-only lock、错盒写入、GET effect；未排期时不得为通过本 case 铺空 console/ |
| `pi` / `cursor` | backend-conformance + 各自协议 fixtures，真实依赖另列 qualification | 工具执行、hidden context、跨 Bot state、取消后重跑/隐式请求不能通过 |
| `compact` | overflow-recovery/overflow-bridge；同一 kernel + fake Host compact + provider outcomes | 401+overflow、429、payload-too-large、EOF、候选日志、重复 completion 任一产生恢复即失败 |
| `diagnostics` | diagnostics + status-facets；retention/gap/source/epoch vectors | 错代拼 timeline、缺事件推出零调用、无 watermark 显示 delivered 即失败 |

表内缩写测试路径相对 S2 树的所属 `test/`；票据给完整命令。验证 runner 为每个 child command 输出 case、argv（无秘密）、exit code、断言/skip 数；最终 JSON 含 commit SHA、dependencyReality、supports、notProven、artifacts。不能只根据 exit 0 或测试数量推断语义完成。

### S9.2 必要端到端 vectors

- 一个工具调用 → Host 工具结果置于 `user.content` → **无新 Human turn** 的下一 STEP，双 SDK body 均保留 id/name/result/isError 与尾部。mixed text/result、同正文含控制词、长 args/results、空字符串/false/0、中文/UTF-8、超过 1500/8000 的边界均覆盖。
- root 在 state 内与 root 在独立字段的两个 profile：required root 恰好一次；未知/遗漏/错误 provenance 在 credential/provider 前拒绝。工具 schema 不能因为 catch/continue 消失；vision 声明/未知内容拒绝与安全预算不能偷变截断。
- binding：首次读/写竞态、不同 Bot、相同 modelId 改 endpoint/ref、credential 改变、长工具空档、expiry、restart、重复和 cancel-before-submit；不靠 sleep 证明顺序。
- fullStream：terminal 被 Deferred 阻住时首 token 已到 Host；early/late/no reader、关闭一个 reader、tool interleave、serial violation、malformed event、EOF、缺 usage、output budget、cancel 后 late event。Host fake 有唯一工具执行计数器及独立 transcript/UI reader，不能把三个 reader 当三个 tool executors。
- lifecycle/controller：每个 acquire 注入失败/interrupt，正常 release 条件下所有 owned 计数归零；另行注入 release 自身失败时验证 cleanup gap/非成功，不豁免普通泄漏。借用资源保持存活。真实进程 fixture 只能命中自己创建且身份锁定的 child，不扫描/信号现役 Host。

所有 offline fixture 在任何生产模块导入/Layer 构造前设置独立 HOME/roots、剥离真实 auth env、封锁外网/真实 credential，注入进程端口。HTTP mock 也需请求计数/URL allowlist；单纯给 SDK 一个 fake stream 不能证明实际 HTTP 编码。不能直接运行尚未隔离的旧全量 Host/guardian suites。

<a id="review-live"></a>
### S9.3 独立复审与 live 门

实现者提交可复现证据，不自签关键合同。**Astra/max 必须复审**：T20 树/退场/import graph；T21 实际 request oracle；T23–T26 selection/Scope/stream/取消 proof；T27/T28 权限与证据 writer；T29 仅在显式排期后审 CAS/identity（浏览器 MVP 另审）；T30/T31 qualification；T32 恢复预算；T33 claim ceiling。T22 可随下一次 core review 同审。复审绑定 exact SHA，修改关键路径后旧 review 失效；不把模型名字硬编码成构建依赖。

票据 Done = **本票范围**代码/退场完成 + required offline proofs + 上述独立复审，无本票占位/未知必需断言。只有 T20 明列的未建能力可作为结构交付的 notProven，不能据此关闭后续功能票；T26/T28 必须分别清零推理/控制占位。依赖事实不成立时标 blocked，不勉强实现。offline Done 不等于 live-qualified；每次 live 另需 owner 明确授权、当前身份/源 SHA/profile/bridge artifact 预检与成本/停止边界。

- **L1 core canary**：T22/T26/T28 offline gates 与 Astra review 后，获授权才采用 exact bundle/profile；只用 test0 `00000000-0000-4000-8000-000000000114`。验证真实首 chunk/Host terminal/一次工具续步/SendToUser 与官方 renewal；分别记录 observed 层级。test1 `00000000-0000-4000-8000-000000000113` 保持 unassigned，验证官方路径，不 opt-in。
- **L2 backend**：每个新 provider/backend 的真实协议/auth/流取消资格独立采集；SDK mock 和 L1 AI SDK 不能给 pi/Cursor 背书。
- **L3 compact**：只在经批准 Host compact seam 与 provider-specific confirmed overflow 证据可用时验证一次恢复；不能为了构造证据无预算地灌大 prompt/反复重试。
- **UI proof（T29 deferred MVP，非默认主链）**：仅在显式授权做 console 时才适用。实际浏览器覆盖登录、选择保存、旧 revision、reload/断线/重复确认与 safe rendering；Playwright Chromium 只作 pin 的 dev-only driver，由 Bun 测试驱动，不替换既有 runner。缺 browser 环境就阻塞此证明，不能 skip 后宣称通过；headless reducer/API pass 不能冒充 UI proof。默认离线 mock runtime，访问现役实例另需授权。T20–T28 不得为了本条铺 `console/`。

只把最小可公开 interoperability facts 与自行编写的 fixture 放进 repo。真实凭据、Host dumps、私人源码/完整对话及机器路径证据留在受控外部；公开票据只引用可复核 SHA/计数/结论和明确未证明项。
