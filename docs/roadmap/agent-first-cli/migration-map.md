# 现有命令的候选去向

状态：直接切换、无旧语法对外兼容期已确认，精确命令与参数去向仍待收口。此表不是第二份当前命令 registry。

初始 v2 基线 `6f0473d54b16885568e85c2850bc1bde02f58579` 的 182 个唯一 leaf 已保存于固定研究报告。本轮按当前 `a3e9131` 的 [registry](../../../packages/cli/src/registry.ts) 重新导入，增加五个服务/monitor 入口，当前映射覆盖 187/187。实施前仍须重跑盘点，按意图和参数分支核对，不让固定表覆盖后续源码。

## 10. 旧命令完整去向

以下覆盖本轮 registry 展开的 187 个入口。写成多个新入口表示旧命令混合了多个用户意图，需要按意图拆开；不是让调用者手动编排内部实现。标为后台 driver 的工作由服务接管，不保留日常 advance 循环。

项目尚未正式发布，用户期望破坏式重建并一次性采用最终版本。新合同定版后，同批迁移仓内脚本、Skill、文档、测试和已知调用方，旧语法直接退出，不提供对外兼容期。开发中可分阶段验证，允许中间版本不完整或不可用，不建设迁移期零停机、双轨或临时兼容层；最终不留下第二套正式语义或 writer。

数据兼容范围见 [Spec](spec.md)：官方数据及身份继续接入，有价值的模型/连接配置按需一次性导入，旧开发期内部数据库/日志/回执/测试状态不承诺迁入，投影与索引从真实来源重建。此边界不授权自动清理；实际在途或未知外部效果仍需识别，避免重复执行。源码中的旧限制也需核实其必要性，不能一律继承。

网络产品专属旧参数不进入新业务核心，现存冻结兼容代码单独治理，不因此新增适配承诺。leaf 名称覆盖只证明入口出现；每项还须按参数分支、目标、权限和成功条件核验，实施前更新基线。

