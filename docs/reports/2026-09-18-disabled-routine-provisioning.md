# 默认禁用 Routine 创建、持久回执与精确对账 · 2026-09-18

本片基于 `fbde51b`，继续[T53](../tickets/T53-agent-routines-cli.md)的通知前置，不改变已经交付的[OBS/CONT J1接口](../roadmap/template-ops-automation-spec.md#obs-continuity-interface)。产品合同归[Template Ops §10.1](../roadmap/template-ops-automation-spec.md#agent-routines)，现场仅归[LIVE-OPS-ROUTINES](../tickets/LIVE-integration-validation.md#live-ops-routines)与既有配置成套切换条目。没有替身、关系迁移、旧Bot删除或真实通知操作。

## 实际交付

新增三个已注册入口，local/daemon复用相同程序：

```text
agents routines apply <agent-id> --from <file> --operation-id <id> --confirm
agents routines outcome <agent-id> --operation-id <id>
agents routines reconcile <agent-id> --operation-id <id> --routine-id <id> --confirm
```

apply接收单份严格schema1 blueprint：key/name/prompt/webhook trigger，isEnabled只能省略或false。文件在解析前限制24KiB，prompt限制16KiB，读取为有限、严格UTF-8、同文件身份的regular-file读取。不接受任意URL、凭据、cron/group或自动启用。首次创建显式disabled；已有managed key只更新本安装保存的native ID，且expected revision必须同时吻合本地binding与当前原生定义。省略其他key不删除任务，外部编辑或对象缺失不会被覆盖/重建。

`RoutineProvisionLedger`与`NativeRoutineProvision`通过kernel的`runRoutineProvision`组合，box-runtime facade装配实际store/native adapter。原有Routine管理命令、模型选择、配置、CONT及observability source接口不重写。新的Gateway写入只有createAgentAutomation/updateAgentAutomation，不获取Webhook凭据、不执行runNow或sendPrompt。远程使用必须具有匹配的daemon能力，禁止用客户端本地账本给远端Gateway创建重放许可。

## 持久副作用边界

本地`state/routine-provision/operations.sqlite`是T53 scoped provision回执与重放保护，不是第二份原生调度库。只复用既有portable SQLite driver；不复用monitor表、诊断TTL或GC。保存operation身份、key、digest、native ID、状态及原dispatch进程身份，不保存prompt/凭据/原生响应正文。

每次先用短事务提交attempting记录，再在事务外执行至多一次原生请求，随后读回并单独提交binding和结果。相同operation重入必须fingerprint一致，并返回已有历史回执；结果不明时，同agent/key的新operation也不能绕过旧记录再创建。原生或本地ACK丢失、后置读取不符均保留unknown，不自动重投。

outcome是历史结果，不证明当前Routine开关或全部远端工作已终结。reconcile由用户明确指定精确native ID，校验相同预期定义且disabled后只更新本地记录；不按名称自动认领，不发第二次create。attempting的原进程仍活着或身份不可证时拒绝接管；证明进程退出或启动身份改变后才可显式对账。原生返回列表而非事务receipt，因此仍明确无native CAS/idempotency，读取一致也不等于排除App并发或取消在途任务。

## 容量与损坏行为

本域SQLite主文件最大2MiB，安装级最多256条operation记录；这不是模型STEP数量上限，触顶只阻止新的provision。未知记录不因容量、时间或诊断GC被删除；安全退役尚未实现。`runtime storage status`单列routineProvision的容量、未结数量和不允许诊断GC的边界。

只有赢得首次私有目录创建的进程能初始化其空文件。既有账本被截断、损坏，或目录存在而DB丢失时明确拒绝，不把它当作新安装。首次初始化中断可能留下需要后续明确恢复的阻断；本片不通过清空目录假修复，也不制造无限临时文件。最后可靠重放保护不能为了提升可用性被自动放弃。

## 固定验证结果

项目固定Bun1.3.14，原依赖、models v2及wire8未改变；config仍为4。可重复专项：

```bash
bun scripts/verify-runtime-rebuild.mjs routine-provision
```

最终完整专项为 **149 pass / 0 fail**，9文件、965断言；类型、构建、导入边界和含untracked的隐私扫描通过。验证前后源码摘要相同：`c572f1115165ee963ba9bb88e3bd804b70ac0e9a23aadae512bb064b0dd7cdde`（754个source/test/lock文件）。实际preload SHA-256为`05cfd5fe4f6301f237f0dee7b3c211ff287d9764ec5a9258fe68be8a131c3759`，pin按真实构建更新并通过拒旧制品测试。

CLI全目录 **690 pass / 0 fail**（67文件、5626断言）。packages一次整组调用超过工具时限，未取得完整回执、不计通过；随后将排序后的全部测试文件按行号mod3分成互不重叠三组：

| 分组 | 最终结果 |
|---|---|
| mod3=0 | 620 pass / 11 skip / 0 fail；83文件、6215断言 |
| mod3=1 | 604 pass / 2 skip / 0 fail；84文件、7710断言 |
| mod3=2 | 523 pass / 6 skip / 0 fail；83文件、3272断言 |

packages合计1747 pass/19 skip/0 fail；与CLI合计 **2437 pass / 19 skip / 0 fail**，317文件、22823断言。默认跳过的19项原生资格不计通过。上述分组之后，提交前另补一行守卫及断言：已有observed记录也必须匹配reconcile指定ID，不能直接返回不相符的旧成功回执。该最后改动经40项集中回归及最终149项完整专项再次验证（增加1条断言）；没有将较早分组回执称作这行改动之后重新运行的全仓结果。此后只收口文档，最终提交/rebase是否改变代码以Git复验为准。

新provision测试13项覆盖重复/不同operation绕过、并发、create/update的精确ID、预期revision、丢ACK、reserve/finish提交不确定、真实子进程SIGKILL后身份对账、256记录及真实文件上限、损坏/缺失账本不重建、诊断GC隔离。CLI测试在真实local/daemon及实际打包Node中走完整apply/outcome/re-entry流程，原生HTTP是合成边界，不操作产品Bot。J1原14项合同回归包含在专项中并通过。

### 验证器问题与修正

导入副作用探针最初使用运行脚本的process.execPath，即在Bun执行验证脚本时以Bun代替发布运行时。该自定义monkeypatch探针发生过5秒超时。先隔离继承的启用环境参数后单次通过，但组合仍复现，不能把环境隔离说成已确认完整根因。现明确使用Node并核对engine，同时保留原5秒界限、全部写入陷阱、负向副作用测试及独立Bun packed smoke；没有去掉检测或增加超时。

journal-lock历史测试在第三组出现子进程就绪失败，单独运行也可复现。测试改为将原TS worker打包到测试专属临时文件并用Node执行，保持原ready/queued窗口与全部13项真实SIGKILL/互斥/活owner保护断言。生产锁源码未修改；修正后该文件和整个第三分组均复验通过，最后专项也包含它。并未声称已诊断Bun内部根因。

## 剩余门槛

没有真实native HTTP创建/更新资格、凭据配对、Webhook invoke/run/report对账，也没有多项blueprint或agents create/update --routines-from组合。原生调度事务/CAS/取消语义不能由这些离线测试补造。下一段仍应接T54/T46配对与T45投递，不能把本地历史回执当Bot已收到提醒。

独立Astra复核请求本轮仍返回503，没有审核结论；此前上游事实Current Home写入阻断未在本片绕过。新代码不因此取得上线资格。

本片没有切换全局shim、迁移现役schema、重启Host/modeld、创建真实Routine/Bot、发Webhook/业务模型请求、提Issue或发布模板。schema4仍依既有原制品/配置退路与固定v2候选的成套采用程序；Git合并和J1 handoff都不自动触发部署。

收口时曾准备仅同步v2的LIVE-OPS-ROUTINES行；该v2提交调用被工具安全检查拦截，没有重新换入口提交。已撤回本次未提交的v2文档编辑，保留实施分支同一路径的更新；v2索引同步属于后续集成待办，不宣称本片已在v2登记或采用。
