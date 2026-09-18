# modeld 写入端日志轮转与独立存储取证 · 2026-09-18

本报告记录 `8835fcf` 之后的实施与离线证据，不维护当前现场状态。合同归 [专项 Spec §8](../roadmap/template-ops-automation-spec.md#storage)，实施归 [OBS-04](../tickets/OBS-04-bounded-observation-storage.md)，当前验收只看 [LIVE-OBS-STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage)。

## 实现选择

原 `replaceModeld` 将 detached 子进程 stdout/stderr 接到无限追加的 `modeld-process.log`。仅 rename 外部文件不能切换子进程持有的 fd；由短命令持有日志管道又会让长服务依赖命令存续。

现在由实际 modeld 服务在拥有 listener 后创建 `bounded-process-log.node.ts` writer，在同一 Effect Scope 内写入有限结构化生命周期记录。borrower 和未取得 listener 的竞争者不获取 writer，不轮转或删除原服务日志；结束时先结算日志写入和关闭 writer，再由 listener owner 释放 socket。诊断失败不变成推理或启动失败，启动回执单列日志 available/unavailable。

默认单段4MiB、总32MiB，年龄策略72h在写入或重开时执行；闲置进程没有新增字节，不宣称已经有独立定时TTL删除器。固定数量的段带持久序号、generation和schema header。writer关闭旧fd后才淘汰已关闭段；新进程开启新段，不接写可能残留半行的旧文件。最大64个固定槽的检查有界，拒绝损坏header、符号链接、额外硬链接、路径/inode/文件大小变化，不全盘扫描或清全局Trash。原子性仅限所执行的文件步骤；存储损坏可以使日志降级，不承诺任意掉电后无数据损失。

这不是全量stderr捕获。日志仅允许ready、listener_failed、shutdown_requested等公开枚举和必要本地身份/时间；不落盘原始异常栈、Provider body、凭据或工具正文。详细请求故障仍由现有结构化journal提供。正常交互CLI保留原输出；replacement的raw stdout/stderr改为ignore，由新服务自己记日志。旧raw文件只计量、不自动删除，已有旧服务须正常换代才不再持有旧fd。

## 只读存储状态

`runtime storage status`继续明确监控数据库的主文件/页/辅助文件范围，另附processLogs分区。未配置runRoot时为not_configured，不猜另一个Box；monitor库不存在/读取失败时为not_initialized/unavailable，仍返回独立进程日志的可用证据。查询不建目录/库、不修权限、不GC。

`installationBudgetEnforced=false`保持：SQLite128MiB与本片process32MiB的局部上限不等于整安装512MiB预算。进程日志分区明确rawStdioCaptured=false和legacyFileManaged=false。其他producer、结构化journal分段、备份与全安装容量仍有施工范围。

## 可执行证明

固定Bun1.3.14。日志初片类型检查、构建与22项集中测试通过；后续补独立storage facet后，最终类型检查所在联合调用被工具安全检查拦截，没有通过另一个入口重试，故最终typecheck仍未取得回执。之后独立构建成功，最新4文件专项为 **20 pass / 0 fail / 2673断言**，不将前一版本的类型结果算成最新通过。

- `process-log-rotation.test.ts`：25代、每代30条真实写入，段总量不越8KiB测试预算；有效NDJSON、序号跨重启、崩溃半行保持、400次并发offer有界丢弃、未知文件/符号链接拒绝、TTL及policy缩小只清本owner段，旧raw及用户文件保持。
- `process-log-modeld.test.ts`：实际打包Node owner→borrower→SIGTERM；borrower前后日志字节相同；再由正式replacement程序在可丢弃目录替换精确Node服务，独立检查新PID的fd1/fd2为/dev/null、新代段存在、旧raw文件字节不变；测试未启动原生Host、Bot或Provider。
- `modeld-running-failure.test.ts`：实际listener close/error后owner收束并记录有限原因；取消记录shutdown_requested，不误报listener_failed；日志目录不安全时服务仍ready且不写穿符号链接。
- `monitor-incident-cli.test.ts`：actual CLI只读输出独立存储分区；缺monitor也可看到进程证据，无初始化/修复/网络。

随后当前候选的E09拒旧制品、modeld生命周期/启动失败、CLI lifetime和LIVE索引回归另有 **36 pass / 0 fail / 232断言**；与前述20项合计56项（不沿用更早候选的全仓数字）。含untracked的928文件隐私扫描零命中，git diff whitespace检查通过。最终typecheck与独立review缺口保持。

实际preload SHA-256为`9e39c7487d016e7a418e3e0ed1c3d2852af921ff7bbe0be5a4529be96d173d6a`，E09 pin按真实构建更新并已通过拒旧制品测试。新增`verify-runtime-rebuild.mjs process-log-rotation`组合这些现有测试与原生命周期/边界/隐私门；该整组尚未在最终候选上取得回执，不能把注册verifier当通过。

## 前置、复核与现场边界

已提交的前片为`8835fcf`（本地incident/不可变证据/SQLite局部容量与采集调度），其专项验证64项、边界/构建/隐私检查通过。一次只读独立复核使用指定Astra渠道返回上游503，未取得审核报告；实现者测试不替代独立review。

本报告不签实际live采用、长期服务安装、全安装容量、结构化journal、其他process producer、原生Webhook/目标配对或执行安全状态退役。没有创建Bot/Routine、花业务模型额度、发布Issue/模板或重启现役Host/modeld。后续进入固定v2候选后，按LIVE逐项登记实际窗口，不用可丢弃Node替换测试冒充现役重启。
