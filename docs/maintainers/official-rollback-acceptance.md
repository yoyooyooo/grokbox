# Official Host rollback acceptance

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Current Home：完整返回未补丁 Host 的目标、操作边界与验收判据。** 当前已验/未验、阻断和下一步只看 [LIVE-MODELD-RESTART](../tickets/LIVE-integration-validation.md#live-modeld-restart)；旧 schema 退路另见 [REASONING-CUTOVER](../tickets/LIVE-integration-validation.md#live-reasoning-cutover)。 [T40](../tickets/T40-persistent-release-and-rollback.md)拥有生命周期/发布闭环，T28提供唯一控制程序；日常逐Bot官方选择归T24，原生会话往返归T39。本文不提供通用signal权限，不修改App/产品SQLite、Server归属或官方迁移hold。

## 1. 两种“回官方”，不是同一个操作

| 动作 | 应改变什么 | 不能顺带改变 |
|---|---|---|
| `models reset --for <bot>`的目标能力 | 该Bot下一TURN使用原生`originalSession`，bridge仍安装 | harness/Server身份/会话/其它Bot；不调用全局deactivate |
| 完整未补丁Host退出 | 所有批准补丁从实际运行代码退出，原生进程继续拥有同一持久状态 | 不重建Bot，不把旧会话换成另一执行者，不丢未知工具效果 |

当前候选已支持route模式下单Bot reset（T24），现役与原生往返仍需分别核验；显式reset即使在冲突/缺桥时也只能撤managed覆盖，`ownership:not_required_for_reset`不授予原生执行权；返回originalSession的单元测试不证明custom checkpoint可被纯原生代码恢复。现有`deactivate`意图回执也不等于未补丁代码已经运行。所有具体可执行入口以源码和T28/T40实现资格为准，不将旧POC操作步骤照搬到现场。

## 2. 完整退出的前置证据

确认候选/原生目标制品、Host身份/拓扑、实际已加载profile/preload、原生持久状态格式和当前受影响Bot范围。Server/local须由有效来源确权；已知冲突test2不是成功判据。当前Host启动会经原生全局身份同步，因此完全退出也可能对齐其本地binding；须先明确影响、保全并取得对应授权，不能承诺“没有显式reconcile就不会改身份”，更不能屏蔽原生同步保留冲突。

禁止先停进程再寻找恢复方案。先停止受影响的新managed准入，枚举已受理/在途/未知执行并按原生策略有界排空或隔离。已发生副作用不可假回滚，未知STEP不可给官方再执行一次。保全使用原生/一致性快照能力，不能把任意db文件复制当恢复证明。

必要的精确进程操作、guardian、lease与receipt复用T28；若缺合法执行入口或工具拒绝，只阻塞该操作/验收，不调用另一通道绕过。circuit或unknown operation不能手清以取得绿灯。只读status/ownership/outcome不含隐藏退出、repair、重发或迁移。

## 3. 退出后的验收（同一固定窗口）

1. **代码确实退出。** 实际运行进程、源/制品/加载合同证明是未补丁Host；desired=disabled、命令accepted或单纯PID变更不足。
2. **原生状态能继续。** 从custom阶段保存的原生checkpoint启动官方session，保留summary carrier、工具关联、Memory及正式transcript；实际工具与SendToUser成功，无重复效果。不从UI/Server显示窗口拼prompt补救。
3. **归属没有被偷换。** 官方模型不等于Temporal。提前准备不依赖已卸bridge的受支持原生身份/执行证据；bridge接口缺失保持unknown，不能当Server字段改变或成功回滚。如果没有可用读法，这项先不签。
4. **原版App真实继续。** 不改/重签/注入App、不清缓存作前置；真实输入到正确原生执行，结果在同一会话可见。正常关闭/重开只是韧性用例，不是“消除冲突”的万能步骤。
5. **状态语义正确。** T36验证current-session running/composing、具名activity、entry streaming和权限等待的区别；普通Working不以currentActivity非空为前提。结束/失败/断连的UI不能被旧代事件污染。
6. **其它对象与服务。** 未配置/合法temporal/其它Bot不受未经授权改变；凭据、官方renewal及必要持久目录仍有效，旧managed进程/重复socket不竞争writer。

以上各项必须记录同一版本、Bot/session/nonce/执行代与最终状态。模型stop、收到进度、空trays或一个绿色测试不能替代这六项。

## 4. 官方迁移与Host-only边界

原生协议在已应用升级窗口中包含Box→Temporal迁移pass；身份读取和执行fence必须尊重该变化。我们不主动用迁移完成普通模型切换，也不绕过迁移hold或永久压住Server写回。

若退出/升级期间确实发生官方迁移，如实记录为归属变化及支持范围变化，不能签为“同一Box路径无变化回滚”。Host补丁无法控制已绕过Host的App→Server主模型请求。仅重新领养、Cmd-Q或擦掉某一侧历史，都不是这个问题的证明。

Stock Host的roster可能省略box；这是wire兼容事实，不应要求卸载后仍有grokbox always-emit切片。Gateway缺字段不能自动当Server确认，App选源也不能只从Gateway推断。版本事实与最低互操作要求见[harness](transcript-harness-box-vs-server.md)。

## 5. 故障、停止与恢复

任何identity/源SHA/原生状态不匹配都停止后续危险操作。已经做过的操作按receipt/read-back对账，不重复signal或provider请求。停止或回到已验证配置只使用仍然合法的原生/控制路径，不能恢复Server temporal/local box冲突作为“旧版本回滚”。

T40 的现场退出是否完成、缺证、影响范围和下一责任统一登记在 [LIVE](../tickets/LIVE-integration-validation.md#live-modeld-restart)，固定运行细节留日期报告；日常回官方通过而完整退出失败时分别显示，不能把两者统一标可回滚。修复后重跑受影响门，不让其它无关测试数量抵消失败。

## 6. 历史收据与Current Homes

2026-09-11 L2曾观测attested Host always-emit（43 box/1 temporal/0 absent）；这不证明官方未补丁路径，也不是当前库存。历史`deactivate`/watchdog占位与L1b circuit状态不自动成为当前可执行指令。

- `PRIVATE_EVIDENCE`：历史切片与CLI参数证明。
- `PRIVATE_EVIDENCE`、`l2-profile-write-readopt-receipt.md`：历史profile/re-adopt和输出观察。
- `PRIVATE_EVIDENCE`：历史未关闭的控制边界。

这些私有收据仅为证据引用，不搬入公共依赖。研究源位置在私有grok-bot docs23–26；公开实现规则见[Spec S0](../roadmap/box-runtime-impl-spec.md#server-authority-rollout)、[T40](../tickets/T40-persistent-release-and-rollback.md)、[T39](../tickets/T39-native-model-roundtrip.md)、[Host/App投影](host-app-projections.md)。

## Freshness / 本轮结果

Host/App版本、加载制品、identity协议、controller入口、原生checkpoint格式或凭据生命周期变化时，在 LIVE 对受影响条目标明待重验并保留旧回执。本页只定义判据，不更新当前结果；历史文档治理时未运行的说明不能覆盖之后窗口的事实。
