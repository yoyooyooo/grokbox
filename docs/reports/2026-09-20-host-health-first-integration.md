# Host 健康首个端到端工作包：固定证据

日期：2026-09-20。实施来源：[HOST-01](../tickets/HOST-01-patch-health-verifier.md)、[T44](../tickets/T44-host-ops-continuous-sensing.md)、[CLI-05](../tickets/CLI-05-implementation-follow-through.md)。这是固定工程验证，不是现场部署、整个HOST-01完成或新的设计Spec。

## 固定工程窗口

根工程源码指纹 `0af5f91658b47a95e594fd2c9fc4c0a75ebeaee4a51dfc7a70b766713b359206`，1153个git-visible源码、测试、工具链输入，包含未提交/未跟踪文件及Cargo/wire，不包含docs、dist和已安装依赖。

通过实际 `scripts/verify-host-health.mjs core` 与 `integration` 执行，各自前后指纹相同且两组一致。Node22.22.0、Bun1.3.14（连同嵌套构建PATH）、Rust1.85.0、Oxc0.75.0。没有用默认Bun1.4.2的运行结果签这一固定窗口。

| 窗口 | 结果 |
| --- | --- |
| core：生成wire一致性、Cargo、根/Web typecheck、受影响纯合同/运行时/CLI | Rust20项通过；Bun271项/31文件通过 |
| integration：实际Node/HTTP/SQLite/CLI、生产Chrome与tarball | Bun21项/15文件通过 |
| 两组Bun文件集合 | 不重叠，合计292项/46文件，0失败 |

包装测试内部另运行Host管理Node10项、两个verifier Node组合21及20项，搬移生产制品后的Chrome63个节点。它们是上表包装测试内部计数，不与292相加；Rust20项为独立Cargo测试计数。其余包装组合仍实际运行模型Node36、通知首次接入18/管理31、观察12、异常/订阅19、桥9、材料25、保护23、人工生命周期18和当前上下文18。没有重跑与本片无关的旧RC/完整模型矩阵，也没有声称292替代全仓所有测试。

生产构建产出Node与Web及固定Rust binary/manifest/LICENSES.txt。tarball实际安装后核对binary字节/摘要、许可文本摘要与Web清单，并经Node/FD使用安装后binary运行公开结构样例；binary的identity也在空PATH下执行，不依赖cargo/runtime下载。浏览器桌面和390px窄屏截图已读回检查；功能视觉不等于最终设计验收。

收尾：文档链接/实际CLI leaf与LIVE主场景覆盖15项通过；`check-publication.mjs --include-untracked` 实际扫描1441个文本blob、15651245字节，0发现/0二进制，暂存与未暂存差异格式检查通过。这些结构/隐私检查不替代前述行为、原生和独立审查边界。

## 真正贯通的链路

固定source/worker/profile → 原TS精确有序apply → 实际candidate → Node继承只读FD → 正式Rust严格parse/semantic/有限CFG → 有界静态报告 → 原provenance → 原OBS installation condition与通知准备 → 同一管理API/CLI/Web。

Rust package只有library/binary；库不读OS环境、文件、协议或DB。binary管有界帧/FD和CPU/地址空间、父进程死亡。Node管scope/槽位/取消/close，不把收到final当资源已经释放。wire是单一手写schema，包含initialize、请求/响应包络及payload，生成两端定义并使用共享独立形状反例。TS能力需求、Rust checker实现注册和管理DTO是不同合同，没有手抄第三份算法。

本片三个checker只覆盖main options binding、turn入口managed错误门、checkpoint callback计算/持久化await。动态注册、一般别名和未证明的调用角色明确unsupported；完整主链native身份、lease/finally、所有能力的运行见证仍不在这三项通过中。source/companion语法与candidate谓词分别保留；任一必需artifact语法失败仍使完整健康分析失败，不能被candidate通过盖掉或丢成协议异常。

固定源码中的 `system host health` 和 `/host-health` 可读取来源、配方、有限语义、producer、intake与缺口；没有创建Bot、Host采用/重启、重新选模、强制分析或源正文读出。运行证据仍为loaded/attachment未观测、not-exercised，整体qualified=false、通知coverage=local-only。

