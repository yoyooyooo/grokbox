# CONT-05 — 连续性成套验收与发布

**状态：planned；CONT-00的8个原生边界探针不构成本票通过。**

合同：[S13.8](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。依赖CONT-01–04的独立实现/离线/review出口。所有当前live状态仅维护 [LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)；monitor安装与真实投递同时链接已有LIVE-MONITOR-PERSISTENCE条目。

## 目标和边界

证明实际用户能及时收到归属丢失通知，已保全材料可在新的Box身份中持续使用，且恢复不重复旧业务。分别记录检测、通知接收、准备、原生恢复、业务交接、下一回合和原App可见性；任何一个通过不替代其他项。

默认在独立worktree完成源码/制品/offline/review，再线性合入v2。固定成套CLI/preload/modeld/Host profile与schema后才开展授权的live窗口；索引或合并本身不授权重启、模型消费或对真实Bot停用routine。

## 必需矩阵

| 维度 | 可观察出口 |
|---|---|
| 发现 | 事件加速及轮询兜底；首次Temporal、空闲、升级/Host重启、失联gap；业务准入不被collector挤占 |
| 通知 | durable outbox→实际目标消息记录；丢回执/重启去重，短提醒结束；未配对/目标失联不是成功 |
| 材料 | committed root/closure/Memory分层/转录watermark齐全；partial、缺引用、schema变化和磁盘压力可见 |
| 创建 | 官方新身份，独立confirmed_box；nonce丢回执不多建，创建后立即Temporal停止推进 |
| 恢复 | native writer接受→checkpoint读回→关闭重开→真实下次模型请求含规定历史与摘要；不是仅问“记得吗” |
| 效果 | 旧tool/消息/routine/job不重复；源未隔离时新Bot仍prepared；服务重启不重放未知效果 |
| 用户入口 | 新旧UUID对照、原App新会话可用、旧固定ID入口剩余清单；logical映射只覆盖其管理入口 |
| 风暴 | 短时间再次迁移、全批迁移、多collector/迟到操作，唯一继任者与持久冷却有效 |

public fixture、packed Node、选择性原生函数、whole native session、实际Server/App/provider分别标注依赖真实性。构建、语法检查、空Bot创建、artifact输出或CLI成功不能升级成端到端证明。不能为测试诱导真实业务Bot迁移；实际迁移窗口用获准可丢弃对象或自然发生后的只读证据。

## 实现和复核要求

验收脚本/测试沿现有测试目录和verifier命令组织，精确入口随实现登记，缺能力不写虚构可运行命令。baseline防回归至少包含monitor、ownership、context-maintenance/continuity和CLI创建不确定性测试。原生探针已有入口：

```bash
GROKBOX_TEST_NATIVE_HOST=1 bun test --timeout 30000 packages/box-runtime/test/ownership-continuity-native.test.ts
```

当Host身份/clone/export/Blob、Memory、routine/Webhook、App路线、context writer、消息ack或config/notification授权变化时，更新受影响向量并独立复核。原生源只在明确opt-in时本地读取，不分发私有实现、凭据、真实用户内容或机器路径回执。

## 非目标

不保证任意未来Host兼容或永久免于迁移，不宣称精确恢复未提交的RAM，不在文档里维护第二份live完成表，不把未执行或skip标为通过。未完成的implementation/review留在来源票，只把对live的阻断效果写入唯一索引。
