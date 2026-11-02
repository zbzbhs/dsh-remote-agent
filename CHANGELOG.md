# 更新日志

本文件记录所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于 0.x**：在 1.0 之前，`lib/**` 是 DSH 直接加载的产物（无构建步骤），
> 所以每次变更都可能是**行为变更**。升级前请读本文件对应条目。

---

## [0.10.1] - 2026-11-02

### 🔴 修复：0.10.0 装进 profile 后整个插件不激活

**这是发布后立刻暴露的阻断级事故。**

现场（2026-11-02，主机 profile 升到 0.10.0 后）：

```
GET /dsh-market/status
{"active": false, "error": "dsh: warning: 1 entry did not activate\n
 remote-agent (dsh-remote-agent): TypeError: tool \"remote_write\" must declare
 output { schema, render, presentationMeta? }"}
```

24 个工具全部消失、面板全空 —— 但**本地测试 1086 条全绿**。

#### 根因

DSH 的 `ctx.tools.register()` 是**注册期硬校验**（`dsh-tools/lib/index.js:2977`）：

```js
if (output === void 0 || typeof output !== 'object'
    || typeof output.render !== 'function'
    || output.presentationMeta !== void 0 && typeof output.presentationMeta !== 'function')
  throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
```

0.10.0 里有两类声明不满足它：

- `writeOp(...)`（`remote_write` / `remote_mkdir` / `remote_move` / `remote_delete`）
  把裸 JSON Schema 直接当 `output` 传 —— 既没有 `schema` 包装层，也没有 `render`。
- `lib/hub/advanced-tools.js` 的 `remote_file` / `remote_screenshot` 只写了
  `output: { schema: {...} }` —— 缺 `render`。

`remote_write` 是第一个被注册到的，所以报错停在它身上；**任何一个**不合法都会让
**整个插件条目不激活**。

#### 为什么单测没抓到

测试里的 `ctx.tools.register` 是假实现（`definitions.set(def.name, def)`），只存
map 不做校验。真实的注册期校验在测试里从未被执行过。

#### 修法

- `lib/hub/tools.js` 新增导出 `withOutputContract(definition)`：把声明补齐成
  `output: { schema, render }`。三种历史写法都兼容（已带 `render` 的保留、
  只有 `schema` 的补 `render`、裸 JSON Schema 的包一层），且对
  `undefined` / `null` / 非对象声明也不抛。
- 两个注册入口（`registerRemoteTools` 的 `reg`、`registerAdvancedTools` 的 `reg`）
  统一先过 `withOutputContract`，收口在一处。
- 新增 `test/output-contract.test.js`（4 条）：**复刻 Host 的真实校验条件**，
  对两个入口注册出的每一个工具逐一断言，并单测 `withOutputContract` 的三种
  补齐路径与默认 render 的兜底行为（含循环引用）。

### 测试

```
tests       1090（1087 pass / 0 fail / 3 skip）
新增        output-contract 4
漂移检查    134/134
```

## [0.10.0] - 2026-11-02

### 全面能力升级：自检、双向文件、桌面截图、后台管理

参考 `@hope_phenom/dsh-plugin-remote-use` 的机制重新梳理了远程能力，但保留本项目的
核心架构：direct + relay、X25519/AES-GCM E2E、worker 是任务状态权威、断连续跑、
manifest-before-bytes、只有显式请求才传成品。**没有把 ACP 明文任务流或每次连接
新建 DSH 子进程带进现有链路。**

#### 新增

- **真实自检与派单前 fresh gate**：`remote_selfcheck` 返回结构化 `checks[]` /
  `verdict` / `blockingFailures`；真实写读删每个 root，GUI 用途实际截图。
  新节点在 `remote_task` / subagent 创建任务前默认重新检查，失败即不派单；
  `precheck: false` 可显式跳过。
- **后台管理**：`remote_agents` 提供 `list` / `status` / `wait`，直接复用同一任务
  注册表和 handoff；`remote_interrupt` 是取消语义别名。
- **双向大文件**：`remote_file` 提供 `stat` / `send` / `fetch`，单文件 512MiB、
  256KiB 分块、offset 重对齐、完整 SHA256、`.part` 与原子 commit。worker 仍受
  roots/denyPaths/realpath 约束；上传必须 `confirm: "yes"`，下载默认不覆盖。
- **桌面截图**：`remote_screenshot` 在 Windows worker 捕获完整虚拟桌面，PNG 字节
  经既有 E2E 通道分块返回；有大小、数量、TTL 上限，校验后才原子落盘。
- **可选会话门禁**：`sessionGate: true` 时，每个会话须由用户执行
  `/remote-agent on`（别名 `/remote-use on`）才能调用 `remote_*`；`off` 撤销，
  `status` 查询。按 session id 隔离、内存保存、重启失效、缺 session fail closed。
  默认 `false`，旧配置行为不变。

#### 安全与边界

- 新文件和截图能力复用既有 FS RPC，不增加旁路 HTTP，不向 relay 暴露明文。
- 自检的 GUI 项只约束 GUI 用途，不阻塞 headless `agent` / `exec`。
- 高级工具在 execute 入口再次检查 session gate；即使 Host 没有全局 guard 也不会绕过。
- 文件 hash 或长度不一致时不 promote；截图读取后主动 release，并有定期清理。

#### 测试

```
tests       1086（1083 pass / 0 fail / 3 skip）
新增        advanced-tools 10、precheck-gate 3、file-transfer-service 17、
            selfcheck-service 6、desktop-service 4、session-gate 5
契约更新    24 工具、worker caps、subagent mock 兼容、工具输出净化
漂移检查    134/134（14c 改为逐站点校验：每个 handoff 出口都必须走投影）
```

## [0.9.11] - 2026-10-21

### 🔴 修复：agent 任务"假成功"（真实使用中发现的严重 bug）

**这是用户第一次真实派发任务时立刻暴露的问题。**

现场（2026-10-21，用户实测）：

```
状态: completed          ← 显示成功
结果摘要: [agent 错误] {"turn":1,"step":1,"error":{"message":
         "DeepSeek Messages transport failed.","code":"TRANSPORT"}}
成品: 0 项
```

**一次 agent 完全失败的任务被标记成 `completed`。**

#### 根因

DSH 的 `kick()` 是 `try { while (await this.turn()) } catch (_error) {}`
—— **turn 内的错误被完全吞掉**，只通过 `agent/error` 事件暴露。

我们**已经**监听了那个事件（之前修过一次"消息 source 类型非法"的 bug），
但只做了一件事：把错误文案推进 `liveText`（所以它出现在摘要里）。
`ok` 的判定是：

```js
ok: !timedOut && !aborted     // ← 完全没看这个错误
```

#### 为什么这比直接报错更糟

报错至少知道要重试；**"假成功"会让人以为事情做完了** —— 用户可能就这样
交付了一个什么都没生成的任务。

#### 修法

1. `agent/error` 里置 `hadError = true` + 记 `firstError`
2. `ok` 必须包含 `&& !hadError`
3. `stderr` 带上第一个错误 → engine 会把它写进 `task/end` 的 error 字段，
   任务详情里就能看到原因（而不只是一句 completed）
4. `exitCode` 在报错时为 1（不是 0）

#### 测试

`test/agent-false-success.test.js` **5 条**，用源码断言锁住这条链：

- `agent/error` 必须置 `hadError`（不能只记文案）
- `ok` 必须排除 `hadError`
- 失败时 `exitCode` / `stderr` 必须反映错误
- engine 的映射链完整（`result.ok ? COMPLETED : FAILED`）
- `timedOut` / `aborted` 的原有语义没被破坏（#26-5 不回退）

> **这个 bug 证明了什么**：61 个测试文件、1032 条断言全绿，但用户第一次
> 真实使用就撞上了。因为所有测试都是 mock —— `agent/error` 的监听被
> 静态断言"存在"，却没断言"它会影响 ok"。
>
> 静态断言能钉住"接线在"，钉不住"接线**对**"。

### 顺带

- `test/agent-cancel-abort.test.js` 里断言 `exitCode` 完整表达式的地方
  放宽为"timedOut/aborted 优先落 null" —— 表达式加了 hadError 分支，
  死锁整行文本会让每次正常演进都失败。

```
packaging   4 项
doc-drift   132/132
diag:inject 11 项
tests       1037（1035 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.10] - 2026-10-20

### 文档：README 补齐四项能力的介绍

用户反馈（第 2 次）：「readme 好像没有功能相关的介绍」。0.9.8 加了四项能力，
但 README 只更新了工具数量 —— **没有任何功能介绍**。

### 新增三节

| 小节 | 内容 |
|---|---|
| **七、一键修复** | 两步流程（预览/确认）+ 6 条护栏表（只改托管块 / 备份 / 写后校验 / 回滚 / 撤销 / 绝不用 0.0.0.0）|
| **八、外部工具检测** | 四个工具「缺了会怎样」表 + **为什么不代下载**的边界说明 |
| **九、文件写入与进程诊断** | 写操作 5 条护栏表 + `remote_kill` 三道护栏（含拒绝时的具体提示语）|

### 更新已有章节

- **五、出问题能自己诊断**：补「一键修复」「错误翻译成人话」「连接失败可见」
  「外部工具检测」四行；「面板运行中分组」补上"最近一步在干什么"
- **用法 / 读副机上的文件**：原写"只读，**没有任何写操作**" —— 这句在 0.9.8
  之后已经不准确，改成"**这一组**是只读的"，并新增两小节：
  - 「改副机上的文件（写操作，需确认）」—— 含 `resolveWritable` 的
    设计理由（为什么不能复用只读的 `resolveAny`）
  - 「排查副机上的进程与端口」—— 含三个典型用法示例 + kill 三道护栏表
- **安全**：从 3 条扩到 6 条（写操作、kill、SMB），并新增一张
  **「本插件主动放宽边界的三处」** 表 —— 把所有放宽集中列在一处，别处没有
- **结构**：补 5 个新模块（`auto-fix` / `explain-error` / `external-tools` /
  `listen-server` / `instance-config`）

### 写文档时的一条原则

不只写"有什么功能"，还写**"为什么这么做"**：

- 一键修复为什么是两步 → 因为改的是 DSH 自己的配置，我们踩过事故
- 外部工具为什么不代下载 → 因为会变成软件分发方，供应链责任全落在我们头上
- 写操作为什么不递归删 → 因为不可逆损失太大
- kill 为什么拒杀父进程 → 因为副机失联后你彻底失去远程修复能力

### 新增断言

doc-drift **96**：README 必须有七/八/九三节标题 + 「主动放宽边界」+
「为什么不代下载」+「三道护栏」。这样以后加功能忘了写文档会立刻失败。

> 写断言时踩了个小坑：变量名用了 `readme`，与模块顶部的 `readme` 同名，
> 被 eslint 的 `no-shadow` 拦下。改名 `rootReadme3`。

```
packaging   4 项
doc-drift   132/132
diag:inject 11 项
tests       1032（1030 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.9] - 2026-10-20

> **0.9.8 的 CI 回归修复。** 本地全绿，但 macOS 与 Windows 上失败。

### 修复：测试断言直接比绝对路径（realpath 与平台表示差异）

**现象**（CI run `39389528713`，macOS + Windows 失败，Linux 通过）：

    macOS:   actual '/private/var/folders/.../b.txt'
             expected '/var/folders/.../b.txt'

    Windows: actual 'C:\Users\runneradmin\AppData\Local\Temp\...\b.txt'
             expected 'C:\Users\RUNNER~1\AppData\Local\Temp\...\b.txt'

**根因**：`fs-service` 的写操作返回 **realpath 后**的路径 —— 这是**刻意的正确行为**
（realpath 才能识破软链逃逸与 8.3 短名）。但测试用 `path.join(root, ...)`
直接比字符串：

- **macOS**：`/var` 是 `/private/var` 的软链
- **Windows CI**：`RUNNER~1` 是 `runneradmin` 的 8.3 短名

两者都让"直接比字符串"失败。**Linux 恰好没有这层间接，所以本地和 ubuntu 都过。**

**修法**：这条用例真正要验证的是"移动成功且内容对"，不是"路径字符串相等"。
改成比 `basename` + 文件内容：

```js
assert.equal(path.basename(r.to), 'b.txt')
assert.equal(fs.readFileSync(b, 'utf8'), 'A')
```

### 0.9.8 的四项能力（本版包含）

| 能力 | 关键护栏 |
|---|---|
| **一键修复** | 只改托管块 / 写前备份 / 写后校验 / 二次确认 / 可撤销 / 绝不用 0.0.0.0 |
| **外部工具检测** | 只探测 + 给命令，**不代下载**（守供应链边界）|
| **写操作 ×4** | confirm 必填 / 默认不覆盖 / 不递归删 / 原子写 / 8MB 上限 / roots 护栏 |
| **进程诊断 ×3** | kill 三道护栏：confirm / 拒杀自身与父进程 / 拒杀系统关键进程 |
| **UI 折叠** | 首屏只留当下需要的；配置/体检/共享收进 `<details>` |

```
packaging   4 项
doc-drift   131/131
diag:inject 11 项
tests       1032（1030 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.8] - 2026-10-20

### 四项能力（用户要求：一键修复 / 自动装依赖 / 更多工具 / 重写 UI）

这四项**全都在放宽边界**，所以每一道护栏都不是"最佳实践"，而是**踩过的坑**。

#### ① 一键修复配置（会改 DSH 的 cordis.patch.yml）

用户此前明确说过「不要改 DSH」，而这个功能恰恰要改它。所以做成**两步流程**：

    [预览修复] → 只读，列出"将要改什么" + "不会做什么"
    [确认修复] → 才写盘（必须带 confirm: "yes"）

护栏：
- **只改托管块**（`# --- dsh-remote-agent (managed) ---` 之间），用户手写的
  其它条目一个字节不碰
- **写前必备份**（`.bak-<时间戳>`）
- **写后必校验**：重新解析，确认条目在、无重复 id
- **失败必回滚**，并给「撤销」按钮（`action: 'undo'`）
- **绝不用 0.0.0.0**（新版 DSH 硬拒绝，会让它启动崩溃 —— 我们踩过 10 份 crash 日志）

**只修机械可判定的项**（webserver host / role）。端口占用、防火墙、装软件、
模型凭证这些需要人判断的，只给建议不动手。

#### ② 外部工具检测（**不代下载**）

用户原话是"自动装依赖"，我们把范围收窄到**外部工具**，且**不代下载**：

- 零 npm 依赖是核心卖点 —— 代装 npm 包会自毁卖点
- 代下载第三方二进制会让我们变成软件分发方（版本/来源/校验/责任/
  供应链攻击面全落在我们头上）

所以只做三件事：**探测**（Tailscale / PowerShell / git / Node.js）、
**说清缺了会怎样**、**给官方链接 + 安装命令**（用户自己复制执行）。

实测在本机探测到：Tailscale 1.102.4 / PowerShell 5 / git 2.54.0 / Node v24.18.0。

#### ③ 更多工具：文件写操作（4 个）+ 进程诊断（3 个）

工具数 12 → **19**。

**写操作**（`remote_write` / `remote_mkdir` / `remote_move` / `remote_delete`）：

