# A · 当前 Host、原生接口与补丁健康资格

归属：[并行拓扑](../parallel-delivery.md)。本卡是后续实施任务，不是已通过资格。建议分支`feat/w3-host-current`；从当前`feat/box-runtime-v2`切独立worktree，每个出口回流v2。

## 目标与先读入口

让同一套当前Host/worker、唯一TS变换、原生接缝及Rust/Oxc证据能够支撑真实运行核心；随后扩展到完整产品。先读[HOST-01](../../../tickets/HOST-01-patch-health-verifier.md)、[HCR-04](../../../tickets/HCR-04-capability-profile-upgrade.md)、[来源变化记录](../../../reports/2026-09-22-native-material-source-drift.md)及[健康方案](../../host-patch-health-proposal.md)。历史固定来源是证据输入，不是当前安装事实。

## 掌管模块与禁止越界

原`packages/box-runtime/src/internal/host/`中的source recipe、profile应用、接缝注册、native checkpoint pair；`internal/io/host-verifier/`、`internal/ops/host-health/`、`internal/roots/host-health.runtime.ts`；`crates/host-verifier/`和现有协议生成/资格工具。对应公开合同仍在runtime-kernel，Host保持轻量。

A拥有全局配方、原生ABI资格和最终注册；R拥有执行/上下文算法，B拥有材料writer适配，C拥有恢复/交接程序。相关路线可以提交本域原生模块，但共同slice/注册/schema变化先交A整合，不各自维护“当前Host”。E消费证据，不另造检查器；F消费制品，不改配方选择。

## 分阶段出口

| 出口 | 可开始条件 | 必须交付 / 解除的依赖 |
| --- | --- | --- |
| **A1 当前接口合同** | J0；能读取所选原生来源 | 重新固定Host/worker集合，逐接缝确认原生角色、异步签名、writer、身份、权限、失败和独立读回。现行有序变换在候选上成立，相关原生ABI用原声明/worker和自有存储验证。给R/B/C/D/E可消费的具体接口清单；不是只改pin或跑parse |
| **A2 核心候选资格** | A1；R/F/E的所需合同已接入 | 对本次实际加载/可达的所有补丁形成风险闭包：正常/合法语义破坏、原生passthrough、辅助链、checkpoint/lease、取消/资源释放及非目标影响有证据。静态、编译、引用、调用机会分别呈现；输出J2所需的采用前资格。J2后的实际loaded/调用证据交J3，不形成首次采用的循环前置 |
| **A3 全产品覆盖** | 各领域新增原生接口已确定 | 接入B/C的材料/初始化/入站/删除等新能力，完成HOST-01声明的必要健康覆盖、检测器/来源重启与故障恢复。交J5；不得用A2局部通过关闭全票 |

A1可以分批交有用接口，消费者只等待自己实际调用的接口资格。A3不阻R的核心真实往返，但A2中必需未证能力不能借A3后置。

## 验证与现场边界

先运行受影响的source recipe、Host leaf、Rust规则/协议和Node/只读FD组合。现有入口：`cargo test --locked -p grokbox-host-verifier`、`node scripts/generate-host-verifier-protocol.mjs --check`、`node scripts/verify-host-health.mjs core`。按实际改动选择局部测试，不为每个小修重跑全部管理领域。

原生隔离入口及所需环境见HOST-01；只访问明确源和自有worker库，不执行完整Host、真实模型或改profile。失效源不能自动回退历史配方；合法JS语义反例不能只靠unknown-sha或语法错被拒绝。实际采用由Q统一窗口，F执行唯一controller；A提供源/制品/加载/见证的独立核对。

不得新建Rust变换器、原生业务数据库、第二controller，或放宽授权/把`qualified`写绿求通过。更新installed source后相关证据重验；磁盘变化不等于现役已加载或Bot已故障。

## 交付与阻塞

每个出口提供v2基线/tip、接口表、源/worker/candidate/制品摘要、测试真实性、当前缺口及直接消费者。接口表在HOST-01/HCR相应来源处维护，本卡只路由。

缺来源访问只阻相关ABI/现场资格，继续公开fixture及协议工作；未知原生角色是CODE/DEP，明确缺哪个reader/writer，不把整个B/C都标“等Host全完”。J2所加载路径存在P0/P1或必要资格缺失则保留阻断，不能用未运行该功能的短对话绕过。
