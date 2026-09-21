# CTX-04 — 旧会话下一消息恢复、操作入口与整体验收

Status: **管理入口已迁入统一 Server；完整原生/App 与独立审查未关闭。** 当前手动维护、原请求恢复和旧入口退出见[管理阶段报告](../reports/2026-09-21-compaction-management.md)。原有主动维护与 confirmed-overflow 程序继续复用，不由手动 Compact 验证替代 CTX-A01。历史提交与窗口只证明其原版本，不能作为本次新版采用许可。

## Goal / release blocker

**CTX-A01不可替换：** 已有过长历史，最近以error/aborted/无有效usage结束，正常部署新能力与本地128K策略后，一条普通新输入在首次主HTTP之前触发必要compact，并完整处理一次；旧失败STEP仍失败、已执行工具不重做。不用新建短会话、手动摘要或制造上游400替代。

唯一产品/算法/状态/证明合同在 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)。本票组织CTX-00–03的实际集成、命令与验证，不创建第二预算或另一套现场进度表。PI-AI-01传输研究不阻塞当前AI SDK路线。

## Actual entrypoints and retirement

CLI `bot context compact <bot> --preview` 读取已核对账号、加载代、模型选择、预算策略和默认 Box session 的原生能力。明确提交携带 `--scope-id`、`--expect-revision`、`--request-id` 与 `--confirm`；可能消耗摘要模型费用，但不发送业务 prompt 或伪造 STEP。preview revision 不是未来 root 的快照，原生 runner 在安全点选取当时的 current root；named/server/subagent 不隐式映射。`operation get/reconcile/resume/cancel --domain compaction` 定位原请求，准备、未知派发、modeld 提交和原生 shell 结算分开。原 `agents context/compact`、直连 Gateway writer 及仅为其存在的 mock 已删除，没有兼容转发。

Host输入/restore/工具后与modeld准备/实际出站均检查本地预算，新候选保持原输入sourceRef/nonce/元数据。可信维护消息按当前 wire/配置/模型合同核验；manual approval 在 Host、wire 和 modeld 共用声明，缺失或变更不得作为当前授权。正常auto由配置与能力资格决定，旧 `GROKBOX_MODELD_HOST_COMPACT` gate已从正常路径退出；注入仍off。源码日志/命令使用安全结构化错误及统计，不写摘要正文/原历史/credential，错误不进入有效Memory。

用户消息进入实际Host之前，配置写入与模型选择仍在原domain writer。迁移后续版本保留旧retired manifest/备份，不能以删除旧回执开新迁移；preflight与首次主请求、后续维护共享原TURN的credential/policy/lifecycle，不能在维护时绕过取消或热换key。

## Executable acceptance

```bash
bun test test/compaction-management.test.ts packages/box-runtime/test/compaction-management.test.ts
bun scripts/verify-runtime-rebuild.mjs context-maintenance
bun scripts/verify-runtime-rebuild.mjs context-policy
GROKBOX_TEST_NATIVE_HOST=1 bun scripts/verify-runtime-rebuild.mjs context-native
```

公共组合case运行真实Pi衍生算法、kernel/SDK/Unix/本地HTTP、临时持久store、Node打包入口；expected来自独立事实断言。核心用例为Fake provider始终接受500K，长失败root收到单条新输入，本地128K仍先compact；工具尾部/早期事实/当前消息保持，重复维护不新增推理。连续至少10次维护后退出owned进程，由新进程读回当前root继续，不借旧RAM。新key在preflight后变更时首次主HTTP拒绝，原输入及已提交checkpoint不受损。

取消/迟到/pending/错source或material版本、空/缺finish/工具输出、预算耗尽、旧STEP/关闭TURN、同operation重复/unknown、schema迁移/别名/模型原字节、官方对照和import fence分别验证。初始suite、计数、Node20/Node22区别及全库失败归[原离线报告](../reports/2026-09-17-context-maintenance-offline.md)；后续真实端点503/备用200、同会话显式备用、手动操作六分支和最终2256通过/7跳过/0失败归[补充证据](../reports/2026-09-17-context-provider-failure-evidence.md)。实际已采用版本与新修复的采用状态只看LIVE，不能将相同wire8冒充同制品。原生隔离方法需要固定合法source，只签实际执行的slice/consumer范围；外围blob/状态替身不变成全原生事务证明。

## Review and actual remaining gate

要求固定提交、只读、P0/P1边界的Astra review在三个阶段均返回provider503，最终干净候选 `804c994` 也没有审查报告。独立review是本票未完成的非live前置，不改称live待办，不用实现者自审替代，也不为了推进修改报告为通过。新source更改须对最终固定候选复核，旧报告不签新构建。

真实config3/wire8成套采用和一次modeld replacement已执行，详情在[固定CTX-V8窗口](../reports/2026-09-17-context-v8-live-window.md)；原阶段不包含晚到的5f2afdb；其后已从集成v2 `6e88991`非强制重启Host并replacement modeld、核对新preload，见同报告§9。两个阶段都不能覆盖被工具拦截、没有accepted回执的原Bot消息。review仍无完整结论，错误/成功端点测试不替其签字。

当前已验/未验、阻断和下一动作只更新 [ADOPTION](LIVE-integration-validation.md#live-ctx-adoption)、[NEXT-INPUT](LIVE-integration-validation.md#live-ctx-next-input)、[DURABILITY](LIVE-integration-validation.md#live-ctx-durability)。用户已授权本功能完成前置后rebase v2及Host/modeld切换/重启；仍先固定集成候选、匹配制品、原配置/回退、在途对象保护和逐请求费用预算。没有原版App接口时该子项not-observed，CLI投递不能替代App输入/详情/Working通过。

完整native archive/checkpoint跨真实重启、未知结果对账和业务会话继续不从临时store或一次restart推导。动作仅限批准范围，未知副作用先保全/对账，不删除ledger、重发旧失败STEP或回滚用户新历史；平台Reset和npm发布不在本次授权里。

## Exit / claim boundary

代码、公开/打包/原生隔离证明、独立review、合入v2与真实采用分层关闭。原版Host工具循环、Memory、原始会话与archive不由Pi接管；不承诺不可压缩单条输入或摘要服务不可用时仍生成答案。常态已支持的长历史应进入有界维护而非无限发已知超预算请求，失败须准确呈现且不破坏/重放工作。
