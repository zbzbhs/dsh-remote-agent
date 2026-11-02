/**
 * 主机侧 hub 插件入口（零外部依赖）。
 *
 * 这一层只做三件事：
 *   1. **接线** —— 把 webServer 的 upgrade 路由、七个 remote_* 工具、
 *      一个 systemPrompt section、一个 subagent provider 挂上去；
 *   2. **路由上行帧** —— 直连 socket 与中继链路都汇到同一个 NodeRegistry；
 *   3. **生命周期** —— 每一处注册都包在 ctx.effect 里，disposer 真的释放资源
 *      （关连接、清定时器、删临时文件、reject 在途 pull）。
 *
 * 刻意的边界：hub 不持有任务状态的真身。断连只把节点置为 offline，任务投影留在
 * 内存里等副机重连后 task/sync 重建 —— 任务在副机本地持久运行，断连不终止。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { ERROR_CODE, PROTOCOL_VERSION } from '../protocol.js'
import { acceptUpgrade } from '../ws.js'
// 独立监听端口（2026-10-18）：副机拨入不再依赖 DSH 的 webserver 配置
// （DSH 每次启动重写 profile patch，会把 webserver 段冲掉）。
import {
  DEFAULT_LISTEN_PORT,
  isLoopbackHost,
  resolveListenHost,
  startListenServer,
} from '../listen-server.js'
import { NodeRegistry } from './node-registry.js'
import { RelayLink } from './relay-link.js'
import { createPluginLogger } from './hub-util.js'
import { PullManager } from './pull-manager.js'
import { createAuditLog } from './audit-log.js'
import { registerRemoteTools } from './tools.js'
import { registerUiRoutes } from './ui-routes.js'
import { createRemoteAgentProvider } from './subagent-provider.js'
import { createSessionGate } from './session-gate.js'
import { registerAdvancedTools } from './advanced-tools.js'
// P2-11：hub 持久身份（ed25519）。指纹进 welcome / hub-identity 帧，副机钉住防假 hub。
import { IDENTITY_FILE_NAME, loadOrCreateHubIdentity } from '../identity.js'

/** 默认 upgrade 路径：与 node/transport.js 的 direct 分支一致，改动会同时打穿两边。 */
export const NODE_UPGRADE_PATH = '/api/remote-agent/node'

/** 只读健康检查：给部署脚本与验证用，不暴露任何凭证。 */
export const HEALTH_PATH = '/api/remote-agent/healthz'
/** systemPrompt section 的 order：紧接 dsh-anywhere 的 fleet（151）之后。 */
export const PROMPT_ORDER = 152

