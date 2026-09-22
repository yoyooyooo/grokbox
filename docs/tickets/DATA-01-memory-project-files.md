# DATA-01 · Memory、Project 与文件的统一材料能力

状态：实施中。显式本地三层Memory、Project描述/membership与文本索引/替换保持；named-root元数据、二进制上传下载、源变更、可恢复删除与原删除恢复已接通统一Server/CLI/Web，旧fs/daemon文件入口退出。原生源修改、Project附件/fileRef、上游账号/同步资格和长期安全维护仍未闭合。依赖 CLI-01 的范围/引用、CLI-02 的操作/并发、CLI-03 的观察合同；由 CLI-05 集成，CLI 和 Web 共用，不归页面维护源数据。

## 用户结果

在已授权、已接入来源内检索 Memory 和 Project 文件，定位原位置、显式读取正文，并通过真实 owner 修改已核验支持的内容。全局不等于全账号可见。

## 先核验的高成本边界

- 按 agent/user/project、原生 Project/membership 与文件来源列出读取、检索、修改、订阅能力、事实 owner 和资格限制；先探明关键写入/读回路径，不从候选命令名推定完整 CRUD。
- 稳定引用带安装/账号与来源范围；同内容 hash 不跨来源合并身份，文件 mtime 不推导作者/完成度，Git root 不代替原生 Project。
- 原内容、派生索引、已采集变化历史分别管理。可重建索引有初始扫描、增量更新、有界校准及新鲜度/缺源说明；不能补造历史或修改索引冒充源写入。
- 源修改复用领域操作和实际支持的并发边界，必要 readback 与索引追赶分开；文件通路不能绕过 Memory/Project 的写权限。
- 扫描、正文、搜索、队列、存储均有预算，隔离慢源/坏条目；源凭据和私有内容不得进入元数据列表或公共证据。

具体 adapter、索引实现、表结构与分页参数留给实施。原生资料继续接入；旧开发期索引不要求迁入，不授权清理源数据。

## 当前实现与来源资格

材料对象是带安装/来源绑定的**文档**，不是新的 Memory fact 身份，也不是完整上游账号清单。原生布局核对延续[来源可行性记录](../reports/2026-09-19-webui-source-feasibility.md)：本轮读取原生源码副本中的 `MemoryService`、Project membership 与 Gateway/transcript 管理入口，确认 Agent、User、Project 分片及独立 `projects.json`。已观察到的 `getAgentMemories/deleteAgentMemory` 不能推出全局 User/Project 的写入 API；本轮没有通过直接编辑分片来冒充该能力。

| 来源 | 已接入范围 | 修改边界 |
|---|---|---|
| Agent Memory | 显式 Bot 清单内的 profile/log 文档 | 原生副本只读；不声称 prompt snapshot 已失效或下一 TURN 已采用 |
| User Memory | 同一清单内的 by-agent 分片 | 保留分片身份，不按内容 hash 合并 |
| Project | 显式 slug 下的 project.md、所选 Bot 的 Memory 分片与 membership | membership 只显示授权 Project，不从 Git 路径猜成员；原生写入仍待资格 |
| 索引文件来源 | 显式材料根内的受限UTF-8文本/全文检索 | 既有writable文件通过原材料writer替换；索引来源不能同时成为named-root写别名 |
| Named-root文件 | 绑定安装/根策略/inode的目录元数据、显式正文与64MiB内二进制 | 原Box描述符writer承载新建/替换/mkdir/upload/download/trash/restore；metadata/content/write/delete/restore独立授权，完整原生Project附件不在此证明内 |

[B1 当前材料合同报告](../reports/2026-09-22-material-contract.md)固定当前来源、身份、权限与 Project fileRef 缺口；[纯合同](../../packages/runtime-kernel/src/materials.ts)、[源适配](../../packages/box-runtime/src/internal/io/material-source.node.ts)、[索引与操作存储](../../packages/box-runtime/src/internal/io/material-store.node.ts)、[后台宿主](../../packages/box-runtime/src/internal/roots/materials.runtime.ts)和[管理用例](../../packages/server/src/materials.ts)分别拥有边界。管理 Server 持有 indexer；扫描不做原生 RPC/模型请求或源写入。配置只读面不初始化存储；显式启用的后台进行初始扫描和周期校准。源绑定包含配置、声明的账号 scope、真实根目录 inode，声明 scope 不冒充最新原生登录，所有来源保留 `upstreamSync=not-observed`。

索引按源有界扫描、逐项增量更新；不变内容不重写正文、不使游标失效。新鲜度、缺源、partial 与空结果分开；慢/坏来源不伪装完整结果。一个源的快照与 cursor generation 在同一 SQLite 事务发布，索引器用真实进程身份互斥，网络/源读取不持数据库事务。配置只比较 materials 领域，不因 CLI Profile/其他领域变更丢弃有效扫描。关页面不停止后台；关闭管理服务取消并等待真实扫描，不留晚写。

