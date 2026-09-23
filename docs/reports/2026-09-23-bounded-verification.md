# core/release 有界完整回归（2026-09-23）

## 结论与输入

AH-160的当前源码绑定制品已在V2 `d442180708e42c5e7f1bafe844ba77622d296c1a`。本批从该实际基线补齐原core/release运行器的有限分组、准确文件清单与子进程关闭回执；不是新业务运行器、模型策略或部署控制器。最终合流SHA在Linear AH-161/AH-117回执记录。

固定源码/测试/lock为1285文件，摘要`cfc131a76f34ae7267fc0cf14f4def96d8c641acbde554d1c5b0d59f8e8e7ca9`。build/core/release/native-runtime/artifact全部对应此窗口，最终before/after一致。原生Host=`bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`，worker=`da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`，结束后再次读回相同。

## 改变了什么

`verification-shards.mjs`从原声明展开regular test文件，拒绝重复、缺失、越界或空集合；对每个分组验证互斥、并集完整、非空及无额外项。每组最多20文件，使用明确的`./file`，不依赖Bun子串匹配。core为14个测试进程及4项原前置；release按原职责构成14组，耐久性、制品编译、取消观察单列，不将各类全局测试状态长期堆积在一个VM。

原单用例deadline不变。core每个受管命令保留270秒上限，release每个构建/测试进程保留180秒上限；总窗口上限由有限组数构成，不再误称整个release仍只有一个180秒预算。不循环重跑求绿、减少原耐久性STEP/TURN数量或删除required检查。

`verification-child.mjs`仅管理自身spawn返回的child handle，捕获有界输出并等到close及stdio关闭；不是收到exit或首条输出就成功。父SIGINT/SIGTERM/SIGHUP取消当前命令，先请求退出、再对同一child升级终止；非零、超时、取消、输出超限、无法确认关闭都失败且不进入下一组。各用例仍负责自身worker/server清理；不声称控制任意脱离父级的daemon，不扫描或终止现役服务。已执行的边界用例包括直接child拒绝退出、继承输出的子进程晚关闭、父取消转发及无下一组、创建失败、非零、deadline与输出上限。

原取消传播用例只增加payload-free阶段计时，保持其15秒和所有业务断言。当前完整release记录：fixture ready 66ms、响应结算273ms、journal结算299ms、冷SQLite读取344→349ms、关闭370ms，sourceCalls=2/modelCalls=0。历史15秒超时没有精确的同窗口阶段材料，不能由新通过反推某个已证实的生产错误根因。此后再发生可直接区分等待阶段。

## 实际结果

| 入口 | 结果 |
| --- | --- |
| build、协议、根/Web类型 | 通过 |
| core | 1503 pass / 0 fail；157个不同文件，14个测试组；Rust39通过；18项命令均close结算 |
| release-offline | 695 pass / 0 fail / 0 skip；72个不同文件，14组；所有原声明文件恰好一次，各child结算 |
| native-runtime | 90 pass / 0 fail / 0 skip；14文件、4组 |
| context artifact-e2e | packed35与observation11全部通过；E09源绑定有效 |
| docs | 16通过 |

新增制品14项与清单/子进程9项解释原release672到当前695的增量；core从原1480增加同23项到1503。包装内外、不同入口及重复窗口不累计为唯一测试总数。

当前preload为`47b1cdb83a07c8fa58ecca1954c12ca2f4a68cc64f2d90eaee1ce1b27e612c12`（638443字节），build sourceDigest=`c64b50917e53b9c208155521e7aa957aa4d2d357d5828bad7ea869e9c56b6973`；实际esbuild0.28.2、ai5.0.253、openai SDK2.0.125、Effect4.0.0-beta.107、Bun1.3.14。artifact lane前后独立内存重建与候选完全匹配。文档/提交不改变该生产源码与制品身份。

## 失败历史与边界

此前共享临时目录制品setup卡住的问题在AH-160收尾中独立定位到reference阶段，改包内自有cache后保留同样所有正反例通过；详见[制品报告](2026-09-23-preload-source-binding.md)。本批新增清单测试首轮曾错误把cargo test计入Bun命令，已改为精确可执行文件判定，未改变清单覆盖。先前大组ETIMEDOUT/SIGTERM保持真实历史，当前采用新有限窗口的完整退出回执，不声称历史从未失败。

此结果关闭本次R1所需的实施/隔离/制品入口缺口，不代签A2所有可达补丁、Q独立审查、实际安装或J2采用许可。原生组是选定原声明/worker/自有SQLite，外部模型、official对象、权限与工具效果仍是隔离能力。artifact的E07全矩阵、E10/E11及实际native/live缺口按原lane保留，不能借汇总ok改成全产品通过。没有切Host/modeld、发布profile、调用收费模型或修改用户Bot/App。
