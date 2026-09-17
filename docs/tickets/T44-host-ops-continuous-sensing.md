# T44 — Host 运维持续采样与同源 incident

## Status / Goal

**Planned · Spec-only。** 将现有 HSO one-shot 升级识别接成长期只读采样并纳入 T41，持续区分磁盘、已加载、组件、配置与监测自身失联。Owning contract：[Spec §4](../roadmap/template-ops-automation-spec.md#chain)、[§8](../roadmap/template-ops-automation-spec.md#storage)，来源事实继续归 [HSO](../roadmap/host-seam-ops-recognition.md)。

## Depends-on / Modules

依 T43 的事件/scope 与 T51 的 preset/预算合同，可先用 Fake；复用 T41 已实现 collector/store 和 HSO observe/retain，不等待 T41/T40 整票关闭。

`packages/box-runtime/src/internal/ops/host-seam/watch.ts`、`observe.ts`、`upgrade-sense.ts`、`seam-status.ts`、`internal/roots/monitor.runtime.ts`、`internal/io/monitor-store.node.ts`；纯分类在 kernel ops/monitor 现有 owner。profile watch 与 monitor 调用同一 provenance writer/lease，不抢占或复制源码库。

## Work

实现目录事件 dirty 标记、合并、周期 metadata/hash backstop、启动/重连/PID+start/overflow 重新采样；各资源在 monitor Effect Scope 内，背压与 single-flight 有界。填真实 sense，而不是 CLI 永远传空。source 捕获用 fd/字节一致性，installed 与 loaded 分列，companion 未覆盖明确 partial。

HSO receipt 固定后，T41 按稳定 source receipt ID 索引并提交 incident/outbox 意图；跨存储中断后幂等补齐，不虚构原子性。不要让 controller operation 去重吞掉后续采样。

分别分类：源码不匹配、加载漂移、完整资格过期、无资格的新 source、模型分配无效、observer gap、历史 circuit 原因。统一 status/doctor 使用同一事实定义；不从窗口名或单个 green 推断全部切片/语义安全。

## 2026-09-17 补充：默认用户与维护者分流

按 [T51](T51-ops-capability-presets.md) 的 effective 配置运行轻量/深观测；user 默认只对 confirmed user impact 且 safe remedy unavailable/blocked/failed 输出可提醒的 incident。source-only 更新、位置变化、maintainer-only debug 可记本地但不唤醒普通用户。用户上报与源码异常只能在有同源关联时关联，unknown 保留 unknown，不自动诊断根因。

无合法安全修复路径可由规则判断，不先发动模型/尝试变更来证明不能自修；T52 据此询问是否准备 issue。GET、未启服务/未配对、显式 off 与坏配置的 requested/effective/gap 要诚实显示。深 replay 不因 user 开启基础观察而自动运行。

追加 FakeClock/端到端 oracle：无用户影响连续多个 source 事件的 Bot 唤醒/模型调用/GitHub 写入均为 0；有影响首次输出一次 brief 事件，重复周期合并；maintainer preset 不改变普通用户接收范围或自动修复权。

## Executable acceptance

实现时新增 `packages/box-runtime/test/host-ops-sensing.test.ts`、`test/host-ops-status.test.ts`；执行：

```bash
bun test packages/box-runtime/test/host-ops-sensing.test.ts test/host-ops-status.test.ts test/host-upgrade-watch-cli.test.ts packages/box-runtime/test/host-upgrade-sense-contract.test.ts
bun run typecheck
```

首两项为待创建文件。FakeClock/临时源文件证明：atomic rename 丢事件仍被 backstop 捕获；同 version 不同 bytes、同 SHA 新 PID、helper-only、A→B→A、中途 swap、文件不可读、collector 重启、迟到旧 scope 都不生成虚假 safe。源先提交而 DB 未提交时可补索引；重复采样不开第二 incident。

观察模式全过程 signal/spawn/官方升级 RPC/provider 请求次数为 0；read-only status 不启动服务、不写库或 retain。数据库满或监测器退出时，现有推理不依赖本 observer；gap 可在本地状态观察。

## Forbidden / Non-goals

不接回 `observeAndHeal()`，不加执行权限，不自动清 circuit，不把安装完成从版本号/ack/PID 推出来，不读取任意日志正文，不实施升级器，不改 modeld 热路径或 Host App。

## Done evidence / Next

交付 source/CLI 测试与取消/资源释放证据；持续运行的原生安装留给 T50。T45 从已提交 incident 消费，不能在采样 callback 里直接唤醒 Bot。
