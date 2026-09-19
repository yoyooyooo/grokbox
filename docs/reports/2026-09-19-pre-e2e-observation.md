# E2E 前观测、持续采集与恢复接线 · 2026-09-19

本报告固定在 `91142f4` 基线之后的实现与离线验证，不维护第二份当前现场表。当前状态只看 [LIVE-OBS-EVIDENCE](../tickets/LIVE-integration-validation.md#live-obs-evidence)、[MONITOR-PERSISTENCE](../tickets/LIVE-integration-validation.md#live-monitor-persistence) 与 [OBSERVER-LIFETIME](../tickets/LIVE-integration-validation.md#live-ops-observer-lifetime)。源码职责仍分别由OBS-00/01/02、T44/T45/T50及OBS-06拥有；完整跨owner配额和安全退役不能被本片代签。

<a id="producer-boundaries"></a>
## 1. 实际写入边界与证明边界

| 要求 | 当前生产接点 | 必须保留的限制 |
|---|---|---|
| E01 身份 | 原Host/modeld/run/tray身份与关联 | 无STEP事件不能补造STEP；父子关系不能按名字猜 |
| E02 事发制品 | Host hook_enter带build/wire及source/profile/transformed，modeld terminal带实际build/wire | 配对需相同Agent/TURN/Host代及build/wire；事后查询不能改事发元组 |
| E03 Provider/SDK | 沿用实际请求、编码/规范化与错误见证 | 无Provider回报的内部effort仍not-observed，不凭错误文本补完整度 |
| E04 工具 | 原生handler入口/返回/失败；PromptExecutor接收已释放toolCall结果 | 两者匹配STEP/toolCallId及执行身份；handler可包括审批等待，不证明批准或外部业务提交 |
| E05 context | 原生owner checkpoint开始、ACK与commit_unknown，保留操作及旧/新root | ACK不替代新进程独立持久读回，不吞掉真实提交未知 |
| E06 任务 | 原queue observer的queued/started/结束事件与有界活动窗口 | 父任务终结不证明所有Temporal/外部子任务终结，App展示另验 |
| E07 告警 | 沿用原生tray attachment/decision/lifecycle | 不证明App已经收到或用户已读 |
| E08 来源健康 | collector读来源/字节/积压；同次ownership响应里的native任务窗口 | 文件可读不等producer存活；缺窗、旧代、超龄、丢任务保持缺口 |

Host只增加安全元数据与纯内核投影，不引入Effect/SQLite/CLI或第二执行器；没有采集原始prompt、工具参数/结果、摘要或私有原生代码。modeld terminal与原journal reader共用已有事件链。固定revision不因后续查询和新事件被修改。

Native run窗口最多256任务、32个显式目标，原始观察超过5秒或coverage不完整时不判stall；正常队列、工具/审批等待和不在窗口的任务不猜死锁。模型流实际消费才更新progress，健康轮询不会续鲜它。并行工具全部结算前持续标tool_or_approval。可疑停滞仍是suspected，不自动取消、重试或换模型。

context新增观察I/O后必须重新检查取消/原root，才允许native发布；关闭等待在途观察和checkpoint结算，无法结算沿原cleanup_unknown处理，不能放出晚写者。诊断sink抛错不改变已经发生的native提交事实。

<a id="collector-lifetime"></a>
## 2. collector 的真实服务出口

`runtime monitor install --run-root ... --agents ...`默认只读预览。确认时使用原config CAS/operation机制，先初始化或迁移观测库，再保存唯一`daemon.observation`意图。匹配schema4，不新增配置文件或编排服务；命令本身不启动daemon，已运行daemon会随后采用新配置。相同operation重入先校验原指纹，不能重建丢失的证据库或偷换今天的storage策略。

`runtime monitor service --json`只查询现有daemon。daemon listener持有一个Effect collector子任务：明确目标和canonical runRoot，消费Host/control两份journal，各有持久游标和独立健康。配置变更、off或移除后先退出并结算旧collector，再启动新配置；不重置游标或凭空刷新上代健康。没有配置不建库、不调用原生；配置坏/库缺失保持阻断，不恢复默认。

慢原生RPC不挡本地drain；正常从未创建的journal与已有来源消失分开；周期检测使用原生源窗口，不把文件读成功当liveness。通知关闭只影响新通知意图，不关闭已有本地采集与必要维护。该实现不是OS开机注册或平台Reset恢复保证；`bootInstalled=false`明确保留。

## 3. 从真实故障修复 daemon 重启入口

实际打包Node旅程最初在强杀后的第二次启动失败：不是SQLite游标问题，而是旧Unix socket还占路径。现有daemon仅独占bind，没有确证的遗留socket回收。

现复用项目已有Linux advisory fd gate，门的固定inode不删除，fd随进程死亡自动释放。绑定后原子保存精确socket inode、代际和内部进程启动身份；恢复只有在旧owner确证死亡/身份变化、socket仍同inode且连接明确拒绝时进行。超时、活进程、未知/损坏owner、普通文件、符号链接及旧无记录socket全部保守拒绝，不按年龄或PID猜测删除。

owner与暂存各至多4KiB，固定暂存槽不积累随机文件。监听竞争失败会结算先创建的事件/Jobs/desktop/title等资源，退出先结算collector/sender，最后关闭监听并释放精确owner。非Linux仍使用原独占bind，不声称同等自动遗留恢复。bind后尚未写owner时崩溃和撕裂记录保留明确阻断，不能将有限探针宣传为任意掉电安全。

<a id="old-event-fence"></a>
## 4. 组合验证发现的历史故障误补发

过去automatic选择只检查work.created_at晚于授权，未考虑延迟采集。实际新反例中：故障发生在授权前、日志随后才被索引，work在授权后创建，旧代码真的向loopback端发出了第二次POST。

已同时修复工作选择查询与直接自动发送入口：incident.first_seen和work.created_at都必须处于本次授权之后且不在未来；来源时间缺失时拒绝。历史故障仍可本地查询，显式用户确认的发送语义不变。该修复不构成备份恢复fence，也不能识别原生端没有可靠发生时间的重建事件；对应来源仍必须保留未知与覆盖限制。

组合旅程现在通过原observer生成任务失败，经真实journal、服务内collector、SQLite固定revision/outbox、既有私有配对/授权和自动sender进入loopback HTTP。不是手工向SQLite插入一条通知冒充故障被发现。重启collector/sender后同work不重复发，通知引用的同一revision仍原样可读，关闭后无数据库晚写。原生运行边界为owned fixture，HTTP/数据库/文件/独立Node为真实依赖；不代表生产Bot已送达。

<a id="verified-candidate"></a>
## 5. 可重复验证

```bash
bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation
```

续作已完成完整`pre-e2e-observation`组合：138 pass / 0 fail，17文件、2091断言；类型、构建、运行时边界、含未跟踪文件的隐私检查通过。验证前后source摘要同为`4ee83206fb9245c597a13d5705532ee7e9390b89110370697bf57f5ad0e125f8`，真实preload为`d3bc024f7d8e3ddac0effd5cca63548d3aa461666815b991d84dbd69fce71de7`。该回执只针对本切片，后续预算/退役/安装变更需重新验证。固定Bun1.3.14、原锁文件与Node支持下限；没有新增依赖或改变models/wire版本。新增命令已登记到LIVE覆盖映射，原有稳定锚点与公共J1保持。

独立原生隔离探针：`GROKBOX_TEST_NATIVE_CONTINUITY=1 bun test packages/box-runtime/test/native-observation-boundaries.test.ts`实际3 pass/0 fail、23断言；对照当前固定Host源并完整应用profile，选定原生tool方法在受控边界执行一次成功/一次失败，没有读取真实Bot数据、执行真实工具或复制上游实现到仓库。默认公开测试跳过这三项，不能计作原生现场通过。

首次全CLI回归出现6项失败：五项源/packaging/Host profile测试来自合成Host缺新工具观察anchor，一项是新增命令未进LIVE映射。补齐最小合成壳和精确覆盖后对应组通过。首次packages全目录2045 pass/47 skip/2 fail，两项为旧slice白名单未登记新增观察点；只补名单，不放宽其他断言。

<a id="restore-fence"></a>
## 6. 续作：自动通知的数据库恢复防护

本轮新增实际worker持有的有限防重放状态，独立于可被还原的SQLite。worker启动时冻结新的接受边界，启动前故障/旧work不会因数据库恢复被自动补发。真正POST之前记住由scope、rule、occurrence_key和原始first_seen导出的稳定身份；同一故障即使重建新work ID也不能重复发。结果unknown同样保护，不能由HTTP错误清掉guard。若live记忆仍在但还原库已丢attempt，精确work进入unknown隔离，不伪造已接受且不阻挡后续新故障。

guard最多4096项，仅在原work期限与原始发生的15分钟窗口都过后回收；时间高水位使时钟回拨不能重新打开过期区间。实际备份/还原证明包含accepted、HTTP unknown、worker重启、新work ID、后续新故障继续发送、容量及30轮到期回收。该机制只保护自动通知，不覆盖显式人为发送、所有业务ledger、整机时间倒退或恢复后的累计费用回退。

最终`pre-e2e-observation`专项145 pass / 0 fail，18文件、2179断言；source前后为`a60c8fe5e0903ceed7eaa74e67333262e0c22494489be562f4462ae1bb05bbbb`，实际preload `21c49e113a0b7b8e6058e4d90ec98aa93e7432bf48fe53cbbcb5a62d9693df6c`。类型、构建、真实仓库导入边界和隐私检查通过；该数字包含原切片与本轮guard，不能再与前一组138相加。

## 7. 验证宿主与环境的剩余阻断

当前canonical kernel exports新增了monitor/observation/continuity/routines/inference/commands，但源码tsconfig路径曾未同步，已补齐精确路径及自动清单测试。shim安装器的Bun定位和版本探针增加有限等待，测试子进程等close并清理自有目录；不执行现役shim安装。仓库外CLI及shim有过一次2项成功复验，后续仍复现版本子进程超时，故不能宣布该通路最终稳定。

本轮全CLI尝试771 pass / 2 fail / 1 error，失败在local-shim。运行时全目录和90文件第一组均遇到架构检查的隔离空preload esbuild超时，未取得完整结果；单独架构组24 pass / 2 fail。真实仓库边界检查通过，但不能替代这两项隔离fixture。没有调大期限把超时算成功，也没有取消负例的结构化拒绝要求。专项145项与kernel全组270 pass（31文件、1335断言）是限定有效证据，不是全仓通过。一次进一步编译器探针被工具拦截，未绕过重试。

本轮只读核对目标环境PID1为tini，system/user两种systemd状态均offline；没有把systemctl二进制存在当作可用启动owner。不安装无资格的systemd unit，不修改官方supervisor，不以nohup/临时daemon声称boot注册已经实现。T40/T50需先形成受支持的环境启动接口，之后才有实际安装/重启验收。

## 8. 未签范围与部署边界

本片没有切Host/modeld、生产daemon或全局shim，没有迁移现役schema、创建Bot/Routine、领取凭据或POST原生端点。独立复审状态和最终合入范围以本片收口回执为准；实现者检查不替代独立报告。

仍有真实的非live任务：OS启动服务注册、全安装跨owner物理预留、执行/维护/通知与provision安全台账的有界退役及备份恢复fence。OBS-04/05与T40/T50继续承担；`installationBudgetEnforced=false`未改，不能把本片完成称为E2E之前所有来源票已Done。已实施的观测/collector可支撑后续小范围现场资格，但全面开窗仍遵守固定v2、审查、旧制品/配置退路与成套schema4采用要求。
