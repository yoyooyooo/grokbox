# T29 — Shared CLI/API boundary, second-writer CAS and deferred Web UI

## Status / owner

**Open · 浏览器暂缓，已接受未来产品方向；不是T28后的默认施工。** 近期持续观测与SQLite/incident归[T41](T41-continuous-observation-and-alerting.md)，不等待Web UI。本票拥有共用命令/API边界、真实第二写入入口的并发保护和显式排期后的浏览器交付；页面/交互的未来Current Home为[单盒Web UI](../roadmap/future/webui-console.md)。

## 当前内核应预留的合同

- CLI/API共用commands/status、T37归属判定和T41安全read model；页面不是第二admission/controller/collector。
- 唯一ConfigurationWrite保存canonical模型/期望能力/监控配置。草稿、已保存选择、当前TURN捕获、实际运行生效分开；T24允许逐Bot回官方，不沿用旧route-reset永久禁用规则。
- 每次操作绑定明确Box/Bot/scope，缺身份拒绝；IP/显示名/当前页面不是目标权威。capability supported/desired/effective分别显示，勾选不能制造支持资格。
- 现在固定revision/幂等/错误合同，不为未出现的writer建立通用CAS系统。CLI+Web API成为两个实际写入口时，同一入口短锁→重读→expected configRevision→同一校验/归属/权限→原子发布；CLI同时接入。
- GET只读，不建库/迁移/retention、解析模型密钥、启动monitor/prepare/repair或投递通知。显式refresh受T41采集预算约束，不等于修改上游。

## SQLite与独立后台

旧“WebUI一律无SQLite”调整为**不得有SQLite配置/执行SoT**：T41可在UI之前实现本地观测与incident库。浏览器只经有限API读取，不能直接开DB或通过写DB再同步models/desired。current projections可重建，历史observations/ack/snooze/通知回执不能一律当可丢cache；数据合同唯一在[Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation)。J13 writer与Host stores不迁移。

collector/已授权operation归长期runtime，网页仅拥有订阅和草稿。快照带cursor，续流、scope/epoch变化和保留期gap按T41解释；关页面不停止服务、不重放未知操作。

## 部署边界

进程与runtime在Box内，外部浏览器经用户自管HTTPS入口访问，是已接受的单Box场景，不是跨Box runtime写入。沿用[产品网络边界](../product-contract.md#2-默认入口与连接)：只提供必要的通用监听/外部Origin配置，不发现或管理Tailscale、Serve、ACL。使用同源API或显式地址，不能依赖浏览器localhost指向Box；应用会话、严格Host/Origin、CSRF、代理信任和target绑定照常验收。本票仍未启动浏览器开发。

## Module / dependency

仅在排期时创建console API/browser资源。现有runtime-kernel commands/status、configuration/IO ports与box-runtime roots复用；API/CLI是入口而非业务owner。same-box Gateway仍使用有界既有adapter，不反向import CLI，不让browser见Gateway secret。

T27/T28/T37提供相应能力，T41供观察；某模块可用才开放它的写操作，不等所有future、也不假开放未就绪功能。T41不等待本票，T29与T40无相互整票Done依赖。

## Acceptance

1. CLI和API同一程序/输出语义；构建边界拒绝第二配置规则/控制器/collector。
2. 真实双进程writer竞争：版本冲突不丢更新、保留草稿；旧read model不授权写，重复requestId/ack丢失按原operation对账，不二次signal。
3. 错Box/账号scope/身份未知、过期确认、权限不足在产品写入前拒绝；secret不入URL/日志/HTML。
4. GET counted ports产品写、DB管理写、signal、模型调用和notification均为0；状态GET不自动refresh上游或变更服务。
5. Browser排期后按[future页面合同](../roadmap/future/webui-console.md)真浏览器验证快照/流交界、断线重连、切对象、草稿/冲突、关闭tab和有限写入；API/reducer绿不等于像素/交互通过。
6. console会话认证、默认loopback与用户自管外部HTTPS入口、Host/Origin、CSRF、confirm操作有独立证明；外部浏览器不依赖客户端Tailscale CLI，不把网络可达当认证，也不复用高权限Gateway/provider身份。构建/运行不需要私有App源码，不修改官方App。

## 非目标 / 下一动作

当前不建React/Playwright/HTTP空壳；不做跨盒runtime写、通用exec/RPC代理、聊天composer、自动修复、多渠道升级或全量分析平台。此前“禁止另建React/Query/SQLite平台”仍禁止平台化，不禁止T41有实际owner与生命周期的SQLite adapter。

近期仅从T24/T37/T41的已需接口提炼共同边界，UI排期时再落实页面与第二入口。范围与优先级只认[Spec](../roadmap/box-runtime-impl-spec.md#webui)，未来资料不自带开工权限。
