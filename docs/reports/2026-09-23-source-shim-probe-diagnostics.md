# Source shim：限定加载目录并恢复调用语义

当前代码/测试候选：`48173996b0fb53d1ad7036220f0c81228877d617`，基于已交付的 V2 `f34a20f1`。以下是本轮实际修复与验证；后附诊断阶段仅作历史记录。

## 修复边界

原 Bun 源码启动在任意调用目录发现/加载模块时可在输出前停顿；单行脚本也能复现，故不能把项目业务模块当作必要原因。一次外部临时目录枚举约28.6秒、约66.7万个条目，但未取得系统调用跟踪，不宣称精确定位了 Bun 内部实现。

源码 shim 现在让 Bun 先在固定 checkout 完成静态模块加载，再由 source-cli.ts 恢复原调用者 cwd/argv，之后才创建 CLI 依赖、解析命令和打开用户文件。原 index.ts 的信号、EPIPE、退出收尾逻辑只移动到一个共同的 runCliEntry；打包Node入口和源码入口都使用它。未用版本stub或dist替换源码，未复制执行器/服务owner。

源码 shim 禁用自动 dotenv 发现，避免加载目录改为仓库后误带入其.env；shell导出的环境变量保持。该策略在README明确，不声称保留以前隐式读取调用目录.env的行为。相对文件、参数及配置根均在恢复后的调用上下文解析；不存在的调用目录拒绝，不回退仓库继续执行。

## 固定候选实际验证

使用声明Bun1.3.14。原安装例从10秒ETIMEDOUT变为正常通过，未加长probe时限。后置恢复cwd的独立版本/帮助探针约0.3–0.4秒；这是现场样本，不是性能SLA。

完整local-shim套件8/8：两个别名、幂等安装、拒绝无主命令、有限输出/超时诊断，以及真实相对--file/@file、带空格/引号的目录、错误PWD、环境导出与不隐式dotenv、失效cwd。对齐V2后8文件组合124pass、0fail，内部Server36、产品53、创建归属6，不重复累计。完整build、根/Web类型、docs、runtime boundaries、publication、diff和clean检查通过。

同一代码候选调用原verify-modeld-core state，恢复读取其原回执后确认exit0：5文件40pass、0fail/skip、status0、error/signal为空、settled=true。前后源码摘要均为631fe837c62eed4197934c7b299a3dc0ea6c822169226588871eab9d5660d65e（1319对象）。它补上了当前候选的原state/endurance验证，不替代整份release-offline或native/LIVE；以前整包失败没有删除。

全部执行日志与源码复核manifest在本功能树.scratch/ah170/source-loader/。只操作自有临时安装目录；未替换用户全局shim、未部署或切换现役服务。Git/Issue交付状态由Linear维护，本文不作为现场采用许可。

---

# Source-backed shim probe: bounded diagnostics

AH-170; baseline `078389fc7456131ec004021c9e28e421bc9d18d6`. This is a diagnostic checkpoint, not a startup reliability fix or merge approval.

## Observed

With declared Bun 1.3.14 and isolated HOME/configuration roots, the same TypeScript `--version` entry returned from the repository directory in 393/282 ms. An empty temporary cwd timed out at 10 seconds once and returned in 2857 ms on repetition; system tmp returned in 8118/3155 ms. These observations establish a cwd-correlated difference, not its underlying cause.

The original installer reproduces a 10-second `ETIMEDOUT`, SIGKILL, zero stdout and zero stderr. It is not a version mismatch. Further loader-variant diagnostics were not executed because the tool invocation was rejected. No loading workaround, alternate entry point, timeout extension, or real global shim change has been made.

## Delivered diagnostic change

The original probe still launches the installed alias against the real TypeScript entry and requires the exact package version. Its 10-second limit is unchanged. Failure includes only a fixed phase/alias/reason, exit status, signal, selected spawn error code, deadline and output byte counts. Raw stdout/stderr and environment values are not echoed; output collection is capped at 64 KiB.

Four synthetic-executable tests passed: nonzero exit, unexpected version, bounded-output overflow and timeout. The original three behavioral tests remain; the real install test still fails intermittently and has not been reclassified as an expected failure. Root typecheck, publication scan and diff checks passed for the diagnostic changes. Filtered diagnostic tests are not the full shim suite.

## Remaining

Determine the source startup root cause and fix the original loader/installer path without changing caller cwd semantics or substituting a version-only program. AH-170 remains In Progress; this checkpoint must not be merged as a completed reliability fix. Tests used owned temporary installation directories and did not modify services, credentials, Bots or the user's global commands.


## 启动层隔离对照（2026-09-23）

后续测试不再仅运行项目入口：空临时目录中的单行 `console.log` TypeScript 脚本（`bun run <绝对脚本>`）和独立 `--eval` 也出现10秒、零输出超时；即使为该临时目录创建自有最小package.json，tiny脚本仍超时。这把观察范围缩到项目业务代码之外，不能再单凭共享client依赖推定原因。

正确参数位置的 `bun run --cwd <仓库> <原TS入口> --version` 实际输出精确版本，312ms；同次普通临时cwd运行原入口9100ms。尚未采用强制cwd作为修复，因为它会改变相对路径、文件输入和命令工作目录语义。需要证明保留调用者cwd的完整入口，而不是只让版本探针返回。

首批全局参数置于run之前的变体不作为有效的修复排除证据；其中cwd变体退出0却输出11367字节帮助，而不是14字节版本，已排除该伪阳性。带进程采样的诊断及后续预加载工作目录对照调用被工具检查拦截，未执行；不声称有其结果，不据此签根因或启动可靠性。真正运行的表格留于 `.scratch/ah170/closeout/`，本次仅报告更新，安装器与CLI生产实现未变。
