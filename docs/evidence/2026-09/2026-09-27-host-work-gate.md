# Host 工作范围与正式空闲门

2026-09-27，AH-187。当前现场只看 [LIVE](../../tickets/LIVE-integration-validation.md)。延续[模式声明修复](2026-09-27-adoption-mode-identity.md)。

`a3db4bc8a52b5859cde0e7d04a8457bb42e035ce` 已固定安装，正式 Server/modeld 已切到该制品。route 声明进入 `host start` 时，旧空闲门因两个正在运行的 Temporal Bot 返回 `host_switch_blocked`。该次拒绝在 controller 调用前，未发信号，也未新增操作；ledger 仍为 51 terminal / 9 unknown，前次 observe unknown 原记录逐字段未变。

原生 `getHostStatus` 同时报告 isBusy=false。核对固定 `a22d48c` 原文后可知，该字段来自 Host 自有 getHealth：本地回合与后台 shell、可携带待唤醒、恢复排空、升级暂停、暂停恢复共同决定忙碌。当前原方法在隔离 VM 的七种输入中实际运行通过，方法 SHA `36ad17a76af85ea306ad87c541b9df45e4d23e0cfd21fa13afcd63fefa1c35b8`；该证据不执行完整 Host 或 Provider。

原 CLI 门只读取全账号名册。因此它既会被云端 Temporal 回合阻挡，也无法在没有 running 名册行时识别 Host 原生后台工作。两项问题均先通过正式 CLI 入口的隔离反例复现。

修复仍在原 host start/stop/restart 路径：先读名册，再读取同一 Gateway PID、startedAt 和地址的原生状态。原生 busy、Box/归属不明的运行对象继续拒绝；只有确定的 Temporal 行不再代表该 Host 的执行工作。原生状态缺失、不可读或运行代变化仍拒绝。没有使用 force、绕过原 controller、增设 writer 或重放 unknown。

入口与原资源围栏回归 82 pass / 0 fail；新增覆盖空闲 Host 上的云端回合、本地后台工作、Box 状态冲突、未知归属、缺失 busy 字段和两次读取间 Gateway 变化。1.5 GiB Node heap 下类型、文档 16 项及 publication 均通过。

本记录结束时仍未实际采用或发送静默创建。源码和隔离原生结果不构成 loaded/Server 创建、业务、通知或更新证明。零模型请求预算不变，费用继续 `billing not observed`。
