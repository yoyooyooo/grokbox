# E2E 前置实现收口 · 2026-09-19

本报告记录 `fe49300` 之后的服务注册与安全退役实现、修正和固定验证。当前现场结果仍仅在 [LIVE](../tickets/LIVE-integration-validation.md)，操作方法在[服务注册手册](../maintainers/runtime-service-registration.md)。本轮没有部署、重启现役、消费业务模型或发送生产 Webhook。

## 收口范围与验收出口

本轮关闭的是已选核心用户旅程所需的**代码与离线证明**：实际观察点/固定现场、daemon collector与sender生命周期、诊断联合容量接纳、执行与维护记录的安全收缩，以及可用服务管理器上的明确注册/退场。此前已合入的source→journal→SQLite→固定revision→HTTP和数据库恢复反例继续纳入组合回归，不重建一条观察链。

目标机器的实际管理器、原生Host/Provider/App、用户接收声明、开机/重建行为及24小时稳态属于W0及后续LIVE证据，不由源码成功代签。完整主机文件系统配额、任意整机快照回滚下的外部单调锚点、无限期接受任意旧请求并同时无限遗忘身份，不是现有接口提供的保证；当前正确行为是保留有限精确保护或拒绝不能安全记录的新effect，不清空账本制造通过。

## 持久服务：原管理器与精确制品

`runtime services install/status/uninstall`与box-runtime同一程序提供预览、planDigest确认、两份精确单元和只读状态。只使用实际可达且linger开启的systemd用户管理器；没有这种环境时，在写入unit或注册前拒绝，不修改官方Host/supervisor，不用nohup或新轮询器模拟boot能力。

服务入口为已安装发行包的Node CLI，拒绝源码checkout，核对规范化目录、配置revision、入口/preload/Node指纹和包身份。接受的Node下限与当前npm包声明一致。默认只注册，不启动；`--start`必须同时出现在预览与确认中。启动前核对入口/preload字节，屏蔽未经核验的Node与动态链接器注入环境；依赖闭包和原生模块仍须在W0对实际发行包验证，不能把两个文件hash当完整安装证明。

管理器加载的FragmentPath必须对应这两份精确unit，额外drop-in或同名替代拒绝；磁盘文件匹配不再足以允许启动。配置在预览后、或manager reload期间改变时，不启动旧计划。状态分开显示filesMatched、loadedDefinitionsMatched、artifactsMatched和真实manager观察，不以installed代替推理或采集ready。

安装先保存preparing，后请求管理器和读回。有效的最终回执若停在固定`.next`槽，只在重新确认并核对已有文件/管理器结果后完成发布，零重复enable/start。独占link发布中断留下的双链接，只认可本文件与其确切`.next`配对；陌生硬链接拒绝。部分卸载只有记录中已处于preparing/removing、对应单元确实未运行且未改动时才能继续，不重建已删单元。未知/损坏暂存保留阻断，不擅自修复。

modeld复用daemon的精确Unix socket owner与Linux advisory gate。强杀后只有登记inode、死亡启动身份和明确拒绝连接三者匹配才回收socket；活服务、未知socket和普通文件不碰。modeld允许已有owner可读但不可由组/其他用户写入的run目录，daemon默认仍要求私有目录。服务退出先结算维护/存储再释放socket；旧请求由新service epoch拒绝，重启不是清除unknown的许可。

## 安全退役：最小保护由执行入口消费

| Owner | 可回收内容 | 必须保留及实际拒绝路径 |
| --- | --- | --- |
| execution | closed/revoked TURN的非active STEP和已不需要的绑定详情 | 精确TURN关闭标记；kernel reserve/occupy在Provider前检查；新服务epoch拒旧epoch |
| context | 后续操作已取代的settled详细receipt | 同键fingerprint与detailsRetired；旧请求返回operation_retired，零摘要/新checkpoint；unknown/committing不退休 |
| Routine provision | 不再由当前binding引用的observed完整操作 | 精确Agent/operation/fingerprint tombstone；apply/outcome/reconcile保留retired，修改内容冲突，零重复原生请求 |
| notification | 全部承诺期限结束的诊断payload | work/attempt禁止重放标记、revision水位及既有自动worker时间/occurrence守卫；unknown不是未执行 |
| CONT恢复 | 仅其本域已证明可解除的引用 | 沿用原owner事务/闭包保护；此次无替身、职责迁移或Bot删除 |