export function normalizeConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {}
  const limits = c.limits && typeof c.limits === 'object' ? c.limits : {}
  const defaults = c.defaults && typeof c.defaults === 'object' ? c.defaults : {}
  const relay = c.relay && typeof c.relay === 'object' ? c.relay : null
  return {
    nodePath: typeof c.nodePath === 'string' && c.nodePath !== '' ? c.nodePath : NODE_UPGRADE_PATH,
    healthPath: typeof c.healthPath === 'string' && c.healthPath !== '' ? c.healthPath : HEALTH_PATH,
    // ── 独立监听端口（2026-10-18）──────────────────────────────────────
    //
    // 副机拨入不再依赖 DSH 的 webserver（DSH 每次启动重写 profile patch，
    // 会把 webserver 段冲掉；而且新版硬拒绝 0.0.0.0）。插件自己开端口。
    //
    // listenHost：留空 = **自动选**（Tailscale IP > 私网 IP > 回环）。
    //   显式填了就按填的绑（必须是具体 IP，不能 0.0.0.0 —— 与 DSH 同规则）。
    // listenPort：默认 19387（与历史配置、配对码、文档一致）。
    listenHost: typeof c.listenHost === 'string' ? c.listenHost.trim() : '',
    // listenPort：默认 19387（与历史配置、配对码、文档一致）。
    // **0 = 显式关闭独立监听**（测试 / 只走 relay / 已在别处暴露端点时用）。
    listenPort: Number.isFinite(c.listenPort) && c.listenPort >= 0 && c.listenPort < 65536
      ? c.listenPort
      : DEFAULT_LISTEN_PORT,
    nodeToken: typeof c.nodeToken === 'string' ? c.nodeToken : '',
    sessionGate: c.sessionGate === true,
    systemPrompt: c.systemPrompt !== false,
    // F1-1：healthz 是否暴露计数。默认 true（便于运维自检）；
    // 设为 false 时该路由只回 { ok, plugin, role, protocol }，不暴露任何计数。
    healthDetail: c.healthDetail !== false,
    // Web 面板（client 半）用。uiEnabled 默认 true（面板路由随 hub 一起注册）；
    // uiPullRoot 是**唯一**允许面板拉取产物落地的目录，未配置则面板的 pull 动作禁用 ——
    // 不让 Web 界面变成任意路径写入的入口。
    uiEnabled: c.uiEnabled !== false,
    uiPullRoot: typeof c.uiPullRoot === 'string' && c.uiPullRoot !== '' ? c.uiPullRoot : '',
    // P2-11：hub 身份落盘目录（<stateDir>/hub-identity.json，0600）。与副机默认
    // 同目录无冲突 —— hub 只写 hub-identity.json，副机写 token/ 与 tasks/。
    stateDir: typeof c.stateDir === 'string' && c.stateDir.trim() !== '' ? path.resolve(c.stateDir.trim()) : defaultHubStateDir(),
    // 提案 #19：审计日志。默认开启（本地 JSONL、无凭证、有轮转）；audit:false
    // 或 audit.enabled:false 显式关闭。maxBytes/maxFiles 控制轮转体积。
    audit: normalizeAudit(c.audit),
    relay:
      relay && typeof relay.url === 'string' && relay.url !== ''
        ? { url: relay.url, token: typeof relay.token === 'string' ? relay.token : '' }
        : null,
    limits: {
      heartbeatMs: numOr(limits.heartbeatMs, 15_000),
      ackTimeoutMs: numOr(limits.ackTimeoutMs, 60_000),
      pullTimeoutMs: numOr(limits.pullTimeoutMs, 30 * 60 * 1000),
      maxPullBytes: numOr(limits.maxPullBytes, 512 * 1024 * 1024),
      // ⚠ 这个上限按**在跑的任务**算，不按历史累计（见 createTask 的说明）。
      // 曾经按 `rec.tasks.size`（含终态）算，导致派几十条任务后节点永久不可用。
      maxTasksPerNode: numOr(limits.maxTasksPerNode, 64),
      // hub 侧任务视图的保留期：终态任务超过它就自动清掉，防视图无限累积。
      // 默认 1 小时 —— 比"回看刚才那条任务的结果"需求长，又远短于副机的
      // TaskStore 保留期（7 天）。设 0 关闭自动清理（只留 remote_purge 手动清）。
      taskViewRetainMs: numOr(limits.taskViewRetainMs, 60 * 60 * 1000),
      // 两阶段审批（提案 #2）：manual 任务挂起超过此时长自动拒绝（fail-closed）。
      // 默认 30 分钟；设 0 = 不设超时（任务一直挂着等人，仍不会自动批准）。
      approvalTimeoutMs: numOr(limits.approvalTimeoutMs, 30 * 60 * 1000),
      helloTimeoutMs: numOr(limits.helloTimeoutMs, 10_000),
    },
    defaults: {
      // ⚠ **不要在这里兜底 1h**（2026-10-17 修，行为变更）。
      //
      // 原实现 `numOr(defaults.timeoutMs, 60 * 60 * 1000)` 让 explicitTimeoutMs
      // 恒为 3600000，于是 tools.js 里 #26-1 的优先级
      //
      //     args > 显式配置 > 分模式默认（exec 10min / agent 1h）
      //
      // 被压扁成「恒 1h」——**exec 的 10 分钟默认成了死代码**，一条失控命令
      // 比文档承诺的多跑 50 分钟才被杀。而且那个兜底还掩盖了 tools.js 里的
      // 一个 TDZ 引用 bug（`v.spec.mode` 自引用），让它在生产环境永不触发。
      //
      // 现在保持 undefined：不配置就是"没有显式指定"，让 tools.js 按 mode
      // 分模式取默认值。用户显式配 `defaults.timeoutMs` 时仍然优先。
      timeoutMs: typeof defaults.timeoutMs === 'number' && Number.isFinite(defaults.timeoutMs)
        ? defaults.timeoutMs
        : undefined,
    },
  }
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 审计配置归一（提案 #19）：false/缺省对象两种写法都接受，坏值回落默认。 */
function normalizeAudit(a) {
  const d = { enabled: true, maxBytes: 8 * 1024 * 1024, maxFiles: 3 }
  if (a === false) return { ...d, enabled: false }
  if (!a || typeof a !== 'object') return d
  return {
    enabled: a.enabled !== false,
    maxBytes: numOr(a.maxBytes, d.maxBytes),
    maxFiles: numOr(a.maxFiles, d.maxFiles),
  }
}

/** hub stateDir 默认值：与副机 resolveStateDir 同口径（homedir 不可写退 tmp）。 */
function defaultHubStateDir() {
  try {
    return path.join(os.homedir(), '.dsh-remote-agent')
  } catch {
    return path.join(os.tmpdir(), '.dsh-remote-agent')
  }
}

/** 恒定时间比较，避免 token 逐字节泄露。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

function remoteAddress(req) {
  return String(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '')
}

/**
 * 把一个 disposer 包成**幂等**的。
 *
 * 为什么需要：同一个注册可能有两个 owner（插件自己的 effect + 服务侧的
 * 作用域），HMR 与卸载竞态都会让它被释放两次。注册类 disposer 的语义是
 * "移除我注册的那个东西"，第二次调用必须是安全的 no-op，而不是抛错把
 * 一次正常的卸载变成失败。
 */
function once(fn) {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      fn?.()
    } catch {
      /* 注册可能已被服务侧先行移除 */
    }
  }
}

/** 中继 URL 去掉 userinfo 后用于日志。 */
function redactUrl(raw) {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(invalid-relay-url)'
  }
}

