# B · 原生 Memory/Project、附件引用与材料管理

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-native-materials`，从当前v2切出。完整DATA-01可在运行核心日用之后完成；正常推理/保全实际依赖的材料安全缺口优先交付。

## 目标与先读入口

现有原生身份和材料经真实owner读取/受支持修改，保留账号、来源、同步/回调、附件引用和独立读回；不能用本地索引或另一进程的原生store代替运行中的writer。先读[DATA-01](../../../tickets/DATA-01-memory-project-files.md)、[来源变化记录](../../../reports/2026-09-22-native-material-source-drift.md)、[文件已交付范围](../../../reports/2026-09-22-file-management.md)及[CLI-03](../../../tickets/CLI-03-observation-and-wait.md)。

## 模块与边界

`packages/server/src/materials.ts`、现有file共享入口、`packages/box-runtime/src/internal/io/material-source.node.ts`/`material-store.node.ts`、材料indexer、runtime-kernel材料合同及client校验。新增原生材料适配放Box原IO/Host边界，接缝/配方资格交A；不复活已移除的Memory Gateway或旧Project实现。

B拥有材料/引用/同步含义，C消费恢复闭包，D消费导出/模板/Project关系读取，W消费同一API。原生推理的Memory/episode语义仍由R主持验证，B提供其实际writer/读回能力。named-root文件传输、垃圾箱恢复和原material安全store已经实现，不另写上传下载或通用文件writer。

## 出口

| 出口 | 可并行开工 / 依赖 | 必须交付 |
| --- | --- | --- |
| **B1 当前材料合同** | J0可定位现行来源；生产接入消费A1 | agent/user/project材料身份、账号/来源范围、正文/元数据权限、原生writer/回调/同步和可验证读回；Project membership/fileRef真实来源。给C/D/R/E明确接口与缺口；不能只列类型或旧方法名 |
| **B2 原生管理闭环** | A1相关接缝已交付，B1合同确定 | 受支持Memory/Project修改→原native owner→回调/同步→独立读回→索引追赶；权限、原revision、并发/外部CAS限制、unknown恢复及管理历史。CLI/API贯通，W随后接页面；交J5 |
| **B3 附件闭包与长期维护** | B1/B2及现有file通路 | 文档/附件/二进制/fileRef的完整枚举、字节与引用覆盖；交C恢复后的资源独立性接口，交D导出接口。原本域安全记录和派生索引分开维护，容量不足不删unknown；交J5 |

R/E在核心实际调用中的材料损坏、同步回调缺失或保全缺口，不因B整体后置而延期；作为明确的小出口优先回流。不要求为了关闭该依赖提前完成全局搜索/管理UI。

## 验证与禁止

复用`test/materials-management.test.ts`、`test/file-management.test.ts`、`packages/client/test/material-contract.test.ts`和原材料/引用/配置测试。普通文件的真实Node/SQLite/HTTP证明不能签原生材料；相关原生writer必须在A限定来源上验证，实际原生写只在Q批准的测试材料窗口完成。

测试需区分源写入、独立读回、同步资格、索引采用；数据相同不是历史提交证明，已存在路径不是原生写权。缺源/账号不明不显示空成功；符号/硬链接、跨scope、损坏安全store、并发替换和未知恢复继续拒绝。禁止直接改原生SQLite/分片“补功能”，不把Project等同Git目录，不将未知附件当作可丢字段。

## 回流

B1/B2/B3分别提交，给直接消费者当前模块、source/版本/原生资格、引用闭包、测试范围和剩余缺口。材料能力与恢复能力共享一个合同，不让C复制第二套附件搬运。全DATA-01尚未实现的义务留原票，不因J4已日用而关闭。
