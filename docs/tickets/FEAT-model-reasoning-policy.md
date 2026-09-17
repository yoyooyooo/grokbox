# FEAT — 同通道模型推理设置

Status: implementation and executable offline qualification complete; integrated into v2; independent review pending. Current live progress is maintained only in the linked LIVE rows.
Source branch: `feat/model-reasoning-policy`; initial v2 base `f8c82c0`, final rebase base `fa476b1`. Current integration receipt is below.
Authority: [Spec S11](../roadmap/box-runtime-impl-spec.md#model-reasoning-policy), [ADR](../decisions/2026-09-17-model-reasoning-policy.md). This ticket does not authorize runtime adoption, live model calls or publication.

## 现场验收路由

当前已验范围、未验项、阻断和下一步只看 [REASONING-CUTOVER](LIVE-integration-validation.md#live-reasoning-cutover)、[PROVIDER](LIVE-integration-validation.md#live-reasoning-provider) 与 [HOST-APP](LIVE-integration-validation.md#live-reasoning-host-app)。这些条目链接对应的日期报告；本票保留实现合同、离线/制品证明和独立 review，不另抄当前现场结果。下方原始实现/集成回执中的未部署等表述只描述其历史时点。

## 实现范围与出口

| 范围 | 实现与离线 oracle |
|---|---|
| 配置/命令 | schema v2 structured assignment；v1 只读归一化；显式 use/default/reset/migrate；未知字段及 unsupported effort 在写入和外部 I/O 前拒绝；CAS 复用 |
| 能力 | catalog 的明确 wire effort 白名单，unknown/unsupported 区分；Pi 只接受显式身份映射，不从 boolean/model name 推断 |
| TURN 身份 | policy/capability 纳入 selectionRevision；deep-frozen resolved record；冷恢复验证完整选择；同 STEP 不因改档重跑 |
| 请求编码 | 锁定 SDK 的 Grok Responses 丢档反例；SDK settings merge；实际 fetch 前 Chat/Responses 白名单编码、冲突拒绝、保留 wire model/并行/预算/工具 |
| 观测 | configured-next-turn 查询，requested/emitted 与 Provider unknown 分层；bounded SDK warnings；reasoningTokens 为可选 completion 子集；CLI/Host/daemon 标题 e 独立 |
| 协议 | wire v7；旧 v4/v5/v6 有限只读诊断，不能执行；原 Host prompt envelope/ownership/Effect owner 不变 |
| 隔离集成 | actual Host hook → Unix → production modeld → fake HTTP；磁盘 TURN high/high → cold high → new TURN xhigh；回执与重复请求计数验证 |

新增 executable suites：`reasoning-selection.test.ts`、`reasoning-backend.test.ts`、`reasoning-command.test.ts`、`reasoning-binding.test.ts`、`reasoning-unix.test.ts`、`reasoning-packed.test.ts`。测试只使用合成凭据、owned temporary roots 与可控 Provider，没有现役 Host/Bot 写入或真实模型消费。

## 非 live 关闭要求

下方已记录 pinned Bun 1.3.14 / 最低 Node 20.17.0 的类型、全库、打包及 Host import fence 复验。早期 Bun 1.4.2 定向绿色不作为 pinned release gate。代码作者自审不能代替项目所要求的独立复审；独立 reviewer receipt 当前 `not-recorded`，属于本票非 live blocker，不能改名塞进 LIVE。

## 需要真实环境的出口

只在 [LIVE-REASONING-CUTOVER](LIVE-integration-validation.md#live-reasoning-cutover)、[LIVE-REASONING-PROVIDER](LIVE-integration-validation.md#live-reasoning-provider)、[LIVE-REASONING-HOST-APP](LIVE-integration-validation.md#live-reasoning-host-app) 记录实时状态与回执。必须先映射到固定 v2 集成提交，再单独确认对象、预算、窗口及回退制品。没有经过资格验证的 Provider 回报时，执行档位保持 unknown；tokens/时延不是 xhigh 证明。

## 初始功能分支固定来源与验证回执（2026-09-17，历史）

- Implementation source: `1e9a76a5a8cac784dfba927626d78baa15403ca3`；source tree `144bfbc0f3bfddd9d60c6dafd70762dc4efe49b2`。
- Build sourceDigest: `017f3e00e8f49497a99ab338ad92605fadba8e82203477e28289afb4cf69a8a0`；packed preload SHA-256: `21c5d29adfdfd91ba9d542448890a42ab147e6696119f204eac9726ee002f0bb`。
- Toolchain: Bun `1.3.14`、Node `20.17.0`、esbuild `0.28.2`；AI `5.0.253`、OpenAI provider `2.0.125`、Effect `4.0.0-beta.107`。没有更改依赖 pin。

| 检查 | 回执与范围 |
|---|---|
| `bun install --frozen-lockfile` | passed，lock 无变更 |
| `bun run typecheck` / `bun run build` | passed；source-built preload pin 与源码构建一致 |
| `bun test` | **2087 pass / 6 skip / 0 fail**，270 个文件，17144 次 expect；包含源码、owned Unix/LevelDB、打包、边界反例及新增 31 个 reasoning 专项测试 |
| 独立 Node 打包验证 | `reasoning-packed.test.ts` 两项通过；在限定 PATH 下使用最低 Node 20.17.0 执行双 API SDK bundle 与真实 CLI migrate/show，无 Gateway/Provider 凭据 |
| modeld `release-offline` | **425 pass / 0 fail**，47 个文件；verifier 的 sourceCommit 与上述来源一致，stage=passed-offline |
| 显式 read-only native-source | **28 pass / 0 fail**，6 个文件、209 次 expect；包括常规全库默认跳过的全部 6 个原生源码 case |
| Publication/privacy | 工作树及当前来源可达历史扫描 0 findings；仅规范化本 feature 未发布提交的作者/提交者元数据，不修改全局 Git 身份或 v2 历史 |

全库回执绑定上述完全相同的 Git tree；提交匿名化只更改元数据，tree 与 build sourceDigest 未改变。source commit 级 modeld verifier 已在匿名化来源重跑并核对 sourceDigest，不能用源码绿色推断部署。既有少量测试会选择其固定的其他 Node 二进制；新增 reasoning-packed 明确使用本轮限定 PATH 的最低 Node，而非把所有旧测试统称为最低版本运行。

原生资格命令限定 `GROKBOX_TEST_NATIVE_HOST=1 bun test --timeout 30000` 的 `live-copy`、`host-harness-emit`、`native-auxiliary-noop`、`host-managed-turn-retry`、`host-compact`、`transform` 六个 suite；运行前确认已安装源码与既有 pin 相同。仅作受保护临时副本的变换/语法编译或隔离 VM 中的固定消费者测试，未运行完整 Host、未改原生文件或相关 PID、未调用真实模型，临时源码副本已清理。它不关闭 LIVE 的已加载制品/Provider/App 义务；verifier 的完整 native qualification 仍为 not-proven。

作者自审覆盖：所有 assignment 消费者与原子保存、能力 pre-I/O 拒绝、policy/revision 冷恢复与去重、SDK omission/conflict 的真实编码边界、reasoning usage 子集、诊断字段/数组访问器不执行、标题清除/保留、旧 wire 诊断与 Host import fence。没有另建执行器、静默降档、通道替换、所有权放宽或无界重试。独立 reviewer receipt 仍 `not-recorded`，非 live review gate 尚未签署；本票不宣称生产可发布。

## 当前 v2 集成回执（2026-09-17）

已按本轮指令变基到最新 v2 `fa476b1`，并由 `git merge --ff-only` 快进至 `e82d116`。原实现 `1e9a76a → ac73435`，原回执 `1108011 → 697fe0c`；新装 model v2、迁移 preview 身份及单一命令面交叉修复为 `0f2cd0a`。完整映射、制品摘要、运行命令、实际回执和边界见 [集成报告](../reports/2026-09-17-reasoning-v2-integration.md)。

本轮组合代码全库 2190 pass / 6 默认原生 skip / 0 fail，modeld release-offline 516/0；六个默认跳过的原生源码 case 随独立只读 lane 28/0 覆盖。随后在已合入的 v2 工作区复验配置专项 205/0、reasoning 与制品专项 37/0，sourceDigest 为 `82aaf3e43024f82e8d382734315e6208db5eb956d4d522e89d3b93c310f16750`。这些是不同、部分重叠的证明范围，不合并为独立测试总数。

独立 reviewer receipt 仍未记录；LIVE 三条已映射到 v2 但均 blocked，不是未实现代码的转移。公开工作树扫描无命中；最新 v2 基线已有的 16 条提交邮箱元数据命中在六个旧提交上，本次未增加也未擅自改写，历史发布门禁不能沿用上方旧基线的 0 findings 回执。没有 push、线上配置迁移、服务重启、现场 Bot 写入或真实模型消费。
