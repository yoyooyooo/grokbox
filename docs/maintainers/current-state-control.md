# 单盒当前上下文操作

当前状态控制通过绑定安装的管理 Server，CLI、共享客户端和 Web 共用同一 CONT 程序。对象仍是原生 Bot 的一份当前工作上下文，不提供 session 列表或切换，也不把管理引用改成跨产品人格。生命周期与关系交接见[生命周期指南](bot-lifecycle.md)，剩余能力归 [CONT-07](../tickets/CONT-07-current-context-control.md)，真实现场资格归 [LIVE-CURRENT-CONTEXT](../tickets/LIVE-integration-validation.md#live-current-context)。

## 权限与原生能力

查询当前原生 head 需要 `context.read`；捕获、初始化、重置、恢复和原操作准备阶段的续接/对账/取消需要 `context.write`；解除原准备屏障另需 `context.activate`。历史回执需要 `operations.read`。原生 scope、所有权、资格、当前 revision 和 worker 屏障仍独立核对，管理权限不代替原生资格。

生产适配只调用本 Box 已加载并已注册的原生 current-state 能力，不直写原生数据库、不自动升级 Host 或变更 profile。原生能力缺失明确 unavailable，没有本地副本或模拟成功 fallback。远端调用者必须选择显式安装绑定，管理 Server 仍只操作其本机原生源；旧 `agents state ...` 不再注册，也不作为恢复备用 writer。

## 正式入口

以下命令都以准确 Bot UUID 或安装内引用为目标。`scope-id` 和 `expect-revision` 来自该 Bot 当前读面；`request-id` 由调用者在发送前持久保存。

```bash
grokbox bot context get <bot-ref>
grokbox bot snapshot create --bot <source-bot-ref> --scope-id <scope> --request-id <uuid> --expect-revision <native-revision> --confirm
grokbox bot context initialize <unused-target-ref> --snapshot-ref <snapshot-ref> --scope-id <scope> --request-id <uuid> --expect-revision <target-revision> --confirm
grokbox bot context reset <bot-ref> --scope-id <scope> --request-id <uuid> --expect-revision <native-revision> --confirm
grokbox bot context restore <bot-ref> --snapshot-ref <snapshot-ref> --scope-id <scope> --request-id <uuid> --expect-revision <native-revision> --confirm
```

捕获只保存原生 checkpoint 的声明闭包和受支持补充，不修复源、不调用模型。初始化导入同账号 scope 的已发布材料，可能包含声明的 agent Memory、历史显示与受管指令；共享 user/project Memory、完整附件和外部依赖不是这份快照的隐含完整性保证。目标已经运行或含请求、转录、结算、待处理 Routine 结果时，即使没有 root，也不能当成未使用目标。

reset/restore 只用于外部操作者选择的空闲、已加载、拥有当前 root 的目标。备份先于上下文替换，备份、候选及原请求的关联在 CONT 中保留；不回滚长期 Memory、模型配置、已经发生的文件或外部任务效果。含未知效果的来源只允许原程序支持的受限恢复候选，不把过去 pending 工具重新发起。self-reset 的持久安全排队仍未交付，不以同步调用规避。

## 保存、应用、解除屏障分别核对

原生 worker 在自己的事务中写 root/依赖及应用标记，主 Host 再核对发布、重新装载并记录其应用状态。CONT 只在对应读回和清理结算后确认历史应用，不能以某一个数据库成功代替整段完成。结果 `prepared` 不代表允许新输入，更不代表已启动模型任务。

```bash
grokbox operation get --domain context --scope-id <original-scope> --request-id <original-uuid>
grokbox operation reconcile --domain context --bot <original-bot-ref> --scope-id <original-scope> --request-id <original-uuid> --confirm
grokbox operation resume <context-operation-ref> --domain context --bot <original-bot-ref> --confirm
grokbox bot activate <original-bot-ref> --scope-id <original-scope> --request-id <original-uuid> --expect-revision <current-prepared-revision> --confirm
```

普通提交重入只返回原历史，不继续准备或重发写入。`resume` 才推进保存的原计划；已存在未知原生应用时只能查原标记，不能再 apply。`reconcile` 不捕获、compose、导入或解除屏障，仅核对已保存发布或原生应用证据并结算原记录。原生标记缺失不是未执行证明。

`activate` 使用该原操作的应用标记解除准备屏障，只允许后续普通输入，不发用户消息、不启动业务任务。首次解除前固定其审阅 revision；丢回复后使用同一原操作和首次解除 revision。读面 `activationExpectedRevision` 保留该定位，浏览器不在 localStorage 保存 revision。原生解除接口能证明同一标记已解除，或仅解除其仍准备中的原 hold；不能打开另一操作的 hold，更不能用旧材料覆盖目标后续 B1/B2。

管理 Server 持有已受理操作，客户端断开不等于撤销；服务关闭会取消实际原生读取并等待有限回调与持久结算。进程被强杀后原 CONT 安全记录仍在，重启不能取得第二次未知 apply 权限。历史查询不依赖当前 Host 存活，也不创建、迁移或修复安全库。

## 有证据的准备阶段取消

```bash
grokbox operation cancel <context-operation-ref> --domain context --bot <original-bot-ref> --confirm
```

仅在持有原 driver 互斥、没有任何原生应用声明、也没有解除声明时允许取消。它保存原请求墓碑，释放不再使用的准备材料引用，不删除原请求或原生资料；同一旧请求不能在取消后复活。已有 prepared/effect_unknown 的原生应用声明都不能靠取消变成未执行，也不能换 UUID 绕过目标未决操作。缺失或损坏的已知 CONT 数据库不重建为空历史。

材料保护与回收在原 CONT 数据库事务内检查：未完成准备、未结原生效果以及等待解除的上下文保留其来源/备份/候选引用；受支持的完成或准备取消只退出自己这组引用。历史回执可以继续指向已经按原策略退役的材料，保留引用不等于正文永久可用。

## Web 与证据范围

`/contexts` 只为明确选择的 Bot 读取当前 head；历史可按原 operation ref 独立查询。捕获、上下文替换、对账、有限取消与解除分别明确确认，CSRF 和服务端权限持续检查。草稿 revision 不被后台页面刷新偷偷替换；提交前只持久化原主体/安装/Bot/账号 scope/request 定位，正文、快照选择、revision、令牌不进入本地恢复记录。未知原生效果仍阻止替代提交；尝试取消或续接被拒绝，不能把原未知效果误标为已拒绝。

[管理 Node 测试](../../test/context-management.test.ts)使用真实 HTTP、CONT SQLite、原生 owner/RPC/checkpoint worker、打包 CLI 和受控 SIGKILL；原生 schema、账号和资料均为隔离合成输入。[生产浏览器旅程](../../apps/web/test/context-browser.node.ts)消费搬移后的 Web 制品，没有假后台。它们不证明现场 Host/Provider/App 的恢复首轮，也不关闭全附件、self-reset、逐职责资源独立和安全退役等剩余义务。完整阶段结果记录在 [CLI-05](../tickets/CLI-05-implementation-follow-through.md)。
