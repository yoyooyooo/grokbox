# 候选命令目录

状态：已按本轮确认的能力范围更新，精确动作和参数仍为候选；不是已实现的命令帮助。已接受方向与未决项见[决策清单](decisions.md)，实际命令以源码 registry 为准。

## 3. 对外完整命令目录

下表是候选目标树；动作列每个名称代表一个候选 leaf。describe 是离线索引/描述入口。目录包含当前能力的重组，以及为统一服务、全局检索、源数据管理和可靠操作合同新增的能力。Memory/Project update、文件 search、默认值 reset 等具体命名和输入尚待合同细化；接受其上层意图不代表每个来源都具备相应能力。实际注册须有已验证的支持和结果合同，不能用空实现兑现命令名。

| 领域 | 命令前缀 | 动作 | 合同要点 |
| --- | --- | --- | --- |
| 发现 | `grokbox describe` | `[<command-path>]` | 离线索引、命令输入/输出 Schema、影响、等待条件与版本配套 guide；--topic 读取配套主题。 |
| 发现 | `grokbox capability` | `list` · `get` | 目标当前支持、启用、授权、可用与资格分别返回；能力发现不产生执行许可。 |
| Bot | `grokbox bot` | `list` · `get` · `resolve` · `create` · `update` · `delete` · `duplicate` · `clone` · `replace` · `spawn` · `activate` · `export` | Bot 身份、资料和完整生命周期；get 的 summary/activity/diagnostic 视图有固定 Schema。 |
| Bot | `grokbox bot ownership` | `get` | 读取 Server 与本机的归属对照；不提供 harness setter。 |
| Bot | `grokbox bot model` | `get` · `set` · `reset` | 原生、跟随 grokbox 默认或指定模型；指定不跟随默认切换，但采用自身模型配置更新；普通变更作用于后续 TURN。 |
| Bot | `grokbox bot context` | `get` · `compact` · `reset` · `restore` · `initialize` | 单份当前上下文；initialize 只允许空白准备目标；不创造会话列表。 |
| Bot | `grokbox bot snapshot` | `list` · `get` · `create` · `verify` | 私有恢复材料与覆盖说明；verify 检查闭包，不执行历史工具。 |
| Bot | `grokbox bot protection` | `get` · `set` | 确认 Box-owned 默认观察与保全，可逐 Bot 调整/关闭；后台按证据推进保护与接替。 |
| Bot | `grokbox bot handover` | `get` · `attest` · `retire` | 按接替操作读取真实 Bot 前后继关系与交接证据；目标可用、关系已转移、旧身份可退役分别核验。 |
| Bot | `grokbox bot presentation` | `get` · `set` · `sync` | 标题中的运行信息展示策略；sync 只重新呈现真实观察，不改变执行事实。 |
| 群组 | `grokbox group` | `list` · `get` · `create` · `update` · `delete` | 原生 Group；get --view activity 呈现成员队列与回复缓冲。 |
| 群组 | `grokbox group member` | `list` · `add` · `remove` · `set` | 成员关系；set 替换精确集合，明确上游 CAS 能力。 |
| 消息 | `grokbox message` | `list` · `get` · `search` · `thread` · `send` | 展示转录与明确的 Human 输入；不伪造 Bot 发信人。 |
| 消息 | `grokbox message delivery` | `get` · `wait` | 跟踪一次 submission 的 recorded/response-observed 等真实回执；不推断完整运行结束。 |
| 执行 | `grokbox run` | `list` · `get` · `events` · `wait` · `cancel` | 真实可关联的 Bot 执行；cancel 仅在原生精确范围能力存在时开放。 |
| Memory | `grokbox memory` | `list` · `get` · `read` · `search` · `update` | list/search/read 已接显式本地 agent/user/project 文档来源；read 单独取原正文。不是完整原生 fact CRUD；get/update 与源修改继续逐源核验，不直接写原生分片。 |
| Memory | `grokbox memory source` | `list` · `get` | 当前接入的数据源、覆盖范围、更新时间、同步延迟与缺口。 |
| Project | `grokbox project` | `list` · `get` · `update` | 原生 Project 读取与受支持属性修改；字段、成员管理动作逐项收口，不把 Git 目录当成 Project 或机械补齐 CRUD。 |
| Project | `grokbox project member` | `list` | 明确记录的 Bot membership。 |
| Project | `grokbox project file` | `list` | 返回 Project 下授权文件的 fileRef；读取/下载统一走 file。 |
| Routine | `grokbox routine` | `list` · `get` · `apply` · `enable` · `disable` · `delete` | 原生自动任务的声明与启停；新建默认 disabled；不宣称存在通用 invoke。 |
| 模型 | `grokbox model` | `list` · `get` · `apply` · `delete` · `check` · `probe` | 集中维护模型配置，使用者后续 TURN 采用更新并记录版本；仍被 Bot 选择或全局默认引用时拒绝删除并返回引用关系；probe 明确费用与副作用。 |
| 模型 | `grokbox model default` | `get` · `set` · `reset` | 全局默认只影响明确跟随者；reset 表达清除全局默认，区别 Bot 回原生；仍有跟随者时拒绝清空；无默认不能选择跟随。 |
| 模型 | `grokbox model credential` | `get` · `import` | 只读脱敏来源元数据；通过受控来源导入为私有引用，不输出密钥。 |
| 模板 | `grokbox template` | `pack` · `stage` · `get` · `publish` · `delete` · `import` | 打包、上传草稿、发布和导入；不虚构官方完整 template list。 |
| 模板 | `grokbox template visibility` | `set` | 显式改变分享范围；公开发布属于独立影响。 |
| 异常 | `grokbox incident` | `list` · `get` · `ack` · `snooze` | 后台主动识别并跟踪管理异常的发生、变化、恢复；ack/snooze 不代表恢复。 |
| 异常 | `grokbox incident evidence` | `get` · `capture` · `retain` | 固定证据 revision、显式补充取证、有限保留；读取不续租。 |
| 原生告警 | `grokbox alert` | `list` · `get` · `trace` | 原生 tray 及其观察生命周期；与持久 incident 关联但不混成同一对象。 |
| 通知 | `grokbox notification` | `status` · `list` · `get` · `send` | status/list/get 已接共享管理服务的 worker 与 work/attempt 读面；send 仍由原领域入口迁移，只发送指定既有 work，不接受任意 URL/body。 |
| 通知 | `grokbox notification settings` | `get` · `apply` | 已接原配置 writer 的窄目标/模式/预算变更；显式 revision 和确认，保留其他系统策略；配置不是私有授权、Routine enable 或投递。 |
| 通知 | `grokbox notification receiver` | `list` · `get` · `blueprint` · `verify` · `test` · `bind` · `enable` · `disable` · `unbind` | 配置后显式启用，后台负责持续投递、去重、有限重试与记录；test 是独立可选投递，必要配置/授权齐备即可启用；启用/测试/实际投递分开。 |
| 文件 | `grokbox file` | `stat` · `list` · `search` · `read` · `write` · `mkdir` · `upload` · `download` · `delete` · `restore` | 当前list/search/read/write保留显式文本来源；named-root的stat/list/read/write/mkdir/upload/download/delete/restore已接入同一管理面，旧fs退出，索引不接管原内容。原生Project fileRef、账号/同步与长期安全维护仍待资格，named-root不能代签。 |
| 文件 | `grokbox file root` | `list` · `get` | 已授权文件根与权限/大小上限。 |
| 进程 | `grokbox job` | `start` · `list` · `get` · `logs` · `wait` · `cancel` | OS Job，结构化 argv，持久身份，日志与运行寿命分开。 |
| 操作 | `grokbox operation` | `list` · `get` · `wait` · `events` · `reconcile` · `resume` · `cancel` | 跨领域操作索引与生命周期查询；具体写入和安全推进仍由原领域 owner 实现。 |
| 事件 | `grokbox event` | `list` · `watch` | 有界历史和增量流；范围、游标、代际、缺口和背压统一。 |
| 系统 | `grokbox system` | `init` · `get` · `check` · `recover` | 安装初始化、总览、只读诊断和精确计划恢复；不提供模糊一键修复。 |
| 系统 | `grokbox system identity` | `get` | 真实认证主体、安装与账号 scope；self 绑定来自可信运行上下文。 |
| 系统 | `grokbox system console grant` | `create` | owner-only 一次性登录码，绑定显式 console origin；只写新私有文件，不输出普通凭据、不作为持久业务 operation。 |
| 系统 | `grokbox system service` | `list` · `get` · `install` · `uninstall` · `start` · `stop` · `restart` · `run` | 管理 server/modeld/web；run 是 supervisor 的明确前台入口；重启采用组件专用关闭合同。 |
| 系统 | `grokbox system host` | `get` · `start` · `stop` · `restart` | 官方 Host 生命周期，由原 controller/supervisor 负责。 |
| 系统 | `grokbox system integration` | `get` · `enable` · `disable` · `reconcile` | grokbox 与 Host 的集成状态和采用；与服务启动、逐 Bot 模型选择分开。 |
| 系统 | `grokbox system materials` | `get` | 当前材料 indexer、来源绑定与可用性/新鲜度；不启动扫描、授权源或证明上游同步。 |
| 系统 | `grokbox system observation` | `get` · `refresh` | 持续采集的健康、范围与新鲜度；refresh 是有预算的一次观察请求。 |
| 系统 | `grokbox system config` | `get` · `apply` · `reset` · `validate` · `export` · `path` · `preset` | 受管系统偏好，显式 patch/replace；字段按领域分派，禁止绕过领域授权和不变量。 |
| 系统 | `grokbox system storage` | `get` · `maintain` | 存储实占与有界维护；各 safety/CONT/诊断 owner 审批自己的回收。 |
| 系统 | `grokbox system log` | `list` · `watch` | 组件日志的结构化、有界读面；日志正文默认脱敏。 |
| 系统 | `grokbox system desktop` | `get` · `prune` | 原生桌面 fork 的状态与精确清理；自动策略进入系统配置。 |
| 系统 | `grokbox system desktop keep` | `set` | 保护清单的精确集合更新。 |
| 系统 | `grokbox system web` | `get` | Web URL、启用与服务状态；不把会话凭据放到 URL。 |
| 系统 | `grokbox system access` | `list` · `get` · `grant` · `revoke` | 本安装的有限调用权限与主体绑定；不是多租户 IAM 平台。 |
| 系统 | `grokbox system quota` | `get` | 读取明确的上游账号额度来源；不从日志推算，不混同 provider 账单。 |
| 连接 | `grokbox connection` | `list` · `get` · `set` · `delete` · `check` · `recover` | 显式连接描述与已支持的恢复适配；不设全局 use，不内建网络产品配置。 |
| 外部 Box | `grokbox box` | `get` · `wake` · `recover` | Box 外部生命周期能力；直接使用独立授权控制面，可在本机服务不可达时运行。 |
| 外部 Box | `grokbox box keepalive` | `run` · `get` · `stop` | 在 Box 外持有有界 keepalive；停止不假称平台已 freeze。 |
| 维护者 | `grokbox maintainer host-profile` | `get` · `observe` · `analyze` · `propose` · `write` · `replay` · `prune` | 上游 profile 研究、资格与材料保留；不进入 Bot 日常发现摘要。 |
| 维护者 | `grokbox maintainer contract` | `get` | 精确 Host 兼容合同与切片信息。 |
| 维护者 | `grokbox maintainer config` | `migrate` · `aliases` · `bootstrap` | 必要配置一次性转换与安装初始化；动作按实际保留需求收口，不承诺旧开发期数据库/回执迁入或通用历史迁移。 |
| 维护者 | `grokbox maintainer recovery` | `inspect` · `apply` | 精确 controller/config 元数据修复，不自动清执行权限或重放未知操作。 |
| 维护者 | `grokbox maintainer integration` | `set-mode` | 保留确有诊断价值的内部模式，不作为普通启用流程。 |

