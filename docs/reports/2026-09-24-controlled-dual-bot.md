# 2026-09-24 受控迁移、固定候选与双 Bot 窗口

本报告记录 AH-183/184/185 → AH-162/122 → AH-123/124 → AH-186 的同一授权窗口。**2026-09-25 当前状态：原失败接管已完成同 ID 物理恢复，新的受控接管及 loaded/committed 对齐实际成功；双 Bot 验收阻塞在第一只 Temporal Bot 的原生创建 `effect_unknown`。** 现场已返回官方 Host、desired disabled，实验 modeld 已正式停止，49 个原有本机 Bot 的身份/harness 与模型配置保留。实现与固定安装为 `d15cf498`；全局 shim 指向该安装。以下旧候选小节均为其当时范围，不代表当前状态。本报告不签双 Bot E2E、J3/J4、全模型矩阵、完整 App 或长期运行。

## 2026-09-25 当前结果与剩余阻塞

- 原操作 `2e3df157…` 经受保护的当前资源资格、模型服务退出、现有 socket OFD gate 和新鲜进程/资源观察，在 `b41071e8` 的正式恢复入口返回 `restored`。原始证据、缺失事实、旧 prepared 字节与六条 unknown 保留；历史入口实际读回 `recorded`。完成发布改为一个自包含校验记录的独占原子 link，中断的准备记录不再锁住后来已正常重启的官方 Host。原子发布相关 97 项测试/357 断言、类型和文档检查通过。
- 当前原生输入为 Host `83be8f81ebfeca0625a2b084d6c516545734e6764697168672257c472b2bc006` / worker `0378b9f497f0f4b9d6f0abd281279505a48da3fe93a69640127ad081109406d3`。61 切片及四项语义检查、当前原生组合 40 项、固定 receiver/模型切换链两项实际通过。此前 2297 输入上的失败和未改代码的单例复核均保留；83be 相对 2297 仅两处构建元数据字符串共 11 bytes 改变。有限资格不等于完整 Host 或真实 provider 验收。
- 真实接管暴露并修复了启动权限遗漏：临时 Host 曾继承终端 `umask 0002`，使 Gateway 变成 `0664` 而被管理读取器拒绝。当前 helper 在发信号前绑定原生 supervisor 的 umask，启动子 Host 前应用；真实 Node22.14/22.22 夹具验证 `0022/0077`、`0644/0600` 和退出/join，未放宽 Gateway 读取检查。另一轮切换中，旧进程退场阶段耗用 22.29 秒；30 秒 guardian 到期，未提交接管。这轮保留为第七条 controller unknown，随后同 ID 正式物理恢复成功。当前整体守护窗口固定为 60 秒，单段等待仍为 30 秒。
- `7296d9fb` 与最终 `d15cf498` 的真实接管均返回 `alignment: verified`，实际 loaded source/profile/transformed 摘要与完成 owner 一致。CONT 还修复了安装根权限边界：保护运行根不被其他用户写入，允许原有 `0755`；实际 CONT 目录与文件仍要求 `0700/0600`，相关真实存储与创建链检查通过。独立复核最后覆盖到 `2b760221`；之后按用户要求由父会话直接实现和验证，未再派发审查。
- 第一只专用 Temporal Bot 的正式创建已有安全台账记录，但没有原生身份回执，状态为 `effect_unknown`。本机完整名册未出现新对象，当前原创建 nonce 缓存也没有可用回执；这些缺席事实不能证明未创建。原生输入经当前真实校验器验证通过，当前预调用路径能到达发送边界；原始调用的错误正文没有留存。没有重发该请求、改 UUID、推断名称为创建回执或清除未知记录。B/C 没有提交，模型关系、Human/DM、工具效果、A/B compact 和 follow-up 尚未执行。
- 09:35 UTC 收场读回：官方 Host、Gateway `0644`、Host umask `0022`、无 grokbox preload；此前 patched Host 已退出，modeld 原 owner 停止且 socket 不存在。49 个原有本机 Bot 的 ID/harness 保留且均空闲；models3 字节及原 52 条 controller 行未改。controller 当前 7 unknown/49 terminal/0 running；产品创建台账另有上述一条 unknown。modeld 此阶段 accepted/completed/active 与推理历史读写均为零。A 的远端原生副作用仍未知，不能据此推断远端没有对象或费用。Server/Web 为固定安装的受控前台消费者，不声明持久服务。

