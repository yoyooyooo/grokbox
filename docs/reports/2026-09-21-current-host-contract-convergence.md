# 当前 Host 合同、配方与 ABI 的单版本收束

2026-09-21。遵循用户最终新版无旧实现/兼容运行路径的要求，接续[运行机会闭环](2026-09-21-host-lease-opportunities.md)。本报告固定本工作包，不替代 HOST-01 当前排程，也不声明全仓翻新已经结束。

## 退出的实现

实时健康只接受 host-health-v2 的四项必需检查和 witness v2 的累计机会合同。已删除旧三项合同、window-only witness v1、可选累计信息及旧投影分支；历史字节没有被改写、抹除或自动标记成功。原Server/provenance测试将自有旧合同文件保留，验证当前读面拒绝、服务身份仍可查、关闭后文件字节不变。新Host读回旧witness也通过真实HTTP链被拒绝。

新反例先复现 persisted analysis 接受旧checker revision的漏洞；现在完整必需集合、准确id/revision在持久读回时再次校验，不只在首次Rust协议接收时验证。缺项或任意新checker不能替代当前规则。

Host authoring、能力升级、诊断与有限ABI使用同一当前配方。旧切片已直接更新为当前词法与actionOnly/mcpTools语义，删除了按SHA选择旧布局、有限名字替换映射及unknown-source回退到旧配方的分支。默认作者和原envelope/publisher仍执行严格有序apply、唯一位置、source/candidate hash及显式审核。未知布局可以明确失败，不能挑旧配方求绿。旧Host元组e7031…与2380…不再被worker installer接纳；未资格化worker候选变换出口也已删除。当前代码仍包含必要原生passthrough及域内恢复语义，它们不是旧grokbox兼容运行路径。

## 本轮真实 Host 再升级

原生复验先发现磁盘Host已从2380…升级到 `6be750313bb7bb393cc3833e103d4d2cd0dc336b6d903e7671c107ea1883767f`。该次native-pair窗口为3 pass/25 fail，未计资格通过；其后依赖该成功的静态命令没有执行。还暴露duplicate测试在hash断言前缓存source，导致后两个测试可能使用未资格字节：已移除该缓存，每个选取都先核实际源hash。

先保持生产配对未变，仅将独立测试预期定位到新来源；实际运行新来源schema/AgentStore/引用图、startup、duplicate和disposal的24项隔离测试通过。随后将生产唯一当前元组替换为新值，不追加旧兼容元组；正式worker hook+原Node module loader+自有SQLite数据库及全套原生资格再次28项通过。实际完整Host主入口、真实Bot和Provider未运行。

| 当前窗口对象 | 实测 |
| --- | --- |
| source | 6be750313bb7bb393cc3833e103d4d2cd0dc336b6d903e7671c107ea1883767f；26,548,196字节 |
| worker | 56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e；677,638字节 |
| 当前61片candidate | ed1028aebe94cd02f150f7cbfaaeb8137995b5dc16a8ca6843fffbad8b5e7ef0；26,571,968字节 |
| 有序配方 | core39 + checkpoint3 + current-state19全部应用；没有删除切片 |
| 正式Rust/FD | 三份artifact严格语法/semantic诊断0，四项必需规则全部passed |
| 配对 | 当前准确Host/worker有限ABI匹配；不是完整Host/业务资格 |

最终静态窗口分析2553ms、完整命令19492ms，仅一次测量。选择了实际打包目录中的binary；早先一次给错binary目录的尝试返回unavailable，未计分析成功。profile未发布或加载，整体qualified=false。

## 构建验证的环境隔离

扩大core首轮出现3个架构反例因5秒esbuild期限结束而失败，未放宽断言或增加超时。相同binary/781字节结果的独立小输入实验：共享临时树1793/1299ms，项目自有cache7/5ms。将测试输入和构建证明输出移入已有node_modules/.cache下的自有临时目录，并在结束时清理；不修改或清理共享临时树，不把该测量推断为所有历史浏览器超时的根因。后续29个架构场景及完整core通过。

## 固定验证

源码 `b95d2775220802a796eca8cd1ad5a0362858521828e39be1d6e2729512630f75`，1186个源码/测试/工具链输入。core607项/68文件、integration24项/18文件、native-pair28项/5文件，三个窗口前后一致，合计659项/0失败。Rust39、根/Web类型检查、协议生成一致性通过。包装内部Host管理Node13、witness26、Chrome67等不与659重复相加。正式build、tarball安装、Rust/FD、搬移Web与其余已迁移管理域实际运行。

收尾文档/实际命令覆盖15项与暂存/未暂存差异检查通过。包含未跟踪文件的全工作树发布扫描1488个文本blob，唯一发现仍为并行VOICE文档的本机路径；不把全工作树发布资格标成通过。

剩余旧controller/inject refusal-only源码和仅为它们存在的测试、仍未迁移的handover/compact入口、其他能力/存储版本与安装边界继续归主线收束。不能由本次单版本Host完成就声明整个仓库无旧残留；不得为了保持旧测试计数恢复旧实现。并行VOICE暂存成果不混入本实现提交。无部署、推送、现役切换、真实模型或外部投递。
