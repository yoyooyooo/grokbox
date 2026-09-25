# Host 更新现场断链：安装级 intake 与实际来源保全

## 起点与产品修正

接手 `e5979b98` 后，正式管理读面实际显示：Host 来源变化已观察到，但 OBS collector 为 `not_configured`，health journal 有 64 条未确认记录，latest 停在 sequence 63；通知接收者未配置。不是 Host 更新没有发生，也不是需要更多资格脚本，而是安装级来源观察被错误地绑在 Bot monitor 配置之后。

同一现场的 27,689,642-byte Host 来源使用 gzip level 1 后，单独 base64 已达 9,724,080 bytes，超过原 8 MiB 附件总额。因此前后 evidenceRef 一直为空；保全重试又在未运行的 intake 前累积。实际来源只读测量不执行 Host，也不证明新版业务兼容。

本次修正复用原 owner，不增加 watcher、数据库或修复 Agent：

- 有效安装配置下，Host 观察默认由原管理 Server collector 提供安装级 intake，零 Bot 目标、不读原生名册、不调用模型。已有 Bot 监控仍用同一个 Scope 串行替换；无配置文件、坏配置或明确关闭观察不会隐式启用默认路径。
- 只初始化全新观测目录；既有目录缺库、损坏、旧 schema 或活跃其他 collector 继续拒绝，不以重建历史解决问题。允许 owner 控制、不可由他人写入的 0755 安装根；私有观测子目录/文件仍为 0700/0600。
- 大来源改为异步 gzip level 6，不扩大附件配额或改格式。真实来源经原 capture/read/decompress 路径，保存为 7,778,658 bytes，原字节准确读回；临时材料随后清理，未写现役来源或 profile。

## 已执行的检查与范围

声明工具链 Bun 1.3.14、Node 22.22.0。根/Web 类型、完整构建、runtime boundaries、文档检查通过；安装级生命周期与来源保全 17 个用例通过，包含 0755 根、新初始化、关闭/重启、旧 ledger 缺失拒绝及活跃 epoch 不被夺取。原 OBS 管理 15、Host 健康 19、通知管理 48、运行见证 26、handover 20 个真实 Node 内层用例通过；外层包装不重复相加。原 packed collector 退出/重启及 monitor store 检查通过。

最初 OBS 管理回归暴露默认 collector 与手动 fixture seed 竞争；修正通用自有 fixture 的明确 observation=false 和不存在配置不启动规则后，保留原读只读/身份/游标断言重验通过。一次全来源 Python 差异比较超时，未视为兼容性结论；随后使用有界原 Git diff 获取实际变化范围，未扩大检查或改写源码。

本轮按用户指令不派发 subagent；实现者自测不冒充独立复核。这里首先记录源码和原生来源存储范围，不签新 Host 可采用、真实 Bot 回合、普通用户通知、自动冷启动待办接续或整个双 Bot E2E。当前实际运行结果只回填原 LIVE。

## 真实尺寸暴露的管理线程阻塞

第一版固定制品的观察开启烟测在 `/v1/host-health` 原五秒请求上超时，尚未上线。直接测量同一真实来源：capture 到第一次让出事件循环耗时约 6.9 秒，另一次配方预检约 3.4 秒；最大事件循环停顿约 7.0 秒。这是同步大文本计算阻碍管理响应，不是新增 Bot 证明缺失，也不证明此前 Host 的具体退出原因。

修正采用原 transformation 的逐切片生成器：preload 同步消费，背景分析在切片间让出执行权并响应取消，不新增 worker/controller 或另一套配方规则。窗口保全不再为每个切片重复复制整份来源；异步计算后仍复核同一来源与代际。相同输入再次测得第一次让出约 55 毫秒、最大停顿约 228 毫秒，总计算时间没有伪装成零；这些是一次测量，不是所有环境的时延承诺。原精确 SHA、重复锚点、替换结果和失效拒绝保留；另验证挂起时调用者改动配方不会改变已开始的计算、取消会终止背景步骤。

此变更的 Host-health 19、packed witness 26 个 Node 用例及共享 transform/背景源读取检查通过；独立安装的 API 响应和十秒退出上限保持，不靠关闭观察通过。

## 固定安装与实际 intake 恢复

`e468ba99` 已线性合入 v2，独立安装的默认观察开启、真实来源只读烟测通过：原五秒 HTTP 请求无超时，原十秒退出上限下实际约 64 毫秒退出。随后仅替换现役管理 Server/Web，不切 Host、不启动 modeld、不改配置/模型/原 controller 字节；全局 CLI shim 未修改。

13:10 UTC 实际读回：原 64 条积压记录已确认入库，后续 sequence 64/65 继续发布，Host/runtime intake 均 committed，真实附件可用。期间官方来源又更新到 `8aeda5f9`（worker 仍为 `0378b9f4`），本次是自动观察而不是人工代写；观察器运行状态与旧 profile 不再适用分开。旧 `99eb` 的 BEFORE 附件缺失仍如实保留，不能反向伪造完整历史。

## 保留完整配方的新来源刷新

进一步实施 `--refresh-reviewed`：原发布者在一个原子写中把现有全部审核切片绑定到新 retained source，校验原 reviewed 文件摘要并在 gate 内重核，不先发布 core 再补回其余能力。原窗口 drift 的准确 slice review、原生 pair 资格、源码/输出摘要要求保留。两个 current-state 注册切片内嵌来源身份；仅完整旧模板吻合时重绑这两个声明槽位，并明确返回 reboundIds，其余切片字节不变。模板有额外修改则要求显式 recipe review，不做任意哈希替换。实际原 61 切片经两处重绑后，与本次通过原生资格的完整配方相同；该命令不改业务逻辑、checkpoint 数据或运行状态，也不冒充自动维护授权。

