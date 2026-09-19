# 运行结果观测

本页只保留排障入口和证据边界。2026-09-19 在隔离 worktree 执行的 `test/outcome.test.ts`、`modeld-outcome.test.ts`、`provider-failure-unix.test.ts` 提供本地回归证据；它们不证明当前 Host、App 或真实 Provider 已采用相同行为。旧版本号、历史 pass 数和现场步骤已删除，可从 `6f0473d:docs/maintainers/run-outcome-observation.md` 查历史。

## 先绑定原操作

send 回执里的 `clientNonce` 用于继续观察同一次发送：

```sh
grokbox history outcome <agent-id> --nonce <clientNonce> --runtime --json
```

只有 STEP ID 时，先查已有本机记录：

```sh
grokbox runtime incident <step-id> --agent <agent-id> --json
grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
```

自定义 runtime 根须提供相应 `GROKBOX_RUN_ROOT`。查询缺少关联时保持未知；不要用同名、相邻时间、新 nonce 或重发消息补成成功。

## 分开读取证据

| 观察 | 能说明什么 |
| --- | --- |
| `recorded` / queued | 输入已记录或排队，不是任务完成 |
| 同 STEP 的明确失败 | 不能被较早进度回复、空 alerts 或消失的 tray 洗成成功 |
| Provider terminal / Host terminal | 各自边界的结果；不等于原生 checkpoint、工具副作用或用户收到回复 |
| 工具材料释放 | 不证明工具实际执行、回滚或原子批次 |
| 日志缺失、截断、不可读 | 证据不足，不是没有失败 |
| 历史 progress、PID、健康文件 | 最后观察，不是当前存活租约 |

当前投影从 `packages/cli/src/outcome.ts` 进入；修改时用反例检查它。只存在字段或通过旧测试，都不能证明投影正确。

<a id="推理档位证据schema-v2--wire-v7"></a>
## 模型、档位与加载状态

区分 configured-next-turn、当前 TURN captured、请求 emitted 和 Provider reported。标题、耗时、更多 tokens、Bot 自述或默认值不能证明实际档位；未观测的 reported 保持 unknown。见 [配置说明](../configuration.md#model-reasoning-schema-and-general-config-migration)。

协议版本查看实际 [wire 常量](../../packages/runtime-kernel/src/internal/contract/wire.ts)和加载进程的直接证据；源码相容不证明驻留进程已升级。手动 title sync 与定时刷新也须分别观察，等待两分钟本身不是验证。

## 尚未证明的边界

原生 trigger、checkpoint/Memory writer、App 展示、重启连续性及真实 Provider 请求仍需对应现场证据。本次未重新验证完整 recovery、retention、authority-wait 路径；旧文档中的精确预算和部署结论不再作为当前事实复制。

通过 [LIVE](../tickets/LIVE-integration-validation.md#live-modeld-app) 找具体场景和报告，并核验报告的输入、版本和执行范围。fixture/SDK/Unix 测试、打包成功、旧报告和代码修复都不能自动把现场结果改为 passed。
