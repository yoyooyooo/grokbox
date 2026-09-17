# 2026-09-17 — 本地上下文维护实现与离线收口

本报告保存这次固定源码审查/测试的证据，不维护后续现场进度。当前 live 采用、新输入旅程与重启缺口只在 [LIVE 索引](../tickets/LIVE-integration-validation.md#live-ctx-adoption)。没有把旧 W17 的 config2/wire7 运行回执当作新 CTX 能力证据。

## 1. 源码与范围

功能提交 `883e224` 实现 Pi 衍生 compact、本地窗口、config3、wire8、Host/modeld 受限维护协议、原生候选接受、命令与验证入口。`269f1e2` 修正 commit readback 的 source/root/material revision 一致性。后续 `358c057` 修复已完成迁移之后的下一次 schema 迁移，`f4b3a18` 把维护请求的凭据与生命周期重新接回唯一 TURN 事实。

这批代码位于 `feat/pi-context-reuse`；集成/部署不能仅按分支名推定。主合同为 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)，实现范围分别由 CTX-00–04 拥有。保留 published Node >=20.17.0，没有安装 Pi Agent 运行时、创建第二历史库或替换现有 AI SDK ModelBackend。

## 2. 已实现链路与复用决定

`context/vendor/pi-compaction/` 是唯一受控提取位置，来源为核对过的 Pi core 0.85.1；原文件哈希、保留函数、模板、明确差异、MIT 许可和升级流程保留在 `PROVENANCE.md`、`LICENSE` 及 THIRD_PARTY_NOTICES。公共包需 Node>=22.19.0、caller-owned request 未公开、默认 serializer 在请求回调前截去工具结果尾部，故选择保留纯算法/模板并适配材料与请求边界，而非伪造大 Models 服务、绕过 package exports 或暗升 Node。

生产的本地门使用 `unicode-envelope-v1` 完整输入估算及余量，不冒充 tokenizer 或 provider 实测 usage。Pi 的 usage 估算函数保留并由 golden 验证；实际安全门不依赖取得一次成功 usage。Pi 准备/切点给出候选，sourceRef/工具组闭包、完整材料分段、固定 system/最新输入/图片保留和最后预算验证归 grokbox。摘要生成仅通过既有 Effect/ModelBackend，native 外层只接收经过验证的结果，不产生第二次隐式摘要推理。

Host preflight 在主请求及大型 CCS/IPC 之前工作，modeld prepare/最终 egress 继续复核。原生摘要 facade 复用 native partition/carrier/archive/accept/checkpoint：先生成候选并停在接受边界，独立验证后才恢复原生写入。原始元数据及工具关联由 Host 保存；临时 Pi 投影不直接覆盖 root。

config.runtime.context 默认 auto、本地窗口128000、reserve16384、keepRecent20000，模型/Bot覆盖和 policy revision 与 selection revision 分离。普通 schema2 reader 不默默升级；显式迁移进入 schema3，models 保持本域原字节。`agents context` 纯读配置/历史维护回执与能力状态，`agents compact --operation-id … --confirm` 在已加载默认 Box session 的原生空闲动作上工作，不发送伪业务 prompt/STEP。旧普通功能环境 gate 已退场，故障注入仍独立关闭。

## 3. 这次审查发现并修复的问题

**连续迁移被旧回执永久阻挡（358c057）。** 旧代码在固定 `config-migration.json` 存在时一律拒绝新计划，即使上次已 retired；现役已完成 config1→2 的安装不能进入 config3。现在预览绑定前次 manifest 的精确指纹，只有 retired 才允许下一迁移；旧 manifest/备份在原 operation 目录保留，未完成迁移必须 recovery。测试覆盖完整升级、prepared/published 两个中断、新旧别名/模型原字节、前次指纹改变、归档冲突和 unfinished 拒绝。不是删除旧 manifest 后强行继续。

**维护绕过已有 TURN 的 auth/lifecycle（f4b3a18）。** 原维护路径只冻结模型/策略并重新 pin 当前 key，未与先前主请求或 preflight 的凭据指纹核对；缓存 context selection 也未拒绝已关闭/撤销的父 TURN。现在维护与主请求共享捕获的安全凭据指纹，首次主请求不能在 preflight 后暗换 key；已存在绑定的 policy/credential 也不能被新全局配置替换。真实 parent STEP 的取消/终态、TURN关闭/撤销和 scope 变化在同一 TURN 锁与持久事实内检查，scope改变写入原 TURN revoked，恢复到旧scope也不能复活。没有伪造 STEP 或新增 authority ledger。新增 kernel 反例及真实 SDK/Unix/本地 HTTP 旋转 key 对照证明零额外主请求、当前输入仍保留。

**LIVE 文档测试与当前表格布局不符。** 原测试要求旧分节导航链接，未验证新版每行的实际缺口/下一步。修为保持六个 modeld 稳定锚点、每行四个非空栏目、来源链接和合法验收状态；集成分支名字继续必须显式存在。没有删除 LIVE 唯一入口约束。

**E09 制品 pin 过期。** 在最终源码两次实际构建得到相同SHA后，更新exact preload pin，保留重新打包、旧错误正文反例和变异字节拒绝。最终全库再次执行该用例并通过，没有删除或跳过pin检查。具体指纹见下方最终收口。

## 4. 已执行证明及边界

工具链使用仓库锁定 Bun1.3.14；系统 Bun1.4.2 的第一次 verifier 调用被正确拒绝，没有计成测试成功。Node20 与 Node22 运行分开记录。

