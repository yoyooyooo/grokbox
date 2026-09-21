# 旧控制入口与 preload 回退退出

2026-09-21，CLI-05/T28/HOST-01 重建收束。接续已提交的单版本Host，不重做lease/机会阶段。

删除旧 `controller.runtime.ts`、`live-inject.ts`、`live-readopt.ts` 及6个只验证旧拒绝型stub的测试文件。相关引用从打包、CLI、只读观察、helper、HOME隔离fixture及验证清单中全部退出；不保留throwing shim。现行Controller program、direct/transient策略、guardian、身份与未知操作恢复仍在。新的边界测试扫描生产consumer和公开包，确认旧文件/符号确实不存在；不会把一个工厂从未被调用当成实际零副作用证据。

preload定位只使用当前源码对应dist或已安装bundle同级CJS。缺制品不借用checkout/旧run-root副本，也不返回无法由Node加载的TypeScript。读侧摘要查询仍明确返回不可得，不能意外抛出resolver异常破坏诊断。独立安装目录反例在checkout有完整构建时仍拒绝缺失的本安装制品。

96项/11文件定向验证通过，含原controller真实文件锁/跨进程、CLI配置与拒绝路径、只读观察、隔离HOME、helper、实际tarball安装和打包preload；typecheck及文档/命令覆盖15项通过。旧CLI禁词断言误将新`health`匹配为`heal`，改为准确命令token匹配，而非移除该断言。原生Host/模型未执行，原生资料未读取或修改，未知记录未清空。全大阶段组合在收束后另行固定；本报告不是全仓翻新完成。
