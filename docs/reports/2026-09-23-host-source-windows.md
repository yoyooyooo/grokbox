# AH-159 · 固定来源窗口、变化分类与增量回流证据

日期：2026-09-23。技术合同唯一归 [HOST-01](../tickets/HOST-01-patch-health-verifier.md#持续来源演进与资格窗口)，排程和问题去重归 Linear AH-159。本文件记录实际执行的有限证据，不是另一套完成清单，也不是 Host 部署/采用许可。

## 实施基线与证据身份

独立分支 `feat/ah-159-host-evolution` 最初基于 v2 `13f2296f`，随后 rebase 到 `53fc9810`，保留 AH-120 的 core-risk 与 AH-121 的 core-observation 清单、授权门和原生声明校验。实施及浏览器依赖清单校正后的验证输入覆盖1297个源码/测试/锁文件；各组前后摘要一致：

`49c693eba2f53eff2aed718e9285513078485251e735751773829190016a7090`

| 身份 | SHA-256 |
| --- | --- |
| 当前只读 Host | `bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be` |
| 当前只读 worker | `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c` |
| 无选定profile的捕获sourceSet | `e81bb40939ae38a2f1eed27b63de32be538e2090fe43940e1d7ed218e0943b4e` |
| 完整61片有序recipe | `34b214eb0dd37eb22697f8e47252db55498bd39e85870f4c41f77e5b8c7a5fcd` |
| 变换后Host候选 | `830a2c20dc2c4d31f58fdb716588c0cfec9341b7bdb11907663428eca08d9529` |
| worker候选 | `8eb521daa9a75cd5c09c377c4b9ff69d483fe783d83d5f98f845ad7b4f85eb8f` |
| Rust/Oxc checker build | `bb2c3de8760071da273297f660381b8e200df4638ce7daddb9dabcac5378d2ab` |
| 跨语言schema | `8fbb644ff38372420dfb8bde1f4eb3fbebdab6c26941e8e5c61dbb4cd8a18aac` |

捕获时主Host为27,015,685 bytes、worker为677,653 bytes。日期报告中的“当前”仅指本次读取，不外推至后续上游更新。摘要不是源码副本；原始私有字节不进入仓库或此报告。

## 一次真实安装更新的只读回放

真实安装变化来自 AH-157 的实际采样，而不是本票人为改写安装文件。原记录可在 AH-157 的评论 `09f60abb-3703-4e23-93f6-295b507d240f`（2026-09-22 21:36 UTC）与 `5e0c82d0-7e2f-4436-9907-a92b54941d56`（2026-09-23 00:51 UTC）核对：Host 从 `68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc` 变为上表bfa76e，worker仍为da6796。后者当时被独立原生源校验拒绝为 `native_message_source_mismatch`；旧窗口通过没有授予新版本资格。后续原Owner已完成准确bfa/da配对复验，见 [AH-157消息与来源窗口](2026-09-23-native-message-source-evolution.md)。

本票使用新原入口重新读取实际安装的bfa/da，以旧68/da的完整摘要作为显式比较基线：

```sh
bun scripts/qualify-host-health.ts \
  --source "$READ_ONLY_INSTALLED_HOST" \
  --worker "$READ_ONLY_INSTALLED_WORKER" \
  --binary-directory dist/native/x86_64-unknown-linux-gnu \
  --candidate-recipe current-state \
  --reference-host-sha 68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc \
  --reference-worker-sha da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c
```

命令使用仓库声明的Bun1.3.14与实际打包checker，路径变量只表示明确的只读安装输入，不是新服务配置。2026-09-23 05:23:05 UTC 的回执为：`changedComponents=[host]`、完整recipe `applicable-not-reviewed`、四项静态语义passed、原生ABI `not-run`、覆盖 `incomplete`、解释 `source-change-needs-abi-proof`。本次窗口内freshness为unchanged，与比较历史基线得到host-changed并不矛盾。

静态窗口键为 `0f51e81c024f070935e38f8db1928a1c1b0761377f41456d3d1353bab9f04b7c`，实际候选/checker/schema绑定后的资格键为 `a22d45bd8264a518f0480805fcd01a5ffedb7808fdf274edf3ecf8ec4708b1ee`。`referenceOrigin=caller-supplied-comparison-not-qualification`：参考参数没有更改独立原生pin。原生配对和运行组另行验证，不把静态调用伪装成原生ABI执行。

**本票未声称在自己的测试时间段内又目击一次热更新。** 它复用了已被记录的真实安装更新，再用新固定窗口入口读取该更新后的真实来源；窗口内变化、读中替换及连续更新由下面的自有文件反例确定性证明。不切服务、不运行完整主Host、不写真实Bot/用户库、无收费Provider或外部Webhook调用。

## 固定输入与历史结果的确定性反例

`test/host-source-window.test.ts` 的8项用例覆盖主Host原子替换、worker-only同size且恢复mtime、读中替换、原文件消失、私有副本被改写、继承键缺失/错误、四槽容量、取消/失败结算、依赖计划改变。原输入删除后，清洁Node子进程仍读取同一个已校验窗口；安装freshness显示unavailable，不伪造该窗口已加载。UUID+inode保护已释放槽位，旧dispose不能删掉复用该槽的新窗口。

共享分类测试分别核对source/recipe/semantics/native ABI/coverage，未执行检查保持not-run。保留四项原始合法JavaScript语义破坏：错误输入身份、重启managed retry、未await checkpoint、未await lease preflight；每项均重新固定candidate摘要并被相应Rust语义规则判为violated，不依赖语法错或未知SHA代替回归判断。

实际管理链测试使用打包Rust、真实Server owner与自有来源，故意挂住A分析，再送入B、C。B未执行；A完成以snapshot进入原provenance/OBS，C仍是latest且其配方失配incident保持open。C完成后一共两轮分析；重启后分析次数为0，不重复通知。原A→B→A用例证明恢复时重新发布观察但复用固定结果，避免显示仍停留在B。

完成结果在原有界journal/64项缓存中复用；待跑只有一槽。超过保留边界或checker/recipe/test输入改变时重新验证，不宣称无限历史下的exactly-once。未完成的基础设施失败仍按原有有界退避处理，不将失败次数伪装成ABI回归。最后一次来源窗口结束后，默认私有窗口目录下未留占用槽。

## 实际执行结果

所有下列组都完成原入口的前后输入一致性核对；原生组均零skip、子进程已结算。组间存在重叠，不相加为去重用例总数；内部Node用例与Bun包装用例也分开列出。

| 原入口 | 实际通过 | 固定窗口键（原生组） |
| --- | --- | --- |
| `verify-host-health.mjs core` | 1520项Bun；39项Rust；协议生成、根目录及Web typecheck通过 | 不执行私有原生来源 |
| `integration-host` | 6个包装；内部Node共99项，包括health 14、compile 11、SQLite调度5、boundary 20、witness 26、verifier 23 | 自有来源、实际打包制品 |
| `native-host` | 原28项，六个顺序文件子进程；仍为30秒单用例deadline | `f2b9ab6e5bea038baa1bf7ba32f54cfcbf16e9c91cdc892958dcbcf57174ddb1` |
| `native-pair` | 34项；原生消息内部Node另14项；完整61片候选与四项语义反例 | `3e9d5dd3f79d385e2c5edb65b1ee0c4e548b1f0d4565edd12d55a13e343eaeaa` |
| `native-runtime` | 90项；context/compaction内部Node另18+20项；原worker、SQLite、独立冷读及模型选择链 | `fd89c0d6a1be041bc59cd54247ae5ded6a432ce0dbafe10c61f7c9a23c93ef64` |
| `core-risk`（AH-120） | 289项；compaction内部Node另20项 | `a7c2a96cb819b2a8df87412087c7efba9836574c2999a8d567d358accbac1df6` |
| `core-observation`（AH-121） | 230项；内部Node另132项 | `a7b249df8e22dad441bb34da7f9e77731b23a1a4d30d706e891a272e88eb4252` |

`bun run build` 在最终实现上成功构建CLI、preload、native制品及Web。固定原生组使用显式Host/continuity opt-in（按各组原规则）与指定原生Node；隔离模型链使用自有loopback upstream，实际Provider请求为0。原生组freshness均报告原始安装SHA未变，固定副本也未变；这不是以后来源不变的保证。

`check:docs` / `check:publication` 的最终组合工具调用被工具安全门拦截，未执行、没有通过回执；本报告不以已通过的构建或测试替代这两项检查。其余表中结果均来自实际执行。

## 本票发现并修正的问题

早期管理回归发现A→B→A时已完成key仍挡住当前观察重发布；现在换代清除当前发布标记而不清除固定分析缓存，原用例与迟到结果用例同时通过。原生子进程白名单曾丢失窗口locator，已显式传入键与定位并保留独立pin。旧live-copy用例把生产保护目标也别名到测试副本，现已拆开：输入来自副本、保护目标仍是真实生产常量且应拒绝。

一次旧的六文件单Bun进程被SIGKILL，不能据此断言ABI退化或确定OOM原因；改为原28项/六文件的顺序新进程，未删断言、未放宽30秒deadline，最终全部通过。浏览器打包完整输入allowlist同步新增纯数据分类模块，仍验证没有Node/Effect/存储或Provider进入client bundle。早期根目录脚本缺少host-health路径映射也已由真实CLI参数拒绝测试发现并修正。

这些是本票实现/测试集成问题，已在原Owner内修正，不冒充新的上游退化，不重开AH-157/AH-120/AH-121，也未给无关消费者新增Blocks。

## 采用边界

`nativeQualification=passed-in-selected-scope` 只描述该组已执行范围；整体验证仍 `qualified=false`，`loadedProven=false`、`profilePublished=false`，不替代拟采用准确版本的真实服务、权限、App、外部效果及独立通知验证。原健康producer/provenance/OBS承担有限事实与去重；Linear承担真实缺陷的排程和回流，本票没有创建自动工单daemon或外部投递授权。