/** systemPrompt 文案：让主 agent 知道什么时候该用远程同事，以及正确的调用顺序。 */
export const SYSTEM_PROMPT_TEXT = `## 远程同事（dsh-remote-agent）

你可以把任务派给其他电脑上的 DSH 节点执行。这些节点在自己的机器上**本地持久运行**
任务（独立 agent 循环、独立模型上下文），断连不会终止任务；主电脑只消费交接卡，
不消费副机的原始日志。

调用顺序：

1. \`remote_nodes\` —— 看有哪些节点在线、各自允许的工作区根（roots）与能力（caps）。
2. \`remote_task\` —— 派单。给出 \`node\`、\`goal\`；需要指定目录时给 \`workspace\`（必须在 roots 内）；
   简单的命令式活可用 \`mode:"exec"\`，需要判断与多步操作的活用默认的 \`mode:"agent"\`。
   本工具只等到副机"接受任务"就返回，不等结果。
   需要副机用特定模型时传 \`model\`（如 \`{model:"deepseek-chat"}\` 或
   \`{provider:"openai",model:"gpt-4o"}\`；只传**选择**，副机用自己的凭证跑，
   指定的模型在副机不存在时任务会明确失败。headless 后端不支持 model）。
3. \`remote_status\` —— 跟进进度（进度尾巴 + 日志尾巴）。任务状态的真身在副机，
   节点短暂离线不代表任务停了。
4. \`remote_handoff\` —— 任务结束后取交接卡：状态、退出码、摘要、工作区变更、
   产物清单、拉取提示。**决策所需的一切都在这一张卡里。**
5. \`remote_manifest\` + \`remote_pull\` —— 清单先于字节。只有清单里 \`role:final\`
   的成品可以拉；\`intermediate\`（日志、缓存、中间构建文件）只在副机留存，
   仅上报元数据，不要去拉它。
6. \`remote_cancel\` —— 需要打断时用。

新增能力：remote_selfcheck 做真实环境自检；remote_agents 可 list/status/wait 后台任务；
remote_interrupt 是取消别名；remote_file 用于显式双向文件互传（上传需 confirm）；
remote_screenshot 获取副机桌面 PNG。文件与截图分块校验 SHA256，仍受 roots/E2E 保护。

注意：产物回流是**按需**的，不会自动同步。想看成品就用 \`remote_pull\` 显式拉取。
作为委派目标使用时，用 subagent 的 provider \`remote-agent\`（label 里写节点名可指定机器）。`

/**
 * 挂载 hub 角色。
 * @param {object} ctx DSH 插件上下文（已声明 webServer / tools / systemPrompt）
 * @param {object} [config] profiles/hub.cordis.yml 里的 config
 */
