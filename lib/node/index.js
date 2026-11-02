/**
 * 副机侧 worker 插件入口：拨入 hub + 任务引擎接线 + 优雅降级。
 *
 * 职责边界：
 *   本文件只做「装配与接线」——把冻结的 protocol / transport / store / artifacts /
 *   runner / engine 拼成一个可运行的副机 worker，并把 hub 帧翻译成引擎调用。
 *   它不实现任何协议语义、不碰任务状态机、不做产物判定。
 *
 * 四条硬不变式（在实现里逐条落地）：
 *   1. **启动绝不被 hub 拖住**：applyWorker 全程同步，没有一处顶层 await 网络。
 *      连不上只记日志，退避重连交给 NodeTransport 自己跑（其定时器全部 unref，
 *      不会吊住副机 dsh 的事件循环）。连 stateDir 不可写也只降级，不抛。
 *   2. **断连不终止任务**：任务执行路径（engine/runner/exec）一个字节都不读连接状态；
 *      这里唯一的连接副作用是 `send()`，而它被包成永不抛、失败即丢帧。
 *   3. **零外部依赖**：只用 node: 内置模块与包内相对 import，不 import 任何 @deepseek-ai/*。
 *   4. **单帧故障隔离**：'frame' 监听器整体 try/catch，任何一帧解析/处理失败只影响那一帧；
 *      并且给 engine.execute 包了一层，杜绝 pump() 的 `void execute()` 变成
 *      unhandledRejection（那会直接把副机 dsh 带走）。
 *
 * 与 hub 侧的分工：任务状态的真身在副机（TaskStore），hub 只是视图。
 * 所以重连后由本文件触发 `engine.syncAll()` 主动上报，而不是等 hub 来问。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  PROTOCOL_VERSION,
  TASK_STATUS,
  TERMINAL_STATUS,
  newPullId,
  validateTaskStart,
} from '../protocol.js'
import { ArtifactService } from './artifact-service.js'
import { defaultRoots, resolveWorkspace } from './exec.js'
// P2-11：hub 身份验证 —— 指纹归一化 + TOFU 钉住落盘（<stateDir>/hub-pin.json）。
import { normalizeFingerprint } from '../identity.js'
import { clearHubPin, loadHubPin, saveHubPin } from './hub-pin.js'
// expandPairConfig：配置里的 pair: 'dshra1://…' 展开成 hubUrl/token/nodeId
// （显式配置优先，解析失败只降级不炸 —— 见 lib/pairing.js）。
import { expandPairConfig } from '../pairing.js'
import { selectRunner } from './runner.js'
// 资源遥测：CPU（增量）/内存/负载采样，经 node/resource 帧上报 hub。
import { RESOURCE_INTERVAL_MS, createResourceSampler } from './resource.js'
// 统一错误翻译层（2026-10-20，体验提升 ④）：覆盖协议错误码（17 个）+ HTTP
// 状态 + errno，每条都给"下一步做什么"。面板与日志共用同一份口径。
//
// 注：原先这里还 import 了 setup.js 的 friendlyConnectError，2026-10-20 起
// 运行时错误统一走 explain-error.js（覆盖面更广），那个 import 已无用。
import { explainError, formatExplained } from '../explain-error.js'
import { scanRepos } from './repos.js'
import { TaskEngine } from './task-engine.js'
import { TaskStore } from './task-store.js'
// 远程文件工具集（提案 #25）：ls/read/grep/tree 只读实现，与任务链路共用
// roots / denyPaths / caseInsensitive 三个配置（同一个安全边界，两处入口）。
import { createFsService } from './fs-service.js'
// 进程与端口诊断（2026-10-20）：ps/port 只读，kill 不可逆（自带三道护栏）。
import { createProcessService } from './process-service.js'
import { createFileTransferService } from './file-transfer-service.js'
import { createDesktopService } from './desktop-service.js'
import { createSelfCheckService } from './selfcheck-service.js'
// 工作区 SMB 共享（2026-10-17）：只探测 + 生成命令，不执行（需管理员）。
import {
  SHARE_ACCESS,
  buildMountCommand,
  buildShareCommand,
  buildUnshareCommand,
  isAdmin,
  probeShareState,
} from './share-service.js'
import { NodeTransport, TRANSPORT_MODE } from './transport.js'

const PLUGIN_NAME = 'dsh-remote-agent'
const PLUGIN_TAG = '[dsh-remote-agent:worker]'
const STATUS_PATH = '/api/remote-agent/status'
const WORKER_EFFECT_LABEL = `${PLUGIN_NAME}:worker`

/** 产物分块背压：写缓冲高水位与 drain 超时（与 ArtifactService 的取值保持一致）。 */
const HIGH_WATER_BYTES = 2 * 1024 * 1024
const DRAIN_TIMEOUT_MS = 30_000

/** 节点 id 的形状，与 protocol.validateHello 完全一致 —— 本地先生成合法的，别让 hub 拒。 */
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 节点 id 长度上限（与 NODE_ID_RE 的 {0,63} 一致）。 */
const NODE_ID_MAX = 64
/** 丢信息时掺进 id 的原文指纹长度（sha256 前 8 位十六进制）。 */
const NODE_ID_HASH_LEN = 8

/** 本机能力声明：副机插件 v0.1 四种能力全开。 */
const CAPS = Object.freeze(['fs', 'exec', 'artifact', 'agent'])

/** 注入副机 agent 的说明段（只在 systemPrompt 服务存在时注册）。 */
const WORKER_PROMPT = [
  '## 远程 Agent（副机 worker）',
  '',
  '这台机器同时作为 dsh-remote-agent 的副机在运行：主电脑可以把任务派发到这里，',
  '任务以独立 agent 会话在本地持久执行，完成后回传 handoff 摘要与产物清单，',
  '只有 role:final 的成品会被主电脑拉取。本机状态见 GET ' + STATUS_PATH + '。',
].join('\n')

/* ────────────────────────────── 小工具 ────────────────────────────── */

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function msgOf(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err.message === 'string') return err.message
  return String(err)
}

