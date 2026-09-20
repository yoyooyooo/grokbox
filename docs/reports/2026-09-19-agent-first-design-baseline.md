# Agent-first CLI 与 Web UI V0 文档基线回执

日期：2026-09-19。基线为 v2 commit `6f0473d54b16885568e85c2850bc1bde02f58579`，在独立 worktree 中完成文档变更。本文只证明这次文档与资源落盘，不是新命令实现、浏览器交付或 live 采用回执。

## 交付与范围

- [CLI 方案入口](../roadmap/agent-first-cli/README.md)路由 Spec、统一命令合同、候选目录、旧命令去向、决策和实现影响占位。
- [合同讨论票](../tickets/README.md)承接身份/发现、操作结果、观察等待、命令切换；实现关联另为占位。
- [Web UI 页面目标](../roadmap/future/webui-console.md)补充全局 Memory、Project/文件、状态与日志，并记录 TanStack Start SSR 和独立 Effect-first API 的方向。
- [固定来源研究](2026-09-19-webui-source-feasibility.md)记录有限互操作事实和研究构建指纹，不复制私有源文件。
- [V0 视觉基线](../design/webui/v0/README.md)保存最后一批四张图与功能纠偏。每个 SVG 内嵌原 PNG 字节，未转码、裁切或重新生成；[manifest](../design/webui/v0/manifest.json)保存原字节数和 SHA-256。

当前公共命令合同仍待讨论。205 个候选 leaf 是完整性检查输入，不是上线数量承诺。旧命令映射是固定源码窗口的迁移提案，不取代实际 registry。

## 验证

| 检查 | 实际结果 | 限制 |
| --- | --- | --- |
| `bun run check:docs` | 23 pass，0 fail | 文档链接、现有 LIVE 结构与纯仓库规则，不访问官方服务 |
| registry 与迁移表对比 | 182 个唯一 leaf，182 个唯一映射，缺失/额外均为 0 | 只覆盖上述基线，实施前须重跑 |
| 候选目录统计 | 58 个目录行，205 个候选 leaf | 不代表这些命令已存在 |
| 四张图片完整性 | 内嵌 PNG 大小、SHA-256、签名和 1586 × 992 尺寸均匹配原图 | 尚未进行最终 Web SVG renderer 或浏览器页面验收 |
| `git diff --check` | 通过 | 不代替新增文件链接与内容检查，后者由文档检查和专项比较覆盖 |

实际检查使用环境中的 Bun 1.4.2；仓库 packageManager 声明为 Bun 1.3.14。本次没有改变工具链或锁文件。Python 命令在该工作环境不存在，图片检查改用现有 Node 的只读内存校验完成。

本轮未修改业务源码、启动服务、安装补丁、发送消息或调用模型。没有独立 review 或生产资格声明。未决事项进入[决策清单](../roadmap/agent-first-cli/decisions.md)，后续实现差额进入[关联占位](../roadmap/agent-first-cli/implementation-impact.md)，不在本报告维护滚动进度。
