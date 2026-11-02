/**
 * UI 控制路由：给 Web 面板提供只读数据 + 少量动作。
 *
 * 为什么用 HTTP 路由而不是别的通道：
 *   静态 bundle 的 client 半（浏览器）能用的 Client 服务只有 layout/sessions/slots/
 *   theme/timer/workspaces —— **没有任何一个能读到远程节点或任务**。而 `host.call()`
 *   属于动态包（cordis_run）机制，静态 bundle 不走那条路。同 profile 的
 *   `dsh-context` 与 `dsh-better-sidebar` 都是用 `fetch('<自己的路由>')` 拿 Host 数据，
 *   这是已在本机验证过可行的模式。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（v0.1 加固版，逐条结论见下方各段注释）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 【结论 1 · 这些路由**不在** DSH 的 /api 鉴权围栏内】
 *
 * 这是本文件最重要的一条。DSH 的 Host/Origin + 浏览器 cookie 围栏由
 * `@deepseek-ai/dsh-client-connection` 注册，而它的注册形态是：
 *
 *     kind: 'prefix', path: '/api'      // ← prefix
 *     handler: 先 admit(req)（Host/Origin + cookie），再 bridge 到 RPC
 *
 * 而本文件的路由是：
 *
 *     kind: 'exact',  path: '/api/remote-agent/ui/...'   // ← exact
 *
 * `@deepseek-ai/dsh-host-webserver` 的 `match()` 是 **exact 表优先于 prefix 表**：
 *
 *     match(pathname) {
 *       const exact = this.exact.get(pathname);
 *       if (exact !== void 0) return exact;      // ← 命中 exact 就直接返回
 *       ...longest-prefix-wins...
 *     }
 *
 * 结论：命中 exact 的请求**不会**走到 `/api` prefix 的 admit()，即我们的 UI 路由
 * 绕过了 DSH 的 token/cookie 围栏。已用真实 dsh-host-webserver 实测确认：
 * 同一台 server 上，`/api/remote-agent/ui/overview`（exact）返回 200，
 * 而 `/api/some-other/thing`（只命中 prefix）返回 401。
 *
 * 因此本文件**不能**假设"外层会替我们鉴权"，必须自带请求围栏 —— 见 `guard()`。
 * 这与 `dsh-context` 的做法一致：它走 `ctx.connection.fetch.register`（受围栏保护），
 * 而不是 `webServer.register`；我们走 webServer 是因为静态 bundle 拿不到 connection。
 *
 * 【结论 2 · CSRF：判定"低风险，但已显式加固"】
 *
 * 判定：第三方页面**无法**诱导这些动作，理由三条（前两条来自框架，第三条来自本文件）：
 *
 *   a) **cookie 是 SameSite=Strict**（client-connection `sessionCookie()`：
 *      `Path=/; HttpOnly; SameSite=Strict`）。跨站发起的 fetch/XHR 不会带上
 *      这个 cookie，所以跨站请求拿不到任何浏览器凭证。
 *   b) **JSON content-type 触发 CORS 预检**。`apiPost` 发的是
 *      `content-type: application/json`，属于"非简单请求"，浏览器必先发
 *      OPTIONS 预检；本文件不返回任何 `access-control-allow-*` 头，
 *      预检必然失败，真实请求不会发出。
 *      （`text/plain` 表单可绕过预检，但 body 是 `a=b` 形式，readJson() 解析失败 → 400。）
 *   c) **本文件现在主动拒绝跨源**（结论 1 的 guard）：带 `Origin` 且与 `Host`
 *      不一致 → 403；`sec-fetch-site: cross-site` → 403。即使 (a)(b) 因浏览器
 *      行为差异或未来框架改动而失效，这一层仍然拦得住。
 *
 * 结论：CSRF **不是**本组路由的主要风险面 —— 因为 DSH 的会话 cookie 是
 * SameSite=Strict 且动作要求 JSON，浏览器的同源模型已经把它挡在门外。
 * 主要风险面是**绕过围栏的本地/同源访问**（结论 1），以及 pull 的路径逃逸（结论 4）。
 * 因此 guard 的设计目标是"补上被绕过的围栏"，而不是"防 CSRF"。
 * 注意 guard 对无 Origin 的请求放行（curl/本机进程），这类客户端本就不携带
 * 浏览器凭证，不属于 CSRF 载体。
 *
 * 【结论 3 · 响应体逐字段白名单，绝不 spread】
 *
 * `nodeView()` / `taskView()` / `handoffView()` 都是**逐字段构造**的字面量对象。
 * 反例是 `{...registry.list()[i]}` 或 `{...t.handoff}` —— 那会让将来新增的
 * 内部字段（conn、hello 全量、pendingPulls…）自动泄漏到浏览器。
 * `handoffView()` 尤其重要：handoff 由副机上报，字段集不受本文件控制。
 *
 * 【结论 4 · pull 是唯一写盘动作，双道校验】
 *
 * 顺序必须是：字符串层 isInside → mkdir → realpath 复查。
 * 先字符串（挡 `../` 与反斜杠），再 realpath（挡符号链接与 8.3 短名）。
 * 注意 realpath **必须在 mkdir 之后**，否则新目录 realpath 会失败；
 * 而"先 mkdir 再校验"意味着一个越界目录可能被**创建**出来 —— 这是可接受的，
 * 因为创建空目录不是数据泄漏，而写入越界文件才是。见 `resolvePullDest()`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ERROR_CODE, RemoteAgentError, TASK_MODE } from '../protocol.js'
// 分模式默认超时（提案 #26-1）：与 remote_task 工具同源常量。
// 面板派单也必须按 mode 取值，否则 exec 会静默吃 1 小时超时（2026-10-17 修）。
import { AGENT_DEFAULT_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS } from '../node/task-engine.js'
import { isInside, normalizePath } from '../glob.js'
// 副机接入（pair-info）：复用向导的同一份纯逻辑 —— 面板生成的配对码与
// dsh-remote-setup 生成的一字不差，避免两套实现漂移。
import { detectLanIps, buildHubUrl } from '../setup.js'
import { encodePairCode } from '../pairing.js'
// 视图投影共享层：工具路径与 UI 路径用**同一份**白名单，
// 不让任一方绕开投影（见下方「视图投影」段的说明）。
import {
  handoffView,
  nodeView,
  taskView,
} from './views.js'
// 任务模板库（配方）：模板是"派发表单的预设值"，存 hub 本地 JSON。
// 校验/原子写/并发串行化都在那个模块里（本文件只做路由与围栏）。
import { createTemplateStore, defaultTemplatesFile } from './templates.js'
// 环境体检（2026-10-17）：与命令行 `dsh-remote-setup --doctor` 共用同一份检查逻辑。
// 存在的理由是那个最贵的静默失败 —— webserver 绑 loopback 时副机永远连不上，
// 而主机侧毫无异常。面板必须把它渲染出来。
import { envChecks } from '../env-check.js'
// 角色解析**只有一份实现**：v0.9.0 起默认 role 是 'auto'，凡是判定
// "是不是 hub" 的地方都必须过这一层（v0.9.0 审查 H1 的根因就是这里漏了）。
import { resolveRole } from '../index.js'
// 一键修复（2026-10-20）：只改托管块 + 备份 + 写后校验 + 可撤销。
// 用户此前说过"不要改 DSH"，所以这个模块的每道防线都对应一次真实事故。
import { applyFixPlan, isManagedBackup, listBackups, planFixes, undoFix } from '../auto-fix.js'
// 外部工具检测（2026-10-20）：探测 Tailscale/PowerShell/git/node 在不在，
// 缺了给"为什么需要 + 官方链接 + 安装命令"，**不代下载**。
import { probeExternalTools } from '../external-tools.js'
// 写盘器：自带备份 + 冲突检测 + 写后校验 + 失败回滚（与 setup 向导共用同一份）。
import { writePatchBlock } from '../setup.js'

export const UI_API_PREFIX = '/api/remote-agent/ui'

/** 单次请求体上限：UI 只发小 JSON，超过就是异常。 */
const MAX_BODY = 256 * 1024