- **必须传 `confirm: "yes"`**（不可逆操作，AI 会"顺手"多调一次工具）
- **默认不覆盖**已有文件 —— 防手滑清空
- **不递归删除**：非空目录一律拒绝（递归删除太容易造成不可逆损失）
- **原子写**（临时文件 + rename），失败不留半截文件
- 单次写入上限 8MB（防一次写爆磁盘）
- roots 护栏：新增 `resolveWritable`，允许目标不存在但对**已存在的祖先**
  做 realpath 校验（防软链逃逸）

**进程诊断**（`remote_ps` / `remote_port` / `remote_kill`）：

- `ps` / `port` **只读**
- `kill` 有三道护栏：
  1. 必须 `confirm: "yes"`
  2. **拒绝杀本进程与父进程** —— 否则副机失联，用户彻底失去远程修复能力
  3. **拒绝杀系统关键进程**（System/csrss/wininit/services/lsass 等）

实测端口查询准确识别出 19387 的监听 PID。

#### ④ UI 改进：折叠区块（信息密度）

加了一键修复 / 外部工具 / SMB 共享之后，面板区块到了 **9 个**，首屏被淹没。

改用原生 `<details>` 折叠（零 JS 状态、可访问性好、无 hydration 问题）：

- 首屏只留：错误横幅 + 状态卡 + 节点 + 任务 + 派发表单
- 「接入与配置」「环境体检与工具」「工作区共享」收进折叠块
- **默认展开策略**：没副机在线 → 展开「接入」；体检有失败项 → 展开「体检」

### 踩坑记录（都写进了代码注释）

**① `resolveAny` 要求路径已存在 → `remote_write` 100% 失败**
只读工具用 `realpathSync` 是对的（"读不存在的文件没有借口"），但写操作的
目标**本来就是要新建的**。第一版直接复用，实测立刻暴露
`path not found: .../a.txt`。修法：新增 `resolveWritable` —— 目标不存在时
向上找第一个存在的祖先做 realpath，再校验 roots。

**② 多行 PowerShell 脚本 `join(' ')` 缺分号**
`$ErrorActionPreference="Stop" Get-Process ...` 被拼成一行，PowerShell 报
`UnexpectedToken`。修法：用 `;` 分隔语句。

**③ `process-service.js` 忘了导出 `createProcessService`**
6 个测试文件全部加载失败（`does not provide an export named`）。

**④ 测试锚点被新代码干扰**
`indexOf('confirm-required')` 找到的第一处不再是被测的那条（一键修复也用
同一个错误码）。修法：锚更具体的上下文。

### 测试

`test/capabilities-2026-10-20.test.js` **23 条**，重点不在"功能能用"而在
"护栏挡得住"：

- 写操作：默认不覆盖 / 越界拒绝 / 目标不存在也能写 / 超限拒绝 /
  非空目录拒绝 / 原子性无残留
- kill：无 confirm 拒绝 / 拒杀自己 / 拒杀父进程 / 非法 pid 拒绝
- 一键修复：只标机械可修项 / 绝不 0.0.0.0 / plan 是只读的 /
  备份名必须符合命名空间
- 外部工具：结构完整 / **不得代执行安装命令**（反例断言）/ 清单与探测同源

doc-drift 新增 91（一键修复护栏）、92（写操作护栏）、93（kill 三道护栏）、
94（不代下载）、95（折叠 UI）。

```
packaging   4 项
doc-drift   131/131
diag:inject 11 项
tests       1032（1030 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.7] - 2026-10-20

> **0.9.6 的 CI 回归修复。** 0.9.6 在本地全绿，但 GitHub Actions 的
> `ubuntu-latest / node 24.x` 上 E2E 握手全部超时。

### 修复：X25519 私钥重建改用 DER，不再依赖 JWK 的 `x` 校验

**现象**（CI run `39384173448`，只有 ubuntu/node24 失败）：

    Error: timeout waiting for e2e session on test-worker
    code: 'ERR_CRYPTO_INVALID_JWK'

**根因**：`lib/e2e.js` 用 JWK 重建私钥：

```js
createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64, x: '' }, format: 'jwk' })
```

本地 Node 24.18 接受 `x: ''`，但 CI 那个 Node 24 小版本**不接受**
（空串不是合法 base64url；省略 `x` 同样被拒）。

**这个 bug 为什么藏了这么久**：失败表现为
`timeout waiting for e2e session` —— **真因（ERR_CRYPTO_INVALID_JWK）被
完全掩盖**，看起来像时序抖动，而本地又复现不了。

**修法**：直接用 DER 构造 —— X25519 私钥的 PKCS#8 就是
固定 16 字节前缀 + 32 字节标量。这条路径**不经过 JWK 校验**，跨 Node
小版本稳定。

实测验证：DER 构造出的私钥导出的公钥 `x` 与原始 JWK 完全一致，
DH 协商结果与正常生成的密钥对一致。

**测试**：`test/e2e.test.js` 新增 2 条 ——
双方派生会话密钥必须一致（E2E 握手的核心数学）、非法长度必须明确抛错。

### 0.9.6 的五项体验提升（本版包含）

- **④ 统一错误翻译层** —— errno + 17 个协议码 + HTTP + 文案特征，每条带"下一步"
- **① 副机连接状态可见** —— 记录每次连接尝试，空态显示原因与修法
- **② 一键复制修法** —— 体检项旁的「复制修法」按钮（只复制，不代改文件）
- **③ 首次使用向导** —— 编号步骤 + 每步"应该看到什么"
- **⑤ 任务进度摘要** —— 任务行直接显示"最近：调用工具 Write · 共 23 步"

```
packaging   4 项
doc-drift   126/126
diag:inject 11 项
tests       1009（1007 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.6] - 2026-10-20

### 用户体验：五项提升（"出了问题不知道原因"的正面回应）

用户实测反馈的核心痛点不是功能不够，而是**看不到系统在做什么**。
下面五项都指向同一件事：**让每一步的状态可见、每个错误可行动**。

#### ④ 统一错误翻译层（`lib/explain-error.js`）

此前原始错误直接抛给用户：

    connect ECONNREFUSED 100.86.48.54:19387
    handshake timeout: no welcome/accepted within 15000ms
    task t-xxx terminal: timeout after 40000ms
    HTTP 401 {"error":"unauthorized"}

项目里原本有一份 `friendlyConnectError`（`lib/setup.js`），但只覆盖 5 类
网络错误、且没用到协议错误码。现在统一到一处，覆盖：

- **errno**（ECONNREFUSED / ETIMEDOUT / EADDRINUSE / EADDRNOTAVAIL / …）
- **协议错误码**（17 个，全部有专门翻译）
- **HTTP 状态**（401/403/404/405/409/500/502/503/504）
- **文案特征**（`timeout after Nms` → 换算成秒、`handshake timeout` → 版本差异）

**每条都给"下一步做什么"**，并保留原始信息（`raw`）供排查。

设计约束：**绝不抛**、**不猜**（拿不准的如实说"未知，请附原始错误"）。

#### ① 副机连接状态可见

**此前**：副机连不上时主机只显示「0 在线」，**没有任何原因**。
用户为此排查了两天（重启回引导页、19387 不监听、SMB 密码…）。

**现在**：注册表记录**每一次连接尝试**（成功/失败 + 原因 + 时间 + 远端地址，
环形上限 50 条）。面板节点区空态渲染：

    ✗ newland 连接失败                        2 分钟前
      100.72.146.73:19387 连不上（超时）
      → 检查：① 两台机器能否互 ping；② 主机防火墙；③ 是否同一局域网
      原始：connect ETIMEDOUT

并区分三种情形（**排查方向完全不同**）：

- 有失败记录 → 显示原因与修法
- 从没尝试过 → "副机还没开始连"
- 连过但现在不在线 → "副机 DSH 可能没在跑"

#### ② 一键复制修法

体检项旁边加「复制修法」按钮。修法里常含可直接粘贴的 YAML/命令，
让用户手抄是纯粹的摩擦。

**只做复制，不做"一键修复"** —— 后者会改用户文件，风险 > 收益
（我们刚因为改 DSH 文件出过事故）。

#### ③ 首次使用向导

配置完成后的"下一步"从一句话变成**编号步骤 + 每步"你应该看到什么"**：

    1  重启 DSH          必须
       关掉 DSH 窗口再打开。配置只在启动时读取。
    2  生成配对码
       重启后这个面板会出现「副机接入」按钮 —— 点它，复制那行 dshra1://
    3  在副机上粘贴
       副机也装本插件 → 打开面板 → 粘贴 → 保存 → 重启副机 DSH
    4  等它连上
       「在线节点」会从 0 变成 1。若一直是 0，看「节点」区的失败原因。

角色选择页也加了一句判断提示：

    通常：你现在用的这台（你在这里操作 DSH 的）= 主机；
          另一台要被派活的电脑 = 副机。

#### ⑤ 任务进度摘要

长任务（agent 跑 10 分钟）原来只有展开详情才能看到「进行步骤」。
现在**任务行下方**直接显示：

    运行中 · 已跑 6m12s
      最近：调用工具 Write · 共 23 步

只对运行中的任务显示（已完成看结果摘要更有用），只取最后一条有内容的步骤。

### 顺带修复

- `lib/node/index.js` 的 `friendlyConnectError` import 已无用（被 explain-error
  替代），删除
- `explainError` 的取值路径逐层 try —— `String(err)` 在 `toString` 抛错时
  会崩，而翻译层的职责是"绝不抛"（测试抓到的真 bug）

### 测试

- `test/explain-error.test.js` **20 条**：errno / 协议码全覆盖（断言 17 个
  ERROR_CODE 都有专门翻译，不能落到兜底）/ HTTP / 文案特征 / 健壮性
  （含 `toString` 抛错的恶意对象）/ 渲染
- doc-drift 新增 88（翻译层覆盖面）、89（连接历史链路）、90（复制按钮 +
  编号步骤 + 进度摘要）

**写测试时又踩了一次"断言自己的问题"**：健壮性用例的消息里写了
`String(v)`，而那个用例的 `toString` 是故意抛错的 → 断言在构造消息时
自己先崩，误报成"实现抛错"。改用下标标识用例。