`8aeda5f9/0378b9f4` 的原生隔离组 40/0（native Node 22.14.0）、原生接收模型与持久化后切换两项通过；这些与 CLI 本身的声明 Bun/Node 验证分开。CLI 实际解析→原发布者的完整刷新、错误摘要拒绝、全部切片保留，以及 gate 内并发写入拒绝已测试。新绑定不是任意未来 Host 的资格；完整 Agent 自动修复/策略授权仍属原 AH-189/AH-190。

## 真实采用与创建意图缺口

`433184fb` 已固定安装并替换管理 Server/Web；原发布者完成 61 切片 source refresh，随后原 controller 对当前来源真实采用，返回 `alignment=verified`。这是该时点的运行事实，不是模型、DM 或未来来源保证；原恢复历史没有重跑。

原 B 的旧计划是 Temporal，不能验证 Box-local modeld。正式原请求查询为 not_found、未曾提交后，在本窗口明确改为 Box/deferStart=true，保留原名/描述/requestId，重新 preview 后首次提交。原生返回明确 ID，回执 complete，但独立 readBack 为 Temporal/mismatch；这不是 A 的 unknown，也不能再提交 B 原请求。A 原未知、静默 C 和其余用户 Bot 没有被重放或改 harness。

从实际原生创建方法追到出站口：显式 Box 只使 wantsTemporal=false，base 请求未包含 harness，服务端因此仍可按默认创建 Temporal。新增一个精确 `native-create-box-harness` 切片，只让明确 Box 意图进入原出站请求；默认与 Temporal 保持原样，服务端授权/拒绝不绕过。当前原方法与修后方法在有限隔离环境执行至同一 requestMint 边界，4 个原生用例通过；不伪造服务端回执或声明实际 Box 创建已通过。后续应使用独立未提交对象读回，不重发已完成的 B。

此能力使完整配方从 61 扩展为 62。原有历史完整 envelope 仍可读取，缺的新能力明确要求 review，不能把历史黄金样本一律判损坏，也不能假称历史已验证新切片。普通 CLI/原发布者/transform 与相关 envelope 检查通过；真实创建读回与必要清理仍需实际结果。

## 最后收口：已交付与尚未采用分开

新增 `native-creation` 是原 profile publisher 的有限能力选择器，只追加/更新 Box 意图切片，保留其它 reviewed 能力；不会要求先完成整个 current-state 升级。对现役 61 切片的只读分析已给出准确结果：只新增 `native-create-box-harness`，原 reviewed 摘要一致，required review 也只有这个 ID。正式 CLI 选项、原 writer 及新能力的源检查通过，未直接改写现役 profile。

最后一次服务切换调用被工具层拦截，私有切换目录只有脚本、没有 admitted/start 记录，进程仍明确指向 433。当前 Host/runtime intake committed，来源 exact、静态检查 passed、companion matched、运行代/witness current；这只支持仍在运行的 433/61 切片，不支持未上线的创建修复。最后正式 modeld 读回 ready、accepted/completed/active 都为零，原 7 个 controller unknown 逐行未变，模型文件摘要与原窗口相同。

最后正式名册含 50 个 Bot：原 49 个 ID/harness 均匹配，加本次已返回 ID 但 Temporal/mismatch 的 B；B 未运行，也未被删除或迁移。A 原请求仍 effect_unknown/result null，C 未提交。现役 Server/Web/modeld 与 Host 的本轮 adopted preload 为 433；全局 shim 因工具路径范围未修改，仍 e597。新的固定安装与源码合入不等于服务已经切换。最后可恢复入口与准确提交记录在原 Linear 及本窗口私有结果，不把同名旧脚本当作新授权重跑。

下一步仅在工具允许执行后切换已固定制品，通过原 publisher 追加这个已审能力，再经原 controller 核对加载，并对尚未提交的静默 C 取得一次 Box 创建读回。B 已有已知结果不能重发；真实模型/双向 DM/工具/compact 与清理保留为后继验收，不新增全局证明前置。

## 接回主线

原操作物理恢复已完成，历史 unknown 不重开。当前 Host 无补丁与其准确来源资格分别处理；已有合格候选的重新加载不应等待 Agent 修改补丁。新来源的 codec/worker 与运行前提仍需针对受影响契约核对，不能从窗口无变化推造整 Host 语义等价。A 原创建 unknown 保留，B/C 独立声明不再受旧全局创建围栏阻挡；实际身份、模型、DM、compact 与非目标收场继续按原场景记录。

## 本地接手：13740 来源资格

本地正式入口重新确认 Host `13740b50`、worker `0378b9f4`，Server/Web 仍 433，modeld 已 071；原 A effect_unknown、B complete/Temporal/mismatch、C not_found。当前完整名册恢复可读，原 49 个 ID/harness 与七条 controller unknown 保持，模型字节与接手基线一致。

62 个配方切片均准确应用。原发布者的完整 61 切片刷新无 required envelope drift，两个注册身份槽按原模板重绑；管理 API、模型选择相关九个原生声明字节未变。本次只更新精确 native tuple 与独立测试 pin，不扩大为未来来源放行。静态 verifier 四项正例和四项合法语义反例通过；原 native-pair 中 39 项通过，剩余一项因新增创建切片后仍预期 61 而失败，修正为 62 后单独复验通过。另有创建参数链、接收模型和原 AgentStore/worker 持久化后模型切换共六项通过，根类型检查与构建通过。工具链为 Bun 1.3.14，原生 Node 22.14.0。

这些是有限隔离资格，尚不代表固定安装、Host 实际加载或真实 Box 创建/业务通过。本轮不派发子 Agent，未声称独立审查；AH-124 不重开。C 仍为静默对照，业务工作者须使用独立明确声明。
