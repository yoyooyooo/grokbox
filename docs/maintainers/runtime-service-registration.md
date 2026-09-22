# Runtime 服务注册与退场

本页是操作方法，不维护当前机器是否安装或已通过验收。现场状态仅看 [LIVE-RUNTIME-PERSISTENCE](../tickets/LIVE-integration-validation.md#live-runtime-persistence)。实现差额由 [T40](../tickets/T40-persistent-release-and-rollback.md) 和 [T50](../tickets/T50-template-ops-release-proof.md) 维护。

## 支持边界

`runtime services`复用现有 daemon/modeld 前台入口，交给**实际可用的 systemd 用户管理器**监督。确认前同时检查用户管理器可达、用户 linger 已启用；仅有systemctl二进制、tini、窗口管理器或一个后台进程不满足条件。工具不会开启linger、安装系统服务管理器、修改原生supervisor、写用户桌面autostart，或用nohup冒充boot注册。环境不满足时，预览返回原因，确认写入在产生单元文件前拒绝。

注册只处理两份本安装的服务单元，不改变Host/preload采用或其他应用。没有通用shell/任意unit名称入口；runRoot、durableRoot、用户HOME、实际Node和发行制品都参与范围核对。一次现役采用仍须满足固定已合入v2、旧制品与配置退路、停止条件和明确授权，不能指向feature checkout。

F1准备合同把每次结果绑定到动态宿主观测和独立安装身份：`environment.host`记录当次PID1、systemd-user和linger事实，`owner`记录服务主人，`roots`明确durable/run/home/release/unitDir，`epoch`等于本次登记摘要。release与这些状态根重叠或位于任一源码checkout祖先下会拒绝；同一scope只生成daemon/modeld两份固定unit，`singleInstance`只表示可验证的单位身份约束。`faultReceipt`/`operationReceipt`保留preparing、committed、reconciled等可对账阶段；它们不把离线fixture或文件存在升级成live开机验收。

## 预览与确认

先准备正式安装包中的绝对release目录和受支持Node。源码checkout不允许直接注册，既有release在运行期间不能原地改写。默认只做预览：

```bash
grokbox runtime services install --run-root /path/to/run --release /path/to/installed-grokbox --node /path/to/node --json
```

检查environment、scope、两个unit名称、releaseRevision和planDigest。将**本次预览的**planDigest用于确认：

```bash
grokbox runtime services install --run-root /path/to/run --release /path/to/installed-grokbox --node /path/to/node --expect-plan <planDigest> --confirm --json
```

默认只enable后续启动，不立即启动。只有在已授权协调窗口内，给预览和确认两次命令都加`--start`才会同时请求启动。预览后字段、制品或已登记状态变化会拒绝旧plan；不得自动拿新plan替用户确认。

两份单元调用实际打包Node `daemon serve`和`runtime modeld run`。每次启动前独立核对入口/preload字节指纹，变更制品不执行；Node本身也在登记/查询时核对。依赖与整个安装包的资格仍归固定候选检查，不把这两个文件的hash当全部依赖attestation。安装程序不会把当前shell里的Provider密钥复制到unit或argv；凭据必须沿已批准的持久来源提供。已有用户管理器可能有自己的环境，因此单元显式移除Node预加载与动态链接器注入变量，不能把“没有复制shell”误称为完全隔绝管理器环境。

退出使用原服务的有界结算，不强杀超时进程来伪造干净停止。重启退避与频率限制由管理器负责，不新建grokbox轮询supervisor。stdout/stderr不另存无限raw日志，结构化日志及维护证据由原owner保留。

## 只读核对

```bash
grokbox runtime services status --run-root /path/to/run --json
```

状态分开显示私有注册phase、待发布回执phase、精确unit文件匹配、管理器实际加载定义匹配、制品匹配和环境可用性，并返回owner/roots/epoch、父shell独立性和故障回执。同名但来自其他FragmentPath的单元、额外drop-in不会通过启用前检查。`installed`不等于模型可用、Host已采用、collector已配置或Bot已经收到提醒。查询绕过Profile配置初始化，配置坏时仍可观察注册，不修复单元或启动服务。

collector需要另行使用`runtime monitor install`保存明确目标集合；配对、Routine启用和通知授权也仍是独立操作。重启后的旧work不自动补发，源健康待重新核对。modeld与daemon仅回收登记过的精确socket、确证死亡的owner及拒绝连接，未知旧socket、普通文件、符号链接和身份不匹配保持阻断。

## 中断与卸载

注册先持久化preparing再请求管理器。manager回执丢失时保留unknown/preparing，只能核对精确已有定义后重新预览同一计划；不另造服务名称。最终回执已完整暂存时，重新确认后先读回既有管理器结果，再完成本地发布，不重复enable/start。独占发布的双链接只接受确切本文件/`.next`配对；损坏、不明暂存或陌生硬链接不自动清空。

换发行制品前先按原服务接口/已批准管理器步骤结算并停止两份服务，再预览退场：

```bash
grokbox runtime services uninstall --run-root /path/to/run --json
grokbox runtime services uninstall --run-root /path/to/run --expect-plan <planDigest> --confirm --json
```

仍有活动PID或单元正在启动时拒绝卸载；命令不会替用户signal任意进程。只移除精确匹配的本安装单元，用户编辑/第三方占用不覆盖。先前已进入removing且只移除一部分文件时，可在重新确认、核对全部服务停止后继续，不重建已移除的文件。保留运行数据、配置、凭据、执行安全标记及旧发行包，不把取消注册说成数据回滚或在途副作用取消。已retired重放为无写入结果。

## 验证口径

临时发行目录和受控manager验证计划/文件/恢复行为；真实systemd解析器验证生成文件，真实Node验证启动前制品拒绝及modeld强杀后再启动。它们不等于实际登录/开机启动已验证。目标机器的管理器可用性、实际服务注册、Host加载、Provider凭据和整机重启只能在对应LIVE窗口逐项确认。
