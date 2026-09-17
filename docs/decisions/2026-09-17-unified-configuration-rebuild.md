# 2026-09-17 — AH-99/AH-100 与运维配置的统一重建

**状态：基于用户本轮破坏重建要求形成的施工建议；仅文档，不是两张 Linear 票已获完成签署。** [统一配置 Spec](../roadmap/configuration-rebuild-spec.md)拥有最终路径、shape、命令和迁移；[Template Ops Spec](../roadmap/template-ops-automation-spec.md)继续拥有通知/诊断/维护/支持业务。AH-99/AH-100 正文和 2026-09-16 冻结评论已读取，两票当时仍 Triage，评论本身仍待维护者确认；本轮没有改票或状态。

## D18 — 两份日常意图文档，而不是合并所有文件

接受 AH-99 的用户目标：逻辑入口 config.json 与 models.json。client Profiles、daemon/desktop 长期策略、runtime desired、ops 偏好都进入 config v2；不只塞一个 desktop 段就宣布统一。models 继续独立，保留当前 v2 最新字段与领域语义；Host 源档案、秘密、短效、CLI 安装不搬进配置。

Box config 实体选现有 durableRoot/config.json，models 实体维持 durableRoot/models.json，home 管理稳定别名。非 Box client 配置仍是自己的 home 普通文件，不发明远端模型副本。路径发现和实际读写分开，原子写必须针对 canonical 实体，别名被替换时报警并保全双方，不静默合并。真实 Reset 保障要有对应平台/安装资格。

## D19 — 一个命令面和一个写入程序

顶级 `grokbox config` 管 general config，`models` 管模型，`ops` 管运维动作，`profile/desktop/host` 是同用例上的领域入口。不再引入 `runtime ops config`、独立 ops-policy writer 或 Profile 文件树的永久兼容层。

普通 `config set` 不处理 model、grant、endpoint 绑定、floor 或 stopWindow pin；父对象替换也不能绕过。配置身份、连接作用域与目标 Box 不混用，远端 Profile 下模糊 Box 写入必须拒绝/明确 scope。

原子 rename 只解决局部 publication，不解决 stale writer。所有领域 writer/daemon/bootstrap 都经同一 lock+CAS+readback 程序；保存与消费者应用分别出回执，RPC 失败不能冒称持久化未发生。

## D20 — 偏好展平，授权与配对移出普通配置

原运维方案的 `overrides` 展平到 config.ops 的稀疏叶，固定版本 preset 补缺省；不用两棵看起来都能写的有效配置。targets/routing 仍由原业务规则解释，可配置 desired Agent，但真实配对收据与 grant 放机器状态，普通 set/import 不建立授权。

document configRevision 负责全文件 CAS；子域依赖 digest 负责失效，desktop/client 改动不撤销全部 target/grant，不取消 modeld 当前 TURN。models 保持独立 snapshot/selectionRevision，Host 不读大 config 或 ops 数据库。

## D21 — 单向迁移，不能把未知覆盖称作收口

一次显式 migrate 固定 source/plan digests；旧 writer 必须可证明已停止或切换，不能靠新锁约束旧二进制。新旧冲突先确认，不采纳“新文件总赢”；多文件迁移用阶段 manifest 和恢复门，承认部分提交，不宣称一个 rename 是整体事务。

新版日常路径只读新 shape；旧解析器只在 migrator。bootstrap 在 schema/迁移/consumer 准备好后切种子，不继续覆盖旧 daemon 配置。models/secrets 原位，用户 off/预算保留，旧原型 grants 不自动晋升有效。

## D22 — 本轮边界

本轮把 AH-99/AH-100 扩成配置底座的同一 release gate，拆 T57–T60 并接入 T43–T56；不是再追加两套小补丁，也不是当前立即改生产配置。AH-101 行为不随迁移修改。运维分支落后 v2 的 chatDialect 等字段必须在实现前对齐，破坏重建不允许旧 parser 抹掉新模型资格。

日常命令和文档统一可以在本轮完成设计收口；实现、迁移、混版本退役、packed/native 验收必须有独立证据，不能因文档提交就关闭 Linear 票。
