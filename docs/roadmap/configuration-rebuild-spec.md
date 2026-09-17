# 统一配置与命令面重建实施规格

**2026-09-17 · AH-99/AH-100 与运维专项的破坏式重建施工建议；仅 Spec，T57–T60 未实现、未迁移、未部署。** 本文唯一拥有配置根、文档形状、读写程序、命令作用域、迁移与旧入口退役。运维业务规则仍归 [Template Ops Spec](template-ops-automation-spec.md)，总运行时/Host/controller 归 [主 Spec](box-runtime-impl-spec.md)。[决策](../decisions/2026-09-17-unified-configuration-rebuild.md) · [Tickets](../tickets/README.md#configuration-rebuild)。

## 1. 为何合并，而不是照两张旧票各加一层

AH-99 的已确认目标是「日常两份人读配置，models 独立，长期意图聚合，短效不混入」。AH-100 是「路径化读写、同一 schema、坏值不改文件」。2026-09-16 两票冻结评论仍处等待确认状态，主要提出 desktop 迁入 v2 global、models 保持 durable 实体而在 home 建别名、一次性 migrate、floor 只读、config 不管模型。本轮读取时两票仍 Triage；没有修改其描述/评论/状态，不将冻结评论当已实施证据。

保留这些安全边界，但**不采纳把 `{version,current_profile,desktop}` 当最终形状、只做 desktop 白名单包装、长期旧路读取或另写 ops-policy.json**。否则 Profile 本体、daemon 其余长期策略、runtime desired、ops 仍有多套人读入口。也不采纳「新文件存在就自动胜出」「rename 就保证无丢更新」「持久化后 RPC 失败等于没有保存」。

调查基线：运维分支 `ae37351`，v2 `36e6dc5`。关键文件为 `cli/config/profile.ts`、`cli/daemon/config.ts`、`cli/daemon/desktop.ts`、`cli/bootstrap.ts`、`cli/commands/operator.ts`、`box-runtime/internal/io/configuration.node.ts`、`configuration-write.node.ts`、`host/selection.node.ts`。Profile/global、daemon 与 runtime 分别有 writer；只有 models 当前已有 cooperative lock/optional revision/readback，desired 未共用相同 CAS；desktop 还有进程内 keep/prune 副本。bootstrap 直接种子旧 daemon 文件。新增通用 writer 必须替换所有相关旧 writer，不只新命令走新路径。

v2 比运维分支新增模型 `chatDialect`；实现前对齐最新 v2 模型 schema/tests，不能用旧 parser 重写并丢弃新字段。破坏重建不授权迁移时丢模型、凭据、用户设置或运行证据。

<a id="decisions"></a>
## 2. 收口决定与非目标

1. 对外只有 `~/.grokbox/config.json` 与 `~/.grokbox/models.json` 两份日常意图文档；统一配置命令 `grokbox config …`，模型仍 `grokbox models …`，运维业务入口收成 `grokbox ops …`。
2. `config.json` 聚合 client Profiles、daemon 策略、desktop 意图、runtime desired 与 ops 偏好。`models.json` 继续独立且独立版本演进；本轮保留 v2 最新 models v1 的含义和字段，**不借统一配置重造 provider/model/selection schema**。
3. Box 的配置实体持久化在既有 durable root；模型实体、secrets、reviewed/host-bundles/contracts/observations 不搬。home 是稳定入口，不是重置持久性的证据。
4. preference、binding、grant、observation 不混写：实际配对收据、发布/维护授权与安装安全策略属于机器管理状态，不放进普通 config；配置只能请求能力，不能给自己签字。
5. 一个配置变更程序、一个文档级提交边界，domain 命令是适配入口而非独立 writer。saved、consumer-applied、Host-loaded 分开。
6. 一次显式可恢复迁移；新版正常读取只用新版根/shape，无长期双读/双写、旧 JSON 兼容 overlay 或第三个 ops 配置文件。

不改变 AH-101 的闲时策略与 minIdleMs 下限，不调整座位表/Server harness，不改原生 Routine schema、不引入新官方 updater。不移动 CLI 安装树，不为路径美观重写模型提供商字段、恢复旧 Host 或升级 Effect/Bun。

<a id="layout"></a>
## 3. 逻辑入口、物理根与运行角色

### 3.1 两份日常文档，不等于整个安装只有两个文件

| 角色/数据 | canonical 实体 | 可发现入口 / 限制 |
|---|---|---|
| Box config | `${durableRoot}/config.json`（新） | `${configDir}/config.json` 由安装器管理的文件别名 |
| Box models | `${durableRoot}/models.json`（实体不变） | `${configDir}/models.json` 别名 |
| client-only 配置 | `${configDir}/config.json` 普通文件 | 无 Box 证明不创建 workspace 树；不得靠目录存在自动判 Box |
| client-only models | 不自动创建/不管理远端模型 | `models` 当前仍 box-local；不制造本地假模型库 |
| 机器/证据 | 既有 durable `state/`、`secrets/`、`profiles/reviewed.json`、`host-bundles/`、`contracts/`、`observability/` | 不进入人读两文件；只能从 owner 命令读取/管理 |
| socket/临时加载收据 | 既有 run root | 短效，生命周期规则不变 |
| CLI 制品 | `~/.grokbox/runtime/` | 不是配置，也不是 durable runtime root |

`configDir` 默认 `~/.grokbox`，`durableRoot` 默认 `/workspace/.grokbox/box-runtime`。保留显式 `GROKBOX_CONFIG_DIR`、`GROKBOX_BOX_RUNTIME_ROOT`、`GROKBOX_RUN_ROOT` 的部署选择用途；它们不是 arbitrary key override，不能从当前目录、Webhook 或模型输出切换。已初始化安装的受保护 layout record 固定 role、physicalRoot 与 installationId；不一致时拒绝，换根走显式 relocation，不偷偷开第二安装。

client 模式读取自己的 Profiles，Box 角色仍能保存自身客户端 Profiles。连接到远端不意味着本机 config 变成远端意图。Mac/client-only 不具备 Box 证据时，读写 desktop/runtime/ops 执行意图须拒绝或显式 target transport，不能在本机 home 假配置远端。

### 3.2 别名不是第二事实源

writer 由 installation descriptor 找 canonical 实体，按已验证父目录/regular-file/no-follow/owner/mode 条件读写。临时文件建在实体旁、fsync 后 rename 到实体，**绝不向 home 别名 rename**。Host 保持读取 canonical durable models 的有界 no-follow 路径，不能为了别名放松 Host 的 symlink 防线。

home 别名被原子保存编辑器替换为普通文件，会产生分叉；doctor 和 `config path/check` 必须报告 alias-conflict。不自动覆盖该文件、不按 mtime 合并，保全双方并通过显式修复选择。CLI 对该路径不静默写错文件；已有推理仍只消费 canonical models。手工编辑不是受控事务：推荐 `config/models` 命令或先取 `config path --physical`；不能承诺任意编辑器都能正确写 symlink。

只在受支持 bootstrap/restore lane 实测重建别名与安装身份后，才声明特定 Reset 场景可恢复。workspace 持久性也依赖平台实际保留范围；不将目录名本身当作 Reset 无损证明。模型凭据 `file:` 继续指向既有 durable secrets，迁移不重写密钥内容或任意重定向路径。客户端连接 secret 可能仍在旧 home secret store：配置文件迁入 durable 不等于这些 secret 已持久化，必须逐引用核对可读性与保留范围，不自动迁密钥/改 ref，也不删除仍被引用的目录；未证明的 Reset 认证恢复单列 not_proven。

<a id="shape"></a>
## 4. config v2 的形状与字段归属

新文档使用 `schemaVersion:2` 与 camelCase；不是 AH-99 旧评论中的 `{version:2,current_profile,desktop}`。当前 v1 parser 只用于显式 migrator，新运行路径不双读。顶层只允许 `schemaVersion/client/daemon/desktop/runtime/ops`；文档 revision 在提交/读回回执计算，不由用户写一个自称 revision 的字段。

```json
{
  "schemaVersion": 2,
  "client": {
    "currentProfile": "default",
    "profiles": {
      "default": { "transport": "auto" }
    }
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
    "support": { "offerIssue": true, "draft": "after-consent", "submit": "confirm-each", "repository": "yoyooyooo/grokbox", "attachments": "none" },
    "targets": { "default": { "enabled": true } },
    "routing": { "enabled": false, "defaultTarget": "default", "rules": [] }
  }
}
```

示例是目标形状，不会因写 `enabled:true` 安装服务/配对/花费；实际能力受部署、授权、资格与预算限制。升级不把旧 off 自动改为例子值。

| 分区 | 持久化内容 | 重要限制 |
|---|---|---|
| `client` | currentProfile；嵌入命名 Profiles | 不再 `profiles/<name>/config.json`；transport、serverUrl、daemonSocket、gatewayUrl/discovery、sshHost、secret refs、sandbox/quota 等以当前 validator 逐字段映射 camelCase，无宽松字段透传 |
| `daemon` | network listener 意图、Serve 意图、filesystem roots、process policy | 复用现有限制，提炼为纯 schema；secret verifier/已发布 Serve ownership 不属于偏好。扩权须声明影响并确认，不能通过 object set 绕过叶级权限 |
| `desktop` | idleReclaim.enabled/minIdleMs、keepAgentIds | minIdleMs 保持 600000–86400000；floorAgentIds 与 stopWindow 可执行文件 pin 移入安装安全状态，只读投影，不被通用 set 修改 |
| `runtime` | desiredMode=disabled/observe/identity/route | 原 state/desired.json 意图搬入；保存模式不等于 inject/deactivate 成功，真正切换仍用唯一 controller |
| `ops` | enabled、固定版 preset、监测/通知/诊断/维护/支持、targets/routing 偏好 | 不再 `ops-policy.json`；不再 `overrides` 包一层。节点实际出现就是覆盖，缺省继承固定版 preset，unset 回默认 |

`ops.targets.<alias>` 可保存明确的 desired agentId/routineKey 与偏好，方便配置化选 Bot；真实 native ID/revision、endpoint secretRef、用户对数据/模型/工具范围的同意指纹只能来自 bind 用例的机器收据。配置修改 desired target 不自动创建/启用 Routine，也不使旧配对对新目标有效。迁移/便携 export 默认移除实际身份和 secret refs，保留可重新绑定的别名。

对象合并不使用隐式 deep-merge：读取时以 schema/preset 逐字段求值；写入先对目标对象完整替换，再对全文件及关联引用校验。路由数组顺序有语义；不可排序为看似规范化。models v1 的逐 Bot assignment、externalCatalog、credentials refs、contextWindowTokens、chatDialect 等全部保持，`assignments.main` 不借本票改变默认回退语义。

### 4.1 被移出普通配置的状态

`${durableRoot}/state/installation.json` 管理 layout/role/安装 generation、floor 与 stop-window pin、daemon verifier/发布身份等安全事实，只有对应安装/安全程序可更新；新字段按职责子对象限制写者，不制造普通 JSON 编辑入口。

`${durableRoot}/state/ops-bindings.json` 由 targets bind/rebind/unbind 程序管理；`${durableRoot}/state/ops-grants.json` 由受信维护/issue grant 程序管理。维护 grant 和发布 grant 仍分领域，share file 不 share 权限。one-shot issue consent/submission、incident/outbox/诊断在原 SQLite，controller operation 在原 controller store。不能用 config apply/import、文件内 `approved:true` 或更强模型建立许可。

机器文件不是需要用户维护的第三配置；与同 UID 恶意代码不形成 OS 沙箱。每个 machine write 仍有期望 revision、owner、撤销和备份恢复策略。配置与 bind/grant 跨文件流程通过阶段回执对账，不假装文件系统事务。

<a id="cli"></a>
## 5. 一套公开命令面

```text
grokbox config get [path] [--effective] [--scope local|target]
grokbox config set <path> <json-value> [--expect-revision <sha>] [--confirm]
grokbox config set <path> --string <literal> | --value-file <json-file>
grokbox config unset <path> [--expect-revision <sha>]
grokbox config apply --file <config-v2.json> --expect-revision <sha> --confirm
grokbox config validate [--file <config-v2.json>]
grokbox config schema [path]
grokbox config path [--physical] [--document config|models]
grokbox config export --portable
grokbox config preset ops user|maintainer --preview|--confirm
grokbox config migrate --preview
grokbox config migrate --apply --plan-digest <sha> --confirm
grokbox config migrate --status|--recover

grokbox models list|use|reset|check|apply|persist-key …
grokbox ops status|targets|routes|issue|policy|claim|diagnose|plan|submit|outcome|run …
grokbox profile list|show|use|add|update|remove …
grokbox agents routines …
grokbox host start|stop|restart …
```

以上为目标。删除尚未实现的 `runtime ops config …` 设计；`ops` 处理运维动作，不是第二配置 CRUD。已有 `runtime models …` 能力归并到顶级 models；旧 user-facing aliases 在破坏版本中移除并给明确迁移帮助，不留第二执行程序。`runtime profile` 等已用低级诊断/资格入口不为对称性全面改名；模板及普通用户入口只教新配置/ops/models 主线。

`profile` CRUD/use 仍可提供领域便利命令，但它们调用同一 ConfigChange 修改 `client` 子树；desktop keep 与 on/off 等同理。`models` 有独立模型合同和提交资源，不受 `config set models.*` 访问；模型 apply 也不是一个自由 JSON 编辑器。`ops routes validate/explain/test` 是纯业务观察，不替代全文件 config validate。

### 5.1 路径和值

常见路径使用 dotted form，如 `desktop.idleReclaim.enabled`、`ops.notifications.mode`。包含点/斜线等特殊字符的 map key 使用同一位置参数上的 RFC 6901 JSON Pointer，如 `/client/profiles/work.v2/transport`；不实现 eval、表达式、wildcard 或自创 escaping。两种形式解码到同一 path tokens。禁止 `__proto__`/`prototype`/`constructor` 等危险键，遍历 only-own-properties；同一 JSON 有重复 key 必须在 parse 层拒绝，不能靠 JSON.parse 的后者覆盖掩盖输入。

value 默认是严格 JSON：true 是布尔，600000 是数字，字符串用 JSON 字符串或显式 --string，不做 true/on/yes 的模糊自动转换。大数组/对象允许 --value-file，大小上限与 canonical reader 对齐；它只是输入文件，不能指定任意输出路径。三种输入互斥，敏感 refs 不应进入 argv/history。

数组 set 必须 `--replace` 且带明确确认/expectedRevision；不支持索引写/append/splice，日常 add/remove 走对应领域命令。object/root 替换校验所有受影响后代权限、危险扩权与交叉引用，不能用 set desktop 整段夹入 floor。`unset` 只删除可选的显式意图，输出随后使用的默认来源；不能删 schemaVersion、必需对象、被引用目标、currentProfile 或将缺失 secret 当成自动默认。

无 path 的 get 默认返回脱敏 stored-intent 树及 scope/revision；--effective 返回 default/inherited/override 与支持/授权/应用状态。不得以 hash、secret ref 或 read-only field 泄漏秘密/机器身份；read-only 安全字段只在明确诊断投影中显示合适的安全信息。redacted 输出不是可直接 apply 的完整备份，portable export 明示需补齐的绑定/身份，不能用 *** 覆写真值。

### 5.2 Scope 不是 Profile 的另一种拼写

`client.*` 永远属于发起者本机 Profiles，target scope 不允许改远端 currentProfile。`desktop/daemon/runtime/ops` 属于一个被明确识别的 Box。

在当前连接明确是本 Box 时，省略 scope 按 local；已选择远程 Profile 时，修改 Box 意图却未给 scope 必须 `config_scope_required`。`--scope local` 仍需本机是受支持 Box；`--scope target` 只经新明确声明的配置 capability 发到该目标 canonical writer。没有新 capability 就拒绝，不 fallback 写发起者 home，不开通用远程文件修改。models 写入当前仍 local-only，远程新能力不在这次顺带开放。

remote get 不能泄漏目标 client Profiles/secret；只返回被授权的 Box 部分。target scope 的 apply 只接受被授权 Box 分区的显式变更，不能用一个不含 client 的文档删除目标 client 域；带 client 变更则拒绝。连接失败、scope/installation generation 改变时不提交。配置 path/migrate/validate 的启动路径必须能在旧/坏配置时运行，不先经过必须成功解析新 Profile 的业务启动流程。

<a id="writer"></a>
## 6. Schema、写入、修订与生效

### 6.1 一个逻辑 writer，而非一把 CLI 专用锁

一个 ConfigChange 用例处理路径更改、领域操作或完整替换。程序顺序：识别 scope/root → 读取来源与 operation → 锁内重读 canonical → 检查 expectedRevision → 完整 shape/引用/权限/扩权确认校验 → 临时文件独占创建 0600 → flush/fsync → 再核路径身份与旧摘要 → 原子 rename → 目录 sync 与读回 → 保存 commit receipt → 释放锁 → 通知消费者重新读取。

同一文档 cooperative lock 由所有 writer 使用：profile/init、desktop keep、on/off/upgrade 的意图、config CLI、bootstrap、ops preset/targets desired、runtime desired。bootstrap 不再通过内联 node 合并/覆盖文件；daemon 不再拿旧内存数组拼整文件写回。keyed domain add/remove 也锁内读最新值，不能因领域便利入口跳过 CAS。外部手动编辑不遵守锁，提交前复核可发现一部分竞争但不能对同 UID 恶意修改声称完全隔离。

文档 revision 为严格验证、规范化 JSON 的摘要；每次配置 edit 与完整 apply 的读回使用同一算法。无显式 --expect-revision 的简单 local 标量命令也须捕获并复核本次读版本；自动化、数组/整文档写、非交互高风险写必须显式 revision。冲突不自动重试覆盖；返回具体稳定失败与重新预览指引。

不持配置锁访问 Gateway/GitHub/provider，Effect Scope 拥有锁/文件/取消/finalizer。只把最小不可分的 publication 窗口设为不可中断，未知 commit 以稳定 operationId 对账。完整依赖 catalog/network 资格在事务外固定 evidence，锁内只做有限重新核验。

### 6.2 一个文件不等于一种有效性 revision

`configRevision` 负责整个 config 文档 CAS；另外复用/计算 `runtimeRevision`、`opsPolicyRevision`、target policy digest、model selectionRevision 等**具体依赖投影摘要**。修改 desktop 或 client.currentProfile 不撤销所有运维 grant、不重绑所有目标、不取消 modeld TURN。

modelsRevision 与 configRevision 独立；Host 不开始读取大 config 或 ops。对选模仍捕获同一 models 快照与既有 selectionRevision，保留进行中的 TURN pin；改 target 的 desired model 不偷换当前 STEP。跨 models/config 的维护计划引用两边 revision，在动作用例前重新验证，不提供跨两文件原子 config apply，也不通过一个全局 revision 假装事务。

### 6.3 保存与应用的三层回执

```json
{
  "operationId": "config-example",
  "scope": "local",
  "document": "config",
  "commit": "committed",
  "changedPaths": ["desktop.idleReclaim.enabled"],
  "configRevision": "example-revision",
  "application": { "state": "pending", "reason": "daemon-unavailable" }
}
```

保存成功但 reload RPC 失败，不得回复「没有保存」或自动回滚意图。普通 set 以持久提交完成为成功并明确 pending；`--wait-applied` 要求当前消费者实际确认相关 revision，超过有界时间返回 apply_pending 并保留 committed 事实。daemon 启动时/收到通知时从 canonical 重读，不接受 RPC 携带第二份值作为权威；通知只是 invalidation hint，丢通知仍靠有界版本对账恢复。

hot reload 字段只在消费者成功安装新快照后报 applied；改变 listener/process policy 等需要重启的字段报 restart-required，不能偷偷重启。Host start/stop/upgrade 原有运行安全门继续约束真实控制；config set runtime.desiredMode 不是 host stop，config set ops.enabled 不安装 collector。AH-101 对开关的产品策略另行决定，不在迁移时顺便改变默认闲时行为。

统一新错误类别需同步 §13/CLI tests：config_invalid、config_path_invalid、config_conflict、config_scope_required/unavailable、config_layout_conflict、config_migration_required、config_apply_pending、config_commit_unknown。旧领域错误继续本域，不能把所有配置错叫 profile_invalid。安全 unknown、stored commit 与 active state 均有机器可读结构，stderr 不输出原始 secret/cause。

<a id="migration"></a>
## 7. 单向迁移与旧 writer 退役

### 7.1 映射

| 旧来源 | 目标 |
|---|---|
| home config.version/current_profile | schemaVersion2 / client.currentProfile |
| profiles/<name>/config.json | config.client.profiles.<name>；snakeCase 显式逐字段映射 |
| daemon/config.json 的 desktop prune/minIdle/keep | config.desktop.idleReclaim / keepAgentIds |
| daemon config network/serve/filesystem/process 的长期意图 | config.daemon；verifier、pin、实际 ownership 分到机器安装状态 |
| runtime state/desired.json.mode | config.runtime.desiredMode |
| 已存在的试验性 ops-policy 偏好 | config.ops；overrides 的显式叶展平，同值可合并、冲突停下 |
| ops-policy bindings/grants（若确实存在） | 新机器状态；不得从未验证原型记录升级为有效授权，默认 suspended/revalidate |
| durable models.json/secrets/源档案/原始事件 | 原位不动；模型 schema 以上线候选的最新 v2 为准 |
| bootstrap/daemon-config.json | 不作为最新事实源；只作为安装输入证据，退役旧安装脚本 |

没有对应旧文件时不要制造迁移需求；不得假设之前写的 Spec 文件已生产落盘。未用字段与未知字段报冲突/未识别，不用旧 parse→stringify 静默丢弃，包括并行 v2 的 chatDialect。

### 7.2 迁移协议

1. `migrate --preview` 独立于正常 Profile 初始化，枚举实际存在来源/布局/别名/owner 版本，输出安全变化、source digest、冲突与服务影响。只读，不原地生成新版配置。
2. 用户确认 exact plan 后取得 migration lease，证明所有会写旧路径的相关 daemon/bootstrap/CLI owner 已停止或已换到能参与 fence 的新版。新文件的锁不能约束旧二进制；不能证明旧 writer 已收口就 blocked。停止生产服务/Host 的影响需要对应授权，不因迁移命令默认获得。
3. 保存不可变备份和阶段 manifest，在 canonical 旁验证 staging 与必要机器状态；新旧来源冲突必须明确选择，**不按“新版永远赢”或 mtime 自动合并**。source/plan digest 变化即重新预览。
4. 多文件发布不是单次 rename 事务。记录 prepared/publishing/published/activated/retired；新版消费者发现迁移未激活必须等待/拒绝新动作。崩溃按 manifest 精确恢复，publication 前旧字节保持；publication 后部分状态公开为 partial/recovery-required，不承诺任何时刻旧文件都没动。
5. 核对 canonical 两文档、别名、secret 解析、依赖 scope、消费者读取相关 revision，才激活新版 layout。models 实体不变，Host no-follow 路径不变；modeld/controller 的 desired reader 已指向 config.runtime 才可退旧 desired。
6. 仅在激活和受支持 owner 资格通过后，将旧配置移入受保护 migration 备份/墓碑，bootstrap 只生成新根。新版普通读永不 fallback 老文件；旧 writer 重建旧文件要告警而非合并。

重复迁移幂等，对账同 operation/manifest；未知步骤不能以删除目录重试。失败恢复保留用户修改和秘密，不能重置到示例默认。迁移备份按明确保留策略管理，不入 git/公开 artifact。单纯升级 CLI 包不隐式执行破坏迁移；upgrade 可做诊断提示，真正迁移须确认计划与必要维护窗口。

### 7.3 串行升级中的兼容边界

新版正常路径只读新 shape，旧 v1 parser 仅在 migrator；旧 CLI/daemon 不再列为同安装受支持 writer。必要的短 rollout 阶段以冻结写入+已资格化读取 bridge 实现，不能变成永久 dual source。当前 models v1 保留不是第二 config 策略，是独立领域版本不在本票重建。

当前运维分支落后于 v2 的 provider 修复。T57/T60 实施前先固定集成基线，在隔离 worktree 对齐模型字段及命令冲突；不重写并行提交、不把私有模型目录当测试输入，不把 docs commit 视作完成升级。未知运行/安装环境保持 unsupported，不猜 home 持久化。

<a id="modules"></a>
## 8. 目标骨架与删除地图

```text
packages/runtime-kernel/src/
  config.ts                              # 统一纯配置公开合同；无 Node/CLI import
  internal/config/
    schema.ts                            # 组合 client/daemon/desktop/runtime/ops 片段、路径能力元数据
    path.ts                              # dotted / RFC6901 同一解析，非通用表达式
    revision.ts                          # 文档与依赖投影 revision
  internal/commands/config.ts            # 单一 ConfigChange 用例
  ports.ts                               # 扩展既有 ConfigurationWrite，不另开同义 writer
packages/box-runtime/src/internal/io/
  config-layout.node.ts                  # role/root/别名/regular file resolution
  config-store.node.ts                   # canonical config 的 lock/CAS/fsync/readback
  config-migrate.node.ts                 # 独立旧解析/migration manifest/恢复
  configuration.node.ts                  # models store 复用；desired 读取改 config.runtime
  configuration-write.node.ts            # 同一用例 Live Layer
  ops-bindings.node.ts / ops-grants.node.ts # 机器状态，非用户偏好文件
packages/cli/src/
  commands/config.ts                     # 薄参数/输出/作用域路由
  config/profile.ts                      # 保留领域服务适配；删除独立 global/profile 文件 writer
  daemon/config.ts                       # 启动/读取适配；纯 validator 提炼到 kernel，不另存 daemon JSON
  commands/profile.ts / commands/operator.ts / daemon/desktop.ts
                                         # 同 ConfigChange；内存状态不反向覆写整份文件
  bootstrap.ts                           # 调统一初始化/migration，不内联拼 JSON
  registry.ts                            # config/models/ops 主线，公开旧别名退役
```

ops 的规则片段仍由 T51/T54 拥有，kernel schema 组合而不复制常量/validator。原模型 parser/revision/credentials 不搬进通用 config。领域读取者只校验自己依赖的片段及版本/完整性，不让一个未知 ops 可选能力迫使 Host 加载全部配置依赖；全文件 writer 必须严格校验全部字段。坏 JSON/重复 key 不可局部猜补，自动写与新危险动作 fail closed。

Host/preload 保持 Effect-free/SDK-free/不读 ops/grants；只消费既有 models snapshot，modeld 的新 runtime config reader 使用薄纯合同。统一文件里的 client/desktop 修改不得污染 TURN pin，也不能增加每个 token 的全文件重读。

<a id="proof"></a>
## 9. Tickets、可验收退出与并行边界

| Ticket | 对应需求 | 唯一交付 |
|---|---|---|
| T57 | AH-99 形状与根；T51/T54 衔接 | 统一纯 schema/布局、两文件含义、permission/revision 子投影、最新模型字段保全 |
| T58 | AH-100；AH-99 writer 收口 | config 命令+统一 commit、作用域、数组/对象安全、领域便利命令无丢更新 |
| T59 | AH-99 新装/迁移/bootstrap | 可恢复迁移、旧 writer fence、别名冲突、消费者 applied 与回退边界 |
| T60 | 两票整体与 T43–T56 集成 | 顶级 ops/models、文档/skills/packaged CLI、跨域失效隔离与运行资格 |

依赖为 T57 → T58/T59（共享 IO 一个 owner）→ T60。T51/T54 业务纯规则可并行，但其持久偏好不先落 ops-policy.json；T53 通用 Routine 与 T43 原生资格不依赖统一配置完成。T45/T46/T52/T55/T56 的持久接线消费此重建，不为迂回绕过再建第三配置。AH-101 的闲时行为独立，不趁本票改变 floor 或 minIdleMs；需要联动只在 shared writer 一片收口。

必须证明：旧 parser 不丢 chatDialect；client-only/Box/remote 不写错根；同文档交叉 writer 不丢键；数组替换与 keep add 冲突可见；set 父对象无法写 grant/floor；saved但reload失败如实 pending；通知丢失能重新读回；改 desktop 不失效 target/grant/模型 TURN；别名被覆盖不污染 durable；迁移每阶段硬崩可恢复；bootstrap 不重建旧 SoT；backup 不复活授权；models secret refs 不变；安装升级的 current loaded readers 与实际文档路径匹配。

所有新测试先 synthetic/FakeClock/临时真实文件与进程、实际 packed Node 入口；不用真实 home、provider、Bot 或私有源。live migration/Reset/远端配置写入须独立范围批准。source/packed green 不标两票已完成生产验收，本轮不改 Linear 状态。

## 10. 参考与失效

JSON Pointer 的路径编码以 [RFC6901](https://www.rfc-editor.org/rfc/rfc6901) 为准；JSON 对象重复 key 的互操作风险见 [RFC8259 §4](https://www.rfc-editor.org/rfc/rfc8259#section-4)，本产品选择严格拒绝。fs 操作/符号链接/并发读写的底层行为参考 [Node fs](https://nodejs.org/api/fs.html)，Node Promise fs API 本身不提供应用级同步；本方案的事务/CAS/Scope 是产品实现责任，不从 rename 推出跨文件原子或 compare-and-swap。

配置 schema/root、bootstrap/持久性、支持 writer 版本、领域 revision、transport capability 或模型 parser 变化时复核本规格；运维能力与付费/发布授权的细节继续维护在各自 Current Home。