LevelDB写入与回收共用原owner串行队列；计量文件及compaction转换余量后才接纳新claim。原生compaction可能在metadata扫描中取消链接，扫描有限重取，不将不完整统计签作空文件或错误归咎用户数据。缺空间时拒新effect，不擦除已有身份。

此次反例发现：最前面的未结任务会让只读队列前缀的GC长期饥饿。现有队列内加入本epoch的有限扫描游标，同时推进TURN队列和同TURN子项窗口；每轮最多检查128个子项，active保护不变，后面的已结子项可被回收。游标只调度GC，不授予执行权，随epoch级退役处理。

Routine私有schema由1增至2，在原已确认写事务内增加tombstone表，旧writer拒绝新schema。完整操作窗口不再因几百次已结更新耗尽；主文件容量仍有限，unknown和当前绑定不会为了腾位置被压掉。精确tombstone本身不能随TTL遗忘。

## 测试、独立审查与证据层级

组合入口仍是 `bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation`。本轮新增的服务与退役用例进入同一组合，没有另建一个同义总验证器。完整组合实际为**202 pass / 1 skip / 0 fail**，28文件、3790断言；类型、构建、导入边界和隐私扫描通过。source前后均为`529ea9ffb3238da8afe19f61eaae2a3091dc19466d7cf27ef765aba125143f3f`（914个源/测试/锁文件）；实际preload为`8d5c2f5a8daab7faf923de97f080a3d4b365fabd5f5d0dc3ea2557fbd6ca6a27`。首次组合仅拒旧制品pin未跟随最终source字节更新，按实际构建更新后重跑完整组合，不放宽拒旧断言。

已执行的集中资格：`GROKBOX_TEST_SERVICE_MANAGER=1`下服务注册/退役/modeld重启/socket恢复四文件25 pass / 0 fail。服务manager动作用受控adapter，但unit语法由实际systemd解析器核验；Node pre-start与强杀/重启是真实进程。检测同名替代/drop-in、配置竞态、部分卸载、最后回执丢失、独占发布残留以及GC饥饿的反例均在永久测试中。

全CLI目录792 pass / 0 fail（80文件、7535断言）。运行时整个目录一次调用超出工具期限，未计通过；随后以无重叠文件集完整执行：kernel/CLI包278 pass（33文件）、box a–g 449 pass/1 skip（65文件）、h–m 617 pass/5 skip（102文件）、n–o 348 pass/43 skip（40文件）、p–z 430 pass/1 skip（56文件），全部0 fail。包内296文件与扫描清单相符，合计2122 pass/50 skip；与根CLI合计**2914 pass / 50 skip / 0 fail**、376文件、28392断言。专项与全仓重叠，不相加。资格条件默认跳过不当作通过；服务解析器已另行显式运行。

只读独立Astra请求在限定窗口未返回报告，工具退出124；随后使用用户已允许的SOL提供者，对固定提交`b767470`中的服务注册和执行退役两文件再次请求限定只读复核，也退出124且无报告。不能据此诊断为某个Provider故障，更不能把尝试、作者复查或绿色测试写成独立review。W0保留REVIEW，源码集成不自动授予现场切换。

## 当前合同与剩余现场门

[OBS-05](../tickets/OBS-05-safe-state-retirement.md)、[T40](../tickets/T40-persistent-release-and-rollback.md)、[T50](../tickets/T50-template-ops-release-proof.md)记录当前实现范围；旧“完全没接collector/没实现安全压缩/只有前台进程”的描述应被更新，不能再次指挥同义开发。

本轮重新只读检查：本机systemd解析器为257.13，但`systemctl --user show --property=Version --value`报告无DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR，未连接到用户管理器。没有查询到管理器不等于证明所有可能的外部启动系统都不存在；目前注册入口必须保留明确ENV阻断，不能宣布本机boot已就绪，也不能偷偷安装新OS管理器或改上游启动。正式开窗须重新观察和选择确有支持的环境；已运行服务中的采集/通知与跨模型/compact测试有独立LIVE判据。

所有实际采用继续使用固定已合入v2、旧发行包/配置退路和协调窗口；不在feature worktree直接切Host/modeld/daemon，不因本报告自动激活通知或清理用户数据。
