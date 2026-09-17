# AH-99 / AH-100 — 统一配置实现与验收收口

日期：2026-09-17。实现提交：`dbc43f53c30fc80484c63a3fd95b19f6bb2a0cb3`，分支 `feat/template-ops-automation`，基线为 v2 `f8c82c0`。本报告记录配置工程交付，不代表生产迁移、独立代码复审或其余 ops 执行功能已完成。

## AH-99：一个配置根，两份人读文档

已交付 config v2：client Profiles、daemon 策略、desktop 偏好、runtime desired 和 ops 偏好使用同一 canonical config.json。Box 上 canonical 位于既有 durable root，人读入口为受管的 home config/models 别名；普通客户端配置仍只属于该客户端。models.json 物理位置、完整原字节、模型字段和现有 secret refs 保持；不把模型配置塞进 ops，不整体搬迁 host-bundles/reviewed/secrets/observations。

旧的全局 v1/Profile 文件树、daemon config 和 desired.json 只由显式 migrator 读取。正常消费者不双读或双写。bootstrap 新装使用同一 canonical writer；迁移要求旧 writer 停写证据、源摘要复核和冲突选择，包含分阶段恢复。别名被编辑器替换时先报告，显式修复保全 detached 字节而不覆盖模型文件。bootstrap 回退不能覆盖后来用户修改，prepared/A→B→A 的未知操作不得重新发布。

floor、daemon verifier、实际绑定/授权是受限机器状态，不是普通 set 可以编辑的配置。安装、运行、授权与用户意图分离。当前操作地图为 `docs/configuration.md`，按需 Agent 入口为 `skills/grokbox/config.md`。

## AH-100：统一命令与唯一写入程序

已交付 `config get/set/unset/schema/validate/apply/preset/export/path/migrate/recover/aliases`，以及安装流程使用的 bootstrap 入口。嵌套路径支持 dotted path 和 JSON Pointer；值为严格 JSON，字符串可用 --string，较大值使用文件输入。未知字段、重复 JSON key、非法类型/范围、保留路径与 protected 状态拒绝，失败不发布候选字节。

通用写入、Profile 操作、desktop keep/operator、bootstrap 和 runtime desired 共用 ConfigurationWrite/ConfigChange 的锁、期望 revision、完整候选校验和原子发布/读回。数组整项替换要求 --replace、确认和期望版本；领域 keep add/remove 在锁内处理最新值，并继续遵守安装 floor。父对象或根替换也不能绕过 protected 字段和作用域。

配置保存与消费者应用分别报告。desktop 应用证据绑定真实 PID/start 和本域摘要；--wait-applied 等待已有消费者，不启动服务或偷做 Host 切换。提交成功但未应用返回 pending/restart-required 的真实状态。client/desktop 的无关变更不失效 Host 模型捕获、另一 target 或 support 策略。

models 独立使用顶级 list/check/use/reset/persist-key；--for 与 --default 明确互斥，默认项不能 opt-in 其他 Bot。已删除重复 runtime models 注册。远端配置写 capability 尚未提供，显式返回 unavailable，绝不落到错误机器。

## 实际验证

固定工具链：Bun **1.3.14**，Node **22.22.0**。`bun install --frozen-lockfile` 无改动。

| 验证入口 | 实际结果 / 范围 |
|---|---|
| `bun scripts/verify-runtime-rebuild.mjs config-unification` | **通过**；typecheck、build、200 tests、Host import fence，源码摘要前后相同 |
| `bun test`（通过 all 验收器执行） | **2118 pass / 6 skip / 0 fail**，275 文件，17385 assertions |
| `bun scripts/verify-runtime-rebuild.mjs all` | **未放行**：其严格策略不接受上述 6 个 opt-in native source tests 被跳过；未删除或放宽该门 |
| `bun test test/packaging.test.ts packages/box-runtime/test/context-continuity-artifact.test.ts test/config-packed.test.ts` | **15 pass / 0 fail**；真实 tarball 安装、Node CLI、模型原字节、别名恢复和 E09 制品指纹 |
| `bun test test/ah97-followups.test.ts test/skills.test.ts test/models-command-surface.test.ts` | **34 pass / 0 fail**；恢复有效 packaged Node 说明，并删除 core Skill 的过时 stub-only 口径 |
| `node scripts/check-publication.mjs`、`git diff --check` | 无隐私发现、无空白错误 |

配置专项固定源码摘要：`a8e208f000c75cabe5d29a10f4c73d2eb61dbe2783011615ac68aa4245fbed1b`。分组之间有重叠，不相加为独立测试总量。没有对 Node20 或真实 Reset 作未执行的成功声明。

## 关闭与剩余门

AH-99/AH-100 的配置实现、迁移工具、命令和离线/制品验收可以按本报告关闭；这不等于生产已经切换。实际迁移、旧进程退出、当前 shim/消费者采用、平台 Reset/home 重建与 credential 存续保留在 `docs/tickets/LIVE-integration-validation.md` 的 LIVE-CONFIG-CUTOVER。条目仍 awaiting-integration，不因登记而得到 live 权限。

独立代码复审未取得，继续作为 T60 的非 live 发布门，不塞进 live backlog 或冒充已通过。当前可用工具没有 herdr 独立 reviewer 通道；本轮进行了源码人工复核和可执行回归，但不将其称为独立复审。

T43–T56 的原生 Routine/Webhook、实际多 Bot 配对/通知 worker、诊断、Host 自动维护、GitHub issue 发布仍由其来源票拥有。config.ops 能保存严格偏好，不是这些执行能力已经完成。没有为追求总票数 Done 添加占位成功接口。

本次未修改现役 shim、未迁移生产配置、未重启 Host/modeld、未发真实模型或 Webhook 请求、未发布 npm 或模板；只按用户指令更新 AH-99/AH-100 的实施评论与状态。
