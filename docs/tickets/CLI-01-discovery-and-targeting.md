# CLI-01 · Agent 发现能力并锁定目标

状态：架构方向已接受，发现/目标/输入输出的精确合同待细化。依赖：无。本票完成只表示合同产物完整，不表示能力已实现；当前仍不启动代码搬迁。

## 用户结果

陌生 Agent 通过按需发现，确认真实调用身份与目标安装，将名称解析成稳定 ref，再读取一个 Bot。它不需要知道 daemon/monitor 的内部布局。Agent First 体现在基础能力的可发现与组合，不规定它如何组织 Bot 的业务工作。

## 方案范围

以[Spec](../roadmap/agent-first-cli/spec.md)为目标，收口[决策 D02、D03、D06](../roadmap/agent-first-cli/decisions.md)。确定 descriptor 可发现内容、默认展开范围、命令/语义版本、输入来源、未知字段拒绝、引用与 self、显式 connection、默认 JSON、正文权限和有界分页。

## 验收产物

- 完整走通“describe → identity/capability → resolve → get”，每步给出合成请求、有限响应与失败分支。
- 名称歧义、身份缺失、错安装、旧 Bot 被替换、未知字段、版本不兼容均有明确结果；写入不按名称重新寻找。
- Bot/operator/maintainer 发现视图只影响展示；能力声明、认证身份、授权、当前可用性各自说明。
- 默认输出可被程序消费；空列表、分页尾部、截断、正文未授权与过期来源不混淆。
- 更新[命令合同](../roadmap/agent-first-cli/command-contract.md)及相关目录，不另建第二版本。
- 同一对象/范围在 CLI、API 与浏览器路由中一致；发现与 wire 合同可校验，CLI 输出不强行充当页面 view model，SSR 不改变调用者权限。具体字段随已闭合用例细化。

## 实施前验证

后续以实际 parser/descriptor/adapter 验证这些例子；本票只确定合同与验收样例。尚无新 parser/API 实现。