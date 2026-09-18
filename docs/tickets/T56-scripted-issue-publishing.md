# T56 — 用户决定后的 gh 发布适配（延期）

## Status / Goal

**Deferred · 2026-09-18；自动Issue不在当前方案。** [Spec §5.6](../roadmap/template-ops-automation-spec.md#issue-automation)。只保留未来用户主动决定后的有限自动执行，不保留旧内置REST/发布grant路径，不作为观测、通知或首发前置。

## Depends-on / Modules

未来依T52确切草稿/用户决定与OBS-03公共视图。唯一GhIssuePublisher消费已批准稿件；grokbox不保存GitHub token、不给Bot凭据、不新增发布服务。本阶段不创建命令/adapter/后台worker。

## Deferred contract

只复用当前执行环境中已安装gh及目标host下可用身份；无gh/认证/权限就保存本地材料并skip，不安装、不登录、不auth switch、不请求新PAT、不做官方App/接收服务、不自动追补旧事故。

先探测gh版本/flags，不能给旧版本传不存在的--active/--json再误判未登录，也不能仅以JSON命令exit0证明有效认证。核对GH_CONFIG_DIR/HOME/有效环境覆盖后的真实作者，检查与提交使用同一环境；不自动跨账号切换。stdout/stderr不得输出token或HTTP调试正文。

实际提交用固定host/repo、结构化stdin正文、无交互；exact内容/作者/目标变化需用户重新决定。预留submission identity，超时/崩溃/非零退出仍按实际回执判断unknown，先对账，不换工具再提交；无自动附件/评论/关闭/labels权限扩大。

## Deferred executable acceptance

实施时添加Fake gh executable/临时环境测试：旧/新参数、JSON错误exit0、多host/多账号、环境覆盖、auth失效、无TTY、超时但已创建、秘密stderr、重复提交和内容digest变化。只有再次启动本票后才确定实际测试文件与命令，不注册占位成功。

## Forbidden / Exit

无默认自动发布、无有限发布grant、无独立REST fallback、无登录引导作为必要前置。首发README不宣称有本功能。当前[LIVE-OPS-ISSUE-PUBLISHING](LIVE-integration-validation.md#live-ops-issue-publishing)保持Deferred；未来真实公开测试仍需明确对象/内容授权。