### 3.1 主要参数归属

| 命令族 | 目标与主要输入 |
| --- | --- |
| bot get/update/delete/activate/export | <bot-ref>；create/spawn 用 --input；导出用显式 --out |
| bot duplicate/clone/replace | <source-bot-ref>；结构化复制范围、模型、材料、启用与交接计划 |
| bot ownership get | 一个或有限批 Bot ref；每项独立给出来源与缺口；刷新由 system observation refresh 承担 |
| bot model get/set/reset | <bot-ref>；set 显式区分跟随默认与指定 modelRef，reset 回原生；选择 Schema 与 effort 按能力细化 |
| bot context get/compact/reset/restore/initialize | <bot-ref>；restore/initialize 指定 snapshotRef 和目标 revision |
| bot snapshot list/create | --bot <bot-ref>；get/verify 用 <snapshot-ref> |
| bot protection get/set | <bot-ref>；默认保护、逐 Bot 排除/调整与证据条件分开表达，具体策略 Schema 待定 |
| bot handover get/attest/retire | <replacement-operation-ref>；attest 指定 itemRef 与可验证 evidenceRef |
| group member list/add/remove/set | <group-ref>；add/remove 为明确 botRef，set 为完整集合 |
| message list/search/thread | 必须声明目标或全局授权范围；thread 绑定真实 entry/root 身份 |
| message send | --to <bot-ref或group-ref> 和结构化正文；返回 submissionRef、operationRef、原生 nonce |
| message delivery get/wait | <submission-ref>；保留原生 correlation 能力与结果窗口 |
| run list/get/events/wait/cancel | list 可按 Bot/Group/实际关联筛选；其余使用 <run-ref> |
| memory list/search | --scope agent/user/project/all 与对应 --bot/--project；all 表示已授权已接入范围 |
| memory get/update | <memory-ref> 含 scope/source；get 显式读取正文，update 绑定源内容版本和已验证写能力；具体修改格式待定 |
| project get/update/member list/file list | <project-ref>；update 的字段与来源能力待核实；project file list 返回可复用 fileRef |
| routine list/apply | 明确 --bot；get/enable/disable/delete 使用含所属 Bot 的 routineRef |
| model get/apply/delete/check/probe | 明确 modelRef；apply 声明影响使用者后续轮次的配置变更；delete 拒绝在用引用，引用检查并发与回执待细化；probe 显式有界 |
| model default get/set/reset | 安装级默认；set 指明 modelRef，reset 不改变逐 Bot 显式选择；在用默认拒绝清空，无默认时拒绝选择跟随 |
| template get/publish/import | shareRef 与精确 revision；pack 指明 Bot 和输出；stage/publish 分开 |
| incident get/ack/snooze | <incident-ref>；修改需要 incident revision；snooze 有截止时间 |
| incident evidence get/capture/retain | 固定 incident/evidence ref；capture 可按 Bot/STEP/tray 关联，缺关联时明确报告 |
| notification send | <notification-work-ref>；不接受任意 endpoint、正文或接收目标替换 |
| notification receiver bind/enable | 精确目标、Routine/binding revision 和必要配置/授权；测试不是启用门槛 |
| notification receiver test | 已配置目标和固定测试内容，不接受任意 URL/body；独立显式操作，产生测试 work/attempt，具体 Schema 待细化 |
| file 操作 | search 明确授权来源/Project 范围并返回来源位置与覆盖；读写用 fileRef/named-root，具体过滤/索引与写并发 Schema 待定 |
| job start | 结构化 argv、受控 cwd/env 和实际支持的执行期限；shell 是独立能力 |
| operation get | <operation-ref>，或用 --request-id 找回提交回执；不凭名字或时间拼接 |
| system service | server/modeld/web 三种明确组件；操作全部组件必须显式声明集合 |
| system config apply | input 明确 mode=patch 或 replace、领域、revision；不接受直接写私有 store |
| connection set | 本机客户端的显式 endpoint/credential reference；不操作目标 Box 配置 |
| box wake/recover/keepalive | 显式外部控制来源和目标身份；不继承 Gateway 的权限 |

Bot get、group get、run get 的视图是只读投影，不是第二套业务用例。activity、evidence 等视图必须保留来源、年龄和不完整性。
