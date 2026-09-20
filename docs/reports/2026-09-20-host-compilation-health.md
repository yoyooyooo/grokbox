# Host 编译回执与运行代健康集成

本报告固定主线 `feat/agent-first-management` 上一个工程工作包，不是当前部署、原生能力资格或完整 HOST-01 通过。前序基线为 `17c91927`；没有修改 v2、现役服务、全局入口或真实 Bot。

## 已接通的事实链

原 `Module._compile` 接缝在精确目标上恢复原函数，然后执行原 TS 变换及模块求值。补丁拒绝仍执行原生字节；模块求值失败保留原抛出对象。正负观察均包含实际 source/candidate 摘要，不把期望 profile 来源当实际加载字节。诊断回调异常不替代原生返回或异常。

原 preload-marker 保留 controller 既有字段，并增加严格投影的编译观察：准确 PID/start/UID、exe/argv、安装根/目标/操作和 profile/preload 字节摘要。只有主线程的准确启动目标写入，不由继承环境的无关子进程证明主 Host。轻量 Host 路径没有引入 Effect、Rust 进程、AST、业务数据库或轮询。

管理 Server 使用独立有界采样通道读取该 marker，核对当前实际进程身份。磁盘 A→B 与仍运行 A 的编译证据独立；PID 复用、退出、exe/argv 改变只能保留历史。旧 marker 不被推断升级成新观察。无 marker、损坏、来源不可读及编译失败分别呈现。

运行回执由原 provenance 有界保留，通过独立稳定事件流进入原 OBS installation condition/outbox。retain 与 intake 不是跨库事务；重启重放保留的事件 ID/序列。磁盘静态通过不能解决运行中未打补丁的代；缺失 marker 或失败进程退出也不是恢复。后续准确运行代正证据才能解决编译 condition，回滚旧 marker 不重开已被较新运行代解决的旧编译失败。

`system host health` 和 `/host-health` 分别展示磁盘与运行来源；compiled 只表示模块求值返回，不代表 attachment、exercised、模型执行或恢复成功。当前这两层仍分别为 not-observed/not-exercised，最终 qualified=false。

## 实施中同时修正的分层差额

接续时已有未完成的分层迁移：ModelConfiguration 已移入 ports，模型命令已移入 commands，但存储与测试仍导入旧路径，实际 typecheck 失败。本包完成消费者迁移。transport 不再反向导入 Routine/provision roots，由唯一 roots composition 注入原程序。

旧 layout checker 仍只登记早期 S2 子路径，拒绝已经接受的 model-management/materials/host-health 纯合同。本包登记三个精确出口及目标，不放宽任意出口；三个独立反例确保这些纯模块仍不能导入 Effect。失败 fixture 还要求真实架构判据，不以编译器超时冒充架构拒绝。一次正例 esbuild 超时未计通过，后续完整组合重新执行通过。

## 固定源码与实际检查

Node 22.22.0、Bun 1.3.14、Rust 1.85.0。源码指纹 `b7fb831cc870e970dd7d810f1c0b905357b6f0cad6c405bfffd2830b563a3d3a`，1161 个 git-visible 源码/测试/工具链输入。

`node scripts/verify-host-health.mjs core`：334 pass / 0 fail，36 个文件；包括29个架构场景、模型存储/管理 Gateway、preload marker/hook、原 OBS/modeld、客户端和 CLI。协议生成校验、20个 Rust 测试、根/Web typecheck 同窗口通过。

`node scripts/verify-host-health.mjs integration`：22 pass / 0 fail，16 个文件。与 core 文件不重叠，合计356个 Bun测试；Node/Chrome 包装内部计数不能再次相加。内部编译回执 Node11、Host健康 Node10、verifier Node21与边界 Node20、Chrome65 均通过，并回归其他管理领域。生产构建、搬移 Web、tarball 实际安装、Rust binary/manifest/许可与Web制品核验同批执行。修正文件尾多余空行后，重新执行上述两组；最终两个窗口前后源码指纹相同，不含 docs 或已安装依赖。

编译测试实际启动打包 preload 和公开合成模块，覆盖补丁拒绝继续原生求值、语法和运行时异常、进程退出后的负证据、PID复用、来源/marker篡改、retain-before-intake中断、重启幂等和无 OBS 的 local-only。停止管理 Server 不向仍运行的测试 Host 发信号。

阶段中文档/实际命令覆盖15项通过，包含未跟踪文件的发布扫描1450个文本blob无发现。收尾发现多余EOF空行后已修正并重新跑完上述core/integration。此前最后工具调用未执行；下一接续窗口重新核对同一源码指纹、15项文档检查、含未跟踪文件的发布扫描和 `git diff HEAD --check` 均通过，随后按阶段保全本批。未重建已验证的工作包，也没有推送、发布或切换现役。

## 未证明范围

公开合成模块不代替私人 Host/worker 的当前配方适配或真实加载资格；本包没有重新执行实际磁盘配方诊断。当前9+2来源差额仍沿 HOST-01 的原证据保留。同代真实 handler 挂接、完整能力目录、实际触发见证、独立通知出口和长期安装/容量仍需继续，不从编译成功推导。
