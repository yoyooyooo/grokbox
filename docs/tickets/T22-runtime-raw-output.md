# T22 — Remove default raw Host output sink (A6)

## Status
**Open · Phase 0 独立小修。** 不 gate T21/内核工作；任何 rebuilt live adoption 前必须完成。

## Goal
默认 child stdio 不捕获 Host 原始 stdout/stderr，不遗留 raw-output 启动依赖；保持 T12 official renewer allowlist/传递。

## Module / dirs touched
- `packages/box-runtime/src/internal/process/helpers/grokbox-temp-supervisor.cjs`。
- `packages/box-runtime/src/internal/process/launch.node.ts` 中对应固定 launch spec。
- `packages/box-runtime/test/controller-io.test.ts` 的 raw-output cases、`fixtures/`；pack 清单只在确有路径变化时更新。

## Depends-on
[T20](T20-runtime-layout-cut.md) 的 helper 唯一位置；不依赖 T21/T23–T28。

## Forbidden
默认打开 `/tmp/sand-host-adopt.err`、捕获 provider/Host 正文、用 opt-in 诊断框架替代关闭默认 fd、随手删除运行中旧 fd/遗留文件、丢 T12 env、复制整份 process.env。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs raw-output`，映射至 `bun test packages/box-runtime/test/controller-io.test.ts -t 'raw output'`。
2. disposable child 向 stdout/stderr 写合成 sentinel；默认 helper 不建立 raw sink、不把 sentinel 带进普通日志；验证配置/fd 行为，不只 grep 路径字符串。
3. allowlisted fake renewer 字段原样抵达 child，非 allowlisted/provider secret sentinel 不传播；值不写 snapshot/output。缺少必要 env 不能 silent green。
4. 故意恢复 raw fd 或去掉 renewer 字段时测试失败。构建后的 helper 也验证同样行为；无 re-adopt、零现役进程/文件操作。
5. exact SHA、命令/断言及 default-fd/allowlist 证据提交给下一次 **Astra core review**；注明旧进程/历史 raw file 未处理。

## Non-goals / out-of-scope
诊断产品、日志轮转系统、历史清理、provider/Host live 验证、controller 全重写。

## Related
[spec S7](../roadmap/box-runtime-impl-spec.md#delete) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 0](../roadmap/box-runtime-plan.md) · [ADR D4](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d4--fidelity-first-phase-0) · [T12 历史义务](T12-adopt-preserves-official-capabilities.md)