| 固定阶段 / 入口 | 实际结果 | 证明范围 |
|---|---|---|
| `269f1e2`，`verify-runtime-rebuild context-maintenance` | typecheck/build通过；35 tests / 189 assertions；另11 packed/wire tests / 99 assertions；import边界通过 | 合成Host能力、真实kernel/SDK/local HTTP/Unix；不证明现场加载或App |
| `269f1e2`，Node20.17实际PATH，maintenance/config packed | 4 tests / 74 assertions通过 | 十轮维护与退出owned进程后重读当前持久root；Node22/Bun未冒充Node20 |
| `269f1e2`，`GROKBOX_TEST_NATIVE_HOST=1 … context-native` | 1 test / 28 assertions通过 | 固定原生摘要/accept方法的隔离VM与全部slice唯一性；blob/状态外围仍为受控替身 |
| 初次全库回归 | 2229 pass、7 skip、2 fail，18273 assertions | 如实保留旧LIVE路由断言与E09 stale-pin失败；不是全库绿色 |
| 连续迁移修复，migration+context-policy | 22 tests / 140 assertions通过，typecheck通过 | 含五个连续迁移新增场景 |
| TURN fence修复，context-selection+route-binding+Host链 | 19 tests / 105 assertions通过，typecheck通过 | 冻结key/policy、终态/撤权、已有绑定、新主请求以及无额外effect |
| 新增真实key轮换对照，selection+Host链 | 8 tests / 51 assertions通过，typecheck通过 | Host preflight已提交后轮换key，首次主HTTP仍被拒绝，原新输入与一次checkpoint保持 |

### 最终组合收口

基于runtime固定提交 `f4b3a18`、本轮LIVE路由断言与E09 pin修正的组合工作树，最后再次运行下列验证；当时仅文档/该测试pin与路由修改尚未提交，verifier据实报告worktreeDirty=true。测试/锁文件/source的前后快照一致：`7af8ac115e98f2f5960742d2e8ceea59a6fcbd7c2110219b60dc01e1f1b28479`，688项。此指纹不包含已安装依赖，不能冒充依赖供应链认证。

| 最终实际入口 | 结果 |
|---|---|
| 全库 `bun test --only-failures --timeout 30000` | **2243 pass / 7 skip / 0 fail / 18397 assertions**，294文件，281.60秒；skip不算通过 |
| `context-maintenance` | typecheck/build通过；**42 tests / 225 assertions**，另**11 packed/wire tests / 99 assertions**，均0失败；import fence通过 |
| `context-policy` | typecheck通过；**49 tests / 292 assertions**，0失败，含连续迁移与TURN fencing新增反例 |
| 明确Node20.17 PATH的maintenance/config packed | **4 tests / 74 assertions**，0失败；含十轮压缩及新进程持久读回 |
| 显式固定native隔离 `context-native` | **1 test / 28 assertions**，0失败；notProven保留真实存储/现役/App/review |

最后 `build` 与 `pack-runtime-helpers` 重复得到同一preload SHA：`a498abd86e037f1b4db8081a070972c0e518864d24f64b9539ba593e60fc5964`；匹配更新后的E09 pin。CLI `dist/index.js` SHA：`6de5244d6e43cc860d063a2c93c29d0f9236cc1580da38a5d60adde70c056451`。后续源码/依赖/构建变化使这些指纹和相关证明需要重验。

所有失败注入使用合成身份/临时目录/loopback HTTP。没有把生产Bot历史复制到Git，没有拿真实上游超限作为自动compact的触发前提。测试结果不能跨后续源码变更自动继承；最终组合回归及pin已在上表记录；不能将初次两项失败隐藏成从未发生。

提交测试pin与文档后，干净候选 `804c99423a89908669dc87f75d2fdd6009c2497e` 再次执行完整 `context-maintenance`，`worktreeDirty=false`、42+11测试及typecheck/build/import fence全过，source指纹仍为上述 `7af8ac…28479`。执行 `git rebase feat/box-runtime-v2` 返回up-to-date，v2基线为 `6596a1572bc64516c93f0c9149931723a0a7db83`；没有借rebase隐含合回或切换live。此后的报告/索引回执为文档更改，不签新的运行代码。

## 5. 独立 review 与明确未证范围

三次限定只读的 `sub2api-codex/gpt-6-astra` / max review，分别针对 `269f1e2`、`f4b3a18` 与最终干净候选 `804c994`，均立即返回provider HTTP503，进程退出1，**没有审查报告或独立认可**。最后一次在全部源码/制品回归及rebase核对后尝试；仍无结果，停止重复请求，不将不可用通道说成review通过。本报告里的分析是实现者审查，不冒充独立review。该缺口留在CTX来源票，不改名为live-only，也不重复无限启动review花费。

原生隔离资格不等于现役已加载，更不等于全部native storage是事务：真实 archive/carrier/checkpoint与重启、App输入/活动/交付须单独取证。未知checkpoint不会说成已回滚。手动入口当前仅已加载默认Box session；named/server/subagent不自动映射。预先存在的同STEP自依赖摘要是有界拒绝，不盲等或抹Promise；可独立结束的pending通过原owner取消并等待。缺合资格的resource/self-document/preCompact-hook链时拒绝，不能用缺口扩大Host patch权力。图片当前完整保留，不宣称提供图片摘要模型。

[PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md)继续是独立非阻断传输研究，没有因为采用Pi算法就默认启用新Provider backend。源实现、公共/打包/原生隔离证明、独立review与现场采用分别记录；当前现场状态只看LIVE，不复制另一个发布进度表。
