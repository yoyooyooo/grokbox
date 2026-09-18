# OBS-03 — 保留诊断价值的分层脱敏

**Status：Planned / Spec-only；M1。** Contract：[Spec §5.3](../roadmap/template-ops-automation-spec.md#privacy)。依OBS-00；可与OBS-01/02并行定义，最终在OBS-02真实采集/导出与T45发送边界接线。

## Goal / Modules

源头最小化，不做全量dump后正则补救。kernel `internal/observation/evidence-views.ts`及公开契约catalog；各Host/SDK安全projector仅补所需结构；CLI/export/notification调用同一版本化view。默认不修改现有原生数据。

## Work

实现local-diagnostic、bot-notice、bot-diagnostic、public-summary视图。Bot提醒只接最小摘要/必要真实ID/取证命令；获授权诊断才可读限定证据；公共视图必须用户主动导出/决定公开，字段不足明确说明。

公开内置工具名/schema字段走版本化catalog；未知自定义名称、正文/参数/原始error cause默认不外发。保留类型、缺失、契约差异、是否已dispatch等诊断事实；不能为了脱敏把所有ID替换成同一字符串。

报告内一致匿名映射、跨修订稳定、跨报告默认不可关联；低熵原值的普通hash不当匿名证据，公共签名从软件事实构造。Redaction receipt仅含类别/原因/计数，不能回显秘密。取证命令中的真实ID只能向已配对目标披露，原始路径/endpoint不进入消息。

未知新增字段默认不公开；投影不执行getter、不接受原型污染/任意URL/无限递归。实际网络/导出字节最后校验，Bot的hypothesis和自由文本也不能绕过字段策略。Raw-sensitive采集默认off，独立小范围/字节/TTL授权；本票不建设自动正文上传。

## Executable acceptance

待新增：

```bash
bun test packages/runtime-kernel/test/evidence-views.test.ts packages/box-runtime/test/evidence-privacy-pipeline.test.ts test/evidence-export-privacy.test.ts
bun test test/publication-privacy.test.ts packages/box-runtime/test/alert-chain.test.ts
```

覆盖嵌套JSON、数组、URL/token、路径、error cause、Unicode、getter/prototype、大字段、schema升级和Bot输出中的秘密哨兵；验证实际发送/文件/stdout/stderr没有原值，校验器报错本身也不回显。

非干扰测试：只改变prompt/Memory/参数值/真实ID，不应改变公开的结构性故障解释；故意改变tool匹配、缺字段、执行阶段则必须改变解释。报告内ID关系仍可重建，但真实身份/跨报告稳定ID不可恢复。

局部owner-fixture读取不能被说成向真实供应商披露已授权；native目标dataPolicy/模型变更需重绑交T55/LIVE。默认提醒网络bytes不得包含完整诊断JSON。

## Forbidden / Non-goals

不依赖LLM脱敏、不保存默认原始转录、不以长度/hash/正则证明任意自由字串安全；不创造用户同意，不自动Issue，不删除原生Memory。TTL不承诺介质安全擦除；敏感语义复现不足就明确请求受控最小样本。

## Exit evidence

固定viewPolicyVersion、catalog及source→projection→manifest→notification/CLI的byte-level证明。字段新增需逐项声明公开政策。随[OBS-06](OBS-06-integration-and-soak-proof.md)和[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)收口，不另建当前现场账。
