# Box-runtime Effect 标准

适用于 `packages/runtime-kernel`、`packages/box-runtime` 及 CLI/未来 UI 的 runtime composition roots。Effect 必须拥有重副作用的执行、失败、取消、并发和资源寿命，而不是给一个既有 Promise 工作流换返回类型。纯判定仍可用普通 TypeScript。

## 依赖与执行边界

版本唯一来源是根 [package.json](../package.json) 的 `effect-v4-beta` named catalog 和 [bun.lock](../bun.lock)。workspace 引用 catalog，不并存 v3、不使用浮动 tag。升级必须显式修改依赖和锁并重新验证；旧 E0 阶段“不安装 SDK”等施工限制不再是当前架构规则。

Node 是生产目标，Bun 是开发工具。kernel、Host、modeld、CLI runtime 不导入 `bun:*` 或 Bun globals。Host/preload 保持 Effect-free、SDK-free、SQLite-free；以实际 bundle contribution、外部 import 和 import-time side effects 验证，不只看直接 import 或被 tree-shake 的输入。

| 面 | 必须保持的所有权 |
| --- | --- |
| modeld 服务 | 一次 acquisition，owned/borrowed 明确；listener、已接受 socket、credential 和 driver 随实际 owner 关闭 |
| STEP / context | 唯一业务程序；共享 source 与 waiter 寿命分开，有界 deadline/cancellation，终态不会复活 |
| controller | 同一 operation 组合 lock/lease、guardian、精确身份核对、signals、等待、提交、读回与恢复 |
| config/store/观测维护 | adapter 管 syscall，Effect 管组合、错误和寿命；事务/持久协议由对应 store owner 明确实现 |
| 普通 TS | hash/parser/codec、identity/policy 判定、纯投影、必要同步 Host bootstrap 和有界 IPC leaf |

底层 Node syscall/Promise adapter 可以存在，但不得在 Effect 旁拥有第二套 retry、timer 或取消程序。不为纯函数创建 Service，不以 Service/runPromise 数量衡量采用质量。

## 一个程序与可替换能力

Fake/Live Layer 替换外部能力，不替换业务程序。CLI/API 调 kernel commands，Host IPC 调 kernel inference；ModelBackend 是唯一 provider port，SDK 只在 Box backend。SDK 不执行 tools/Agent loop，不写原生 Transcript/Memory/SendToUser，也不持有第二会话库。

每个实际进程/命令 owner 有一个执行根；宿主 callback 需要时复用有明确 dispose 的 ManagedRuntime。不要每 helper、Bot 或 request 自建 Runtime；Promise facade 只在宿主边界运行同一 Effect 程序。独立 guardian 不能被随父进程消失的 Fiber 替代。

## 事务、取消与未知结果

Scope 不是 SQLite/跨文件事务，interrupt 不是远端取消证明。claim-before-effect、commit/readback、unknown 和 crash recovery 按所属执行/存储合同实现。保留已发生的 side effect 与真实取消/信号回执；超时不自动 SIGKILL 未核验的官方/竞争进程，不重新握手重投旧 invocation。

避免全流程 uninterruptible、无限 finalizer、无界队列、脱离 owner 的 Fiber、SDK×Effect 双重 retry。清理失败必须可观察；失败/defect/interrupt/unknown 不能全部压成空成功。日志不输出原始 Cause/body、secret、prompt 或工具正文。

## Host journal（J13）

Host terminal journal 保留原 append owner，watchdog 的语义 compaction 与段维护不创造第二事件 writer。字节轮转、关闭段保留与日志锁恢复使用同一协议；GET 不恢复锁、不删文件。Host 可以使用纯 storage 策略/version leaf 和有界文件桥，不因此导入 Effect/SQLite/网络。

配置采用、分段发布、owner-token/进程身份恢复和物理占用分别取证。证据损坏影响可观察性，不改变模型回复或工具循环。journal-via-modeld、另加 terminal-report IPC 或迁移 writer 不是本标准的默认授权；需要明确的接口/寿命/故障合同变更。[存储合同](runtime/operations.md#storage)和其源码/报告保存具体证明边界。

## 修改与验证

从实际失败/资源 owner 开始，修改生产入口及其负例，不另写测试专用 admission。使用 pinned Effect API 的 TestClock/barrier 验证预算、并发和取消；覆盖 success/failure/interruption、partial acquire 和有界 shutdown。真实 CLI/Unix composition、Node packed、Host import fence 与硬崩恢复有不同证明，不以一层 fake 概括全部。

工具版本来自 package/lock。按影响运行 typecheck、目标测试、build/pack；遇到已证失败继续修复并复验受影响范围，不因一次绿就忽略后续改动。独立 review、native/live 和发布按 [验收入口](tickets/LIVE-integration-validation.md)及来源票分别处理，不能假称工具超时完成了 review。

[执行合同](runtime/execution.md)拥有 service/source/waiter/STEP 细节；[架构](architecture.md)拥有模块边界。本页不保存旧 E 接缝阶段进度或特定模型的审查循环。Effect 版本、Host 可达依赖、wire、journal writer 或资源 owner 变化时同步复核。