/** 错误消息回给浏览器的上限（避免把绝对路径/内部细节整段回显）。 */
const MAX_ERR_MESSAGE = 300

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // 面板数据不进任何缓存：任务状态是活的
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJson(req, maxBody = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBody) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 错误消息净化：只回稳定 code + 截断后的短消息，绝不回堆栈。
 *
 * 为什么必须截断：`RemoteAgentError` 的消息里经常带绝对路径
 * （例如 `artifact vanished: C:\Users\...\x`、`workspace outside allowed roots: ...`），
 * 整段回显等于把主机目录结构交给浏览器。堆栈更糟（含源码路径与行号）。
 * 所以这里**只取 message 的前 N 字符**，并且从不把 `err.stack` 写进响应。
 */
function shortMessage(err) {
  const raw = String(err?.message ?? err ?? '')
  // 去掉可能夹带的换行/堆栈形态尾巴
  const firstLine = raw.split(/\r?\n/)[0]
  return firstLine.slice(0, MAX_ERR_MESSAGE)
}

/**
 * 本地请求围栏的兜底实现（当 `connection` 服务不可用时使用）。
 *
 * 刻意做成 DSH `isTrustedApiRequest` 的**保守子集**：
 *   - `sec-fetch-site: cross-site` → 拒（浏览器明确标注的跨站）
 *   - 带 `Origin` 且其 host 与 `Host` 不一致 → 拒（跨源）
 *   - 无 `Origin`（curl / 本机进程 / 测试）→ 放行
 *
 * 为什么无 Origin 放行：非浏览器客户端不会自动携带凭证，本就不是 CSRF 载体；
 * 而要求 Origin 会让所有 CLI/测试调用失效。真正的边界是 Host/Origin 一致性。
 */
