# Template Bot 运维告警与自动化维护手册

**2026-09-17 · 补充分层配置、确认后 issue 与 Routine CLI，尚未实现/安装或启用。** 本页拥有安装、值守、故障处理与验收的操作解释；动作资格、DTO、权限、预算与目标骨架只在 [Template Ops Spec](../roadmap/template-ops-automation-spec.md) 定义。本手册不把计划中的 `runtime ops` 命令写成当前可执行能力。[T43–T53](../tickets/README.md#template-ops-automation) 拥有实现退出。

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

正常启用服务的新安装默认 user：轻量观察，配对及成本告知后只对已确认用户影响且不可安全自修的异常做 brief-notice；不默认模型排障。维护者显式选 maintainer 可多看本地来源/契约细节，但 auto-diagnose、canary、维护分别启用。旧安装 off/显式覆盖保留，单纯安装 CLI/import/GET 不启服务或收费。导入、配对、测试成功均不产生维护 grant 或 issue 发布许可。

实际能力显示 requested/effective 与阻断原因，例如未配对、缺原生资格、没有 grant；不能把「配置里开了」说成已运行。验证 heartbeat、无变化不唤醒、断线恢复和退出；自动维护需独立角色，Bot 不负责长驻。

配对/密钥轮换/卸载通过将来的 `runtime ops bind/unbind/policy` 入口完成。Secret 不出现在 argv/模板/普通输出；配对变化使旧 binding revision 失效。克隆、备份恢复或账号切换重新核对，不能复用发布者的活 Webhook、Bot ID 或 grant。

## 3. 三条用户可感知路径

### 默认简短提示；只读诊断单独启用

user 只对符合影响门的 incident 唤醒 Bot，首醒领取安全摘要、简述影响/为什么不能自修、询问是否整理 issue，然后结束。没有每次 source 变化都跑模型的动作，也不为证明不能自修而先尝试修复。用户明确请求或独立启用 auto-diagnose 后，才执行 T47 有限 playbook；next 建议不扩大权限。

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

### 默认 issue 提示示例

> 发现自定义模型通道出现异常，现有兼容性证据不足，暂时不能安全自动修复。我没有重启 Host，也没有提交任何材料。是否需要把已有的版本、错误和影响整理成一份脱敏 issue 草稿？整理后会先给你确认，再提交。

只有证据支持时才这样写；不知道原因就说未知，不把所有异常归因于补丁。用户答应整理，只准备本地稿件；展示目标仓库/公开性/标题/完整正文/附件/作者后，再确认一次具体提交。没有新内容且已明确批准 exact 稿件时，不重复索要同一确认。拒绝/不回复不定时催问。额外排障和附件各自说明范围/成本，默认不上传原始日志、对话、私有路径、endpoint 或凭据。

Webhook 唤醒本身可能消耗原生 token，不能称零成本；节约来自常态 0 模型采样、确定性分类、一次短提醒与不自动深排障。默认日预算/去重只在 [Spec §6.1](../roadmap/template-ops-automation-spec.md#capability-tiers) 定义，手册不复制常量。

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
| 用户只同意准备 issue | 生成/展示本地脱敏稿，等待 exact 发布同意 | 自动提单、上传附件或借维护 grant 代签 |
| 创建 issue 超时 | 查 submission/已知 issue/report reference，保留 unknown | 再发一次 POST 以碰碰运气 |
| maintainer preset 已选但维护未生效 | 看独立 mode、grant、资格/安全屏障和 effective | 认为维护者身份自动越过所有门 |
| Agent 创建成功而 Routine 失败 | 用 exact Agent ID/nonce/阶段续做原操作 | 删 Agent 重建、复制活 Webhook 或伪称全部完成 |

## 5. 撤销、禁用与回官方不同

撤销 grant 阻止未来自动操作，不回滚已经发生的外部效果。禁用 Webhook 只阻止唤醒，不证明 collector/维护进程已停止。停止 grokbox 普通服务也不等于 Host 未打补丁。

完整回到未注入官方 Host 遵守 [官方回退验收](official-rollback-acceptance.md)；逐 Bot 选择官方模型与全 Host 退出是两件事。原 grant 必须明确退出后新回合的模型/供应商策略，不能假定用户允许任何数据去向。不得执行 retained Host 来回退官方版本，或删除 official ack/source/用户数据库。

卸载只停本安装拥有的服务与原生任务，保留未决操作/关键 incident 的恢复证据。发送或维护 unknown 时先对账；删除配对记录不代表原生任务已删除。恢复 backup/clone 后先重新配对和复核 scope，旧 grant 不可复活。

## 6. 交付与上线检查

按 T43/T51 合同配置 → T53 通用 Agent/Routine CLI → T44/T45 只读纵切 → T46/T52 默认提醒与确认后支持推进；T47 诊断和 T48/T49 维护各自可后交付，由 T50 分 lane 验收。Offline、source CLI、packed Node 和 native 实测分别记录；只验证哪条 lane，就只批准哪条 lane。

当前可运行的回归仍以仓库已有测试为准；各新票列出的测试文件和 `template-ops` verifier 是待创建交付物，不是本次已运行清单。本专项的实际生产签署复用现有 [readiness](t32-live-enable-readiness.md)，不建立另一份绿色总表。

## 7. 配置怎么用（目标，当前命令尚不存在）

默认只需正常启用服务并完成一次模板配对；想关闭通知或多看维护者信息时，再改少量配置。唯一配置与解析/升级规则归 [Spec §6.2](../roadmap/template-ops-automation-spec.md#configuration)。示例为计划命令，不是本轮已经添加：

```text
grokbox runtime ops config show --effective
grokbox runtime ops config preset maintainer --preview
grokbox runtime ops config preset maintainer --expect-revision <revision> --confirm
grokbox runtime ops config set monitor.deepReplay true --expect-revision <revision> --confirm
grokbox runtime ops config set diagnostics.mode on-request --expect-revision <revision> --confirm
grokbox runtime ops config apply --file <preferences.json> --expect-revision <revision> --confirm
```

preset 只是版本化偏好，显式覆盖默认保留；预览会指出哪些覆盖仍有效。export 不含 binding/secret/grant/consent。maintenance.mode=low-risk 没有 grant 仍不执行；support.submit 固定 confirm-each，不能切 maintainer 后变自动提交。不要直接编辑配置文件或用环境变量绕过安全写入。`enabled=false` 关闭本专项新自动活动，`monitor.enabled=false` 仅停观察，二者都不取消已运行用户任务；旧 off 在升级后保持，不悄悄迁成开。

## 8. Routine CLI 与 E2E（目标）

当前 `grokbox agents create/update --help` 无 Routine 参数；template 的 routines 类型和 export 的 automations 备份均不是 CRUD。新增 [T53](../tickets/T53-agent-routines-cli.md) 打通独立 routines apply 与 create/update --routines-from，和模板使用同一原生程序；无需先启用运维。

完整链：能力预检 → 创建本次测试 Bot/disabled Webhook Routine → 读回/enable → invoke 真实 HTTP POST 合成 probeId → 原生 run/报告 → 更新同一 Routine 后第二次 POST → disable → 核对无新触发 → 所有本次任务结束后清理。本链与公开接口/schema 在 [Spec §10.1–10.2](../roadmap/template-ops-automation-spec.md#agent-routines) 维护。

测试保留官方模型，Bot/请求数量/费用/清理范围需独立批准；不顺便测试 Host 升级或向生产仓库提 issue。超时不重复创建，禁用不等于取消在途任务，清理只动本次明确拥有对象，失败保留 cleanup_required 与恢复回执。HTTP accepted、Bot echo、App 已读的证明层级分开。

本手册在 native Payload/模板导入/认证、用户确认来源、preset/issue API、工具权限、source/组件、policy 和生命周期变化时复核。长期目标是尽量无打扰，而不是以静默隐藏失败或把同一个故障无限交给 Bot 排障。