/** 调用一个可能抛的回调，吞掉异常。清理路径上每步都必须能独立失败。 */
function safeInvoke(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** 吞掉 promise 的 rejection，避免任何后台任务变成 unhandledRejection。 */
function swallow(p) {
  if (p && typeof p.then === 'function') {
    try {
      p.then(undefined, () => {})
    } catch {
      /* then 本身失败也无所谓 */
    }
  }
  return p
}

/** Build one desktopRead response without guessing EOF from the requested length. */
export function readDesktopChunk(desktop, input = {}) {
  const offset = input.offset ?? 0
  const length = input.length ?? 256 * 1024
  const metadata = desktop.stat(input.id)
  const data = desktop.readChunk(input.id, offset, length)
  return {
    id: input.id,
    offset,
    length: data.length,
    base64: data.toString('base64'),
    eof: offset + data.length >= metadata.bytes,
  }
}

/** Release all short-lived worker resources; each cleanup branch fails independently. */
export function disposeWorkerResources({ desktop, fileTransfer } = {}) {
  safeInvoke(() => desktop?.dispose?.())
  safeInvoke(() => {
    if (typeof fileTransfer?.dispose === 'function') fileTransfer.dispose()
    else fileTransfer?.abortAll?.()
  })
}

/** 统一的日志出口：优先 ctx.logger，其次 ctx.get('logger')，最后 console。 */
function createLogger(ctx) {
  const emit = (level, msg, extra) => {
    const text = `${PLUGIN_TAG} ${msg}`
    try {
      const own = ctx?.logger
      if (own && typeof own[level] === 'function') {
        own[level](text, extra)
        return
      }
      const service = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
      if (service && typeof service[level] === 'function') {
        service[level](text, extra)
        return
      }
    } catch {
      /* 日志本身失败绝不能影响主流程 */
    }
    try {
      if (level === 'error') console.error(text, extra ?? '')
      else if (level === 'warn') console.warn(text, extra ?? '')
      else if (level === 'debug') {
        if (process.env.DSH_REMOTE_DEBUG) console.log(text, extra ?? '')
      } else console.log(text, extra ?? '')
    } catch {
      /* 没有 console 也不该炸 */
    }
  }
  return {
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    debug: (m, e) => emit('debug', m, e),
  }
}

/**
 * 取一个可选服务。**不能**写进 inject 硬依赖 —— 副机可能没有 webServer，
 * 硬依赖会让插件在那种组合下根本加载不了。
 */
function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/* ────────────────────────────── 身份组装 ────────────────────────────── */

function safeHostname() {
  try {
    const h = os.hostname()
    return typeof h === 'string' && h.trim() !== '' ? h.trim() : 'node'
  } catch {
    return 'node'
  }
}

/**
 * 把任意主机名/用户输入收敛成协议合法的 nodeId。
 *
 * 规则（对应 validateHello 的 /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/）：
 *   - 小写化
 *   - 非法字符（含中文、空格、冒号…）一律替换成 '-'
 *   - 首字符必须是字母数字：前导非字母数字全部剥掉
 *   - 长度封顶 64
 *   - 剥完为空（例如纯中文主机名）时，用原文 sha256 前 8 位兜底，保证多机不撞
 *
 * ── 两条"必须掺原文指纹"的路径（都是真实踩过的多机撞 id） ─────────────
 *
 * 修复前的实现只在**剥完为空**时才掺指纹，于是另外两种"信息被丢掉"的情况
 * 会静默地把不同的机器收敛成**同一个 id**：
 *
 *   ① 非法字符被替换后又被边界剥除：`"研发-pc"` 与 `"测试-pc"` 都变成 `"pc"`。
 *      这是最常见的形态 —— 中文前缀 + ASCII 后缀的主机名（`<中文>-pc`、
 *      `我的-PC`…）在中文 Windows 上遍地都是，两台这样的机器会撞成同一个
 *      nodeId，hub 侧表现为 `duplicate-node`，一台把另一台顶下线。
 *   ② 截断到 64：`"a"*70` 与 `"a"*64 + "b"` 前 64 位相同 → 同一个 id。
 *
 * 判据是"清洗后是否丢掉了信息"（`s !== 规范化原文`），而不是"结果是否为空"。
 * 只要丢过信息就掺 8 位指纹：既有可读前缀，又能保证不同原文不同 id。
 * 反过来，**没丢信息时绝不动 id** —— 显式配置的 `nodeId: "slave-pc"` 必须
 * 原样保留，否则用户按文档配的 id 会带上莫名其妙的哈希后缀。
 */
export function sanitizeNodeId(raw) {
  const src = typeof raw === 'string' ? raw : String(raw ?? '')
  const cleaned = src.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  let s = cleaned.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')
  let lossy = s !== cleaned
  if (s.length > NODE_ID_MAX) {
    s = s.slice(0, NODE_ID_MAX).replace(/[^a-z0-9]+$/, '')
    lossy = true
  }
  if (s === '') lossy = true
  if (lossy) {
    // 原文为空时用 'node' 当盐：空输入不是"某台机器"，但也别产生裸的 "node-"。
    const h = createHash('sha256')
      .update(src === '' ? 'node' : src, 'utf8')
      .digest('hex')
      .slice(0, NODE_ID_HASH_LEN)
    // 前缀留出指纹与 '-' 的位置，保证最终长度仍 <= 64。
    const room = NODE_ID_MAX - NODE_ID_HASH_LEN - 1
    s = `${s === '' ? 'node' : s.slice(0, room)}-${h}`
  }
  return NODE_ID_RE.test(s) ? s : `node-${Date.now().toString(36)}`
}

export function detectOs() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

/** 本机可用 shell 列表（只是声明，供 hub 侧挑选 exec 的写法）。 */
export function detectShells() {
  const out = []
  const add = (v) => {
    if (typeof v === 'string' && v.trim() !== '' && !out.includes(v)) out.push(v)
  }
  if (process.platform === 'win32') {
    add(process.env.DSH_REMOTE_PWSH)
    add('pwsh')
    add('powershell')
    add(process.env.ComSpec || 'cmd.exe')
  } else {
    add(process.env.SHELL)
    add('/bin/bash')
    add('/bin/sh')
  }
  return out
}

export function resolveStateDir(config) {
  const c = asConfig(config)
  const explicit = typeof c.stateDir === 'string' ? c.stateDir.trim() : ''
  if (explicit !== '') return path.resolve(explicit)
  try {
    return path.join(os.homedir(), '.dsh-remote-agent')
  } catch {
    return path.join(os.tmpdir(), '.dsh-remote-agent')
  }
}

/**
 * 把任意 config 归一化成对象。
 *
 * 为什么不能只写 `config = {}` 默认参数：默认值**只对 `undefined` 生效**，
 * 显式传 `null` 会绕过它，随后 `config.stateDir` / `config.roots` / `config.token`
 * 直接抛 TypeError。这几个函数是导出给外部（含测试、未来的 CLI）用的配置解析入口，
 * "配置解析不能因为一个 null 就炸" 是它们最基本的契约 —— 而 `null` 恰恰是
 * JSON/YAML 里"这个键没配"的常见写法（`stateDir:` 留空会解析成 null）。
 */
function asConfig(config) {
  return isPlainObject(config) ? config : {}
}

/** 允许的工作区根：配置非空就用配置，否则用保守默认（home 下的工作目录）。 */
export function resolveRoots(config) {
  const c = asConfig(config)
  const configured = Array.isArray(c.roots)
    ? c.roots.filter((r) => typeof r === 'string' && r.trim() !== '')
    : []
  if (configured.length > 0) return configured
  try {
    return defaultRoots()
  } catch {
    return []
  }
}

/** token：配置优先，其次 <stateDir>/token 文件。 */
export function resolveToken(config, stateDir = '') {
  const c = asConfig(config)
  if (typeof c.token === 'string' && c.token.trim() !== '') return c.token.trim()
  if (typeof stateDir !== 'string' || stateDir === '') return ''
  try {
    return fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 读副机当前默认模型选择（提案 #27）。
 *
 * 来源是 DSH 的 `agentDefaultModel` 服务（`currentSelection()` 返回 detached
 * 的 provider/model/reasoning 选择）。**只报 provider 键名与 model id，
 * 不碰任何凭证**。取不到（服务缺失 / 抛错 / 字段形态不对）一律 null ——
 * 上报是尽力而为的遥测，绝不能影响资源帧本身。
 */
export function readDefaultModel(ctx) {
  try {
    const dm = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
    if (!sel || typeof sel !== 'object') return null
    const provider = typeof sel.provider === 'string' && sel.provider !== '' ? sel.provider.slice(0, 64) : ''
    const model = typeof sel.model === 'string' && sel.model !== '' ? sel.model.slice(0, 128) : ''
    if (model === '') return null
    return { provider, model }
  } catch {
    return null
  }
}

/** 模型清单上限：够面板下拉用，又不让 RESOURCE 帧膨胀。 */
const MAX_MODELS = 64
/** 单个 provider 的模型上限（防止某个聚合 provider 一次吐几百个）。 */
const MAX_MODELS_PER_PROVIDER = 24
/** provider 数量上限。 */
const MAX_MODEL_PROVIDERS = 8

/**
 * 收集副机**可用的模型清单**（提案 #27 的面板下拉数据源）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么现在能做（2026-10-17 更新）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v0.7.0 的注释曾写"in-process 后端没有稳定的清单 API（DSH 内部的
 * `model/list` 走 app-server 协议面，fiber 服务摸不到）" —— **那个判断
 * 已经过时**。`ctx.llm` 服务现在直接暴露：
 *
 *     listProviders(): LlmProviderInfo[]                     // {id, name}
 *     async listModels(provider): Promise<LlmModelInfo[]>    // {provider, id, name, ...}
 *
 * 所以面板可以真的渲染下拉，而不是让用户猜 provider/model 名、填错了等
 * 任务跑到副机才失败。
 *
 * ── 安全边界（硬要求）──────────────────────────────────────────────────
 *
 * **只上报 provider 键名 + model id + 显示名**。
 * 绝不上报：apiKeyEnv 的值、baseURL、任何凭证、未注册的 provider。
 * `listProviders()` 只返回**已注册（有 adapter）** 的 route —— 天然满足
 * "不泄露这台机器配了哪些渠道"，只有真能用的才会出现。
 *
 * ── 尽力而为 ────────────────────────────────────────────────────────────
 *
 * 每个 provider 的 `listModels` 都可能抛（网络探测、鉴权失败、adapter 不
 * 支持）。单个 provider 失败**不影响其它**；全部失败则返回 null（面板退回
 * 自由文本）。整段包在 try/catch 里：遥测帧绝不能因为模型探测而丢。
 *
 * @returns {Promise<{models: Array<{provider:string,id:string,name:string}>, defaultModel: object|null}|null>}
 */
export async function readAvailableModels(ctx) {
  let llm
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    return null
  }
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return null
  }

  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return null
  }
  if (!Array.isArray(providers) || providers.length === 0) return null

  const models = []
  // 逐个 provider 探测；单个失败静默跳过（不打断其它）。
  for (const p of providers.slice(0, MAX_MODEL_PROVIDERS)) {
    const providerId = p && typeof p.id === 'string' ? p.id.trim() : ''
    if (providerId === '') continue
    let list
    try {
      // 逐个探测是刻意的：并发打满会把副机的出站连接占住，
      // 而这里只是低频遥测（RESOURCE 帧 30s 一次）。
      list = await llm.listModels(providerId)
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    for (const m of list.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!m || typeof m.id !== 'string' || m.id === '') continue
      const id = m.id.slice(0, 128)
      const name = typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id
      models.push({ provider: providerId.slice(0, 64), id, name })
      if (models.length >= MAX_MODELS) break
    }
    if (models.length >= MAX_MODELS) break
  }

  if (models.length === 0) return null
  return { models, defaultModel: readDefaultModel(ctx) }
}

