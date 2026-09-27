# 原失败采用的官方回程与退场审查修复

2026-09-27，AH-187，延续[采用失败](2026-09-27-formal-adoption-unresolved.md)和[受控退场能力](2026-09-27-owned-host-retirement.md)。当前进度仍由 [LIVE](../../tickets/LIVE-integration-validation.md) 维护。

## 本次物理恢复

06:07 UTC 准备退场检查时，原候选 Host 生命周期已经结束，磁盘来源也发生变化。新退场入口没有发送信号，原操作目录没有退场意图。06:08 UTC 核对当前官方版本为 `0b67642`，完整 Host SHA 为 `7acd9a7e9272833758f2f7aad72a4a9146da7f6098a692fb4f60e16390978797`，worker 仍为 `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。原 observe writer 已保留新完整原文。

正式恢复观察确认唯一 wrapper → 官方 supervisor → 官方 Host 直接父子链，Gateway 属于该 Host，三者均无相关 preload。06:09 UTC 使用已安装 `84c3000e` 的原 `restore-operation --confirm`，为原 `021f7ddd…` 操作发布 `physicallyRestored:true`、`exact-lifetime-absence` 回执。没有发信号、采用或重放。全部原证据摘要与旧记录不变，仍为 10 unknown / 0 running / 51 terminal。

这次回程发生在原官方运行体系中；新退场能力未执行，不能把该回程计为它的现场成功。原 guardian 回执的 released 与 controller 最终 expired 并存，最初采用失败原因仍需继续定位。旧失败不被回程改写为采用成功。desired=disabled，modeld/管理 Server 仍停止。

## 独立审查与修复

原只读恢复审查者对 `7f30b3fe` 给出 BLOCK：控制进程骤死后，helper 的已缓冲指令可能在资源锁释放后发送 SIGTERM（P1）；信号发出后中断仍会得到“未请求 Host 信号”的通用错误（P2）。审查仅访问公开源码，没有现场、私有 Host、凭据或测试执行权限。

修复让 helper 继承原 controller、identity、modeld 三个已加锁的 open-file descriptions，保持到信号/退出观察结束；不通过重新打开路径假装继承原锁。输出管道消失也不提前结束受保护的观察。原门仅新增用于继承的 descriptor 访问，不新增资源 owner。中断错误改为保留 SIGTERM 可能已经请求或送达的不确定性。

新增真实 Linux 反例：暂停已固定目标的 helper，发令后强杀 controller；三个原 gate 路径均继续拒绝其他获得者。恢复 helper 后，正常 SIGTERM 已到达而目标尚未退出时，三个 gate 仍保持；目标结束与 helper 退出后才释放。另验证正式 controller 调用在发送后取消时先 join helper，并报告信号不确定性。含原恢复在内共 97 pass / 0 fail，类型检查通过；待原审查者复看，不以这些测试自行解除其 BLOCK。

## 下一项实际差额

只读观察还复现了进程分类误报：以 `--from host-main.cjs` 为输入的诊断 CLI 被旧 role classifier 当成 Host；普通脚本带 `sand-supervisor.mjs` 参数也会被当成 supervisor。这是已复现的独立缺陷，但尚不能断言它就是本次采用的首个失败原因。下一次采用前需修正并重新核验新来源，不能重用旧来源的 loaded 资格。

静默创建仍未发送，模型业务、通知与正式受控更新连续性未验；费用继续 billing not observed。
