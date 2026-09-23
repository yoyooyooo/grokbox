# 原生产品合同的浏览器边界

工作包 AH-169。来源：正式 core 的独立浏览器 client 构建在 `node:crypto` 解析处失败；Node HTTP 或 SSR 构建通过不能代替该边界。

## 单一合同与摘要兼容

产品 client 改读独立 `runtime-kernel/products` 公共入口，不再从整个 continuity barrel 引入运行时图。产品意图、权限披露、回执一致性与原生对象校验函数未复制或降级，只调整其依赖。原 ContinuityFailure 与标识谓词提取成纯 primitives，由 material 原入口重新导出同一实现。

canonicalJson 原逻辑逐字移动为纯模块，Node hash 原入口继续导出它并保留原 createHash 实现。仅产品使用 portable-hash，固定依赖 `@noble/hashes` 2.4.0 的 SHA-256；UTF-8 编码保持 TextEncoder 与 Node 原摘要一致。没有 Node 假 polyfill、跳过摘要、或由 client 自报成功。

两个新公共导出使用 src 顶层入口，原内部路径禁止规则保持。源码执行映射同时补齐先前遗漏的 materials/files/compaction；原 shim 测试仍验证每个真实 export 和离开 checkout cwd 的实际执行，不操作已安装的全局命令。

## 验证方式

原 client 浏览器构建修前失败；修后由 esbuild 的 browser 平台打包，不使用 node:crypto external 或别名。依赖图只加入显式纯模块与四个固定 SHA 库模块，Node/Effect/存储/Provider 依赖仍禁止。

新增回归将生成的浏览器 IIFE 放进无 process/require/Buffer 的 VM 执行，正确回执通过，伪造对象摘要与未派发却声称匹配的回执拒绝。已对空串、标准向量、中文/emoji、未配对 surrogate、块填充和二进制边界比对原 Node 摘要，并核验原错误构造器身份未变。

同域 Node 产品、消息、Server、模型授权与原 CONT 存储/当前状态程序参与交叉回归。所有业务资源均为自有临时根与合成事实；不表示真实 App、原生账号、运行模型或完整核心候选已获资格。

源码：[纯产品入口](../../packages/runtime-kernel/src/products.ts)、[摘要实现](../../packages/runtime-kernel/src/portable-hash.ts)、[浏览器行为回归](../../packages/client/test/product-browser.test.ts)。

## 独立复核及未扩大声明

限定源码复核接受本补丁，未签完整核心/现场。另加明确 canonical JSON 金值，避免只比较移动后的同一个函数。原产品校验主体在import之后与父提交一致；Node与portable摘要的独立实现仍有已执行向量比对。

原源码shim安装探针存在独立的10秒超时：本候选有单独3/3通过，也有合跑/随后单跑失败；未包含本补丁的V2基线也复现同一失败。路径映射一致性已修复，但不将该启动失败宣称解决；AH-170单独跟进。浏览器client与Node业务交叉结果、源码shim结果分别陈述，不用前者覆盖后者。

## 全组后续消费者

正式core越过client后发现architecture最小合法夹具未同步两个公共入口。本票补齐夹具exports/源文件，并把新入口纳入原Effect禁止反例；负例另外拒绝以意外缺失export充当预期失败。生产checker规则与产品运行时未再修改。
