# SQLite 只读锁等待与保护元数据并发

2026-09-21。在 HOST-01 扩大回归中接续 WEB-03 的保护读面稳定性调查。没有新存储 owner、缓存事实副本或事务重放。

## 复现和根因范围

管理保护 Node 组合新增80轮、每轮4个并发元数据读取，实际出现 `ContinuityFailure(busy)`。再用独立 Node 子进程把 libuv pool 固定为1：原写连接持有 EXCLUSIVE，读连接进入 SELECT，30ms后原写连接提交。旧 reader 的 native busy timeout 占着唯一worker等待锁，COMMIT排队无法释放它；读失败才释放worker。已打开读连接和锁期间新开8个连接两项独立反例均失败。

[SQLite busy_timeout](https://www.sqlite.org/c3ref/busy_timeout.html)明确该handler睡眠后返回BUSY；[Node threadpool](https://nodejs.org/api/cli.html#uv_threadpool_sizesize)描述共享固定线程池。安装的sqlite3源码也调用native busy_timeout并将工作派到异步队列。这里的根因由实际锁/真实线程池反例支持，不只从依赖文档推断。

该问题能使原保护overview返回不可用，继任链接因而缺席。它解释了一个已复现的同类失效；没有足够旧现场证明将之前那次180秒Chrome超时全部归因于它，超时残项保留。

## 修改

原 `monitor-sqlite.node.ts` 对 OPEN_READONLY 连接关闭native sleep，在已结算的读取返回SQLITE_BUSY后让出Node线程，有限等待并重读同一语句和已复制的参数。保持1秒/有限次数边界，不重新执行业务事务callback。原write/COMMIT执行次数、unknown、SQLITE_LOCKED、坏schema/权限错误与持久文件合同均不变。初始化只重试两个连接本地配置pragma，不重试任意SQL写入。

未改为WAL、增加进程线程数、吞busy为成功、缓存最后健康或重试整个HTTP写操作。真实锁不释放时仍有界拒绝。临时console诊断已移除，不把原始错误正文加入生产输出。

## 验证

[独立Node反例](../../test/sqlite-read-scheduling.test.ts)5项：唯一worker下原提交可执行、并发read-only打开可执行、真持锁有界拒绝/写入拒绝、读取参数不漂移，以及read事务不写数据库或sidecar。原始两个反例修前失败、修后通过。

[保护管理组合](../../test/protection-management.test.ts)24个Node场景通过，含80轮并发原元数据读取及原SIGKILL恢复。根typecheck及受影响8个测试文件共60项通过；内部Node计数不与外层60相加。另覆盖monitor事实/游标事务、回执丢失、缺库/坏库、存储压力和CONT未知apply/独立读回。

完整集成/浏览器和当前源码固定指纹由本大阶段最终窗口再记录，不借用此前绿色窗口。VOICE暂存文档与未闭合Host配对施工文件不进入本修复提交。
