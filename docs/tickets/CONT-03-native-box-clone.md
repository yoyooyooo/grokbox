# CONT-03 — 新 Box 身份的原生导入与手动恢复

**状态：planned；创建身份已是既有能力，本票的跨身份导入/reopen尚未实现。**

合同：[S13.5](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。依赖 [CONT-00](CONT-00-native-clone-feasibility.md)、[CONT-02](CONT-02-continuity-snapshots.md)、T37/CTX-02。现场只看 [LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)。

## 目标

为指定 Temporal 源创建一个新的 Server-confirmed Box Bot，接受有来源的历史材料，持久化为新身份的合法原生上下文，关闭重开后可继续。成功只指声明的恢复质量与安全点，不意味着旧身份、旧 App 链接或第三方 ID 自动迁移。

## 模块和接口

CLI有限入口在 `packages/cli/src/commands/continuity.ts`；复用 `runAgentsCreate` 的nonce/已创建但归属未确认语义与model selection写入合同。`box-runtime/src/internal/host/continuity-import.ts` 和版本限定slices提供 target hold、native import/read-back/reopen。纯材料验证在kernel continuity，操作台账在continuity store；原生Host仍是会话最终writer。

入口必须区分只读plan、prepare和执行激活；命令名及schema随实现进入registry，不在文档中假造已经可用的CLI。plan至少列源目标scope、输入质量与水位、model/effort/预算、复制范围、关联ID变更、可能消费及不会继续的在途动作。

## 操作顺序

1. 验证source材料与用户策略，固定operation和创建nonce；请求官方Box身份并读回确认。未知创建结果先核对已知ID，不以新nonce重复创建。
2. 新Bot准备期间必须hold主回合、inbox和routine；隐藏不是hold。普通create/duplicate可能切换App当前会话，需新增或复用已验证不抢当前选择的入口。
3. 校验完整root闭包与schema，按新身份重建当前系统/profile提示；保留历史来源，仅schema化重绑必要自引用。导入Memory按agent/user/project分类，不复制共享权限或旧队列。
4. 由原生writer接受恢复候选和checkpoint；验证实际root/内容/revision，再关闭并重开新session读取。不得覆盖活跃SQLite，不以全局重启Host代替单会话lifecycle。
5. 复核ownership、model/effort和恢复质量，保留prepared状态。只有执行授权及来源副作用对账通过才允许下一次受控输入；业务接管由CONT-04负责。

完整native checkpoint优先；只有获准的 `semantic_resume` 才以归因转录/Memory生成有损恢复摘要，不能把它标为精确当时状态。缺工具结果/摘要标记/闭包拒绝精确恢复，未知结果保持blocked，而不是注入成功断言。

## 可执行验收要求

实现时新增 public fixture 和独立新进程测试，通过真实生产codec/import协议验证：新UUID/root、typed自引用、完整blob、summary/尾部、Memory provenance及正常新输入。fake Provider只能从真实收到的request验证sentinel；历史tool records不触发工具，旧pending不自动重放。

覆盖创建结果丢回执、target立即变Temporal、target已有非空root、导入前/后取消、部分native写入、checkpoint ack丢失、reopen失败；错误为明确prepared/commit_unknown，不能覆盖源或再创建一次。source/packed/原生隔离各自证明，固定native方法探针仍用CONT-00已有入口。

## 禁止与非目标

不修改原Temporal归属，不把普通duplicate当resume，不只切换内部history flag，不用目录相似度代替Server注册，不把历史请求/审批/任务句柄当作新身份待执行状态。全自动替换、routine切换和旧UUID重定向不在本票；手动恢复闭环先于自动化。
