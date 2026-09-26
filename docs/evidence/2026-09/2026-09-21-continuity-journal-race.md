# CONT 元数据并发读取：已退役 journal 的身份观察

2026-09-21。承接[SQLite只读调度](2026-09-21-sqlite-read-scheduling.md)；这是另一处独立竞态，不回滚原线程池等待修复，也不重建数据库。

本轮完整集成再次在保护元数据并发读取中得到 `ContinuityFailure(unsafe_path)`。缩到相同生产 reader／原保护 writer 后，1600轮×4读取的诊断窗口捕获：失败对象为 journal、regular=true、symlink=false、nlink=0、mode=0600、同UID。这不是硬链接或权限变化，而是路径检查观察到了原写方已 unlink 的 journal inode。临时诊断字段随后删除，没有将原路径或任意异常正文加入生产输出。

`checkContinuitySidecar`现在只为三种 SQLite sidecar 做一次有限重观察：第一次若是私有、同UID、正常类型但 nlink=0，只重新观察路径；缺失可作为该次缺失，存在的替代文件仍须满足全部原有安全检查。再次遇到退役 inode 返回 busy，不能接受它、无限重试或把它归类为损坏。符号链接、多个链接、非私有权限或不同owner一开始就拒绝。数据库与材料对象仍使用原严格 `checkContinuityFile`，不共享这一临时文件例外。

新增7项确定性反例使用真实打开后unlink的inode元数据固定竞态第一步，后续路径操作仍为真实文件系统：缺失、正常重建、chmod／硬链接／符号链接替代、连续退役以及非sidecar路径。生产保护组合保留原断言并扩大到200轮×4并发读取；没有通过在HTTP层重试、使用旧缓存或忽略失败求绿。

本提交前focused组合32项／5文件通过，包含这7项、Host lease和见证相关测试，以及实际Node保护管理24个内部场景；包装内部计数不重复相加。固定完整阶段回归归HOST-01后续窗口，不据此宣称此前全部浏览器超时根因已解决。未触及原生Bot、现役服务或并行VOICE规划。
