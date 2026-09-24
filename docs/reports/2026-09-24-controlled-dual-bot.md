# 2026-09-24 受控迁移、固定候选与双 Bot 窗口

本报告记录 AH-183/184/185 → AH-162/122 → AH-123/124 → AH-186 的同一授权窗口。当前为**采用前资格已齐、实际接管与双 Bot 验收待执行**；后续结果在本报告续写。它不签 J3/J4、全模型矩阵、完整 App 或长期运行。

## 固定候选与证据边界

- 实现候选：`734206b78af3951942b0fd9013d739f716f0672c`，已线性合入 v2；前序为 `b1d3d9a09bd5f0e81488e991352d97e3d5531d5b`。
- 包：`grokbox-0.1.0-alpha.6.tgz`，3,377,130 bytes，SHA256 `d48150f2880bf9aca89d90b7d93f7448424ab30b13286fe3b6012d6c4d9a89fc`。构建清单 SHA256 `2c197ff64bf255481fb62a427543fe2804575a2c6bbc4e30633005b99a4df6c9`；独立复查逐项核对全部 72 个产物及包内各次出现。
- 固定安装：`/workspace/opt/grokbox/releases/734206b78af3951942b0fd9013d739f716f0672c`。生产依赖闭包和全部符号链接留在安装目录内；无施工树运行依赖。
- 工具链：Bun 1.3.14、管理/CLI Node 22.22.0、原生资格 Node 22.14.0；锁文件 SHA256 `f2957cc61f63b8cb0290e4e684a685702f393318b9bcd49fa303cffe1d0296ed`。
- 冻结原生输入：Host `68a020b8483656c3eb89d0ce991bacdf089ceabb16f95549ba3084061375a68e` / worker `96c32f4dd4e99f91576a720f88b4e24281212faf76b341709b83bce2502f71a2`。实际采用前仍须重核目标字节/进程；静态回执保持 `qualified=false`。
- 独立 Astra high 复查：原主体修复闭合，b1d3 后四文件/四行增量为 **OK with notes**，未建立剩余 P0/P1/P2。原始审查、私有来源和逐笔回执在仓库外保留，非公开测试依赖。

当前候选串行检查：类型/构建通过；原生组合 40/40，61/61 切片与四项语义义务通过，四个合法 JavaScript 反例被拒绝；受影响公共检查 52 pass / 35 skip，固定输入 receiver 1 pass / 72 assertions。全部命令已结束，产物哈希稳定。公共 469 文件清单的 3507 pass / 0 fail / 69 skip 是原分片与必要重跑的逐文件对账，**不是 734206 的新全仓运行**。

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

采用前 Bot 创建预览因缺少当前 ownership 来源被拒绝，未创建对象或改走其他 writer。当前 Host 仅有进程/入口观察与 stale-attestation 状态，完整 loaded provenance 尚未签定。真实接管、模型请求、DM、工具、compact、follow-up 和官方退出结果待后续实测填写，未计通过。
