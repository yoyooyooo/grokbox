# 核心验证入口的安全反例回流

工作包 AH-166。修复的是原 verifier 清单遗漏，不是运行时 writer，也不把本报告当作整个候选通过。

## 原入口与无损接入

使用 package.json 声明的 Bun 1.3.14。原 core/integration 的实际 --list 证实五个新测试入口均未消费。三个新增计划断言修前失败，修改后原与新增共12项通过。

core 加入原模型最终发布和删除后桌面竞态测试；integration-domains 加入原模型HTTP授权和消息测试。模型HTTP入口导入 publication-boundaries，包含 Console 停服身份用例。原清单无删减、核心分片仍精确覆盖一次；native/integration-host/integration-web 的计划均未改变。

完整 Bot/Group 管理保持独立，不成为核心前置：

```bash
node scripts/verify-host-health.mjs product-management --list
node scripts/verify-host-health.mjs product-management
```

此入口实际执行53项原产品Node用例，而非只打印计划。所有分组仍使用原子进程所有者、取消、来源摘要与原时限，不放宽任何跳过/原生授权规则。--list不签运行资格。

## 本轮完整运行暴露的独立问题

core 首次通知CLI超时，隔离及同组重跑通过；随后原Skill超过600词的确定性失败已由AH-168修复并合入，未改预算断言。继续运行在浏览器client的Node crypto导入处失败，独立AH-169负责修复。

integration-domains新加入的模型授权24项与消息34项已执行通过；全组在原保护测试的一次restart-read上失败，隔离24项通过。失败日志保留，不以隔离通过代签全组。

本包已交付可执行入口与原清单无损证明。全核心固定候选与整个integration仍由AH-122/AH-162按修复后的来源重新核验；本报告不宣称整体绿色、真实平台/Host采用或任何用户验收。

源码：[原验证器](../../scripts/verify-host-health.mjs)、[可执行计划回归](../../test/host-health-shards.test.ts)。