下一步需要原创建的可验证原生结果，或用户明确调整试验身份/未知风险边界；现有创建围栏不能靠改台账或另换请求 ID 绕过。私有来源、原生诊断、nonce 只读检查、全部失败与回执继续留在仓库外。下面保留历史演进与证据边界。

## 早期 734 候选与证据边界

- 实现候选：`734206b78af3951942b0fd9013d739f716f0672c`，已线性合入 v2；前序为 `b1d3d9a09bd5f0e81488e991352d97e3d5531d5b`。
- 包：`grokbox-0.1.0-alpha.6.tgz`，3,377,130 bytes，SHA256 `d48150f2880bf9aca89d90b7d93f7448424ab30b13286fe3b6012d6c4d9a89fc`。构建清单 SHA256 `2c197ff64bf255481fb62a427543fe2804575a2c6bbc4e30633005b99a4df6c9`；独立复查逐项核对全部 72 个产物及包内各次出现。
- 固定安装：`/workspace/opt/grokbox/releases/734206b78af3951942b0fd9013d739f716f0672c`。生产依赖闭包和全部符号链接留在安装目录内；无施工树运行依赖。
- 工具链：Bun 1.3.14、管理/CLI Node 22.22.0、原生资格 Node 22.14.0；锁文件 SHA256 `f2957cc61f63b8cb0290e4e684a685702f393318b9bcd49fa303cffe1d0296ed`。
- 冻结原生输入：Host `68a020b8483656c3eb89d0ce991bacdf089ceabb16f95549ba3084061375a68e` / worker `96c32f4dd4e99f91576a720f88b4e24281212faf76b341709b83bce2502f71a2`。实际采用前仍须重核目标字节/进程；静态回执保持 `qualified=false`。
- 独立 Astra high 复查：原主体修复闭合，b1d3 后四文件/四行增量为 **OK with notes**，未建立剩余 P0/P1/P2。原始审查、私有来源和逐笔回执在仓库外保留，非公开测试依赖。

734 阶段串行检查：类型/构建通过；原生组合 40/40，61/61 切片与四项语义义务通过，四个合法 JavaScript 反例被拒绝；受影响公共检查 52 pass / 35 skip，固定输入 receiver 1 pass / 72 assertions。全部命令已结束，产物哈希稳定。公共 469 文件清单的 3507 pass / 0 fail / 69 skip 是原分片与必要重跑的逐文件对账，**不是 734206 的新全仓运行**。

68a 相对 c361 的完整原生变化为五段、151 bytes、3 行：构建身份、Playwright settle 参数、wait-for 上限。原始纯函数探针覆盖配置/归一化差异；未声称实际 MCP 接受新参数或真实浏览器时序通过。所选 29 声明、12 owner/helper、21 执行声明和 196 Gateway 属性保持对应字节/绑定；worker 不变。历史完整 native-runtime/core-risk/core-observation 仍绑定原输入。首次原生组合的 39 pass / 1 fail 保留，原因未证；未改变代码/门/期限的重跑及独立组合运行随后通过。

## 配置迁移与管理消费者

原 daemon/modeld 的实际 V8 加载脚本、PID/start、原 Node 与依赖闭包先被保全。原 schema3 writer 在受持有的协作 guard 下只发布 disabled，排空并由原进程完成 SIGTERM 退出/socket 清理；没有强停、删除 socket、清账本或重放请求。

固定 b1d3 CLI 随后执行正式 schema4 迁移，计划 digest `b50a04265b304497db119adc439737321b1c175b946e1b6feff4051051936ec7`；原操作 `ed8ccaac-7ff7-4ace-b385-003b5d3e9504` 到达 `retired`。迁移差异仅 schemaVersion 和退役 `daemon.serve`，desired 保持 disabled。模型字节、安装文件、controller/coordinator、旧 attestation 和前次迁移回执在迁移窗口逐字节保留，五条 controller unknown 未变。

后续管理 bootstrap 是独立操作：安装身份和其他安全字段保留，仅替换 owner verifier，并保留原安全 checkpoint。connection 原 writer 以 CAS/原请求 UUID 更新默认连接的 endpoint、installationId、credentialRef；不在报告输出凭据。初次误用内部 bootstrap DTO 被拒绝，未进入 applying；修正为公开 launch DTO 后沿同一操作完成。安装文件不能跨这两次操作泛称字节未变。

