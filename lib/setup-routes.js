/**
 * 引导路由：**未配置时**注册的最小 UI 路由集。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要一组独立的路由（而不是复用 hub 的那些）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 首次安装时插件**无法知道**这台机器是主机还是副机 —— 只有用户知道。
 * 所以 `role` 的默认值是空（未配置），此时：
 *
 *   · `applyHub` **不跑** → hub 的 10 条 UI 路由都不存在
 *   · `applyWorkerBranch` **不跑** → 也不启动拨入
 *
 * 如果这时什么都不注册，用户打开面板只会看到两个端点都失败的报错 ——
 * **拿不到任何引导**。所以未配置时必须注册这一小组：
 *
 *   GET  /api/remote-agent/setup/state   当前配置状态（让面板知道该显示引导）
 *   POST /api/remote-agent/setup/apply   写入角色选择（安全写盘，含备份回滚）
 *   GET  /api/remote-agent/setup/pair    生成配对码（选 hub 后给副机用）
 *
 * ── 与 hub 那组路由的关系 ────────────────────────────────────────────────
 * 这组**不依赖** NodeRegistry / PullManager（未配置时它们不存在），所以参数
 * 只有 `ctx` 与 `config`。它也不注册工具 —— 未配置时不该有任何工具可用。
 *
 * ── 安全 ────────────────────────────────────────────────────────────────
 * 与其他 UI 路由一样自带同源围栏（`kind:'exact'` 会绕过 DSH 的 `/api` prefix
 * 围栏，所以必须自己补）。写盘走 `lib/setup.js` 的 `writePatchBlock()` ——
 * 它有冲突检测、备份、托管块、写后校验、失败回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ERROR_CODE, RemoteAgentError } from './protocol.js'
import {
  FORM_OWNED_KEYS,
  extractPreservedConfig,
  newNodeToken,
  readManagedBlockBody,
  upsertTokenInBlock,
  writePatchBlock,
} from './setup.js'
// 角色解析必须**只有一份实现** —— 面板说"未配置"而插件实际在跑 hub，
// 是最难排查的撕裂（v0.7.0 踩过）。所以这里直接复用 lib/index.js 的解析器。
import { resolveRoleDetail } from './index.js'
// 配置分层（2026-10-18）：DSH 插件管理器会重写 cordis.patch.yml 并冲掉手工段，
// 所以每次写配置时也在 <stateDir>/instance.json 存一份（插件加载时合并回来）。
import { writeInstanceConfig, readInstanceConfig } from './instance-config.js'

/**
 * 面板表单**管辖**的顶层 config 键由 `lib/setup.js` 的 `FORM_OWNED_KEYS` 定义
 * （CLI 向导与测试共用同一份，避免两处各写一份再分叉 —— 本版审查的 C2/L2
 * 就是这么来的）。所以这里直接用那份常量，不再本地复制。
 *
 * 其余的一切（nodeToken / uiPullRoot / relay / listenHost / listenPort /
 * agentMode…）在重写托管块时必须**原样保留** —— 否则用户在面板点一次保存，
 * 凭证与设置就被静默抹掉（已实证）。
 */

/** 引导路由的前缀。与 hub 的 `/api/remote-agent/ui` 分开 —— 未配置时后者不存在。 */
export const SETUP_API_PREFIX = '/api/remote-agent/setup'

const MAX_BODY = 16 * 1024

