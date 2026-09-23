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