| 当前命令，不含 grokbox 前缀 | 目标归属 |
| --- | --- |
| `config get` | system config get |
| `config set` | system config apply：显式 patch |
| `config unset` | system config reset |
| `config apply` | system config apply：显式 replace |
| `config validate` | system config validate |
| `config schema` | describe system config apply --schema |
| `config path` | system config path |
| `config export` | system config export |
| `config preset` | system config preset |
| `config migrate` | maintainer config migrate |
| `config aliases` | maintainer config aliases |
| `config recover` | maintainer recovery inspect/apply --domain config |
| `config bootstrap` | maintainer config bootstrap |
| `init` | system init |
| `skills list` | describe --topics |
| `profile list` | connection list |
| `profile show` | connection get |
| `profile use` | 删除共享默认切换；每次调用显式 --connection |
| `profile add` | connection set |
| `profile update` | connection set |
| `profile remove` | connection delete |
| `profile capabilities` | capability list --connection |
| `skills get` | describe --topic |
| `daemon serve` | system service run server |
| `daemon ensure` | system service start server |
| `daemon status` | system service get server |
| `doctor` | system check |
| `on` | system integration enable |
| `off` | system integration disable |
| `upgrade` | system integration reconcile |
| `host start` | system host start |
| `host stop` | system host stop |
| `host restart` | system host restart |
| `host status` | system host get |
| `host realign` | system integration reconcile |
| `host logs` | system log list --component host |
| `models list` | model list |
| `models use` | bot model set 显式指定/跟随默认，与 model default set 分开；旧输入映射不可把显式指定变成隐式跟随 |
| `models show` | bot model get |
| `models migrate` | Removed; no old model document execution or normalization command |
| `models reset` | --for：bot model reset 回原生；--default：候选 model default reset 清除全局默认。仍有 Bot 跟随时拒绝清空默认并返回引用关系；不改变 Bot 的显式选择，不把两种意图合并 |
| `quota` | system quota get |
| `recover` | connection recover |
| `box status` | box get |
| `box wake` | box wake |
| `box keepalive run` | box keepalive run |
| `box keepalive status` | box keepalive get |
| `agents list` | bot list |
| `agents show` | bot get |
| `agents context` | bot context get |
| `agents compact` | bot context compact |
| `agents protection status` | system protection get / bot protection get；旧普通命令已退出 |
| `agents protection observe` | 管理 Server 的默认保护观察通道；不保留手动业务 writer |
| `agents protection advance` | 管理 Server 的材料/继任/交接通道；策略入口 bot protection set，精确历史用 bot handover get |
| `agents handover status` | bot handover get |
| `agents handover advance` | 后台 handover driver；显式恢复使用 operation resume |
| `agents handover observe` | 后台关系观察；显式新鲜观察使用 system observation refresh |
| `agents handover attest` | bot handover attest |
| `agents handover retire` | bot handover retire |
| `agents clone` | bot clone --input --preview/--confirm；旧直写入口已退出 |
| `agents replace` | bot replace --input --preview/--confirm；统一主体/计划与原 CONT |
| `agents spawn` | bot spawn --input --preview/--confirm；程序启动独立权限 |
| `agents lifecycle status` | operation get --domain lifecycle --scope-id --request-id；原主体历史 |
| `agents lifecycle advance` | operation resume --domain lifecycle；只续原计划安全阶段，未知创建不重发 |
| `agents state show` | bot context get；已接管理服务，旧直连退出 |
| `agents state capture` | bot snapshot create；原生 checkpoint + 原 CONT 发布，固定 request/scope/revision |
| `agents state initialize` | bot context initialize；独立的原请求和快照引用，不隐含解除 |
| `agents state reset` | bot context reset；备份先于源替换，原 writer/marker 核验 |
| `agents state recover` | bot context restore；保留来源与备份，不回滚外部世界 |
| `agents state operation` | operation get --domain context；原主体/安装/scope/request 的历史 |
| `agents state reconcile` | operation reconcile --domain context；只对账原证据，不重新 apply |
| `agents state activate` | bot activate；原操作标记/首次解除 revision，独立 context.activate 权限，无任务启动 |
| `agents ownership` | bot ownership get |
| `agents title show` | bot presentation set --visible true |
| `agents title hide` | bot presentation set --visible false |
| `agents title sync` | bot presentation sync |
| `agents routines apply` | routine apply --input；已退出旧普通入口，严格 JSON / disabled apply 经共享 Server |
| `agents routines outcome` | operation get --domain routine --bot；保留原请求与主体 |
| `agents routines reconcile` | operation reconcile --domain routine；exact disabled definition 和当前 revision，原 request-id，不重发创建 |
| `ops targets list` | notification receiver list |
| `ops targets show` | notification receiver get |
| `ops targets blueprint` | notification receiver blueprint |
| `ops targets verify` | notification receiver verify |
| `ops targets activate` | notification receiver enable |
| `ops targets bind` | notification receiver bind；显式原数据库、Routine 与旧 binding revision，原 capsule 的持久配对回执 |
| `ops targets disable` | notification receiver disable |
| `ops targets unbind` | notification receiver unbind |
| `ops notifications send` | notification send |
| `ops notifications worker` | notification status；已退出旧 daemon RPC/命令，安全状态经管理 API |
| `ops notifications list` | notification list |
| `ops notifications show` | notification get |
| `agents routines list` | routine list --bot；旧 daemon Routine RPC 已退出 |
| `agents routines show` | routine get；安装/Bot/原生 Routine 稳定引用 |
| `agents routines enable` | routine enable |
| `agents routines disable` | routine disable |
| `agents routines delete` | routine delete |
| `agents duplicate` | bot duplicate |
| `agents operations show` | 原 CONT 历史记录保留只读；新产品请求走 product operation get/reconcile |
| `agents create` | bot create |
| `agents update` | bot update |
| `agents delete` | bot delete |
| `groups list` | group list |
| `groups show` | group get |
| `groups create` | group create |
| `groups update` | group update |
| `groups delete` | group delete |
| `groups members list` | group get（完整成员集合）；历史只读入口暂保留 |
| `groups members add` | group get → group members set；先审阅完整集合，不用旧快照盲覆盖 |
| `groups members remove` | group get → group members set；明确原生无 CAS，不隐藏复合写入 |
| `groups members set` | group members set --input；固定 requestId/scope/revision、显式非原子确认 |
| `send` | message send |
| `alerts trace` | alert trace |
| `alerts list` | alert list |
| `history outcome` | message delivery get/wait；STEP 诊断使用 run get |
| `history search` | message search |
| `history tail` | message list |
| `history thread` | message thread |
| `memory list` | memory list --scope agent；已迁为显式来源的文档元数据，正文用 memory read。旧 positional/--content 已退出；不冒充完整原生 fact CRUD |
| `export agent` | bot export |
| `template pack` | template pack |
| `template stage` | template stage |
| `template publish` | template publish |
| `template show` | template get |
| `template visibility` | template visibility set |
| `template delete` | template delete |
| `template import` | template import |
| `fs stat` | file stat（已迁入共享管理；准确根引用） |
| `fs list` | file list（已迁入；直接目录与索引窗口分别声明） |
| `fs read` | file read（已迁入；正文独立权限） |
| `fs download` | file download（已迁入；固定描述符、完整hash、本地no-clobber） |
| `fs write` | file write（已迁入；严格JSON与原领域回执） |
| `fs mkdir` | file mkdir（已迁入；明确缺失目标） |
| `fs upload` | file upload（已迁入；暂存、commit、取消分别有证据） |
| `fs remove` | file delete / file restore（已迁入；原主体/原删除与安全保全） |
| `exec run` | 已退出；job policy/start 经共享Server和原Job owner，结构化JSON、明确revision/request/confirm |
| `jobs list` | 已退出；job list 按实际主体读取原安全记录 |
| `jobs show` | 已退出；job get/wait 原始Job与有界观察，非CLI持有执行 |
| `jobs logs` | 已退出；job logs 独立正文权限、准确offset与base64页 |
| `jobs cancel` | 已退出；job cancel及operation get --domain job-cancel保留原取消身份；未知不重排 |
| `desktop status` | system desktop get |
| `desktop keep add` | system desktop keep set：审阅后提交完整agentIds集合与原request/revision，不提供旧add别名 |
| `desktop keep remove` | system desktop keep set：显式确认完整集合及移除保护的影响 |
| `desktop prune run` | system desktop prune：明确preview或带原request/revision的confirm |
| `desktop prune enable` | system config apply --domain desktop：action=idle-reclaim，enabled=true，明确minIdleMs与原request/revision |
| `desktop prune disable` | system config apply --domain desktop：action=idle-reclaim，enabled=false，保留原操作历史 |
| `events` | event watch |
| `is running` | bot get --view activity / group get --view activity |
| `runtime start` | system service start modeld + system integration enable，各自明确动作 |
| `runtime status` | system get / system integration get / system service get modeld |
| `runtime storage status` | system storage get |
| `runtime services status` | system service list/get，实际注册与运行分别观察 |
| `runtime services install` | system service install，绑定实际发行包与支持的管理器 |
| `runtime services uninstall` | system service uninstall，只退场所拥有的服务 |
| `runtime monitor install` | system init / system config apply 中的明确观察配置与存储初始化，不能在 GET 中补做 |
| `runtime monitor service` | system service get server；已退出旧 daemon RPC/命令；持久观察另用 system observation get |
| `runtime monitor init` | system init：显式初始化观察存储 |
| `runtime monitor run` | 管理服务 observation worker；一次采样使用 system observation refresh |
| `runtime monitor snapshot` | system observation get |
| `runtime monitor events` | event list |
| `runtime monitor incident` | incident evidence get |
| `runtime monitor capture` | incident evidence capture |
| `runtime monitor evidence lease` | incident evidence retain |
| `runtime monitor incidents` | incident list |
| `runtime monitor ack` | incident ack |
| `runtime monitor snooze` | incident snooze |
| `runtime activate` | system integration enable；纯诊断 mode 归 maintainer integration set-mode |
| `runtime deactivate` | system integration disable |
| `runtime log` | system log list/watch |
| `runtime group-progress` | group get --view activity |
| `runtime incident` | run get --view evidence |
| `runtime contracts` | maintainer contract get |
| `models check` | model check |
| `models persist-key` | model credential import |
| `runtime profile analyze` | maintainer host-profile analyze |
| `runtime profile observe` | maintainer host-profile observe |
| `runtime profile propose` | maintainer host-profile propose |
| `runtime profile prune` | maintainer host-profile prune |
| `runtime profile replay` | maintainer host-profile replay |
| `runtime profile status` | maintainer host-profile get |
| `runtime profile watch` | maintainer host-profile observe |
| `runtime profile write` | maintainer host-profile write |
| `runtime operation-recovery` | maintainer recovery inspect/apply |
| `runtime re-adopt` | system integration reconcile |
| `runtime watchdog run` | 管理服务内 controller 协调任务 |
| `runtime modeld replace` | system service restart modeld --expect-generation |
| `runtime modeld status` | system service get modeld |
| `runtime modeld run` | system service run modeld |

讨论收口由 [CLI-04](../../tickets/CLI-04-command-cutover.md) 负责。新名称可能变化，保留的用户意图、身份和未知结果语义不能因重命名而丢失。