/** 同源围栏（与 ui-routes.js 的 makeGuard 同策略，但更简单：这里没有 connection 可用时也要 fail-closed）。 */
function makeGuard(ctx, log) {
  return function guard(req, res, pathname) {
    let rejection
    try {
      // 与 webServer 同理：**属性访问优先**，`ctx.get(name, false)` 非严格兜底。
      // `ctx.get` 的默认 strict=true 只返回"提供者 fiber 当前活跃"的服务，
      // 在 apply() 早期可能拿不到。
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
      log('warn', 'setup guard: connection fence threw, failing closed', { path: pathname, error: String(err?.message ?? err) })
      rejection = 403
    }
    if (rejection === undefined) {
      // connection 不可用（或没拒绝）时的兜底：只挡浏览器明确标注的跨站。
      const h = req.headers ?? {}
      if (h['sec-fetch-site'] === 'cross-site') rejection = 403
      else if (h.origin !== undefined) {
        try {
          if (new URL(h.origin).host !== h.host) rejection = 403
        } catch {
          rejection = 403
        }
      }
    }
    if (rejection === undefined) return true
    res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    return false
  }
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

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 默认 profile 的 `cordis.patch.yml` 路径。
 *
 * 与 `lib/setup.js` 的 `defaultPatchFile()` 同源 —— 但这里**不 import 它**，
 * 因为那条路径要处理 profile 名归一化，而这里只关心"当前生效的 profile"。
 *
 * 优先级（从高到低）：
 *   1. `DSH_HOME/profiles/<DSH_PROFILE>/cordis.patch.yml`
 *      DSH Desktop 把 DSH_HOME 指向 harness 目录（如
 *      ~/Library/Application Support/dsh-desktop/harness），
 *      profile 文件在其 profiles/<name>/ 子目录下。
 *   2. `~/.dsh/profiles/<DSH_PROFILE>/cordis.patch.yml`
 *      命令行版 dsh 的默认路径（兜底）。
 */
function currentPatchFile() {
  const raw = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '')
  const profileName = safe === '' ? 'desktop' : safe
  const home = os.homedir()

  // 1. DSH_HOME env var（DSH Desktop 注入，最精确）
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    const p = path.join(process.env.DSH_HOME.trim(), 'profiles', profileName, 'cordis.patch.yml')
    if (fs.existsSync(p)) return p
  }

  // 2. 自动探测：枚举常见 DSH Desktop 安装路径（跨平台）
  // macOS: ~/Library/Application Support/dsh-desktop/harness
  // Windows: %APPDATA%\dsh-desktop\harness, %LOCALAPPDATA%\dsh-desktop\harness
  // Linux: ~/.config/dsh-desktop/harness, ~/.local/share/dsh-desktop/harness
  const candidateBases = []
  const platform = os.platform()
  if (platform === 'darwin') {
    candidateBases.push(path.join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness'))
  } else if (platform === 'win32') {
    if (process.env.APPDATA) candidateBases.push(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'))
    if (process.env.LOCALAPPDATA) candidateBases.push(path.join(process.env.LOCALAPPDATA, 'dsh-desktop', 'harness'))
    // Windows non-system drive: DSH_HOME may be user-set; also try C:\dsh-desktop
    candidateBases.push(path.join('C:\\', 'dsh-desktop', 'harness'))
  } else {
    // Linux
    candidateBases.push(path.join(home, '.config', 'dsh-desktop', 'harness'))
    candidateBases.push(path.join(home, '.local', 'share', 'dsh-desktop', 'harness'))
  }
  // Try each base with both the detected profileName and common fallback names
  const profileFallbacks = [profileName, 'web', 'desktop']
  for (const base of candidateBases) {
    for (const pn of profileFallbacks) {
      const p = path.join(base, 'profiles', pn, 'cordis.patch.yml')
      if (fs.existsSync(p)) return p
    }
  }

  // 3. 命令行版 dsh 兜底路径
  return path.join(home, '.dsh', 'profiles', profileName, 'cordis.patch.yml')
}

/**
 * 注册引导路由。
 *
 * @param {object} ctx cordis 上下文（需要 webServer；没有就静默跳过）
 * @param {object} config 本行的生效配置（只读快照）
 * @param {(level:string,msg:string,extra?:object)=>void} log
 * @returns {Array<() => void>} disposers
 */
export function registerSetupRoutes(ctx, config = {}, log = () => {}) {
  const disposers = []
  // ⚠ **必须优先用属性访问 `ctx.webServer`，不能只用 `ctx.get('webServer')`。**
  //
  // cordis 的 `ctx.get(name, strict = true)` 默认只返回"提供者 fiber **当前
  // 活跃**"的服务（源码注释原文："strict — when true, only return
  // implementations whose providing fiber is currently active"）。
  //
  // 而本函数在 `apply()` 的**早期**被调用（先于 hub/worker 分支），那时
  // webServer 的提供者 fiber 可能还没激活 → `ctx.get` 返回 undefined →
  // 整组引导路由静默跳过 → `/api/remote-agent/setup/state` 落到 DSH 的
  // `/api` prefix 围栏 → 返回**纯文本** `unauthorized`（与"路径不存在"
  // 完全一样的响应，实测极难排查）。
  //
  // 属性访问走的是另一条路（`internal/get` waterfall + fiber store 查找），
  // 能拿到已就绪的服务 —— `applyHub` 一直用的就是 `ctx.webServer`，那是
  // 被验证可用的形态。
  //
  // 保留 `ctx.get(name, false)`（**非严格**）作为兜底：万一属性访问在某个
  // 组合下不可用（例如 loader 行没声明 inject），非严格查找仍能拿到值。
  let webServer
  try {
    webServer = ctx.webServer
  } catch {
    /* 没声明 inject 时属性访问会抛 —— 走下面的兜底 */
  }
  if (!webServer) {
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer', false) : undefined
    } catch {
      webServer = undefined
    }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 webServer 的组合（纯 headless）：没有面板，也就不需要引导路由。
    log('info', 'setup routes skipped: no webServer in this composition')
    return disposers
  }
  const guard = makeGuard(ctx, log)

  const route = (pathname, handler) => {
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          try {
            const h = req.headers ?? {}
            log('info', 'setup route in', {
              path: pathname,
              method: req.method,
              hasCookie: typeof h.cookie === 'string' && h.cookie !== '',
              origin: typeof h.origin === 'string' ? h.origin : null,
            })
            if (!guard(req, res, pathname)) return
            await handler(req, res)
          } catch (err) {
            const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
            log('warn', 'setup route failed', { path: pathname, code, error: String(err?.message ?? err) })
            try {
              writeJson(res, 500, { error: code, message: String(err?.message ?? err).slice(0, 300) })
            } catch {
              /* 响应可能已发出 */
            }
          }
        },
      }))
      log('info', 'setup route registered', { path: pathname })
    } catch (err) {
      log('error', 'setup route registration failed', { path: pathname, error: String(err?.message ?? err) })
    }
  }

  // ── 状态：面板据此决定显示引导还是"切换角色" ─────────────────────────
  //
  // 这组路由**始终注册**（不只未配置时）—— 所以这里必须如实报告当前是否
  // 已配置，面板才能区分：
  //   configured: false → 显示**首次引导**（两个大按钮）
  //   configured: true  → 显示**切换角色**（在设置区，带当前值）
  route(`${SETUP_API_PREFIX}/state`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const role = typeof config.role === 'string' ? config.role.trim().toLowerCase() : ''
    // 复用 lib/index.js 的解析器 —— 它已经处理了 auto 推断、大小写、非法值。
    // 两处判据必须一致，否则会出现"面板说未配置、实际已在跑 hub"这种撕裂。
    const detail = resolveRoleDetail(config)
    // `configured` 的语义是"用户已经做过选择，不需要引导"。
    // auto 也算已选择：它是个明确的工作模式（按 hubUrl 推断），不是"还没配"。
    const configured = role === 'auto' || detail.unconfigured !== true

    // ── 独立配置状态（2026-10-18）──────────────────────────────────────
    //
    // 报告 `<stateDir>/instance.json` 里存了什么。这不是给用户看的细节，
    // 而是排查"配置被 DSH 重写冲掉"这个坑的关键线索：
    //   · instance 有值 = 配置抗住了重写（重启后 apply() 会合并回来）
    //   · instance 为 null 但 patch 有值 = 只靠 patch 那层，下次重写会丢
    const saved = readInstanceConfig(config)
    writeJson(res, 200, {
      ok: true,
      configured,
      // 推断结果（面板据此显示"当前生效角色"）—— auto 时它是有值的
      effectiveRole: detail.role,
      inferred: typeof detail.inferred === 'string' ? detail.inferred : '',
      // 配置持久化的两层状态
      persist: {
        // DSH 会重写 cordis.patch.yml（实测会把我们的段整段冲掉）
        patchFile: currentPatchFile(),
        // 这一层 DSH 冲不掉，是"重启后配置还在"的真正保障
        instanceFile: saved !== null,
        instanceRole: saved && typeof saved.role === 'string' ? saved.role : null,
      },
      // 回显当前配置里已有的值，方便用户"改一个字段"而不是从头填
      current: {
        role: typeof config.role === 'string' ? role : '',
        nodeId: typeof config.nodeId === 'string' ? config.nodeId : '',
        transportMode: typeof config.transportMode === 'string' ? config.transportMode : 'relay',
        hubUrl: typeof config.hubUrl === 'string' ? config.hubUrl : '',
        relayUrl: typeof config.relayUrl === 'string' ? config.relayUrl : '',
        roots: Array.isArray(config.roots) ? config.roots : [],
        // H3（2026-10-20）：面板必须知道"有没有口令"。此前完全不回显 → 用户
        // 走面板配完 hub 永远是空口令，而独立监听因此只能绑回环、副机连不上。
        // ⚠ 只回布尔，绝不回 token 本身（与 /config 的披露边界一致）。
        tokenSet: typeof config.nodeToken === 'string' && config.nodeToken.trim() !== '',
      },
      // 写入目标（让用户知道改的是哪个文件）
      patchFile: currentPatchFile(),
      // 提示：写盘后必须重启
      note: '写入后需要重启 DSH 生效',
    })
  })

  // ── 写入角色选择 ────────────────────────────────────────────────────
  route(`${SETUP_API_PREFIX}/apply`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (body === undefined) return writeJson(res, 400, { error: 'bad-body' })

    const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : ''
    if (role !== 'hub' && role !== 'worker' && role !== 'both') {
      return writeJson(res, 400, { error: 'bad-role', message: 'role 必须是 hub / worker / both' })
    }

    // 组装要写入的 YAML 块。**逐字段构造**，绝不把 body 直接序列化进去 ——
    // 那是把用户输入变成配置注入（YAML 里一个换行就能插入任意 loader 行）。
    const lines = [
      '- id: remote-agent',
      '  name: dsh-remote-agent',
    ]
    // 非致命提示（如"已自动创建目录 X"）—— 随响应回给面板展示，
    // 不打断写入流程。写入成功但目录没建出来，用户需要知道。
    let applyWarnings = []
    // inject 必须跟着 role 走：
    //   hub  → 需要 webServer/tools/systemPrompt（注册路由与工具）
    //   worker → 需要 tools/agentLoop/sessions（agent 的 ctx 继承依赖声明，
    //            少了 tools 就挂不上 shell/文件工具 —— 实测踩过）
    if (role === 'worker') {
      lines.push("  inject: ['tools', 'agentLoop', 'sessions']")
    } else {
      lines.push("  inject: ['webServer', 'tools', 'systemPrompt']")
    }
    lines.push('  config:')
    lines.push(`    role: ${role}`)

    const str = (v) => (typeof v === 'string' ? v.trim() : '')
    const nodeId = str(body.nodeId)
    if (nodeId !== '') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId)) {
        return writeJson(res, 400, { error: 'bad-node-id', message: '节点 ID 只能含字母数字 . _ -，以字母或数字开头' })
      }
      lines.push(`    nodeId: ${nodeId}`)
    }
    if (role === 'worker') {
      const mode = str(body.transportMode) === 'direct' ? 'direct' : 'relay'
      lines.push(`    transportMode: ${mode}`)
      if (mode === 'direct') {
        const hubUrl = str(body.hubUrl)
        if (hubUrl === '') {
          return writeJson(res, 400, { error: 'hub-url-required', message: 'direct 模式必须填主机地址' })
        }
        // 引号包裹：URL 里可能有冒号/斜杠，YAML 裸标量在某些形态下会解析异常
        lines.push(`    hubUrl: '${hubUrl.replace(/'/g, "''")}'`)
      } else {
        const relayUrl = str(body.relayUrl)
        if (relayUrl !== '') lines.push(`    relayUrl: '${relayUrl.replace(/'/g, "''")}'`)
      }
    }
    const roots = Array.isArray(body.roots) ? body.roots.map(str).filter((s) => s !== '') : []
    if (roots.length > 0) {
      // ── 自动创建 roots 目录（2026-10-17，开箱即用）────────────────────
      //
      // 此前 roots 必须**已经存在**：用户填了 D:\work 但没建这个目录 →
      // 任务全部报 workspace-denied，而错误信息在任务详情里，用户根本
      // 不会往"目录不存在"这个方向想。
      //
      // 现在写入配置时顺手把不存在的目录建出来。这是安全的：
      //   · 只 mkdir -p，不删不改任何已有内容
      //   · 路径必须**绝对**（相对路径一律跳过，让 resolveRoots 去拒）
      //   · 创建失败不阻塞写配置（只记进 warnings，面板能显示）
      const warnings = []
      for (const r of roots) {
        try {
          if (!path.isAbsolute(r)) {
            warnings.push(`${r} 不是绝对路径，已跳过创建（roots 必须是绝对路径）`)
            continue
          }
          if (!fs.existsSync(r)) {
            fs.mkdirSync(r, { recursive: true })
            warnings.push(`已自动创建目录：${r}`)
          }
        } catch (err) {
          warnings.push(`无法创建 ${r}：${String(err?.message ?? err)}`)
        }
      }
      lines.push('    roots:')
      for (const r of roots) lines.push(`      - '${r.replace(/'/g, "''")}'`)
      if (warnings.length > 0) {
        // 记到响应里（面板可展示），不打断写入流程
        applyWarnings = warnings
      }
    }

    const blockYaml = `${lines.join('\n')}\n`
    const file = currentPatchFile()

    // ── 保留本次表单不管辖的字段（H2，2026-10-20）────────────────────
    //
    // 托管块是**整体替换**的：新块进来，旧块整段消失。而本表单只提交
    // role/nodeId/transportMode/hubUrl/relayUrl/roots —— 于是用户在面板点一次
    // 「保存」，托管块里的 nodeToken / uiPullRoot / relay / listenHost /
    // listenPort 全部被静默删掉（已实证）。
    //
    // 这里把旧块里"不归表单管"的行原样搬到新块末尾（文本级搬运，保留用户的
    // 格式与顺序；不解析 YAML，避免零依赖被打破）。
    let preservedLines = []
    try {
      const existing = readManagedBlockBody(fs.readFileSync(file, 'utf8'))
      preservedLines = extractPreservedConfig(existing, FORM_OWNED_KEYS)
    } catch {
      // 首次写入（文件不存在）—— 没有可保留的
    }
    const blockWithPreserved = preservedLines.length > 0
      ? `${blockYaml.replace(/\s+$/, '')}\n${preservedLines.join('\n')}\n`
      : blockYaml

    const result = writePatchBlock({ file, blockYaml: blockWithPreserved, force: body.force === true })
    if (result.ok !== true) {
      // 冲突（有手写条目）是可预期的用户可修复状态，单独给个 code 让面板
      // 能显示"替换手写配置"按钮，而不是把整段错误文案丢给用户。
      const conflict = /手写的 remote-agent 条目/.test(String(result.error ?? ''))
      return writeJson(res, conflict ? 409 : 400, {
        error: conflict ? 'handwritten-conflict' : 'write-failed',
        message: result.error,
        file: result.file,
      })
    }
    log('info', 'setup applied', { role, file: result.file, mode: result.mode, warnings: applyWarnings })

    // ── 同时写独立配置（2026-10-18，方案 B：防被 DSH 重写冲掉）──────────
    //
    // 事故：用户在 DSH 里卸载重装插件后，`cordis.patch.yml` 被重写成只剩
    // 4 条 —— 我们的 role + webserver 整段消失，重启后又回引导页。
    //
    // 所以每次 setup 写入成功后，把**同样的值**再存一份到
    // `<stateDir>/instance.json`。插件 `apply()` 时会把它合并回来
    // （独立配置优先）。这样 DSH 怎么重写 patch 文件都不影响角色配置。
    //
    // ⚠ 2026-10-20 修两处：
    //   · **必须传 config**（第二个参数）。此前漏了 → 写默认目录、读自定义
    //     stateDir → 配了 stateDir 的机器持久化完全失效（M1，已复现）。
    //   · 先铺上已有值再覆盖表单字段，否则每次保存都会把 nodeToken / relay /
    //     listenHost 这类"表单不管辖"的字段从 instance.json 里抹掉（H2 的另一半）。
    const prev = readInstanceConfig(config) ?? {}
    const nextPersist = { ...prev }
    // 表单管辖的键以本次提交为准（这样"清空"也能真正生效）
    for (const k of FORM_OWNED_KEYS) delete nextPersist[k]
    const persisted = writeInstanceConfig({
      ...nextPersist,
      role,
      nodeId: str(body.nodeId),
      transportMode: str(body.transportMode) || undefined,
      hubUrl: str(body.hubUrl) || undefined,
      relayUrl: str(body.relayUrl) || undefined,
      roots,
    }, config)
    if (persisted.ok !== true) {
      applyWarnings.push(`独立配置写入失败（${persisted.error}）—— 角色配置仍写进了 patch 文件，`
        + '但下次 DSH 重写该文件时可能丢失，建议重启后到面板确认一次。')
      log('warn', 'instance config write failed', { file: persisted.file, error: persisted.error })
    } else {
      log('info', 'instance config persisted', { file: persisted.file })
    }

    writeJson(res, 200, {
      ok: true,
      role,
      file: result.file,
      backup: result.backup,
      mode: result.mode,
      // 独立配置的落点（让用户/排查者知道配置存在哪两处）
      instanceFile: persisted.ok === true ? persisted.file : null,
      // 非致命提示（自动建目录的结果等）—— 面板要显示，否则用户以为
      // "目录已就绪"而实际没有
      warnings: applyWarnings,
      note: '已写入配置。**重启 DSH 后生效**。',
    })
  })

  // ── 生成 / 轮换入网口令（nodeToken）──────────────────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 为什么必须有这条（v0.9.3 审查 H3，2026-10-20）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CLI 向导（`dsh-remote-setup --role hub`）会生成 `nt_` 开头的口令，
  // **面板这条路却完全没有** —— YAML 里不写 nodeToken、instance.json 里也不写。
  //
  // 后果链（实测）：
  //   面板配 hub → nodeToken 空 → 独立监听按安全策略只能绑回环
  //   → 副机连不上 → 体检报"需要口令" → 而面板没有任何生成入口
  //   → 用户只能去手改 patch → 被 DSH 重写冲掉 → 死循环
  //
  // 安全边界：
  //   · 只对**回环请求**生成并回显明文（与 pair-info 的 token 披露边界一致）
  //   · 明文只回这一次，之后任何接口都不再吐 token（`/state` 只给 tokenSet）
  //   · 走的是同一套 patch 写盘（备份 / 校验 / 回滚）
  route(`${SETUP_API_PREFIX}/rotate-token`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })

    const ra = String(req.socket?.remoteAddress ?? '')
    const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
    if (!loopback) {
      return writeJson(res, 403, {
        error: 'loopback-only',
        message: '生成口令只能在主机本机打开的面板里操作（避免局域网内其他人拿到凭证）',
      })
    }

    const token = newNodeToken()
    const file = currentPatchFile()

    // 只改 nodeToken 这一行，其余字段（roots / uiPullRoot / relay / listen*）原样不动
    let blockBody = ''
    try {
      blockBody = readManagedBlockBody(fs.readFileSync(file, 'utf8'))
    } catch {
      // 还没有 patch 文件：生成一个最小的托管块，role 取当前生效角色
    }
    if (blockBody.trim() === '') {
      const detail = resolveRoleDetail(config)
      const r = detail.role === 'worker' ? 'worker' : 'hub'
      const inject = r === 'worker'
        ? "['tools', 'agentLoop', 'sessions']"
        : "['webServer', 'tools', 'systemPrompt']"
      blockBody = `- id: remote-agent\n  name: dsh-remote-agent\n  inject: ${inject}\n  config:\n    role: ${r}\n`
    }

    const result = writePatchBlock({
      file,
      blockYaml: upsertTokenInBlock(blockBody, token),
      force: false,
    })
    if (result.ok !== true) {
      const conflict = /手写的 remote-agent 条目/.test(String(result.error ?? ''))
      return writeJson(res, conflict ? 409 : 400, {
        error: conflict ? 'handwritten-conflict' : 'write-failed',
        message: result.error,
        file: result.file,
      })
    }

    // instance.json 也存一份（这一层 DSH 冲不掉）—— 同样保留已有字段
    const prev = readInstanceConfig(config) ?? {}
    const persisted = writeInstanceConfig({ ...prev, nodeToken: token }, config)

    log('info', 'node token rotated', {
      file: result.file,
      instance: persisted.ok === true ? persisted.file : null,
      instanceError: persisted.ok === true ? undefined : persisted.error,
    })

    writeJson(res, 200, {
      ok: true,
      // 明文只此一次：面板要提示用户"复制保存"，之后不再回显
      token,
      file: result.file,
      backup: result.backup,
      instanceFile: persisted.ok === true ? persisted.file : null,
      note: '口令已写入。**重启 DSH 后生效**；副机需要用新口令重新配对。'
        + '这串口令只显示这一次，请立即复制保存。',
    })
  })

  return disposers
}