function sameOriginOk(req) {
  const headers = req?.headers ?? {}
  const host = headers.host
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 请求围栏：每个 UI 路由的第一道门。
 *
 * 【为什么必须有这一道】
 * 见文件头"结论 1"：本文件注册的是 `kind:'exact'`，而 DSH 的 /api 围栏是
 * `kind:'prefix'`，WebServer.match() exact 优先 → 我们的路由**绕过**了 DSH 的
 * Host/Origin + cookie 鉴权。所以不能假设"外层会替我们鉴权"。
 *
 * 【怎么补】优先复用框架自己的围栏，而不是自己造一套：
 *   `ctx.connection.requestRejection(request)` 的官方用途正是
 *   "Apply Connection's Host/Origin checks and browser authentication to
 *    **another** Web route" —— 我们就是那个 another route。
 *   返回 401 / 403 / undefined，语义与 DSH 内建 /api 完全一致。
 *
 * 该服务不存在时（例如无 web 组件的组合、单元测试）退回到 sameOriginOk()，
 * 保证"没有围栏"不会退化成"完全不检查跨站"。
 *
 * @returns {true} 放行；{false} 已写响应，调用方应立即返回
 */
function makeGuard(ctx, log) {
  return function guard(req, res, pathname) {
    let rejection
    try {
      // 与 webServer 同理：**属性访问优先**，`ctx.get(name, false)` 非严格兜底。
      // `ctx.get` 默认 strict=true 只返回"提供者 fiber 当前活跃"的服务，
      // 在 apply() 早期可能拿不到（实测：引导路由因此静默不注册）。
      let connection
      try {
        connection = ctx.connection
      } catch {
        /* 未声明 inject 时属性访问会抛 */
      }
      if (!connection && typeof ctx.get === 'function') connection = ctx.get('connection', false)
      if (connection && typeof connection.requestRejection === 'function') {
        rejection = connection.requestRejection({ headers: req.headers ?? {} })
      }
    } catch (err) {
      // 围栏自身出错时**失败关闭**：宁可面板不可用，也不放行未鉴权请求。
      log('warn', 'ui guard: connection fence threw, failing closed', { path: pathname, error: shortMessage(err) })
      rejection = 403
    }
    if (rejection === undefined && !sameOriginOk(req)) rejection = 403
    if (rejection === undefined) return true
    writeJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return false
  }
}

// ── 视图投影：**从 lib/hub/views.js 共享** ──────────────────────────
//
// 这里的六个投影函数（nodeView / changedView / exitView / errorView /
// taskView / handoffView）原本定义在本文件里。提取出去的原因是：它们只被
// UI 路径使用，而 `remote_handoff` 工具因为"没有对应的 View 函数"就裸直出了
// `t.handoff` —— 加固做了一半，而且漏掉的正是更该加固的那一半
// （工具返回值会进入会话日志，被后续每个请求带上）。
//
// 集中到 views.js 后，新增消费方无处可绕开投影。

/**
 * 计算 pull 的落盘目录，双道校验。
 *
 * 顺序（**不可调换**）：
 *   1. 字符串层 `isInside(pullRoot, destDir)` —— 挡 `../`、`..\`、绝对路径
 *   2. `mkdirSync(destDir)` —— 目录不存在时 realpath 会失败，所以必须先建
 *   3. `realpathSync(destDir)` 后复查 `isInside(realRoot, realDest)`
 *      —— 挡符号链接、Windows 8.3 短名、junction 等字符串层看不出的逃逸
 *
 * 已知的取舍：第 2 步可能创建一个"最终会被判定越界"的空目录
 * （例如 pullRoot 内已有一个指向 /etc 的符号链接，我们会在 /etc 下 mkdir）。
 * 这是可接受的 —— 创建空目录不是数据泄漏，越界**写入**才是，
 * 而第 3 步保证了越界写入不会发生。反过来若先校验再 mkdir，
 * 新建目录的 realpath 会抛 ENOENT，正常路径反而不可用。
 *
 * @returns {{ok:true, dir:string} | {ok:false, code:string, dest:string}}
 */
export function resolvePullDest(pullRoot, sub) {
  const destDir = path.resolve(pullRoot, typeof sub === 'string' ? sub : '')

  // ① 字符串层：挡 ../ 与反斜杠写法
  if (!isInside(normalizePath(pullRoot), normalizePath(destDir), {})) {
    return { ok: false, code: 'dest-outside-pull-root', dest: typeof sub === 'string' ? sub : '' }
  }

  let realRoot
  let realDest
  try {
    fs.mkdirSync(pullRoot, { recursive: true })
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(pullRoot) : fs.realpathSync(pullRoot)
    // ② 建目录（realpath 要求路径存在）
    fs.mkdirSync(destDir, { recursive: true })
    // ③ realpath 归一后复查：挡符号链接逃逸
    realDest = fs.realpathSync.native ? fs.realpathSync.native(destDir) : fs.realpathSync(destDir)
  } catch (err) {
    return { ok: false, code: 'pull-root-unusable', dest: typeof sub === 'string' ? sub : '', message: shortMessage(err) }
  }

  if (!isInside(normalizePath(realRoot), normalizePath(realDest), {})) {
    return { ok: false, code: 'dest-outside-pull-root-after-resolve', dest: typeof sub === 'string' ? sub : '' }
  }
  return { ok: true, dir: realDest }
}

/**
 * 注册 UI 路由。
 *
 * @param {object} o
 * @param {object} o.ctx dsh 上下文（需要 webServer）
 * @param {object} o.registry NodeRegistry
 * @param {object} o.pulls PullManager
 * @param {(level:string,msg:string,extra?:object)=>void} o.log
 * @param {object} o.defaults remote_task 默认值
 * @param {string} [o.pullRoot] 允许 UI 拉取产物落地的根目录（绝对路径）。未配置则禁用 pull。
 * @param {string} [o.uiTemplatesFile] 任务模板库的 JSON 绝对路径。未配置则落在
 *   `config.stateDir/templates.json`（见 templates.js 的 defaultTemplatesFile）。
 * @param {object} [o.config] 本插件行的**生效配置**（只读快照），供面板展示
 * @returns {Array<() => void>} disposers
 */
export function registerUiRoutes({
  ctx,
  registry,
  pulls,
  log,
  defaults = {},
  pullRoot,
  uiTemplatesFile,
  config = {},
  // 可达性自检结论（2026-10-17）：{ bound, origin, loopback, hint }
  // 绑 loopback 时副机永远连不上，而这个失败在主机侧完全静默 ——
  // 面板必须渲染成红色横幅，否则用户只能去猜"地址填错了？token 错了？"
  //
  // ⚠ 2026-10-20：必须用 **getter**，不能用快照。
  // 独立监听是异步启动的，注册路由的这一刻它通常还没有结果；传快照会让面板
  // 永远显示启动瞬间的旧结论（0.9.3 的"假红"就是这么产生的）。
  reachability = null,
  getReachability = null,
  // 独立监听的实时状态：{ ok, disabled, host, port, source, error }
  listenRuntime = null,
}) {
  const disposers = []
  const guard = makeGuard(ctx, log)

  /**
   * 当前 profile 的 cordis.patch.yml 绝对路径（与 setup-routes 同口径）。
   *
   * 一键修复要改的就是这个文件。判定方式与 `lib/setup-routes.js` 的
   * `currentPatchFile()` **完全一致** —— 两处不一致会让"面板显示改的是 A、
   * 实际写的是 B"，是最难排查的一类错。
   */
  const currentPatchFile = () => {
    const raw = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
      ? process.env.DSH_PROFILE.trim()
      : 'desktop'
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '')
    return path.join(os.homedir(), '.dsh', 'profiles', safe === '' ? 'desktop' : safe, 'cordis.patch.yml')
  }

  /** 取当前可达性结论：getter 优先，静态快照兜底（兼容老调用方/测试）。 */
  const reachOf = () => {
    if (typeof getReachability === 'function') {
      try {
        const r = getReachability()
        if (r) return r
      } catch {
        /* 取失败退回快照 */
      }
    }
    return reachability
  }

  // 注册计数：`applyHub` 结束时会打一行日志汇总。
  // 为什么用 log 而不是写文件：上一轮排查用的文件诊断在清理时被删了，
  // 而**路由注册失败是静默致命的**（面板只看到 404，启动日志里什么都没有）。
  // 用 log 至少能在 DSH 的宿主 stdout / 日志里看到，且不会留垃圾文件。
  let registeredCount = 0
  let failedCount = 0



  /**
   * 面板可读的配置视图。
   *
   * **为什么只读**：改配置需要写回 profile 的 patch 层（`cordis.patch.yml`），
   * 而那条路径由 loader 拥有 —— 插件在运行时改它会让下次启动的配置与当前进程
   * 不一致，且没有事务保证。所以面板只**展示**当前生效值，要改请编辑 profile。
   * 这比提供一个"半可靠"的写入按钮更诚实。
   */
  const configView = () => ({
    role: typeof config.role === 'string' ? config.role : 'hub',
    // ⚠ 凭证一律**只回"是否已设置"的布尔**，绝不回明文 —— 面板是浏览器里的东西，
    // 它看到的每个字节都可能被扩展、调试工具或被截图带走。
    // （nodeToken 曾经原样回传，是实测发现的泄漏；relay.token 一开始就是布尔。）
    nodeTokenSet: typeof config.nodeToken === 'string' && config.nodeToken !== '',
    relayTokenSet: typeof config.relay?.token === 'string' && config.relay.token !== '',
    uiPullRoot: typeof config.uiPullRoot === 'string' ? config.uiPullRoot : '',
    uiEnabled: config.uiEnabled !== false,
    relayUrl: typeof config.relay?.url === 'string' ? config.relay.url : '',
    nodeId: typeof config.nodeId === 'string' ? config.nodeId : '',
    transportMode: typeof config.transportMode === 'string' ? config.transportMode : 'relay',
    roots: Array.isArray(config.roots) ? config.roots : [],
    stateDir: typeof config.stateDir === 'string' ? config.stateDir : '',
    // 会话级开关（0.10.0）：true 时每个会话必须 `/remote-agent on` 才能用 remote_*。
    // 面板只需显示这个布尔值 —— 开关本身由命令控制，面板改不了（改它要重启）。
    sessionGate: config.sessionGate === true,
    // 让面板能提示"改这些要去哪改"
    editHint: '以下配置在 profile 的 cordis.patch.yml 里修改，改完重启 DSH 生效',
  })

  /**
   * 每个 handler 都包两层：
   *   1. **请求围栏**（guard）：见文件头"结论 1" —— 这些 exact 路由绕过 DSH 的
   *      /api prefix 围栏，必须自己复用 connection.requestRejection。
   *   2. **异常收口**：稳定 code + 截断消息（**不含堆栈**，堆栈里有绝对路径），
   *      且 UI 抛错不能让 host 崩。
   */
  const route = (pathname, handler) => {
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          try {
            // 请求到达取证。**这一行是排查面板 404/401 的唯一可靠手段** ——
            // 面板请求经 Electron 的 forwardWebRequest 改写（剥 host/origin/
            // cookie/sec-fetch-site，再注入 hostCookie），从外面 curl 永远
            // 复现不出那个形态。所以必须记录"真实到达的请求长什么样"。
            //
            // 只记**判定所需**的字段，且 cookie 只记"是否存在 + 长度"，
            // 绝不记明文（日志可能被带走）。
            const h = req.headers ?? {}
            const ck = typeof h.cookie === 'string' ? h.cookie : ''
            log('info', 'ui request in', {
              path: pathname,
              method: req.method,
              host: typeof h.host === 'string' ? h.host : null,
              hasCookie: ck !== '',
              cookieLen: ck.length,
              origin: typeof h.origin === 'string' ? h.origin : null,
              secFetchSite: typeof h['sec-fetch-site'] === 'string' ? h['sec-fetch-site'] : null,
              ua: typeof h['user-agent'] === 'string' ? h['user-agent'].slice(0, 60) : null,
            })
            if (!guard(req, res, pathname)) {
              log('warn', 'ui route rejected by guard', {
                path: pathname,
                hasCookie: ck !== '',
                origin: typeof h.origin === 'string' ? h.origin : null,
                secFetchSite: typeof h['sec-fetch-site'] === 'string' ? h['sec-fetch-site'] : null,
              })
              return
            }
            await handler(req, res)
          } catch (err) {
            const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
            log('warn', 'ui route failed', { path: pathname, code, error: shortMessage(err) })
            try {
              writeJson(res, 500, { error: code, message: shortMessage(err) })
            } catch {
              /* 响应可能已发出 */
            }
          }
        },
      }))
      registeredCount += 1

    } catch (err) {
      // 注册抛错是**静默致命**的：路由不存在 → 请求落到 /api prefix → 面板看到
      // 404/401，而启动日志里什么都没有。必须留痕。
      failedCount += 1
      log('error', 'ui route registration failed', { path: pathname, error: shortMessage(err) })
    }
  }

  // ── 总览：节点 + 任务计数 + 面板自身能力 ──────────────────────
  route(`${UI_API_PREFIX}/overview`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const nodes = registry.list().map(nodeView)
    const tasks = registry.listTasks().map((t) => registry.taskView(t))
    // 连接尝试历史（2026-10-20，体验提升 ①）：副机连不上时面板要能说清原因。
    // 逐字段投影（不 spread）—— 与其他 UI 响应同一条硬规则。
    const connReport = (() => {
      try {
        const r = registry.connectionReport(20)
        const mapEntry = (e) => ({
          at: Number.isFinite(e.at) ? e.at : 0,
          result: e.result === 'ok' ? 'ok' : 'fail',
          code: typeof e.code === 'string' ? e.code : '',
          nodeId: typeof e.nodeId === 'string' ? e.nodeId : '',
          remote: typeof e.remote === 'string' ? e.remote : '',
          title: typeof e.title === 'string' ? e.title : '',
          detail: typeof e.detail === 'string' ? e.detail : '',
          hint: typeof e.hint === 'string' ? e.hint : '',
          raw: typeof e.message === 'string' ? e.message : '',
        })
        return {
          everConnected: r.everConnected === true,
          byNode: Array.isArray(r.byNode) ? r.byNode.slice(0, 20).map(mapEntry) : [],
          recent: Array.isArray(r.recent) ? r.recent.slice(0, 20).map(mapEntry) : [],
        }
      } catch {
        // 诊断数据取不到不该让整个面板挂掉
        return { everConnected: false, byNode: [], recent: [] }
      }
    })()
    writeJson(res, 200, {
      ok: true,
      nodes,
      // 连接尝试历史：面板据此显示"最后尝试 2 分钟前 —— 握手超时 → …"
      connection: connReport,
      counts: {
        nodes: nodes.length,
        online: nodes.filter((n) => n.online).length,
        tasks: tasks.length,
        running: tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
        activePulls: pulls.activeCount,
      },
      // 面板据此决定按钮是否可用，而不是让用户点了才知道不行
      capabilities: {
        pull: typeof pullRoot === 'string' && pullRoot !== '',
        // 未配置时回 null（而不是空串）：normalizeConfig 会把未配置归一成 ''，
        // 面板据此判断"该不该显示落地目录"，空串会渲染成 "落地到 " 这种残缺文案。
        pullRoot: typeof pullRoot === 'string' && pullRoot !== '' ? pullRoot : null,
        dispatch: true,
        // 可达性自检（2026-10-17）：`loopback === true` 时副机永远连不上，
        // 面板渲染红色横幅。逐字段投影，不 spread。
        // 2026-10-20：结论来自 `reachOf()`（独立监听优先），并带上 via/port，
        // 让面板能说清"是哪条通道在听"。
        reachability: (() => {
          const r = reachOf()
          if (!r) return null
          return {
            bound: typeof r.bound === 'string' ? r.bound : null,
            origin: typeof r.origin === 'string' ? r.origin : null,
            loopback: r.loopback === true,
            hint: typeof r.hint === 'string' ? r.hint : '',
            via: typeof r.via === 'string' ? r.via : 'webserver',
            port: Number.isFinite(r.port) ? r.port : null,
          }
        })(),
        // 独立监听的原始状态：面板要区分"在听 / 失败 / 关闭"三种情形
        listener: listenRuntime
          ? {
            ok: listenRuntime.ok,
            disabled: typeof listenRuntime.disabled === 'string' ? listenRuntime.disabled : '',
            host: typeof listenRuntime.host === 'string' ? listenRuntime.host : '',
            port: Number.isFinite(listenRuntime.port) ? listenRuntime.port : null,
            source: typeof listenRuntime.source === 'string' ? listenRuntime.source : '',
            error: typeof listenRuntime.error === 'string' ? listenRuntime.error : '',
          }
          : null,
      },
    })
  })

  // ── 节点列表 ──────────────────────────────────────────────────
  route(`${UI_API_PREFIX}/nodes`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    writeJson(res, 200, { nodes: registry.list().map(nodeView) })
  })

  // ── 任务列表（可按节点过滤） ──────────────────────────────────
  route(`${UI_API_PREFIX}/tasks`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const nodeId = url.searchParams.get('node') ?? ''
    let tasks = registry.listTasks().map((t) => registry.taskView(t))
    if (nodeId !== '') tasks = tasks.filter((t) => t.nodeId === nodeId)
    // 最近的在前，面板顶部就是最新活动
    tasks.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    writeJson(res, 200, { tasks: tasks.slice(0, 200).map((t) => taskView(t)) })
  })

  // ── 单任务详情（含 handoff 卡片） ─────────────────────────────
  route(`${UI_API_PREFIX}/task`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const taskId = url.searchParams.get('taskId') ?? ''
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    const view = taskView(t, { tail: 20 })
    // handoff 经白名单投影后再回（副机上报的字段集不受本文件控制）
    writeJson(res, 200, { task: view, handoff: handoffView(t.handoff) })
  })

  // ── 动作：派任务 ──────────────────────────────────────────────
  route(`${UI_API_PREFIX}/dispatch`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (!body) return writeJson(res, 400, { error: 'bad-body' })

    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (goal === '') return writeJson(res, 400, { error: 'goal-required' })

    const nodes = registry.list()
    const nodeId = typeof body.node === 'string' && body.node !== ''
      ? body.node
      : (nodes.length === 1 ? nodes[0].nodeId : '')
    if (nodeId === '') {
      return writeJson(res, 400, { error: 'node-required', message: '多个节点时必须在 body.node 指定' })
    }
    if (!registry.getNode(nodeId)) return writeJson(res, 404, { error: 'node-unknown', nodeId })

    const mode = body.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT
    const taskId = `ui-${Date.now().toString(36)}${Math.floor(Math.random() * 0x1000).toString(36)}`

    // 复用与 remote_task 工具完全相同的注册路径，避免两套行为漂移
    const { validateTaskStart } = await import('../protocol.js')
    const v = validateTaskStart({
      taskId,
      goal,
      workspace: typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : undefined,
      mode,
      // 两阶段审批（提案 #2）：面板同样可显式选 auto/manual；缺省语义在
      // validateTaskStart（exec→manual、agent→auto），与 remote_task 一致。
      approval: body.approval,
      // 面板派单也可以指定模型（字符串 "provider/model" 或 {provider,model} 对象，
      // 归一与容错都在 validateTaskStart / normalizeModelSelection 里）
      model: body.model,
      outputs: Array.isArray(body.outputs) ? body.outputs.filter((s) => typeof s === 'string') : [],
      constraints: {
        // 提案 #26-1（2026-10-17 修第三处）：面板派单也必须按 mode 分模式取默认。
        //
        // 原实现 `defaults.timeoutMs ?? 3600000` 让面板派 exec 任务也吃 1 小时
        // 超时 —— 与 remote_task 工具同样的缺陷（exec 该是 10 分钟）。
        // 三处同族失效点：tools.js（TDZ + 兜底遮蔽）、hub/index.js（1h 兜底）、
        // 这里（1h 兜底）。
        timeoutMs: Number.isFinite(body.timeoutMs)
          ? body.timeoutMs
          : (Number.isFinite(defaults.timeoutMs)
            ? defaults.timeoutMs
            : (mode === TASK_MODE.EXEC ? EXEC_DEFAULT_TIMEOUT_MS : AGENT_DEFAULT_TIMEOUT_MS)),
        denyPaths: [],
      },
      origin: 'ui',
    })
    if (!v.ok) return writeJson(res, 400, { error: v.error })

    registry.createTask({ nodeId, spec: v.spec })
    // approval（提案 #2）：exec 任务默认 manual —— 面板要如实告知"已挂起待批"
    writeJson(res, 200, { ok: true, taskId, nodeId, mode, approval: v.spec.approval })
  })

  // ── 动作：取消任务 ────────────────────────────────────────────
  route(`${UI_API_PREFIX}/cancel`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (taskId === '') return writeJson(res, 400, { error: 'taskId-required' })
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    // cancelTask 返回 false 有两种含义：任务不存在（上面已排除）或 cancel 帧没发出去
    // （节点离线）。所以 requested=false 表示"请求未能送达"，面板应据此提示。
    const delivered = registry.cancelTask(taskId) === true
    writeJson(res, 200, { ok: true, requested: delivered, nodeId: t.nodeId })
  })

  // ── 动作：审批（提案 #2 两阶段审批）──────────────────────────
  // 批准挂起的任务：此刻才真正派给副机。任何错误都给明确状态码 ——
  // 批准动作绝不能"看起来成功其实没派"。
  route(`${UI_API_PREFIX}/approve`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (taskId === '') return writeJson(res, 400, { error: 'taskId-required' })
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    let approved
    try {
      approved = registry.approveTask(taskId, { by: 'ui' })
    } catch (err) {
      // 批准时节点掉线：任务已转 failed，如实告诉面板
      return writeJson(res, 502, { error: 'node-unreachable', taskId, message: shortMessage(err) })
    }
    if (!approved) return writeJson(res, 409, { error: 'not-pending', taskId, status: t.status })
    writeJson(res, 200, { ok: true, taskId, nodeId: t.nodeId })
  })

  // 拒绝挂起的任务：任务转 rejected 终态（幂等；对已派发的任务返回 409）。
  route(`${UI_API_PREFIX}/reject`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (taskId === '') return writeJson(res, 400, { error: 'taskId-required' })
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 300) : ''
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    const rejected = registry.rejectTask(taskId, { by: 'ui', reason })
    if (!rejected) return writeJson(res, 409, { error: 'not-pending', taskId, status: t.status })
    writeJson(res, 200, { ok: true, taskId, status: 'rejected' })
  })

  // ── 动作：清理任务视图 ────────────────────────────────────────
  //
  // 面板上的「清理」按钮。为什么需要它：hub 侧任务视图会累积（副机的任务
  // 记录默认保留 7 天，所以它会持续 sync 回来），累积到 maxTasksPerNode
  // 就会**拒绝一切新任务** —— 那种情况下连"派一条清理命令"都做不到，
  // 必须有一个不依赖派任务本身的入口。这个按钮就是那个入口。
  //
  // 语义：**只清 hub 视图，不碰副机状态**（副机是任务状态的权威）。
  // 默认只清终态；在跑的任务保留，除非显式传 includeActive。
  route(`${UI_API_PREFIX}/purge`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const wanted = typeof body?.node === 'string' ? body.node : ''
    const includeActive = body?.includeActive === true
    // 显式指定 node 时先校验存在 —— 否则会静默清 0 条，用户以为成功了。
    let nodeId
    if (wanted !== '') {
      const rec = registry.pickNode(wanted)
      if (!rec) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, node: wanted })
      nodeId = rec.nodeId
    }
    const { removed, kept } = registry.purgeTasks({ nodeId, includeActive })
    log('info', 'ui purge', { removed, kept, nodeId: nodeId ?? '(all)', includeActive })
    writeJson(res, 200, { ok: true, removed, kept, includeActive })
  })

  // ── 动作：拉产物 ──────────────────────────────────────────────
  //
  // 这是唯一会写磁盘的 UI 动作，所以约束最严：
  //   - 必须配置 pullRoot（否则整个动作禁用）
  //   - dest 只能是 pullRoot 内的相对子路径，且经 realpath 归一后仍在其中
  route(`${UI_API_PREFIX}/pull`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    if (typeof pullRoot !== 'string' || pullRoot === '') {
      return writeJson(res, 403, { error: 'pull-disabled', message: '未配置 uiPullRoot，UI 拉取已禁用' })
    }
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === 'string') : []
    if (taskId === '' || paths.length === 0) {
      return writeJson(res, 400, { error: 'taskId-and-paths-required' })
    }
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })

    // 目标目录：pullRoot + 可选相对子目录（双道校验，见 resolvePullDest）
    const resolved = resolvePullDest(pullRoot, body?.dest)
    if (!resolved.ok) {
      const status = resolved.code === 'pull-root-unusable' ? 500 : 403
      return writeJson(res, status, { error: resolved.code, dest: resolved.dest })
    }

    const results = []
    for (const p of paths.slice(0, 50)) {
      try {
        // pull() 的契约是 { nodeId, taskId, relPath, dest }（见 pull-manager.js）
        const r = await pulls.pull({ nodeId: t.nodeId, taskId, relPath: p, dest: resolved.dir })
        results.push({ path: p, ok: true, bytes: r?.bytes ?? null, sha256: r?.sha256 ?? null })
      } catch (err) {
        const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
        results.push({ path: p, ok: false, error: code, message: shortMessage(err) })
      }
    }
    writeJson(res, 200, { ok: true, dest: resolved.dir, results })
  })

  // ── 配置视图：面板里的「主机设置」区读它 ──────────────────────
  //
  // 只读。改配置要编辑 profile 的 patch 层并重启 —— 插件在运行时写它会让
  // 下次启动的配置与当前进程不一致，且没有事务保证。面板负责**展示**当前
  // 生效值 + 指明去哪改，比提供一个半可靠的写入按钮更诚实。
  route(`${UI_API_PREFIX}/config`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    writeJson(res, 200, { ok: true, config: configView() })
  })

  // ── 环境体检 ──────────────────────────────────────────────────
  //
  // 与命令行 `dsh-remote-setup --doctor` 共用 `lib/env-check.js` 的同一份逻辑。
  //
  // 为什么面板上必须有这一屏（2026-10-17 实测）：那个最贵的静默失败是
  // "webserver 绑 127.0.0.1 → 副机永远连不上，而主机侧毫无异常"。日志用户
  // 不会看，面板会看。所以体检结果要能一键看到，且每条都带修法。
  //
  // 探测项里有一部分需要**真实系统信息**（端口占用、防火墙、Tailscale），
  // 这里只传能拿到的：reachability 来自 applyHub 的自检、nodesOnline 来自
  // registry。其余留给调用方（命令行）补 —— 拿不到的项 envChecks 会跳过，
  // 不会误报。
  route(`${UI_API_PREFIX}/env-check`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    let result
    try {
      const nodes = registry.list()
      result = envChecks({
        // ⚠ 必须传**解析后**的角色（2026-10-17 修 v0.9.0 审查 H1）。
        //
        // 原实现传的是原始 `config.role` —— 而 v0.9.0 起默认安装的生效配置
        // 就是 `role: 'auto'`。envChecks 内部的 `isHub` 判据若拿到未解析的
        // 'auto' 会判 false，导致 reachability/port/firewall/tailscale/nodes
        // **五项全部跳过**，role 与 inject 两项还会误报 —— 体检对 100%
        // 默认安装用户完全失效。
        //
        // 本路由只在 hub（或 both）分支注册，所以直接传 'hub' 也正确；
        // 用 resolveRole 更稳妥（覆盖 both 与显式 hub 两种）。
        role: resolveRole(config) || 'hub',
        config,
        // 实时取（独立监听优先），不能再用注册时的快照
        reachability: reachOf(),
        // 独立监听的原始状态：体检要能单独报"主通道起没起来"（M4）
        listener: listenRuntime
          ? {
            ok: listenRuntime.ok,
            disabled: typeof listenRuntime.disabled === 'string' ? listenRuntime.disabled : '',
            host: typeof listenRuntime.host === 'string' ? listenRuntime.host : '',
            port: Number.isFinite(listenRuntime.port) ? listenRuntime.port : null,
            source: typeof listenRuntime.source === 'string' ? listenRuntime.source : '',
            error: typeof listenRuntime.error === 'string' ? listenRuntime.error : '',
          }
          : null,
        nodesOnline: nodes.filter((n) => n.online).length,
      })
    } catch (err) {
      // 体检自身出错不能让面板白屏 —— 回一个"体检失败"而不是 500
      log('warn', 'env-check threw', { error: shortMessage(err) })
      return writeJson(res, 200, {
        ok: false,
        items: [{ ok: false, id: 'internal', label: '体检自身出错', fix: '', detail: shortMessage(err), autoFix: false, severity: 'error' }],
        failed: 1,
        autoFixable: 0,
      })
    }
    writeJson(res, 200, result)
  })

  // ── 一键修复（2026-10-20，用户要求）──────────────────────────────
  //
  // ⚠⚠ **这会改 `<profile>/cordis.patch.yml`** —— DSH 自己的配置文件。
  // 用户此前明确说过「不要改 DSH」，所以这里的每一道防线都是**踩过的坑**：
  //
  //   · 我们手写过 `host: '0.0.0.0'` → DSH 启动崩溃（10 份 crash 日志）
  //   · 我们追加过 remote-agent 段 → 被 DSH 下次启动重写冲掉
  //
  // 防线（缺一不可）：
  //   1. `POST` 必须带 `confirm: 'yes'` —— 缺了直接 400，没有默认通过
  //   2. `action: 'plan'` 是**只读**的，先让用户看清"将要改什么"
  //   3. 写盘走 `writePatchBlock` —— 它自带备份 + 冲突检测 + 写后校验 + 回滚
  //   4. 只改**托管块**，用户手写的其它条目一个字节不碰
  //   5. 写后本模块再校验一遍（重复 id / 条目缺失 → 提示用「撤销」）
  //   6. `action: 'undo'` 用备份覆盖回去 —— 一键回滚
  //
  // **只修机械可判定的项**（webserver host / role）。端口占用、防火墙、
  // 装软件、模型凭证这些需要人判断的，只给建议不动手。
  route(`${UI_API_PREFIX}/fix`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const action = typeof body?.action === 'string' ? body.action : ''

    // ── 只读：生成修复计划 ─────────────────────────────────────────
    if (action === 'plan') {
      try {
        const nodes = registry.list()
        const env = envChecks({
          role: resolveRole(config) || 'hub',
          config,
          reachability: reachOf(),
          nodesOnline: nodes.filter((n) => n.online).length,
        })
        const plan = planFixes({
          envCheck: env,
          patchFile: currentPatchFile(),
          listenHost: typeof config.listenHost === 'string' ? config.listenHost : '',
        })
        // 附上可撤销的备份列表（用户改坏了能回退）
        plan.backups = listBackups(path.dirname(plan.file), 5)
        return writeJson(res, 200, { ok: true, plan })
      } catch (err) {
        return writeJson(res, 200, { ok: false, error: shortMessage(err) })
      }
    }

    // ── 写盘：应用修复 ─────────────────────────────────────────────
    if (action === 'apply') {
      // ⚠ 二次确认是**硬要求**：这是唯一会改用户 DSH 配置的动作
      if (body?.confirm !== 'yes') {
        return writeJson(res, 400, {
          error: 'confirm-required',
          message: '一键修复会改 profile 的 cordis.patch.yml（DSH 自己的配置文件）。'
            + '请先在面板上确认"将要改什么"，然后带 confirm: "yes" 重试。',
        })
      }
      try {
        const nodes = registry.list()
        const env = envChecks({
          role: resolveRole(config) || 'hub',
          config,
          reachability: reachOf(),
          nodesOnline: nodes.filter((n) => n.online).length,
        })
        const plan = planFixes({
          envCheck: env,
          patchFile: currentPatchFile(),
          listenHost: typeof config.listenHost === 'string' ? config.listenHost : '',
        })
        const role = resolveRole(config) || 'hub'
        const result = applyFixPlan({
          plan,
          writePatchBlock,
          readFile: (f) => fs.readFileSync(f, 'utf8'),
          role,
        })
        if (result.ok === true) {
          log('info', 'auto-fix applied', {
            file: result.file,
            backup: result.backup,
            applied: result.applied,
          })
        } else {
          log('warn', 'auto-fix failed', { file: result.file, error: result.error })
        }
        return writeJson(res, 200, {
          ok: result.ok === true,
          file: result.file,
          backup: result.backup,
          applied: result.applied,
          error: result.error || null,
          // 改完必须重启才生效（配置在启动时读取）
          note: result.ok === true ? '已写入。**重启 DSH 后生效**。' : null,
        })
      } catch (err) {
        return writeJson(res, 200, { ok: false, error: shortMessage(err) })
      }
    }

    // ── 撤销：用备份覆盖回去 ───────────────────────────────────────
    if (action === 'undo') {
      if (body?.confirm !== 'yes') {
        return writeJson(res, 400, { error: 'confirm-required', message: '撤销会覆盖当前配置文件，请带 confirm: "yes" 重试。' })
      }
      const backup = typeof body?.backup === 'string' ? body.backup : ''
      const file = currentPatchFile()
      // 安全：备份必须在我们管理的命名空间里（防任意文件覆盖）
      if (!isManagedBackup(path.basename(backup))) {
        return writeJson(res, 400, { error: 'bad-backup', message: '备份文件名不符合预期（应为 cordis.patch.yml.bak-*）' })
      }
      // 且必须与目标文件同目录（防路径穿越到别处）
      if (path.dirname(path.resolve(backup)) !== path.dirname(path.resolve(file))) {
        return writeJson(res, 400, { error: 'bad-backup', message: '备份必须与配置文件在同一目录' })
      }
      const result = undoFix({ file, backup })
      if (result.ok === true) {
        log('info', 'auto-fix undone', { file, backup })
      }
      return writeJson(res, 200, { ok: result.ok === true, error: result.error || null })
    }

    return writeJson(res, 400, { error: 'bad-action', message: 'action 必须是 plan / apply / undo' })
  })

  // ── 外部工具检测（2026-10-20）──────────────────────────────────
  //
  // 用户要求"自动装依赖"，我们把范围收窄到**外部工具**，且**不代下载**：
  //   · 零 npm 依赖是核心卖点 —— 代装 npm 包会自毁卖点
  //   · 代下载第三方二进制会让我们变成软件分发方（版本/来源/校验/责任/
  //     供应链攻击面全落在我们头上）
  //
  // 所以这里只做三件事：探测在不在、说清缺了会怎样、给官方链接与安装命令。
  route(`${UI_API_PREFIX}/tools`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    try {
      const r = probeExternalTools()
      writeJson(res, 200, {
        ok: true,
        platform: r.platform,
        tools: r.tools.map((t) => ({
          id: typeof t.id === 'string' ? t.id : '',
          name: typeof t.name === 'string' ? t.name : '',
          installed: t.installed === true,
          version: typeof t.version === 'string' ? t.version : '',
          required: t.required === true,
          why: typeof t.why === 'string' ? t.why : '',
          install: typeof t.install === 'string' ? t.install : '',
          url: typeof t.url === 'string' ? t.url : '',
        })),
        missing: r.missing.map((t) => t.id),
        requiredMissing: r.requiredMissing.map((t) => t.id),
      })
    } catch (err) {
      log('warn', 'tool probe failed', { error: shortMessage(err) })
      writeJson(res, 200, { ok: false, error: shortMessage(err), tools: [], missing: [], requiredMissing: [] })
    }
  })

  // ── 工作区 SMB 共享（2026-10-17）──────────────────────────────
  //
  // 用户需求：想用本地 IDE 直接打开副机的项目目录 —— 唯一现实路径是把工作区
  // 通过 SMB 共享出去，主机 `net use X: \\副机\dsh-work` 映射成盘符。
  //
  // ⚠ **这是本插件唯一主动放宽安全边界的功能**。开启后：
  //     · roots / denyPaths 全部失效（Windows 内核直读，插件拦不住）
  //     · 「清单先于字节」失效（.env / .git 密钥 / 中间产物全部可见）
  //     · 新增凭证面（主机需要副机 Windows 账号）
  //
  // 所以：
  //   · `POST /share` 必须带 `confirm: 'yes'` —— 二次确认，缺了直接 400
  //   · `access` 默认 `read`（最小权限），写权限要显式传 `write`
  //   · **本路由不执行任何共享命令** —— 只返回可复制的命令。执行需要管理员，
  //     而 DSH 通常以普通用户跑；Node 里提权失败比让用户手动跑一条难排查得多
  //
  // 三个 action：
  //   GET  /share?node=X                 → probe（当前是否管理员 + 已存在的共享）
  //   POST /share { action:'plan', ... } → 生成共享命令 + 主机映射命令
  //   POST /share { action:'unshare', ... } → 生成卸载命令
  route(`${UI_API_PREFIX}/share`, async (req, res) => {
    // GET = 只读探测（不需要确认）
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const nodeId = (url.searchParams.get('node') ?? '').trim()
      if (nodeId === '') return writeJson(res, 400, { error: 'node-required' })
      try {
        const result = await registry.shareRequest(nodeId, 'probe', {})
        return writeJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return writeJson(res, 200, {
          ok: false,
          code: err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL,
          message: shortMessage(err),
        })
      }
    }
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })

    const body = await readJson(req)
    const action = typeof body?.action === 'string' ? body.action : ''
    const nodeId = typeof body?.node === 'string' ? body.node.trim() : ''
    if (nodeId === '') return writeJson(res, 400, { error: 'node-required' })

    // ⚠ 二次确认是**硬要求**：这是唯一会放宽安全边界的操作，
    // 客户端必须显式表达"我知道风险"。缺了就拒，不给默认通过。
    if (body?.confirm !== 'yes') {
      return writeJson(res, 400, {
        error: 'confirm-required',
        message: '开启工作区共享会让主机绕过本插件的 roots/denyPaths 边界直接读写这些文件。'
          + '请在请求里带 confirm: "yes" 表示已知情。',
      })
    }

    try {
      if (action === 'plan') {
        const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
        const access = body.access === 'write' ? 'write' : 'read'
        // 主机侧地址：面板把 window.location.hostname 传进来（就是主机自己的地址），
        // 但副机要连的是**主机**，而映射是主机连**副机** —— 所以这里要的是副机地址。
        // 由面板从节点信息里取（registry 有），不信任客户端传的值。
        const node = registry.list().find((n) => n.nodeId === nodeId)
        const hostForMount = typeof body.host === 'string' && body.host !== ''
          ? body.host
          : (node && typeof node.hostname === 'string' ? node.hostname : nodeId)
        const result = await registry.shareRequest(nodeId, 'plan', {
          dir,
          access,
          host: hostForMount,
          drive: typeof body.drive === 'string' ? body.drive : 'X:',
        })
        return writeJson(res, 200, { ok: true, ...result })
      }
      if (action === 'unshare') {
        const shareName = typeof body.shareName === 'string' ? body.shareName.trim() : ''
        if (shareName === '') return writeJson(res, 400, { error: 'shareName-required' })
        const result = await registry.shareRequest(nodeId, 'unshare-plan', { shareName })
        return writeJson(res, 200, { ok: true, ...result })
      }
      return writeJson(res, 400, { error: 'bad-action', message: 'action 必须是 plan / unshare' })
    } catch (err) {
      return writeJson(res, 200, {
        ok: false,
        code: err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL,
        message: shortMessage(err),
      })
    }
  })

  // ── 副机接入：生成配对码（面板 GUI 化的落点）──────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-10-20 修（C1）：端口**必须**取独立监听的实时状态
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 原实现：面板传 `window.location.port` 回来，注释写着"节点端点与面板同端口"。
  // 那个前提在 0.9.3 已被推翻 —— 节点端点搬到了独立监听（默认 19387），
  // 而 DSH webserver 的端口是**每次启动随机**的（实测见过 56594、58626）。
  //
  // 后果：面板生成的每一个配对码都指向"DSH 面板端口 + 节点路径"——
  // 那个端口既没有节点端点、又绑在 127.0.0.1 → 副机 100% 连不上。
  // 用户看到的是"配对码贴了没反应"，而两端都没有报错。
  //
  // 现在：端口从 `listenRuntime` 取（真实监听成功后的端口）。浏览器传来的
  // `port` 参数**不再采信**，只作为"独立监听没起来"时的兜底参考。
  //
  // ⚠ token 披露边界（与 /config 的"只回 set 布尔"同一精神）：
  // 含 token 的完整配对码**只对本机回环请求**生成 —— 面板可能被 lanBind
  // 暴露到局域网，局域网内的另一台机器能打开面板 ≠ 应该拿到主机凭证。
  route(`${UI_API_PREFIX}/pair-info`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const url = new URL(req.url, 'http://localhost')
    const ra = String(req.socket?.remoteAddress ?? '')
    const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
    const tokenSet = typeof config.nodeToken === 'string' && config.nodeToken !== ''
    const token = loopback && tokenSet ? config.nodeToken : ''

    // 真实端口：独立监听优先；没起来则退回浏览器端口（老部署），再兜底 19387
    const portRaw = url.searchParams.get('port') ?? ''
    const browserPort = /^\d+$/.test(portRaw) && +portRaw > 0 && +portRaw < 65536 ? +portRaw : null
    const listenOk = listenRuntime && listenRuntime.ok === true
    const port = listenOk && Number.isFinite(listenRuntime.port) && listenRuntime.port > 0
      ? listenRuntime.port
      : (browserPort ?? 19387)
    const portSource = listenOk && Number.isFinite(listenRuntime.port) ? 'listen-server' : 'fallback'

    // 独立监听在听时，**只有它绑的那个地址**是可用的（新架构只绑一个具体 IP）。
    // 其余候选地址照旧列出来（老配置可能走 webServer 通道），但明确标 usable，
    // 免得用户复制了一条连不上的码还以为是自己的问题（C2）。
    const boundHost = listenOk && typeof listenRuntime.host === 'string' ? listenRuntime.host : ''
    const candidates = detectLanIps()
    const codes = candidates
      .map((ip) => {
        const hubUrl = buildHubUrl(ip.address, port)
        const pairCode = encodePairCode({ hubUrl, token })
        const usable = boundHost === '' ? portSource === 'fallback' : ip.address === boundHost
        return {
          address: ip.address,
          name: ip.name,
          private: ip.private === true,
          hubUrl,
          pairCode,
          usable,
          includesToken: token !== '' && pairCode !== '',
        }
      })
      .filter((c) => c.pairCode !== '')
      // 可用的排最前（面板默认展示第一条，用户多半直接复制）
      .sort((a, b) => Number(b.usable) - Number(a.usable))

    // 独立监听没在听时，给出**可执行**的原因，而不是让用户对着空列表猜
    const listenerState = !listenRuntime
      ? 'unknown'
      : (listenRuntime.ok === true ? 'listening' : (listenRuntime.disabled !== '' ? 'disabled' : 'failed'))
    const listenerError = listenRuntime && typeof listenRuntime.error === 'string' ? listenRuntime.error : ''
    const listenerHint = listenerState === 'listening'
      ? ''
      : listenRuntime && listenRuntime.disabled !== ''
        ? `独立监听已关闭（${listenRuntime.disabled}）—— 副机只能走 DSH webserver 通道`
        : (listenerError !== ''
          ? `独立监听启动失败：${listenerError}（改 listenPort / listenHost 后重启）`
          : '独立监听尚未就绪（刚启动？稍后刷新）')

    writeJson(res, 200, {
      ok: true,
      port,
      portSource,
      tokenSet,
      scope: token !== '' ? 'full' : 'tokenless',
      codes,
      // 面板据此决定是否禁用"生成/复制"并显示原因
      listener: {
        state: listenerState,
        host: boundHost,
        port: listenOk ? listenRuntime.port : null,
        source: listenRuntime && typeof listenRuntime.source === 'string' ? listenRuntime.source : '',
        error: listenerError,
        hint: listenerHint,
      },
      firewallHint: `netsh advfirewall firewall add rule name="dsh-remote-agent" dir=in action=allow protocol=TCP localport=${port}`,
      note: token !== ''
        ? ''
        : (tokenSet
          ? '当前不是从主机本机打开的面板 —— 配对码不含 token；完整版请在主机本机打开面板生成，或用 dsh-remote-setup 向导'
          : '主机未设置 nodeToken —— 无口令的端点不会暴露到网络（安全策略），副机连不上。请先生成口令。'),
    })
  })

  // ── 诊断：面板自报（用于排查"面板 404 但路由存在"这类问题）──────
  //
  // 背景：桌面版（Electron）的页面来源是 `dsh-app://app/`，它对非静态资源的
  // 请求会经 `forwardWebRequest` 转发到本机 HTTP 服务。这条链路上任何一环出问题
  // （页面 origin 不同、转发改写、路径不符）都会表现为面板里的一个 HTTP 错误码，
  // 而**光看那个码无法区分是哪一环**。
  //
  // 所以给面板一个"把现场报回来"的端点：client 在首次加载时 POST 自己的
  // location.href / origin / 以及它实际请求的 URL。这条会进 DSH 日志。
  //
  // 安全：只接受同源请求（走同一个 guard），且**只记录不执行任何动作**；
  // 请求体上限 4KB，字段逐个白名单，绝不回显。
  route(`${UI_API_PREFIX}/diag`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    let body = {}
    try {
      body = (await readJson(req, 4096)) ?? {}
    } catch {
      /* 体不合法也继续记，现场信息在 header 里 */
    }
    const pick = (v) => (typeof v === 'string' ? v.slice(0, 300) : null)
    log('info', 'panel self-report', {
      pageHref: pick(body.href),
      pageOrigin: pick(body.origin),
      pageProtocol: pick(body.protocol),
      apiBase: pick(body.apiBase),
      probeUrl: pick(body.probeUrl),
      probeStatus: typeof body.probeStatus === 'number' ? body.probeStatus : null,
      probeError: pick(body.probeError),
      reqHost: pick(req.headers?.host),
      reqOrigin: pick(req.headers?.origin),
      reqSecFetchSite: pick(req.headers?.['sec-fetch-site']),
    })
    writeJson(res, 200, { ok: true })
  })

  // ── 任务模板库（配方）：list / save / delete ────────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════
  // 为什么这组路由值得单独一段说明
  // ═══════════════════════════════════════════════════════════════════════
  //
  // 它是本文件里**唯一把浏览器输入持久化到磁盘**的一组（pull 是往磁盘写文件，
  // 但写的是副机传回来的产物；这里是"把面板上填的东西存下来，之后原样回填"）。
  // 于是它同时踩到两个已有结论：
  //   · 结论 1（绕过 DSH 的 /api 围栏）→ 必须走同一个 guard()
  //   · 结论 3（响应体逐字段白名单）→ 回给浏览器的每条模板都要**逐字段构造**，
  //     绝不 spread 磁盘上的对象（文件可能被手工编辑过，里面什么都有）
  // 两条都不另起一套：`route()` 已经包了 guard + 异常收口，这里直接用。
  //
  // ── 为什么模板不是"注入通道"（本组的设计目标） ────────────────────────
  // 模板会被面板回填成 `/dispatch` 的请求体。若它能带任意字段，就等于绕过
  // `/dispatch` 与 `validateTaskStart` 那道收口。所以校验全部在 templates.js
  // 里做（白名单 + 长度 + 数量 + 枚举），本文件只负责把错误码翻成 HTTP 状态。
  //
  // ── 存储位置 ─────────────────────────────────────────────────────────
  // 默认落在 hub 的状态目录（与 hub-identity.json 同目录），可用
  // `uiTemplatesFile` 显式指定；再退一步用 `stateDir` 拼默认文件名。
  // 都不给时用 createTemplateStore 自己的默认（homedir 不可写退 tmp）。
  //
  // 为什么优先读**调用方显式传入**的那份 config（而不是只认参数）：
  // hub 的配置入口是 profile 的 cordis.patch.yml，用户能写的是 config.*；
  // 参数只是给测试与将来的装配层留的直通口。
  const pickPath = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '')
  const templatesFile =
    pickPath(uiTemplatesFile)
    || pickPath(config.uiTemplatesFile)
    || defaultTemplatesFile(pickPath(config.stateDir) || undefined)
  const templateStore = createTemplateStore({ file: templatesFile, log })

  /**
   * 单条模板的**出边界投影**。
   *
   * 与 views.js 的六个投影同一条硬规则：逐字段构造，永不 spread。
   * 磁盘上的记录是"可能被手工编辑过的文件"，而且未来模板结构会加字段 ——
   * 让浏览器自动看到新字段等于把"加字段"变成一次静默的契约变更。
   */
  const templateView = (t) => {
    if (!t || typeof t !== 'object') return null
    const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '')
    const out = {
      id: str(t.id, 64),
      name: str(t.name, 60),
      goal: str(t.goal, 2000),
      mode: t.mode === 'exec' ? 'exec' : 'agent',
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
      updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
    }
    // 可选字段：**缺就省略**，而不是给 null/空串 ——
    // 面板据此判断"这条模板有没有预设 workspace"，空串会渲染成一个假的预设值。
    if (typeof t.workspace === 'string' && t.workspace !== '') out.workspace = t.workspace.slice(0, 500)
    if (t.model && typeof t.model === 'object') {
      const m = {}
      if (typeof t.model.provider === 'string') m.provider = t.model.provider.slice(0, 64)
      if (typeof t.model.model === 'string') m.model = t.model.model.slice(0, 128)
      if (typeof t.model.reasoningEffort === 'string') m.reasoningEffort = t.model.reasoningEffort.slice(0, 32)
      if (Object.keys(m).length > 0) out.model = m
    }
    if (Array.isArray(t.outputs) && t.outputs.length > 0) {
      out.outputs = t.outputs.filter((o) => typeof o === 'string').slice(0, 32).map((o) => o.slice(0, 200))
    }
    if (Number.isFinite(t.timeoutMs)) out.timeoutMs = t.timeoutMs
    return out
  }

  // ── 列模板 ────────────────────────────────────────────────────
  //
  // 面板每次打开派发表单时拉它。**不缓存**：模板是用户刚点"保存"就能看到的东西，
  // 缓存只会让"我明明存了怎么没有"这种问题多一个来源。
  route(`${UI_API_PREFIX}/templates`, async (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const r = await templateStore.list()
    writeJson(res, 200, {
      ok: true,
      templates: r.templates.map(templateView).filter(Boolean),
      count: r.count,
      max: templateStore.max,
      // degraded=true 表示文件坏了/读不了，已降级为空库（不是"你一条都没存过"）。
      // 面板据此显示提示 —— 否则用户会以为模板被自己删光了。
      degraded: r.degraded === true,
      reason: typeof r.reason === 'string' ? r.reason : '',
      // 模板存哪：面板显示它，让"我的模板文件在哪"不必靠猜。
      // （只回路径本身，不含任何凭证 —— 模板里本就没有凭证字段。）
      file: templateStore.file,
    })
  })

  // ── 保存模板（新建或更新）─────────────────────────────────────
  //
  // body.id 命中已有模板 → 就地更新；不带 id → 新建。
  // 状态码映射刻意区分三类，面板据此给不同的提示：
  //   400 输入不合法（把 message 原文给用户看 —— 它是人话，且不含路径）
  //   404 id 指了一条不存在的模板（可能已被别的会话删了）
  //   409 数量到上限
  route(`${UI_API_PREFIX}/templates/save`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (!body) return writeJson(res, 400, { error: 'bad-body' })
    const r = await templateStore.save(body)
    if (!r.ok) return writeJson(res, r.status ?? 400, { error: r.error, message: r.message })
    log('info', 'ui template saved', { id: r.template.id, updated: r.updated, count: r.count })
    writeJson(res, 200, {
      ok: true,
      template: templateView(r.template),
      count: r.count,
      updated: r.updated === true,
      recovered: r.recovered === true,
    })
  })

  // ── 删除模板 ──────────────────────────────────────────────────
  //
  // 用 POST + body.id 而不是 `DELETE /templates/:id`：本文件的路由是
  // `kind:'exact'`（**不支持路径参数**，见文件头结论 1），要支持路径参数就得
  // 改成 prefix 路由，那会把 DSH 的 /api 围栏语义一起改掉 —— 代价远大于收益。
  route(`${UI_API_PREFIX}/templates/delete`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (!body) return writeJson(res, 400, { error: 'bad-body' })
    const r = await templateStore.remove(body.id)
    if (!r.ok) return writeJson(res, r.status ?? 400, { error: r.error, message: r.message })
    log('info', 'ui template deleted', { id: String(body.id).slice(0, 64), count: r.count })
    writeJson(res, 200, { ok: true, removed: r.removed, count: r.count })
  })

  // 注册结果汇总。**必须打** —— 路由注册失败是静默致命的（面板只看到 404/401，
  // 而宿主启动日志里什么都没有）。有了这一行，排查时一眼能看出"注册了几条、
  // 失败几条"。走 log 而不是写文件：不会留垃圾，且宿主日志里有痕迹。
  log('info', 'ui routes registered', {
    registered: registeredCount,
    failed: failedCount,
    prefix: UI_API_PREFIX,
  })

  return disposers
}