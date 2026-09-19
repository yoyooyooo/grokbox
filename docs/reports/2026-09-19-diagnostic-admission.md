# 诊断联合容量接纳与过期证据退役 · 2026-09-19

本报告保存 `9801fe7` 后的固定离线候选证据。实现差额归 [OBS-04](../tickets/OBS-04-bounded-observation-storage.md)、[OBS-05](../tickets/OBS-05-safe-state-retirement.md)、[OBS-06](../tickets/OBS-06-integration-and-soak-proof.md)；当前现场结论只归 [LIVE-OBS-STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage) 和 [LIVE-OBS-SAFE-RETIREMENT](../tickets/LIVE-integration-validation.md#live-obs-safe-retirement)。没有部署本候选。

## 接纳发生在原 writer 前，而不是查询后

`host/diagnostic-budget.node.ts`复用现有有界目录锁协议，使已安装观测范围的 monitor SQLite、两份 journal 和 modeld 过程日志先取得同一个短期接纳门，再获取原域事务/文件锁。没有新增数据库、daemon、配置根或对任意文件的清理权限。Host 依赖保持无 Effect/SDK；状态和 writer 共用同一有界元数据扫描 leaf。

范围来自 canonical `daemon.observation.runRoot` 与 durableRoot。首次采用固定一个不含路径正文的 scope 记录；普通读不创建它。后续删除配置、改 root、丢失或损坏既有 scope 均不授予一个新的默认容量池。尚未安装的旧用法保留原本局部 writer 上限；这不是隐式迁移或启动。首次 scope 发布中断仍保守阻断，未实现自动恢复。

门内计量三个明确诊断命名空间的实际文件长度和 allocated blocks，备份/暂存/SQLite辅助文件即使无法解析也计入；完整计量失败、符号链接、深度/项数超限时不接纳新增写入。接纳协议本身最多132个元数据对象并检查实际占用，固定预留1MiB，不累积逐请求文件。数据库写预留主文件可能增长量、最坏DELETE journal及页开销；显式初始化/迁移额外预留完整备份空间。journal与过程日志使用原writer给出的有限新增量，不能由事件自报。

正常接纳不使用内部reserve；维护可使用reserve完成同协议回收。双方根的文件系统可用块也需满足预留，其他应用占盘不等于诊断配额已失效。门在实际callback结算后释放；强杀通过确证失主恢复，不重放callback。没有并发writer分别读取同一“尚有余量”后都写入的路径。

SQLite连接明确使用DELETE rollback模式；已是其他模式的库拒绝写入，不擅自切模式。临时查询材料放内存，cache采用固定值，不把临时磁盘文件漏出所声明的预留范围。普通查询仍是只读；与执行账本共用驱动的其他消费者通过全仓回归。

## 压力与故障行为

monitor保留原压力/忙锁错误；Host日志失败只降低观察质量。过程日志遇到暂时压力或锁竞争丢弃并计数，保留可恢复的writer，不因一次压力永久停用它。纯关闭段清理允许零增长；数据库维护仍需能容纳回滚材料，完全满盘时不会冒险执行VACUUM。不会为了达标删除用户导出、恢复闭包或未核验备份。

`runtime storage status`新增只读 `diagnosticAdmission`，披露scope绑定、策略与机制。`scope_bound`不是已观测所有运行制品采用该代码，更不是OS文件系统quota。未改造writer、Jobs、执行/CONT安全状态、制品和命名空间外导出仍有各自差额；`installationBudgetEnforced=false`和`allRunningWritersVerified=false`保持，不能将本片扩大为整个安装已强制有界。

## 过期材料不永久绑定未知副作用

此前提交 `9801fe7` 允许在材料承诺期限、通知期限与lease都已结束后退役诊断快照；精确work/attempt与修订水位保留。reserved/attempting/unknown不是无限保存payload的理由，也不能因payload回收而变成重新发送许可。旧revision查询返回expired/snapshot_revision_retired；不会将已经发生的事故说成不存在。

这不是所有安全记录的最终删除方案。当前provision及其他安全owner仍必须先改变或证明旧请求准入边界，才允许忘记去重身份；不以诊断TTL代做安全退役。

## 固定执行证据

使用锁定的Bun1.3.14和原依赖，未改models或wire版本。完整组合：

```bash
bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation
```

实际 **157 pass / 0 fail**，20文件、3488断言，类型/构建/导入边界/隐私检查通过。验证前后source摘要一致：`5fe403a914f65670c3bbb7279bf02b0813fa4487ac03ab411f187d5f524e1041`，906个源/测试/锁文件；实际preload为`2a7587196cd88f28e52f4602676d8890c2de6a23caaa535006f0cc7a14f052a4`。扫描1178文件、零发现。

随后不重叠全仓执行：CLI 801 pass / 0 fail，79文件、7873断言；packages 2097 pass / 49 skip / 0 fail，293文件、20381断言。合计 **2898 pass / 49 skip / 0 fail**。跳过的原生资格未计通过。此前遗漏的全仓组和旧shim超时不再是本候选的未执行项；这些结果只属于上述固定源码，不签后续并行修改。

七项新接纳测试使用真实小额配置、文件/SQLite、八个并发writer、精确scope破坏、库存截断和真实子进程SIGKILL，证明压力下三类writer均拒写、用户字节不变、释放人工压力后恢复、维护可用预留且查询不修复。另24轮soak核对两份journal、数据库及过程日志真实字节、游标、租约和用户导出。子进程reservation测试使用源Bun进程；既有collector/daemon旅程使用打包Node，二者不混称原生生产依赖。

## 合入最新 v2 后的重新验证

随后rebase到`25dd61b`，保留并行的network责任收口和overflow证据修正，没有将旧执行假设补回。该基线移除部分文档结构测试，原两项跟随测试仍断言旧文案/固定等待时间；更新为实际nonce/STEP取证入口及完成title refresh的证据要求，原模型准入负例未修改。

重新跑完整CLI为791 pass / 0 fail（79文件、7502断言）；完整packages为2099 pass / 49 skip / 0 fail（293文件、20397断言）。最终合计**2890 pass / 49 skip / 0 fail**，不是将旧基线数字相加。最终`pre-e2e-observation`完整专项**150 pass / 0 fail**、20文件、3197断言；类型/构建/导入边界通过，source前后为`86cddff8867685cd2aff86daf18a9ccccf8c0866133cfa835fb06faef52c3337`（906文件），实际preload为`51ddf20da8a4a10bb1453263e0d4356879300cf6e61a837955e5f4c1a0465cb0`。最终源码扫描1180文件、零发现。

独立Astra只读审查在限定窗口未返回报告，进程以timeout退出124，未计为审核通过。`docs/runtime/operations.md`的合同同步写入被工具拦截，未落盘；本票/报告记录实际实现与差额，不把未完成的Current Home更新说成已完成。后续集成是源码收口，不自动授予live放行。

## 源码集成回执

已将`83119c6`至`d3ec6e6`的七个提交快进合入`feat/box-runtime-v2`，其中观测/collector、通知恢复guard、工具链修正、过期材料退役和联合容量接纳不再只留在feature worktree。基线`25dd61b`的并行network/overflow及文档收口完整保留。

在v2执行接纳/soak/通知恢复/打包collector/故障到通知/清单六文件复验，实际**23 pass / 0 fail、2247断言**。该重点复验与前述全仓有重叠，不再相加。没有push、全局shim安装、配置迁移、原生通知或现役服务切换；独立review未完成，不签live放行。

## 剩余边界

独立审查结果以提交后的报告为准，测试数量不替代审查。OS启动owner尚无完整受支持安装路径，本机tini/无有效systemd会话不能用二进制存在或X窗口管理器存在补证；没有改官方supervisor。全安全台账有界退役、所有owner物理配额、完整备份恢复和真实Provider/App/Webhook仍各有来源票或LIVE范围。未切Host/modeld/daemon、未迁移生产配置、未发送真实通知。
