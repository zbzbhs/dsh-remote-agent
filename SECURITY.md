# 安全策略

这个插件**在两台机器之间建立执行通道** —— 主机可以在这台机器之外的电脑上
读写文件、执行命令。所以它的安全边界值得认真对待，而不是"装个插件而已"。

---

## 报告漏洞

**不要开公开 issue。** 请用 GitHub 的
[Private vulnerability reporting](https://github.com/zbzbhs/dsh-remote-agent/security/advisories/new)，
或发邮件到仓库 owner 的 GitHub 邮箱。

请附：

- 受影响的版本（`node_modules/dsh-remote-agent/package.json` 的 `version`）
- 角色与传输方式（`config.role` / `transportMode`）
- 复现步骤（**不要**附带真实凭证或他人数据）
- 你判断的影响范围

我会在 **7 天内**确认收到，并在修复发布后致谢（除非你要求匿名）。

---

## 威胁模型

### 部署形态

```
主机（hub）  ──ws──▶  副机（worker）
  派任务                 在 roots 内执行
  收 handoff
  按需 pull 成品
```

**relay 形态**（双方都在 NAT 后，见 [profiles/README.md](profiles/README.md) 的降级链）：
hub 与 node 都主动拨入中继，中继按 nodeId 双向转发。

**信任假设**：

| 假设 | 说明 |
|---|---|
| 主机是可信的 | 主机能派任意任务给副机。**不要把副机接到你不信任的主机。** |
| 副机是可信的 | 副机上报的 handoff 会进主机的模型上下文。**不要把主机接到你不信任的副机。** |
| 传输通道可能被窃听 | `direct` 模式的默认配置是**明文 ws://**。见下面「传输加密」。 |
| 中继机器是可信的（用 relay 时） | **提案 #1 起：业务帧端到端加密**——中继只见路由信封（`t`/`id`/`to`/`from`），goal、handoff 与成品内容全是密文。但中继仍是**流量路径**：它可以扣下握手帧让链路退回明文（副机会大声警告），也能拒绝转发（可用性攻击）。边界细节见下面「中继链路端到端加密」。TLS（[deploy/relay-vps/](deploy/relay-vps/)）仍建议叠加以隐藏元数据 |
| 副机能识别"它钉住的 hub" | P2-11 起：hub 有持久 ed25519 身份，副机首连自动钉住指纹（TOFU）或用 `pinnedHubFingerprint` 显式钉住，此后**假 hub / 假中继冒充会被当场拒绝**。边界：TOFU 防不了"首次连接就被截和"—— 指纹随配对码分发时依赖传递渠道可信（当面 / 加密聊天）。 |

**可用性边界**（不是安全边界）：中继挂了任务照跑 —— 副机本地持久执行，
重连后 `task/sync` 对账。链路断不影响已派任务的完成，只影响"此刻能否派新的"。

**本插件不做的事**（有意为之）：

- 不隔离副机的文件系统 —— 安全边界是 `roots` 配置，不是沙箱。
- 不限制副机能执行的命令 —— `mode: exec` 直接跑 shell。
- 不校验副机的身份（默认 `nodeToken` 为空）—— 见下面「认证」。

---

## 部署检查清单

### 1. 认证：**默认不校验，公网必须配**

`direct` 模式下，主机侧的 `nodeToken` 为空时**不校验任何凭证** ——
任何能连到 `hubUrl` 的人都能注册成节点并接收任务。

```yaml
# 主机
- id: remote-agent
  config:
    role: hub
    nodeToken: 'nt_<用 newNodeToken() 生成，或自选强随机>'   # ← 必配
```

```yaml
# 副机
- id: remote-agent
  config:
    role: worker
    token: 'nt_<与主机相同>'                                 # ← 必配
```

**什么时候可以留空**：只在**完全可信的私网**里（例如 Tailscale 虚拟内网、
或者本机自测）。**任何情况下都不该在公网留空。**

> `relay` 模式有独立的 enroll token 机制，但主机的 `nodeToken` 仍应配置 ——
> 中继只负责会合，不替代节点认证。

### 2. 传输加密

| 场景 | 建议 |
|---|---|
| Tailscale / WireGuard 虚拟内网 | 明文 `ws://` 可接受（隧道已加密）|
| 同机 / 完全可信 LAN | 明文 `ws://` 可接受 |
| **公网直连** | **必须**在前面放 TLS 反向代理（nginx/caddy），用 `wss://` |
| 公网中继 | 中继应部署在 TLS 之后，用 `wss://`。可直接抄的模板：[deploy/relay-vps/](deploy/relay-vps/)（Caddyfile / nginx.conf，中继只听回环、公网只暴露 443）|

**本插件不自带 TLS。** 它假设"要么网络层已加密，要么你在可信网络里"。
relay 模式另有应用层端到端加密，见下面「中继链路端到端加密（提案 #1）」。

### 3. `roots` 是真正的安全边界

副机只允许任务在 `roots` 列出的目录内动作。**留空会退回保守默认**
（用户 home 下的工作目录），**不要依赖这个默认值** —— 显式写清。

```yaml
config:
  roots:
    - 'D:\work'          # ← 只给任务需要的目录
    - 'D:\scratch'
```

**不要**把整个盘（`D:\`）或用户 home 加进去。

### 4. `uiPullRoot` 控制面板的写盘范围

Web 面板的「拉取」按钮是**唯一**由浏览器触发的写盘动作。

- 未配置（默认 `''`）→ 面板拉取**禁用**（返回 `403 pull-disabled`）。
- 配置了 → 只允许写到该目录内。路径校验是双道：先字符串层 `isInside`
  （挡 `../` 与反斜杠），再 `realpath` 复查（挡符号链接与 8.3 短名）。

**注意**：`realpath` 必须在 `mkdir` 之后 —— 所以一个越界目录可能被**创建**
出来（空目录，不是数据泄漏）。这是已知取舍。

### 5. 副机的 `denyPaths`

在 `roots` 之内再排除敏感子目录（例如 `roots: ['D:\work']` 但
`denyPaths: ['D:\work\secrets']`）。相对与绝对形式都支持。

### 6. 配对码（`pair`）等同凭证，按凭证传阅

配对码 `dshra1://…` 内含 `nodeToken`。**它能注册一台新副机 —— 谁拿到它，
谁就能接入你的主机。**规矩：

- 只通过**当面或加密聊天**传给副机；**不要贴公开群、截图、工单、日志**。
- 轮换：副机遗失/外泄时，改主机 `nodeToken` + 逐台换码即可全部失效
  （旧码里的旧 token 直接认证失败）。
- 面板「副机接入」生成的配对码有披露边界：**含 token 的完整码只回本机
  回环请求**（`/api/remote-agent/ui/pair-info` 判定 `remoteAddress`）——
  面板可能被 `lanBind` 暴露到局域网，能打开面板 ≠ 该拿到主机凭证。
  非回环请求只会拿到**不含 token** 的码（仅够可信内网直连）+ 一条提示。
- `roots` **不在**配对码里：副机能操作哪些目录是副机自己的安全边界，
  永远由副机配置声明 —— 主机侧的任何串都决定不了它。

### 7. hub 身份认证：副机也会验主机（默认开启）

协议此前只有单向认证：副机拿 token 向 hub 证明自己，但 hub 从不向副机证明
"我就是那个 hub"—— 假 hub 回一帧 welcome 副机就上线（token 是副机交出去
的东西，假 hub 根本不验），假中继更可以直接冒充 hub 下发 `mode: exec`
（副机任意代码执行）任务。P2-11 起补上了反向认证：

- **hub 侧**：首次启动生成持久 ed25519 身份密钥对，落盘
  `<stateDir>/hub-identity.json`（默认 `~/.dsh-remote-agent/`，0600；可用
  hub 配置项 `stateDir` 改目录）。direct 模式的身份证明放在 `welcome` 帧；
  relay 模式 hub 在节点上线后**追发**一帧 `hub/identity`。
- **副机侧**：配置 `pinnedHubFingerprint`（`hubfp1-` 开头共 29 字符）显式
  钉住；未配置时**首连自动钉住（TOFU）**，指纹写进
  `<stateDir>/hub-pin.json`（0600）。配对码自带指纹（向导生成的码自动带上
  `hubFingerprint` 字段）—— 副机粘一个码即完成"连接配置 + 指纹钉住"，
  零终端。
- **验证链**：指纹自洽（`sha256(报上来的公钥)` 必须等于报上来的指纹）→
  匹配 pin → ed25519 验签 → nonce 回显（防重放旧 welcome）→ 时间戳
  ±5 分钟窗口。任何一环不过：拒绝上线、**停止重连**、日志大声报错。
  钉住的指纹不会自动清除 —— 确认是主动换 hub 后删 `hub-pin.json`（或更新
  `pinnedHubFingerprint`）再重启副机即可重新钉住。
- **relay 宽限窗口**：relay 模式的"在线"信号来自中继，hub 身份帧是追发的。
  副机上线后 15 秒内等它：验过 → 正常干活；有 pin 但一直不来 → 拒绝
  （身份帧可能被中间人剥掉）；无 pin 且不来 → 按旧版兼容模式继续（记
  warn）。宽限窗口内到达的任务一律回 `hub-identity-pending`，不会被拿去执行。
- **换拨入地址不算换 hub**：pin 文件记录了当时的 endpoint。你自己改了
  `hubUrl` / `relayUrl`（本地配置行为，远程攻击者改不了）→ 副机提示 re-pin
  并重新 TOFU，不会逼你手删文件。

**剩余边界**（如实说）：① 能改副机本地配置或删 `hub-pin.json` 的人不在
威胁模型内（本地攻击者 = 游戏结束，任何方案都一样）；② 提案 #1 后中继只
见密文，但**主动降级**仍是已知局限——中继扣下 E2E 握手帧可让链路退回明文
（副机 5 秒超时后按明文兼容旧中继继续，并大声警告）；持有 enrollToken 的
中继运营者另可冒充**节点**重拨入（task/sync 会同步任务视图，历史 goal 泄露
给副机可见的中继），彻底关闭需副机侧身份钥，是另一个提案的体量；③ hub
身份文件被替换（磁盘损坏重建 / 被人动手脚）时，副机侧表现为指纹不匹配的
大声失败 —— 不会静默接受新身份，但恢复需要人工干预。

---

## 本插件的安全设计

### 审计日志（提案 #19）

hub 在 `<stateDir>/audit.jsonl` 追加记录**派发 / 取消 / 拉取**三类事件
（谁在何时让 hub 在哪台机器上跑了什么、哪些成品过了河落在哪）。
字段过统一打码层（双层）：**键名**含 token/password/apiKey 类字样的写 `***`；
**值内**的凭证形态字符串（sk-/ghp-/github_pat_ 前缀 token、`Bearer <token>`、
`password=值` 等键值对、URL userinfo）同样打 `***` —— 任务书正文里内嵌的
凭证不落明文（真机验证揪出并修复，见
docs/verification-repos-routing-real.md §4③）。超长值 400 字符截断。
默认开启，体积 8MB × 3 份轮转封顶；`config.audit: false` 显式关闭。
写入失败只限频告警，**绝不影响任务链路**。

### 凭证不离开副机

协议里**不带模型 API key**。副机用自己的 DSH 配置与凭证 ——
主机只能派任务，拿不到副机的模型凭证。

### 远程只读文件工具：roots 边界、链接不跟随（提案 #25）

四个文件工具（`remote_ls` / `remote_read` / `remote_grep` / `remote_tree`）
让 AI 直接读副机文件 —— 它们的安全模型：

- **这一组只有读动词**。写操作由独立工具承担，见后文；二进制文件在
  `remote_read` 中只回 sha256 + 大小 + 64 字节头部预览，不回原始字节。
- **`roots` 是同一条边界**。每个入口路径先 `realpathSync.native`（展开
  8.3 短名与符号链接，与任务工作区解析同口径）再与 `roots` 前缀比对，
  越界即 `workspace-denied`；`denyPaths` 在**枚举层**就生效 —— 被禁
  条目连名字都不会上报给 hub。
- **符号链接不跟随**。tree/grep 遍历时链接只列条目本身：roots 内一个指向
  `C:\Users` 的链接不是逃逸口。
- **带宽有界**。read 单响应 ≤256KB；grep 上限 2000 文件 / 单文件 2MB /
  命中 200 / 10 秒；tree 条目 ≤2000。副机不会被一次请求拖死。
- **独立通道 + 加密**。文件操作走 `fs/req`↔`fs/res` 专用帧（15s 超时，
  断连即失败），**不进任务队列、不占并发槽**；`fs/req` 在 relay 模式下
  属于必需加密帧集 —— 文件路径与内容对中继不可见。

注意：本组工具与 `remote_task` 共享 `roots` 的**读取**面 —— 给了
`roots` 就意味着主机 AI 可以读那些内容（与派任务让副机 agent 读文件
的既有能力等价，只是更快更直接）。不想让 AI 读某目录，把它加进
`denyPaths`。

### 双向文件、桌面截图与会话门禁（0.10.0）

- `remote_file` 的 worker 路径和现有读写工具使用同一 `roots` / `denyPaths` /
  realpath 边界；上传必须显式 `confirm: "yes"`，默认不覆盖。单文件 512MiB、
  256KiB 分块，offset 冲突返回 `expectedOffset`，commit 校验完整 SHA256，
  先写临时文件再原子 rename。hub 下载同样先写 `.part`，目标用独占创建。
- 文件和 PNG 字节只走现有 `fs/req` ↔ `fs/res` E2E 通道，**没有另开 Bearer HTTP
  旁路**。relay 仍只见路由信封和密文。
- `remote_screenshot` 会把副机完整虚拟桌面的图像带回主机；这是明确的敏感读取
  能力，应只派给可信会话。worker 限制单图 16MiB、最多 16 张、10 分钟 TTL，
  正常读取后立即释放。
- `remote_selfcheck` 的写入探针只发生在已配置 roots 内，并立即删除；GUI 检查
  会临时截图，但不会把探针图回传。fresh gate 失败时任务在 hub 创建前终止。
- 可选 `sessionGate: true` 按 Host 的 session id 授权，未识别会话 fail closed；
  工具 execute 内有兜底 guard，不能只靠隐藏工具或提示词。授权不持久化。
- 这些能力没有放宽成品策略：任务完成仍只自动回 handoff + manifest，
  `remote_pull` 仍只接受 `role:final`。`remote_file fetch` 是用户/Agent 显式
  读取 roots 内文件的独立通道，不会自动搬运工作区。

### exec 两阶段审批：默认挂起，等不到人不跑（提案 #2）

`mode:"exec"` 的任务**默认 `approval:"manual"`**：hub 收到派单后挂起，
**副机完全不知道这条任务存在**，直到人在面板上点批准；挂起超过
`limits.approvalTimeoutMs`（默认 30 分钟）自动拒绝。设计原则是
**fail-closed**：超时、拒绝、取消都让任务终止，唯一"放行"的路径是人
明确点批准 —— 绝不存在"没人管就默认执行"。批准时节点恰好掉线 → 任务
立即转 failed 并给 502，绝不静默退回挂起（那会让"批了但没跑"变成无头案）。
审计留痕：`approval.pending / granted / rejected` 三类事件进 audit.jsonl。
想要旧行为显式传 `approval:"auto"`。

### 仓库清单上报：只报结构，不报凭证（提案 #13）

副机接入后自动扫描 `roots` 下的 git 仓库并上报到 hub：每仓库只含
**名字、远端 url、本机路径** 三个字段。两条硬边界：

- **url 里的凭证在副机本地剥掉**：`.git/config` 常见
  `https://user:token@host/...` 的推送凭证，上报前统一打码
  （见 `lib/node/repos.js` 的 `sanitizeRepoUrl`）——hub 与面板永远拿不到。
- **扫描零子进程**：只 `readdir` + 读 `.git/config` 文本，不 spawn git，
  扫描行为完全可从源码审计。

不想暴露目录结构时 `config.reposIntervalMs: 0` 关掉上报（`repo:` 路由
随之不可用，其余功能不受影响）。注意：仓库路径本身也是主机目录结构的
一部分 —— 若 `roots` 给了整盘，这条披露与 roots 自身的披露同样成立。

### 响应体逐字段白名单，绝不 spread

`lib/hub/views.js` 是工具与 UI 共用的投影层，**逐字段构造**。
反例是 `{...registry.list()[i]}` —— 那会让将来新增的内部字段
（`conn`、`hello` 全量、`pendingPulls`…）自动泄漏到浏览器。

`handoffView` 尤其重要：handoff 由**副机上报**，字段集不受主机控制。
它刻意**不含** `workspace`（绝对路径会回显主机目录结构）、`logs`
（可能带环境变量）、`sessionId`（副机内部标识）。

### UI 路由自带围栏

DSH 的 `/api` 鉴权围栏是 `kind: 'prefix'`，而本插件的路由是 `kind: 'exact'`。
`@deepseek-ai/dsh-host-webserver` 的 `match()` **exact 表优先** ——
所以本插件的路由**不在** DSH 的 token/cookie 围栏内。

因此 `lib/hub/ui-routes.js` **自带 guard**，且**失败关闭**：

- 带 `Origin` 且与 `Host` 不一致 → 403
- `sec-fetch-site: cross-site` → 403
- `ctx.connection.requestRejection` 抛错 → **仍拒绝**（不是放行）

`check-doc-drift.mjs` 有断言锁住"失败关闭"这条语义。

### 只有 `role:final` 过河

任务结束只回 `manifest` + `handoff`；`intermediate`（日志、缓存、
中间构建文件）只在副机留存，仅上报元数据。这限制了"主机意外拉走一堆
不该传的东西"的风险面。

### 变更 diff 视图：内容（不只是元数据）会随 handoff 上报（提案 #21）

handoff 的 `diffs` 字段会带**工作区文本文件改动的 unified diff** ——
这是文件内容本身，不再是元数据。边界刻意收窄：

- 只覆盖 `changed` 里的 add/modify/delete，且**前像必须在任务开始时
  被快照捕获**（≤256KB/文件、64 文件、总量 4MB、前 64 字节含 NUL 的
  二进制不捕获）—— 大文件、二进制文件的 diff 缺席，changed 元数据仍在。
- 输出封顶：12 文件 / 单文件 16KB / 总量 96KB，超出部分缺席（truncated
  标注），不做"全量备份"。
- diff 内容与 handoff 一起过 `handoffView` 白名单投影，进模型上下文与
  面板的路径同受约束。

评估口径：能被 `role:final` 产物拉走的文件本来就能过河，diff 只是让
"改了什么"在卡面上直接可见；真正敏感的是**没有列为产物、但被任务改动
的文件**（例如顺带改掉的配置）现在会以 diff 形式出现在卡上 —— 这是有意
的透明化（证据链），不是泄漏路径变化。若工作区含不该离开副机的文件，
用 `denyPaths` 排除（快照与 diff 都遵守它）。

### 中继链路端到端加密（提案 #1）

relay 模式下，hub⇄副机的业务帧默认**端到端加密**（`relayE2E: false` 可关）。
中继转发的是密文：它只看得到路由信封（`t`/`id`/`to`/`from` 明文，路由逻辑
不变），goal、handoff、产物分块全在 AES-256-GCM 密文里。要点：

- **密钥协商**：双方各出一次性 X25519 → ECDH → HKDF-SHA256 派生会话密钥。
  ed25519 身份钥**永不参与**对称密钥推导——会话钥泄露不影响身份链，
  每次重连换新会话钥（前向隔离）。
- **认证**：hub 用持久 ed25519 身份签握手回执，签名绑定双方临时公钥与
  nonce——中继偷换任一侧公钥或重放握手都会验签失败。副机的验证锚是
  P2-11 钉住的 hub 指纹。
- **完整性**：每帧 AAD 绑定方向 + 帧类型 + 帧 id + 序号，序号严格递增，
  重放/乱序/跨会话移植即解密失败丢弃。副机产物的 pullId/offset/sha256
  等路由细节也在密文里（二进制帧整帧进密文）。
- **防伪造指令**：会话建立后，副机**拒绝一切明文业务帧**（task/start 等）
  并回加密的 `e2e-required` 错误——这是挡住"中继运营者拿 enrollToken
  冒充 hub 注入任务"的唯一防线（P2-11 身份链挡不住中继本身，因为它就是
  传输路径）。
- **已知局限（如实说）**：① **主动降级**——中继扣下握手帧可让链路退回
  明文（旧中继兼容需要），副机 5 秒超时后按明文继续并大声警告；彻底关闭
  需副机侧身份钥，是另一个提案的体量。② 持有 enrollToken 的中继运营者
  可冒充**节点**重新拨入，让 task/sync 把任务视图同步给他（历史 goal 泄露）。
  ③ 中继仍可做可用性攻击（拒转/延迟），这不是加密能解决的。

### 中继的 token 处理

- **一次性 token 不落盘**：由中继管理接口（`POST /api/relay/token`）铸造，
  只存在中继进程内存里，用过（consumed）或过期（默认 15 分钟）即消失。
  重放会 403 —— 适合"发一台机器出去"的场景。
- **长期凭证在中继机器上**：`/etc/dsh-remote-relay/env`（0600，root:root）与
  `<data-dir>/tokens.json`（0600）。**都不要提交进版本库。**部署模板见
  [deploy/relay-vps/](deploy/relay-vps/)。
- 副机的 `token` 也可以留空，让它读 `<stateDir>/token` 文件 ——
  便于不把凭证写进 YAML。

---

## 已知的未验证项

见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md) 的 §7.1。要点：

