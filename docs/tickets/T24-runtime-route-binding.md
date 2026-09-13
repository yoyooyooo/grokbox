# T24 — RouteBinding / selection fence / STEP program

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open closeout · Phase 1 implemented core / R2 delta active。** 唯一内核入口为 `@grokbox/runtime-kernel/inference`；A5 在 request-specific credential/provider effects 前关闭。已有 binding/STEP 代码不重做；实际正式关闭仍需本票 proof/review。

### 2026-09-12 R2 stable-delivery delta

[Spec S0 V01/V02](../roadmap/box-runtime-impl-spec.md#stable-delivery) 重申：普通模型配置保存只影响下一 TURN；已准入 TURN（含后续 STEP/恢复）不静默 re-pin，也不把期望配置变化自动视作权限撤销。credential/authority 真正撤销仍 fence。核对现有 `route-binding` 与 Host selection 的差额再改，不新建第二选择服务。

已选择 managed 的 Bot 遇本地桥/资格缺失必须明确 unavailable；旧 T11 预 dispatch `originalSession` fallback 是待清理的实现差额。未配置 Bot 保留 exact originalSession。需要 source/packed 各自覆盖已选择但 unavailable、未选择 official、两 Bot 不同模型与当前 TURN 修改下一 TURN 的负/正例；不因本文更新就称已实现。

### 本轮已收的具体差额

`host/session-hook.ts` 对**已捕获 managed Agent 但缺 TURN**的分支不再返回 `originalSession`，改为 `invalid_envelope` 的显式 Host 拒绝。专用原生 summary 没有 managed Agent 身份，继续从 earlier official 分支原样返回；不能混为一个例外。source hook 正/反例与 Host fullstream 回归已过。**15:56 UTC 批次进一步关闭两个隐式回官方分支**：route模式具名Agent的models.json缺失/损坏/不支持schema/超限/目录/symlink均抛固定`runtime_config_invalid`，标记可信本地失败并写有界拒绝原因；不能确认选择时不返回official。没有Agent身份的专用原生session及observe/identity不依赖该文件，合法配置中的未分配Bot仍exact originalSession。新的7个反例先红后绿。

`responses-continuation.test.ts` 真走 Host session/client、Unix/kernel、SDK mock Responses，验证同一 TURN 的 reasoning＋工具结果续聊及下一 TURN 窗口；无第二次 owned tool effect。它是日用合同的一段可执行证明，不替代真实 provider/完整 Memory/reload 或独立 review。生产目标及当前全局缺口见 Spec S0 / readiness。

### Host-only 官方/自定义往返差额（2026-09-12）

用户要求同Bot可随时选择官方或合格自定义模型，且只介入Host，不修改App。按Spec S0.1.1保持Server确认的Box归属和原生会话不变；所谓“回官方”是选择`originalSession`，不是Box→Temporal，也不是每次卸载bridge。配置生效点仍是下一TURN，旧TURN/工具恢复不重绑。

**当前工作树已有逐Bot route-mode reset。** CLI use/reset经`changeRuntimeModel`复用T37共享归属判定和唯一ConfigurationWrite；`--for`明确目标时可保存下一TURN的official选择，全局/default reset仍受保护。返回selectionSaved/currentTurn/effectiveUse，不把保存当立即生效；其它Bot覆盖不变。配置在Server读取期间变化会拒绝覆盖，但这不是T29多writer CAS。当前已将不可读route配置与明确official选择分开拒绝；它不是继续信任最后一次成功配置的隐藏缓存。

完整官方→A→B→官方→A的原生持久状态与真实旅程资格由新增[T39](T39-native-model-roundtrip.md)承接；本票交付可被它调用的选择机制和命令，不另记相同旅程的完成态。当前Responses三步mock和单独passthrough测试不证明回程已完成。

Server已temporal、本地/Server冲突或迁移未确认不属于已支持的模型切换。先使用原生Server读取合同确权，不把本地harness保护或App缓存判断当正式身份。读取/迁移协议研究由`private interoperability notes (not distributed)`保存，公开兼容性与入口差额见[harness](../maintainers/transcript-harness-box-vs-server.md)。完整卸载单独归rollback acceptance，不削弱本票普通模型选择义务。

### Server确权查询已落地（2026-09-12 11:55 UTC）

`agents ownership <targets...>` 已通过Host原生官方客户端实查Server并与本地读前/读后对照；test0/test1确认box，test2是Server temporal/本地box的冲突。四类ownership+独立desktop/migration证据维度由单一CLI projector提供，缺数据/错代/冲突不猜默认box。只读命令不是自动models use/send门，尚不关闭上面的逐Bot回官方和原生会话往返。

读取桥只扩展既有getHostStatus的显式namespaced参数，复用原认证、不导出凭据、不调用reconcile或迁移；普通getHostStatus无新增Server读取。定向与direct/daemon负例已过，最新全仓1069/0；实际证据/局限见[harness当前页](../maintainers/transcript-harness-box-vs-server.md#command-results-and-limits)。不主动借官方BOX→Temporal迁移开启自定义模型。

### 下一实施片：独立可逆选择（按职责拆分，均未关闭）

归属证据/时效/真实准入转由[T37](T37-server-ownership-admission.md)实现；资料更新/本地优先slice退场和test2校准由[T38](T38-identity-write-alignment.md)实现。本票消费同一个共享判定，保持RouteBinding/选择/STEP唯一程序，不能再复制归属规则。T37开发不等待本票的全部往返功能，避免循环依赖。

本票须完成：

- `models use/reset --for`在现有ConfigurationWrite入口执行预检→原子保存→读回；route模式单Botreset为下一TURN的明确official，不全局deactivate，不改harness或Server身份。模型错误/权限缺失/写失败不产生半份选择，不静默更换原已确认配置。
- 原子保存的“已设置选择”和真正“已准入TURN的捕获选择”分开投影；有活动TURN时下一选择可pending，不把用户点击结果展示成正在运行的模型。不能为UI另建current-model状态库；从canonical配置和已有binding事实派生。
- 明确首次捕获点及准入线性化点，官方和managed路径都不允许同一TURN中途漂移。受理前发现配置版本变更可拒绝重读，但受理后普通配置保存不撤销旧TURN；真正authority/credential撤销则沿原fence结算。
- 区分明确official、合法未opt-in、不可读/损坏配置；selected managed的证据失败不能decline为官方。保留普通未配置Bot和专用native summary原行为，不能扩大到全局停用。
- 两Bot并发选择与同Bot相邻设置保留其他配置，失败无隐式重试/重放；不为尚无第二writer的场景引入复杂revision DB，但现有合作并发路径须以canonical读写/预期revision证明无丢更新。

reset的逐Botsource实现与CLI/运行时回归已过；config读取decline、完整真实消费者和合作多writer仍有差额。T39签真实原生往返，T40签完整卸载，本票不通过调用这两种重操作实现普通选模。

### 未资格化 no-STEP 不再绕到官方（2026-09-12 15:56 UTC）

`overlayOfficialNoStepStreams`已收敛为`attachManagedAuxStreams`。已选managed session中没有STEP的普通调用，不能靠“没有ID”推断它属于专用摘要；现在由managed validator拒绝，官方executor计数为0。可信memory/episode purpose仍走既有独立aux，专用外部summary在无Agent的session入口保持official。原测试先暴露调用official后假成功，修复后通过；E07目的/工具/取消8项集成回归也过。没有通过删除辅助推理来缩小稳定范围。

这些机制已接现有`model-selection`验证入口，当前45/0；实际packed Host/client与原生消费者的证据等级见T37/readiness。T39真实官方模型回程、原生checkpoint新进程、App与完整Memory仍未关闭。

### 本轮选择纵切证明（2026-09-12）

`bun scripts/verify-runtime-rebuild.mjs model-selection` 已可运行，复用选择/绑定测试并新增 `model-switch-pipeline.test.ts`：真实配置用例→Host hook/client→Unix→production kernel→Chat/Responses SDK mock HTTP。官方fixture→A→B→官方fixture→A；A工具空档切B，A仍完成原TURN；B期间reset，旧B仍继续、下个TURN才返回exact originalSession。保留原生形状的state/metadata/tool关联，另一个Bot不变；owned JSON读回及modeld新lifetime后A继续。

明确上限：官方对象是独立fixture，未调用原生官方模型；JSON不是原生checkpoint，服务重启不是整个Host新进程恢复；真实工具/Memory/App与多writer CAS均未据此证明。完整`model-roundtrip` case尚未实现，不能用这个选择case替代T39。

## Goal
实现一次 admission/producer、TURN 不可变选择、STEP 去重和拒绝语义。旧 TURN 不能经 TTL、新 STEP 或重启偷偷重绑；不同 Bot 保存不误伤当前 binding。

## Module / dirs touched
- `packages/runtime-kernel/src/inference.ts`、`ports.ts`、`contract.ts`、`selection.ts`。
- `packages/runtime-kernel/src/internal/inference/{route-binding,step-ledger,step-program,stream-state}.ts`。
- `packages/box-runtime/src/internal/host/selection.node.ts`、`io/configuration.node.ts`、`io/authority.node.ts`；单独有界同步读与 Effect 读复用同一 pure parser。
- `packages/runtime-kernel/test/{selection,route-binding,step-ledger}.test.ts`；相关 Fake Layers。

## Depends-on
[T23](T23-runtime-model-backend.md)（传递依赖 T20/T21）。T25 wire/root 消费本票的真实程序，不能另实现一份 server admission。

## Forbidden
main fallback、Host projection 文件族、configRevision 冒充 selectionRevision、首 STEP 请求后才比 modelId、掉线重试、STEP 取消释放 TURN 后再选、旧 id LRU 驱逐重投、每 request 新 Runtime。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs binding` → `bun test packages/runtime-kernel/test/selection.test.ts packages/runtime-kernel/test/route-binding.test.ts packages/runtime-kernel/test/step-ledger.test.ts`。
2. Host selection 捕获后、server canonical read 前的 barrier 修改同 modelId endpoint/ref、删除 opt-in；拒绝且 auth/provider 计数均为 0。其它 Bot 变化不改当前 selectionRevision；无覆盖的 Host 路径保持 exact originalSession。
3. 明确首次选择接受的线性化点；之后普通配置保存只影响新 TURN，不要求跨文件原子事务。credential/authority 等等待后再验证相同 pin、activation、取消；拒绝后的迟到异步完成不能 dispatch。
4. 同 TURN 后续 STEP 使用 bindingId + 原 model/auth/ServiceEpoch；长工具空档、首 STEP abort、credential 改变、idle expiry、服务重启均保留旧身份或显式拒绝。缺 ack/token 不当作新 TURN，零静默 re-pin。
5. key 含 HostEpoch/agent/TURN/STEP；同时保留前一个 STEP 的迟到 cancel。相同 key 同输入只返回 duplicate metadata，改输入 conflict；缺/坏 STEP 拒绝，零旧工具 replay。
6. 同 TURN concurrent STEP 为 turn_busy；不同 TURN 可并发。1024 ledger 或注入小上限满额明确 capacity，旧 id 不被驱逐重跑。Fake TestClock/barrier 证明，不靠等待若干毫秒。
7. ModelBackend.prepare 在 auth 前零外部 effects；只有 admitted 程序消费一个 backend stream。terminal/unknown/拒绝迁移有 oracle，取消后 chunks/success 不回流。
8. `backend`/`codec`/`layout` 回归，移除旧 resolveAssignment/ModelPin lifetime/第二 ledger 的执行 caller；**Astra 审身份、竞态、负对照与单生产路径**。T25/T26 未接通前不宣称 Host end-to-end。
9. source与packed CLI direct/daemon均验单Botuse/reset：无全局deactivate、无profile/harness写入、其它Bot配置逐值保持；保存B期间A的工具续步/恢复仍为A，下一TURN才B，历史执行模型不改。
10. 损坏/不可读配置、目标不合格、save前后故障和并发更新：明确失败或pending，不假official、不覆盖其它Bot、不部分发布。预期来自独立配置/请求oracle而非被测applyUse的输出。
11. 状态读区分desired和captured；没有真实活动binding时不虚构actual。T37冲突门要能从Host实际入口捕获，CLI-only预检不能签关闭。
12. 给T39交付同原生context的选择夹具、明确版本和不变量，完整native/真实模型往返在T39关闭；不能为了关本票声称它已跑过。

## Non-goals / out-of-scope
WebUI CAS、复杂 revision store、无限历史退休、真实 provider、compact retry、部署或 re-adopt。

## Related
[spec contracts](../roadmap/box-runtime-impl-spec.md#contracts) · [binding](../roadmap/box-runtime-impl-spec.md#binding) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.1](../roadmap/box-runtime-plan.md) · [ADR D5](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d5--thin-host-visible-selection) / [D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer)
