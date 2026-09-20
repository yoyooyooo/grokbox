# Host lease / finally 静态生命周期

2026-09-21，HOST-01 工作包。承接当前源码和 checkpoint ABI 配对，不重做旧控制面或另建验证器。

新增 `context.lease-finally@1`，通过原 Rust registry、Node/FD、TS 健康组合、原 provenance/OBS 和 CLI/Web 自动查询路径执行。它验证实际 compact 返回值被保存、同步 disposer 登记到同一资源环境后才 await preflight、真实 root 的 executeToolStream 位于同一保护区、其 response 在正常 return 前被等待、finally 精确释放同一环境。关闭标志必须先于原 lease dispose；私有 active/lease/slot 不得逃逸或覆盖，资源环境不得提前清空或释放。

编译器资源 helper 是单独的有限 ABI 依赖。检查其真实词法绑定、不可重写和已资格化 initializer 摘要，不凭函数名字判定会清理。原 Host 的两段 helper 通过显式 native 资格测试实际执行：同步 receiver、LIFO、原错误、清理失败仍释放后续资源、SuppressedError 与无效 disposer；不复制私人代码到公开 fixture。公开测试另有独立编写、单独执行的同步 helper。helper 字节变化必须重新资格化，不能凭相似度继续 passed。

9 组 Rust 反例覆盖省略/错绑 finally、登记顺序、异步 disposer、关闭次序、影子变量、别名/覆盖、helper 变化，以及返回未等待的 response。后一反例先复现 passed 漏判，随后加入同一异步 owner、实际 response 等待和正常提前 return 的拒绝。该检查不声称解决任意 heap alias、远端取消、Promise.all 某分支失败后其他外部工作的物理结算或全部后处理生命周期。

管理故障组合通过原 TS 变换重新固定候选 hash；合法 JS 中把关闭标志改错会形成安装级 semantics incident，重启不重复，准确新正证据才恢复。无原生 RPC 或模型。健康合同增至 host-health-v2；历史 v1 的原三项证据仍可读取，但不能升级为新生命周期资格，不能删掉缺项冒充新合同。

实际磁盘取样：source `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`，worker `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e`，61片候选 `187c57a8fb2b11b8ee51f2ff73203f62b805e13a28dedc829de295dd02024db4` 均与前一包相同。正式 Rust 的四项检查全部 passed，三份 artifact 严格语法/semantic 诊断为0。此窗口分析2435ms，完整静态命令18807ms，仅单次测量；未执行主 Host、发布 profile、调用账号/模型或改变服务。

提交前源码 `fdcebd0a2fc9b8d5b602310394326157a1e33fbdda99c57d26d50cd387ec031a`、1184输入。Rust39、根/Web类型、协议一致性通过；focused实际 verifier Node23、Host管理 Node11通过，native helper3通过。扩大core500项中498通过、2失败，均是原架构检查的空/最小fixture在5秒内未等到esbuild完成；没有放宽或跳过，根因尚未确定，不计整组通过。大阶段最终组合另行固定。并行VOICE文档保持原暂存状态。
