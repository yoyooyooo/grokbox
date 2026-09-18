# 官方式 duplicate 与持久创建事实 · 2026-09-19

本报告记录CONT-06的Box-local实现切片，不是完整状态clone或自动交接的完成证明。命令语义归[操作指南](../maintainers/native-agent-duplicate.md)，实施范围归[CONT-06](../tickets/CONT-06-native-duplicate-cli.md)，实际账户/App效果只在[LIVE-NATIVE-DUPLICATE](../tickets/LIVE-integration-validation.md#live-native-duplicate)。

## 实现

`agents duplicate`默认只读预检；执行需要精确源ID、plan/scope、固定操作UUID与确认。预检绑定可观察profile/Routine定义与启用状态、实际归属和Gateway/认证代际，披露本地Routine复制、清会话、活动聊天切换及非完整Memory/blob克隆。源不能是群，名字不作为操作身份。

程序沿CLI→有限Gateway适配→Effect操作→CONT私有存储，共用已有安全记录，不增加另一个日志或复制调度器。原生仍只调用一次`duplicateAgent({id})`，没有向原生虚构创建nonce；不以createAgent代替、不隐藏rename/update，不暂停源Routine或迁移关系。

最终POST前再次核对原始证据年龄及Gateway身份；认证值只参与嵌套摘要，不保存或输出。唯一复制路径关闭普通HTTP/auth重试，其他Gateway命令保留原行为。源被正常官方接管到Temporal并不拒绝这项官方复制，但新目标归属必须独立核实，不能默认标Box。

CONT管理库显式v1/v2→v3迁移，加入有界identity receipt及按源操作索引；这不是canonical config迁移。意图和源保护原子保存，claim先记effect_unknown，已确认响应的新ID与成功状态原子提交，再读取目标当前归属。重复操作使用第一份持久请求，不被新的读取时间改变；未知结果阻止同源改operation ID再复制。

成功创建但ownership读取失败，仍保留原ID；收到原生ID而本地结果提交失败时，错误保留该ID并标unknown，不把它算完成。完全丢失原生响应时不通过同名或列表差异猜关联。GET和`agents operations show`离线读取，不升级库或联系Host；继承版本变化不清理未知操作以腾空间。

## 并发、取消与故障证明

真实CONT SQLite用例覆盖同操作并发、不同操作同源未结保护、预检漂移、过期证据、本地未发出拒绝与HTTP失败的区别、取消后等待有限结果收口、回执提交前后故障。底层通用prepare/settle不能绕过duplicate专用原子记录。

独立Node20进程使用测试自有的外部效果计数：创建后、回执落盘前被SIGKILL，重启保持unknown且不再派发；回执提交后被杀，新进程读回精确ID；三个进程竞争只有一个实际调用。其外部创建是owned port，不是真实Bot。实际生产CLI、HTTP传输、身份预检和数据库在另一组本地HTTP测试运行；401/500没有重复POST，普通命令的原认证行为通过回归。

固定原生Host源码的选定复制函数在隔离VM中执行，验证会话清理、原样复制启用Routine、不复制独立Memory/blob、生命周期委托及既有current-state身份清理slice。没有启动全Host或调用生产账户。未启用原生资格时不能用skip作为通过。

## 验证入口与范围

```bash
node scripts/verify-runtime-rebuild.mjs continuity-duplicate
GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-duplicate-qualified
```

工具固定Bun1.3.14、Node20.17.0，无依赖锁升级。形成候选时公开专项37 pass、原生语义3 pass；内核/package269 pass，顶层CLI分组279/267/203 pass，各组有重叠，不累加为不重复的全仓总数。一次整批回归180秒未取得完成回执，随后拆组成功；没有将超时改记通过，也未残留该次测试进程。最初Effect版本API误用和不合法remote测试类型已修正，最终使用项目固定API，未放宽行为断言。

代码核对顺带修复既有`agents state`的local-only registry边界，禁止先解析Profile覆盖调用上下文。独立操作指南和命令帮助已更新；ownership技能主题追加被工具拒绝，本轮未写入，未把它作为已交付文档。独立外部review尚未取得。

## 集成与现场边界

从已集成v2基础继续，公共Gateway/存储变化需在最新v2上重验后线性合并，不覆盖并行通知/Routine实现。真实源/目标创建、App当前选择、复制Routine实际行为、现场账本迁移和跨Host版本兼容均无本轮回执；Git合并不执行这些动作。

默认fullClone=false；完整状态clone、Memory/展示历史/附件迁移、受管指令spawn、自动保护与逐职责交接继续在对应CONT票实现，不挪成“只差Live”。本轮不重启Host/modeld、不迁移运行配置、不唤醒或复制真实Bot。
