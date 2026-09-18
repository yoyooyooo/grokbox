# 统一配置实施规格

**状态：配置 v2、统一写入程序、显式迁移、bootstrap、别名恢复及源码/打包 CLI 已实现；生产切换与平台 Reset 验收独立。** AH-99/AH-100 的实现范围由 [T57–T60](../tickets/README.md#configuration-rebuild)跟踪，实际使用见 [配置指南](../configuration.md)。本规格拥有配置文件、schema、作用域、提交与恢复；运维行为仍归 [Template Ops Spec](template-ops-automation-spec.md)。

<a id="decisions"></a>
## 后续 ops/storage 变更（2026-09-18接受，尚未实现）

本页保留T57–T60原配置重建的交付合同；当前源码schema3与CTX扩展见[配置指南](../configuration.md)。[T51](../tickets/T51-ops-capability-presets.md)将在下一不兼容配置版本新增顶级storage并显式退役旧ops.support意图，具体版本号实施时与最新v2统一分配。字段语义唯一归[Template Ops Spec §6.2](template-ops-automation-spec.md#configuration)，物理布局、CAS与迁移继续复用本页，不双读双写、不新增配置文件。

因此下文原v2/support形状仅代表该次已实现范围，不代表新的通知/存储能力已可用。旧off、预算和无关领域保留，迁移不创建binding/grant、不唤醒Bot、不自动公开；新命令/字段不能直接用于当前schema3。

## 1. 用户与程序边界

日常配置只有 `config.json` 和独立的 `models.json`。前者聚合 client Profiles、daemon、desktop、runtime desired 和 ops 偏好；后者保持现有模型目录、凭据引用与逐 Bot 分配。模型协议、Server 归属与同 TURN 选择不因普通配置变化而改变。

配置是意图，不是运行结果或授权收据。安装身份、credential verifier、floor、固定可执行路径、真实 Bot/Routine 绑定、维护/issue grant、Host attestation、运行记录不进入普通配置。共享物理目录不等于共享修改权限。

`config` 查询、校验、预览与 schema/path 发现不启动服务、不修文件、不发模型或 GitHub 请求。持久化成功、消费者采用、Host 加载、用户收到消息分别取证。

<a id="baseline"></a>
## 2. 实现基线与唯一入口

实现基于包含 modeld/ownership 当前改动的 v2 `f8c82c0`。模型文件迁移只验证、不规范化重写，包含 `chatDialect`、外部目录、凭据引用、alias 和容量等字段保持字节。构建必须使用 package.json 声明的 Bun 和 frozen lock；当前为 Bun 1.3.14 / Effect 4.0.0-beta.107。

配置纯合同在 `packages/runtime-kernel/src/config.ts`；所有人读配置写入通过 `runConfigChange` 与 `ConfigurationWrite.changeConfig`。Profile、desktop、operator、runtime desired 和 bootstrap 调相同 store，不能各自读旧快照再覆盖整份文件。模型领域继续使用其独立 ConfigurationWrite 能力。

旧文件只由显式 migrator 识别；正常读写仅认 v2。原生配置状态与 CLI 程序更新应在受控切换窗口一起安排，不能让旧服务重新生成已退役文件。

<a id="layout"></a>
## 3. 物理布局与读取

| 数据 | Client-only | 已安装 Box |
|---|---|---|
| 人读 config 入口 | `${configDir}/config.json` 普通文件 | 同路径的受管别名 → `${durableRoot}/config.json` |
| 人读 models 入口 | 不自动创建 | `${configDir}/models.json` → 原 `${durableRoot}/models.json` |
| 安装定位 | 无 Box locator | `${configDir}/state/layout.json`，固定 role/root/installationId |
| 安装安全状态 | 独立管理所需的客户端凭据 | `${durableRoot}/state/installation.json` |
| 配置操作与迁移 | 本地 root 的 state | durable root 的 state |
| 源档案、reviewed profile、model secrets、观察库 | 不伪造 Box 数据 | 原 durable 位置不变 |
| 短效 socket、live evidence | 既有运行目录 | 既有运行目录 |
| CLI 制品 | 安装目录 | 安装目录，不是配置根 |

默认 configDir 为 `~/.grokbox`，Box durableRoot 为 `/workspace/.grokbox/box-runtime`。客户端不能通过选择一个远程 Profile 就假装本机是 Box。显式 root 必须和安装 locator 一致，不能从 cwd、Payload、Bot 名字或网络地址猜出另一个根。

读取是同 owner、bounded regular-file、no-follow；最多 128KiB，UTF-8/严格 JSON、读前后文件身份与元数据相符。canonical 文件不能是 symlink。目录拓扑、别名缺失/替换/异根都会阻断对应正常操作。逻辑别名不参与 canonical 原子 rename；CLI 在实体所在目录发布。

`config path/schema/validate --file` 绕过普通 Profile 初始化，损坏或旧配置不能把恢复入口锁死。别名被编辑器替换时用 `config aliases`：固定 preview digest、保留脱离文件、恢复链接；不合并、不删除用户的新内容。恢复也不推断任何运行中服务已采用配置。

<a id="schema"></a>
## 4. v2 数据形状

```json
{
  "schemaVersion": 2,
  "client": {
    "currentProfile": "default",
    "profiles": { "default": { "transport": "auto" } }
  },
  "desktop": {
    "idleReclaim": { "enabled": false, "minIdleMs": 600000 },
    "keepAgentIds": []
  },
  "runtime": { "desiredMode": "disabled" },
  "ops": {
    "enabled": true,
    "preset": "user",
    "presetRevision": 1,
    "monitor": { "enabled": true, "deepReplay": false },
    "notifications": { "mode": "actionable-user", "maxAutomaticWakeupsPerDay": 2, "criticalReservePerDay": 1 },
    "diagnostics": { "mode": "on-request" },
    "maintenance": { "mode": "off" },
    "targets": { "default": { "enabled": true } },
    "routing": { "enabled": false, "defaultTarget": "default", "rules": [] }
  }
}
```

顶层只允许 `schemaVersion/client/daemon/desktop/runtime/ops`，前两项必需。缺文件只合成默认 client 读值，不落盘。字段实际存在就是显式覆盖，未出现的 ops 叶继承固定版本 preset；没有单独 overrides 层。

| 领域 | schema 与约束 |
|---|---|
| client | 嵌入命名 Profiles，camelCase transport/URL/socket/secret refs/sandbox/quota；currentProfile 必须指向存在的 Profile |
| daemon | network/serve/filesystem/process 的受限长期策略；credential verifier 单独安装，不接受任意 shell 或越界文件根 |
| desktop | idleReclaim.enabled/minIdleMs、keepAgentIds；idle 时限保持 600000–86400000ms，floor/pin 不可由普通 config 修改 |
| runtime | desiredMode disabled/observe/identity/route；保存后由控制程序独立检查执行条件 |
| ops | 预设、采样/通知/诊断/维护/support 偏好、target 偏好与有序路由；真实绑定和发布许可不在这里 |

使用一套 schema metadata 描述类型、边界、敏感字段、数组和路径能力。重复 decoded JSON key（含转义后同名）、危险原型名、未知字段、非法类型/枚举/引用和超限均拒绝。伪文件系统路径经过分段检查，`/./proc`、重复斜杠或 `..` 不可绕过路径政策。

`get` 默认脱敏，`export --portable` 去掉安装身份、秘密引用位置与部署绑定。导入偏好不创建 Bot、grant、维护计划或实际任务。带宽/成本/数据范围的检查比较完整生效前后值；unset 使关闭值恢复为开启默认值时也需要确认。

<a id="commands"></a>
## 5. 当前命令合同

```text
grokbox config get [path] [--effective] [--scope local|target]
grokbox config set <path> [json-value] [--string <literal>|--value-file <file>]
grokbox config unset <path>
grokbox config apply --file <file> --expect-revision <sha> --confirm
grokbox config validate [--file <file>]
grokbox config schema [path]
grokbox config path [--physical] [--document config|models]
grokbox config export --portable
grokbox config preset ops user|maintainer [--preview]
grokbox config migrate --preview|--apply|--status|--recover
grokbox config aliases --preview|--apply
grokbox config recover [--operation-id <id>]
grokbox config bootstrap --prepare|--from <file>|--recover
```

写入支持稳定 `--operation-id`、`--expect-revision`、`--preview`，以及有界 `--wait-applied --timeout-ms`。set 值必须显式选 JSON、string 或文件之一，不猜 yes/on/数字字符串。dotted path 与同一位置参数上的 RFC6901 JSON Pointer 共用路径解析；含点号 map key 用 `/client/profiles/work.v2/transport`。

数组只整项替换，含父对象替换内的数组；要求 `--replace`、期望 revision 和确认。单元素 keep 操作走领域命令并在锁内读最新值。unset 只移除可选显式值，不删除必需段；父对象和全文替换不能夹带 floor、secret verifier、授权或未知字段。

Profile 便利命令、desktop keep、operator 和 runtime desired 都调同一 writer。模型公开族为 `models list/check/use/reset/persist-key`；use/reset 明确二选一 `--for <agent>` 或 `--default`。后者只维护非路由默认，不 opt-in 任何 Bot。低级 Host profile 诊断仍保留原领域入口；告警/诊断/issue 执行面由运维票实现，配置 schema 接受偏好不代表已经交付执行程序。

### Scope

client.* 属于发起机器。Box 偏好需要当前有效安装；选中远端 Profile 时，写入必须显式选 local/target。当前目标端没有合格配置 capability 时，`--scope target` 返回 `config_scope_unavailable`，不会修改发起机器。普通本地 scalar 修改不要求无意义的重复确认，但扩大权限/成本、数组替换和整份替换有明确门禁。

<a id="writer"></a>
## 6. 提交、生效与故障

同一 root cooperative lease → 锁内重读 → revision/权限/schema 检查 → prepared 操作记录 → canonical 相邻临时文件 → 文件 fsync/rename/目录 fsync → 读回 → committed 回执。网络、消费者通知与等待不占文件提交锁。

通用 set 比较操作开始时的快照，领域 keep add/remove 在锁内基于最新集合处理。稳定操作 ID 和 fingerprint 防止重复或不同意图复用。prepared 记录只能在当前值等于已固定 after-state 时确认；否则返回 unknown，不重写。尤其 A→B→A 不能仅凭回到原哈希就重放历史写入。新意图需用户检查后创建新 operation。

消费者分别报告依赖版本：全文件 revision 用于 CAS；client、daemon、desktop、runtime、ops、target、support 使用本域摘要。desktop/client 的修改不失效其他 target 或已捕获模型选择。Host 继续只读原 models 快照，不能为了统一配置引入 server/ops/Effect 依赖。

| 保存事实 | 消费者事实 |
|---|---|
| committed / unchanged、operationId、configRevision | not-required / pending / applied / restart-required |

desktop 仅在实际采用快照后写带 PID/start 身份的应用收据；查询不代签。`--wait-applied` 等待 1–120000ms，超时为 `config_apply_pending` 并带真实保存结果，不回滚配置、不启动消费者、不重试控制信号。运行中无合格 ack 的其他领域保持 pending，daemon 启动策略变化保持 restart-required。

提交锁恢复只接受确证死亡的 PID/start owner，未知锁不按年龄删。别名恢复有独立计划和 prepared/repaired 回执，保留当前普通文件/错误链接。bootstrap 使用独立安装 lease，再调用配置提交程序，跨安全状态、配置和别名是可恢复分步操作，不声称整体原子事务。

当前进程权限模型是合作 writer 与明确本机操作，不宣称防御同 UID 任意 shell 的恶意篡改。输入/输出不回显 raw credential、env、payload 或安装令牌。

<a id="migration"></a>
## 7. 一次性迁移

迁移入口是唯一识别历史文件的地方：

| 来源 | 去向 |
|---|---|
| 全局 version/current_profile | schemaVersion2 / client.currentProfile |
| profiles/<name>/config.json | client.profiles.<name>，snake_case 显式映射 |
| daemon/config.json | daemon 策略、desktop.idleReclaim 与 keepAgentIds；安全字段转 installation state |
| state/desired.json | runtime.desiredMode |
| 实际存在的 ops 原型 | config.ops 偏好；原授权只保全并要求复核 |
| durable models.json | 保持全部原字节，验证但不规范化 |

preview 不写任何文件。plan digest 绑定来源、root/role、冲突选择与候选；apply 重查来源与相关进程。Linux 上读取有限进程/安装元数据来拒绝活动旧 writer，不持久化 argv/env。进程边界无法证明的平台或进程保持 blocked，不能伪造停写证明。

阶段是 prepared → publishing → published → activated → retired。每个源有受保护原字节备份。新旧数据冲突需明确 prefer 选择；别名中独立模型数据不静默合并。中断后按已发布事实前进，用户在期间修改 canonical/安全状态则拒绝覆盖。旧文件只在相应激活阶段完成后移到本操作退役位置；不删除用户数据或通过重启测试旧版本兼容。

bootstrap 生成新布局并保留既有模型字节，现有配置先显式迁移。bootstrap 的回退仅恢复本次 before/after 版本；后来用户编辑使回退受阻。原生 Host/模型服务不是这些命令的隐含副作用。生产中由 [LIVE-CONFIG-CUTOVER](../tickets/LIVE-integration-validation.md#live-config-cutover)安排实际 writer 停止、成套部署与读回；平台 Reset、home 重建和凭据存续单独观察，不从临时文件测试推导保证。

<a id="modules"></a>
## 8. 代码骨架与权限

```text
runtime-kernel/src/config.ts
  internal/config/{path,schema,revision,runtime}.ts
  internal/commands/config.ts
box-runtime/src/internal/io/
  config-layout.node.ts       # locator、installation、bounded IO、canonical publication
  config-lock.node.ts         # exact process owner、lease 与恢复
  config-store.node.ts        # 唯一 ConfigChange 实现
  config-application.node.ts  # 消费者 ack 的独立事实
  config-migrate.node.ts      # 历史数据显式迁移、分步恢复
  config-bootstrap.node.ts    # 安装资源 saga 与回退
  config-aliases.node.ts      # 保留 detached 文件的别名修复
  configuration.node.ts      # 模型与统一 runtime desired 读取
cli/src/
  config-registry.ts
  commands/config.ts
  config/profile.ts           # transport 适配与统一配置领域操作
  daemon/config.ts           # daemon 资源适配，不拥有第二配置文件
  daemon/desktop.ts          # 当前快照采用、领域写入与 ack
  bootstrap.ts               # 调同一安装/迁移程序
```

kernel 只拥有纯规则和 Effect 用例；Node IO 由真实 root 装配。Host 的薄 desired/模型解析保持无 Effect/SDK。Fake 替换 ports 而非复制业务。迁移/安装/修复的 lease、关闭与异常事实由当前 Effect root 拥有，不另建 daemon reconciler。

<a id="acceptance"></a>
## 后续已接受扩展：本地上下文维护

当前本Spec的config v2实现不包含runtime.context。[主运行时Spec S12](box-runtime-impl-spec.md#context-maintenance)与[CTX-01](../tickets/CTX-01-context-policy-and-meter.md)拥有目标config schema3的新增本地窗口/compaction偏好，扩展既有显式迁移、canonical writer、alias、安全范围和consumer application程序，不建立另一套配置底座。字段/默认/覆盖/预算公式只在S12定义，本页不复制。

models schema2、凭据与reasoning assignment仍由模型领域拥有；普通context配置不改它们。本Bot的解析策略按独立contextPolicyRevision捕获，当前TURN不热换；client/desktop/ops或其他Bot编辑不失效本Bot。未来Host只从有界modeld协议取得已捕获最小预算DTO，不导入config/ops reader、Effect或SDK；这是对前述Host只读models的窄能力扩展，不允许传递整份配置。配置升级不能冒充能力上线或现场迁移授权，旧v2不以忽略未知字段继续写schema3。

## 9. 可执行验证与余项

```bash
bun run typecheck
bun scripts/verify-runtime-rebuild.mjs config-unification
bun test test/models-command-surface.test.ts test/ownership-model-selection.test.ts
bun test test/packaging.test.ts
node scripts/check-publication.mjs
```

验收器同时检查源码稳定性与固定工具链，执行临时真实 FS/锁/死亡进程、迁移每阶段中断、配置/领域交叉写、别名恢复、配置与模型依赖隔离、真实 desktop 消费者、实际发布 Node CLI 以及 preload import fence。负例包括类型/重复 key/原型/路径绕过、错 root/远程 scope、arrays/父对象越权、关闭值 unset 后隐式收费、prepared 重放和 ABA。

源码/打包证明不替代生产迁移、Reset 或原生 webhook/model spend。远程 config 写 capability 与运维 workers 是明确未交付能力；不会注册空成功入口。T57–T59 的配置实现、T60 的配置集成验收与 T43–T56 的运维执行关闭分开，不能用一次配置绿灯关闭全部运维票。
