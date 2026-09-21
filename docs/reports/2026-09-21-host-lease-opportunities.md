# Managed main-stream lease：运行寿命与采样间隙故障

2026-09-21，HOST-01 工作包。接续 [lease/finally 静态验证](2026-09-21-host-lease-finally.md)，不重建 CONT、采集器、通知 outbox 或 Host controller。

## 实际实现与故障边界

原 `bindHostCompactHook` 在 context 工厂失败时撤销未能返回 disposable 的预留；preflight 前后核对原 slot、取消、stepClosed 和 root 所属，迟到的成功不能越过已经关闭或被替代的 STEP。测试实际执行 TS 精确变换后的公开 fixture、生产 compact hook 和未完成 Promise，检查 preflight 拒绝、provider 等待、取消、换代、释放及工厂失败后的容量。

真实 managed 主流入口从另一侧查询原 compact registry，记录准确 Agent/TURN/STEP 的 lease present/missing，不从日志缺席猜 bypass，不增加同步准入权。原 Server challenge、运行代前后核验、provenance、OBS condition/outbox 与共享 CLI/Web 消费同一观察。新代仅有注册、读面恢复、旧代后续正常 STEP 均不能修复已知缺失；要有较新编译代的直接正机会证据。

新增反例证明：管理观察暂停时，一次 missing 可在首次采样前被后续事件挤出32项详细环。现在 Host 同代保留固定大小的累计直接观察数、missing数、首次missing与最后检查；不增加IO、timer或新DB。投影核对累计数与连续后缀，消费者拒绝同代计数、版本或首次失败倒退。Node实际运行暂停观察→missing→明细滚动→恢复Server→原OBS故障，重启不重复工作，known failure不由环回收消除。累计元数据不证明没有记录到的机会、所有消费者、真实Provider或整条恢复成功。

## 本次接续复验

DevSpace恢复后，在源码 `e2358c5f9d7ce8cb9e8dc16a80d7b6e78076d60a9c8ff6b3d3ecf95c2f59df77`、1186输入上重新运行两个窗口：core511项/51文件、integration24项/18文件，合计535项/0失败，两组前后指纹一致。Rust39、根/Web typecheck与协议生成一致性通过。包装内部 witness Node24、Host管理Node11、编译Node11、Chrome67和原其他管理域通过，不与535相加。生产build、tarball、Rust/FD及搬移Web也在integration执行。

此前架构fixture的临时目录、子进程完成及超时诊断已补强；本窗口29项架构反例通过，但不将此前历史超时全部归因于该调整。浏览器测试区分回执出现与控件解除busy的渲染边界；短期直接测试客户端用独立连接验证同端口重启后的领域历史，不改变生产网络错误和写入重试策略。

本工作包不部署、调用真实模型或外部通知；并行VOICE文档保留原暂存状态。用户最新要求最终新版不保留旧实现/兼容分支；后续从本已验证点继续将实时合同与生产资格收为单一现行版本，历史资料不因此删除，也不得制造新成功证据。