export function applyHub(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const log = createPluginLogger(ctx, 'remote-agent')
  const sessionGate = createSessionGate({ required: cfg.sessionGate })
  /**
   * 注册收集器。
   *
   * ⚠ 为什么不用 `ctx.effect(...)`（2026-10-14 实测）：
   * `applyHub` 收到的 `ctx` 是 `ctx.plugin(hubPlugin)` 创建的**子 fiber** 的上下文。
   * 该 fiber 在 `apply` 同步返回后被框架清理 —— 诊断日志显示注册后 **3–13ms**
   * 出现 `DISPOSED (fiber unloaded)`，所有 `ctx.effect` 的 disposer 被执行，
   * 刚注册的 9 条路由 + healthz 全部被删，且**不再重新注册**（框架不会重新 load
   * 一个已"完成"的父 fiber 下的子 fiber）。表现：面板 404/401，启动日志无异常。
   *
   * 改成「立即执行 + 收集 disposer」后完全不依赖 fiber 生命周期。
   * 代价：热重载时不会自动摘路由 —— 可接受，因为 DSH 重启会清掉一切，
   * 而 disposer 仍由 applyHub 的返回值交给调用方保管。
   */
  const __disposers = []
  const __reg = (fn, label) => {
    try {
      const d = fn()
      if (typeof d === 'function') __disposers.push(d)
      // 每条注册都留痕。为什么：注册抛错是**静默致命**的 —— 路由不存在、
      // 工具缺失、面板 404，而宿主启动日志里什么都没有（实测踩过多次）。
      // 有这一行，"哪一条没跑"就一目了然。
      log('info', 'hub registration ok', { label })
    } catch (err) {
      log('error', 'hub registration FAILED', { label, error: String(err?.message ?? err) })
      throw err
    }
  }

  // ── hub 身份（P2-11）：首次启动生成持久 ed25519 密钥对，之后一直复用 ──
  // 加载失败不致命：welcome 不带 identity、relay 不追发，副机按旧协议处理。
  // 身份文件损坏时 loadOrCreateHubIdentity 就地重建 —— 已钉住旧指纹的副机会
  // 在下一次握手大声失败，这正是想要的方向（fail-closed，绝不静默接受新身份）。
  let hubIdentity = null
  try {
    hubIdentity = loadOrCreateHubIdentity(path.join(cfg.stateDir, IDENTITY_FILE_NAME))
    log('info', 'hub identity ready', { fingerprint: hubIdentity.fingerprint, created: hubIdentity.created, file: hubIdentity.file })
  } catch (err) {
    log('warn', 'hub identity unavailable; hub authentication disabled', { error: String(err?.message ?? err) })
  }
  // ── 审计（提案 #19）：派发/取消/拉取证据链，<stateDir>/audit.jsonl ──
  // 必须在 registry/pulls 之前建好（两者构造时就要拿到写入器）。
  // createAuditLog 自身不抛（目录建不了时返回 no-op 形态），这里的 try 只是纵深防御。
  let audit = null
  try {
    audit = createAuditLog({ dir: cfg.stateDir, enabled: cfg.audit.enabled, maxBytes: cfg.audit.maxBytes, maxFiles: cfg.audit.maxFiles, log })
    if (audit) log('info', 'audit log ready', { file: audit.path, enabled: cfg.audit.enabled })
  } catch (err) {
    log('warn', 'audit log unavailable; running without audit', { error: String(err?.message ?? err) })
    audit = null
  }

  // ── 可达性自检：webServer 绑在 loopback 时副机永远连不上 ────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 这是一个**静默失败**，2026-10-17 实测踩到
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // DSH 的 `@deepseek-ai/dsh-host-webserver` 的 `host` 是**必填项、无默认值**，
  // 而它面向的默认场景是"本机浏览器访问自己"，所以多数 profile 里绑的是
  // `127.0.0.1`。`webServer.getOrigin()` 的文档也明说它返回的是
  // "the root URL **local clients** use to reach the bound listener"。
  //
  // 但本插件的整个用法是**跨机**：副机拿 `ws://<主机IP>:19387/...` 拨入。
  // 绑 loopback 时：
  //   · hub 自己一切正常（healthz 200、面板能开、工具都在）
  //   · 副机**永远连不上**，报 `ECONNREFUSED` / `connect timeout`
  //   · 主机侧**没有任何异常**，用户只能去猜"地址填错了？token 错了？防火墙？"
  //
  // 三种用户会踩：
  //   A. 全新安装，没动过 webserver 配置（**绝大多数**）
  //   B. 装过某个改 lanBind 的插件又卸载，托管块残留但插件没了
  //   C. 自己改过 webserver，绑错了
  //
  // 所以这里做两件事：
  //   1. **启动时 log 一条明确的 warn**（带修法，不是只说"不可达"）
  //   2. 把结论存进 `reachability`，由面板渲染成**红色横幅** ——
  //      日志用户不会看，面板会看
  //
  // ⚠ 自检本身**绝不能**让 hub 起不来：`getOrigin()` 在 listen 之前会抛，
  // 服务缺失时也不存在。整段包 try/catch，拿不到就记 `unknown`。
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-10-20 重写：旧结论只反映 webServer，会**假红**（0.9.3 起独立监听才是主通道）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 0.9.3 把节点端点搬到独立监听（默认 19387）后，这段自检没跟着改，结果是：
  // 副机明明能连（19387 在听），面板却因为 DSH 的 webserver 绑 127.0.0.1 而
  // 报「副机用任何地址都连不上」，并把用户引向一个已被证伪的修法（改 webserver）。
  //
  // 现在拆成两层：
  //   · `webServerReach` —— 旧通道的结论（保留给"独立监听没起来"的降级场景）
  //   · `currentReachability()` —— **对外唯一入口**：独立监听优先，实时读取
  //
  // 为什么是函数而不是快照：独立监听是异步启动的（Promise），注册 ui-routes 时
  // 往往还没结果。传快照会让面板永远显示启动瞬间的状态。
  const listenRuntime = {
    ok: null, // null=未出结果 / true=在听 / false=失败
    disabled: '', // 非空 = 显式关闭的原因（listenPort:0 / 测试环境 / token 空）
    host: '',
    port: 0,
    source: '',
    error: '',
  }

  /** 旧通道（DSH webserver）的可达性结论。 */
  function computeWebServerReachability() {
    try {
      const ws = ctx.webServer
      const origin = typeof ws?.getOrigin === 'function' ? ws.getOrigin() : null
      if (typeof origin === 'string' && origin !== '') {
        let hostname = null
        try {
          hostname = new URL(origin).hostname
        } catch {
          /* 非 URL 形态：保持 null */
        }
        const h = typeof hostname === 'string' ? hostname.toLowerCase() : ''
        const loopback = isLoopbackHost(h)
        return {
          bound: hostname,
          origin,
          loopback,
          hint: loopback
            ? 'DSH 的 Web 服务绑在 loopback。如果下面「独立监听」正常，这不影响副机接入 —— '
              + '本插件已不再依赖它（2026-10-18 架构变更）。'
            : '',
          via: 'webserver',
        }
      }
      return { bound: null, origin: null, loopback: null, hint: 'webServer.getOrigin() 不可用', via: 'webserver' }
    } catch (err) {
      // getOrigin() 在 listen 完成前会抛（文档明说）；服务缺失也会抛。
      log('info', 'reachability self-check unavailable', { error: String(err?.message ?? err) })
      return {
        bound: null,
        origin: null,
        loopback: null,
        hint: `webServer 可达性自检失败：${String(err?.message ?? err)}`,
        via: 'webserver',
      }
    }
  }

  const webServerReach = computeWebServerReachability()

  /**
   * 对外统一的可达性结论：**独立监听优先**。
   * @returns {{bound:string|null, origin:string|null, loopback:boolean|null, hint:string, via:string, port?:number}}
   */
  function currentReachability() {
    if (listenRuntime.ok === true && listenRuntime.host !== '') {
      const loopback = isLoopbackHost(listenRuntime.host)
      return {
        bound: listenRuntime.host,
        origin: `${listenRuntime.host}:${listenRuntime.port}`,
        loopback,
        hint: loopback
          ? '独立监听绑在 loopback —— 副机无法接入。原因通常是 nodeToken 为空（安全策略：'
            + '无口令的端点不暴露到网络）。到面板「副机接入」生成口令后重启 DSH 即可。'
          : '',
        via: 'listen-server',
        port: listenRuntime.port,
        source: listenRuntime.source,
      }
    }
    // 独立监听没起来（失败/关闭）→ 退回旧通道结论，并把原因带上
    const reason = listenRuntime.error !== ''
      ? `独立监听启动失败：${listenRuntime.error}`
      : (listenRuntime.disabled !== '' ? `独立监听已关闭：${listenRuntime.disabled}` : '')
    return {
      ...webServerReach,
      hint: [reason, webServerReach.hint].filter((s) => s !== '').join(' '),
    }
  }

  // 启动期的一条日志（面板读实时值，日志只在启动时说一次）
  if (webServerReach.loopback === true) {
    log('info', 'DSH webserver 只绑 loopback（不影响独立监听通道）', {
      origin: webServerReach.origin,
    })
  }

  const registry = new NodeRegistry({ log, limits: cfg.limits, identity: hubIdentity, audit })
  const pulls = new PullManager({ registry, log, limits: cfg.limits, audit })
  registry.bindPulls(pulls)
  // 先建运行时 effect：Cordis 逆序释放，所以它的 disposer 最后跑，
  // 保证路由/工具/provider 先摘干净，再拆运行时资源。
  __reg(() => {
    log('info', 'hub runtime started', { protocol: PROTOCOL_VERSION })
    // 启动心跳巡检。此前 startHeartbeat() 实现完整却从未被调用（只有副机侧调过同名方法），
    // 导致 tick() 永不执行、this.timer 恒 undefined —— 半开连接（拔网线 / NAT 静默超时 /
    // 主机休眠）会**永久显示 online**，任务继续派给收不到的节点。
    registry.startHeartbeat()
    return () => {
      try {
        pulls.dispose()
      } catch {
        /* 已经清空 */
      }
      try {
        registry.dispose()
      } catch {
        /* 已经清空 */
      }
      // 审计在途写入 flush（fire-and-forget：dispose 返回 promise，失败已在其内部吞掉）
      try {
        void audit?.dispose?.()
      } catch {
        /* 已清空 */
      }
      log('info', 'hub runtime stopped')
    }
  }, 'remote-agent: runtime')

  // ── 中继链路（可选） ────────────────────────────────────────────
  if (cfg.relay) {
    __reg(() => {
      const link = new RelayLink({
        url: cfg.relay.url,
        token: cfg.relay.token,
        log,
        onFrame: (frame) => registry.handleRelayFrame(frame),
        onBinary: (header, payload) => registry.handleRelayBinary(header, payload),
      })
      registry.attachRelay(link)
      link.start()
      return () => {
        try {
          link.stop()
        } catch {
          /* 已停 */
        }
      }
    }, 'remote-agent: relay-link')
  }

  // ── 独立监听端口（2026-10-18，**副机拨入的主通道**）───────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 为什么不再依赖 ctx.webServer
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 原先副机端点注册在 `ctx.webServer.registerUpgrade` 上，于是副机必须能访问
  // **DSH 自己的 webserver 端口**。这带来两个绕不开的死结：
  //
  //   1. **DSH 每次启动都重写 `<profile>/cordis.patch.yml`**（实测：写进去的
  //      `webserver` 段在下次启动时被删掉，只剩 3 个 `ui-*` 条目）→ 绑回
  //      127.0.0.1 → 副机永远连不上，而且主机侧毫无异常。
  //   2. `webServer` 服务**激活即 listen**，没有 rebind 方法 → 插件运行时改不了。
  //
  // 而且新版 `dsh-host-webserver` 硬拒绝 `0.0.0.0`（直接让 DSH 启动崩溃，
  // 我们踩过：10 份 crash 日志）。所以"帮用户把 webserver 改好"这条路是死的。
  //
  // ── 现在的做法 ──────────────────────────────────────────────────────────
  //
  // 插件自己用 `node:http` 起一个只服务节点端点的小 server（见
  // lib/listen-server.js），**完全不依赖 DSH 的 webserver 配置**。
  //
  // 绑定地址自动选：配置的 listenHost > Tailscale IP > 私网 IP > 回环。
  // 端口默认 19387（与历史配置、配对码、文档一致）。
  //
  // ⚠ 这是**新增的主通道**，不是替换：下面 webServer 的 registerUpgrade 仍然
  // 保留 —— 老配置（webserver 恰好绑对了）的机器继续用那条路径，两条通道
  // 并存不冲突（不同端口/不同 socket）。

  // ── 健康检查响应：按调用者身份分级（v0.9.3 审查 L4）──────────────────
  //
  // 该端点**无鉴权**，而原实现直接把 `plugin: dsh-remote-agent / role: hub /
  // protocol` 回给任何人 —— 那是给扫描器送指纹：认出"这台机器装了会执行
  // 远程命令的插件"正是值得挑的目标。
  //
  //   · 匿名（或口令不对） → 只回 `{ ok: true }`
  //   · 带正确 `x-dsh-token` → 完整信息（healthDetail=false 时不含计数）
  //
  // ⚠ 必须定义在**两个使用点之前**：独立监听块在本函数体内同步执行，
  // 用 `const` 声明的函数在后面会踩 TDZ（`ReferenceError: Cannot access
  // 'healthPayload' before initialization`）—— 与 0.9.x 那次 H1 同族。
  // 两条通道（webServer / 独立监听）共用这一份，避免"改一条漏一条"。
  const healthPayload = (req, via = '') => {
    const authed = cfg.nodeToken !== '' && safeEqual(req.headers['x-dsh-token'], cfg.nodeToken)
    if (!authed) return { ok: true }
    const base = {
      ok: true,
      plugin: 'dsh-remote-agent',
      role: 'hub',
      protocol: PROTOCOL_VERSION,
    }
    if (via !== '') base.via = via
    if (!cfg.healthDetail) return base
    const nodes = registry.list()
    return {
      ...base,
      nodes: nodes.length,
      online: nodes.filter((n) => n.online).length,
      tasks: registry.listTasks().length,
      activePulls: pulls.activeCount,
    }
  }

  let listenHandle
  __reg(() => {
    const listenHost = typeof cfg.listenHost === 'string' ? cfg.listenHost : ''
    const port = Number.isFinite(cfg.listenPort) ? cfg.listenPort : DEFAULT_LISTEN_PORT

    // ── `listenPort: 0` = 显式关闭独立监听（2026-10-18）────────────────
    //
    // 这个开关是**为测试与特殊部署**准备的：
    //   · 单测/e2e 里 ctx 是 mock，本模块会真的开端口 → 监听句柄不释放
    //     → 测试进程挂住（实测：hub-worker-e2e 90 秒不退出）。
    //   · 某些部署场景（只走 relay、或已在别处暴露端点）不需要这个端口。
    //
    // 另外**自动检测测试环境**：测试不该真的占用 19387（并行跑多个测试文件
    // 时还会互相抢端口，而且监听句柄不释放会让 `npm test` 挂住）。
    //
    // ⚠ 检测方式是 `NODE_TEST_CONTEXT`（node --test 会设为 'child-v8' 等），
    // **不是** `process.argv` —— 实测 `node --test` 子进程的 argv 里没有
    // `--test`（那是父进程的参数），第一版用 argv 判断所以没生效。
    //
    // 显式传非默认 listenPort 时以显式为准（有测试专门验证监听行为时要用）。
    const isUnderTest = typeof process.env.NODE_TEST_CONTEXT === 'string'
      && process.env.NODE_TEST_CONTEXT !== ''
    // L3（2026-10-20）：原来用"值 != 默认端口"推断"是否显式配置"，
    // 于是用户显式写 19387 与"没写"无法区分（测试里想显式测 19387 会被跳过）。
    // 改成看**原始 config 有没有这个键**。
    const explicitPort = config !== null && typeof config === 'object'
      && Object.prototype.hasOwnProperty.call(config, 'listenPort')
      && Number.isFinite(config.listenPort)
      && config.listenPort !== DEFAULT_LISTEN_PORT
    if (port === 0 || (isUnderTest && !explicitPort)) {
      listenRuntime.disabled = port === 0 ? 'listenPort: 0' : 'test environment'
      log('info', 'independent listener disabled', {
        reason: port === 0 ? 'listenPort: 0' : 'test environment (pass explicit listenPort to enable)',
      })
      return once(() => {})
    }

    // ── 安全：无口令的端点不暴露到网络（H1，2026-10-20）───────────────
    //
    // 0.9.3 把端点从 DSH 的 webserver（默认绑 127.0.0.1）搬到了独立监听，
    // 而独立监听**主动挑最可达的地址**（Tailscale 优先）。于是"nodeToken 为空"
    // 从"只有本机能连"变成"整个 tailnet 无口令可连" —— 任何人都能
    // `attachDirect` 注册成节点、收到派发的任务内容。
    //
    // 规则：
    //   · listenHost 没显式配（自动选）+ token 空 → **强制回环**
    //     （用户没有表达"要对外"的意图，默认必须安全）
    //   · listenHost 显式配成非回环 + token 空 → 尊重用户，但明确警告
    const tokenBlank = cfg.nodeToken === ''
    const explicitNonLoopback = listenHost !== '' && !isLoopbackHost(listenHost)
    const forceLoopback = tokenBlank && !explicitNonLoopback

    const picked = forceLoopback
      ? { host: '127.0.0.1', source: 'loopback-no-token', candidates: [] }
      : resolveListenHost({ listenHost })

    if (forceLoopback) {
      log('warn', '独立监听退回 loopback：nodeToken 为空，端点不暴露到网络', {
        hint: '副机要接入，请先在面板「副机接入」生成口令（nodeToken），再重启 DSH。'
          + '（0.9.3 之前端点跟 DSH webserver 一起绑 loopback，不存在这个暴露面。）',
      })
    } else if (tokenBlank && explicitNonLoopback) {
      log('warn', 'nodeToken 为空但 listenHost 显式指向非回环地址 —— 端点无口令可连', {
        host: picked.host,
        hint: '仅限完全可信网络。建议尽快设置 nodeToken。',
      })
    }

    let disposed = false

    /**
     * 起监听，并对 **EADDRINUSE 做有限重试**。
     *
     * 为什么需要：0.9.5 起 apply 可重入（同一 ctx 重新 apply 时先摘上一代）。
     * 摘上一代会 `server.close()`，而**紧接着用同一个端口重新 listen** 在
     * Windows 上经常还会拿到 EADDRINUSE（close 是异步完成的，端口没这么快
     * 释放）。没有重试的话，"热重载"就会把端点变成永久不可用 —— 看起来和
     * "插件坏了"一样，但其实是可自愈的。
     *
     * 只重试 4 次（200/400/600ms）：真的被别的进程占了就该报错，不能无限拖。
     */
    const startWithRetry = async (attempt = 1) => {
      try {
        return await startListenServer({
          host: picked.host,
          port,
          path: cfg.nodePath,
          healthPath: cfg.healthPath,
          // 函数形态：按调用者身份分级（匿名只见 `{ ok: true }`）
          healthBody: (req) => healthPayload(req, 'listen-server'),
          onUpgrade: (conn, req) => {
            // 与 webServer 那条路完全相同的鉴权与交接逻辑（一处不能少：
            // token 校验是这条通道唯一的口令，跳过就是一个无鉴权入口）。
            if (cfg.nodeToken !== '') {
              const token = req.headers['x-dsh-token']
              if (!safeEqual(token, cfg.nodeToken)) {
                log('warn', 'node upgrade rejected: bad token (listen-server)', { remote: remoteAddress(req) })
                try {
                  conn.close(1008, 'bad token')
                } catch {
                  /* 已关 */
                }
                return
              }
            }
            registry.attachDirect(conn, { remote: remoteAddress(req) })
          },
          log,
        })
      } catch (err) {
        const code = String(err?.code ?? '')
        const inUse = code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err?.message ?? ''))
        if (inUse && attempt < 4 && !disposed) {
          log('warn', 'listen: port still held, retrying (previous generation closing)', {
            host: picked.host,
            port,
            attempt,
          })
          await new Promise((r) => {
            const t = setTimeout(r, 200 * attempt)
            if (t.unref) t.unref()
          })
          return startWithRetry(attempt + 1)
        }
        throw err
      }
    }

    startWithRetry()
      .then((h) => {
        if (disposed) {
          // 竞态：disposer 先跑了（插件卸载/HMR），把刚起来的 server 关掉
          void h.close()
          return
        }
        listenHandle = h
        // 运行时状态：面板的配对码与体检都读它（C1/M4）
        listenRuntime.ok = true
        listenRuntime.host = h.host
        listenRuntime.port = h.port
        listenRuntime.source = picked.source
        listenRuntime.error = ''
        log('info', 'node endpoint ready (independent listener)', {
          host: h.host,
          port: h.port,
          source: picked.source,
          path: cfg.nodePath,
        })
      })
      .catch((err) => {
        // ⚠ 监听失败不能静默：那会让"副机连不上"变成又一个无头案。
        // 但要**降级而非抛出** —— 本插件不该把整个 DSH 拖垮
        // （webServer 那条通道可能仍然可用）。
        listenRuntime.ok = false
        listenRuntime.host = picked.host
        listenRuntime.port = port
        listenRuntime.source = picked.source
        listenRuntime.error = String(err?.message ?? err)
        log('error', 'independent listener failed; falling back to webServer-only', {
          host: picked.host,
          port,
          error: String(err?.message ?? err),
          hint: '端口被占用或该地址不可用。可在插件配置里改 listenPort / listenHost。',
        })
      })

    return once(() => {
      disposed = true
      if (listenHandle) {
        void listenHandle.close()
        listenHandle = undefined
      }
    })
  }, 'remote-agent: independent-listener')

  // ── 直连 upgrade 路由（保留：webServer 路径恰好可用的场景）─────────────
  __reg(() => {
    const dispose = ctx.webServer.registerUpgrade({
      path: cfg.nodePath,
      handler: (req, socket, head) => {
        try {
          // direct 模式下可选校验 x-dsh-token；配置为空则不校验（用户自选的裸奔模式）
          if (cfg.nodeToken !== '') {
            const token = req.headers['x-dsh-token']
            if (!safeEqual(token, cfg.nodeToken)) {
              log('warn', 'node upgrade rejected: bad token', { remote: remoteAddress(req) })
              socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
              socket.destroy()
              return
            }
          }
          const conn = acceptUpgrade(req, socket, head, { name: 'remote-agent-node' })
          if (!conn) return
          registry.attachDirect(conn, { remote: remoteAddress(req) })
        } catch (err) {
          log('error', 'node upgrade handler failed', { error: String(err?.message ?? err) })
          try {
            socket.destroy()
          } catch {
            /* 已销毁 */
          }
        }
      },
    })
    return once(dispose)
  }, 'remote-agent: node-upgrade')

  // ── 健康检查（只读，不含凭证） ─────────────────────────────────
  //
  // 响应体由上面定义的 `healthPayload()` 产出（匿名只回 `{ ok: true }`，
  // 带正确 `x-dsh-token` 才给插件名/角色/计数）。这里只负责注册路由。
  __reg(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: cfg.healthPath,
      handler: (req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(healthPayload(req)))
        } catch (err) {
          log('warn', 'healthz failed', { error: String(err?.message ?? err) })
          try {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false }))
          } catch {
            /* 响应可能已结束 */
          }
        }
      },
    })
    return once(dispose)
  }, 'remote-agent: healthz')

  // ── Web 面板控制路由（client 半的数据源）──────────────────────
  //
  // 静态 bundle 的浏览器半边拿不到任何"远程节点/任务"的 Client 服务，
  // 所以面板通过 fetch 本组路由取数据（同 profile 的 dsh-context 也用这个模式）。
  if (cfg.uiEnabled) {
    __reg(() => {
      let disposers = []
      try {
        disposers = registerUiRoutes({
          ctx,
          registry,
          pulls,
          log,
          defaults: cfg.defaults,
          pullRoot: cfg.uiPullRoot,
          // 本行生效配置的只读快照，供面板「主机设置」区展示。
          // 传**原始** config（而非归一化后的 cfg），因为面板要如实反映用户写了什么。
          config,
          // 可达性：**必须传 getter**（2026-10-20）。
          // 独立监听是异步启动的，注册路由时它往往还没结果 —— 传快照会让面板
          // 永远显示启动瞬间的旧结论（0.9.3 的假红就是这么来的）。
          // 静态的 `reachability` 保留给老调用方/测试，getter 优先。
          reachability: currentReachability(),
          getReachability: currentReachability,
          // 独立监听的实时状态（ok/host/port/source/error/disabled）。
          // 配对码的端口必须来自这里 —— 浏览器地址栏的端口是 DSH webserver 的，
          // 与节点端点无关（C1）。
          listenRuntime,
        }).map(once)
      } catch (err) {
        log('error', 'ui route registration threw', { error: String(err?.message ?? err) })
        return () => {}
      }
      return () => {
        for (const d of disposers) d()
      }
    }, 'remote-agent: ui-routes')
  }

  // ── 八个 remote_* 工具 ────────────────────────────────────────
  //
  // ⚠ 这里**必须容错**：`ctx.tools` 是 loader 行 inject 声明的服务，若某个
  // 部署（旧 profile / 手写配置）没声明它，访问会抛
  //
  //     cannot get property "tools" without inject
  //
  // 而本函数的位置在路由注册**之后** —— 不兜住的话，整个 `applyHub` 抛错、
  // fiber 标记 failed，现象是**路由活着但工具全没了 + 插件页显示"异常"**
  // （实测踩过：包内 inject 被收窄成 ['webServer'] 就复现了）。
  //
  // 工具是**可选能力**：拿不到 tools 服务只该让工具消失，不该让整个 hub 挂掉。
  // 所以单独 try/catch，并把原因写进日志（否则又是"静默半死"）。
  __reg(() => {
    let toolsSvc
    try {
      toolsSvc = ctx.tools
    } catch (err) {
      log('error', 'tools service unavailable: remote_* tools NOT registered (check inject on the loader row)', {
        error: String(err?.message ?? err),
        hint: "loader 行的 inject 需要包含 'tools'",
      })
      return () => {}
    }
    if (!toolsSvc || typeof toolsSvc.register !== 'function') {
      log('warn', 'tools service missing register(): remote_* tools NOT registered')
      return () => {}
    }
    const disposers = registerRemoteTools({ ctx, registry, pulls, log, defaults: cfg.defaults, sessionGate }).map(once)
    disposers.push(...registerAdvancedTools({ ctx, registry, stateDir: cfg.stateDir, sessionGate, audit }).map(once))
    if (sessionGate.required && typeof toolsSvc.guard === 'function') {
      disposers.push(once(toolsSvc.guard((execution) => sessionGate.guard(execution))))
    }
    return () => {
      for (const d of disposers) {
        d()
      }
    }
  }, 'remote-agent: tools')

  // 可选会话门禁：只有显式开启 sessionGate 时才注册斜杠命令。
  const commandsSvc = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commandsSvc && sessionGate.required) {
    __reg(() => {
      const disposers = sessionGate.commands().map((command) => once(commandsSvc.register(command)))
      return () => { for (const dispose of disposers) dispose() }
    }, 'remote-agent: session-gate-commands')
  }

  // ── systemPrompt section ──────────────────────────────────────
  if (cfg.systemPrompt) {
    __reg(() => {
      let systemPromptSvc
      try {
        systemPromptSvc = ctx.systemPrompt
      } catch (err) {
        // 同上的理由：缺这个服务只该少一段提示词，不该让 hub 挂掉。
        log('warn', 'systemPrompt service unavailable: prompt section NOT registered', {
          error: String(err?.message ?? err),
        })
        return () => {}
      }
      const dispose = systemPromptSvc.section({
        name: 'remote-agent',
        order: PROMPT_ORDER,
        text: SYSTEM_PROMPT_TEXT + (cfg.sessionGate
          ? '\n\n本会话远程工具默认关闭；只有用户明确输入 /remote-agent on 后才能调用，/remote-agent off 会再次关闭。不要尝试绕过门禁。'
          : ''),
      })
      return once(dispose)
    }, 'remote-agent: system-prompt')
  }

  // ── subagent provider ────────────────────────────────────────
  // subagents 是可选服务：不能写进硬 inject（hub 也可能跑在没有 subagent 的组合里）。
  // 注册风格与上面五处保持一致：effect 回调里拿到 disposer，再用 once() 包成幂等。
  const registerProvider = (subagents) => {
    const provider = createRemoteAgentProvider({ registry, pulls, log, defaults: cfg.defaults, sessionGate })
    const dispose = subagents.registerProvider(provider)
    return once(dispose)
  }

  // subagents 是**可选**服务：不能写进 loader 行的硬 inject（hub 也可能跑在
  // 没有 subagent 的组合里）。所以用 `ctx.get('subagents')` 安全探测 ——
  // ⚠ 不能写 `ctx.subagents`：cordis 对未声明 inject 的服务访问会抛
  // `cannot get property "subagents" without inject`（实测）。
  const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
  if (subagents) {
    __reg(() => registerProvider(subagents), 'remote-agent: subagent-provider')
  }

  log('info', 'hub plugin applied', {
    path: cfg.nodePath,
    relay: cfg.relay ? redactUrl(cfg.relay.url) : 'direct',
    tokenCheck: cfg.nodeToken !== '',
  })

  return {
    registry,
    pulls,
    /**
     * 由调用方保管；DSH 卸载插件 / 我们自己在重入前清理时用。
     *
     * ⚠ **必须逆序**（最后注册的先摘）。`__reg` 的顺序是「运行时 effect 在最先、
     * 路由/工具/监听在其后」，而运行时那个 disposer 会 `registry.dispose()` /
     * `pulls.dispose()` —— 先拆它再去拆工具，工具的 disposer 就可能碰到已销毁的
     * registry（0.9.5 修重入时发现这里原来是正序跑的，与 cordis 的"逆序释放"
     * 语义和本文件的注释都不一致）。
     */
    disposeAll: () => {
      for (let i = __disposers.length - 1; i >= 0; i -= 1) {
        try {
          __disposers[i]()
        } catch {
          /* 已清 */
        }
      }
    },
  }
}

/** 生成一个节点 token（部署脚本用，避免手写弱口令）。 */
export function newNodeToken() {
  return `nt_${randomBytes(24).toString('base64url')}`
}

export { ERROR_CODE }