- **Windows 8.3 短名绕过向量未验证**：`uiPullRoot` 的路径校验先做字符串层
  再 `realpath`。8.3 短名（如 `PROGRA~1`）能否绕过字符串层、以及 `realpath`
  是否总能解析它，**没有实测**。已加防御（双道校验），但缺对抗性验证。
- **POSIX 分支的平台实测覆盖不足**：Windows 全量验证，Linux/macOS 只跑过 CI。
- **P2-11 hub 身份链路的对抗性验证不足**：验签 / 钉住 / 重放 / 超窗有单元
  与变异负向测试，真实双进程 e2e 走通了完整身份链路；但"真中继剥帧 /
  真 MITM"场景没有实机红蓝对抗实测，relay 宽限窗口的超时分支只在测试
  时钟下验证过。

如果你做了这两项的对抗性测试，欢迎按上面的方式报告结果。

---

## 不在范围内

以下**不算**本插件的漏洞（属于部署配置问题）：

- 主机 `nodeToken` 留空且暴露在公网 → 设计如此，见检查清单第 1 条
- `roots` 配得太宽（例如整个盘）→ 配置问题
- 明文 `ws://` 走公网 → 见检查清单第 2 条
- 副机执行了主机派来的破坏性命令 → 这是功能，不是漏洞
  （主副机互信是前提）
- 能改副机本地配置（删 `hub-pin.json`、改 `pinnedHubFingerprint`）的人
  → 本地攻击者不在威胁模型内，见检查清单第 7 条的剩余边界

**但如果**你能证明：绕过 `roots` / `denyPaths` / `uiPullRoot` 的边界、
未授权注册成节点、或从响应体里取到未白名单的字段 —— **那是真漏洞，请报告。**