当前操作与派生索引复用一个 owner-private SQLite 文件，但不同表分别管理：索引重新扫描/源撤销只改派生部分，不能删除写操作的原 request-id、unknown 或历史回执。源替换之前持久预留按文档排他的操作；已完成回执先于新的准入返回，提交后或 COMMIT 回调丢失保持 unknown，不凭当前内容补签历史成功。源内容提交与索引追赶分别读回。索引损坏时直接读取完好的源仍可用，但新的源写入因安全记录不可靠而拒绝；坏库/丢库不自动重建。

Linux descriptor-backed 本地根是当前资格平台，逐层拒绝符号链接/硬链接与根替换，限制隐藏/凭据路径；源重叠不能建立原生只读分片的 writable 别名。外部 writer 没有参与本地原子 CAS，回执明确 `externalCompareAndSwap=false`，不夸大竞态保证。policy 限制来源/文档/目录遍历/文本/索引/操作容量；达到上限保持 partial 或拒绝新增，不淘汰未知操作以换容量。

正式入口为 `system materials get`、`memory list/search/read`、`project list/get`、`file root list/get`、`file stat/list/search/read/write/mkdir/upload/download/delete/restore`，以及 `operation get --domain material|file`。file/material引用各自固定来源，不能通过fallback混淆；旧positional Memory、旧fs/daemon文件RPC及Job执行入口已退出。Web `/materials` 提供分类、源筛选、字面搜索、Project 成员和显式正文；文本写入、冲突保留草稿、丢回复刷新恢复共用同一管理用例。元数据、检索、正文与修改权限分开。

[真实 Node 测试](../../test/materials-management.test.ts)消费隔离的真实文件/SQLite/HTTP/CLI，[浏览器旅程](../../apps/web/test/materials-browser.node.ts)消费搬移的生产制品；fixture 不属于生产 fallback。具体最终源码与扩大回归结果归 [CLI-05](CLI-05-implementation-follow-through.md)。它们不关闭完整 DATA-01 或原生 LIVE。

### Named-root纵向实现（2026-09-22）

[文件管理用例](../../packages/server/src/files.ts)持有[原文件描述符适配](../../packages/box-runtime/src/internal/io/governed-filesystem.node.ts)，复用原材料SQLite的独立file_operations表，当前schema为2，旧schema保全但不自动升级。两种源writer在同一个事务中保护unknown对应的physical path/子树；修改配置把named root变成材料来源也不能绕过原未决写入。GET不初始化存储，安全主库丢失且目录仍存在时不重建许可。

32KiB块、完整SHA/size、固定原描述符和并发打开容量分别验证；正文和可复用审批不进浏览器localStorage。首次声明或发布回执丢失保持原unknown，真实Server SIGKILL后也不重发。暂存上传与发布分开，原owner在到期/取消/关闭时只能将已证明未发布的暂存结算cancelled；新服务不能猜测旧commit是否发生。删除保留原trash与请求，恢复仅用同主体原成功删除，不能覆盖当下存在的目标。新建文件和CLI下载使用原子no-clobber，替换与目录恢复不承诺外部writer参与CAS。目录revision是metadata，不是递归内容快照。

`/files`提供源审阅、显式内容/二进制、版本冲突保留草稿、上传与原操作恢复；`/operations`接入file域。文本索引、原生Memory/Project与普通文件仍按各自权限和绑定处理，不用复制上游片段冒充源修改。证明与剩余边界见[文件管理报告](../reports/2026-09-22-file-management.md)。

### 剩余差额

原生材料删除/修改、User/Project源写入及读回、Project原生附件/fileRef、实时原生账号/同步资格、索引/操作/可恢复trash的长期安全保留与清理仍需接原owner和真实验收。named-root二进制与恢复不能替代这些原生目标，也不签安装采用或W4。没有源能力的必需项保留明确差额，不通过隐藏按钮或把本地副本当上游事实消除。

## 验收

1. 跨来源检索能返回稳定引用、原位置、覆盖与索引年龄；缺源、陈旧、无结果、无权限明确不同。
2. 使用合成原生材料验证读取、已支持修改、并发冲突/外部 writer 限制及独立读回；重启/重建索引不丢源内容或越权读取。
3. 源写已成功但索引滞后、文件监听漏报、重复事件及扫描中断有可恢复结果；不无限重试或挤占管理请求。
4. CLI/API/浏览器消费同一用例。LIVE-MATERIALS-SEARCH 与 LIVE-MATERIALS-WRITE 记录最终资格；源能力不足的必需项保留阻断，不自行降级承诺。

[T41](T41-continuous-observation-and-alerting.md)仍拥有持续观察/incident；[CONT-02](CONT-02-continuity-snapshots.md)仍拥有私有恢复材料。本票不接管这两类账本，也不建立新的 Memory 身份层。