本地 config、真实管理 API 已独立读回 schema4/disabled；认证连接成功。b1d3 管理 Server/Web/modeld 是本窗口的前台消费者读回，实际 argv/Node/安装目录可追溯；当时 modeld 计数为零、Host 协议尚未观察。新 734206 安装也已在隔离根从 `/tmp` 跑通：管理/模型 HTTP200、无凭据401、Web200、CLI 配置读取、modeld 启动和原 socket/进程退出。此处不声明持久服务、boot/login/crash 恢复。

## AH-123 本窗口采用前结论

固定实现、包、独立安装、适用原生增量资格、独立复查、既有授权与恢复材料已齐，可进入**一次受控采用取证**。不要求在首次采用前先证明 loaded、真实推理或 24 小时，也不把允许采用写成已采用成功。

执行边界：父会话是唯一现场写者；使用固定安装入口和原 controller。先核 modeld root/epoch/PID-start、guard、在途/unknown及当前 Host/worker，再 modeld replace、retained profile write、一次 re-adopt。旧 attestation 与开放 circuit 保留，未知 provenance 不能靠删文件改成 official。新旧 loaded/compiled/attached 事实需要实际读回。

目标为新建专用 A/B 与静默 C，原生注册 harness 创建后不修改。A/B 首选 `sub2api-deepseek/deepseek-v4.1-flash high`，实际失败才依次使用 `sub2api-codex/gpt-5.6-sol high`、`sub2api-xai/grok-4.6 high`；没有额外总 token 上限。未知请求只查原身份，不换 nonce/provider 重发。

现存模型文件有 12 个覆写，其中 9 个仍属当前注册 Bot；保留这些配置和非目标身份。未覆写 Bot 按现行 `decideRouteSession` 走官方路径；main 模板不自动应用于所有 Bot。首次接管先使用 observe，再只为新 A/B 写模型关系，实际推理窗口核对非目标影响。

选定现场义务：Human 输入、A→B→A/B→A→B、两个短任务并发、原生 DM 工具身份关联、独立工具效果读回、实际 DM root/session 证明、A/B 非 no-op 持久 compact、后续 Human/DM 和一次效果、回官方模型及完全退出补丁、仅清理本窗口对象。C 不参与发信/任务。持久服务 AH-156、完整模型矩阵 AH-125、24 小时 AH-128 保留为后续义务；本窗口不改 init/supervisor、不 Reset、不公开发布。

## 现场结果

采用前 Bot 创建预览因缺少当前 ownership 来源被拒绝，未创建对象或改走其他 writer。当时 Host 仅有进程/入口观察与 stale-attestation 状态，完整 loaded provenance 尚未签定。后续一次真实采用的失败见下一节；模型请求、DM、工具、compact、follow-up 和官方退出验收仍未执行。

## 后续 216a 候选与一次采用结果

平台来源推进后，四行版本绑定增量进入 `cff73feb5d3bfbd6da0cdedfdf008fc04124e0f9`。Host 为 `216a8b6b7bdaf9410a0ffa6727bdfe864c1f9a600618a6be2788ce6f520d0e54`，worker 不变。完整变化为六段、668 bytes、1 行；版本/构建与浏览器、桌面指导文本变化分别核对，未称整体语义等价。选定执行声明、owner、196 Gateway 属性与 61 切片不变。独立复查为 OK with notes；组合类型/构建、原生 40/40、61 切片/四语义、受影响公共检查及固定 receiver 均通过。包 SHA256 `31d97af8f820215b1947daeddb8a99a2f15d332889c41d795754c398370623d5`，3,377,117 bytes；72 个安装/包内产物独立核对一致。前述旧候选证据仍保留其原绑定。

cff73 已线性合入 v2 并独立安装。模型文件原为 version2，后续通过原 `RuntimeStore.saveModels` 的 models-write lease、原字节比较和发布前 disabled 检查显式转换为 version3；仅 `/version` 改变，12 个原绑定、模型、main、目录和凭据引用保留，原字节留档。独立复查未建立该已完成转换的缺陷；它不是放宽旧文档读取器。实际 modeld replace、固定 Server/Web 更新与认证读回通过，未声明持久服务。

