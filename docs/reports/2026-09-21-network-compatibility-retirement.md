# 旧网络兼容链退出与重建阶段回归

2026-09-21，NET-01/CLI-05。承接[控制器入口退出](2026-09-21-controller-entry-retirement.md)，按用户要求删除旧运行兼容，而非冻结、改名或保留throwing shim。没有删用户资料、未知操作或并行VOICE规划。

## 实际退出与保留

删除556行旧CLI bootstrap模块及所有生产消费者；Tailscale peer发现、status/ping、Serve读写/恢复、相关打包传输/远程安装和凭据轮换退出。init、daemon ensure、recover的旧选项不注册，由普通parser直接拒绝；diagnostics旧tailnet/serve/identity占位字段和daemon.serve配置schema同时退出。没有根据域名选择旧路径，也没有保持隐藏fallback。

本地init先读取健康再保存Profile。显式配置HTTPS/loopback端点、能力/凭据判断以及已配置SSH恢复继续工作。有限SSH模块只检查或启动已有安装；存活但不健康进程拒绝替换、缺安装拒绝bootstrap，不修改配置/密钥/网络。删除代码不授权删除现役机器上的Serve映射或凭据。旧字段的配置明确拒绝且字节保留，不偷偷归一化成新状态。

外部验证脚本使用操作者提供的端点和外部执行机上已有file:凭据引用，在本次独立配置目录记录引用。不调用退役的bootstrap或凭据轮换。它证明现成端点及当前相关业务面，不再声称通过该脚本执行了服务换代；换代义务保留在独立生命周期/LIVE。脚本本轮只做离线输入拒绝、语法及调用面检查，未运行真实外部任务。

## 行为反例

`network-boundary.test.ts`扫描生产源/registry验证无旧网络控制，检查旧Serve配置读取/写入均拒绝且不改变已有字节，失败init不覆盖原选择。`ssh-recovery.test.ts`实际执行当前POSIX命令、自有临时安装和Node服务，验证健康no-op、准确已有程序启动、重复ensure不多开、存活但不健康PID保留、缺安装不部署、非法目标和未知回执拒绝。传输被映射到本机隔离shell；不声称真实SSH/外网TLS已验。

Profile、daemon、恢复、共享配置/原canonical bootstrap与安装测试保留了各自当前行为，不用删除新架构仍需能力来压低失败数。旧部署专属测试替换为现行拒绝与零副作用反例。Skill、NET-01、LIVE、产品/架构/配置边界和外部脚本同批对齐，不留可执行旧示例。

## 最终固定源码验证

`b7ad26968b43c66f4cb78fea01eb4e9b4442e13d583b0d48eb6238d4c90b3a85`，1179个源码/测试/工具链输入。Bun1.3.14下 `verify-host-health.mjs` 的core、integration、native-pair三个窗口前后完全相同：791项/86文件、25项/18文件、28项/5文件，共844项/109文件，0失败；native-pair无跳过。Rust39项、根/Web类型检查、协议生成一致性通过。文档/实际CLI覆盖15项通过，差异格式检查通过。

包装内部生产Chrome67节点、Host见证Node26、Host管理Node13、正式verifierNode23、其余原管理域组合均通过，计数不与844重复叠加。生产build、tarball隔离安装、Rust/FD与搬移Web实际执行。native-pair只用准确安装来源里的原声明及自有数据库上的原worker/codec/disposal；未执行整个主Host、现有Bot资料、Provider或App。

此前控制器包的96项和网络定向100项均已纳入或与本组合重叠，不额外累计。含未跟踪文件的全工作树发布扫描覆盖1483个文本文件，仍单独报告并行VOICE文档的一条本机路径；本阶段不能签全仓可发布。

## 接续边界

这两包收束了Host周边旧controller/preload回退与厂商网络兼容；不是整个CLI/Server重建完成。继续将剩余handover/compact动作及仍依赖CLI daemon的必要能力迁入统一Server，同批退出旧writer/路由/消费者，不把现行必需功能直接删掉冒充迁移。材料完整原生文件通路、独立modeld/安装、全能力健康和独立告警出口仍有各自义务。并行VOICE不插队，不扩大现场执行权限；未部署、推送、切全局入口、调用真实模型或外部通知。
