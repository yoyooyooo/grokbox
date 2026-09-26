# 2026-09-26 — Box 创建核心前提：原生对照与完整客户端编码链

## 结论及边界

**当前标准新建路径仍未交付可由本机 Box 承接的 Bot。** 本轮实际执行了一次不经过 grokbox 管理 Server、preload、modeld 或恢复路径的原生 Gateway 创建：明确 `harness=box`，抑制 introduction/kickstart，返回 HTTP 200 与明确原生身份，但结果为 Temporal；两次独立列表读回一致。测试对象随后由原生删除接口清理，最终列表恢复原来的 51 个 Bot、ID/harness 均保留，无新增残留。本轮未发送任何模型消息、未迁移现有 Bot、未改现役 Host 或模型配置。

这证明“创建错误只是我们管理／恢复重建造成的”不足以解释现象；**仍不证明官方所有合法 Box 路径已关闭**。本轮原生路径和此前含参数修复的 C 结果，都没有取得与真实请求对应的最初服务端响应及最终出站 BOX 枚举。不得把下面的隔离编码结果伪装成实际网络抓取。

## 实际原生对照

时间为 2026-09-26 00:33:19 UTC。正式 runtime 读面事前确认 `actual=official / origin=official / desired=disabled`，modeld 未启用。调用原生 `/api/createAgent` 一次，使用原发现／凭据读取者，不输出凭据、不采用调试器或修改运行中函数。Gateway 进程代在提交与返回之间一致；观察器记录的磁盘／保全来源是 `75aa6d77`，不据此伪造未补丁 Host 的内部加载摘要。

首次 Bun 只读名册预检超时，没有创建。相同协议程序使用固定 Node 22.22.0 后正常完成预检、单次创建、读回与清理；没有提高超时或重试写请求。`transportAttempts=1` 是本程序到 Gateway 的计数，不声明官方内部没有重试。后续另一个只读迁移元数据查询超时，不视为迁移功能不可用或服务端拒绝。

原 A unknown、B/C 的既有 Temporal 结果不重放、不改写。新对象身份、原请求、返回、两次读回、删除与非目标对比均保存在私有 POC 目录；本报告不包含私人 Bot 清单。最终再次读取时 Gateway 已由官方更换运行代，目标仍不存在、原 51 个 ID/harness 保持。原生创建/删除可能改变 App 活动选择，本轮未验该投影；保全结论不是任意用户状态逐字节不变。

## 当前源码检查及可执行编码实验

复用已运行观察器保存的 `75aa6d77` 完整证据，不为新摘要重新打包部署。与前次 `13740b50` 比较：普通 mintAgent、createRemoteAgentFirst、mintRemoteFirst、requestMint、最终远端 adapter、harness 枚举映射与普通 backend client 这些所选完整声明字节相同。外层 proxy 有变化，但当前没有覆盖普通 createAgent；`creationRoute=box` 的分流消费仍在 createGroup，不是普通 Bot 的强制选项。

本轮不再停在 requestMint 的 mock 输入。使用当前原生的三个 identity 方法、最终 create adapter、枚举、CompactMessage/protobuf 运行时和消息类，执行到原始二进制编码／解码。没有运行完整 Host、没有账号请求；传输和重试调度为自有止点，头像渲染替代为固定输出，不伪造服务端成功。

| 客户端输入 | 原生未修改的编码值 | 套用已有参数修复的编码值 |
|---|---:|---:|
| 明确 Box | UNSPECIFIED = 0 | BOX = 1 |
| 明确 Temporal | TEMPORAL = 2 | TEMPORAL = 2 |
| 未选择 harness（实验策略允许 Temporal） | TEMPORAL = 2 | TEMPORAL = 2 |

六例中 agentId 保留，FRESH=1、PRODUCT_CREATE=5 与 introduction=true/kickstart=false 正确编码、读回。旧切片确实能修正这个客户端字段缺口，编码器不会在所选链中吞掉 BOX。**但这仍不证明此前 C 实际走到了这条修正链，或服务端接受 BOX。**

另一项直接语义事实：原生 mintRemoteFirst 只对“要求 Temporal 却得到非 Temporal”做不匹配拒绝，没有对 Box 作对称约束。官方成功创建一个对象不等于满足调用者 Box 意图；grokbox 后续 mismatch 判断不是多余障碍。

## 其他正常入口的范围

- 普通 Update 的当前请求合同没有 harness，不能用它切换归属。
- 当前 Temporal 源的 duplicate 明确调用 Temporal 创建，不是有依据的 Box 后门。
- 模板创建请求没有可选 harness，取决于服务端返回。Host 保留 shared-identity 未启用时的 local-only 导入分支，但未证明当前账号会走该分支；本轮未导入模板，也没有伪造 feature gate。该分支不能自动列为已排除或已通过。
- `register-existing-local` 是有真实本地身份的登记情境，不是新建时可任意伪造的 caller/intent。
- 已查看的迁移 operator 合同为 Box→Temporal，没有从这些入口取得受支持的反向 setter；未调用任何管理员迁移接口。
- 可创建本地群、保留本地执行代码或使用云电脑，不等于取得 server/local 一致的 Box 普通 Bot。

## 最短决策与下一步

把后续依赖新 Box 身份的实施保持在前提待解状态，而非继续堆普通修复。唯一尚未闭合的决定性边界是：通过获准的正常账号客户端，实际送出 BOX=1/FRESH/PRODUCT_CREATE 后，最初服务端响应和同一身份的登记是什么。

若服务端最初明确拒绝或返回 Temporal，当前账号／该合法路径不能满足产品前提；只评估有真实合同与授权的其他路径。若先 Box 后 Temporal，转向创建后的生命周期；若出站仍非 BOX，修实际接线。不要通过伪装 caller、改本地标签、循环新建或关闭权限检查换取表面成功。

本轮未取得上述 BOX=1 真实服务端请求结果，也不声称全文件语义已穷尽。已有来源保全和账号／调试相关调用曾被工具安全层拒绝，本轮未用另一包装绕过；新的实际对照走的是不同的标准原生 API 路径。

当前主线仍归 AH-186，总控 AH-187；AH-124 历史恢复不重开。源码资格、真实原生对照、修后实际网络请求、服务端登记和业务回合是不同结论。本轮没有新增生产切片、controller、诊断框架或全仓验证前置。