只读真实 supervisor 能力核对修正了上面的 observe 建议：本机首次采用只支持现有 **route/transient** owner；observe/direct 不支持。原两个孤儿公开浏览器 fixture 经删除根/入口、原测试环境、公开 synthetic health、PID/start 和 parent 归属证明后，精确 pidfd SIGTERM 退出。未过滤完整进程分类器，未强停或删除文件。

61 切片 current-state profile 经正式 baseline/envelope/显式 capability writer 发布，实际变换字节 SHA256 `8517a3faa53d66211ac1796610c8857350ce4e5577fffbfb9c2b6f0ab3eddcc5` 与合格候选一致。随后仅执行一次 `runtime re-adopt --confirm`，原操作 `2e3df157c37defda543f049393f165cc2e098ca46c7aa622cc7808d7775b158a` 返回 recovery-required/commit-failed，并保持 unknown；原五条 unknown 不变，合计六条。

临时 Host 的原 PID/start 编译 marker 证明上述精确源/变换代码已编译返回；没有证明 Gateway 就绪、modeld 结合或采用提交。marker 的 `modeld:false` 是初始化固定值。原日志显示后来官方 Host 从当时仍存活的临时 Host 接管数据目录。完整内层失败码被控制器的 boolean 端口丢弃，临时子进程输出按既有秘密保护合同忽略；根因不能从剩余日志唯一还原。guardian 的 30 秒期限先于多阶段独立等待结束，缺少寿命结束传播和 release 原因记录；不据此伪定唯一超时原因或扩大期限。

独立故障复查要求窄化修复：保留内层原因/阶段/真实副作用事实、受限脱敏的子进程退出与就绪证据、guardian 寿命约束，以及绑定原失败操作的明确物理恢复 owner。现有 operation-recovery 的 clear 只表示租约与 running 条目不待恢复；没有公开入口可把当前 pending adopt journal 安全登记为物理恢复。未调用私有纯 helper 改状态，未清 attestation/circuit/unknown，也未再次采用。

已执行原 `runtime deactivate` 的 desired-only containment，当前 disabled；不信号 Host，不清模型绑定或旧证据。最后一次读回 49 个非目标 Bot 元数据/harness 不变且空闲，modeld accepted/completed 为零。A/B/C 尚未创建，Provider/DM/tool/compact/follow-up 均未跑。AH-183 的实际迁移与消费者读回已完成；AH-124 保持 In Progress。后续修复与隔离资格在独占源码树进行，原操作未知仍保留。上述失败不撤销其原范围的离线事实，也不形成任何 live 通过。

## 历史：修复审查与原始创建证据限制

本节记录 18e 阶段结束时的判断；后续当前资源恢复结果见报告开头。

隔离修复范围 `cff73feb..550419e7` 的初次独立审查为 **BLOCK（五项 P1、一项 P2）**：中断未等待原采用 Promise 结束、未退出子进程可能被新操作 ID 再次操作并覆盖单例证据、恢复遗漏子进程身份、未完成发布被历史读取器当成完成、异步 rename 可越过期限，以及完整 `/proc` 可见性要求阻断正常用户。后续反例又推动了 checkpoint 写入失败时的事实保留、物理完成与业务账本不确定性的分离、结构化编译观察一致性，以及所有 route authority 的完成证据检查。这些已报告源码问题在各自审查范围内均已关闭。最后范围 `6c07327e..99836167` 的独立复核为 **OK with notes**，24 项测试、146 个断言通过；两个不受支持的 route 变体经真实 store、`current`、`currentContext` 拒绝，未读取原生 ownership。合法 direct identity 与六条历史 unknown 保留。原审查、反例、失败和修复回执均未覆盖。

原现场操作还存在独立的历史证据缺口。固定临时 supervisor helper 的一次 spawn 不变量及制品字节已核对；原编译观察也绑定 PID/start、操作及 source/profile/preload 等摘要。但没有找到当时临时 supervisor 与所记录 Host 的直接父子绑定。原 journal 的 Host 为 null；后续进程扫描只记录已返回的官方链。补充找到的原 Host 健康记录仅有 PID。原会话在 41 秒采用期间没有采集父子关系。相关原始文件与检索边界保留于私有证据目录。

