# 官方式 Bot duplicate

此入口提供原生复制，不是当前上下文恢复或完整 clone。产品边界见 [S13](../roadmap/box-runtime-impl-spec.md#continuity-primitives)，来源资格见 [CONT-06](../tickets/CONT-06-native-duplicate-cli.md)，真实账户/App 验收只在 [LIVE-NATIVE-DUPLICATE](../tickets/LIVE-integration-validation.md#live-native-duplicate)。命令注册与源码合并均不代表现役服务已经采用。

## 预览、提交与原请求读取

使用同一版本的 CLI 与已固定 installation 的管理 Server。源必须为精确 Bot UUID 或该 installation 的 Bot reference；不从同名对象或群推断目标。`duplicate.json` 只需保存一个持久化的 `requestId`；kind/action/target 由命令提供，不在文件重复。

```bash
grokbox bot duplicate "$SOURCE_ID" --input @duplicate.json --preview
```

预览只读，不创建 Bot 或初始化安全库。它绑定源 profile、Routine revision、原生账号 scope、归属和 Gateway/凭据代际，并披露原生复制副作用。Routine 返回窗口不是完整本地/Temporal 清单；必要来源缺失不是零。

明确接受预览列出的副作用后，保持同一输入文件，使用返回的 scope 与 revision：

```bash
grokbox bot duplicate "$SOURCE_ID" --input @duplicate.json \
  --scope-id "$SCOPE_ID" --expect-revision "$PLAN_REVISION" \
  --accept-non-atomic --confirm

grokbox product operation get "$REQUEST_ID" --scope-id "$SCOPE_ID"
grokbox product operation reconcile "$REQUEST_ID" --scope-id "$SCOPE_ID" --confirm
grokbox bot ownership get "$TARGET_ID"
```

`product operation get` 读取原 installation/principal/scope/request 的管理回执，不要求 Gateway 在线。`reconcile` 仅消费原 CONT 已保存的 duplicate 身份回执，不进行原生写入、不靠名单差异猜新对象。历史 `agents operations show` 仍可只读旧 CONT 记录，但不创建新管理请求；旧 `agents duplicate` 已退出注册。

## 原生语义与权限

复制保留选定 profile/设置/头像和本地 Routine 定义，清会话，不完整复制独立模型 blob 库或文件 Memory。新对象可能成为活动聊天；复制的 Routine 不会被管理入口自动停用，可能发生后续计费运行。它不是安静或 prepared 的替身，也不保证新对象为 Box ownership。

管理权限分别要求 products.read/write/duplicate 与 routines.write；这不替代原生账号/源 ownership 资格。不会迁移源归属、转交关系、删除源或复制 grokbox 模型分配。改名必须用独立 `bot update`，不在复制后暗中补写。Bot/Group 创建、更新、删除、hidden、notify 与成员集合设置也分别是一个审阅过的原生操作。

原生 API 没有源状态 CAS、全局账号锁或原子快照冻结。`--accept-non-atomic` 明确接受这一限制；本地互斥不能升级成跨 App 排他保证。成员集合更新先用 `group get` 读取，再用 `group members set --input @file --preview` 审阅 1–6 个精确、唯一的 Bot UUID。

## 未知结果与证明范围

管理请求复用原 CONT 安全数据库；新请求先持久化，再领取单次派发，原 duplicate 程序仍拥有复制效果和原生身份回执。GET 不初始化、不迁移、不修复损坏库。容量不足拒绝新操作，不按普通日志 TTL 丢弃未知历史。

原生 HTTP 超时、失败、身份回执缺失不证明未执行。同一 request 重入读取历史，不重放未知创建；换 request UUID 也不能越过该目标的未决效果。只有明确发生在传输前的本地拒绝可记录为 not-dispatched。返回字段 `nativeReceipt`、`readBack`、`cleanup` 分别表示回执、读回和清理结果，不能用 `state=complete` 概括对象可用或全部职责完成。

`packages/server/test/products.test.ts` 在真实 Node HTTP/SQLite 和打包 CLI 上执行合成原生端点测试；`packages/box-runtime/test/native-product-qualification.test.ts` 与 `native-duplicate-qualification.test.ts` 需显式 `GROKBOX_TEST_NATIVE_CONTINUITY=1`，只执行固定原生源码的选定函数。两类证据均不签真实账号复制、App 展示或模型消费。当前施工审查及未解决项见 [AH-138 验证回执](../reports/2026-09-23-native-product-review.md)。
