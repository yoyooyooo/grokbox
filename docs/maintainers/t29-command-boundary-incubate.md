# T29 command/API boundary incubate

**Not the default post-T28 chain. Not a browser MVP. Not a second SoT.** Owner allowed this parallel incubate; [T29](../tickets/T29-runtime-webui.md) still forbids treating it as the next construction ticket after T28. Console/browser/Playwright stay unauthorized here.

## Historical incubate inventory (not a fresh source check)

Current accepted boundary is [T29](../tickets/T29-runtime-webui.md); future page/interaction scope is [Web UI](../roadmap/future/webui-console.md). [T41](../tickets/T41-continuous-observation-and-alerting.md) now owns pre-browser observation/incident SQLite. It is not a configuration/revision/execute SoT and does not wait for a frontend. The old inventory below records its original inspection, not a new implementation claim.

| Surface | Exists | Honest gap |
|---|---|---|
| `kernel/commands` | Yes — controller + `runConfigurationSave` | CAS / second writer still absent |
| `kernel/status` | Yes — facets, correlation, journal roles | Future API must consume this, not a console projector |
| `ConfigurationWrite` **port** | Yes — `saveModels`/`saveDesired` → `{ configRevision }` | No live Layer; modeld graph correctly lacks this port |
| Config IO | `openRuntimeStore` atomic tmp+rename; `configurationReadLayer` | Returns `void`, no expected revision, no short lock |
| CLI runtime | `packages/cli/src/commands/runtime.ts` via runtime facade | Not yet a second writer; do not add UI-only lock |
| Box identity | Controller `boxRoot`; durable root resolver | Command-boundary agentId/runtime-root refuse-remote not a T29 CAS |
| `console/` / `console.runtime.ts` / `runtime-roster.ts` | **Absent** (required) | Do not scaffold for this incubate |

## 当前共享writer增量（2026-09-13，T24/T38）

旧表仅为历史。当前已有ConfigurationWrite Live Layer；Astra在实际多Bot CLI use/reset/persist-key发现两个协作调用可同时越过读前检查、整文件互相覆盖，因此真实第二writer压力已出现，不必等浏览器。最终model commit现用短独占锁→canonical reread/expected model revision→原子发布→读回；冲突拒绝，不自动merge/retry。Effect等待该有界commit和锁释放完成，不把取消当回滚。没有新增revision DB、UI-only writer或SQLite配置SoT；desired与models仍非跨文件事务，崩溃残锁不自动回收。

事实owner和验证归[T24](../tickets/T24-runtime-route-binding.md)/[readiness](t32-live-enable-readiness.md)，不是本incubate晋升浏览器。下面D6规则保留，但“CAS仍完全未实现”已不再是当前状态。

## D6 / CAS timing

[ADR D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer): keep the single-writer path simple. **Do not implement shared CAS until a real second writer exists.** When it does, add short lock → canonical reread → expected `configRevision` → mutate/publish **on the same ConfigurationWrite entry**, CLI included. No configuration revision DB, UI-only lock, or SQLite configuration/execution SoT. T41's incident acknowledgements and observation history have separate ownership/retention; they are not a second model-config writer.

This incubate did not add that CAS. The subsequent T24 cooperative-writer correction above supplies the earned model-commit boundary; atomic rename alone is still not concurrency-safe publication.

## Next (when actually scheduled)

1. Configuration use case on `kernel/commands` — landed (`runConfigurationSave` / `saveRuntimeModels`). No CAS.
2. CAS only with a real second writer.
3. Browser MVP only under a separate owner authorization.