同入口主进程继承配置后产生 marker 的可能性，尚未被原有公开合同或受限原生来源核查排除；这不是认定现场发生过该行为。恢复仍缺一条同期直接子进程身份绑定、等价的完整受控范围退出证明，或能排除该替代解释的合格不变量。当前已知 PID 不存在、后来官方链健康及两次空闲快照不能补造该事实。**原操作保持 unknown，物理恢复尚未取得证明，后续接管与双 Bot 验收仍受阻。** 不导入补造的历史回执，不通过新 ID 重放，不清除原证据。

平台 Host 随后推进到 `688f0852fb5ac705b23a17d48603982c4c5e07544cfaeb0e96aa045295c08d98`，worker `96c3…` 未变。冻结增量包含 71 处变化、增加 10,640 bytes/239 行，涉及模型上下文键、存储同步就绪、工具结果与请求上下文、子任务 transport 等行为。61 个锚点及选定声明/Gateway 属性的结构检查不变；这些事实不证明传递依赖或完整 Host 行为。四文件、四行绑定增量已单独合入组合候选，没有重放原生工作树的累计补丁；216a 证据保留原范围。

## 组合候选 18e3：源码闭合、所选资格与独立安装

修复按原顺序移入 `6a494668` 之后，再加入上述四行增量，得到 `18e3e69624b24679f19fd341975a09fbd055eb6a`。与独立审查的 `99836167` 相比，额外差异只有两份已有现场报告和四处原生绑定。该实现已线性合入 v2，原提交及各次独立审查仍可追溯。

对冻结 688f 的六组原始片段/受控依赖探针，首次 context 执行因测试装载遗漏一个依赖常量而出现 ReferenceError；当次 0 通过、其余五组未执行，失败留存。随后补入冻结源码中的原值 60,000 ms，没有扩大期限。原 72 项选择和其他执行/断言文件保持字节一致；新增标量及装载顺序经 AST/哈希核对后，修订清单 `d5234a17…` 下的 context、mirror、mcp、draft、subagent、interop 六组全部实际执行通过，每组退出与同次 stdout 回执验证均为零。它们不签整个 Host、完整镜像 I/O、RPC/工具路由、provider 或采用。

`18e3e696` 的串行组合检查已完成：类型、构建通过；61/61 静态切片与四项具名语义检查通过，静态工具仍报告 `qualified=false`、覆盖不完整且尚未发布 profile；冻结原生组合 40/40；受影响公共检查 137 pass / 35 skip / 0 fail、725 assertions；receiver 1 pass / 72 assertions；原生 AgentStore/worker SQLite 与独立 Node 读回后的模型切换链 1 pass / 53 assertions。后两项使用冻结输入和拥有的测试上游，没有外部 provider 请求。文档 16 项/1740 assertions 通过。历史 3507 项公共对账和其他原生组仍绑定原范围，不代表此提交的全仓重跑。

包为 3,389,985 bytes，SHA256 `c295326a8714e149a91566d4c7c777d3a99fcc6c80a6e52febac7f0316db0fee`；构建清单 SHA256 `9137f881d378a2e5e32c37520369cb6881ead3befd5b6476aaea977a5743ea67`。72 个产物及包内各次出现逐项一致，重复 `bin/grokbox` 的内容/模式相同。Bun 打包只重排了 `package.json` 格式，全部 JSON 字段一致；其余 96 个包文件逐字节匹配。固定安装位于 `/workspace/opt/grokbox/releases/18e3e69624b24679f19fd341975a09fbd055eb6a`，5244 个生产依赖文件和 84 个链接核对一致且闭包留在安装目录内。最初字节比较拒绝的暂存目录与回执另行保留。

独立安装从 `/tmp`、隔离配置根启动：管理/模型 HTTP200、无凭据401、Web200、CLI 配置校验和 modeld ready 均通过；烟测进程完整退出并自行清理 socket。没有连接实际 Host、发布新 profile、切换现场服务或全局 shim。19:42 UTC 的实际只读回查仍为 schema4、models3、12 个绑定、desired disabled；原操作保持 unknown，合计六条 unknown、46 条 terminal、无 running/reserved。modeld 原 epoch 保持 ready/wire8，accepted/completed/active 均为零。A/B/C、真实 provider/DM/tool/compact/follow-up 和官方退出验收继续未执行。**在 18e 阶段结束时，源码与安装资格尚未补齐原操作的历史创建关系；AH-124 当时保持 In Progress，现场恢复为 BLOCKED / bounded UNPROVEN。后续恢复与实际采用结果见报告开头。**
