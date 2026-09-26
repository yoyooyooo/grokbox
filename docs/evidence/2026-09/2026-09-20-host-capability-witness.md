# Host 同代注册与实际边界见证

2026-09-20。范围：HOST-01 / T44 / CLI-05 的运行见证切片；不是完整 Host 资格、实际账号验收或部署记录。

## 实现与事实边界

复用原 preload、ownership 的 getHostStatus wrapper 和管理 Server。preload 在实际赋值时固定原 handle 与方法引用；读取时逐项对比，不能把后来替换的函数登记为新的正确对象。身份、route、已选择的其他能力分别列出必要切片和句柄缺口；这只证明原注册引用仍存在，不证明所有原生机会都调用到了它们。

健康 challenge 走原认证 Native Gateway，仅返回本地内存元数据，不查询 Bot、Server 归属、凭据或模型。请求前后独立读取准确编译 marker 与实际进程身份，校验 challenge、单调采样序列、编译观察 ID、原载入摘要、PID 与五秒范围。错误旧回复也须先检查运行代，不能诊断新代。磁盘版本变化不撤销仍在运行的旧代；安装根、marker 选择和进程换代独立核对。

session 选择/stream/terminal、managed failure 识别、context lease/preflight/checkpoint 的原边界记录最多32项的连续后缀。丢弃数和后缀序号必须一致，不能挑选有利事件隐藏中间缺口。回调异常不替换业务返回或异常，不增加模型调用、上下文写入或 controller；读面不触发这些边界。

管理 Server 使用独立串行采样通道；停用停止采样，关闭取消并等待实际请求与本地写入结算，不 signal Host。challenge、采样心跳和纯序列增长不产生新持久事件。变化仍进原 runtime provenance，再进原 OBS installation condition/outbox；注册失配和检测器失联分别记录，缺证不是修复。原 runtime 目录存在而回执文件丢失时保持缺口，不从零生成同一来源的新序列。

共享 CLI/Web 展示九类注册信息和有限事件，所有正文/秘密/原生源码不加载，`opportunityCoverage=not-observed`、`qualified=false` 保留。静态验证、编译、注册引用、实际边界和业务效果是不同事实，不能合成一个绿色布尔值。

## 实际验证

Node22.22.0，Bun1.3.14，Rust1.85.0。源码指纹 `2d1c173370c46232c964c24d8e459f5acbb2ab5ed24b32fd65cb55648a51745b`，1168个源码/测试/工具链输入，两组前后固定。

`node scripts/verify-host-health.mjs core`：375项/42文件通过；`integration`：23项/17文件通过，合计398项、0失败。Rust20项、协议生成一致性、根/Web类型检查通过。包装内部 witness Node19、编译 Node11、Chrome66，不能与398重复相加。实际构建、tarball安装、正式Rust/FD、搬移Web及其他管理域在integration内执行。

见证 Node 测试实际启动打包 preload 与经过正式切片变换的公开独立来源，使用真实认证HTTP wrapper、管理服务、文件与SQLite。覆盖handle替换/恢复/getter不执行、session实际调用、32项后缀/丢弃、错误nonce/序列/身份/权限声明、source漂移、读取消、停用、重启、旧代无效回复及原证据文件丢失；context原集成保留真实Unix/SDK/状态owner路径。不是以fixture直接返回attached=true。

## 剩余

尚无完整 opportunity/bypass 判定，动态回调角色和所有能力的静态checker也未完成；跨来源配方适配、完整当前Host/worker资格、真实账号Host/Provider/App、独立告警出口及现场采用仍有各自前置。旧精确配方门与原生准入未放宽，未部署或调用真实模型。该批通过后阶段提交，继续在原开发分支推进，不移动v2或覆盖并行成果。
