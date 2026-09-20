# 固定 Host 的 idle/action-only 配方适配与注册合同复核

2026-09-20。HOST-01 / HCR / T44 工作包。承接[同代见证](2026-09-20-host-capability-witness.md)，不是新版已部署、真实恢复或完整Host资格记录。

## 当前修改

[source-recipes](../../packages/box-runtime/src/internal/host/source-recipes.ts)为已经实际检查的源码SHA选择一份有限维护配方。原persisted profile仍通过原TS `applyPatchProfile`核对源码、窗口、唯一位置和候选摘要；没有新loader或运行时模糊匹配。原profile writer及其只读envelope预览共用该选择，Golden、显式review、原生配对和采用门不变。未知源码保持原来的维护配方和明确失败，不扫描名字自动重写新包。

9个基础变化中，7个是已核对所属函数/异常链后的限定局部绑定变化，另外2个涉及手动动作的action-only分支与summary入口参数。手动Compact只在原WeakMap owner给出操作时覆盖`promptlessAction`，否则保留resume和native idle summary的原选择；summary捕获引用实际`mcpTools`参数，未被手动请求接管时保留native threshold分支。startup的2个变化跟随`actionOnly`而非旧resume布尔值；继续消耗原私有ticket、使用原非用户启动载体，不跳过普通空输入拒绝，也不发一条用户任务消息。

独立公开fixture实际执行这些变换：普通空输入、native idle、resume、明确手动Compact与private startup分别断言；保留原异常对象、managed retry拒绝、工具回调失败隔离、epoch过期和automation throttle。8项配方/行为测试还调用原profile publisher，在临时目录验证输出可精确重放、修改源码后unknown-sha、源文件未变。它们不是复制整份私人Host来写测试，也不代替完整原生运行。

## 实际磁盘静态窗口

独立调用`qualify-host-health.ts --candidate-recipe current-state`，只读指定source/worker，在内存生成候选后送入同一个正式Rust/FD分析程序。此选项不能与选择profile混用，报告明确`candidateOrigin=maintained-recipe`、`reviewed=false`、`published=false`；自动监控不会因此采用一个未审核的候选。

| 对象 | 该窗口实测 |
|---|---|
| 原source | SHA `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`；26,523,565字节 |
| companion worker | SHA `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e`；677,638字节 |
| 新维护配方 | core39/39、checkpoint3/3、current-state19/19；完整有序apply成功 |
| 原维护配方 | 仍在managed-retry-gate失败，没有覆盖回旧报告 |
| 61片实际候选 | SHA `ab28117e86cdb619350f25813f311d2326d797074dc00bb85778516283381378`；26,547,337字节 |
| 三份artifact | Oxc严格语法/semantic诊断均0；不是只返回非空AST |
| 当前三个规则 | 均unsupported：main-call-not-unique、retry-control-flow-unproven、checkpoint-registration-unproven |
| Host/worker资格 | unreviewed-pair；原配对pin未修改 |

该次Rust分析1137ms，完整资格命令16377ms，只是单窗口测量。实际native source/候选/worker未执行，profile未发布，loaded未检查，`qualified=false`。末尾再次静态复核的命令及同参重试被工具安全状态检查拦截，未执行；不冒充获得了第二份来源观察。前述成功窗口及绑定源码仍是本报告的来源。

## 从真实factory发现的注册错误

原见证表把Alert observer方法记成`attach`，但实际工厂导出`attachManager`，identity模式的窄集成没有覆盖它。现在用实际session、context、ownership、run、alert、server-activity、receiver工厂构造完整route表，核验8个所选能力，再逐个替换方法/getter，12项测试验证改变可见且getter不执行。同步补入run的group/buffered/current/progress、context的wrapRun/manualOptions和独立resume gate。preload原赋值点登记这些真实引用，不重新记住被替换的对象。

## 入库状态并发修正

扩大回归暴露先读取内存current、再用另一lane的committed作为持久化凭据的错误。新增可控阻塞反例实际复现：编译通道完成OBS intake时，挂接通道的新观察尚未留存，却被显示committed。现在显式比较两个通道当前观察与各自已留存key，共享入库标记不能越过任一已显示的未留存变更；停用也不沿用该标记。原event ID、原单writer和原OBS事务不变。无心跳增长测试先等两条原观察实际留存，不把内存状态当证据。

## 验证与保留差额

最终固定源码`8b5aeed3db7e07a12701360fd8e3416c12aa0afe9c3e2e9667f60c7b1c143e17`，1173个源码/测试/工具链输入；core463项/47文件、integration23项/17文件，两组前后相同，合计486项/0失败。Rust20、协议生成一致性、根/Web类型检查通过。包装内部witness Node20、编译Node11、Chrome66及其他原管理域通过，不与486相加。正式build、tarball安装、Rust二进制/FD及搬移Web在integration实际执行。

先前窗口出现过浏览器180秒超时和一次保护页刷新后继任链接计数0；增加了超时TAP与失败时源状态/页面诊断，保持原断言，不加跳过或隐式重试。后续完整窗口通过，但这两次失败的根因仍unverified，不能因重跑绿色宣称已经修复。HOST整体仍是施工资格，不是完整稳定性放行；浏览器差额继续归WEB-03。

最终文档与实际CLI覆盖15项通过。全工作树公开扫描1468个文本文件，发现1条并行`docs/roadmap/voice-delegation-spec.md`第17行的本机路径；本批文件未出现扫描项，但全工作树发布检查不能标通过。保留并行文档及其暂存状态，不为本批提交改写或隐藏该结果。

完整实际Host角色、idle summary的端到端受管行为、全能力checker与opportunity/bypass、Host/worker当前配对、真实Provider/App和独立告警出口仍未关闭。此批不扩展现场授权、不读取真实Memory、调用模型或切换服务。并行VOICE规划文档保留原暂存状态，不混入此实现提交。
