# 84c3000e 正式采用失败与未完成的物理恢复

2026-09-27，AH-187。候选 `84c3000e10bf3d20d2534641c26ff2ce9759ed53`；来源为 `a22d48c`，Host SHA `462603791cf7516915084d175cb96125241cacb1352e2e42fb100ebe4feb71e0`，worker SHA `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。当前入口仍是 [LIVE](../../tickets/LIVE-integration-validation.md)。

## 实际采用与失败

固定制品构建、candidate 审计、pack、98 个发布文件摘要以及安装依赖原生读写通过。CLI、Server、modeld 来自同一固定安装目录。正式 profile 为 63 切片，摘要 `f8f0ce0b28dd5ce94263114feec79ac6fc91720814608aaed058a84b4f457f04`，变换 Host 摘要 `faad30368ce732b04e6739c7bf42a16bc139779c2d02ac61b6acc1a373c86a41`，与当前原生资格候选一致。

04:26:28 UTC，重新核对完整原文、保留副本、worker、profile、原 wrapper/supervisor/Host 生命周期、原生 Gateway、空闲和 modeld 零接收后，通过正式 `host start` 提交 route 声明，未使用 force。操作为 `021f7ddde893e9b245d905b45139773b982603eac4dab6c4c44d2454b036ae1f`。

本次确实产生了物理效果：原 wrapper 被暂停，旧 Host 与 supervisor 收到 SIGTERM，临时 supervisor 与带 preload 的 Host 启动。新 Host 的编译标记在 04:26:41 UTC 完成，Gateway 随后指向同一生命周期；标记中的完整 compile receipt 与正式 profile 逐字段相符。

约一分钟后，原回执为 unknown，最终诊断 `guardian-ownership-ended / spawn-temp / expired`。清理记录了向新 Host 与临时 supervisor 发 SIGTERM；Host 退出未证实，临时 supervisor 后续观察已不在。原 wrapper 恢复，原 supervisor 程序重新运行，但候选 Host 仍存活。最终错误不能单独解释最初触发清理的原因，该原因仍未定位。

**没有取得 committed adoption。** 已编译、Gateway 可见以及之后只读 readiness 返回 true 均不能替代采用承诺，也不能撤销失败记录。带 failure 的 recovery-required journal 不符合原 `complete-loaded` 入口只接受无失败 spawn-temp 中断的条件。

## 恢复、限流与收场事实

原 `runtime operation-recovery --restore-operation … --confirm` 返回 `blocked / restoration-evidence-unproven`，没有发信号、采用或授权重放。未改 journal、attestation、owner 或 unknown，也未更换 nonce 重新采用。

随后，原 desired writer 已设置 disabled。04:40 UTC，正常停止本窗口 modeld；退出前 accepted=0、completed=0、activeSteps=0。04:42 UTC，本窗口管理 Server 也按准确进程身份正常退出。停止服务没有向 Host 追加信号，不具有开机持久性或官方回程证明。

04:40:53 UTC 的独立读回仍发现原候选 Host 存活并持有 Gateway，原生 isBusy=false。磁盘完整 Host 仍是原官方 `a22d48c` 字节；此时仅上游 advertised latest 变为 `dc2d109`，没有把“有新版”写成已安装。此观察不允许用旧原文覆盖后续官方更新。

静默创建声明仅已规划，始终未发送；没有本窗口新建 Bot、群或 Routine。原历史八条 unknown、observe 前置拒绝以及本次采用合计 10 unknown / 0 running / 51 terminal；原 observe 记录逐字段不变。modeld 零接收仅约束本窗口自定义入口，不是全账号官方费用归因；继续 `billing not observed`。

## 当前阻断与下一项义务

物理恢复仍未完成，不能宣称 stock Host 已恢复或干净收场。当前受影响的现场变更与后续业务停止；下一步必须先处理这一个原操作的已知存活 Host 和退出证据，定位采用的首个失败，再沿原控制与恢复 owner 完成正式回程。未经当前身份核对不能追加信号，不能借新候选或新操作 ID 绕过未结资源围栏。

正式静默哨兵、模型/工具/compact、Memory/群/Routine、用户通知出口和正式受控更新连续性均保持未验。此前 [POC](2026-09-26-box-creation-feasibility.md#program-update-continuity) 的成功不补签此次采用失败。
