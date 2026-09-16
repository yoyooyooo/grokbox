# Template Bot 运维告警与自动化维护手册

**2026-09-16 · 设计/施工手册，尚未安装或启用。** 本页拥有安装、值守、故障处理与验收的操作解释；动作资格、DTO、权限、预算与目标骨架只在 [Template Ops Spec](../roadmap/template-ops-automation-spec.md) 定义。本手册不把计划中的 `runtime ops` 命令写成当前可执行能力。[T43–T50](../tickets/README.md#template-ops-automation) 拥有实现退出。

## 1. 当前就能做的只读检查

在已安装 grokbox 的目标 Box 上，以下是已有入口，不会因为查询自动安装 collector、触发 Webhook、修改 profile 或恢复 Host：

```bash
grokbox doctor --json
grokbox runtime status --json
grokbox runtime profile status --json
grokbox runtime monitor snapshot --json
grokbox runtime monitor incidents --json
```

monitor 未初始化或没有采样时保留 missing/stale，不因此创建空库假称受保护。命令参数以安装版本 `--help` 为准。当前 `profile watch` 仅支持 `--once`；该名字不证明常驻监控已经运行。`profile watch --once --from` 会保留本机源证据，不属于零写入状态查询。

`doctor` 的 custom/ready 不等于全量兼容性；`coverage: window-open` 也可能来自模型分配或准入配置，不一定是源码补丁坏了。存量 open circuit、当前 source mismatch、加载来源、modeld ready、controller heartbeat 和真实用户交付分别检查。磁盘 SHA 不是旧进程加载 SHA。

## 2. 实现后的安装旅程

下面是目标流程；T46/T50 未关闭前不运行虚构命令，也不手工编辑原生产品状态。

导入 grokbox template bot，保持其官方模型。先读取本安装支持的 native automation 能力表。模板应只包含无密钥、未激活的 Webhook 蓝图；上游不支持安全导入时，由 bootstrap 在配对后通过原生接口创建。确认安装/账号作用域、精确 Bot 与 routine，安全保存 endpoint secret ref，再发送无害合成测试事件，核对原生 run 与用户报告。

用户单独选择 notify 或 diagnose，并明确接受原生推理成本；自动维护另选 maintain-low-risk 的动作类和预算。导入、配对、发送测试成功均不自动获得维护权。安装长驻 observer 后验证 heartbeat、无变化不唤醒、断线恢复和退出；需要自动维护时另安装独立维护角色，不能让 Bot 自己维持进程。

配对/密钥轮换/卸载通过将来的 `runtime ops bind/unbind/policy` 入口完成。Secret 不出现在 argv/模板/普通输出；配对变化使旧 binding revision 失效。克隆、备份恢复或账号切换重新核对，不能复用发布者的活 Webhook、Bot ID 或 grant。

## 3. 三条用户可感知路径

### 只读自动排障后主动报告

事件被本地采样确定并入库后唤醒 Bot。Bot claim 当前证据、执行有限只读 playbook，随后报告；它不因诊断工具的 next 建议而自行扩大任务。

示例报告：

> 检测到 Host 的安装版本发生变化，当前运行进程仍使用上一代。新版本的补丁资格尚未通过，所以我没有重启或重新注入。已核对源码、加载收据和相关契约；现有任务没有因本次监测被停止。需要审核的差异已保留，下一步是批准候选或继续保持当前状态。

示例只在证据支持时使用；若无法确认任务状态，必须改为「任务是否受影响尚未确认」。不要用这段固定文案遮盖 unknown。

### 低风险静默维护

已有用户 grant、固定组合 qualification 和实时安全屏障都成立时，允许程序无模型执行，或在 Bot 辅助诊断后提交计划。Bot 收到「计划已持久接收」就结束本回合，不在后台等自己的 Host 重启。维护角色等待实际安全边界、执行唯一 controller、保存结果；成功写时间线或按用户偏好摘要，不强制每次打扰。

静默资格不来自“小改动”或模型自称高 confidence。新 SHA 的自动派生只有落在已审核等价规则中才成立；观察/切片/依赖缺证据时自动降为候选与报告。

### 无法静默时主动告警

示例报告：

> 已识别到与补丁相关的契约变化，但仍有原生子任务运行，暂时无法安全切换。我没有强制停止任务，也没有应用新补丁。自动维护已暂停，问题与计划已记录；需要你批准一次会中断这些任务的维护，或等任务自行结束后重新核对。

审批必须指向精确 plan 与影响，不是让用户回复一个可以批准任意未来动作的「好」。当前 active STEP 不得因退补丁而偷偷换模型、重做工具或改变数据去向。

## 4. 故障分流

| 现象 | 正确处理 | 不应做的事 |
|---|---|---|
| 已检测变化但没有 Bot 消息 | 看 outbox、fixed binding、attempt/unknown、native accepted/run、claim、报告回执，分层定位 | 用新 deliveryId 无限重发，或因 HTTP 200 宣称用户已收到 |
| 同一事件唤醒多次 | 对账同 deliveryId/incident revision，确认单次诊断/操作；披露原生重复推理成本 | 以每次唤醒都执行一次维护 |
| Bot 一直 Working | 看是否在等待自己的 Host 维护、是否遗留原生子任务；按 [Working 手册](working-state-recovery.md) 分层判断 | 自动取消用户任务或忽略提出者的 busy |
| Source 新 SHA 但 anchors 全绿 | 查完整生效切片/依赖闭包、component、wire、规则/test revision 与资格 | 直接重写 SHA/批准新 recipe |
| `window-open`、doctor ready 同时出现 | 分开源、配置准入、加载、operation、circuit 与监测事实 | 将所有非 green 状态归结为补丁错误后重启 |
| 安装处于 transition/mixed/rollback | 留证并失效自动资格，重新采样/等待或报告 | 以版本号、ack 消失、固定等待秒数证明安全 |
| 已提交维护但 Bot 没返回结果 | 查权威 controller operation；提出者本应已结束，结果通过后续交付回收 | 重交相同信号、从 Bot 文本判断操作是否发生 |
| 维护/退出超时 | 保留 partial/unknown，检查独立 guardian 与已发生前缀，只按 owner 流程对账 | 假称回官方、清记录、无限 patch/rollback |
| Webhook/配对/工具能力变了 | 降级或禁用对应自动模式，重新资格化 | 复用旧 schema/endpoint，靠 prompt 替代权限隔离 |
| collector、SQLite 或通知不可用 | 当前状态显式 degraded/gap；不执行新的自动计划；原推理不依赖本观察库 | 删除库重建成空绿、自动解除原 circuit |
| 整个 Box 或原生服务离线 | 承认本机可能无法发出消息；恢复后补欠账，外部离线告警另配 | 承诺模板 Bot 无条件报告自身故障域死亡 |

## 5. 撤销、禁用与回官方不同

撤销 grant 阻止未来自动操作，不回滚已经发生的外部效果。禁用 Webhook 只阻止唤醒，不证明 collector/维护进程已停止。停止 grokbox 普通服务也不等于 Host 未打补丁。

完整回到未注入官方 Host 遵守 [官方回退验收](official-rollback-acceptance.md)；逐 Bot 选择官方模型与全 Host 退出是两件事。原 grant 必须明确退出后新回合的模型/供应商策略，不能假定用户允许任何数据去向。不得执行 retained Host 来回退官方版本，或删除 official ack/source/用户数据库。

卸载只停本安装拥有的服务与原生任务，保留未决操作/关键 incident 的恢复证据。发送或维护 unknown 时先对账；删除配对记录不代表原生任务已删除。恢复 backup/clone 后先重新配对和复核 scope，旧 grant 不可复活。

## 6. 交付与上线检查

按 T43 的 native capability → T44/T45 只读纵切 → T46 配对/隔离 → T47 有限排障 → T48/T49 单动作类维护 → T50 持久验收推进。Offline、source CLI、packed Node 和 native 实测分别记录；只验证哪条 lane，就只批准哪条 lane。

当前可运行的回归仍以仓库已有测试为准；各新票列出的测试文件和 `template-ops` verifier 是待创建交付物，不是本次已运行清单。本专项的实际生产签署复用现有 [readiness](t32-live-enable-readiness.md)，不建立另一份绿色总表。

本手册在 native Payload/模板导入/认证、工具权限、source/组件、policy 和生命周期变化时复核。长期目标是尽量无打扰，而不是以静默隐藏失败或把同一个故障无限交给 Bot 排障。