```
packaging   4 项
doc-drift   126/126
diag:inject 11 项
tests       1007（1005 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.5] - 2026-10-20

> **紧急修复：0.9.4 装上后 DSH 报激活失败，插件显示"异常"。**
>
> ```
> webserver: duplicate upgrade route "/api/remote-agent/node"
> 1 entry did not activate remote-agent (dsh-remote-agent)
> ```
>
> 0.9.4 在**全新启动**的场景是好的（我验证过单次 apply 注册一次），
> 但**热重载会撞车** —— 而 DSH 在插件安装/升级后正是靠热重载生效的。

### 🔴 根因：我们的注册不可回收，而宿主不会帮我们回收

`webServer.registerUpgrade(path)` 在 DSH 里是**按 path 查表**的，同路径第二次
注册直接抛（组合级契约，它这么做是对的）：

```js
registerUpgrade(route) {
  if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
  this.upgrades.set(route.path, route)
  return () => { this.upgrades.delete(route.path) }
}
```

而本插件的注册全部收集在 `__disposers` 里，通过 `applyHub()` 的返回值
（`disposeAll`）交给调用方保管 —— **但 DSH 不认识这个返回值**。热重载时它只
重新 `apply`，不会回头调我们的 disposer。于是第二代的注册压在第一代的残留上：

```
第一代 apply → 注册 /api/remote-agent/node（表里有了）
DSH 热重载 → 直接再 apply（不 dispose）
第二代 apply → registerUpgrade(同一 path) → throw → 整个 entry 激活失败
```

0.9.3 及以前没暴露，是因为那时改完配置都靠"重启 DSH"（进程重来，表是新的）；
0.9.4 是在插件管理页里安装/升级，走了热重载路径 —— 这是**场景差异，不是新引入的代码**。

### 修复

1. **apply 变成可重入**（`lib/index.js`）：按**注册宿主**（`ctx.webServer` 服务
   实例，读不到时退回 ctx）记住"当前这一代"的 dispose；重新 apply 时先自己把
   上一代摘干净再装。**不指望宿主帮我们清理** —— 这是唯一在各种宿主行为下都
   成立的修法。
2. **`disposeAll` 改成逆序**（`lib/hub/index.js`）：此前是正序跑的，会先拆运行时
   （`registry.dispose()`）再拆工具，工具的 disposer 可能碰到已销毁的 registry。
   现在与 cordis 的"逆序释放"语义一致。
3. **独立监听加了 EADDRINUSE 有限重试**：重入时先 `close()` 旧监听、立刻用同一
   端口重新 `listen`，在 Windows 上经常还拿不到端口（close 是异步的）。重试
   4 次（200/400/600ms 退避），真被别的进程占用仍会如实报错。
4. **`handles.dispose`**：apply 的返回值现在带一个顶层 `dispose()`，任何愿意调
   它的宿主都能正确清理。

### 为什么 CI 没拦住（第三次同类）

仓库里所有测试桩都**比宿主宽松**：`hub-worker-e2e.test.js` 的 `makeCtx()` 里
`register()` 是 `table.set()`（同名静默覆盖）、`registerUpgrade()` 只是再挂一个
`server.on('upgrade')`。真宿主会抛，桩不会 —— **桩比宿主宽松 = 假绿灯**。

新增 `test/webserver-contract.test.js`：照宿主源码造一个**重复即抛**的严格 ctx，
钉住四条契约：

- 单次 apply 只注册一条 upgrade 路由
- **同一 ctx 重复 apply 不抛**（就是本次的事故回归）
- apply → dispose → apply 可反复进行，且旧世代的 dispose 不得影响新世代
- 重入后**独立监听仍能绑回同一端口**（热重载不能把端点变成永久不可用）

### 升级须知

- 装完请在插件页把开关**关一次再打开**（或重启 DSH），让热重载重新加载新代码。
- 如果你之前点了「生成口令」，副机要用新口令重新配对。

```
packaging   4 项
doc-drift   123/123
diag:inject 11 项
tests       987（985 pass / 0 fail / 2 skip）
lint        干净
```

## [0.9.4] - 2026-10-20

> **0.9.3 审查的 19 项全部修完。** 0.9.3 把架构换对了（插件自己开 19387），
> 但落地时几乎每一项都只改了"多条路径中的一条" —— 每个新机制都带着一个
> 旧假设。本版逐条补齐。
>
> **0.9.3 有两个 Critical，请直接升级到 0.9.4**：
> 配对码端口取的是 DSH webserver 的端口（复制的码 100% 连不上）；
> `nodeToken` 为空时独立监听成了 tailnet 内的无鉴权接入点。
>
> 架构（独立监听 / 配置分层 / 绑址优先链）见 0.9.3 条目，本版不改它。

### 本版修掉的 19 个问题（0.9.3 审查）

**Critical**

- **C1 配对码端口是错的** —— 前端把浏览器地址栏端口（DSH webserver 的
  58626 之类）拼进配对码，而节点端点在 19387 → **复制的码 100% 连不上**。
  现在 `/pair-info` 从 `listenRuntime` 取**实际绑定端口**，响应带 `portSource`
  （`listen-server` / `fallback`），每个候选地址标 `usable`，可用项排最前。
- **C2 配对码的地址顺序与绑定顺序相反** —— `detectLanIps()` 自己实现了一套
  分类（私网优先），而 `resolveListenHost()` 是 Tailscale 优先 → 首选地址
  根本不是监听地址。现在 `detectLanIps()` 复用 `listCandidateAddresses()`，
  判据只有一份。

**High**

- **H1 `nodeToken` 为空时端点暴露到网络** —— 现在 token 为空且没显式指定可达
  `listenHost` 时**强制绑 `127.0.0.1`**，面板给黄色提示引导去「生成口令」。
- **H2 setup 表单只管 6 个字段，写盘却整块重写** —— 用户在 YAML 里手写的
  `uiPullRoot` / `listenHost` 等被静默抹掉。新增 `extractPreservedConfig`
  文本级切分，**只覆盖表单管辖的键**（`role/nodeId/transportMode/hubUrl/
  relayUrl/roots`），其余原样保留。
- **H3 面板没有生成口令的入口** —— token 为空时只能看到"绑回环"却无路可修。
  新增 `POST /setup/rotate-token`（**仅接受回环请求**），面板加「生成口令」
  按钮（带二次确认），明文只回一次。
- **H4 CI 连红两次还发了 npm** —— `test/doc-drift-selfcheck.test.js` 的手工
  复制清单漏了 `lib/listen-server.js`，副本里 `read()` 抛 ENOENT → **20 个
  自检用例全挂**（不是单条断言失败）。这是同一规矩**第六次**被踩。
  结构性修复：改成**自动扫 `lib/*.js` 全量复制**，手工清单只管目录与非 js 目标。
- **H5 架构换了，诊断层没换** —— reachability 快照、`/env-check`、面板横幅、
  README 全停留在 `webserver` 语义 → **面板报假红**（独立监听 19387 明明在跑）
  并教用户做无效操作（改 webserver host，改了也会被冲掉）。现在：
  `reachability` 变**两层结构 + getter**（运行时绑定后动态求值），
  新增 `listener` 四态（未就绪 / 就绪 / 已关闭 / 失败），横幅三态
  （正常不显示 / 绑回环黄条 / 启动失败红条），README 安装段重写。

**Medium**

- **M1 `writeInstanceConfig(values)` 没传 `config`** —— 写默认 stateDir，而读
  的一方按 `config.stateDir` 找，两边对不上。补上第二个参数。
- **M2 `listenHost` / `listenPort` / `relay` 不在持久化白名单** —— 写进
  instance.json 会被静默丢弃。`PERSISTED_KEYS` 补齐，`relay` 按对象白名单
  （`url` / `token`）处理；schema 也补上 `listenHost` / `listenPort` 声明
  （此前靠 schemastery passthrough 生效，**无表单、无校验**）。
- **M3 instance.json 静默覆盖 patch 值** —— 现在 `mergeInstanceConfig` 返回
  `shadowed: string[]`，`apply()` 里 `log('info', …)` 明示谁覆盖了谁；
  `--doctor` 也会报告"instance.json 覆盖了 patch 的：…"。
- **M4 配对码端口取错** —— 用的是浏览器地址栏的端口（DSH 的 webserver 端口，
  常见 58626），而副机该拨的是 19387。现在从 `listenRuntime` 取**实际绑定端口**，
  响应带 `portSource`，并给每个候选地址标 `usable`（只有与本机绑定地址一致的
  才算可用，可用项排最前）。
- **M5 CLI 写盘路径不写 instance.json** —— 向导/`--apply` 写完 patch 后，
  重启 DSH 又会被重写。`offerWrite` / `applyWrite` 增加 `persist` 参数，
  成功后同步写独立配置。

**Low / Info**

- **L1 `server.on('error')` 在 listen 成功后无声吞错** —— 加 `settled` 闸门：
  首次 reject，之后转 `log('error', 'listen server error (runtime)')`。
- **L2 回环判据三份实现**（listen-server / env-check / 面板各写一份）——
  统一导出 `isLoopbackHost()`，其余全部 import。
- **L3 `explicitPort` 判断看的是归一化后的值** —— 改成看**原始 config 是否
  有该键**（否则"没填"和"填了默认值"无法区分）。
- **L6 候选地址顺序随网卡枚举变化** —— `listCandidateAddresses()` 按
  `score`（Tailscale=0 / 私网=1 / 其它=2）+ 接口名 + 地址稳定排序，
  避免同一台机器两次启动绑到不同 IP。

### 断言与门禁

- **85 改向**：要求 CLI `--doctor` 用 `listen-server` 的回环判据，
  并**负向守卫**——不得再从 patch 里找 `- id: webserver` 判可达性
  （扫剥注释后的代码，注释里的历史留档不算违规）。
- **79b 加固**：三处面向用户的文案必须同时满足"不建议 `0.0.0.0`"与
  "包含不能用 `0.0.0.0` 的警告"。
- 自检不再依赖 import 的**排版**（`writePatchBlock` 的断言改为匹配符号
  而非单行字面量）—— 断言的是依赖关系，不是格式。

```
packaging   4 项
doc-drift   123/123
diag:inject 11 项
tests       982（980 pass / 0 fail / 2 skip）
lint        干净（eslint 严格档，含 bin/ 与 test/）
```

### 升级须知

- **不用再给 `webserver` 填 host**。之前填过的可以删掉（留着也无害，DSH 会
  自己重写掉）。
- 想固定绑哪个地址：`listenHost: '100.x.x.x'`；端口冲突就换 `listenPort`。
- 防火墙要放行的是 **`listenPort`（默认 19387）**，不再是 DSH 的 Web 端口。
- **面板里点过一次「生成口令」的，副机要用新口令重新配对**（旧口令已换掉）。

## [0.9.3] - 2026-10-18

> **架构级重做：插件自己开端口，副机拨入不再依赖 DSH 的 `webserver`。**
>
> ⚠ **0.9.2 那段"去 patch 里给 `webserver` 填一个具体 host"的做法从本版起
> 作废** —— 不用填了，填了也会被 DSH 每次启动重写掉。
>
> 🔴 **本版有两个 Critical，已被 0.9.4 修复，请不要停留在本版**：
> 面板生成的配对码用了 DSH webserver 的端口（粘了连不上）；
> `nodeToken` 为空时独立监听变成了 tailnet 内的无鉴权接入点。
> 另外本版发布时 **CI 是红的**（win + ubuntu 全红、本地实测 20 fail）。

### 为什么必须换架构（三个死结，均实证）

| 死结 | 现象 |
|---|---|
| **patch 被重写** | DSH 每次启动都重写 `cordis.patch.yml`，实测 3962B / 15 条 → **661B / 3 条**，写进去的 `webserver` 段被删光 |
| **webServer 无 rebind** | `webServer` 服务激活即 `listen`，没有改绑方法，插件拿不到控制权 |
| **硬拒通配地址** | 新版 `dsh-host-webserver` 在 schema 阶段就拒绝 `0.0.0.0`，绑了就 **DSH 启动崩溃**（已产生 10 份 crash 日志） |

结论：**副机端点不能再挂在 `ctx.webServer` 上。**

### 新方案

- **`lib/listen-server.js`** —— 用 `node:http` 自己开一个只服务节点端点的小
  server：`GET <healthPath>` 回 200 JSON，`Upgrade: websocket` 复用 `ws.js`
  的 `acceptUpgrade`，**路径精确匹配**，其它一律 404；关闭时追踪并断开所有连接。
- **绑址优先链**：`listenHost` > Tailscale IP（`100.64.0.0/10`）> RFC1918 私网
  > 任意非回环 > `127.0.0.1`；**拒绝** `0.0.0.0` / `::` / `[::]`。
  默认端口 **19387**，`listenPort: 0` = 关闭独立监听。
- **`lib/instance-config.js`** —— 配置分层：patch 只负责"让 loader 加载插件"，
  真配置存 `<stateDir>/instance.json`（**0600 + 原子写 + 字段白名单**）。
  `mergeInstanceConfig` 合并时**独立配置优先**，`apply()` 里重新归一化。
- **安全边界**：token 校验仍是同一份逻辑，独立监听不降低门槛。
  （`nodeToken` 为空的处理是本版**没做到位**的地方，见 0.9.4 的 H1。）

```
packaging   4 项
doc-drift   121/121
diag:inject 11 项
tests       975（953 pass / 20 fail / 2 skip）   ← 发布时实际是红的
lint        干净
```

## [0.9.2] - 2026-10-18

> **紧急修复：0.9.0/0.9.1 会让新版 DSH 启动崩溃。**
> 如果你装了 0.9.x 并升级过 DSH（0.2.1-rc.2 及以后），**先升级到本版**。

### 🔴 严重事故：包内 patch 绑 `host: '0.0.0.0'` 导致 DSH 启动崩溃

**这是我的错。** 0.9.0 为了让"副机连得上"，在包内 patch 里加了：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 19387
```

新版 `@deepseek-ai/dsh-host-webserver` 在 **schema 校验阶段**就硬拒绝通配地址：

```
webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not
supported: binding every interface would expose remote code execution to the
network; bind one concrete IPv4 or IPv6 address of a local interface instead
```

**后果链**：

```
webserver（required）激活失败
  → webServer 服务缺失
  → 至少 6 个插件排队等它
    （web-runtime / open-in-app / directory-picker / client-hmr / remote-agent …）
  → host 启动失败
```

实测在用户机器上产生 **10 份 crash 日志**（`crash-*.log`）。

**这比它想修的"副机连不上"严重得多：连 DSH 都起不来了。**

### 修复

**包内 patch 不再碰 `webserver` 的任何字段。** 理由：

1. `host` 必须是**具体某个本机接口地址**（Tailscale IP / 局域网 IP），
   而这个值因人而异 —— 包里写死任何具体 IP 都是错的。
2. 插件在 `apply()` 里**也不能**自己读网卡再拼配置：loader 的 patch 是
   启动前静态合并的，改不了自己所在那一行的 config。
3. 实际做法：**由用户在 profile 里配一次**，插件负责**检测并说清该怎么配**。

配套修正（四处面向用户的文案，它们此前都在建议 `0.0.0.0`）：

- `lib/env-check.js` 的 reachability 修法 → 改为"具体的本机 IP"，并明确警告
  不能用 0.0.0.0，教会用户 `tailscale ip -4` / `ipconfig` 查地址
- `lib/client.js` 的红色横幅 → 同上
- `lib/hub/index.js` 的可达性自检 hint 与 log fix → 同上
- `README.md` / `README.en.md` 的安装段 → 重写，把"必须绑具体 IP"讲清楚

### 断言方向反转（79 / 新增 79b）

**原来的断言 79 是错的** —— 它要求包内 patch **绑** `0.0.0.0`。现在反过来：

- **79**：包内 patch 的**生效行**不得出现 `- id: webserver` 或
  `host: '0.0.0.0'`，且必须把事故写进注释留档
- **79b**：所有面向用户的修法文案都不得建议 `host: 0.0.0.0`，
  且必须包含"不能用 0.0.0.0"的明确警告

79 只扫**非注释行** —— 注释里必须保留事故原文（含 `0.0.0.0` 示例），
那是给后来者的警示，不该被判违规。

### 现在"副机连不上"怎么办

包内 patch 不再代你配 `webserver`，所以**新装用户要自己填一次 host**。
但这件事不再是静默失败：

- 面板加载时**自动体检**，绑 loopback 会显示红色横幅
- 「环境体检」里的 reachability 项会告诉你**当前绑在哪**、**该改成什么**
- 提示里直接教怎么查自己的 IP

**填什么**：

```yaml
- id: webserver
  config:
    host: '100.x.x.x'    # ← 换成你自己的地址（推荐 Tailscale IP）
    port: 19387
```

查地址：`tailscale ip -4`（跨网，固定不变）或 `ipconfig`（同一局域网）。

### 其他

- 新增 `scripts/diag-worker.ps1` —— 副机诊断脚本（**只读**，不改任何文件），
  输出 profile 列表、`remote-agent` 配置、插件版本、面板端点探测、
  配置备份时间线。用于排查"每次重启都回到引导页"这类问题。

```
packaging   4 项
doc-drift   121/121
diag:inject 11 项
tests       949（948 pass / 0 fail / 1 skip）
lint        干净
```

## [0.9.1] - 2026-10-17

> **0.9.0 发布约 40 分钟后补发**。两个 High 都是真实功能失效
> （体检对新装用户全面误报、SMB 共享完全不可用），趁用户数还少尽快修正。

### 修复（High）：环境体检对默认安装全面误报，且五项检查静默跳过

`/env-check` 路由传的是**原始 `config.role`**，而 0.9.0 起默认安装的生效配置
就是 `role: 'auto'`（`Config` 的 `.default('auto')` + 包内 patch 显式写入）。
`envChecks` 的判据 `isHub = role === 'hub' || role === 'both'` 拿到未解析的
`'auto'` 判 false，于是：

- **reachability / port / firewall / tailscale / nodes 五项全部跳过**
  —— 而这五项正是体检存在的理由（副机连不上的静默失败）
- `inject` 按 worker 三件套判定 → hub 正确的 inject 反被判"缺服务"
- `role` 检查误报未配置

实测（修复前）：

    role=auto → { ok:false, failed:2, items:[role(FAIL), inject(FAIL)] }

**影响放大**：9.0 的"首次自动体检"让这份"双误报 + 零诊断"在**每个新装用户
首次打开面板时自动弹出**。

修复（双保险）：

1. 路由改传 `resolveRole(config) || 'hub'`（与 `setup-routes` 同一份实现）
2. `envChecks` **自己**也解析 —— 即使调用方传错 `'auto'` 也能推断
   （判据：配置里写了 role 就以配置为准交给 `resolveRole`；没这个字段才用
   调用方给的值。两个极端写法都会误报，已由 5 个场景用例覆盖）

实测（修复后）：

    role=auto → role ✓ / inject ✓ / reachability ✗（正确报出 loopback）/ nodes ✗

### 修复（High）：SMB「生成共享命令」100% 失败

面板的 `doPlan` **恒定发送 `dir: ''`** —— 面板里根本没有选择目录的 UI，
而副机侧 `if (dir === '') reply ok:false 'plan 需要 dir'` 按设计拒绝。
于是工作区共享的**唯一主动作完全不可用**（probe 与后端 RPC 正常，API 直调可绕）。

修复：

- 加目录选择 UI，数据源是 `node.roots`（`nodeView` 一直透出它，那是副机的
  安全边界、也正是该共享的目录），默认第一项
- 无 `roots` 时退回可手填的输入框 + 说明原因
- 换副机时重置候选与 plan/probe 结果（否则会显示别人的共享命令）
- `dir` 为空时禁用按钮（不给用户"点了才失败"）

### 修复（Medium）：CLI `--doctor` 与面板体检是两套并行实现

三处注释曾声称"命令行与面板共用 `lib/env-check.js` 的同一份逻辑" —— 那是失真的：
CLI 走 `setup.js` 的 `doctorChecks`（14 项静态），面板走 `envChecks`（8 项运行时态），
**检查项不相交**。CLI 有 Node 版本 / hubUrl / token 但**没有 loopback 诊断**
（本版本最重要的那条），面板有 reachability 但没有前者。

修复：两段都跑、结果合并。顺带修掉 CLI 把 role 写死成 `'hub'` 的同类 bug
（`grab('role') || 'hub'` 会让 auto-worker 被当 hub 体检）→ 改用 `resolveRole`。

实测新增输出：`✓ Web 服务绑在可达地址 —— 当前监听 http://0.0.0.0:19387`

### 修复（Medium）：模型下拉的「自定义…」永远展不开文本框

原实现靠 `fv.model === '__custom__'` 判定，但表单里存的是**真实模型名**或空串，
从来不是字面量 `'__custom__'`：

- 从"跟随默认"（model=''）选自定义 → 旧值仍为 '' → `isCustom=false` → 弹回
- 从任一有效选项选自定义 → 旧模型名被保留 → `isCustom=false` → 同样弹回

唯一能进 `isCustom` 的路径是"表单预填了清单外模型名"（先有鸡）。

修复：加独立布尔 state `modelCustom`，`isCustom = modelCustom || (model 非空
且不在清单里)`。

### 修复（Low ×5）

- **templates.js 注释残留旧重试参数**（~​1.3s / 封顶 200ms）与常量
  （16 次 / 500ms / ~6s）不符 → 改为引用常量名 + 指向事故史。
  **这条最容易埋雷**：后来者可能照注释把窗口"修"回去。
- **`net share` 文本解析对含空格路径截断**（`D:\Deepseek Harness file`
  → `D:\Deepseek`）→ 改用 `Get-SmbShare | ConvertTo-Json` 取结构化路径，
  `net share` 仅作回退。本项目自己的目录名就带空格，这个 bug 在本机即会触发。
- **`autoFix` 承诺了不存在的能力**（全仓库无 fix 路由 / 无 `--fix` 参数，
  面板也没修复按钮）→ 语义改为"修法机械、照抄即可"，文案全部改写，
  reachability 项直接给**可粘贴的 YAML 片段**。
- **README 两处数字漂移**：状态行仍写 0.8.1、断言数写 117（实际 118）→ 修正中英两版。
- **hub ingest 无终态守卫**：晚期 `TASK_END`/`TASK_SUMMARY` 可把已置
  `FAILED(node-unreachable)` 改写回真实终态（良性但破坏"终态即终态"心智模型）
  → 加 `TERMINAL_STATUS.has(t.status)` 守卫（同终态重发幂等放行）。

### 新增：装配级测试（10 条）

`test/assembly-wiring.test.js` —— 全部锚在**接线处**而非模块内部：

两个 High 的共同点是"**单测覆盖了模块本身，没人测模块被装配进系统时的形状**"。
`envChecks({role:'hub'})` 全绿证明不了路由传对了；`buildShareCommand` 全绿
证明不了面板真的发了 `dir`。

另加 doc-drift 断言 84/85 钉住这两条接线，并做了**负向验证**
（回退修复后断言正确报 DRIFT）。

```
packaging   4 项
doc-drift   120/120
diag:inject 11 项
tests       949（948 pass / 0 fail / 1 skip）
lint        干净
```

## [0.9.0] - 2026-10-17

### ⚠ 行为变更：exec 任务默认超时 1 小时 → 10 分钟

**升级前请读这一段。**

此前 `exec` 任务实际拿到的超时是 **60 分钟**（不论文档说什么）。
原因是三处缺陷叠加（详见下方「代码审查修复」的 H1）：

1. `tools.js` 里有个 TDZ 自引用 bug，让分模式默认值那条分支永远走不到
2. `hub/index.js` 用 `numOr(defaults.timeoutMs, 1h)` 兜底，把 `explicitTimeoutMs`
   压成恒 3600000 → 优先级 `args > 显式配置 > 分模式默认` 被压扁成「恒 1h」
3. 面板 dispatch 同样写死 `?? 3600000`

三处都修了，所以现在：

| 模式 | 默认超时 | 意味着 |
|---|---|---|
| `exec` | **10 分钟**（`EXEC_DEFAULT_TIMEOUT_MS`） | 失控命令最多跑 10 分钟就被杀，不再占机一小时 |
| `agent` | 1 小时（不变） | agent 任务本来就需要长窗口 |

**如果你有 exec 任务本来就要跑 10 分钟以上**，显式传 `timeoutMs`：

- 工具：`remote_task({ ..., timeoutMs: 1800000 })`（30 分钟）
- 面板：派发表单的「超时毫秒」字段
- 配置：`defaults.timeoutMs`（作用于所有任务，优先于分模式默认）

### 修复：代码审查（1 High + 3 Medium + 6 Low）

WorkBuddy 2026-10-17 对 `lib/` 全部 26 个源文件（约 19,900 行）做全量审查，
发现的缺陷逐条核实为真后修复。

#### H1（High）tools.js TDZ 自引用

```js
const v = validateTaskStart({ constraints: {
  timeoutMs: ... ?? (v.spec.mode === 'exec' ? ... : ...)
                         ^ v 正在初始化，进入 TDZ
```

`??` 链左侧全空时抛 `ReferenceError`。

**为什么 829 个测试全绿仍带此 bug**：e2e helper 恒传 `timeoutMs`（`??` 第一项
短路）、单测构造时 defaults 也总有值 —— 该分支**从未被求值**。这是典型的
「测试环境与生产装配层差异造成的盲区」。

生产没炸但更糟：`normalizeConfig` 的 1h 兜底让 TDZ 永不触发，却把分模式
默认压成死代码（见上方行为变更）。

修复：改用已在 `v` 之前求值的 `routeMode`。

#### M1（Medium）relay 第三条 hub 写路径漏背压

C1-1 的背压修复只加在 `broadcastHubs` / `broadcastHubsBinary` 两条路径上，
**node 上行帧 → 全 hub 广播是第三条**，漏网。而 `ws.js` 的 `overBudget` 只是
查询属性、不自动断连，所以这条路径的写缓冲**没有任何上限检查**。

实测过的后果形态：单个停滞对端把 relay `writableLength` 推到 339.8 MiB、
RSS 419 MiB。中继是 NAT 场景唯一会合点、单进程常驻，OOM 即全体断连。

#### M2（Medium）grep 单文件分支无大小护栏

目录扫描路径有 `GREP_FILE_MAX`（2MB）与 `GREP_TIME_MS`（10s）双护栏，
但 `st.isFile()` 分支**直接 `readFileSync` 全文**。触发形态：`remote_grep` 的
path 指向工作区内巨大文本文件（应用日志 / 数据库转储 / core dump）→
副机 OOM + 同步阻塞事件循环。**这是一条可达的 DoS 面**（agent 自主选择 grep 目标）。

#### M3（Medium）approveTask 节点不可达时删除任务

原实现 `this.tasks.delete(taskId)` —— 任务从 hub 视图**彻底消失**（不是失败、
不是挂起，是不存在），与该方法注释自称的「转 failed 终态」**直接矛盾**。

后果：`remote_status` / 面板都查不到；`awaitTerminal` 等不到终态只能靠超时
兜底（最长 1 小时+）；与 ui-routes 的 502 文案不符。

修复：保留记录 + 置 FAILED + `error.code='node-unreachable'` + 唤醒等待者。

#### Low 系列（修 6 条）

- **L1** 副机 transport 缺 RelayLink 的两条并发不变式：
  `connecting` 闸门（`start()` 被调两次会开两条 TCP 连接）、close 必须校验
  `this.conn === conn`（否则陈旧连接的 close 把活着的新连接引用清掉 → 副机永久失联）
- **L2** RESOURCE 分支 `rec` 未判空（影子节点竞态必抛 TypeError）
- **L3** runner 的 active 注册晚于 `await createAgent`（窗口期内 cancel 返回
  false，正是 #26-5 修过的形态复现）→ 改为先占位再 await
- **L4** `E2E_REOFFER_DEBOUNCE_MS` 死常量 → 真正按 250ms 时间窗去抖
  （⚠ 它是**实例字段**不是 static，必须经 `this.` 读）
- **L5/L6/L7 未修**（记录在案）：relay 模式 hub 去重被中继层兜住、WS 版本校验
  双方恒发 13、hub 空闲淘汰被副机 15s 心跳掩盖 —— 属一致性改进而非缺陷

#### 测试

新增 `test/code-review-regressions.test.js` **11 条**，覆盖 H1/M1/M2/M3/L1/L2/L4。
**H1 的测试刻意不走 e2e helper**（那正是盲区成因）。

### 文档：README 补「功能」章节

用户指出「README 好像没有功能相关的介绍」—— 核实后发现**比这更严重**：

- **版本号落后 4 个版本**（写 0.4.0，实际 0.8.x）
- **工具数量写错**（写「7 个」，实际 **12 个**：8 个 `remote_*` + 4 个 fs 工具），
  出现在架构图、目录表、工具速查三处
- 确实没有功能总览章节

新增「功能」六组：派任务 / 拿结果 / 翻文件 / 本地 IDE 打开（SMB）/ 自我诊断 /
断连跨网安全。英文版同步。

新增断言 83：**README 声明的工具数量必须等于代码里 `reg(` + `fsOp(` 的注册数**，
两边任一变化立刻失败（做过负向验证）。

### 关于 0.8.0 与 0.8.1（记录）

0.8.0 的 publish 第一次报「假成功」（tarball 未落地），当时判断它卡在 staging
并跳过发布了 0.8.1。事后查 registry 发现 **0.8.0 最终也发布成功了**
（07:43:45，比 0.8.1 晚 3 分钟）—— 那次 `unpublish` 同样假成功。

两个版本内容基本相同（都是 #26-4/#26-5 + EPERM 修复 + #27 完整版），
不影响使用。教训：**npm publish 的成功/失败判定必须用 `Cache-Control: no-cache`
读 registry 核实**，不能只看 exit code 或缓存副本。

### 文档：README 补「功能」章节 + 修正 4 个版本号的漂移

用户指出「README 好像没有功能相关的介绍」—— 核实后发现**比这更严重**：

#### 1. 版本号落后 4 个版本

```
README L33:  | **状态** | 0.4.0 —— 主机侧端到端可用 ... |
实际:        npm latest = 0.8.1
```

#### 2. 工具数量写错（7 → 12）

README 写「7 个 remote_* 工具」，实际是 **12 个**（8 个 `remote_*` +
4 个 fs 工具）。这个数字在 3 处出现（架构图、目录表、工具速查）。

#### 3. 确实没有「功能」章节

原结构是「五分钟上手 → 核心不变式 → 安装 → 用法」——「用法」里只有工具速查，
**没有一个"这个插件能干什么"的总览**。读者只能从零散段落里拼。

#### 修复

新增「功能」章节，分六组：

1. **把任务派给副机** —— 两种模式 / 两阶段审批 / dry-run / 仓库感知 /
   负载感知 / 模型下拉 / 分模式超时 / 并发上限
2. **拿结果但不搬整个工作区** —— handoff 卡 / 三分类 / 显式拉取 /
   断点续传 / 变更 diff
3. **直接翻副机的文件** —— 四个只读工具（不进任务队列）
4. **用本地 IDE 打开副机文件** —— SMB 共享（含安全警示）
5. **出问题能自己诊断** —— 环境体检 / 可达性自检 / 队列健康 /
   运行中分组 / 取消真打断 / 审计日志
6. **断连、跨网、安全** —— 断连不终止 / 两种传输 / E2E / 主机身份 /
   凭证不出副机 / 零依赖

另修：架构图工具数、状态行（0.4.0 → 0.8.1）、测试数表、
`lib/` 目录表（补 `env-check.js`、`role: auto`）。

英文版 `README.en.md` 同步（同样的 4 处漂移 + 完整 Features 章节）。

#### 加了一条断言防复发（83）

工具数量这种「数字漂移」是最容易积累的文档债务 —— 每次加工具都忘了改
README，而读者会拿它当事实。所以新增断言：**数代码里 `reg(` + `fsOp(`
的注册调用数，与 README 里的声明比对**，两边任一变化都会立刻失败。

做了负向验证：临时把 README 的 12 改成 7，断言正确报错并给出
「实际 12 个（reg=8 + fsOp=4）vs 声明 7 个」。

```
packaging   4 项
doc-drift   118/118（+1）
diag:inject 11 项
tests       938（937 pass / 0 fail / 1 skip）
lint        干净
```

### 功能：工作区共享（SMB）—— 用本地 IDE 打开副机的文件

用户需求：想用本地 IDE 直接打开副机的项目目录。

实现方式：把副机的工作区通过 Windows SMB 共享出去，主机
`net use X: \\副机\dsh-work-...` 映射成盘符。

#### ⚠ 这是本插件**唯一主动放宽安全边界**的功能

开启后：
- `roots` / `denyPaths` 全部失效（Windows 内核直读，插件拦不住）
- 「清单先于字节」失效（中间产物、日志、`.env`、`.git` 密钥全部可见）
- 新增凭证面（主机需要副机的 Windows 账号）

所以按用户要求做了三重防护：

1. **二次确认**（硬要求）—— `POST /share` 缺 `confirm: 'yes'` 直接 400，
   没有默认通过的分支；面板上必须勾选「我知道风险」按钮才可点
2. **只读 / 读写两选项**，默认**只读**（最小权限）；读写用 `-ChangeAccess`
   而非 `-FullAccess`（后者会把共享 ACL 也交出去，主机能改权限）
3. **不代执行** —— 只生成可复制的命令，执行由用户在管理员 PowerShell 里做

#### 为什么不代执行（重要设计决策）

`New-SmbShare` 需要管理员，而 DSH 通常以普通用户运行。Node 里提权的
失败表现（静默失败 / 被安全软件拦 / 权限半生效）比让用户手动跑一条命令
难排查得多。所以 `handleShareReq` 只做三件事：`probe`（探测管理员状态
与已有共享）、`plan`（生成共享 + 映射命令）、`unshare-plan`（生成卸载命令）。

#### 实现要点

- **协议**：新增 `SHARE_REQ` / `SHARE_RES` 帧，与 `fs/req` 同款 RPC 模式
- **E2E 强制**：`SHARE_REQ` 进 `E2E_REQUIRED_TYPES` —— 帧里含工作区
  **绝对路径**（暴露副机目录结构），不许明文过中继
- **独立 pending 表**：`sharePending` 与 `fsPending` 刻意分开 —— 混用会让
  超时归因变模糊（一条 share 超时被记成 fs-timeout，排查方向直接跑偏）
- **共享名稳定哈希**：同一目录反复开关共享名不变（不留孤儿共享），固定
  `dsh-work-` 前缀便于识别与清理（不会误删用户的其它共享）
- **共享目录过 roots 边界**：`plan` 的目录必须经 `resolveWorkspace`
  （realpath + roots 前缀 + denyPaths），与 fs 工具同一条规则

#### 文档

新增 [docs/workspace-share.md](docs/workspace-share.md)：完整风险披露、
三步用法（面板开启 → 副机管理员执行 → 主机映射）、关闭方法、常见问题
（连不上怎么查、为什么共享名是怪名字、能不能共享整个盘、与 relay 的关系）。

#### 测试

- `test/share-service.test.js` **17 条**：共享名稳定性、只读/读写映射
  （含"不得用 FullAccess"）、单引号转义防注入、探测不抛、跨平台安全
- `test/share-integration.test.js` **12 条**：帧已声明、E2E 强制、
  pending 表独立、断连 fail-fast、**二次确认是硬要求**、只读默认、
  面板勾选框、不代执行、目录过 roots 边界

doc-drift 新增 81（接线完整）、82（安全约束）。

```
packaging   4 项
doc-drift   117/117
diag:inject 11 项
tests       926（925 pass / 0 fail / 1 skip）
lint        干净
```

### 开箱即用：装完就能用，不用读文档

用户标准（2026-10-17）："我希望是小白可用的，是开箱即用的"。

此前有三道门槛，每一道都能让小白卡死：

1. **`role` 默认 `''`** → 两台机器都要操作一次，不是开箱即用
2. **`webserver` 没绑 `0.0.0.0`** → 副机永远连不上，且**完全静默**
3. **副机表单 4 个字段** → 不知道节点 ID / 工作区填什么

#### 核心设计：`role` 默认 `auto`，按 `hubUrl` 推断

- 默认 `hub`：副机装完会以 hub 身份启动 —— 注册一个 nodeToken 为空、
  不校验凭证的直连端点。**这是实打实的攻击面**（v0.7.0 之前的老问题）。
- 默认 `''`：两台机器都要操作一次，不是开箱即用。
- **默认 `auto`**：没配 `hubUrl` 就是主机（零操作），配了 `hubUrl` 就是副机
  （贴完配对码零操作）。**两者都开箱即用，且不给副机开不该开的端点。**

判据只有一条，但它是副机与主机最本质的区别：`hubUrl` 是副机独有字段，
hub 侧根本不读它。配对码展开后必然产出 `hubUrl`，所以"贴码 = 自动变副机"。

推断结果带 `inferred` 标记（`no-hubUrl` / `hubUrl`），面板可显示依据。
显式写 `hub`/`worker`/`both` 永远优先于推断 —— 用户写的不该被猜掉。

#### 包内 patch 让 hub 真能被访问

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 19387
```

不覆盖这一行，hub 只监听 loopback → 副机永远连不上。这是"能不能用"的决定性一条。

**安全披露**（写进 patch 注释 + README + 面板 + 体检）：绑 `0.0.0.0` 意味着
**DSH 的整个 Web GUI 也能被局域网访问**，不只是本插件的节点端点。DSH 自带
Host/Origin 围栏 + cookie 鉴权，但暴露面确实变大了。用户可在 profile 里覆盖
回 `127.0.0.1`（此时请改用 relay 模式）。

优先级安全：`cordis.yml` 头注释说明应用顺序是 bundles → profile patch →
--patch overlays，所以**用户 profile 里的同名行会覆盖包内默认**。

#### 副机表单简化

- **工作区预填**（Windows `D:\work`，其他 `~/work`）—— 此前是空，小白不知道
  填什么：填相对路径被拒、填 `C:\` 太宽（安全边界）、填不存在的目录任务全报
  `workspace-denied`
- **节点 ID 折叠为高级选项** —— 默认取主机名，90% 用户不用改
- **目录自动创建** —— 写入配置时 `mkdirSync(recursive)` 建不存在的 roots
  （只建不改；相对路径跳过交给 resolveRoots 去拒；失败不阻塞写配置，
  结果进 `warnings` 随响应回给面板）

#### 首次自动体检

面板加载时**自动跑一次**体检（`autoChecked` ref 保证只跑一次，不进 4 秒轮询）。
此前要用户主动点「体检」按钮 —— 但小白不知道要点。

#### 文档修正

README 安装段重写。顺带修正一个**长期错误建议**：旧文档教用户写
`inject: []`，那是错的 —— 副机 agent 的 ctx 继承插件的依赖声明，
`inject: []` 会让 agent 没有任何 shell/文件工具，任务"跑完了但什么都没干"。
正确写法是 `['tools', 'agentLoop', 'sessions']`。doc-drift 断言 30 也跟着改。

#### 测试

`test/out-of-box.test.js` **15 条**：auto 推断的四种情形（没 hubUrl / 有 hubUrl /
空白 hubUrl / 显式 role 优先）、空 role 仍走引导、非法 role 不回退 hub、
包内 patch 绑 0.0.0.0 + 安全披露、表单预填/折叠、自动建目录、首次自动体检。

doc-drift 新增 79（auto + webserver 绑定）、80（表单简化 + 自动建目录 + 自动体检）。

```
packaging   4 项
doc-drift   115/115
diag:inject 11 项
tests       897（896 pass / 0 fail / 1 skip）
lint        干净
```

### 功能：环境体检（命令行为准，面板可见）

这个插件最贵的失败**全是静默的**：

- **webserver 绑 loopback** → 副机永远连不上，而主机侧毫无异常
  （hub healthz 200、面板能开、工具都在）
- **inject 缺服务** → hub 半死（路由活着但 8 个工具全丢）
- **roots 不存在** → 任务全被 `workspace-denied` 拒绝

用户只能猜"地址错了？token 错了？防火墙？"。

本版新增 `lib/env-check.js`，命令行与面板**共用同一份逻辑**：

- `envChecks()` 逐项检查：角色已配置 / inject 含必需服务 / **Web 服务绑在
  可达地址** / 端口可用 / 防火墙 / roots 存在 / Tailscale / 副机在线
- 每项都带 **detail（为什么）** 与 **fix（怎么修）** —— 不是干巴巴一个 ✗
- `autoFix` 标记"我们能自动改配置修好它"

三档处置（产品决策）：

| 档位 | 做法 | 例子 |
|---|---|---|
| A 自动修 | 只改我们自己的配置，不下载任何东西 | webserver 绑 0.0.0.0、role/inject/roots |
| B 提示 + 命令 | 给官方链接与命令，**不代下载** | Tailscale 未安装 |
| C 只诊断 | 报清楚，让人判断 | 端口占用、防火墙、模型凭证 |

**为什么不代下载**（边界）：零 npm 依赖 / 零构建是核心卖点。代用户下载第三方
软件会让本插件变成软件分发方 —— 装哪个版本、从哪下、校验和怎么保证、装失败
算谁的、供应链攻击面，全落在我们头上。所以档位 B 只给链接与命令。

配套：

- `applyHub` 新增**可达性自检**：调 `webServer.getOrigin()` 判定是否绑在
  loopback，是则 `log('warn')` 带修法。自检本身包 try/catch ——
  `getOrigin()` 在 listen 前会抛，**绝不能因为自检让 hub 起不来**
- 面板新增**红色横幅**（绑 loopback 时）+「体检」按钮 + 体检结果区
- 新增 `GET /api/remote-agent/ui/env-check` 路由

测试：`test/env-check.test.js` **24 条**（loopback 识别的 8 种写法 +
各检查项的通过与失败 + 修法必须具体 + warn 不计入 failed +
config 传 null 不抛 + 渲染每条 ✗ 都带修法）。
doc-drift 新增 77（三处齐备）、78（覆盖静默失败项 + 不代下载边界）。

写测试时抓到 3 个真问题：`config: null` 会 TypeError、Tailscale 文案漏了
"不代下载"说明、以及一个断言的正则转义层数写错。

## [0.8.0] - 2026-10-17

### 功能：#27 完整版 —— 模型清单自述 + 面板下拉

v0.7.0 只做了"自述 + 派发前拦截"，面板仍是自由文本 —— 当时的判断是
"in-process 后端没有稳定的清单 API（DSH 内部的 `model/list` 走 app-server
协议面，fiber 服务摸不到）"。**那个判断已经过时**：`ctx.llm` 现在直接暴露
`listProviders()` 与 `listModels(provider)`，这就是稳定服务面。

所以本版把最后一环补上，链路四段：

1. **副机探测**（`readAvailableModels`）：`ctx.llm.listProviders()` →
   逐个 `listModels(provider)`。单个 provider 失败 `continue`（不打断其它），
   全部失败返回 `null`（面板退回自由文本）。上限：8 provider / 每 provider
   24 模型 / 总 64 —— 不让 RESOURCE 帧膨胀。

2. **RESOURCE 帧带缓存**：探测是 async 而 interval 回调是同步的，所以用
   后台串行链刷新（启动探一次 + 每 10 分钟重探），帧里带**上一次的结果**。
   用串行链而不是 `void refresh()` 是为了防探测堆积（探测慢时每 30s 一次帧
   会越积越多）。探测失败保留旧值 —— 一次网络抖动不该让面板下拉消失。

3. **hub 摄入**（`registry-ingest`）：字段级清洗 + **独立封顶**
   （`MAX_NODE_MODELS`，不信任对端遵守了自己的上限）。
   `models: null` **保留旧值**（与 `defaultModel` 的 null 清空语义刻意不同）。

4. **视图 + 面板**：`registry.list()` → `nodeView()` 逐条投影（不 spread）
   → 面板 `<select>`：
   - 第一项"跟随副机默认（provider/model）"
   - 中间是各模型，多节点时带 `· 节点名` 后缀
   - 最后一项"自定义…"（展开回文本框）
   - **没有清单时退回文本框**（向后兼容旧副机）

**安全边界**：只上报 provider 键名 + model id + 显示名。
绝不上报 apiKeyEnv 的值、baseURL、任何凭证。`listProviders()` 只返回
已注册（有 adapter）的 route —— 天然满足"不泄露这台机器配了哪些渠道"，
只有真能用的才会出现。

测试：`test/model-list-dropdown.test.js` 13 条（四段链路逐段钉住 +
"上报字段恰好是 provider/id/name"的硬断言 + 单个 provider 失败不打断 +
null/[] 语义区分 + 面板有 select/自定义/多节点后缀）。
doc-drift 新增 75（链路四段）、76（安全边界）两条锚点。

### 修复：原子写 EPERM 立项修（第 5 次 CI 失败）

`atomicWriteJson` 的 rename 在 Windows 上被 EPERM 拦（目标正被另一个句柄
读着）。历次调整：6 次 × 10ms（总 210ms）→ 10 次封顶 200ms（总 ~1.3s），
run 39012045381 **仍失败**。

第 5 次失败时承认：这不是"抖动"，是"窗口太短"。失败用例是
「原子写：并发写 + 并发读」—— 多个 rename 互相争抢同一个目标，而 CI
runner 高峰期的磁盘延迟能到秒级。

三层修法：

- **总窗口拉到 ~6s**（16 次，封顶 500ms）—— 有界，正常路径第 1 次就成功
- **最后一次尝试前做 unlink 兜底**（删目标再 rename，绕开"目标存在且被锁"
  的 EPERM）
- **兜底只在第 16 次触发** —— 它破坏"任何时刻读到完整文件"的严格原子性
  （删除与 rename 之间读方看到 ENOENT），所以必须当最后手段而不是常规路径；
  触发点用 `RENAME_RETRIES - 1` 计算，不写死数字

安全性：读方（`readAll()` / `list()`）本来就容忍 ENOENT —— 首次写之前
文件不存在是正常状态（`readAll` 的 ENOENT 分支返回空库且 `degraded: false`）。
所以兜底造成的瞬时缺失落在既有容忍范围内，不会让读方看到半截 JSON。

测试：`test/atomic-write-eperm.test.js` 6 条（窗口 ≥5s / 兜底存在 /
触发点是最后一次 / readAll 容忍 ENOENT / 非 transient 立即抛 /
目录占住时干净失败）。

### 修复：队列残余风险的两处静默失效（#26-4 / #26-5）

2026-10-17 实测：副机 `maxConcurrent=2` 被两条卡住的 exec 占满后，后续任务
全部排队。排查时暴露两个让问题**不可见、不可控**的缺陷 —— 都是"没有报错、
行为看起来正常"的静默失效型。

- **#26-4 面板"运行中"分组**：此前面板只有一个数字（`running: 2`），
  用户看不到**是哪两条、在跑什么、跑了多久**。现在任务列表按状态分组，
  运行中（含 queued / pending_approval）置顶，每条显示 `已跑 N`
  （由 `startedAt` 与当前时间算差）—— 这是判断"是不是卡住了"的唯一线索。
  其余任务归入"已完成 / 已结束"，保持原顺序。

- **#26-5 agent 取消真打断**：`InProcessRunner.run` 等 agent 停稳用的是
  `Promise.race([agent.whenIdle(), timeoutPromise])` —— **取消信号不在里面**。
  而 `cancel()` 做的是 `agent.cancel()` + `controller.abort()`：abort 只是
  置了个标志，没有任何人在 await 它；DSH 的 agent 循环也不监听外部
  AbortSignal。后果：hub 发 `task/cancel` → `remote_cancel` 返回
  `requested: true` → 任务**一直 running 到 agent 自己跑完** → 最终落成
  **completed**（不是 aborted）。用户以为取消成功，实际白跑一遍还烧了额度。

  修法：把 abort 做成可 race 的 promise（触发即 resolve），并让返回值的
  `ok` 排除 `aborted`（`ok: !timedOut && !aborted`）。两个语义细节同时钉住：
  超时触发的 abort **不**改写成 aborted（超时 ≠ 用户取消，下游据此外报不同
  错误码）；`finally` 里 `handle.dispose()` 收掉 agent，避免取消后泄漏。

测试：`test/agent-cancel-abort.test.js` 8 条（race 含 abortPromise / ok 排除
aborted / 超时不误标 / cancel 双动作 / finally dispose / engine 映射顺序）；
doc-drift 新增 73、74 两条锚点。

## [0.7.0] - 2026-10-17

### 功能：模型自述 + headless 指定模型派发前拦截（提案 #27）

副机此前"只有它自己知道有哪些模型"—— 面板让用户自由填 provider/model，
填错要等任务跑到副机才失败。本版先解决可靠可达的两半：

- **副机自述**：`RESOURCE` 帧随车上报 `runnerKind`（in-process/headless）
  与 `defaultModel`（来自 DSH `agentDefaultModel.currentSelection()`，
  **只报 provider 键名 + model id，不碰任何凭证**；取不到一律 null，
  尽力而为不影响遥测帧）。hub 摄入清洗后 `remote_nodes` 透出并在节点行
  渲染（"后端 in-process · 默认模型 official/deepseek-chat"）。
- **派发前拦截**：`remote_task` 在 `mode=agent` + 显式 `model` + 目标节点
  为 headless 后端时**立即报错**（旧链路要等任务跑到副机才失败，浪费
  一轮往返 + 烧一个 taskId）。dryRun 与真实派发同一条校验路径。
- **dryRun 回显模型**：预览里给解析后的 `{provider, model}` 与
  `modelSource`（用户指定 / 副机默认 / 未指定）—— 派之前就知道用
  什么模型。

**范围收敛（如实说明）**：完整的"可用模型清单 + 面板下拉"本版不做 ——
in-process 后端没有稳定的清单 API（DSH 内部的 `model/list` 走
app-server 协议面，fiber 服务摸不到；探测 llm-pi-ai 内部结构太脆弱）。
等 DSH 把清单暴露成稳定服务 API 后补（面板届时渲染下拉，第一项
"跟随副机默认"，数据链路本版已铺好）。

测试：`test/model-selfreport.test.js` 3 条 + e2e 2 条（自述贯通 /
headless 拦截 / dryRun 回显）+ 修一处脆弱断言（applySync 窗口锚定义处）。

---

## [0.6.0] - 2026-10-17

### 修复：单条慢命令锁死整台副机（提案 #26，实测事故防线）

实测事故：两条慢 exec 占满 `maxConcurrent=2` 后，后续任务**全部 queued 且一条
都不执行**；重启副机后重派同样命令再次锁死。根因是 `maxConcurrent=2` 与
exec 默认超时 1 小时的组合 —— 一条卡住的命令 = 整台副机一小时不可用。

**行为变更（默认值）**：

- **exec / agent 默认超时分开**：exec 10 分钟（绝大多数命令 1 分钟内结束，
  10 分钟足够暴露"命令本身有问题"）、agent 保持 1 小时。工具层与副机兜底
  **同源常量**（`task-engine.js` 导出，`tools.js` 直接 import），显式
  `timeoutMs` 仍然优先。
- **maxConcurrent 默认 2 → 4**：2 太脆 —— 两条慢任务就能锁死整台机器；
  4 让"两条慢 + 两条快"正常共存。配置项保留，按内存调整。

**可见性：队列健康遥测（#26-3）**：

- 副机 `TaskEngine.queueStats()` 每 30s 随资源遥测帧搭车上报：
  `{queued, running, maxConcurrent, oldestQueuedMs, starved}`。
  `starved` = 有排队 + 并发占满 + 最久排队超 2 分钟。
- `remote_nodes` 透出 `queue` 字段；starved 节点渲染 ⚠ 堵死告警并给出
  下一步动作（remote_status 逐条查 / remote_cancel 释放并发槽）——
  用户不再只知道"卡了"，还知道"卡在哪、等多久、怎么办"。
- 旧副机不上报 queue（向后兼容），remote_nodes 相应行缺席。

**如实说明**：exec 的取消链路核查结论是**真杀进程树**（Windows
`taskkill /T /F`、POSIX `kill(-pgid)`，abort → killTree 已实装）——
"remote_cancel 无效"的残余风险在 agent 会话卡在不检查 signal 的 await
与快照同步扫描（`snapshotWorkspace`），留待 #26 后续批次。

测试：引擎侧 3 条（常量同源文本断言 / maxConcurrent 默认 / queueStats 判定
矩阵）+ e2e 资源遥测用例扩展（queue 贯通 + starved 渲染）。全量 825 tests。

---

## [0.5.0] - 2026-10-17

### 功能：远程文件工具集（提案 #25）

四个**只读**文件工具，装完即有 —— AI 可以直接读副机上的文件，**不用配
网盘、不用挂载、不用 SMB**：

- `remote_ls`：列目录（单层分页，目录优先，条目带类型/大小/修改时间）
- `remote_read`：读文件 —— 文本 ≤8MB 按行分段（`offset`/`limit` 翻页，
  单次响应 ≤256KB，超长行截断）；二进制只回 sha256 + 大小 + 头部 hex 预览
- `remote_grep`：副机本地全文搜索（纯 JS 逐文件扫，**不 spawn 外部 grep**，
  Windows 没有）；上限 2000 文件 / 单文件 2MB / 命中 ≤200 / 总时长 10s，
  达到上限如实报告 `truncated`
- `remote_tree`：目录树摘要（深度 1-6 默认 3，条目 ≤2000）—— 扫描在副机
  跑完只回结构，50GB 目录也不搬数据

架构与安全：

- 独立协议帧 `fs/req`（hub→node）↔ `fs/res`（node→hub），带 `replyTo` 关联
  与 15s 超时；副机断连即清理全部等待者。**不进任务队列、不占并发槽** ——
  一条慢命令锁死队列的形态在这里结构性不存在
- 安全模型与任务链路同一条底线：路径 `realpathSync.native`（展开 8.3 短名
  与符号链接）后与 `roots` 前缀比对；`denyPaths` 在枚举与读取两层生效
  （被禁条目连名字都不上报）；符号链接只列条目不解引用；整个模块没有写动词
- `fs/req` 加入 E2E 必需加密帧集：relay 模式下文件路径与内容对中继不可见

测试：`test/fs-service.test.js` 14 条单测 + hub⇄worker e2e 2 条（真实通道
四工具贯通 + relay 窃听器验证文件内容/文件名不可见）+ 工具收口与 inject
契约断言同步（8 → 12 个工具）。

---

## [0.4.0] - 2026-10-17

### 验证：`agent` 链路两台真机确认通过

此前 §8 的"待两台真机确认"项闭环：在两台都装了 DSH 的真机上，
`agent` 模式全链路（派发 → 副机独立 Agent 循环 → handoff 回传）验证通过，
两处根因修复（source 类型 `20919b5`、模型选择 `367daef`）从进程内测试
覆盖升级为真机确认。README 状态行同步。仍未覆盖：relay 模式跨 NAT 真机。

### 功能：中继链路端到端加密（提案 #1）

relay 模式下 hub⇄副机的业务帧默认端到端加密：中继只看得到路由信封
（`t`/`id`/`to`/`from`），goal、handoff 与产物分块全在密文里。密钥协商用
一次性 X25519 + HKDF-SHA256；hub 用持久 ed25519 身份签握手回执（签名绑定
双方临时公钥 + nonce，中继偷换公钥/重放即失败，验证锚是 P2-11 钉住的
hub 指纹）；每帧 AES-256-GCM，AAD 绑定方向/类型/id/序号，序号严格递增
挡重放。会话建立后副机**拒绝一切明文业务帧**——挡住中继运营者拿
enrollToken 冒充 hub 注入任务的唯一防线。

兼容性：中继**零改动**（密文藏在既有帧格式里，旧中继照转）；旧副机/旧
hub 混跑按未知帧互相忽略；握手 5 秒无 ack 自动按明文兼容旧中继继续
（副机大声警告）。已知局限见 SECURITY.md「中继链路端到端加密」：
主动降级（中继扣握手帧）与 enrollToken 冒充节点。

实现：`lib/e2e.js`（新）+ hub/node 两侧收发路径接线；`relayE2E: false`
可整体关闭。测试：`test/e2e.test.js` 12 条单测（黄金向量/篡改/AAD/序号/
二进制）+ `test/hub-worker-e2e.test.js` 5 条集成（窃听器不可见、二进制
字节一致、伪造拒绝、丢会话自愈、direct 生效）。

### 功能：任务变更 diff 视图（提案 #21）

任务收尾时副机为工作区里 add/modify/delete 的**文本文件**生成 unified diff，
随 handoff 上报 —— 远程场景下没法随手 `git diff`，这张卡就是"到底改了什么"
的证据链。零依赖（不 spawn git、不引 npm 包）：公共前后缀修剪 + DP LCS，
中段超 600 行不硬算（统计式降级，宁可粗也不 O(n²) 爆内存）。

边界刻意收窄：前像在任务开始时快照捕获（≤256KB/文件、64 文件、总量 4MB、
二进制不捕获，超限文件的 diff 缺席但 changed 元数据仍在）；输出封顶
12 文件 / 单文件 16KB / 总量 96KB。消费路径：`remote_handoff` 卡片直接带
diff 文本（`## 变更 diff` 段），面板任务详情新增「变更 diff」块（先展示
6 块）。安全披露见 SECURITY.md 新节 —— diff 是**文件内容**，不再只是元数据；
`denyPaths` 对快照与 diff 同样生效。测试：diff 单测 10 条 + engine e2e 3 条
+ views 投影 3 条。

### 功能：exec 输出行心跳（提案 #15）

`mode:"exec"` 的长任务此前 running 期间没有任何进度帧（只有 started 与
结束帧），面板与 remote_status 都"看起来卡死"。现在 exec 运行期每 2 秒
发一条 `task/progress`（`phase:"output"`），**只在 stdout/stderr 行数有变化
时发**（静止时不刷屏），面板「进行步骤」尾部展示 8 条。只对 exec 做 ——
agent 模式的工具事件本身就是步骤流，避免刷爆 20 条 progressTail。
e2e 1 条（首帧必发、行数不变不发、stop 后静默）。

### 修复：真机验证揪出的四项（docs/verification-repos-routing-real.md）

- **审计值级打码**：此前打码只看键名，任务书正文里内嵌的凭证
  （`Bearer sk-…`、`password=…`、`://user:pass@`、sk-/ghp- 前缀 token）
  会明文落进 audit.jsonl 并长期留存。现在字符串值过第二道凭证形态扫描
  （高精度口径：普通正文不受影响）。
- **`agentMode` 可配置**：副机 hello 里的 `agentMode` 曾硬编码 `true`，
  让 #14 的"agent 模式只选支持 agent 的节点"成为空承诺。现在 worker
  配置 `agentMode: false` 即可关掉（默认 true 不变）。
- **测试不再污染用户真实状态目录**：hub-worker-e2e / ui-routes 两处测试
  的 hubConfig 漏传 `stateDir`，审计事件写进了真实的 `~/.dsh-remote-agent/`
  （跑一次测试写 14 行）。已补上临时目录。
- **scp 形态 url 剥用户名**：`token123@host:path` 的用户名位置可能是
  token（自建 Git 服务常见），不再赌它是公开用户名，`user@` 一并剥掉
  （url 只用于展示与匹配，剥掉无害）。

### 功能：exec 任务两阶段审批（提案 #2）—— ⚠ 行为变更

**`mode:"exec"` 的缺省行为变了**：现在默认 `approval:"manual"` —— hub 收到
派单后**挂起不派**（副机完全不知道这条任务存在），直到在面板「远程同事」
的待审批卡上点「批准并派发」才真正下发；挂起超过 `limits.approvalTimeoutMs`
（默认 30 分钟）**自动拒绝**（fail-closed：等不到人就是不跑，绝不默认放行）。
想要旧行为显式传 `approval:"auto"`。`mode:"agent"` 缺省不变（auto）。

配套：任务新增 `pending_approval`（非终态）与 `rejected`（终态）两个状态；
面板派发表单派 exec 任务同样走审批；对挂起任务调用 remote_cancel 等价于
拒绝（不会向副机发无意义的取消帧）；审计新增 `approval.pending/granted/rejected`
事件；审批路由 `/ui/approve`、`/ui/reject`（404/409/502 语义）。
挂起任务占 maxTasksPerNode 活跃额度（防审批队列无界堆积）。
单元 + e2e 共 15 条。

### 功能：派发 dry-run 预览（提案 #23）

`remote_task` 新增 `dryRun: true`：走与正式派发**完全相同**的路由（显式
node / repo 仓库路由 / 负载自动选）与校验（validateTaskStart），返回"会派
到哪个节点、哪个工作区（含副机默认工作区回填）、什么模式"，不落库、不派
帧、不烧 taskId。预览报错即真实派发会报的错。e2e 1 条（含"不产生任务"
负向断言）。

### 功能：仓库感知调度（提案 #13）

`remote_task` 新增 `repo:` 参数：传仓库名 / 远端 url 片段 / 本机路径片段，
任务派给**持有该仓库**的节点（多个时按负载自动选，名字精确匹配优先于包含
匹配）；省略 `workspace` 时自动用仓库在本机的路径。副机接入后自动扫描
roots 下的 git 仓库（零子进程，只读 `.git/config`）并上报——**凭证在副机
本地剥掉**（url 里的 user:token 不出机器），每 10 分钟刷新，
`reposIntervalMs: 0` 可关。旧 hub 收到新帧按未知帧忽略（混跑安全），
副机未升级时 `repo:` 会得到明确报错并列出当前已上报的仓库。新增
`lib/node/repos.js`、`NodeRegistry.pickNodeByRepo` / `findRepoOn` /
`knownRepoNames`，测试 23 条。`remote_nodes` 与面板节点列表新增 repos 字段。

### 功能：负载感知自动路由（提案 #14）

`remote_task` 省略 `node` 时的行为变更：多节点在线**不再报错**，改为自动选
——在跑任务数 → CPU → 内存占比 → nodeId 字典序逐级比较（逐级而非加权，
确定可解释）；`mode:"agent"` 只考虑支持 agent 后端（agentMode）的节点。
显式指定 `node` 的行为不变。新增 `NodeRegistry.pickAutoNode`，测试 10 条。

### 功能：hub 审计日志（提案 #19）

hub 在 `<stateDir>/audit.jsonl` 记录派发 / 取消 / 拉取证据链
（`task.dispatch` / `task.cancel` / `pull.start` / `pull.end`）。
字段统一打码截断（token 类键值写 `***`、超长 400 字符截断）；默认开启，
8MB × 3 份轮转封顶；`config.audit: false` 显式关闭。写入失败只限频告警，
绝不影响任务链路。新增 `lib/hub/audit-log.js`，测试 9 条。

---

## [0.3.0] - 2026-10-16

### 工程：P1-4 拆分 node-registry.js（1465 行 → 四个职责文件）

纯代码搬移，零行为改动，对外 `import { NodeRegistry, RelayLink, createPluginLogger } from './node-registry.js'` 的旧路径仍可用：

- `relay-link.js` —— RelayLink（中继链路：重连/退避/节点目录），KNOWN-ISSUES 与 CHANGELOG 早已记着这条拆分建议
- `hub-util.js` —— 插件日志器 + errText/numOr/safeDispose（单一真身，registry 与 relay-link 共享；numOr 曾因本地拷贝约束漏抄出 ReferenceError）
- `registry-ingest.js` —— 上行帧处理与 task/sync 对账（mixin：`withIngest`）
- `registry-handshake.js` —— direct/relay 接入、hello、hub 身份证明（mixin：`withHandshake`）
- `node-registry.js` 只剩核心注册表（任务视图/下发/等待器/心跳/生命周期），约 640 行

门禁锚点同步：doc-drift 断言 15c/42/62/66、自检变异目标、task-view-accumulation 文本断言均跟随新文件；KNOWN-ISSUES 该条已标注解决。

### 功能：产物断点续传

`remote_pull` 拉大产物途中断线 / 超时，此前已收字节全部丢弃、重试从 0 重传。
现在**传输中断类失败**（空闲超时 / 节点掉线 / 不可达 / 调用方 abort）把半成品
晋升为稳定命名的 `.dsh-remote-agent-resume-<key>.part` + meta 旁车（全文期望
sha256、已收前缀 sha256、字节数）；下次 pull 同一文件时校验通过就从中段续传
（pull 帧带 `startOffset`，副机从该偏移起流），**内容级失败**（hash 不符 / 乱序 /
写失败 / 超限 / 显式取消 / hub 关闭）仍整体重来。续传前缀经双重防护：meta 里的
前缀 sha 与磁盘字节重算比对（篡改/部分写/截短一律弃用从头），全文 sha 在收尾
三重校验（与既有契约一致）。崩溃残留（磁盘比 meta 长）信 meta 前缀并截断。
`partialTtlMs` 默认保留 7 天，0 = 禁用续传。协议帧结构零改动（chunk/done 帧与
既有字段全同，`startOffset` 是 pull 载荷的可选字段），新旧混跑行为不变；同一
(dest, relPath) 并发 pull 被明确拒绝。

### 功能：副机资源遥测（CPU/内存/负载 上报到 hub）

副机每 30s 采一次本机资源，经 `node/resource` 帧上报（`resourceIntervalMs` 可调，0 = 关）。CPU 用两次采样增量算利用率（`os.cpus()` 累计值直接读出来是开机平均，没有参考价值），首次采样无基线 → cpuPct 为 null。hub 侧存进节点记录，`remote_nodes` 与面板节点行透出；离线节点保留最后一份遥测（带 at 时间戳，消费方自行判断新鲜度）。

尽力而为的遥测：字段缺失/类型不对就落 null，畸形帧不影响节点记录与任务链路。

### 修复：task/sync 自动清理分支 ReferenceError（eslint no-undef 首功）

`applySync` 的自动清理分支用了 `lib/hub/index.js` 的私有 `numOr`，而
`node-registry.js` 是 hub 目录的依赖叶子（index → registry 单向依赖），
本文件并未定义它 —— 分支一走到就 `ReferenceError`，task/sync 全量重建
视图随之中断。此前测试只做文本断言，从没真正执行过这条路径；修复后补
行为级回归（retainMs=1ms 触发清理 + 刚结束任务保留的保留期对照）。

### 工程：eslint 严格档进 CI

新增 `eslint.config.js`（flat config）与 `npm run lint`；devDependencies
引入 eslint 10 —— **运行时仍零依赖**（devDeps 不进 git 安装，`npm run check`
保持「不装依赖也能跑」，CI 里 lint 是独立 job）。规则集 = 推荐集 + 一批
高信号一致性规则（eqeqeq / no-var / prefer-const / no-shadow /
require-atomic-updates 等），首跑清零 256 处存量违规。测试侧放宽两处
框架惯例：node:test 上下文参数 `t`、docblock 零宽空格转义。

### 性能：task-store 热路径异步化（状态同步 + 日志/进度批量写回）

`appendLog` / `appendProgress` 此前每行都全量重写整个任务记录文件
（含最多 500 行 × 200k 字符的日志尾巴，单文件可达 2MB），同步 fs
直接阻塞副机事件循环。改为：

- 状态转移 / 创建 / 关闭前 → **同步落盘**（耐久性语义：终态记录若只躺在
  批量窗口里，崩溃后 reconcile 会把未落盘的 completed 判成 interrupted
  重跑 —— 任务执行两次）；
- 日志 / 进度 → 200ms 合并窗口批量写回，窗口内 N 次更新只写一次盘；
  写失败留脏重试，不抛；
- teardown 在所有写人组件停止后接入 `store.close()` 强制落盘。

行为对使用者不可见（任务状态机、manifest、reconcile 语义不变），
9 条语义测试锁定（批量窗口 / 崩溃模拟 / 留脏重试等）。

### 文档：relay 跨 NAT 降级链 + VPS 部署模板

- **profiles/README.md 新增「怎么选路径：降级链」**：三条接入路径组织成
  条件式降级链（direct → 中继 VPS / cloudflared → 链路全断时副机本地
  续跑 + 重连 task/sync 对账），附「该降级了的判据」现象表与切换成本
  （副机侧只改三个字段）。
- **新增 `deploy/relay-vps/` 部署模板**（已进 `package.json` 的 `files`）：
  systemd unit（含加固段）、凭证 env 模板、Caddyfile 与 nginx 两套
  TLS 前置模板（公网中继从"明文 ws:// 裸奔"变成可抄的 `wss://` 方案），
  外加一份五分钟 runbook。
- **SECURITY.md 修正与补强**：传输加密表的「公网中继」行指向部署模板；
  威胁模型补两条事实 —— 协议无端到端加密（中继可见明文业务帧，选
  VPS 提供商等同于交出链路）、中继挂≠任务挂（可用性边界非安全边界）；
  修正一处文档失真（一次性 token 实际只存在中继进程内存，不落盘）。
- doc-drift 新增 7 条断言（84 → 91），变异负向控制 3/3 全抓。

### 决策：派发自动化维持「桌面会话」边界（评估记录，无代码改动）

`docs/dispatch-automation-eval.md`：hub 的 webserver 整台被 DSH 会话围栏
保护（实测除 `/healthz` 外一律 401），脚本无法代替桌面派发任务。
三个结论：**边界设计使然**（现在）；**短时令牌方案预设计未实施**
（桌面铸造 15 分钟单次令牌、只放行 dispatch/cancel、绝不开 pair-info，
与 relay 一次性 enroll token 同构）；**静态 bearer token 明确拒绝**
（公网面上的无过期便携 secret，与全仓"缩短暴露窗口"的凭证口径相冲）。
复审触发条件已写入文档。KNOWN-ISSUES §8 第 3 条补链接；doc-drift
新增 2 条断言（91 → 93）。

### 安全：hub 身份认证 —— 副机也会验主机，假 hub / 假中继冒充被当场拒绝（P2-11）

协议此前只有单向认证：副机拿 token 向 hub 证明自己，但 hub 从不向副机证明
"我就是那个 hub"—— 假 hub 回一帧 welcome 副机就上线，假中继更可以直接
冒充 hub 下发 `mode: exec`（副机任意代码执行）任务。本次补上反向认证：

- **hub 持久身份**：首次启动生成 ed25519 密钥对，落盘
  `<stateDir>/hub-identity.json`（0600，损坏就地重建 —— 已钉住旧指纹的副机
  会大声失败，fail-closed）。direct 模式身份证明进 `welcome` 帧，relay 模式
  节点上线后追发 `hub/identity` 帧（封堵"hub 握手期静默"的冒充窗口）。
- **副机钉住**：配置 `pinnedHubFingerprint` 显式钉住；未配置则首连自动钉住
  （TOFU，`<stateDir>/hub-pin.json`）。验证链五环：指纹自洽 → 匹配 pin →
  验签 → nonce 回显（防重放）→ ±5 分钟时间窗；任一不过 = 拒绝上线 +
  **停止重连** + 大声报错（pin 保留，人工确认后才重钉）。
- **relay 宽限窗口**：上线后 15 秒内等 hub 身份帧；有 pin 超时 = 拒绝
  （疑遭剥帧），无 pin 超时 = 旧版兼容继续；窗口内到达的任务一律回
  `hub-identity-pending`，不会被拿去执行。
- **零终端分发**：配对码新增 `hubFingerprint` 字段，向导出码自动携带 ——
  副机粘码即完成"连接配置 + 指纹钉住"。
- 向导 / README / profiles/README / SECURITY.md 同步；doc-drift 新增 6 条
  断言（93 → 99）+ 自检复制清单补 `lib/identity.js` + 2 条变异负向用例；
  全量 613 tests 612 pass（含 hub 身份原语黄金向量 6 组负向控制）。

---

## [0.2.0] — 2026-10-15

「小白也能用」版本：从"能跑"到"零终端也能装"。新增配对码、配置向导
（写盘 / doctor / 双击入口）、Web 面板 GUI 化、模型选择、真实运行时
自检工具。**无破坏性变更**（`pair` 纯新增字段，协议版本不变）。

### 新增：向导写盘 + Windows 双击入口 —— 零终端部署闭环

- **向导写盘**（`lib/setup.js`）：自动探测 `~/.dsh/profiles/<profile>/cordis.patch.yml`
  （`cordis.yml` 是空壳，实测确认），备份 → 托管块合并 → 校验，失败自动回滚。
  托管块幂等（跑两次零变化）；检测到**手写** remote-agent 条目默认拒绝并点名
  `--force`（同 id 重复 = 插件挂载两次 = 启动失败）。交互式回车即写，
  非交互 `--write / --force / --profile`。
- **双击入口**（`bin/双击运行-配置向导.cmd`）：零终端第一道墙。
  内容 ASCII（cmd 按 OEM 码页解析批处理）、CRLF 行尾，字节级断言钉住
  （doc-drift 48）；参数透传 `%*`，快捷方式可带参。`.gitattributes` 钉 CRLF。
- **零终端路线图**（README）：双击 → 回车 → 面板「副机接入」复制配对码 →
  副机向导粘贴自动写盘 → 重启，全程不碰 YAML 不开终端手敲命令。
- 测试：write-config 15 条；全量 501+；doc-drift 79/79。

### 新增：Web 面板 GUI 化 —— 副机接入按钮 + 派单模型输入

零终端小白的图形入口（面板是 hub 侧唯一 GUI）：

- **「副机接入」卡片**（`lib/client.js`）：一键生成配对码并复制 `pair:`
  配置行 + 复制防火墙放行命令 —— 主机侧全程鼠标，免终端免向导。
  端口不用配置：面板本身就由 hub 的 webserver 服务，浏览器地址栏端口
  即节点拨入端口。
- **token 披露边界**（`GET /api/remote-agent/ui/pair-info`）：含 token 的
  完整配对码**只对本机回环请求**生成 —— 面板可能被 lanBind 暴露到局域网，
  局域网内能打开面板 ≠ 应该拿到主机凭证。非回环得到不含 token 的码 +
  一条人话提示。与 /config 的"凭证只回 set 布尔"同一精神。
- **dispatch 表单加「模型」输入**（可选）：留空用副机默认；填
  `deepseek-reasoner` 或 `provider/model` 均可，原始字符串交服务端
  normalizeModelSelection 归一 —— 与 remote_task 工具同一通道。
- 测试：ui-routes 3 条（形状/回环全码/非回环拒绝，非回环用伪造
  remoteAddress 直打 handler）；doc-drift 断言 45~47 钉住
  "loopback 策略不被放宽 / 面板入口真实存在 / model 真进请求体"。

### 新增：配对码（pair）—— 副机配置从三行抄写变成一行粘贴

副机部署最容易抄错的就是 `hubUrl` / `token` 两行（少半个斜杠、token 带尾部
空白，表现都是"副机永远不上线"且无报错）。配对码把连接信息压成一行
`dshra1://` + base64url(JSON)：

- **`lib/pairing.js`**（零依赖纯函数）：`encodePairCode` / `decodePairCode` /
  `expandPairConfig`。解析对终端复制形态全容错（换行/引号/空白），所有
  坏输入返回结构化中文错误**永不抛** —— worker 启动路径 pair 无效只降级
  记警告，副机 dsh 照常起来。
- **两条安全语义**：①配对码内含 token，等同凭证（文档明确传阅规矩）；
  ②`roots` 不进配对码 —— 副机的安全边界永远由副机配置声明，主机侧的串
  决定不了它。
- **显式配置优先**：`pair` 与 `hubUrl` 同时存在时 `hubUrl` 生效，方便临时
  换地址调试；展开成功后 `pair` 键从配置对象里删除（token 不存两份）。
- **三处接线**：worker `startWorker` 首行展开 pair；doctor 静态检查基于
  展开后的配置（坏 pair 单独一条 ✗ 带修法）；向导 hub 路径输出配对码、
  worker 路径可整行粘贴自动填充、非交互 `--role worker --pair dshra1://…`
  直接出配置、`--role hub --hub-ip …` 顺手生成配对码。
- 17 条回归（往返矩阵 / 容错矩阵 / 展开优先级 / doctor 与 YAML 接线 /
  applyWorker 降级路径）；doc-drift 断言 42~44 钉住"README 有入口、worker
  真的展开、向导真的生成"三件事。

### 新增：小白向导 + remote_task 支持指定副机模型

#### `bin/dsh-remote-setup.js` —— 配置向导（小白也能配好）

部署这个插件要写 YAML、算 IP、生成 token、记住 `inject: []` 的坑 ——
每一件都对小白不友好。向导把全过程收敛成三次回车：

- **交互式**（无参数运行）：问"主机还是副机"→ 自动枚举本机局域网 IP →
  自动生成 `nt_` 强随机 token → roots 输入时自动创建缺失目录 →
  输出两台机器可直接粘贴的 cordis YAML。**副机片段的 `inject: []`
  由生成器替用户填好**（部署失败头号坑：不填它该行永远 PENDING 且无报错）。
  主机路径还会打印防火墙放行命令；副机路径会先 TCP 探活主机端口。
- **非交互**：`--role hub|worker --hub-url --token --node-id --roots a,b --out 文件`
- **`--doctor <配置.yml>`**：逐项体检（Node 版本 / hubUrl 合法性 / token 与
  公网暴露 / roots 存在性 / nodeId 形状 / 端口可达性），每条 ✗ 都带
  "怎么修"。

纯逻辑在 `lib/setup.js`（14 条测试）；`lib/node/index.js` 的连接错误提示
改走同一份 `friendlyConnectError` 映射 —— 副机日志里的 `ECONNREFUSED`
现在旁边多一行"端口没人听 —— 检查 ①DSH 在跑 ②IP/端口 ③防火墙"。

#### `remote_task` 新增 `model` 参数 —— 主机可指定副机用的模型

    remote_task { goal, model: { model: "deepseek-reasoner" } }
    remote_task { goal, model: { provider: "openai", model: "gpt-4o" } }

- **只传选择，不传凭证**（核心不变式 1）：协议里流动的是 provider/model 名，
  模型 key 始终在副机。指定的模型在副机不存在时任务会以明确错误失败
  （错误经 367daef 修复后的 agent/error 监听进入 handoff）。
- **in-process 后端**：`buildAgentOptions(defaultSel, requested)` 合成
  "副机默认 × 主机指定"，主机字段优先、缺的借默认补齐（只给模型名时
  provider 借副机默认）。
- **headless 后端明确拒绝**（`modelUnsupported`）：`dsh headless` 把模型
  硬编码为副机默认选择、无 CLI flag（对照 app.asar 内 dsh-headless 源码
  核实）—— 静默忽略会让"以为指定了模型、实际跑的是默认"，排查方向
  直接跑偏，所以如实失败。
- **TaskStore.create 的字段白名单补 `model`**：此前 spec 里的 model 会在
  落盘时被丢掉 —— agent 任务重启后 reconcile 重跑时模型选择必须跟任务走。
- 三条入口接通：remote_task 工具、Web 面板 dispatch（body.model）、
  README 工具表与 systemPrompt 同步。subagent provider 不接（框架
  `capabilities.agentOptions=false`，请求里没有自然载体）。

### 修复：健壮性两处（评审遗留）

- **transport 握手超时**：upgrade 后 welcome/accepted 不来必须在 10s 内
  毁连接走重连 —— 此前"TCP 连着但永远上不了线"的哑状态没有任何报错。
  （带陈旧连接守卫与三处定时器清理；mock timers 行为级回归。）
- **pull-manager**：① 分块帧缺 offset 按畸形帧失败（hash-mismatch），
  不再静默跳过校验继续写盘；② 空闲超时重臂用**本条 pull 自己的**
  timeoutMs —— 此前第一个分块后回退到 limits 值，自定义短超时静默失效。

### 文档

- README 新增「五分钟上手」；状态行更正（agent 后端两根因已修、待实机确认）。
- KNOWN-ISSUES §1 标注已修（`kind: 'plugin'` → `cordis-host-runner`），
  保留推理记录 —— 它预言的残余风险后来真的发生了。
- check-doc-drift 65 → 71 条（新增向导承诺断言：README 入口 / bin 声明 /
  生成器填 inject / doctor 带修法 / 错误人话翻译 / model 参数）。

### 新增（同轮，之前提交）

- **transport 握手超时**、**pull-manager offset 必填与重臂预算**
  （commit 0d3f56b，9 条 mock-timers 行为回归）。
- **remote_task 的 model 参数端到端**（commit 9dc0f23，15 条分层回归）。

### 修复（第二轮：独立评审 + 中优先级）

一次外部独立评审（2026-10-15）报出 3 个高优先级 + 若干中优先级问题。
三条高危**逐条核实后确认属实**，已修；中优先级按用户选择修了 5 组。

#### 高 · headless 后端任务书进 shell = 命令注入（`lib/node/runner.js`）

`spawn(dshBin, args, { shell: this.platform === WINDOWS })` 且 `goal` 直接进
argv。Windows 下 `shell:true` 走 `cmd.exe /c` 且**不做转义**，而 `goal` 是
多行 Markdown 任务书、内容来自远端（不可信）。任务书里的 `&`、`|`、引号或
换行会截断/拆开命令行 —— 轻则调用损坏，重则执行夹带的第二条命令。

**修法（两层）**：① `shell: false`（`dshBin` 已是绝对路径，不需要 shell）；
② `goal` 从 **stdin** 传（`headless --json -`，`-` = 读 stdin，已用
`dsh headless --help` 核实），即使将来有人把 `shell:true` 加回来也不在命令行上。

> **核实修正**：评审把它与"agent 假完成"关联，但实测副机走的是
> `runner: in-process`，那个 bug 的真因是 `PLUGIN_SOURCE` 类型非法
> （见下面 0.1.0 的"agent 模式假完成"）。所以这是**独立的真缺陷**。

#### 高 · WebSocket 分片重组无总量上限（`lib/ws.js`）

单帧有 8 MiB 上限，但 `fragBytes` **只累加不检查**，而 RFC 6455 允许拆任意多片。
一条连接连发 N 个 4 MiB 分片即可在 `Buffer.concat` 之前撑爆内存。直连端点在
`nodeToken` 留空时无鉴权，所以是"一条连接打爆 hub 内存"的路径。

**修法**：累加后、concat 前加总量守卫（上限 = 单帧上限 × 4 = 32 MiB），
超限 `fail('fragment-too-large')`。

#### 高 · 中继背压只覆盖 node 方向（`lib/relay.js`）

`forwardToNode` / `forwardBinaryToNode` 有背压，而 `broadcastHubs` /
`broadcastHubsBinary` 直接 `h.send()`。一个不读 socket 的 hub 连接会让中继
写缓冲无限增长 —— 正是本文件自己注释里的 OOM 场景，换了个方向。

**修法**：新增 `applyHubBackpressure(h)`（同策略：超限即断连 + 计 stats + 记日志），
两个广播函数都接上；遍历改用快照 `[...hubs]`。

#### 中 · relay token 走 URL query → 进各级日志

`transport.js` 与 `node-registry.js` 都把 token 塞进 URL query，而 URL 会进
中继 access log、反向代理日志、CDN 日志。中继侧本来就 header 优先
（`searchParams.get('token') ?? headers['x-relay-token']`），`ws.js` 的 `connect()`
也支持自定义 header —— 所以客户端改成走 header 即可，服务端不用动。

**修法**：direct 用 `x-dsh-token`（原有）、relay 用 `x-relay-token`（新增），
两者都不再进 URL。顺带修正了两种模式此前的不对称。

#### 中 · 临时诊断无限增长 + 泄漏任务信息（`lib/node/runner.js`）

定位 agent 问题的诊断写死 `<temp>/dsh-remote-agent-runner.log` 且无上限，
记录里含 taskId、goal 长度、cwd、错误正文。

**修法**：改为 **opt-in**（`DSH_REMOTE_AGENT_TRACE=1`）+ **有上限**
（超 2 MiB 轮转）。注意 `agent/error` 的上报（`liveText.push` + `onEvent`）
是**功能性**的、不受开关影响 —— 它把错误带进 handoff 摘要。

#### 中 · pull-manager 忽略 writeSync 返回值

`fs.writeSync` 可能部分写。虽然最终 sha256 校验会兜住（不会把坏文件当成品），
但代价是**白传一整份产物**才失败。改为循环写直到写完，异常即明确失败。

#### 中 · 中继死连接治理

两个洞：① `HELLO_NODE` **无 `boundId` 守卫** —— 同一连接二次 hello 换 nodeId
会留下永不清除的幽灵条目，反复 hello 可在单连接上堆任意多条目、占满 `maxNodes`
配额；② **无心跳/空闲淘汰** —— NAT 静默死亡（家庭路由 5–30 分钟、断电、
中间设备丢连接）不会触发 `close`，死条目永久占配额，中继缓慢"饱和而死"。

**修法**：① 一条连接只能 hello 一次（`already-helloed`）；② 新增
`sweepIdleConnections()`：空闲 3 分钟发 WS ping 探测（`ws.js` 会自动回 pong），
再一个周期无响应才判定死亡并清理 —— 用 ping 而不是直接按"多久没帧"断，
否则会误杀任务间隙的正常空闲节点。定时器 `unref()`，`close()` 里清理。

#### 中 · `TaskStore.prune()` 从未被调用

定义了但无调用方 → 终态任务记录的**内存缓存与磁盘文件无限累积**
（每条最多含 200KB 日志尾巴）。改为副机启动时清一次（保留期 7 天），
失败只记 warning、不挡启动。

### 待办

- POSIX 分支仍未真机验证（只有 CI 覆盖）。
- Windows 8.3 短名绕过向量未验证（见 KNOWN-ISSUES §7.1）。
- `node-registry.js` 1275 行集多职责于一身，建议把 `RelayLink` 拆出去。
- `task-store` 热路径同步 I/O（每条日志/进度都全量重写记录）。

---

## [0.1.0] — 2026-10-15

首个可用版本。主机侧（hub）端到端可用；副机侧 `exec` 后端可用。

### 新增

- **7 个工具**：`remote_nodes` / `remote_task` / `remote_status` /
  `remote_handoff` / `remote_manifest` / `remote_pull` / `remote_cancel`。
- **Web 面板**（侧栏「远程同事」）：节点列表、派发任务、任务状态、
  结果摘要、工作区变更、成品清单、日志尾巴；主机设置只读展示。
- **两种传输**：`direct`（副机主动连主机，需主机地址可达）与
  `relay`（经中继 VPS 会合，双方都在 NAT 后时用）。
- **两种执行后端**：`in-process`（副机在自己的 DSH 进程里起独立 agent 会话）
  与 `headless`（spawn 独立 `dsh headless` 进程，回退用）。
- **产物按需回流**：任务结束只回 `manifest` + `handoff`；只有 `role:final`
  的成品可以 `remote_pull` 拉取，`intermediate`（日志/缓存/中间构建文件）
  只上报元数据、留在副机。
- **`subagent` provider**：主机侧的 agent 可以把任务委派给远程节点。
- 中继服务（`bin/dsh-remote-relay.js`）+ 初始化脚本（systemd / 计划任务）。

### 设计不变式

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后自动对账 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要显式 `remote_pull` |
| **只有 `role:final` 过河** | 中间产物只在副机留存 |

### 修复（开发期，均已验证）

这一节记录的是**在 0.1.0 发布前**踩到并修掉的问题。保留它们是因为每一条
都对应一个容易复发的陷阱，改动相关代码前值得先读。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查工具返回值，返回 `undefined` 即判失败。
拒绝条件：

- `typeof value !== 'object'` 且非 null/boolean/string/number
  → **undefined / 函数 / Symbol**
- 数字 `!Number.isFinite(v) || Object.is(v, -0)` → **NaN / Infinity / -0**
- 原型不是 `Object.prototype` 也不是 `null` → **类实例**
- 循环引用
- 数组原型不对，或数组上挂了额外属性

我们踩到的是**类实例**：副机回传的 `accepted` 对象带类原型。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 `{ type: 'number' }` / `{ type: 'object' }` 的字段，null **不是**该类型。

触发场景很常见：查一个**刚创建、还没开始执行**的任务
（`startedAt` / `endedAt` / `durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口，而不是逐个工具改 ——
7 个工具返回值形态各异，逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。

```js
const reg = (definition) => {
  const original = definition?.execute
  const schema = definition?.output?.schema
  definition = { ...definition, async execute(...args) {
    const value = await original.apply(this, args)
    return toPlainJson(dropNullForSchema(value, schema))   // 顺序不能反
  }}
  disposers.push(ctx.tools.register(definition))
}
```

- `dropNullForSchema` 读 schema，删掉「值为 null 但 schema 声明非 null 类型」的
  **可选字段**。不动 `required` 字段（删了会从"类型错"变成"缺字段错"，同样失败）。
- `toPlainJson` 净化成纯 JSON（类实例 → 普通对象、undefined → 丢弃、
  NaN/Infinity/-0 → 0、循环引用截断）。
- **顺序**：`dropNullForSchema` 必须在前 —— 它把 null 转成"缺失"，
  而 `toPlainJson` 会丢弃 undefined。

源头同时修了 `views.js`：时间字段用 `0` 兜底、`manifestCounts` 用 `{}`。
新增 `test/tool-output-plain.test.js`（19 条）锁住这两层。

#### UI 路由注册后 8–13ms 被 unload，面板 404

**症状**：面板一直显示 `读取失败: HTTP 404`，而 Host 侧路由实测 401
（路由不在 exact 表）。**启动日志里什么都没有**，排查代价极大。

三个叠加的原因：

1. **`registered` 闩锁**（真正的杀手）：`withServices` 里有一个
   `let registered = false; if (registered) return`。fiber 被 unload 后重新 load
   时，闩锁拦住了重新注册 → **路由被删且永不回来**。
2. **运行时 `ctx.inject` / `ctx.plugin` 都不可靠**：
   - `ctx.inject(deps, cb)` 返回 **thenable fiber**，文档要求 `await` 才算
     "加载完成"；而插件的 `apply` 是**同步**的 → 父 fiber 同步返回后框架
     清理尚未 settle 的子 fiber。
   - `ctx.plugin({inject, apply})` 更糟：子插件的 `apply` **根本没被调用**。
3. **`tools.js` 的 17 处 `type: ['x', 'null']`**：DSH 的 JSON Schema 校验
   **不接受 type 数组**（`type must be a single type string`）→
   `registerRemoteTools` 抛 `JsonSchemaError`。此前被 `ctx.effect` 的容错吞掉，
   改成直接注册后才暴露。

**修法**：

- 去掉闩锁。
- **inject 声明在 loader 行上**（`cordis.patch.yml` 的 `inject: [...]`）——
  框架会推迟本行激活直到服务就绪，只 apply 一次、无子 fiber 抖动。
  这是唯一被验证可用的形态。
- `applyHub` 内部**不用 `ctx.effect`**，改「立即注册 + 收集 disposer」
  （`__reg`），不依赖 fiber 生命周期。
- 17 处 `type: ['x','null']` → `type: 'x'`。
- `ctx.subagents` 改 `ctx.get('subagents')` —— cordis 对未声明 inject 的服务
  **属性访问会抛错**，不是返回 undefined。

**副作用（部署必读）**：副机 profile **必须**覆盖 `inject: []` ——
副机没有 `webServer`/`tools`/`systemPrompt`，不清空的话该行永远停在
PENDING、永不激活。见 `profiles/worker.cordis.yml`。

#### 其他

- `resolvePowerShell` 采用 0 字节的 `WindowsApps\pwsh.exe` → spawn 抛
  `EFTYPE`。加 `isUsableExecutable()`（存在 + 非零字节）。
- relay 错误帧全被丢弃：`RELAY_FRAME.ERROR` 未定义 → 加 `ERROR: 'error'`。
- relay 二进制下行用 `conn.send(text)` → UTF-8 有损；改 `sendBinary`。
- `new URL(req.url)` 未 try/catch → 畸形请求会杀掉进程；加 `safeParseUrl`。
- 任务取消映射到 `failed` 而非 `aborted`；失败路径漏了 `error`。
- `RelayLink.start()` 非幂等 → 孤儿连接泄漏；加 re-entry gate +
  stale-connection 守卫（29 条行为测试）。
- `artifactRules` 内层形状未校验（`{final:"dist/**"}` 字符串会按字符展开规则）
  → `normalizeArtifactRules`。
- `lib/index.js` 的 `export default apply` 让 loader 的 `unwrapExports`
  把命名空间折叠成函数 → `Config` 不可见、配置表单不显示。移除默认导出。

#### agent 模式假完成：消息 source 类型非法（DSH 静默拒绝）

**症状**：副机上 `mode: agent` 的任务在 ~20–40ms 内被标成 completed，
`liveText` 为空、`fromLogParts: 0`、产物 0 —— **且没有任何错误信息**。
`mode: exec` 完全正常。

**根因**：`PLUGIN_SOURCE` 用了 DSH **不认识**的 source 类型：

```js
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'dsh-remote-agent' })
```

DSH 的 `MessageSourceMap` 是一张**封闭的联合类型表**，17 种合法 kind
（`user` / `model` / `tool` / `system-prompt` / `model-selection` /
`user-approval` / `ptc-mode` / `tool-registry` / `user-rpc` / `agent-message` /
`subagent-settled` / `skill-invocation` / **`cordis-host-runner`** / `goal` /
`schedule` / `compact-checkpoint` / `session-reference` / `user-question-reply`）。

**里面没有 `plugin`。** 传非法 kind 时 `followup` 表面成功（消息进 inbox、
驱动被唤醒），但 turn 一启动就抛错 —— 而 DSH 的 `kick()` 是：

```js
async kick() {
  try { while (await this.turn()) }
  catch (_error) {}                      // <-- 静默吞掉
  finally { if (this.phase.kind === 'running') this.setPhase({ kind: 'idle', ... }) }
}
```

错误被吞、phase 转 idle → `whenIdle()` 立即返回 → 任务标 completed、产物 0。

**修法**：① 改用 `{ kind: 'cordis-host-runner' }`（DSH 为"cordis 宿主里的
runner 主动驱动 agent"准备的 kind）；② **加 `agent/error` 监听** —— 因为
`kick()` 吞错，这条事件是**唯一的错误出口**，漏了它任何 turn 内部错误都
完全不可见；③ 错误对象做深度序列化（第一版只取 `err?.message`，记到的是
`[object Object]`）。

**这条是怎么找到的**：加 7 个流程探针定位到"whenIdle 20ms 返回、零输出"，
然后用 **`cordis_inspect_query`**（`Service.listService` 查 `sessions` /
`agentLoop`）拿到 DSH 的**权威类型定义**，对比发现 `plugin` 不在表里。

**教训**：往 DSH 的封闭联合类型里塞自造值**不会立刻报错**，而是在某个被
`catch {}` 包住的深层位置静默失效。改这类常量前应先用 `cordis_inspect_query`
拿权威定义，而不是靠猜。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查返回值，返回 `undefined` 即判失败。
拒绝：类实例（原型不是 `Object.prototype`）、`undefined`、`NaN`/`Infinity`/`-0`、
循环引用、数组带额外属性。我们踩到的是**类实例**（副机回传的 `accepted` 带类原型）。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 number/object 的字段不是该类型。触发场景很常见：查一个**刚创建、
还没开始执行**的任务（`startedAt`/`endedAt`/`durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口 ——
`toPlainJson(dropNullForSchema(value, schema))`。7 个工具返回值形态各异，
逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。顺序不能反
（`dropNullForSchema` 把 null 转成"缺失"，`toPlainJson` 会丢弃 undefined）。
源头同时修了 `views.js`（时间字段用 0 兜底、`manifestCounts` 用 `{}`）。

**测试**：`test/tool-output-plain.test.js`（19 条）。它还**抓到了实现里的一个
bug**：第一版 `toPlainJson` 把 `null` 也当 `undefined` 吞掉了（会让值为 null
的字段静默消失）。

### 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**。要点：

- **副机 agent 后端的"假完成"已修**（`PLUGIN_SOURCE` 类型非法，见上）。
  修复版已在副机实测验证；但**"修复后 agent 能否真正产出"尚未端到端确认** ——
  待下一次实机验证。
- **headless 后端修复后尚未实机验证**（它需要副机没有 `agentLoop` 服务才会走到）。
  本次只做了静态断言 + 判别力验证，`dsh headless -`（stdin）路径未经真机跑通。
- Windows 8.3 短名绕过向量未验证。
- `lib/hub/index.js` 一处已知冗余（`ctx.effect` 的 `once()` 包装）。
- 平台分支的实测覆盖不均：Windows 全量验证，POSIX 分支只跑过 CI。

---

## 版本号约定

- **0.x**：`lib/**` 是加载产物，任何变更都可能是行为变更。升级前读本文件。
- 破坏性变更（配置字段重命名/移除、协议版本号变化）→ 升 minor 并在
  本文件顶部用 `### 破坏性变更` 标注。
- 协议版本号在 `lib/protocol.js` 的 `PROTOCOL_VERSION`。**主副机版本不一致时
  以协议版本号为准**，不要求包版本一致。
