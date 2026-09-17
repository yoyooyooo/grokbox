# T58 — config 命令、唯一 writer、作用域与生效回执

## Status / Goal

**Implemented · source and packaged CLI verified。** AH-100 的路径化配置入口、共同提交程序与消费者应用事实已落地。合同归 [配置 Spec §5–6](../roadmap/configuration-rebuild-spec.md#commands)。目标端远程配置写 capability 不在当前支持范围；请求明确拒绝而非误写本机。

## Implementation

kernel `internal/commands/config.ts` 的 ConfigChange 程序与 `ConfigurationWrite.changeConfig`；box-runtime `config-store.node.ts`、`config-lock.node.ts`、`config-application.node.ts`；CLI `config-registry.ts`、`commands/config.ts`。Profile、desktop keep、operator、runtime desired 与 bootstrap 使用同一 canonical writer。

已实现 get/set/unset/apply/validate/schema/path/export/preset/recover，以及迁移、bootstrap 和别名恢复入口。config 命令绕过普通 Profile 初始化，使坏配置下的 schema/path/validate/migrate 保持可用。JSON 与 string/value-file 显式二选一；路径统一支持 dotted/JSON Pointer；数组必须完整替换、revision 和确认，领域 keep 使用锁内最新集合。

提交与应用分开：配置写锁中重读、CAS、prepared、持久发布、读回和 committed；网络不占锁。desktop 真实采用本域快照后发布精确 PID/start 的 ack。普通 get 不代签；等待超时仍报告已保存，不能撤回文件或重启服务。

## Regression fixes

- 不确定 prepared 操作不能基于后来配置重新执行，即使 A→B→A 回到相同 content hash；只允许核对原 after-state，否则保留 unknown。
- 删除 off 覆盖导致默认开启、启用摘要或恢复 target 时同样检查收费/权限确认；不能通过 unset 绕过 set 的门。
- 所有父对象/全文修改都校验子字段，不能夹入 floor、verifier、grant 或模型目录。
- selected remote Profile 的 Box 写入必须明确作用域；target capability 缺失不会回退本机。

## Executable acceptance

```bash
bun test test/config-cli.test.ts test/config-application-receipt.test.ts packages/box-runtime/test/config-lock.test.ts packages/box-runtime/test/unified-config-store.test.ts test/desktop.test.ts test/profile.test.ts test/operator.test.ts
bun test test/config-packed.test.ts
```

实际用例覆盖 source/Node packed、并发 CAS、跨入口 keep 操作、锁 owner 退出和未知锁保全、prepared/commit 恢复、精确消费者 ack、等待超时、参数/错误码/脱敏、Profile 便利入口与 bootstrap 共享写入。

## Boundaries / Remaining proof

第三方代码复审和生产切换尚未完成。没有远程配置写功能时输出 `config_scope_unavailable`；没有运行消费者时返回 pending/restart-required。ops 配置不会创建原生 Webhook 或签发维护/issue grant。上述执行能力分别由其来源票关闭，不用一个 config 命令的成功掩盖。
