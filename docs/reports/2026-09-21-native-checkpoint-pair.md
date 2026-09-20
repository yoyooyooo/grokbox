# 当前 Host／worker checkpoint ABI 配对与生产入口接线

2026-09-21。HOST-01 / HCR-04 / CONT-07。承接[原生角色分析](2026-09-21-host-native-role-analysis.md)。本报告的资格仅覆盖明确的checkpoint codec、AgentStore及worker事务ABI，不等于完整Host部署、账号权限、Provider/App恢复或全部能力已验收。

## 先实验，再登记有限元组

先保留生产旧pin，以显式 `GROKBOX_TEST_NATIVE_CONTINUITY=1` 和 `GROKBOX_TEST_NATIVE_CONTINUITY_PAIR=idle-candidate` 选择本轮来源，完成原生25项中的首22项隔离实验。它读取准确SHA的已安装文件，在没有注入文件/网络接口的VM中执行选出的原codec/schema/AgentStore声明，以及在仅能打开自有临时source.db/target.db的Node worker thread中执行原worker入口。未执行完整Host主入口、未读取已有Bot数据库或Memory、未发RPC/模型请求。

随后将精确的 `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548` Host与 `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e` worker登记到原[配对目录](../../packages/box-runtime/src/internal/host/native-checkpoint-pair.ts)，原e7031f…元组保留。测试flag不会写目录或批准新pair。最终实验改走正式 `installNativeCheckpointWorkerHook` 与实际Node module loader，不再借候选直编译入口代签生产接线。

原生窗口覆盖shared schema、完整archive/历史root依赖图、缺叶/坏protobuf/未知字段拒绝、引用预算、原AgentStore checkpoint与独立持久读回、真实worker事务/持久receipt/GC屏障、worker重启、解除后B2进展不被原apply覆盖，以及wrong Host/schema/agent在原worker侧拒绝且不改root。追加实际native duplicate及startup切片共25项，确认复制的源准备标记被清除、普通用户消息不被隐藏、startup仍使用原受信载体。

## 两处只跑parse/apply会漏掉的接线问题

第一，虽然原61片candidate已经能应用且3项语义规则通过，两个CONT注册replacement仍携带旧Host hash。现在原 `nativeCurrentStateSlices(pair)` 按明确tuple生成created/session owner的source metadata；旧recipe仍生成旧元组，新recipe生成新元组，没有修改已保存的profile或原生状态来迁就它。

第二，显式current-state能力升级原来选择了新core，却仍拼上旧current-state extras。原生能力升级测试实际在startup-input失败，现统一从同一个source-specific recipe选择core/checkpoint/current-state，保留非目标slice及Golden/review/基线CAS规则。不是删掉失败片或在测试中直接接受替代配方。

preload owner、worker transform、profile capability authoring及artifact读面共用该有限pair目录。新Host配错误/改动worker仍拒绝；hook目标拒绝时先恢复原compile钩子。普通模块、未知Host及未显式启用入口不取得CONT权力。静态matched只表示精确已登记ABI，不代替当前运行代或实际应用证据。

## 修正后的实际源码和候选

原Host仍26,523,565字节、worker677,638字节；61片候选26,547,337字节，新摘要为 `187c57a8fb2b11b8ee51f2ff73203f62b805e13a28dedc829de295dd02024db4`。改变的是两处发出的Host身份，不是为了checker求绿改控制流。

同一正式Rust/FD入口再次验证source/candidate/companion均0 parser/semantic诊断；revision2的main、retry、checkpoint三规则全部passed，pair查询为same-pinned-pair。该静态窗口分析1726ms、整体16539ms，仅单次测量。未发布profile、未加载该candidate，qualified仍false；新支持的生产入口仍需通常的显式profile与实际采用流程。

## 固定源码与本大阶段验证

源码 `e5cbcee765d6bf02afd8ce3198a357d8642989fde3af0a8a3be63a434e3695d0`，1180个源码/测试/工具链输入。三个窗口前后相同：core499项/50文件；integration24项/18文件；native-pair25项/4文件，均0失败，native lane不接受skip。外层合计548项/72文件；另Rust30项。Node主程序22.22.0、原生worker实验Node22.14.0、声明Bun1.3.14。

包装内部verifier22、Host管理10、编译11、见证20、SQLite单worker5、保护管理24、context18、lifecycle18、材料25、模型36、通知setup18/管理31、异常19、观察12、bridge9及搬移制品Chrome66全部通过；内部数字不与外层548重复相加。根/Web typecheck、wire生成、正式构建、tarball安装/二进制与Web清单核验也在当前窗口完成。包含上一修复的[SQLite读等待](2026-09-21-sqlite-read-scheduling.md)，没有沿用此前705/486项冒充新资格。

文档及实际CLI leaf覆盖15项通过；暂存/未暂存差异检查通过。全工作树发布扫描检查1478个文本文件，唯一发现是并行VOICE文档第17行的本机checkout路径；本实现文件无新增发现，但全工作树检查不标green，VOICE内容与暂存状态保持不动。

## 剩余边界

整份Host主程序的启动/实际账号/完整原生恢复、idle summary完整受管链、原生调用机会与bypass、完整lease/finally及未覆盖能力仍由HOST-01/CONT/LIVE承接。元组资格是对应ABI的有限证据，不是系统整体qualified=true。独立审查和发布仍是后续门。

VOICE的8个暂存规划文档完整保留，不纳入本实现提交；不移动v2或切换现役服务/全局入口。下一工作包不应再把当前三条native role或这个ABI tuple列为未实现，但必须补上它们没有证明的完整行为与采用范围。
