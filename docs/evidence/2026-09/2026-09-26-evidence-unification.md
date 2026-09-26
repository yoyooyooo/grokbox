# 2026-09-26：历史证据统一与独立 POC 提炼

本窗口是 D 文档工作线，不是 Host 部署、Box 创建或模型执行验收。迁移起点为 `504d99e61b22825edfbe79e08f3954d84f13355a`；最终合入结果由原 Issue 记录，不在写入前猜测提交 SHA。

<a id="evidence-unification"></a>
## 范围与实际变化

原 reports 的 111 份 Markdown（含索引）迁入 `docs/evidence/2026-09/`；原 archive 的 6 份（含索引）迁入 `docs/evidence/topics/`。固定窗口仍按原日期和文件名，主题提炼仍保留历史边界，不将当前 Spec、Roadmap 或 LIVE 搬入历史目录。

当前 Markdown 链接按原文件位置解析后重定位，所有来源内相对引用及其他文档的入链一起迁移。固定提交的 `git show SHA:旧路径` 保持原树的真实定位，不为目录统一重写历史。

新增[证据根导航](../README.md)和四份独立 POC 主题：

- [独立 POC 索引](../topics/independent-poc-atlas-2026-09.md)：原始材料、脚本、回执关系、读取摘要和仍被依赖的资产。
- [官方客户端入口](../topics/official-client-ingress-poc-2026-09.md)：自有会话、工具委托、原客户端分流、本地群切口与普通 Bot 的路线差异。
- [原生运行合同](../topics/native-runtime-poc-contracts-2026-09.md)：原输入、ackToken、Routine 子父结果、Memory、模型边界及崩溃/重复执行证据上限。
- [更新与身份](../topics/host-update-identity-poc-2026-09.md)：source、loaded、upgrade operation、Server 身份和 local writer 的分层，以及首次启动观察缺口。

独立 POC 的源码和原始回执仍在原目录；本次只提炼，不复制私人正文、凭据、账号标识或原生 bundle。公开文档保留有用的目录基名、符号、协议角色、字段和内容摘要，不把本机化一律等同泄密。

## 消费者与检查

更新根文档路由、维护规范、实施路线和 LIVE 引用；唯一非 Markdown 变更是 `test/live-e2e-checklist.test.ts` 的证据路径检查与反例。完成判据仍要求一个准确、带锚点的日期窗口；主题文章、缺少锚点和多个窗口链接不能代签通过。

迁移守恒检查实际核对：117 个原文档均有新位置；110 份非索引日期报告的正文与“原文只变换引用路径”的预期完全一致；13 条 Git 历史定位原样保留。日期索引覆盖本月全部窗口，新增主题也可从根入口找到。正式用例没有减少，路径检查没有因为迁移而被删除。

迁移中的首次公开扫描在 Git 尚未登记重命名时读取已移动旧路径，返回 scan failed，并非内容通过或泄密发现；登记重命名后重新运行完整扫描。登记迁移后的固定 Bun 1.3.14 文档/LIVE/命令覆盖检查为 16 pass / 0 fail；含新文件的公开扫描为 0 findings；git diff 检查通过。未运行模型或原生 LIVE，用例通过只证明文档与引用合同一致。合流后的复验另由原 Issue 记录。

## 不包含的动作

没有更改 A/C 领域实现、B 的活动实验、Host/source/supervisor、模型配置、Bot、Routine、Memory 或原数据库。没有重新发送旧请求、调用模型、部署、push 或删除任何私有 POC。当前证据只归档已结算的固定窗口，后续实验由其实际结果追加。

文档目录统一完成不代表 POC 资产已经可以删除。仍需沿 AH-194 核对正式替代、跨目录 import、不可再生原始证据、活动使用和未决效果后，才处理临时代码退役。