/** 组 hello：hub 与 relay 都靠它认这台机器。 */
export function buildNodeHello(config, { roots, nodeId } = {}) {  const c = asConfig(config)
  // 不变式：产出的 hello **必须**能过 protocol.validateHello。所以显式 override 也
  // 要过一遍 sanitizeNodeId —— 调用方塞一个未清洗的 id（`''` / `'中文节点'` / `'X Y'`）
  // 会让 buildNodeHello 直接产出 hub 必拒的 hello（`hello-nodeId-invalid`），而
  // "本地先生成合法的，别让 hub 拒"正是本文件 NODE_ID_RE 的既定职责。
  // sanitizeNodeId 对已清洗的 id 幂等，所以 startWorker（传的是清洗后的值）行为不变。
  const override = nodeId == null || nodeId === '' ? undefined : nodeId
  const id = sanitizeNodeId(override ?? (c.nodeId || safeHostname()))
  return {
    nodeId: id,
    protocol: PROTOCOL_VERSION,
    os: detectOs(),
    arch: typeof process.arch === 'string' ? process.arch : 'unknown',
    hostname: safeHostname(),
    dshVersion: typeof process.env.DSH_VERSION === 'string' ? process.env.DSH_VERSION : '',
    shells: detectShells(),
    // roots 必须是**副本**：hello 会被 transport 长期持有并反复发出去，
    // 返回引用的话调用方就地排序/清洗就会悄悄改掉已上线节点的声明。
    roots: Array.isArray(roots) ? roots.slice() : resolveRoots(c),
    caps: [...CAPS, 'file-transfer', 'selfcheck', ...(process.platform === 'win32' ? ['desktop', 'gui'] : [])],
    profile: typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE : '',
    // agentMode：这台副机接不接受 agent 模式任务（#14 的能力过滤依据）。
    // **可配置关掉**（agentMode: false）—— 真机验证实锤（见
    // docs/verification-repos-routing-real.md §3③）它曾被硬编码 true，
    // 让 hub 侧的 agentMode 过滤成为空承诺。默认 true：worker 会在没有
    // DSH 上下文时回退 headless runner，接受任务仍是安全的。
    agentMode: c.agentMode === false ? false : true,
    time: Date.now(),
  }
}

/**
 * 建 stateDir（含 tasks/）。不可写就退到临时目录；再不行返回 '' 让上层彻底降级。
 *
 * **永不抛**：stateDir 不可写只是"这台机器上任务状态没地方落盘"，不是启动失败。
 * 调用方（startWorker）据此决定是否降级成 idle worker，所以这里必须返回 '' 而不是
 * 把 EACCES/EPERM/ENOTDIR 抛出去 —— 抛了会让副机 dsh 整个起不来。
 *
 * 导出是为了让"降级而非抛"这条契约可被直接测试（原先它是模块私有函数，
 * 只能通过 applyWorker 间接覆盖，而 applyWorker 需要 cordis ctx）。
 */
export function ensureStateDir(preferred) {
  const fallback = path.join(os.tmpdir(), `${PLUGIN_NAME}-${process.pid}`)
  for (const dir of [preferred, fallback]) {
    if (typeof dir !== 'string' || dir === '') continue
    try {
      fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
      return dir
    } catch {
      /* 试下一个候选 */
    }
  }
  return ''
}

/** 状态接口里回显 url 时抹掉 token，别把凭证写进任何可读响应。 */
function redactUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    const u = new URL(raw)
    if (u.searchParams.has('token')) u.searchParams.set('token', '***')
    return u.toString()
  } catch {
    return raw.replace(/token=[^&]*/gi, 'token=***')
  }
}

/* ────────────────────────────── 主入口 ────────────────────────────── */

/**
 * 装配副机 worker。**同步返回**，永不抛。
 *
 * @param {object} ctx dsh 上下文（只需要 on/effect/get；agentLoop/webServer 等一律可选）
 * @param {object} [config]
 * @param {string} [config.pair] 配对码 dshra1://…（主机向导生成；展开成
 *   transportMode/hubUrl/relayUrl/token/nodeId，显式配置优先 —— 见 lib/pairing.js）
 * @param {string} [config.nodeId] 节点 id，缺省取 os.hostname() 清洗后的结果
 * @param {string} [config.stateDir] 状态目录，缺省 ~/.dsh-remote-agent
 * @param {'direct'|'relay'} [config.transportMode='direct']
 * @param {string} [config.hubUrl] direct 模式拨入地址
 * @param {string} [config.relayUrl] relay 模式会合地址
 * @param {string} [config.token] 入网 token，缺省读 <stateDir>/token
 * @param {string} [config.pinnedHubFingerprint] 显式钉住的 hub 指纹（hubfp1-…，P2-11）。
 *   未配置时首连自动钉住（TOFU，<stateDir>/hub-pin.json）；之后不匹配即拒绝
 *   上线并停止重连。配对码带指纹时运行时自动填这里（零终端分发）。
 * @param {string[]} [config.roots] 允许的工作区根
 * @param {string[]} [config.denyPaths] 额外禁止路径
 * @param {string} [config.dshBin] headless 回退用的 dsh 可执行文件
 * @param {boolean} [config.preferHeadless] 强制走 headless 后端
 * @param {number} [config.maxConcurrent=2] 并发任务上限
 * @param {boolean} [config.resumeQueued=true] 启动时是否重跑上次遗留的 queued 任务
 * @returns {() => void} disposer（同时挂在 `.dispose` 上），幂等、永不抛
 */
export function applyWorker(ctx, config = {}) {
  try {
    return startWorker(ctx, config)
  } catch (err) {
    // 最后一道兜底：装配期任何意外都只降级成"worker 不启动"，绝不让副机 dsh 起不来。
    safeInvoke(() => console.warn(`${PLUGIN_TAG} worker disabled after startup error`, msgOf(err)))
    return makeDisposer(() => {})
  }
}

/** 让模块本身也能被当成一个插件行直接加载。 */
export default applyWorker

