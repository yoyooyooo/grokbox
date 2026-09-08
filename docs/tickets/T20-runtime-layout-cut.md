# T20 — Runtime skeleton / layout cut

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · Phase 0 首切。** 目标结构由[实施规格 S2](../roadmap/box-runtime-impl-spec.md#layout)锁定；不得另提平行目录。本文只授权切片范围，实施/部署仍由具体任务授权。

## Goal
建立一个 private runtime-kernel、薄 Host leaf 与 adapter/root 分工；撤销 POC 推理入口，不先写第二个新内核再等迁移。后续票据在同一目标树补齐能力。

## Module / dirs touched
- 新 `packages/runtime-kernel/package.json`、`src/contract.ts`、`src/hash.ts`、`src/selection.ts`、`src/ports.ts` 及所属 pure contract/selection 文件。
- `packages/box-runtime/package.json`、`src/runtime.ts`、`src/preload.ts`、规格 S2 的 host/io/process/roots 落点（**不含** later/T29-only 的 `console/` 与 `console.runtime.ts`）；按 S7 搬保留机制，移除旧推理执行链/根 index barrel。
- `packages/cli/package.json`、`packages/cli/src/commands/runtime.ts`/`program.ts`：只更新明确入口，不吸收基线外 WIP。
- `scripts/check-runtime-boundaries.mjs`、`scripts/verify-runtime-rebuild.mjs`、`scripts/pack-runtime-helpers.mjs`、`test/packaging.test.ts`、`packages/box-runtime/test/architecture.test.ts`。
- workspace manifest/lock/tsconfig 仅为新增 private package、同 pin 依赖和测试接线；历史测试向量按新 owner 路由。

## Depends-on
无。先核对 `pre-publication-revision` 与原 WIP；在隔离的干净实施基线上做切割，不 reset/clean 他人改动。

## Forbidden
- legacy/vNext/shared-utils 包、根 re-export shims、旧/新 kernel flag、保留 dead adapter 供后票“参考”。参考留 Git 历史。
- 把 old createModeld/as1/StubRouteDriver 包成新 Service；Fake/echo 作为未完成能力成功兜底。
- 在 Host import Effect/SDK/server、改 published 包/CLI 名、夹带依赖升级。
- 生产 Host/modeld/CLI runtime/runtime-kernel 使用 `bun:*` 或 Bun globals（`Bun.file`、`Bun.serve` 等）。
- 创建 `console/`、browser 资产、Playwright 或假 WebUI API。
- 为通过全量测试删除原行为义务、吞掉失败或批量 skip；不得抄入私人 Host 源码。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs layout` → 实际结构检查 + `bun test packages/box-runtime/test/architecture.test.ts`。checker 解析 import/re-export/require/dynamic import/exports；故意的跨层 edge、旧 alias、第二入口、生产模块 `bun:*` / Bun globals 在 virtual fixture 中必须非零。
2. 只有规格的 private packages/subpaths；old root files 按 S7 退场，无调用者能再进入 POC inference。保留机制实际移动而非转导；提交 changed/moved/removed→target 的逐文件清单，不能只给 tree 截图。退场 API 的旧测试提取 expected vectors/oracles 到新 owner fixtures 并绑定后续票据；未激活向量不算通过，不改成 expect(not_ready) 冒称原产品行为已验证。
3. 暂未完成的 inference/control 只在 composition boundary 返回 `runtime_not_ready`，零 credential/network/signals；记录 T26/T28 的占位移除截止，不宣称可 serving。未建能力不铺空目录/空 Service。
4. `bun run typecheck` 记录可重现基线与新诊断，触及范围必须无错误；不能改 exclude 隐藏错误。`bun run build`、`bun run verify:package` 验证新路径被真实打包、Node20 helpers 可载入、无 source-only 回退。
5. esbuild 实际 preload contribution/external imports + import-time traps 均无 Effect/SDK/全局 census/网络；虚拟污染负例必须被 gate 抓住。旧历史名称在 docs/negative fixtures 中不是清理目标。
6. 提交 exact SHA、命令/exit、assert/skip 数、源码映射、imports/pack 证据；**Astra 复审通过**。本票只关闭结构性质；旧功能未重新证明必须列 notProven。

## Non-goals / out-of-scope
A3fu 修复、provider enable、完整 inference/controller、WebUI/`console/`、live adopt、改现役配置/fd、root `src/` 清理、升 Bun/Node engines。新单轨未接通期间禁止部署。

## Related
[spec S1](../roadmap/box-runtime-impl-spec.md#scope) · [S3 ports](../roadmap/box-runtime-impl-spec.md#ports) · [S7 退场](../roadmap/box-runtime-impl-spec.md#delete) · [S9 证明/复审](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 0](../roadmap/box-runtime-plan.md) · [ADR D2](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d2--evidence-bounded-host-patch-surface)
