# 多 Box 汇总与外部失联监测

**候选；不早于单盒监控，通常与Web UI后续版本一起排期。** 当前只预留可信Box/scope/运行代身份，不宣称多盒读写已支持。单盒事实与告警归[T41](../../tickets/T41-continuous-observation-and-alerting.md)，首版页面归[Web UI](webui-console.md)。

## 为什么不能放在盒内解决

Box离线/断电时，它的collector不能报告自己死了。多机页面的聚合进程或独立外部observer需从盒外观察last contact与数据新鲜度；“看不到”不自动等于机器关机，可能是observer网络、认证、桥或采集进程不可用。要区分设备、传输、collector与Bot归属四个故障域。

## 启动条件

用户确有至少两个要管理的Box，或明确要求不依赖Box存活的主动告警；单盒DTO/事件cursor与范围授权已经资格化；外部常驻位置、连通性和凭据owner已确定。若只是给单盒页面加boxId，不建立fleet数据库或全局代理。

## 接口与权威

外部层调用受控API，不跨机器挂载共享SQLite，不用目录/IP/hostname代替身份。聚合索引按boxId+scope+sourceEpoch区分，来源滞后/断线时显示lastKnown+gap，不混成全局实时状态。远端Box恢复后按序号与原source范围补齐可保留的事件，缺失段不造历史。

聚合告警由外部域拥有，例如“Box不可达”；Box内的ownership conflict仍由原incident ID识别，同一个冲突不因多客户端订阅而被复制成多个新问题。不能以远端聚合cache的绿色状态授权本地model/provider执行；T37 gate仍在原Box的真实入口。

多盒只读不自动授予多盒变更。远程模型配置/控制必须显式选择目标、权限、expected revision/operation身份，并由目标Box的同一commands执行；不得SSH generic exec或任意URL转发绕过现有runtime_local_only边界。跨盒搬迁Bot/会话、Server harness迁移都不是此项目的默认功能。

## 必须补的证据

双盒同名Bot与不同scope不串线；一盒慢/离线不阻塞另一盒；collector重启、网络分区、外部observer自己离线分别可诊断；中断后不自动执行离线命令队列；跨盒授权/密钥隔离、重复订阅、旧cursor与partial inventory有负例。没有上游完整列表证明时不把缺行当删除。

整机离线通知的SLA只能在外部部署与取样预算实测后声明。机房/服务重启、设备恢复等自动修复需另行产品和权限决定，不由告警自动获得。

## 非目标与新鲜度

不建设集中Agent Runtime、跨盒分布式事务、全局会话store、网络共享DB或自动迁移。长周期趋势/容量分析可在事件规模和保留压力实际出现后单独提案，不复制全部对话正文。身份、网络信任、API版本或外部常驻环境变化时复核。
