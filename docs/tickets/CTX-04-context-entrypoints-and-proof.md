# CTX-04 — 旧会话下一消息恢复、操作入口与整体验收

Status: **Implemented / combined offline and native-isolated qualification recorded / independent review pending**。源提交 `883e224`、`269f1e2`，升级/授权一致性修复 `358c057`、`f4b3a18`。源码不再是Spec-only；尚未据此宣布用户现役会话已恢复或正式发布。

## Goal / release blocker

**CTX-A01不可替换：** 已有过长历史，最近以error/aborted/无有效usage结束，正常部署新能力与本地128K策略后，一条普通新输入在首次主HTTP之前触发必要compact，并完整处理一次；旧失败STEP仍失败、已执行工具不重做。不用新建短会话、手动摘要或制造上游400替代。

唯一产品/算法/状态/证明合同在 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)。本票组织CTX-00–03的实际集成、命令与验证，不创建第二预算或另一套现场进度表。PI-AI-01传输研究不阻塞当前AI SDK路线。

## Actual entrypoints and retirement

CLI `agents context <agent> [--session <id>] --json`纯读configured预算、历史维护回执和当前有限native capability，历史成功不能当当前root已观察。`agents compact <agent> [--session <id>] --operation-id <id> --confirm --json`只在真实已加载默认Box session空闲安全点执行原生summarize动作，不发送“请总结”业务prompt或伪造STEP；named/server/subagent不隐式映射，busy/无shell明确拒绝。

Host输入/restore/工具后与modeld准备/实际出站均检查本地预算，新候选保持原输入sourceRef/nonce/元数据。可信维护消息为wire8，config升级至schema3而models保留schema2。正常auto由配置与能力资格决定，旧 `GROKBOX_MODELD_HOST_COMPACT` gate已从正常路径退出；注入仍off。源码日志/命令使用安全结构化错误及统计，不写摘要正文/原历史/credential，错误不进入有效Memory。

用户消息进入实际Host之前，配置写入与模型选择仍在原domain writer。迁移后续版本保留旧retired manifest/备份，不能以删除旧回执开新迁移；preflight与首次主请求、后续维护共享原TURN的credential/policy/lifecycle，不能在维护时绕过取消或热换key。

## Executable acceptance

```bash
bun scripts/verify-runtime-rebuild.mjs context-maintenance
bun scripts/verify-runtime-rebuild.mjs context-policy
GROKBOX_TEST_NATIVE_HOST=1 bun scripts/verify-runtime-rebuild.mjs context-native
```

公共组合case运行真实Pi衍生算法、kernel/SDK/Unix/本地HTTP、临时持久store、Node打包入口；expected来自独立事实断言。核心用例为Fake provider始终接受500K，长失败root收到单条新输入，本地128K仍先compact；工具尾部/早期事实/当前消息保持，重复维护不新增推理。连续至少10次维护后退出owned进程，由新进程读回当前root继续，不借旧RAM。新key在preflight后变更时首次主HTTP拒绝，原输入及已提交checkpoint不受损。

取消/迟到/pending/错source或material版本、空/缺finish/工具输出、预算耗尽、旧STEP/关闭TURN、同operation重复/unknown、schema迁移/别名/模型原字节、官方对照和import fence分别验证。实际suite、计数、Node20/Node22区别及初次全库失败归[固定离线报告](../reports/2026-09-17-context-maintenance-offline.md)。原生隔离方法需要固定合法source，只签实际执行的slice/consumer范围；外围blob/状态替身不变成全原生事务证明。

## Review and actual remaining gate

要求固定提交、只读、P0/P1边界的Astra review在三个阶段均返回provider503，最终干净候选 `804c994` 也没有审查报告。独立review是本票未完成的非live前置，不改称live待办，不用实现者自审替代，也不为了推进修改报告为通过。新source更改须对最终固定候选复核，旧报告不签新构建。

当前已验/未验、阻断和下一动作只更新 [ADOPTION](LIVE-integration-validation.md#live-ctx-adoption)、[NEXT-INPUT](LIVE-integration-validation.md#live-ctx-next-input)、[DURABILITY](LIVE-integration-validation.md#live-ctx-durability)。用户已授权本功能完成前置后rebase v2及Host/modeld切换/重启；仍先固定集成候选、匹配制品、原配置/回退、在途对象保护和逐请求费用预算。没有原版App接口时该子项not-observed，CLI投递不能替代App输入/详情/Working通过。

完整native archive/checkpoint跨真实重启、未知结果对账和业务会话继续不从临时store或一次restart推导。动作仅限批准范围，未知副作用先保全/对账，不删除ledger、重发旧失败STEP或回滚用户新历史；平台Reset和npm发布不在本次授权里。

## Exit / claim boundary

代码、公开/打包/原生隔离证明、独立review、合入v2与真实采用分层关闭。原版Host工具循环、Memory、原始会话与archive不由Pi接管；不承诺不可压缩单条输入或摘要服务不可用时仍生成答案。常态已支持的长历史应进入有界维护而非无限发已知超预算请求，失败须准确呈现且不破坏/重放工作。
