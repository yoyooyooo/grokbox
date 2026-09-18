# 接收者自动任务选模预检 · 2026-09-18

本轮接续 a429af2 之后未提交的接收者代码；运行时代码提交为 `5bd99af`。合同归 [T55](../tickets/T55-custom-receiver-delivery.md)、[T46](../tickets/T46-template-ops-pairing.md) 和 [Template Ops](../roadmap/template-ops-automation-spec.md#receiver-resilience)。现场只归 [LIVE-OPS-RECEIVERS](../tickets/LIVE-integration-validation.md#live-ops-receivers)，本文不维护第二张当前状态表。

## 实现范围

候选新增 `ops targets blueprint <alias>` 和 `ops targets verify <alias>`。blueprint从已配置的routineKey生成固定的disabled Webhook定义；提醒限制只用于自动告警回合，不改Bot永久persona、不限制后续用户委托。JSON命令返回正常CLI envelope，保存为apply输入时取其data对象，不把整个CLI回执作为Routine定义。

verify只读已准备的私有绑定、monitor安装scope、受管Routine身份/revision及当前原生模型观察，不读取凭据、不改配置/定义、不写资格、不授权canary或发送。源缺失、未配对、启用状态改变、prompt策略不符、解绑、作用域/配置变化或过期观察均阻断。`preflight_ready`只表示这些本地预检通过；Server所有权、实际Webhook回合、工具能力、用户已读与HTTP资格仍明确未证。

Host增加受profile资格控制的 `receiver-native-model-preview` 观察点：在原生会话工厂旁登记只读选模闭包，复用原生automation请求来源、实验配置、默认模型和环境覆盖逻辑，不创建会话、取得凭据或请求模型。route模式同时核对精确Agent的受管选择revision，前后重读配置/选择以发现变化。输出仅为关系与摘要，不输出模型参数、Provider endpoint或凭据。范围限定于下一次本地默认自动任务会话，不推及子任务、自定义session覆盖或服务器执行。

原生状态中的能力与模型改为从同一个有界getHostStatus响应投影，前后核对reviewed profile，避免拼接不同请求的代际。与Routine列表的Gateway代际另行比较。完成本地最终核对后再次校验五秒新鲜度，不能将验证中已过期的模型见证作为绿色结果。已有HCR调用继续使用原窄能力接口，未新增Server List或模型请求。

当前原生源变更了三个告警锚点中的局部变量名，候选只更新这些精确锚点并加入新观察点；不放宽SHA/唯一匹配门。默认未加载对应profile/preload的Host不会自动取得该观察能力。

## 已执行验证

固定工具链 Bun 1.3.14，现有Node/依赖下限未变。

- `bun scripts/verify-runtime-rebuild.mjs ops-receiver` 完整执行：117 pass / 0 fail，10文件、916断言；类型、构建、导入边界、隐私检查通过。运行时源码此后未改变；随后补齐合成夹具和测试宿主。
- `GROKBOX_TEST_NATIVE_HOST=1 bun test packages/box-runtime/test/native-receiver-model.test.ts`：1 pass / 0 fail，72断言。该探针对独立明确的当前源SHA应用完整recipe，再抽取选定原生函数，用受控依赖比较6种实验/环境组合的预览与自动任务会话选择。零真实鉴权/模型请求；不是完整Host或云HTTP验收，不更新其他旧native探针的资格。
- 全CLI目录复验：732 pass / 0 fail，69文件、5958断言。
- packages按名称排序拆成不重叠三组，总260文件。最终第一组[0,87)：576 pass / 4 skip / 0 fail；第二组[87,174)：580 pass / 16 skip / 0 fail。第三组[174,260)的86文件被工具检查拦截，未执行完成。**不宣称最终全仓全绿。**
- J1的14项合同测试包含在已通过专项中；没有改动CONT公共owner/ref/事件语义，没有实现替身、关系迁移或Bot删除。

实际preload SHA-256为 `3af36e018531cbfe30289ed7386d3b2bec05541e853814bbfd1748410e1f39ef`，由真实构建更新pin并通过拒旧制品检查。专项时源摘要为 `f0d397379ca7c867cfa7c0dd90a54ab1d6570723a2eb2a2c92d726812bb09984`；它仅标识当次专项，后续夹具/测试宿主变化不能冒用该摘要。

## 实际失败及处理

首次CLI全量3项失败、首次packages全量5项锚点/清单失败：合成Host夹具仍使用旧局部变量名，且缺少新观察点。只更新独立合成scaffold和明确的slice清单，未修改生产拒绝行为；对应37项及21项/1skip集中复验通过，随后CLI全量和packages第一组通过。

两轮大组还出现架构checker子进程超时，首次另有一个通知强杀夹具超时；49项独立复验通过但不能因此称根因已证明。架构checker测试改为以发布环境Node执行该.mjs及其import probe，并在测试owner内定界、等待子进程结算。负例必须取得结构化ok=false，超时、崩溃和非JSON不再仅凭非零退出码算通过。修复后独立26项和最终第一组通过；没有扩大checker运行预算，也不泛化为已定位Bun通用故障。通知测试未改变其超时或生产逻辑，最终第二组包含该测试并通过。

针对5bd99af的独立只读Astra审查受150秒外层窗口约束，未返回任何报告，命令以124结束；不是审核通过，也不是旧503结果。本轮未换入口重做被拦截的第三组测试。

## 未证与下一步

仍缺当前原生HTTP认证/POST合同、真实接收者回合与工具/数据/费用资格、可信激活及paired发送驱动、自动通知安装，以及独立审查与最后一组回归。现有paired凭据保持prepared，发送driver仍不可用。固定prompt是任务约定，不是权限沙箱；普通聊天模型或只读预览不能替代Webhook实际运行。

本轮未修改现役配置、原生Bot/Routine、全局shim或Host/modeld，不领取真实key、不发真实Webhook/模型请求、不提Issue。schema4仍须保留旧制品与配置退路并在固定v2组合候选上成套集成/采用。索引更新和本报告均不自动部署。
