# dsh-remote-agent

[![CI](https://github.com/zbzbhs/dsh-remote-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/zbzbhs/dsh-remote-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19%20%7C%7C%20%3E%3D24-green)
![dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

**简体中文** | [English](README.en.md)

把另一台电脑变成你 DSH 的**远程 Agent 同事**。

副机拥有自己的 DSH 与独立 Agent 循环，任务在它本地持久运行；主电脑只拿到
**handoff 结果卡**与**产物清单**，成品要显式拉取才过河。

```
┌─────────────── 主电脑（hub）────────────────┐
│  DSH · 模型 · 会话日志 · 全部凭证            │
│  ┌─ dsh-remote-agent ─────────────────────┐ │
│  │ 24 个 remote_* 工具 + Web 面板          │ │
│  └────────────────────────────────────────┘ │
└──────────────────▲──────────────────────────┘
                   │ 节点主动拨入（direct / relay）
┌──────────────────┴──────────────────────────┐
│  ┌─ 副电脑（worker）───────────────────────┐ │
│  │  独立 Agent 循环 · 独立模型上下文        │ │
│  │  D:\work\**  中间产物留在这里            │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

| | |
|---|---|
| **状态** | 0.10.1 —— 任务委派、真实自检、双向文件、桌面截图与后台管理；CI 覆盖 Windows / macOS / Linux |
| **DSH** | 桌面版 / CLI，0.2.0-rc.2 验证 |
| **平台** | Windows（全量验证）· Linux / macOS（CI 覆盖）|
| **依赖** | **零外部 npm 依赖** —— 只用 `node:` 内置模块 |
| **Node** | `^22.19.0 \|\| >=24.0.0` |
| **测试** | 1090 项（1087 pass / 3 skip）· 134 条文档漂移断言 · eslint 严格档 |

**Web 面板**（侧栏「远程同事」）：节点列表（含 CPU/内存徽章）、派发任务、
任务状态、结果摘要、工作区变更、成品清单、日志尾巴、**环境体检**、
**工作区共享（SMB）**、模型下拉。

> **开箱即用**：装完重启 DSH 就能用。包内 patch 默认 `role: auto`（没配
> `hubUrl` 就是主机），自动生效。
>
> **副机连的是插件自己的端口，不用改 DSH 的任何配置。** 0.9.3 起本插件自己
> 开一个独立监听（默认 **19387**），副机直接拨这个端口 —— **不再依赖
> `webserver`**，也就不用去 `cordis.patch.yml` 里填 host。
>
> 绑哪个地址是自动选的：`listenHost`（如果你填了）> Tailscale IP >
> 局域网 IP > 回环。想指定就配 `listenHost: '100.x.x.x'`；
> **`0.0.0.0` 一律拒绝**（新版 DSH 硬拒通配地址，绑了会让 DSH 启动崩溃）。
> 详见下方「安装」。

<p align="center">
  <img src="docs/screenshots/panel-main.png" width="720" alt="Web 面板：节点、派发表单、任务列表">
</p>

<p align="center">
  <img src="docs/screenshots/panel-task-detail.png" width="720" alt="任务详情：结果摘要、工作区变更、成品清单">
</p>

---

## 五分钟上手

按你的动手能力选一条路线，**每条都通向同一个终点**：

| 路线 | 主机 | 副机 | 适合 |
|---|---|---|---|
| **① 零终端**（Windows） | 双击 `bin/setup.cmd` → 回车 → Web 面板「副机接入」复制配对码 | 双击同一文件 → 粘配对码 → 回车自动写盘 | 见到黑窗口就慌 |
| **② 向导**（推荐） | 终端跑向导 → 回车确认写盘 | 同左，粘配对码 | 会开终端 |
| **③ 手动** | 参照下文配置节手写 | 手写（`inject: []` 必加） | 想完全掌控每行 |

任一路线完成后：**两台重启 DSH**，对主机说一句「副机上有哪些节点在线？」——
在线即通。出问题跑 `--doctor` 体检，每项 ✗ 都带怎么修。

```bash
node bin/dsh-remote-setup.js
```

> **Windows 不想开终端？** 在插件的 `bin/` 目录里**双击
> `setup.cmd`** —— 打开的窗口里全程回车即可。
> 插件装在 `%USERPROFILE%\.dsh\dsh_orb\dsh-plugin\dsh-remote-agent\bin\`。

1. **主机上跑**：选「1=主机」→ 向导自动找本机局域网 IP、生成 `nt_` 强随机
   `nodeToken`、输出**副机配对码**（一行 `dshra1://…`）与两台机器的完整 YAML
   （含**防火墙放行命令**）。
2. **副机上跑**：选「2=副机」→ **直接粘贴主机给的配对码**（或手抄地址与
   token）→ 向导会**先探活主机端口**，然后生成副机配置。最坑的 `inject: []`
   已替你填好（不填它副机会永远静默不上线）。副机配置里也可以只写一行
   `pair: '<配对码>'`，运行时自动展开成地址与 token（显式配置优先，写
   `hubUrl:` 可临时覆盖）。
3. 两台重启 DSH，对主机说一句「**副机上有哪些节点在线？**」—— 在线即通。
4. **免终端路径（图形界面）**：打开主机的 Web 面板 →「**副机接入**」按钮 →
   一键生成并复制配对码（含防火墙放行命令）。主机面板派任务时也可在
   「模型」栏指定副机用的模型（留空用副机默认）。
5. 出问题就体检（读取配置文件逐项检查，每项 ✗ 都带怎么修）：

```bash
node bin/dsh-remote-setup.js --doctor 你的配置.yml
```

不想交互？一条命令直接生成：`--role worker --hub-url 192.168.1.10:19387
--token nt_xxx --roots D:\work --node-id slave-pc`。

---

## 功能

### 一、把任务派给副机

| 功能 | 说明 |
|---|---|
| **两种任务模式** | `exec` 直接跑命令（`D:\work` 里 `npm run build`、`git pull`、批量重命名）；`agent` 让副机起**独立 Agent 会话**，它自己规划、调工具、写文件 |
| **两阶段审批** | `exec` 默认挂起等确认（`approval: 'manual'`）——等不到人不执行。防止 AI 误派危险命令 |
| **dry-run 预览** | 派发前先看"会路由到哪台、用哪个模型、在哪个目录跑、预计什么产物"，不真派 |
| **仓库感知调度** | 副机上报它 `roots` 下的 git 仓库（名字 + 远端 url），`remote_task({repo: 'my-project'})` 自动找有那个仓库的副机 |
| **负载感知路由** | 副机每 30s 上报 CPU/内存/负载；不指定节点时按负载挑一台 |
| **模型选择** | 面板从副机自述的**可用模型清单**里下拉选（不用猜 provider/model 名）；headless 后端不支持指定模型时**派发前就拦**，不用等跑到副机才失败 |
| **超时按模式区分** | `exec` 默认 10 分钟（失控命令不该占机一小时）；`agent` 默认 1 小时 |
| **并发上限** | 副机 `maxConcurrent`（默认 4）限制同时跑几个任务；超出的排队，`remote_status` 能看到排队数与最久等待 |

### 二、拿结果，但不搬整个工作区

| 功能 | 说明 |
|---|---|
| **handoff 结果卡** | 任务结束回一张卡：结果摘要 + 工作区变更 + 成品清单 + 退出码。**不是把整个目录传回来** |
| **产物三分类** | 工作区文件按 `final` / `intermediate` / `other` 分类，**只有 `final` 能拉**。日志、缓存、`node_modules` 全留在副机 |
| **显式拉取** | 要哪个文件用 `remote_pull` 单独拉，支持 glob 过滤 |
| **断点续传** | 拉到一半掉线不从头重传：已收字节保留，重试从中段续（`startOffset` + `prefixSha256` 校验）|
| **变更 diff 视图** | 任务前后对比工作区，看清它到底改了哪些文件、增删多少字节 |

### 三、直接翻副机的文件（不占任务队列）

四个**只读**工具，走独立的 `fs/req`↔`fs/res` 帧 —— **不进任务队列、不占并发槽**。
副机正跑长任务堵着队列时，这些依然秒回：

| 工具 | 用途 |
|---|---|
| `remote_ls` | 列目录（单层、分页） |
| `remote_read` | 读文件（文本按行分段；二进制只回元数据） |
| `remote_grep` | 副机**本地**全文搜索（纯 JS，不 spawn 进程） |
| `remote_tree` | 目录树摘要（扫描在副机跑完，只回结构） |

安全边界：路径必须在该节点 `roots` 内、`denyPaths` 生效、符号链接只列条目不解引用。

### 四、用本地 IDE 打开副机的文件（SMB 共享）

面板上「工作区共享」区：把副机工作区通过 SMB 共享出去，主机
`net use X: \\副机\dsh-work-...` 映射成盘符 —— 可以用本地 VS Code 直接打开。

> **⚠ 这会绕过本插件的安全边界**（`roots` / `denyPaths` 失效、中间产物与密钥
> 对主机可见、新增凭证面）。需要**二次确认**，默认**只读**。
> 完整风险与用法见 [docs/workspace-share.md](docs/workspace-share.md)。

### 五、出问题能自己诊断

| 功能 | 说明 |
|---|---|
| **环境体检** | 面板一键体检 8 项：角色配置、`inject` 依赖、**Web 服务是否绑在可达地址**、端口、防火墙、`roots` 是否存在、Tailscale、副机在线。**每条都给具体修法**，能自动修的标出来 |
| **一键修复** | 机械可判定的项（`webserver` host、`role`）可以**预览后一键修**。见下面「七、一键修复」 |
| **错误翻译成人话** | `ECONNREFUSED` / `401` / `timeout after 40000ms` 这类原始错误统一翻译成「哪里没对 + 下一步做什么」。覆盖 errno、**17 个协议错误码**、HTTP 状态、文案特征 |
| **连接失败可见** | 记录**每一次**副机连接尝试（成功/失败 + 原因 + 时间 + 远端地址）。面板直接显示「最后尝试 2 分钟前 —— 握手超时 → 检查…」，并区分**从没连过** / **连过又断了**（排查方向完全不同）|
| **外部工具检测** | 一键探测 Tailscale / PowerShell / git / Node.js 在不在，缺了告诉你「为什么需要 + 安装命令 + 官方链接」。见下面「八、外部工具」 |
| **可达性自检** | 启动时检查端点是否绑在 loopback —— 绑了副机永远连不上，且主机侧毫无异常。绑了会打明确 warn + 面板红色横幅 |
| **队列健康快照** | 副机随资源帧上报 `queued` / `running` / `maxConcurrent` / 最久等待；堵死时面板与 `remote_nodes` 都会警告 |
| **面板「运行中」分组** | 运行中的任务置顶，显示**已跑多久**，并直接显示**最近一步在干什么**（`最近：调用工具 Write · 共 23 步`）—— 不用展开详情 |
| **取消真打断** | `remote_cancel` 真的中止 agent 循环（不只是置个标志等它自己跑完）|
| **审计日志** | 派发/取消/拉取/审批全部留痕（`~/.dsh-remote-agent/audit.jsonl`，可轮转）|

### 六、断连、跨网、安全

| 功能 | 说明 |
|---|---|
| **断连不终止任务** | 中继挂了、主机重启了，副机照跑；重连后 `task/sync` 自动对账，**已完成的不重跑** |
| **两种传输** | `direct` 直连（同一局域网/Tailscale）；`relay` 中继（双方都在 NAT 后，需要一台 VPS）|
| **端到端加密** | relay 模式业务帧 X25519 + AES-256-GCM；中继只看得到路由信封 |
| **主机身份验证** | 副机验主机：hub 持久 ed25519 身份 + 配对码携带指纹，首连 TOFU 钉住 |
| **凭证不离开副机** | 协议里不带任何模型 key；副机用自己的模型配置跑自己的循环 |
| **零 npm 依赖** | 只用 `node:` 内置模块，无构建步骤，`lib/` 就是产物 |

### 七、一键修复（会改 DSH 的配置，所以有两步确认）

副机连不上的**最常见原因**是：`webserver` 绑在 `127.0.0.1`，或者 `remote-agent`
的 `role` 没写对。这些是**机械可判定**的，可以自动修。

但 `cordis.patch.yml` 是 DSH 自己的配置文件，改它有风险 —— 所以流程刻意做成两步：

```
[预览修复]  → 只读。列出"将要改什么" + "不会做什么"
[确认修复]  → 才写盘（必须带 confirm: "yes"）
```

**护栏**（每一条都对应一次真实事故）：

| 护栏 | 防的是什么 |
|---|---|
| **只改托管块** | `# --- dsh-remote-agent (managed) ---` 之间；你手写的其它条目**一个字节不碰** |
| **写前必备份** | `.bak-<时间戳>`，随时可回 |
| **写后必校验** | 重新解析，确认条目在、**没有重复 id**（同 id 会挂载两次导致启动失败）|
| **失败必回滚** | 保留备份并提示用「撤销」 |
| **可一键撤销** | `action: 'undo'` 用备份覆盖回去 |
| **绝不用 `0.0.0.0`** | 新版 DSH **硬拒绝**通配地址，会直接启动崩溃（我们踩过，10 份 crash 日志）。地址自动选 Tailscale / 私网 IP |

**只修机械可判定的项**。端口占用、防火墙、装软件、模型凭证这些**需要人判断**的，
只给建议不动手。

### 八、外部工具检测（只告诉你缺什么，不代下载）

有些工具**缺了会静默失败**，而错误表现完全不像"缺个工具"：

| 工具 | 缺了会怎样 |
|---|---|
| **Tailscale** | 跨网时副机连不上，而错误表现只是"连接超时" —— 很难想到是缺个 VPN 工具。同一局域网可以不用 |
| **PowerShell** | Windows 上 SMB 共享、部分 `exec` 任务依赖它。缺了表现为"命令找不到" |
| **git** | 仓库感知调度（`remote_task` 的 `repo` 参数）失效，但用户不知道为什么 |
| **Node.js** | 副机的 headless 后端要独立 node 才能 spawn 子进程，缺了 agent 模式退化 |

面板「检测工具」一键探测，缺的项给你**为什么需要 + 可复制的安装命令 + 官方下载页**。

> **为什么不代下载？**
>
> 零 npm 依赖是核心卖点；而代下载第三方二进制会让我们变成软件分发方 ——
> 装哪个版本、从哪下、校验和怎么保证、装失败算谁的、供应链攻击面，全落在我们头上。
> 所以只做「探测 + 告诉你命令」，执行权在你。

### 九、文件写入与进程诊断（会改副机状态，所以必须确认）

前四个文件工具全是**只读**。这一组会**改副机**，所以都要求 `confirm: "yes"`。

**写操作**（`remote_write` / `remote_mkdir` / `remote_move` / `remote_delete`）：

| 护栏 | 说明 |
|---|---|
| **默认不覆盖** | 目标已存在直接拒绝，要覆盖必须显式 `overwrite: true` —— 防"AI 手滑清空已有文件" |
| **不递归删除** | 只删**单个文件或空目录**；非空目录一律拒绝。真有需要请用 `exec` 显式删除（那是可查的命令）|
| **原子写** | 临时文件 + rename，失败不留半截文件 |
| **8MB 上限** | 防一次写入把副机磁盘写满（副机是常驻进程，磁盘满会让任务/日志/状态全失败）|
| **roots 护栏** | 目标与**父目录**都必须在 roots 内（防软链逃逸）；`denyPaths` 同样生效 |

**进程诊断**（`remote_ps` / `remote_port` / `remote_kill`）：

- `remote_ps` / `remote_port` **只读** —— 排查「端口被谁占了」「那个卡住的进程还在不在」
- `remote_kill` **不可逆**，三道护栏：
  1. 必须 `confirm: "yes"`
  2. **拒绝杀本插件进程与其父进程** —— 否则副机失联，你会彻底失去远程修复能力
  3. **拒绝杀系统关键进程**（System / csrss / wininit / services / lsass 等）

### 十、真实环境自检与派单前门禁

`remote_selfcheck` 不只检查“进程活着”：它会在每个工作区 root 里真实写入、读取并删除
探针文件，检查 runner 与能力声明；GUI 用途还会实际截取一张图。返回结构化
`checks[]`、`verdict`、`blockingFailures`，每项带具体修法。

新版节点在 `remote_task` 和 subagent 派单前会默认重新自检；失败时任务不会进入队列。
旧节点没有 `selfcheck` 能力时自动跳过，也可用 `precheck: false` 显式关闭本次检查。

### 十一、后台代理管理与会话级开关

- `remote_agents`：`list` 看任务，`status` 取单条视图，`wait` 等终态并返回 handoff；复用同一套任务真身，不另造状态源。
- `remote_interrupt`：与 `remote_cancel` 同义，取消任务及在途拉取。
- 可选 `sessionGate: true`：每个会话默认禁用 `remote_*` 和 `remote-agent` 子代理委派，用户输入 `/remote-agent on` 才开启，`off` 关闭，`status` 查询；`remote-use` 是命令别名。授权只存在内存中，重启即失效。默认 `false`，保持旧配置行为不变。

### 十二、双向文件互传与桌面截图

`remote_file` 统一提供 `stat` / `send` / `fetch`：

- 单文件最大 **512MiB**，按 **256KiB** 分块；上传带 offset 重对齐、完整 SHA256 和原子 commit，下载先写 `.part`，校验通过才 rename。
- 副机侧仍严格受 `roots` / `denyPaths` 约束，不跟随符号链接逃逸，默认不覆盖。
- **上传到副机必须 `confirm: "yes"`**；下载到主机使用独占创建，已存在的目标不会被覆盖。

`remote_screenshot` 在 Windows 副机捕获完整虚拟桌面，返回 PNG 元数据、保存路径与 SHA256；
图片分块经既有 E2E 通道传输，临时截图有大小、数量和 TTL 上限。非 Windows 节点会明确报告不支持。

### 工具速查（共 24 个）

| 类别 | 工具 |
|---|---|
| **节点** | `remote_nodes`（列表 + 负载 + 队列 + 模型清单）|
| **任务** | `remote_task`（派发，支持 fresh gate）· `remote_status`（查进度）· `remote_cancel` / `remote_interrupt`（取消）|
| **后台管理** | `remote_agents`（list / status / wait）· `remote_selfcheck`（真实环境自检）|
| **审批** | `remote_task` 的 `approval: 'manual'` 会挂起 → 面板或工具批准/拒绝 |
| **结果** | `remote_handoff`（结果卡）· `remote_manifest`（产物清单）· `remote_pull`（拉成品）· `remote_purge`（清理）|
| **文件（只读）** | `remote_ls` · `remote_read` · `remote_grep` · `remote_tree` |
| **双向文件与桌面** | `remote_file`（stat / send / fetch）· `remote_screenshot`（Windows）|
| **文件（写入）** | `remote_write` · `remote_mkdir` · `remote_move` · `remote_delete` —— **必须传 `confirm: "yes"`**；默认不覆盖、不递归删 |
| **诊断** | `remote_ps`（列进程）· `remote_port`（查端口占用）· `remote_kill`（杀进程，**不可逆**，须 `confirm: "yes"`）|

---

## 核心不变式

这几条是这个包的设计前提，改动前请先读：

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后自动对账 |
| **中继只见密文** | relay 模式业务帧端到端加密（X25519 + AES-256-GCM，见 [SECURITY.md](SECURITY.md)）：中继只看得到路由信封（`t`/`id`/`to`/`from`），goal 与成品内容全部密文 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要 `remote_pull` 才传输 |
| **只有 `role:final` 过河** | 日志/缓存/中间构建文件只在副机留存，仅上报元数据 |
| **断点续传** | `remote_pull` 途中掉线/超时不从头重传：已收字节保留，重试自动从中段续传，全文 sha256 校验照旧 |

---

## 安装

### 主机（hub）—— 装完即用

```bash
# 通过 DSH 插件安装器（GitHub 源）
dsh plugin add github:zbzbhs/dsh-remote-agent

# 或通过 npm
npm install -g dsh-remote-agent
```

或在 DSH 的插件对话框里填 `github:zbzbhs/dsh-remote-agent`。

**装完重启 DSH 就能用**：

- 包内 patch 默认 `role: auto`。**没配 `hubUrl` 就是主机**，自动生效。
- 打开 Web 面板「远程同事」，点「副机接入」生成配对码，发给副机。

**不需要改 DSH 的 `webserver`。** 0.9.3 起插件自己监听一个端口（默认 19387），
副机拨的是它，不是 DSH 的 Web 端口。历史上那套"去 patch 里给 webserver 填一个
具体 host"的做法**已经作废** —— 它还有个副作用：DSH 每次启动都会重写 patch，
填进去的 `webserver` 段会被删掉（实测 15 条配置剩 3 条）。

**想指定绑哪个地址**（多数情况不用，自动选的就是对的）：

```yaml
- id: remote-agent
  config:
    listenHost: '100.x.x.x'   # 可选：留空=自动（Tailscale > 局域网 > 回环）
    listenPort: 19387         # 可选：默认 19387；填 0 = 关闭独立监听
```

**自动选的顺序**是 `listenHost`（填了就用它）→ Tailscale IP（`100.64.0.0/10`）
→ 局域网私网 IP → 任意非回环 → `127.0.0.1`。

**怎么查自己的地址**：

- 跨网（推荐）：`tailscale ip -4` —— Tailscale IP 固定不变、跨网可达
- 同一局域网：`ipconfig` 看 WLAN/以太网那块网卡的 IPv4

> ⚠ **`listenHost` 不能写 `0.0.0.0`**（`::` 也不行）。新版
> `@deepseek-ai/dsh-host-webserver` 在 schema 校验阶段就硬拒绝通配地址：
>
> ```
> host "0.0.0.0" is an unspecified (wildcard) address, which is not supported:
> binding every interface would expose remote code execution to the network;
> bind one concrete IPv4 or IPv6 address of a local interface instead
> ```
>
> 本插件自己开端口，同样**主动拒绝**通配地址：填了会退回自动选择，而不是
> 把端点暴露到所有网卡。
>
> 面板的「环境体检」会检查独立监听有没有起来、绑在哪、副机能不能拨进来；
> 连不上时按提示修（每条 ✗ 都带具体怎么做）。

> **安全策略：`nodeToken` 为空时不暴露到网络。** 没有入网口令的开放在公网/
> 局域网里等于把 RCE 送人。这种情况下插件只绑 `127.0.0.1`（本机 both 模式
> 仍可用），面板会显示一条**黄色**提示告诉你去点「生成口令」。生成后重启
> DSH 即恢复可达地址 —— 想强行对外就显式填一个非回环的 `listenHost`。

### 副机（worker）—— 贴个配对码就行

**同一份包**，装完重启 DSH，然后：

1. 打开 Web 面板「远程同事」
2. 把主机生成的 `dshra1://…` 整行**粘进「配对码」框**（自动解析地址与 token）
3. 工作区已预填（Windows `D:\work`，其他 `~/work`），**目录不存在会自动创建**
4. 点「确认，写入配置」→ 重启 DSH

**为什么贴完就自动变副机**：`role` 默认 `auto`，判据是"配了 `hubUrl` 就是副机"。
配对码展开后必然产出 `hubUrl`，所以贴码 = 自动切到 worker。

**节点 ID 不用填** —— 默认取主机名。想自定义就点「默认用主机名（点此自定义）」展开。

如果你想手工写 YAML（不推荐，但可以）：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: ['tools', 'agentLoop', 'sessions']   # ← 副机必须用这三个
  config:
    role: worker
    pair: 'dshra1://eyJ2IjoxLC…'   # ← 主机面板输出的整行
    roots: ['D:\work']             # ← 副机真实存在的目录（会自动创建）
```

> **为什么副机的 `inject` 和主机不同**
>
> `inject` 决定**这个插件能看见哪些 DSH 服务**，而 agent 的 ctx 继承插件
> 的依赖声明 —— 少了 `tools`，副机的 agent 就**没有任何 shell/文件工具**，
> 任务会"跑完了但什么都没干"。
>
> - hub 需要 `webServer`（注册路由）+ `tools` + `systemPrompt`
> - worker 需要 `tools` + `agentLoop` + `sessions`（起 agent 会话）
>
> 面板的「切换角色」会自动写对这一个字段，**不用自己记**。
> （历史坑：早期文档教用户写 `inject: []`，那是错的 —— 会导致 agent 无工具。）

> **配对码的两条规矩**
>
> 1. **它内含 token，等同凭证** —— 当面或加密聊天传，不要贴公开群。
> 2. **`roots` 不在配对码里** —— 副机能操作哪些目录是副机自己的安全
>    边界，永远由副机配置声明，主机侧的串决定不了它。
>
> 显式配置优先：`pair` 与 `hubUrl` 同时存在时 `hubUrl` 生效，方便临时换地址调试。
> 配对码坏了不会让副机起不来 —— 只记一条警告并按未配置处理（`--doctor` 会报）。

> **hub 身份认证（默认开启）**：副机也会验主机。hub 首次启动生成持久身份
> （指纹 `hubfp1-…`，落 `~/.dsh-remote-agent/hub-identity.json`），配对码
> 自动携带指纹 —— 副机粘码即完成首连钉住（TOFU，状态在副机
> `~/.dsh-remote-agent/hub-pin.json`）。手动配置可写
> `pinnedHubFingerprint: hubfp1-…` 显式钉住；之后指纹不匹配 = 拒绝上线并
> 停止重连（确认主动换 hub 后删 `hub-pin.json` 重启即可重新钉住）。
> 详见 [SECURITY.md](SECURITY.md) 检查清单第 7 条。

**接入路径**（双方都在 NAT 后 / 一方有公网 / 隧道）见
**[profiles/README.md](profiles/README.md)** —— 那里有每条路径的配置片段与验证命令，
以及一条**降级链**：能直连走 direct，不通就降级到中继 VPS 或 cloudflared 隧道；
链路全断时副机本地续跑、重连自动对账。中继的 VPS 部署模板（含 TLS 前置）
在 [deploy/relay-vps/](deploy/relay-vps/)。relay 模式下业务帧走**端到端加密**
（中继只见密文，明文 goal/成品不流经中继；握手由副机主动发起，5 秒内无
ack 自动按明文兼容旧中继继续），安全边界与已知局限见
[SECURITY.md](SECURITY.md)。

---

## 用法

装好后**不需要记命令**，直接说话：

| 你说 | agent 调用 |
|---|---|
| 「副机上有哪些节点在线？」 | `remote_nodes` |
| 「让副机在 D:\work 里跑一下测试」 | `remote_task` |
| 「那个任务怎么样了？」 | `remote_status` |
| 「给我个汇总」 | `remote_handoff` |
| 「有哪些成品？」 | `remote_manifest` |
| 「把 report.pdf 拉过来」 | `remote_pull` |
| 「取消那个任务」 | `remote_cancel` |
| 「看看副机 D:\BigData 里有什么」 | `remote_ls` |
| 「读一下副机上那个 config.json」 | `remote_read` |
| 「在副机 50GB 目录里搜这个词」 | `remote_grep` |
| 「副机那个文件夹结构长什么样」 | `remote_tree` |

另有一个 Web 面板（侧栏「远程同事」）：节点列表（含 CPU/内存/负载与仓库清单）、
派发任务、**待审批卡**（exec 任务默认挂起，批准才下发）、任务状态、结果摘要、
工作区变更、**变更 diff**（文本文件改动的 unified diff）、成品清单、日志尾巴。

> **队列堵死有告警**（2026-10-17 实测事故的防线）：副机每 30s 随资源遥测上报
> 队列健康（排队数 / 并发占用 / 最久等待）。当"有排队且并发占满且最久已等
> 超 2 分钟"时，`remote_nodes` 会在该节点行打 ⚠ 堵死告警并给出下一步动作
> （remote_status 逐条查、remote_cancel 释放并发槽）。默认并发已从 2 提到 4，
> 一条慢 exec 的默认超时也从 1 小时收紧到 10 分钟 —— 单条慢命令锁死整台
> 副机的概率大幅降低。

### 工具速查

<details>
<summary><code>remote_task</code> 的参数</summary>

| 参数 | 说明 |
|---|---|
| `goal` | 任务目标。`mode=agent` 时是给副机 agent 的任务书；`mode=exec` 时是要执行的命令 |
| `node` | 目标节点 id。省略时自动选：多节点按在跑任务数/CPU/内存自动路由（agent 模式只选支持 agent 的节点） |
| `repo` | 按仓库路由：传仓库名 / 远端 url 片段 / 本机路径片段，任务派给持有该仓库的节点（多个时按负载自动选）。省略 `workspace` 时自动用仓库在本机的路径。副机接入后自动上报 roots 下的 git 仓库（凭证打码，每 10 分钟刷新） |
| `approval` | 两阶段审批：`manual`=挂起等面板批准后才派给副机（超时自动拒绝，fail-closed）；`auto`=立即派发。省略时 **exec 默认 manual、agent 默认 auto** |
| `dryRun` | 只出预览不派发：返回会派到哪个节点/工作区/模式，路由与校验和正式派发同一条路径 |
| `workspace` | 副机上的绝对路径，必须在节点 `roots` 内。省略用默认 |
| `mode` | `agent`（副机起独立 agent 会话，默认）/ `exec`（直接跑命令）|
| `model` | 可选。副机用的模型（仅 `mode=agent` 生效）：`{model:"deepseek-chat"}` 或 `{provider:"openai",model:"gpt-4o"}`。只传选择不传凭证 —— 副机用自己的 provider 配置跑。**headless 后端不支持指定模型**（派发前就会被拦，副机固定用默认模型）；`dryRun` 会回显解析后的模型与来源，副机的默认模型见 `remote_nodes` |
| `outputs` | 期望产出物的 glob（相对工作区），用于产物清单筛选 |
| `timeoutMs` | 副机侧超时。缺省按模式：**exec 10 分钟、agent 1 小时**（一条慢 exec 不该锁死副机一小时） |
| `denyPaths` | 额外禁止访问的绝对路径 |
| `artifactRules` | 覆盖内置产物角色判定，例如 `{ intermediate: ["build/**"] }` |

**`exec` 模式在 Windows 副机上跑的是 PowerShell** —— 用 `;` 分隔命令，
不要用 `&`（会被拒）。需要 cmd 语法时显式 `cmd /c "..."`。

</details>

### 读副机上的文件（不用配网盘）

四个只读文件工具（`remote_ls` / `remote_read` / `remote_grep` / `remote_tree`）
装完即有：AI 可以直接列目录、读文件、全文搜索、看目录结构 —— **不用配网盘、
不用挂载、不用 SMB**。扫描类操作（grep/tree）在副机本地跑完只回结果，
50GB 目录也不用搬数据。

<details>
<summary>文件工具的参数与边界</summary>

| 工具 | 参数 | 说明 |
|---|---|---|
| `remote_ls` | `path`（必填）、`limit`、`offset` | 列目录（单层分页，目录优先） |
| `remote_read` | `path`（必填）、`offset`、`limit` | 文本 ≤8MB 按行分段（单次 ≤256KB）；二进制只回 sha256+大小+头部预览 |
| `remote_grep` | `path`、`pattern`（必填）、`glob`、`regex`、`ignoreCase`、`maxMatches` | 副机本地全文搜索（纯 JS，不 spawn 外部命令）；上限 2000 文件 / 单文件 2MB / 命中 200 / 10 秒 |
| `remote_tree` | `path`（必填）、`depth` | 目录树摘要（深度 1-6，默认 3；条目 ≤2000） |

**边界（与任务链路同一条底线）**：**这一组是只读的**；路径必须是绝对路径
且落在该节点 `roots` 内，超出即拒（`workspace-denied`）；`denyPaths` 同样生效
（被禁条目连名字都不上报）；符号链接只列条目不解引用。文件操作走独立的
`fs/req`↔`fs/res` 帧，**不进任务队列、不占并发槽**，且在 relay 模式下与任务
帧一样**全程端到端加密**（中继只见密文）。

**与手工方案的组合**：要"AI 点读/搜索"用本组工具（零配置、跨网可用）；
要"资源管理器像本地盘一样翻大文件"，SMB/网盘仍是正解 —— 两者互补。

</details>

### 改副机上的文件（写操作，需确认）

上面四个是只读的。要**写**，用这四个 —— 它们都会**改副机状态**，所以
**必须传 `confirm: "yes"`**：

```js
remote_write  { path, content, overwrite?, confirm: "yes" }
remote_mkdir  { path, confirm: "yes" }
remote_move   { from, to, overwrite?, confirm: "yes" }
remote_delete { path, confirm: "yes" }
```

<details>
<summary>写操作的护栏（为什么它们安全得起来）</summary>

| 护栏 | 具体行为 |
|---|---|
| **默认不覆盖** | `remote_write` 遇到已存在文件**直接拒绝**。要覆盖必须显式 `overwrite: true` —— 这条防的是"AI 手滑清空你的配置文件" |
| **不递归删除** | `remote_delete` 只删**单个文件或空目录**。非空目录返回 `artifact-denied`，并告诉你"非空目录请用 exec 显式删除"。递归删除太容易造成不可逆损失，我们刻意不做 |
| **原子写** | 先写 `<file>.dshra-tmp-<pid>-<ts>` 再 `rename`。中途崩溃不会留下半截文件 |
| **8MB 上限** | 单次写入超过 8MB 直接拒（`artifact-too-large`）。副机是常驻进程，磁盘满会让任务、日志、状态文件全失败 |
| **roots 护栏（加强版）** | 只读工具的 `resolveAny` 要求路径**已存在**；写操作改用 `resolveWritable`：目标可以不存在，但对**它第一个存在的祖先**做 realpath 再校验 roots —— 这样既能新建文件，又防"roots 内的软链指向外面" |
| **父目录也校验** | 除了目标本身，它的父目录也必须 realpath 后在 roots 内 |
| **符号链接只删链接** | `remote_delete` 用 `lstat`，删的是链接本身，不会顺着链接把目标删掉 |

**跨盘移动会明确报错**（`EXDEV`），不做静默复制 —— 大文件会卡住，且语义不同
（复制不等于移动）。真要跨盘请用 `exec` 的 `cp` / `mv`。

</details>

### 排查副机上的进程与端口

远程排查时你不在副机前面，看不见任务管理器。这三个工具补上这一块：

```js
remote_ps   { node?, limit?, filter? }        // 列进程（只读）
remote_port { port }                          // 查端口占用（只读）
remote_kill { pid, confirm: "yes" }           // 杀进程（不可逆）
```

典型用法：

```
「副机上那个 node 进程还在吗？」     → remote_ps   { filter: "node" }
「19387 到底有没有在监听？谁占着？」 → remote_port { port: 19387 }
「把那个卡死的 PID 12345 杀掉」      → remote_kill { pid: 12345, confirm: "yes" }
```

<details>
<summary><code>remote_kill</code> 的三道护栏</summary>

杀错进程的后果可能很严重（副机上任务全崩，甚至把 DSH 自己杀掉导致彻底失联），
所以有三道独立护栏：

| # | 护栏 | 拒绝时的提示 |
|---|---|---|
| 1 | **必须 `confirm: "yes"`** | `杀进程需要显式传 confirm: "yes"（不可逆操作）` |
| 2 | **拒绝杀本插件进程与父进程** | `拒绝：这是本插件的父进程（通常是 DSH 本体，杀掉会让副机失联）` |
| 3 | **拒绝杀系统关键进程** | `拒绝：lsass 是系统关键进程，杀掉可能导致系统不可用` |

第 2 道最重要：如果 AI 把副机的 DSH 杀了，你就**彻底失去远程修复能力** ——
只能跑到那台机器前手动重启。这是最坏的结果，所以硬编码拒绝。

受保护的系统进程名（Windows）：`System` / `csrss.exe` / `wininit.exe` /
`winlogon.exe` / `services.exe` / `lsass.exe` / `smss.exe` / `svchost.exe` /
`dwm.exe` / `explorer.exe` 等。

> ⚠ 这些护栏防的是**误判**，不是恶意 —— 有管理员权限的人总能绕过。
> 它们的作用是让"AI 顺手杀错"这件事不会发生。

</details>

---


### 自检、后台等待、文件互传与截图

```jsonc
// remote_selfcheck：真实检查副机；GUI 用途会额外检查交互桌面
{ "node": "newland", "purpose": "agent" }

// remote_agents：等待既有任务，返回同一任务的 handoff
{ "action": "wait", "taskId": "task_xxx", "timeoutMs": 60000 }

// remote_file：主机 → 副机（必须确认）
{ "action": "send", "node": "newland", "localPath": "D:\\assets\\brief.pdf", "remotePath": "D:\\work\\brief.pdf", "confirm": "yes" }

// remote_file：副机 → 主机（目标已存在会拒绝）
{ "action": "fetch", "node": "newland", "remotePath": "D:\\work\\report.pdf", "localPath": "D:\\downloads\\report.pdf" }

// remote_screenshot
{ "node": "newland" }
```

会话级开关是可选配置，放在主机 `remote-agent` 的 `config` 中：

```yaml
sessionGate: true
# 之后在具体会话输入 /remote-agent on 或 /remote-agent off
```

### 想用本地 IDE 打开副机的文件？（SMB 共享）

面板上有「工作区共享（SMB）」区：把副机的工作区共享出去，主机
`net use X: \\副机\dsh-work-...` 映射成盘符，就能用本地 VS Code 直接打开。

> **⚠ 这会绕过本插件的安全边界**（`roots` / `denyPaths` 失效、中间产物与
> 密钥对主机可见、新增凭证面）。需要**二次确认**，且默认**只读**。
> 完整风险与用法见 **[docs/workspace-share.md](docs/workspace-share.md)**。

## 安全

**这个插件让主机能在另一台电脑上读写文件、执行命令、结束进程。** 部署前请读
**[SECURITY.md](SECURITY.md)**，尤其这几条：

1. **`nodeToken` 默认不校验** —— 公网部署**必须**配。留空只适用于完全可信的私网
   （Tailscale / 同机 / 可信 LAN）。
2. **传输不自带 TLS** —— 公网直连必须在前面放 TLS 反代，用 `wss://`。
3. **`roots` 是真正的安全边界** —— 只给任务需要的目录，不要给整个盘或用户 home。
4. **写操作会改副机文件** —— `remote_write` / `remote_mkdir` / `remote_move` /
   `remote_delete` 都要求 `confirm: "yes"`；默认不覆盖、不递归删。如果副机上
   有**不该被 AI 改**的东西，用 `denyPaths` 明确挡掉，或者干脆不给那个目录 roots。
5. **`remote_kill` 会结束进程** —— 同样要求 `confirm: "yes"`，并硬编码拒绝
   杀本插件进程、父进程（通常是 DSH 本体）与系统关键进程。
6. **SMB 共享会绕过上面全部边界** —— 开启后 `roots` / `denyPaths` 全部失效
   （Windows 内核直读，插件拦不住）。默认只读，且需要二次确认。

### 本插件主动放宽边界的四处（都在这里，别处没有）

| 能力 | 放宽了什么 | 补偿措施 |
|---|---|---|
| **写操作**（4 个工具）| 从"只读"到"可改文件" | `confirm` 必填 · 默认不覆盖 · 不递归删 · 原子写 · 8MB 上限 · roots + 父目录校验 |
| **进程诊断**（`remote_kill`）| 从"只读"到"可结束进程" | `confirm` 必填 · 拒杀自身/父进程/系统进程 |
| **双向文件与截图** | 可传 512MiB 文件、可读取桌面图像 | roots/denyPaths · 上传 confirm · 完整 hash · 原子落盘 · 截图 TTL/数量/大小上限 |
| **SMB 共享** | `roots` / `denyPaths` **完全失效** | 默认只读 · 二次确认 · 明确文档说明风险 |

除此之外，插件不做任何越界的事。

---

## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口（角色分发器：`role: auto` / `hub` / `worker` / `both`） |
| `lib/hub/**` | 主机侧：节点注册表、**24 个工具**、subagent provider、UI 路由、环境体检 |
| `lib/hub/views.js` | **投影共享层** —— 工具与 UI 用同一份字段白名单 |
| `lib/node/**` | 副机侧：拨入、任务引擎、产物服务、exec/agent 双后端、SMB 共享、文件读写、进程诊断 |
| `lib/env-check.js` | 环境体检（命令行与面板共用一份逻辑） |
| `lib/auto-fix.js` | 一键修复（只改托管块 + 备份 + 写后校验 + 可撤销） |
| `lib/explain-error.js` | 错误翻译层（errno + 17 个协议码 + HTTP + 文案特征 → 人话 + 下一步） |
| `lib/external-tools.js` | 外部工具检测（Tailscale/PowerShell/git/Node，只给命令不代下载） |
| `lib/listen-server.js` | 独立监听端口（副机拨入，不依赖 DSH 的 webserver 配置） |
| `lib/instance-config.js` | 独立配置文件（`~/.dsh-remote-agent/instance.json`，抗 DSH 重写） |
| `lib/client.js` | 浏览器半边（Web 面板） |
| `lib/protocol.js` | 线协议（帧类型、错误码、`PROTOCOL_VERSION`） |
| `lib/e2e.js` | 中继链路端到端加密（X25519 握手 + ed25519 认证 + AES-256-GCM 帧封） |
| `lib/setup.js` + `bin/dsh-remote-setup.js` | 小白向导（配置生成 / doctor 体检 / 连接错误人话翻译） |
| `lib/relay.js` + `bin/dsh-remote-relay.js` | 中继（NAT 场景的会合点） |
| `profiles/**` | 部署档案与配置片段 |
| `scripts/**` | 中继初始化（systemd / 计划任务）+ 质量检查脚本 |

---

## 开发

```bash
npm install     # 只为验证 lockfile；本包零外部运行时依赖
npm run check   # 打包自洽性 + 文档漂移 + 全部测试
```

**没有构建步骤。** `lib/**` 里的 `.js` 就是 DSH 实际加载的产物（纯 ESM，无转译）。

改代码前请读 **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 那里记了几个
**会静默失败**的陷阱（工具返回值出边界、cordis 生命周期、`ctx.get()` 的必要性）。

> `node --test test/`（目录形式）在 Node 24 下会把目录当模块入口，必然失败。
> 用 `npm test`。Windows 的 PowerShell 不展开 glob，也别直接传 `test/*.test.js`。

### 质量防线

| 层 | 命令 | 内容 |
|---|---|---|
| 打包自洽 | `npm run check:packaging` | `files`/`exports`/`bin`/`dsh.bundle.patch` 指向的路径必须存在 |
| 文档漂移 | `npm run check:docs` | 102 条断言，锁住文档与代码的关键约定 |
| 行为测试 | `npm test` | 652 条 |

---

## 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** —— 记录了**刻意不做**的项、
**待补验**的项、以及排查方法论。要点：

- 副机 `agent` 后端不工作（`exec` 正常）—— 待定位
- Windows 8.3 短名绕过向量未验证
- POSIX 分支的平台实测覆盖不足（只跑过 CI）

---

## 更新日志

见 **[CHANGELOG.md](CHANGELOG.md)** —— 含每个修复的**根因分析**。
0.x 期间 `lib/**` 是加载产物，任何变更都可能是行为变更，升级前请读。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