## 独立反例驱动的修复

新Rust反例先复现了实际漏判：return之后和dead branch里的相似调用、声明前读取的turn变量、重新赋值的compact hook/写回回调、不同词法frame、未注册或后被覆盖的入口。修复使用Oxc实际符号及有限CFG/直接调用/CJS出口，未通过全局名字替换或自动刷新Golden求绿。

来源adapter测试复现同size、同毫秒mtime的worker重写仍被当成current。现在新FD重读并核对实际bytes/hash，辅以文件类型、inode/size/mtime/ctime及末端path核对。此机制不是上游supervisor事务锁，也不声称同UID敌对环境的密码学见证。

第一次Host管理组合还抓出publication已更新latest却暂时沿用前一次intake=committed；修正为新receipt先not-observed、真正原OBS提交后再committed。retain后intake前退出能由原event/sequence补入；源不匹配先于Oxc不可用记录，正证据仅恢复相应condition。无Bot、慢原生reader、空目标collector、重启、竞争producer、A→B→A和通知未配场景均有实际组合断言。

子进程反例包含错build/schema/attempt/artifact摘要、截断/重复final、stderr超限、报告后挂起/崩溃、只读FD检查、取消、single-flight busy和实际close、父Node SIGKILL。敌对临时测试进程仅验证传输/资源错误，不作为正例分析oracle。正例均执行实际Rust。

## 同窗口磁盘静态复核

使用 `scripts/qualify-host-health.ts` 显式指定Host/worker和发行binary目录，不传profile，不导入/eval/执行私人Host，不查询Gateway/Provider，不发布profile。无选定profile是该调用的明确输入，不是对现役安装是否有profile的判断。

| 来源 | 字节数 | SHA256 |
| --- | ---: | --- |
| Host entry | 26523565 | `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548` |
| worker companion | 677638 | `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e` |

两来源在读前后及最终digest核对一致。正式Rust build `07642000d067918074fd1b71d031b105ca48a2c19068bb2c8c4fe702e60b9c17`，wire SHA `8fbb644ff38372420dfb8bde1f4eb3fbebdab6c26941e8e5c61dbb4cd8a18aac`。严格parse/semantic分别得到3761481/115830节点、0 diagnostics；实际分析548ms，含读取、原配方诊断、复核和进程等工作wall6391ms。这是单次来源实验，不是吞吐/SLA或RSS实测声明；资源上限设置不等于实际内存测量。

完整当前recipe首先在 `managed-retry-gate` 返回anchor-missing。诊断路径逐片推进并跳过失败，明确不是可发布候选：core39中9项不匹配，checkpoint3项匹配，current-state19中2项不匹配。core失败为 managed-retry-gate、managed-output-retry-gate、managed-summary-retry-gate、tool-execution-failure-observation、alert-main-decision、alert-automation-decision、alert-automation-throttle、context-manual-native-action、context-manual-summary-owner；current-state失败为continuity-native-startup-input/action。Host/worker配对为unreviewed-pair，不能因worker没变或三片匹配继承资格。旧Memory RPC字面未出现仅是文本存在性证据，不宣称原生RPC完整合同已核验。

没有精确candidate，三个candidate谓词均unsupported/no-exact-candidate。没有将顺序诊断的部分变换送去声明完整健康；没有修改既有SHA门、配对pin、原生recipe或现场服务来做出绿色结果。

## 仍未关闭

HOST-01后续仍需全能力/完整native角色与行为资格、实际compile负回执、同代挂接/触发证据、idle/manual/startup等当前源适配、完整退避与长期容量、独立故障出口和真实采用。旧升级四事件只入evidence的历史缺口没有被本片新producer的通过改写为全覆盖。静态报告不成为每个STEP同步DB门，不主动停止既有合法modeld执行。

没有提交、发布、合并、全局shim切换、现役Host控制、真实Bot/Provider/外部通知或用户材料修改。既有和并行成果保留，current-state705项阶段不重做。后续实际source相关能力必须先完成相应资格，不能以本报告替代LIVE或独立审查。
