# NET-01 — Box-local execution and operator-managed networking

## Scope and authority

用户已要求完整翻新、无旧兼容路径。本票原先保留的显式Tailscale bootstrap/recovery，现在随[CLI-05](CLI-05-implementation-follow-through.md)退出，不再冻结保留。Box执行与用户自管网络的边界不变，普通已配置端点与显式SSH恢复不是待保留的旧厂商兼容层。产品合同归[连接](../product-contract.md#2-默认入口与连接)、[Daemon与恢复](../product-contract.md#11-daemon-与恢复)；原历史验证只看[2026-09-19固定回执](../reports/2026-09-19-network-boundary-v2-integration.md)。

## Current implementation

`init`只初始化本地连接，先读取并验证健康再保存选择。`profile add/use`显式配置普通HTTPS端点，DNS/MagicDNS/IP不决定协议、权限或恢复策略。`doctor`只返回当前应用检查，不保留`tailnet`、`serve`、`tailnetIdentity`占位JSON字段。

旧peer发现、Tailscale状态/ping、Serve映射读写、远程打包传输/安装和凭据轮换代码已从生产删除；`init --peer/--bootstrap/--admit-home-read/--yes`、`daemon ensure --bootstrap/--admit-home-read/--yes`、`recover --legacy-tailnet`不再注册，没有转发或拒绝型shim。`daemon.serve`也不再是当前配置字段。旧文件不会被静默改写或删除；无法按当前schema读取时明确拒绝，必要用户偏好应作为首次导入处理，不能据此复活旧运行路径。

`daemon/ssh-recovery.ts`只保留按明确SSH目标检查或启动已有安装的有限程序。健康时no-op；现有进程不健康时拒绝替换；缺安装不自动部署。它不改端点、权限、密钥或网络映射。`recover`保留认证/能力/监听器先行拒绝、健康no-op、明确SSH恢复，以及只有控制面确认休眠且端点失败时才按独立凭据唤醒的边界。诊断成功不授予任何恢复动作。

<a id="compatibility-and-operator-migration"></a>
## Current operator entry

远端由用户部署应用和网络入口，再配置 `profile add <name> --transport daemon --server-url <https-url> --daemon-token-ref <reference>` 与 `profile use <name>`。普通读取不检查网络厂商身份，恢复不接管网络。删除软件兼容实现不意味着有权删除机器上的既有Serve映射、配置或凭据。

外部验证脚本改为要求`GROKBOX_EXTERNAL_SERVER_URL`及外部执行机上已有的`GROKBOX_EXTERNAL_DAEMON_TOKEN_REF=file:/...`，只在独立配置目录记录引用。脚本仍需显式的执行机、Bot、文件和写入root目标；不使用旧bootstrap，不通过凭据轮换制造换代。其范围是现成端点验收；真实服务换代/安装另归T40及对应LIVE，不能将不再执行的换代路径记为通过。

## Verification and remaining qualification

`test/network-boundary.test.ts`检查生产代码/registry没有旧控制源、配置字段拒绝且原字节不变、失败init不改变选择。`test/ssh-recovery.test.ts`实际执行原POSIX恢复程序和自有临时Node服务，覆盖健康no-op、启动与再入不重复、存活但不健康的PID不受影响、缺安装和非法回执拒绝。地址与SSH传输本身是隔离测试输入，不签实际外网可达。

其余入口由profile/recovery/daemon/CLI、共享config、打包安装以及生成Skill验证。最终大阶段固定源码结果见[844项组合与实现边界](../reports/2026-09-21-network-compatibility-retirement.md)；不沿用原有65项兼容验证作为现版证明。独立审查和真实外部DNS/TLS、账号休眠唤醒、整套安装仍看[LIVE-NETWORK-BOUNDARY](LIVE-integration-validation.md#live-network-boundary)，未在本轮执行现场脚本。无部署、推送、真实模型调用或现役服务切换。
