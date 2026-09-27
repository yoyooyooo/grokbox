# 正式采用与静默创建读回差额

2026-09-27，AH-187。候选 `9d33df36ff49b3a488a70f2e099f0459bab3459d`，当前官方 `b77855a`。[前置入口和来源资格](2026-09-27-early-session-entry.md)已完成后，固定安装的 99 个文件逐摘要一致，Node 22 下 SQLite/Level 实际读写通过；全局 shim 未切换。

## 正式采用已完成

profile 由正式 writer 先发布 core，再以其准确摘要 CAS 升级为 63 切片。profile SHA `7489c561ba0dceb3cf4e2945954e78529fa3213e8497e01f947696eea355f647`，transformed SHA `0311a1509b2e30438b55bf193abbc81783e20bbbd780e7059e7f874bcb256595` 与限定资格相符。自动分析仍是 missing_runner，不被表述为自动批准。

同制品正式前台 Server/modeld 启动后，原 `host start` 一次执行，不带 force。操作 `2db422ec…` 到达 attested，guardian released；Host capabilities ready、committed ready、alignment verified。随后独立 status 与管理 preview 读回同一已加载 source/profile/transformed/preload/generation。执行准入和 Provider roundtrip 尚未取证；前台服务也不是 boot persistence。

## 一次真实静默创建

窗口预算为最多 1 Bot、0 模型请求、0 群、0 Routine。沿原来 planned-not-sent 的请求执行正式创建，原 CONT 保存了准确返回的本地 UUID 和首次 Server ID。首次响应为 created / box，本地绑定和独立 Server/local 读回也匹配同一 UUID、Server ID 与 Box。intro suppression=true、kickstart=false，未重新登记或更换 UUID。

原哨兵仍报告 failed/readback，并停在 ownership-unconfirmed，没有发出删除。事实中有两个源码差额：

- 创建 normalizer 把未填写的头像字段补为 empty string，原生工厂选择默认头像后，管理回执误报 readBack=mismatch。
- 实际 Server 名册省略可选 viewerIsOwner。经当前原生认证语义进行的只读 Server 调查，默认、显式排除团队与显式包含团队请求均返回相同目标绑定且不提供该字段。首次使用非该 native caller 的 token 类型得到 401，也保留为失败调查；修正为源码中 getAccessToken 所用类型后，三个查询为 HTTP 200。没有模型或 Bot 变更，也没有保存/公开凭据或全量名册。

原生共享只读规则和既有 ownership kernel 都保留此可选值、只把显式 false 当作拒绝。普通产品变更/Human 消息的额外 true-only 要求与该合同不一致。修复保留 null，不制造正向 owner 标记；仍要求新鲜、稳定的认证作用域与已确认 Server/local 身份，显式拒绝继续阻断，实际效果仍由原生 owner 执行并读回。更强的 handover/protection 条件未被扩张。

新创建意图只保留明确填写的字段，名称仍必需；历史意图中明确存在的空字段和旧 mismatch 回执不被重写。公开反例覆盖原生默认头像、可选共享字段缺失、显式 false 拒绝以及准确清理。typecheck/build 通过，6 个文件的 15 项外层检查通过，其中 Node 原生产品、消息、哨兵通过真实 HTTP、CONT SQLite 和打包 CLI 执行；哨兵内层 10 项全部通过。

本报告提交时，现场原 Bot 尚未清理。继续沿原创建回执和原 cleanupRequestId 处理，不能新建或重放来覆盖此次结果；修复后的整包资格与后续业务仍需另行验证。旧 10 条 unknown 不变。费用继续 billing not observed。