function makeDisposer(fn) {
  let done = false
  const dispose = () => {
    if (done) return
    done = true
    safeInvoke(fn)
  }
  // 同时支持 `d()` 与 `d.dispose()` 两种调用习惯
  dispose.dispose = dispose
  return dispose
}

function startWorker(ctx, config) {
  const logger = createLogger(ctx)
  // pair 展开放在最前面：后面所有字段解析（url/token/nodeId）都基于展开后的 cfg。
  // pair 无效只降级成"没配对码"，记一条 warn —— 绝不让副机 dsh 起不来。
  const expansion = expandPairConfig(config)
  const cfg = isPlainObject(expansion.config) ? { ...expansion.config } : {}
  if (expansion.error !== '') {
    logger.warn('配对码（pair）无效，按未配置处理', { error: expansion.error })
  }

  /* 1) 状态目录 ------------------------------------------------------- */
  const stateDirPreferred = resolveStateDir(cfg)
  const stateDir = ensureStateDir(stateDirPreferred)
  if (stateDir === '') {
    logger.error('state directory unavailable; worker stays idle', { stateDir: stateDirPreferred })
    return makeDisposer(() => {})
  }
  if (stateDir !== stateDirPreferred) {
    logger.warn('configured state dir not writable, using fallback', { stateDir, configured: stateDirPreferred })
  }

  /* 2) 身份 ----------------------------------------------------------- */
  const roots = resolveRoots(cfg)
  const nodeId = sanitizeNodeId(cfg.nodeId || safeHostname())
  const profile = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE : ''
  const dshVersion = typeof process.env.DSH_VERSION === 'string' ? process.env.DSH_VERSION : ''
  const hello = buildNodeHello(cfg, { roots, nodeId })

  const caseInsensitive = process.platform === 'win32'
  const denyPaths = [
    ...(Array.isArray(cfg.denyPaths) ? cfg.denyPaths.filter((p) => typeof p === 'string' && p !== '') : []),
    stateDir,
  ]

  // 远程文件工具集（提案 #25）：与任务链路同源的 roots/denyPaths —— 同一个
  // 安全边界，两处入口。只读实现，见 lib/node/fs-service.js 头注释。
  const fsService = createFsService({ roots, denyPaths, caseInsensitive })

  /**
   * 进程与端口诊断（2026-10-20）。
   *
   * 与 fsService 分开：进程操作**没有路径概念**，所以 roots/denyPaths
   * 那套护栏不适用。它自己的护栏全在 `lib/node/process-service.js` 里
   * （kill 的 confirm + 拒杀自身/父进程/系统关键进程）。
   *
   * 为什么不带 cfg：这里不需要任何用户配置 —— 少一个配置面就少一类
   * 配置错误。若将来要加白名单，再引入 cfg。
   */
  const processService = createProcessService()

  /* 3) 任务仓库 ------------------------------------------------------- */
  let store
  try {
    store = new TaskStore(stateDir)
  } catch (err) {
    logger.error('task store unavailable; worker stays idle', { error: msgOf(err), stateDir })
    return makeDisposer(() => {})
  }

  // 启动时清一次过期的终态任务记录。
  //
  // ⚠ 此前 `TaskStore.prune()` **定义了但从未被调用**（2026-10-15 独立评审
  // 发现）—— 于是终态任务的内存缓存与磁盘文件**无限累积**：
  // 每条记录最多含 200KB 日志尾巴，长期运行的副机会越用越胖。
  //
  // 放在启动时而不是定时器里：清理由"重启"这个天然边界承担就够了，
  // 不值得为它维护一个常驻定时器（多一个要 unref 的东西、多一处出错面）。
  // 保留期 7 天 —— 比任何合理的"回看昨天那个任务"需求都长。
  try {
    const removed = store.prune()
    if (removed > 0) logger.info('pruned expired task records', { removed, stateDir })
  } catch (err) {
    // 清理失败不能挡住启动 —— 它只是卫生工作。
    logger.warn('task prune failed (non-fatal)', { error: msgOf(err) })
  }

  /* 4) 产物服务 + 执行后端 -------------------------------------------- */
  const artifacts = new ArtifactService({
    nodeId,
    caseInsensitive,
    onEvent: (evt) => logger.debug(`artifact: ${evt?.msg ?? ''}`, evt),
  })

  const runner = selectRunner({
    ctx,
    nodeId,
    profile,
    dshBin: typeof cfg.dshBin === 'string' ? cfg.dshBin : undefined,
    preferHeadless: cfg.preferHeadless === true,
  })

  // 全面升级：文件互传、桌面截图与结构化自检都复用同一 FS RPC/E2E 通道。
  const fileTransfer = createFileTransferService({ roots, denyPaths, caseInsensitive })
  const desktop = createDesktopService({ stateDir })
  const selfCheck = createSelfCheckService({
    roots,
    runner,
    // CAPS describes protocol support; agentMode is the live dispatch opt-in.
    capabilities: {
      exec: CAPS.includes('exec'),
      agent: CAPS.includes('agent') && hello.agentMode === true,
    },
    desktopCheck: async ({ purpose }) => {
      if (purpose !== 'gui') return { status: 'pass', actual: 'not required for headless work' }
      const shot = await desktop.capture()
      desktop.release(shot.id)
      return { status: 'pass', expected: 'interactive desktop capture', actual: { width: shot.width, height: shot.height } }
    },
  })

  /* 5) 传输层 --------------------------------------------------------- */
  const transportMode = cfg.transportMode === TRANSPORT_MODE.RELAY ? TRANSPORT_MODE.RELAY : TRANSPORT_MODE.DIRECT
  // relay 模式优先取 relayUrl，direct 模式优先取 hubUrl；两者都给时按模式取对应的那个。
  const url = transportMode === TRANSPORT_MODE.RELAY
    ? String(cfg.relayUrl || cfg.hubUrl || '')
    : String(cfg.hubUrl || cfg.relayUrl || '')
  const token = resolveToken(cfg, stateDir)

  // ── P2-11：hub 身份验证接线 ──
  // transport 自身不碰 fs：TOFU 钉住的读写经 pinStore 注入，测试可用内存实现。
  // pinnedHubFingerprint 显式配置优先；形态不对按未配置处理并大声提醒
  // （静默忽略会让"我明明配了指纹"的排查变成无头案）。
  const pinStore = {
    get: () => loadHubPin(stateDir),
    set: (pin) => {
      const ok = saveHubPin(stateDir, pin)
      if (!ok) logger.warn('hub pin 落盘失败 —— 下次连接将重新首连钉住（TOFU）', { fingerprint: pin?.fingerprint })
      return ok
    },
    clear: () => clearHubPin(stateDir),
  }
  const pinnedFingerprint = normalizeFingerprint(cfg.pinnedHubFingerprint ?? '')
  if (typeof cfg.pinnedHubFingerprint === 'string' && cfg.pinnedHubFingerprint.trim() !== '' && pinnedFingerprint === '') {
    logger.warn('pinnedHubFingerprint 形态不对（应为 hubfp1- 开头共 29 字符），按未配置处理', { value: cfg.pinnedHubFingerprint })
  }
  const transport = new NodeTransport({
    mode: transportMode,
    url,
    token,
    hello,
    pinnedFingerprint,
    pinStore,
    // 提案 #1：E2E 会话加密（默认开）。relayE2E:false 显式关闭 —— 关掉后
    // 中继链路回到"明文 + 依赖 TLS"的旧行为。
    e2e: cfg.relayE2E !== false,
  })

  /* 6) 发送助手：永不抛、失败即丢帧（断连期间任务照跑） ---------------- */
  let lastError = ''
  /**
   * 最近一次连接失败的结构化详情（2026-10-20，体验提升 ①）。
   *
   * `lastError` 只是原始字符串，面板没法据此给用户"下一步做什么"。
   * 这里存翻译后的三件套：{ at, title, detail, hint, raw, code }。
   *
   * 面板据此显示：
   *   ✗ 最后尝试 2 分钟前 —— 主机上没有服务在监听
   *      → 检查：① 主机的 DSH 是否在跑；② 端口是否写对…
   *      原始错误：connect ECONNREFUSED 100.86.48.54:19387
   */
  let lastErrorDetail = null
  const send = (type, data, opts) => {
    try {
      return transport.send(type, data, opts) === true
    } catch (err) {
      logger.warn('send failed', { type, error: msgOf(err) })
      return false
    }
  }
  const sendError = (replyTo, code, message, extra) => {
    send(NODE_TO_HUB.ERROR, { nodeId, code, message, ...(replyTo ? { replyTo } : {}), ...(extra ?? {}) })
  }

  /* 6.5) 资源上报 ------------------------------------------------------ */
  // 每 30s 采一次 CPU（增量）/内存/负载，经 node/resource 帧发给 hub ——
  // 派发前先看节点负载（remote_nodes + 面板节点行）。尽力而为的遥测：
  // 断连期间 send 丢帧无害；resourceIntervalMs=0 可关（不想上报的副机）。
  const sampler = createResourceSampler()
  const resourceIntervalMs = Number.isFinite(cfg.resourceIntervalMs)
    ? Math.max(0, cfg.resourceIntervalMs)
    : RESOURCE_INTERVAL_MS

  /**
   * 模型清单缓存（提案 #27）。
   *
   * `readAvailableModels` 是 async（`llm.listModels()` 可能走网络探测），
   * 而 RESOURCE 帧的 `setInterval` 回调是**同步**的 —— 不能在回调里 await。
   *
   * 所以用一个后台刷新循环：启动时探一次，之后每 `MODELS_REFRESH_MS` 重探。
   * 帧里带的是**上一次的结果**（可能为 null = 还没探完/全部失败）。
   *
   * 为什么不用 `void refresh()` 直接塞进 interval：那会在探测慢时堆积
   * 并发探测（每 30s 一次帧 × 探测要 3s = 越积越多）。用串行链保证
   * 任何时刻最多一个探测在跑（与 repos 上报同款手法）。
   */
  const MODELS_REFRESH_MS = 10 * 60 * 1000
  let cachedModels = null
  let modelsTail = Promise.resolve()
  let modelsQueued = false
  const refreshModels = () => {
    if (modelsQueued) return
    modelsQueued = true
    modelsTail = modelsTail.then(async () => {
      modelsQueued = false
      try {
        const r = await readAvailableModels(ctx)
        if (r) cachedModels = r
      } catch {
        /* 探测失败保留上一次的结果 —— 面板不该因为一次网络抖动退回空列表 */
      }
    })
  }
  // 启动后立刻探一次（不阻塞装配：fire-and-forget，结果进了缓存下一帧就带出去）
  refreshModels()
  const modelsTimer = resourceIntervalMs > 0
    ? setInterval(refreshModels, MODELS_REFRESH_MS)
    : undefined
  if (modelsTimer?.unref) modelsTimer.unref()

  const resourceTimer = resourceIntervalMs > 0
    ? setInterval(() => {
      // 队列健康快照（提案 #26-3）随资源帧搭车：engine 在下方第 7 节才
      // 装配，但 interval 回调最早也在装配完成后才触发，引用安全。
      // engine 尚未就绪（极端：interval 在装配中途先触发）时给空快照。
      const queue = engine ? engine.queueStats() : { queued: 0, running: 0, maxConcurrent: 0, oldestQueuedMs: 0, starved: false }
      // 提案 #27：执行后端与默认模型随帧自述 —— hub 派发前要知道
      // "这台副机用哪个后端、默认模型是什么"（面板显示 + 派发前校验）。
      // currentSelection 每帧重算（用户可在副机改默认），取不到就 null。
      //
      // `models` 是**可用模型清单**（面板下拉的数据源），来自缓存 ——
      // 探测是 async 的，不能在同步 interval 里 await（见 refreshModels）。
      // 只报 provider 键名 + model id + 显示名，不碰任何凭证。
      send(NODE_TO_HUB.RESOURCE, {
        nodeId,
        ...sampler.sample(),
        queue,
        runnerKind: runner.kind,
        defaultModel: readDefaultModel(ctx),
        models: cachedModels,
      })
    }, resourceIntervalMs)
    : undefined
  if (resourceTimer?.unref) resourceTimer.unref()

  /* 6.6) 仓库清单上报（提案 #13） ---------------------------------- */
  // 接入后扫一次 roots 下的 git 仓库（零子进程，见 repos.js），此后每
  // reposIntervalMs（默认 10min）重扫一次 —— 新 clone 的仓库最迟 10 分钟
  // 后可被 repo: 路由找到。尽力而为：扫描/发送失败都不影响任务链路；
  // reposIntervalMs=0 可关（不想上报目录结构的副机）。
  const REPOS_INTERVAL_MS = 10 * 60 * 1000
  const reposIntervalMs = Number.isFinite(cfg.reposIntervalMs)
    ? Math.max(0, cfg.reposIntervalMs)
    : REPOS_INTERVAL_MS
  // 串行 promise 链（与 audit-log 同款手法）：进行中/排队中就跳过本轮，
  // 扫描绝不并发、也绝不阻塞任务链路。用链而不是布尔标志，是为了让
  // require-atomic-updates 有话可说的地方不存在 —— 状态只被同步触碰。
  let reposTail = Promise.resolve()
  let reposQueued = false
  const sendRepos = () => {
    if (reposQueued) return
    reposQueued = true
    reposTail = reposTail.then(async () => {
      reposQueued = false
      try {
        const repos = await scanRepos(roots)
        if (repos.length > 0) send(NODE_TO_HUB.REPOS, { nodeId, repos })
      } catch (err) {
        logger.warn('repos scan failed (non-fatal)', { error: msgOf(err) })
      }
    })
  }
  const reposTimer = reposIntervalMs > 0 ? setInterval(() => { void sendRepos() }, reposIntervalMs) : undefined
  if (reposTimer?.unref) reposTimer.unref()

  /* 7) 任务引擎 ------------------------------------------------------- */
  const engine = new TaskEngine({
    store,
    artifacts,
    runner,
    nodeId,
    roots,
    denyPaths,
    defaultWorkspace: roots[0],
    caseInsensitive,
    send,
    logger,
    // 默认 4（提案 #26-2）：2 太脆，两条慢任务就能锁死整台机器。
    maxConcurrent: Number.isFinite(cfg.maxConcurrent) ? Math.max(1, cfg.maxConcurrent) : 4,
  })

  // TaskEngine.pump() 用 `void this.execute(taskId)` 起任务 —— 一旦 execute reject，
  // Node 会记成 unhandledRejection，在默认策略下会直接终止副机 dsh。
  // 引擎是冻结的，所以在接线层包一层：任务级失败必须只影响那一条任务。
  const rawExecute = engine.execute.bind(engine)
  engine.execute = async (taskId) => {
    try {
      return await rawExecute(taskId)
    } catch (err) {
      logger.error('task execution crashed', { taskId, error: msgOf(err) })
      safeInvoke(() => send(NODE_TO_HUB.ERROR, { nodeId, code: ERROR_CODE.INTERNAL, message: msgOf(err), taskId }))
      return undefined
    }
  }

  /* 8) 帧分发 --------------------------------------------------------- */
  async function runPull({ rec, pullId, relPath, startOffset = 0 }) {
    try {
      const result = await artifacts.pull({
        manifest: rec.manifest,
        pullId,
        relPath,
        startOffset,
        workspace: rec.workspace,
        emit: async (header, payload) => {
          try {
            return transport.sendBinary(header, payload) === true
          } catch (err) {
            logger.warn('artifact chunk send failed', { pullId, error: msgOf(err) })
            return false
          }
        },
        drain: () => transport.drain(HIGH_WATER_BYTES, DRAIN_TIMEOUT_MS),
      })
      if (result && result.ok === false) {
        logger.warn('pull incomplete', { pullId, path: relPath, sent: result.sent, aborted: result.aborted })
      } else {
        logger.info('pull complete', { pullId, path: relPath, bytes: result?.sent })
      }
      return result
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
      logger.warn('pull failed', { pullId, path: relPath, error: msgOf(err) })
      sendError(undefined, code, msgOf(err), { pullId, taskId: rec.taskId, path: relPath })
      return undefined
    }
  }

  function handleTaskStart(frame, d) {
    const v = validateTaskStart(d)
    if (!v.ok) {
      sendError(frame.id, v.error, `invalid task/start: ${v.error}`)
      return
    }
    try {
      engine.accept(v.spec)
    } catch (err) {
      logger.warn('task accept failed', { taskId: v.spec.taskId, error: msgOf(err) })
      sendError(frame.id, ERROR_CODE.INTERNAL, msgOf(err), { taskId: v.spec.taskId })
    }
  }

  function handleTaskQuery(frame, d) {
    const taskId = typeof d.taskId === 'string' ? d.taskId : ''
    if (taskId === '') {
      // 没有 taskId 就是"把你手上全部任务状态给我" —— 重连补齐走的就是这条
      safeInvoke(() => engine.syncAll())
      return
    }
    const rec = store.get(taskId)
    if (!rec) {
      sendError(frame.id, ERROR_CODE.TASK_UNKNOWN, `unknown taskId ${taskId}`, { taskId })
      return
    }
    send(NODE_TO_HUB.TASK_SYNC, { nodeId, taskId, tasks: [store.view(rec)] }, { replyTo: frame.id })
  }

  function handleArtifactList(frame, d) {
    const taskId = typeof d.taskId === 'string' ? d.taskId : ''
    if (taskId === '') {
      send(NODE_TO_HUB.ARTIFACT_MANIFEST, {
        nodeId,
        tasks: store.list()
          .filter((r) => r.manifest)
          .map((r) => ({ taskId: r.taskId, status: r.status, counts: r.manifest.counts, items: r.manifest.items })),
      }, { replyTo: frame.id })
      return
    }
    const rec = store.get(taskId)
    if (!rec) {
      sendError(frame.id, ERROR_CODE.TASK_UNKNOWN, `unknown taskId ${taskId}`, { taskId })
      return
    }
    // manifest 先于字节：hub 只拿到清单，要不要 pull 由它决定
    const manifest = rec.manifest ?? null
    send(NODE_TO_HUB.ARTIFACT_MANIFEST, {
      nodeId,
      taskId,
      status: rec.status,
      manifest,
      counts: manifest?.counts ?? null,
      items: manifest?.items ?? [],
    }, { replyTo: frame.id })
  }

  function handleArtifactPull(frame, d) {
    const taskId = typeof d.taskId === 'string' ? d.taskId : ''
    const relPath = typeof d.path === 'string' ? d.path : ''
    const pullId = typeof d.pullId === 'string' && d.pullId !== '' ? d.pullId : newPullId()
    // 断点续传：hub 带来已收前缀字节数（可选，缺省 = 从头）。畸形值按协议违规拒绝
    let startOffset = 0
    if (d.startOffset !== undefined && d.startOffset !== null) {
      if (!Number.isInteger(d.startOffset) || d.startOffset < 0) {
        sendError(frame.id, 'artifact-pull-invalid', `invalid startOffset: ${d.startOffset}`, { pullId })
        return
      }
      startOffset = d.startOffset
    }
    if (taskId === '' || relPath === '') {
      sendError(frame.id, 'artifact-pull-invalid', 'artifact/pull requires taskId and path', { pullId })
      return
    }
    const rec = store.get(taskId)
    if (!rec) {
      sendError(frame.id, ERROR_CODE.TASK_UNKNOWN, `unknown taskId ${taskId}`, { taskId, pullId })
      return
    }
    if (!rec.manifest) {
      sendError(frame.id, ERROR_CODE.ARTIFACT_MISSING, `no manifest for ${taskId}`, { taskId, pullId })
      return
    }
    // 不 await：分块外发可能跑很久，不能挡住后续帧的处理
    swallow(runPull({ rec, pullId, relPath, startOffset }))
  }

  function dispatch(frame) {
    const d = isPlainObject(frame?.d) ? frame.d : {}
    switch (frame?.t) {
      case HUB_TO_NODE.TASK_START:
        // P2-11：hub 身份未决（relay 宽限窗口内）不接任务 —— 假中继正是趁
        // 这个空窗冒充 hub 下发 exec（副机任意代码执行）。hub 侧收到该错误
        // 会看到明确 code，等身份帧验证过后重派即可。
        if (hubIdentity === 'pending') {
          sendError(frame.id, ERROR_CODE.HUB_IDENTITY_PENDING, 'hub identity not verified yet; retry in a few seconds', { taskId: d.taskId })
          return
        }
        handleTaskStart(frame, d)
        return
      case HUB_TO_NODE.TASK_CANCEL: {
        const taskId = typeof d.taskId === 'string' ? d.taskId : ''
        if (taskId === '') {
          sendError(frame.id, 'task-cancel-invalid', 'task/cancel requires taskId')
          return
        }
        swallow(engine.cancel(taskId))
        return
      }
      case HUB_TO_NODE.TASK_QUERY:
        handleTaskQuery(frame, d)
        return
      case HUB_TO_NODE.ARTIFACT_LIST:
        handleArtifactList(frame, d)
        return
      case HUB_TO_NODE.ARTIFACT_PULL:
        handleArtifactPull(frame, d)
        return
      case HUB_TO_NODE.ARTIFACT_CANCEL: {
        const pullId = typeof d.pullId === 'string' ? d.pullId : ''
        if (pullId === '') {
          sendError(frame.id, 'artifact-cancel-invalid', 'artifact/cancel requires pullId')
          return
        }
        logger.info('artifact cancel requested', { pullId, cancelled: artifacts.cancel(pullId) })
        return
      }
      case HUB_TO_NODE.PING:
        // transport 自己已回 pong；这里保留一条兜底，防止上层换实现后 ping 悬空
        send(NODE_TO_HUB.PONG, { echo: frame.id, nodeId, time: Date.now() }, { replyTo: frame.id })
        return
      case HUB_TO_NODE.FS_REQ:
        // 远程文件工具集（提案 #25）：异步执行，不挡后续帧；结果回 fs/res，
        // reqId 就是请求信封 id（hub 按 replyTo 对 pending 表）。
        handleFsReq(frame, d)
        return
      case HUB_TO_NODE.SHARE_REQ:
        // 工作区 SMB 共享（2026-10-17）：**只探测 + 生成命令**，不执行。
        // 执行需要管理员，而 DSH 通常以普通用户跑 —— 由用户在提权 PowerShell
        // 里手动做（面板给可复制命令）。见 lib/node/share-service.js 头注释。
        handleShareReq(frame, d)
        return
      case HUB_TO_NODE.ERROR:
        logger.warn('hub reported error', { code: d.code, message: d.message, replyTo: d.replyTo })
        return
      default:
        logger.debug('unhandled frame type', { type: frame?.t })
    }
  }

  /**
   * 执行一条远程文件请求（提案 #25）。所有错误——包括被 FsError 表达的
   * 业务拒绝（越界 / denyPaths / 超限）——都折进 fs/res 的 ok:false 载荷，
   * 让 hub 工具层拿到结构化的 code 而不是一条 ERROR 帧。
   */
  function handleFsReq(frame, d) {
    const op = typeof d.op === 'string' ? d.op : ''
    // 只读四项 + 写操作四项（2026-10-20）。
    // ⚠ 写操作由 hub 工具层要求 `confirm: 'yes'`，副机侧只做路径与内容护栏。
    const ops = {
      ls: 'ls', read: 'read', grep: 'grep', tree: 'tree',
      write: 'write', mkdir: 'mkdir', move: 'move', delete: 'delete',
      // 进程与端口诊断（2026-10-20）：只读的 list/port 与不可逆的 kill。
      // ⚠ 它们**不受 roots 约束**（进程没有"路径"概念），
      // 所以护栏全部落在 `lib/node/process-service.js` 内部
      // （kill 的 confirm + 拒杀自身/父进程/系统进程）。
      ps: 'ps', port: 'port', kill: 'kill',
    }
    const advancedOps = {
      selfcheck: (input) => selfCheck.check(input),
      fileStat: (input) => fileTransfer.stat(input),
      fileRead: (input) => fileTransfer.readChunk(input),
      fileBegin: (input) => fileTransfer.beginWrite(input),
      fileWrite: (input) => fileTransfer.writeChunk(input),
      fileCommit: (input) => fileTransfer.commit(input),
      fileAbort: (input) => fileTransfer.abort(input),
      desktopCapture: () => desktop.capture(),
      desktopRead: (input) => readDesktopChunk(desktop, input),
      desktopRelease: (input) => ({ id: input.id, released: desktop.release(input.id) }),
    }
    const fn = ops[op]
    const advanced = advancedOps[op]
    if (!fn && !advanced) {
      send(NODE_TO_HUB.FS_RES, { replyTo: frame.id, ok: false, code: ERROR_CODE.WORKSPACE_DENIED, message: `unknown fs op: ${op || '(empty)'}` })
      return
    }
    const started = Date.now()
    swallow(Promise.resolve().then(() => {
      // 进程诊断走独立的 processService；文件操作走 fsService。
      // 分开是因为两者的安全模型完全不同（路径护栏 vs 进程护栏）。
      const svc = (op === 'ps' || op === 'port' || op === 'kill') ? processService : fsService
      const result = advanced ? advanced(d) : svc[fn](d)
      logger.debug('fs op done', { op, ms: Date.now() - started, nodeId })
      send(NODE_TO_HUB.FS_RES, { replyTo: frame.id, ok: true, result })
    }).catch((err) => {
      const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
      logger.warn('fs op failed', { op, ms: Date.now() - started, code, error: msgOf(err) })
      send(NODE_TO_HUB.FS_RES, {
        replyTo: frame.id, ok: false, code, message: msgOf(err),
        ...(Number.isSafeInteger(err?.details?.expectedOffset) ? { expectedOffset: err.details.expectedOffset } : {}),
        ...(Number.isSafeInteger(err?.details?.actualOffset) ? { actualOffset: err.details.actualOffset } : {}),
      })
    }))
  }

  /**
   * 处理工作区共享请求（2026-10-17）。
   *
   * 支持三个 op，**全部是只读探测或生成命令**，不执行任何需要管理员的动作：
   *
   *   · `probe`        —— 当前是否管理员 + 哪些 dsh-work 共享已存在
   *   · `plan`         —— 生成共享命令 + 主机侧 net use 命令（只读/读写）
   *   · `unshare-plan` —— 生成卸载命令
   *
   * 为什么不执行：`New-SmbShare` 需要管理员，DSH 通常以普通用户跑。
   * Node 里提权失败的表现（静默失败 / 被安全软件拦 / 权限半生效）比让用户
   * 手动跑一条命令难排查得多。所以这里只"生成命令"，执行交给用户。
   */
  function handleShareReq(frame, d) {
    const op = typeof d.op === 'string' ? d.op : ''
    const reply = (payload) => send(NODE_TO_HUB.SHARE_RES, { replyTo: frame.id, ...payload })
    try {
      if (op === 'probe') {
        // 探测要查的目录：默认用 roots（这是本机的安全边界，共享也只该共享它们）
        const dirs = Array.isArray(d.dirs) && d.dirs.length > 0
          ? d.dirs.filter((x) => typeof x === 'string' && x !== '')
          : roots
        reply({ ok: true, result: probeShareState({ dirs }) })
        return
      }
      if (op === 'plan') {
        const dir = typeof d.dir === 'string' ? d.dir.trim() : ''
        if (dir === '') {
          reply({ ok: false, code: ERROR_CODE.INTERNAL, message: 'plan 需要 dir（要共享的目录）' })
          return
        }
        // 共享目录必须在 roots 内 —— 与 fs 工具同一条安全边界。
        // 用户可以在副机共享任意目录，但**通过插件**只能共享已授权的工作区。
        const resolved = resolveWorkspace(dir, { roots, caseInsensitive, defaultDir: roots[0] })
        const access = d.access === SHARE_ACCESS.WRITE ? SHARE_ACCESS.WRITE : SHARE_ACCESS.READ
        const { shareName, command } = buildShareCommand({ dir: resolved, access })
        reply({
          ok: true,
          result: {
            dir: resolved,
            access,
            shareName,
            shareCommand: command,
            // 主机侧映射命令：面板直接给用户复制
            mountCommand: buildMountCommand({ host: d.host || '', shareName, drive: d.drive || 'X:' }),
            admin: isAdmin(),
          },
        })
        return
      }
      if (op === 'unshare-plan') {
        const shareName = typeof d.shareName === 'string' ? d.shareName.trim() : ''
        if (shareName === '') {
          reply({ ok: false, code: ERROR_CODE.INTERNAL, message: 'unshare-plan 需要 shareName' })
          return
        }
        reply({
          ok: true,
          result: { shareName, unshareCommand: buildUnshareCommand(shareName), admin: isAdmin() },
        })
        return
      }
      reply({ ok: false, code: ERROR_CODE.INTERNAL, message: `unknown share op: ${op || '(empty)'}` })
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
      logger.warn('share op failed', { op, code, error: msgOf(err) })
      reply({ ok: false, code, message: msgOf(err) })
    }
  }

  /* 9) 事件接线 ------------------------------------------------------- */
  const listenerDisposers = []
  const on = (evt, fn) => {
    try {
      const d = transport.on(evt, fn)
      if (typeof d === 'function') listenerDisposers.push(d)
    } catch (err) {
      logger.warn('listener registration failed', { evt, error: msgOf(err) })
    }
  }

  on('online', (ack) => {
    logger.info('online', { nodeId, transportMode, relay: ack?.relay === true })
    // 任务状态真身在副机：重连后主动全量上报，hub 由此重建视图
    safeInvoke(() => engine.syncAll())
    // 仓库清单（提案 #13）：接入/重连后立刻报一次，不等 10min 周期
    safeInvoke(() => sendRepos())
  })
  on('offline', (reason) => logger.warn('offline', { nodeId, reason }))
  on('reconnecting', (info) => {
    // hello 是同一个对象引用，重连前把时间戳刷新，避免 hub 看到陈旧的 time
    safeInvoke(() => {
      transport.hello.time = Date.now()
    })
    logger.info('reconnecting', { nodeId, ...(isPlainObject(info) ? info : {}) })
  })
  on('error', (err) => {
    lastError = msgOf(err)
    // 底层错误码（ECONNREFUSED 等）对小白是天书。这里用**统一翻译层**
    // （lib/explain-error.js）给出"哪里没对 + 下一步做什么"；原始错误照记
    // （排查仍需要）。
    //
    // 2026-10-20 改：从 setup.js 的 friendlyConnectError 升级到 explain-error.js
    // —— 后者覆盖协议错误码（17 个）+ HTTP 状态 + 握手超时等，不只是 5 类网络错误。
    //
    // ⚠ 结构化保存：面板要显示"最后尝试时间 + 人话 + 原始错误"三件套，
    // 只存字符串的话面板只能原样打印。
    const explained = explainError(err, { isHub: false, context: '连接主机' })
    lastErrorDetail = {
      at: Date.now(),
      title: explained.title,
      detail: explained.detail,
      hint: explained.hint,
      raw: explained.raw,
      code: typeof err?.code === 'string' ? err.code : '',
    }
    logger.warn(`连接问题：${formatExplained(explained)}`, { nodeId, error: lastError })
  })
  // P2-11：hub 身份验证状态。'pending' 期间（relay 宽限窗口内）task/start 会被
  // 上面的 guard 拒绝；direct 模式在 welcome 时就已决出，宽限窗口实际只作用于
  // relay。重连会把状态重置回 'pending'（transport.connectOnce 负责）。
  let hubIdentity = 'pending'
  on('hubIdentity', (status) => {
    hubIdentity = status === 'ok' || status === 'absent' ? status : 'pending'
    if (status === 'ok') logger.info('hub identity verified and pinned')
    else if (status === 'absent') logger.warn('hub 未提供身份帧 —— 按旧版兼容模式继续（无 hub 身份认证），建议两端升级到同一版本')
  })
  // 提案 #1：E2E 会话状态。ok = 中继/链路上已看不见业务帧内容；
  // timeout = 对端（或中继路径上的旧中继）没完成握手，按明文继续；
  // reset = hub 丢了会话（重启），重新握手后把任务视图再补一遍。
  on('e2e', (status) => {
    if (status === 'ok') logger.info('E2E 加密已启用：任务内容与产物对中继不可见')
    else if (status === 'timeout') logger.warn('提示：hub 未在 5s 内完成 E2E 握手 —— 对端可能是旧版本，链路按明文继续（建议两端升级到同一版本）')
    else if (status === 'reset') {
      logger.warn('E2E 会话被 hub 重置（hub 可能重启过）—— 重新握手并补报任务状态')
      safeInvoke(() => engine.syncAll())
    }
  })
  on('frame', (frame) => {
    // 一帧失败只影响这一帧：这里绝不 rethrow
    try {
      dispatch(frame)
    } catch (err) {
      logger.warn('frame handler failed', { type: frame?.t, error: msgOf(err) })
    }
  })
  on('binary', (header) => logger.debug('unexpected inbound binary frame', { type: header?.t }))

  /* 10) 启动对账：上次进程留下的任务 -------------------------------- */
  // 进程重启后不可能还有任务在跑 —— 如实标成 interrupted，而不是永远挂着 running。
  // queued（已受理但没开跑）默认重排队，这是"任务在副机持久运行"的应有语义。
  const reconcile = { interrupted: 0, requeued: 0 }
  safeInvoke(() => {
    const requeue = []
    for (const rec of store.list()) {
      if (TERMINAL_STATUS.has(rec.status)) continue
      if (rec.status === TASK_STATUS.RUNNING) {
        store.update(rec.taskId, {
          status: TASK_STATUS.INTERRUPTED,
          endedAt: Date.now(),
          error: { code: 'node-restart', message: 'node process restarted while task was running' },
        })
        reconcile.interrupted += 1
      } else if (rec.status === TASK_STATUS.QUEUED && cfg.resumeQueued !== false) {
        requeue.push(rec.taskId)
      }
    }
    for (const taskId of requeue) {
      safeInvoke(() => engine.enqueue(taskId))
      reconcile.requeued += 1
    }
  })
  if (reconcile.interrupted > 0 || reconcile.requeued > 0) {
    logger.info('startup reconcile', { ...reconcile, stateDir })
  }

  /* 11) 可选服务：有就接，没有就静默跳过 ---------------------------- */
  const optionalDisposers = []

  function statusSnapshot() {
    const tasks = store.list()
    const byStatus = {}
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    return {
      nodeId,
      protocol: PROTOCOL_VERSION,
      online: transport.online === true,
      transportMode,
      transportStarted,
      url: redactUrl(url),
      stateDir,
      roots,
      runner: runner.kind,
      profile,
      dshVersion,
      agentMode: hello.agentMode === true,
      caps: [...CAPS, 'file-transfer', 'selfcheck', ...(process.platform === 'win32' ? ['desktop', 'gui'] : [])],
      tasks: {
        total: tasks.length,
        byStatus,
        active: tasks.filter((t) => !TERMINAL_STATUS.has(t.status)).length,
        running: engine.running.size,
        queued: engine.queue.length,
      },
      reconcile,
      lastError: lastError || null,
      // 结构化的人话错误（面板据此显示"最后尝试 + 原因 + 下一步"）。
      // 旧版副机没有这个字段 → 面板按 null 处理，退回只显示 lastError。
      lastErrorDetail: lastErrorDetail || null,
      updatedAt: Date.now(),
    }
  }

  safeInvoke(() => {
    const webServer = getService(ctx, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    const handler = (req, res) => {
      try {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405
          res.end()
          return
        }
        const body = JSON.stringify(statusSnapshot())
        res.statusCode = 200
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.setHeader?.('cache-control', 'no-store')
        res.end(method === 'HEAD' ? undefined : body)
      } catch (err) {
        safeInvoke(() => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: msgOf(err) }))
        })
      }
    }
    const d = webServer.register({ kind: 'exact', path: STATUS_PATH, handler })
    if (typeof d === 'function') optionalDisposers.push(d)
    logger.info('status route registered', { path: STATUS_PATH })
  })

  safeInvoke(() => {
    const systemPrompt = getService(ctx, 'systemPrompt')
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const d = systemPrompt.section({ name: `${PLUGIN_NAME}-worker`, order: 90, text: WORKER_PROMPT })
    if (typeof d === 'function') optionalDisposers.push(d)
  })

  /* 12) 拨入：唯一一处会碰网络的地方，且完全非阻塞 ------------------- */
  let transportStarted = false
  if (url === '') {
    // 没有配置地址就不去连：空 URL 只会变成无限退避重试的噪声，对副机毫无价值。
    // worker 仍然完整可用（引擎/产物服务/状态接口都在），等配置补上重启即可。
    lastError = lastError || 'no-url'
    logger.warn('no hub url configured; transport idle', { transportMode })
  } else {
    try {
      transport.start()
      transportStarted = true
    } catch (err) {
      lastError = msgOf(err)
      logger.error('transport start failed', { error: lastError })
    }
  }

  logger.info('worker ready', {
    nodeId,
    transportMode,
    url: redactUrl(url),
    runner: runner.kind,
    roots,
    stateDir,
    transportStarted,
  })

  /* 13) 清理 --------------------------------------------------------- */
  function teardown() {
    // 顺序有意为之：先断连接（不再产生新帧），再停任务，最后停产物。
    if (resourceTimer) clearInterval(resourceTimer)
    if (reposTimer) clearInterval(reposTimer)
    for (const d of listenerDisposers.splice(0).reverse()) safeInvoke(d)
    safeInvoke(() => transport.stop())

    // E5-1 修复：先**清空队列**，再取消在跑的任务。
    //
    // 此前只取消 engine.running，队列完全不碰，而 execute() 的 finally 会无条件
    // `setTimeout(() => this.pump(), 0)` —— 于是一个在跑任务被取消后，pump() 会继续
    // 把队列里的任务一个个启动。实测卸载后仍启动了 2 个排队任务。
    //
    // 关键区分：**保留 queued 落盘记录 ≠ 保留执行**。
    // 原注释「保持 queued 落盘，等下次启动重排或 hub 重派」说的是**记录**要留
    // （这样下次启动 reconcile 能重排、hub 也能重派），这一点不变 ——
    // 这里只清空内存队列并阻止后续 pump，磁盘上的 queued 记录原样保留。
    safeInvoke(() => engine.stop())
    safeInvoke(() => {
      for (const taskId of [...engine.running.keys()]) swallow(engine.cancel(taskId))
    })
    safeInvoke(() => artifacts.cancelAll())
    safeInvoke(() => runner.killAll?.())
    safeInvoke(() => swallow(runner.disposeAll?.()))
    disposeWorkerResources({ desktop, fileTransfer })
    // 最后把 task-store 批量窗口里没写盘的记录全部落盘。
    // 必须放在所有可能产生写人的组件停止**之后**：提前 flush 会被后续的
    // appendLog 重新标记脏，白刷。
    safeInvoke(() => store.close())
    for (const d of optionalDisposers.splice(0)) safeInvoke(d)
  }

  const dispose = makeDisposer(teardown)

  // 优先把清理挂到 ctx 生命周期上；ctx.effect 不可用也不影响返回值可被调用。
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => () => dispose(), WORKER_EFFECT_LABEL)
  } catch (err) {
    logger.warn('ctx.effect registration failed', { error: msgOf(err) })
  }

  return dispose
}
