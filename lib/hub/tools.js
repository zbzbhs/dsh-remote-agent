/**
 * 主机侧 remote_* 工具集（零外部依赖）。
 *
 * 设计原则：**主电脑只消费 handoff，不消费副机的原始日志。**
 * 工具的职责边界刻意切得很窄：
 *
 * 任务链路：
 *   remote_nodes    看有哪些副机在线（信息汇聚的入口）
 *   remote_task     派一条任务（幂等 taskId，立即返回，不阻塞等结果）
 *   remote_status   看一条任务现在到哪了（进度尾巴 + 日志尾巴）
 *   remote_handoff  取完整交接卡（决策所需的一切都在这一张卡里）
 *   remote_manifest 取产物清单（先看清单，再决定拉什么）
 *   remote_pull     显式拉取成品（只有 role:final 能过河）
 *   remote_cancel   打断一条任务
 *   remote_purge    清理 hub 侧任务视图（逃生舱）
 *
 * 远程文件（提案 #25，只读，走 fs/req↔fs/res 独立通道，不进任务队列）：
 *   remote_ls       列副机目录（分页）
 *   remote_read     读文件（文本按行分段 / 二进制只回元数据）
 *   remote_grep     副机本地全文搜索（纯 JS，不 spawn）
 *   remote_tree     目录树摘要（扫描在副机跑完只回结构）
 *
 * 所有 execute 都返回普通 JSON（output.schema 描述它），错误以
 * RemoteAgentError 抛出，由框架统一materialize 成错误结果。
 */
import os from 'node:os'
import path from 'node:path'
import {
  ERROR_CODE,
  PROTOCOL_VERSION,
  RemoteAgentError,
  TASK_MODE,
  TERMINAL_STATUS,
  newTaskId,
  validateTaskStart,
} from '../protocol.js'
// exec/agent 分开的默认超时（提案 #26-1）——与副机兜底**同源**，
// 避免"工具说 10 分钟、副机兜底 1 小时"的分裂。
import { AGENT_DEFAULT_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS } from '../node/task-engine.js'
// 视图投影共享层：与 UI 路由用**同一份**白名单（见 lib/hub/views.js 的说明）。
import { handoffView } from './views.js'

/**
 * 按 output.schema **删掉类型不匹配的 null**（可选字段）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要（实测踩到两次）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DSH 会对工具返回值跑 `validateJsonSchemaValue(outputSchema, value)`。null 是
 * 合法 JSON，但对声明为 `{ type: 'number' }` / `{ type: 'object' }` 的字段，
 * null **不是**该类型 → 报：
 *   `returned invalid output: "value.startedAt" must be a number`
 *   `returned invalid output: "value.error" must be an object`
 *
 * 我们的共享投影层（views.js 的 exitView / errorView / taskView）出于 UI 侧的
 * 需要会对"没有值"返回 null（UI 只是不渲染那一块）。但同一条投影也被工具复用，
 * 于是工具调用整个失败 —— 而**任务其实已经派出去了**（有副作用却报失败）。
 *
 * ── 策略 ────────────────────────────────────────────────────────────────
 * 只对**不在 required 里**的字段动手：值是 null 且 schema 说它不是 null 类型
 * → 删掉该字段（JSON 里"缺失"与"null"对消费方差别很小，而缺失一定合法）。
 *
 * 对 **required** 字段不删（删了会从"类型错"变成"缺字段错"，同样是失败）；
 * 那种情况属于实现 bug，应该在源头修（例如 taskView 已把时间字段改成 0）。
 *
 * @param {unknown} value 工具返回值
 * @param {object} [schema] output.schema（JSON Schema 子集）
 * @returns {unknown} 处理后的值
 */
function dropNullForSchema(value, schema) {
  if (value === null || typeof value !== 'object') return value
  if (!schema || typeof schema !== 'object') return value

  // ── 数组：逐元素套用 items 的 schema 递归 ──────────────────────────────
  //
  // ⚠ 这一段是 2026-10-16 补的。原实现遇到数组**直接 return**，于是
  // `nodes[0].resource = null` 原样出边界，DSH 报
  //
  //     tool "remote_nodes" returned invalid output:
  //     "value.nodes[0].resource" must be an object
  //
  // 现象是"工具存在并执行了，但返回值不合 schema" —— 而 schema 里
  // `resource` 只声明了 `type: 'object'`，靠"optional 的 null 会被剥掉"
  // 这个约定来容错。**约定只有在递归到那一层时才生效。**
  if (Array.isArray(value)) {
    const itemSchema = schema.items && typeof schema.items === 'object' ? schema.items : null
    if (!itemSchema) return value
    return value.map((v) => dropNullForSchema(v, itemSchema))
  }

  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null
  if (!props) return value
  const required = Array.isArray(schema.required) ? schema.required : []
  const out = { ...value }
  for (const [key, sub] of Object.entries(props)) {
    if (out[key] === null) {
      if (required.includes(key)) continue // required 的 null 要在源头修，这里不掩盖
      const t = sub && typeof sub === 'object' ? sub.type : undefined
      // schema 允许 null（type 数组含 'null'，或显式 nullable）时保留
      const allowsNull = t === 'null' || (Array.isArray(t) && t.includes('null')) || (sub && sub.nullable === true)
      if (!allowsNull) delete out[key]
      continue
    }
    // ── 非 null 的子值：递归下去 ─────────────────────────────────────────
    //
    // 只处理对象/数组（标量没什么可剥的）。这一层同样不能省：
    // `nodes[].resource = { cpuPct: null, ... }` 里的 null 也要剥，
    // 否则 `"value.nodes[0].resource.cpuPct" must be a number`。
    const subValue = out[key]
    if (subValue !== null && typeof subValue === 'object' && sub && typeof sub === 'object') {
      const next = dropNullForSchema(subValue, sub)
      if (next !== subValue) out[key] = next
    }
  }
  return out
}

/**
 * 把工具返回值净化成 **DSH 认可的纯 JSON 值**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层（实测踩到，代价很大）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DSH 在工具返回值出边界时会跑 `walkJsonValue(value, true)`（见 asar 里的
 * `snapshotJsonValue`）。它返回 `undefined` 的条件是：
 *
 *   - `typeof value !== 'object'` 且不是 null/boolean/string/number
 *     → **undefined / 函数 / Symbol 全部被拒**
 *   - 数字 `!Number.isFinite(v) || Object.is(v, -0)`  → **NaN / Infinity / -0 被拒**
 *   - 原型不是 `Object.prototype` 也不是 `null`  → **类实例被拒**
 *   - 循环引用
 *   - 数组原型不对，或数组上挂了额外属性
 *
 * 一旦被拒，工具调用报 `returned invalid output: value is not lossless JSON`。
 * **此时工具其实已经执行成功**（任务派出去了、文件拉回来了），但调用方只看到
 * 一个序列化错误 —— 既拿不到结果，也无法判断副作用是否发生。这是最坏的一类
 * 失败：**有副作用却报失败**。
 *
 * 我们踩到的具体形态：副机回传的 `accepted` 对象带类原型，直接塞进返回值就被拒。
 *
 * ── 策略 ────────────────────────────────────────────────────────────────
 * 用一次 JSON 往返把值变成纯数据（`JSON.parse(JSON.stringify(v))`）：
 *   - 类实例 → 纯对象（原型丢失，但我们只读它的可枚举数据字段）
 *   - undefined 属性 → 被 JSON.stringify 丢掉（正是我们要的）
 *   - NaN / Infinity → **会被 stringify 变成 null**，所以先手动扫一遍转成 0
 *   - 循环引用 → stringify 抛错，被 catch 兜住
 *
 * 注意：这里**不**做字段级白名单（那是 views.js 的职责）。本函数只管
 * "能不能安全出边界"这一件事，让每个工具不必各自记得处理。
 *
 * @param {unknown} v 任意工具返回值
 * @returns {unknown} 纯 JSON 值；无法净化时返回一个最小安全对象
 */
function toPlainJson(v) {
  try {
    // 先把 NaN / Infinity / -0 归一（JSON.stringify 会把它们变成 null，
    // 而 null 对 schema 声明为 number 的字段又是违规的 → 用 0 更安全）
    const norm = (x, seen) => {
      // ⚠ null 必须**原样保留**：DSH 的 walkJsonValue 明确接受 null
      // （`if (current === null) { assign(...); continue }`）。
      // 早先这里写的是 `if (x === null || x === undefined) return undefined`，
      // 把 null 一起吞了 —— 会让「值为 null 的字段」静默消失。已由
      // test/tool-output-plain.test.js 的「null 保持 null」用例锁住。
      if (x === null) return null
      if (x === undefined) return undefined
      const t = typeof x
      if (t === 'number') return Number.isFinite(x) && !Object.is(x, -0) ? x : 0
      if (t === 'string' || t === 'boolean') return x
      if (t === 'bigint') return String(x)
      if (t === 'function' || t === 'symbol') return undefined
      if (t !== 'object') return undefined
      if (seen.has(x)) return undefined
      seen.add(x)
      try {
        if (Array.isArray(x)) return x.map((item) => norm(item, seen)).filter((item) => item !== undefined)
        const out = {}
        for (const k of Object.keys(x)) {
          const val = norm(x[k], seen)
          if (val !== undefined) out[k] = val
        }
        return out
      } finally {
        seen.delete(x)
      }
    }
    return norm(v, new Set())
  } catch {
    return {}
  }
}

/** 渲染文本上限：工具结果进模型上下文，别把整份清单灌进去。 */
const RENDER_LIMIT = 6000

function text(value) {
  let s
  if (typeof value === 'string') s = value
  else {
    try {
      s = JSON.stringify(value, null, 2)
    } catch {
      s = undefined
    }
  }
  // JSON.stringify(undefined) / 循环引用都返回 undefined：展示层退化成占位文本。
  if (typeof s !== 'string') return '(no value)'
  return s.length > RENDER_LIMIT ? `${s.slice(0, RENDER_LIMIT)}\n… (truncated)` : s
}

/**
 * 包一层 render。
 *
 * render 是"展示层"，它绝不该把一次成功的工具调用变成失败：值形状意外
 * （例如被裁剪、被旧版投影喂进来）时退回 JSON 文本，而不是抛出去。
 */
function renderText(fn) {
  return (args, value) => {
    try {
      const out = fn(args, value)
      return [{ type: 'text', text: typeof out === 'string' ? text(out) : text(out ?? value) }]
    } catch {
      return [{ type: 'text', text: text(value) }]
    }
  }
}

/**
 * 把工具声明补齐成 DSH 要求的 `output: { schema, render }`。
 *
 * DSH 的 `tools.register()` 会在注册期校验：
 *   `output === undefined || typeof output !== 'object'
 *    || typeof output.render !== 'function'` → TypeError
 * 一旦某个工具声明不合法，**整个插件条目不激活**（0.10.0 的真实事故：
 * `tool "remote_write" must declare output { schema, render, presentationMeta? }`）。
 *
 * 两种历史写法都要兼容：
 *   · `output: { schema: {...} }`  —— 缺 render
 *   · `output: { type: 'object', ... }` —— 裸 JSON Schema，既缺 schema 包装层也缺 render
 */
export function withOutputContract(definition) {
  if (definition === null || typeof definition !== 'object') return definition
  const raw = definition.output
  let schema
  if (raw !== null && typeof raw === 'object' && raw.schema !== undefined) {
    schema = raw.schema
  } else if (raw !== null && typeof raw === 'object') {
    schema = raw
  } else {
    schema = { type: 'object' }
  }
  const hasRender = raw !== null && typeof raw === 'object' && typeof raw.render === 'function'
  const render = hasRender
    ? raw.render
    : renderText((_args, value) => value)
  const presentationMeta = raw !== null && typeof raw === 'object' && typeof raw.presentationMeta === 'function'
    ? raw.presentationMeta
    : undefined
  return {
    ...definition,
    output: presentationMeta === undefined ? { schema, render } : { schema, render, presentationMeta },
  }
}

/** 安全的数组读取：值缺失时给空数组，而不是 undefined.length。 */
function arr(v) {
  return Array.isArray(v) ? v : []
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}

/** 从任务视图挑出可 pull 的成品路径。 */
export function finalPaths(task) {
  const fromManifest = task?.manifest?.final
  if (Array.isArray(fromManifest)) return fromManifest.map((i) => i.path)
  const fromHandoff = task?.handoff?.artifacts?.final
  if (Array.isArray(fromHandoff)) return fromHandoff.map((i) => i.path)
  return []
}

export function buildManifestView(task) {
  const m = task?.manifest ?? null
  const a = task?.handoff?.artifacts ?? null
  const counts = m?.counts ?? a?.counts ?? null
  const bytesFinal = num(m?.bytesFinal) ?? num(a?.bytesFinal) ?? 0
  const finalList = Array.isArray(m?.final) ? m.final : Array.isArray(a?.final) ? a.final : []
  // ⚠ 声明为 string 的字段一律不能返回 null（DSH 会报 value is not lossless JSON）。
  const str = (x) => (typeof x === 'string' ? x : '')
  return {
    taskId: str(task?.taskId),
    status: str(task?.status) || 'unknown',
    // counts 在 schema 里是 object，null 同样会触发序列化错误 → 用空对象兜底
    counts: counts && typeof counts === 'object' ? counts : {},
    bytesFinal,
    final: finalList.map((i) => ({
      path: str(i.path),
      kind: str(i.kind) || 'file',
      bytes: num(i.bytes) ?? 0,
      sha256: str(i.sha256),
    })),
    intermediateCount: num(m?.intermediateCount) ?? num(a?.intermediateCount) ?? 0,
    note:
      (typeof m?.note === 'string' && m.note) ||
      (typeof a?.note === 'string' && a.note) ||
      (finalList.length === 0
        ? '还没有清单：任务未结束，或本次没有 role:final 产物。'
        : '只有 role:final 可以 pull；intermediate 仅上报元数据，留在副机。'),
  }
}

/** 从 handoff 生成一段人/模型都能直接读的摘要文本。 */
export function handoffSummaryText(task) {
  const h = task?.handoff
  if (!h) {
    return `任务 ${task?.taskId ?? '(unknown)'} 尚无交接卡（status=${task?.status ?? 'unknown'}）。`
  }
  const lines = []
  lines.push(`# 远程任务交接 ${h.taskId}`)
  lines.push('')
  lines.push(`- 节点：${h.nodeId}`)
  lines.push(`- 状态：${h.status}${h.exit?.timedOut ? '（超时）' : ''}`)
  lines.push(`- 模式：${h.mode}  运行器：${h.runner ?? 'unknown'}`)
  if (typeof h.durationMs === 'number') lines.push(`- 耗时：${Math.round(h.durationMs / 1000)}s`)
  lines.push(`- 工作区：${h.workspace}`)
  lines.push('')
  lines.push('## 摘要')
  lines.push('')
  lines.push(String(h.summary?.text ?? '(无摘要)'))
  const changed = Array.isArray(h.changed) ? h.changed : []
  if (changed.length > 0) {
    lines.push('')
    lines.push(`## 工作区变更（${changed.length} 条）`)
    lines.push('')
    for (const c of changed.slice(0, 40)) {
      lines.push(`- ${c.op} ${c.path}${typeof c.bytes === 'number' ? ` (${human(c.bytes)})` : ''}`)
    }
    if (changed.length > 40) lines.push(`- … 另有 ${changed.length - 40} 条`)
  }
  // 任务变更 diff 视图（提案 #21）：有 diff 就直接给文本，模型无需再拉文件。
  const diffs = Array.isArray(h.diffs) ? h.diffs : []
  if (diffs.length > 0) {
    lines.push('')
    lines.push(`## 变更 diff（${diffs.length} 个文件）`)
    for (const d of diffs) {
      lines.push('', `### ${d.path}${d.truncated ? '（截断）' : ''}`, '', '```diff', String(d.diff), '```')
    }
  }
  const artifacts = h.artifacts
  if (artifacts) {
    lines.push('')
    lines.push(`## 产物清单（final ${artifacts.counts?.final ?? 0} / intermediate ${artifacts.intermediateCount ?? 0}）`)
    lines.push('')
    for (const f of (artifacts.final ?? []).slice(0, 40)) {
      lines.push(`- ${f.path} — ${f.kind}, ${human(f.bytes)}, sha256=${String(f.sha256 ?? 'n/a').slice(0, 12)}…`)
    }
    lines.push('')
    lines.push(String(artifacts.note ?? ''))
    if (typeof h.pullHint === 'string') lines.push('', `拉取提示：${h.pullHint}`)
  }
  const logs = h.logs?.tail
  if (Array.isArray(logs) && logs.length > 0) {
    lines.push('')
    lines.push('## 日志尾巴')
    lines.push('')
    for (const l of logs.slice(-10)) lines.push(`> ${String(l).slice(0, 300)}`)
  }
  return lines.join('\n')
}

/**
 * 注册七个工具。
 * @returns {Array<() => void>} disposers
 */
export function registerRemoteTools({ ctx, registry, pulls, log: _log, defaults = {}, sessionGate = null }) {
  const disposers = []
  const explicitTimeoutMs = num(defaults.timeoutMs)

  /**
   * 注册一个工具，并给它的 `execute` **统一套上返回值净化**。
   *
   * 为什么在注册处收口而不是逐个工具处理：7 个工具的返回值形态各异
   * （有的直接 return 对象字面量，有的 return 别的模块的投影结果），
   * 逐个改容易漏。而 DSH 的 `walkJsonValue` 拒绝条件（类实例 / NaN /
   * Infinity / -0 / undefined / 循环引用）对所有工具是一样的，
   * 所以在唯一的注册入口包一层最省事、也最不容易漏。
   *
   * 见 `toPlainJson` 的说明：漏掉会导致「有副作用却报失败」——最坏的失败形态。
   */
  const reg = (definition) => {
    const original = definition?.execute
    const schema = definition?.output?.schema
    // ⚠ DSH 的工具契约是 `output: { schema, render, presentationMeta? }`，缺 `render`
    // 会在 ctx.tools.register 里抛 `must declare output { schema, render, ... }`，
    // 而且是在注册期抛 —— 一个工具声明不合法，整个插件条目不激活（0.10.0 事故）。
    // 收口在这里补齐：`schema` 缺包装层时按裸 JSON Schema 包上，`render` 缺省用
    // JSON 文本兜底（见 renderText：展示层永不把成功调用变成失败）。
    definition = withOutputContract(definition)
    if (typeof original === 'function') {
      definition = {
        ...definition,
        async execute(...args) {
          // 工具内再做一次执行门禁：某些 Host 没有 tools.guard 时，sessionGate
          // 仍必须 fail-closed，而不能退化成只显示一条提示词。
          const rejection = sessionGate?.guard?.({ name: definition.name, agent: args[1]?.agent })
          if (rejection) throw new Error(rejection)
          const value = await original.apply(this, args)
          // ① 先按 schema 把「类型不匹配的 null」删掉 —— 见 dropNullForSchema 的说明。
          // ② 再净化成纯 JSON 值（去类实例 / NaN / 循环引用等）。
          // 顺序不能反：净化会丢弃 undefined，而 ① 正是把 null 转成 undefined。
          return toPlainJson(dropNullForSchema(value, schema))
        },
      }
    }
    disposers.push(ctx.tools.register(definition))
  }

  // ── remote_selfcheck：派单前读取副机的真实就绪报告 ────────────────
  reg({
    name: 'remote_selfcheck',
    description: '让指定副机立即执行就绪自检。普通 exec/agent 只看运行后端、roots 与队列；GUI 任务另看交互桌面，桌面故障不会误伤无界面任务。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点 id；只有一台在线节点时可省略。' },
        purpose: { type: 'string', enum: ['agent', 'exec', 'gui'], description: '自检用途，默认 agent。' },
        refresh: { type: 'boolean', description: '保留兼容字段；当前每次都实时检查，不返回陈旧缓存。' },
      },
      required: [], additionalProperties: false,
    },
    output: { schema: { type: 'object' } },
    async execute(args) {
      const nodeId = resolveNodeId(registry, args?.node)
      const purpose = ['agent', 'exec', 'gui'].includes(args?.purpose) ? args.purpose : 'agent'
      return registry.fsRequest(nodeId, 'selfcheck', { purpose }, { timeoutMs: 30_000 })
    },
  })

  // ── remote_agents：同一个任务真相源上的后台子代理管理 ──────────────
  reg({
    name: 'remote_agents',
    description: '列出、查看或等待远程后台 Agent。taskId 与 remote_task/subagent provider 共用，不建立第二套任务状态。wait 只在终态后返回交接卡。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'wait'], description: '默认 list。' },
        taskId: { type: 'string', description: 'status/wait 必填。' },
        timeoutMs: { type: 'number', description: 'wait 的本次等待上限，默认 60000，最大 3600000。' },
      },
      required: [], additionalProperties: false,
    },
    output: { schema: { type: 'object' } },
    async execute(args) {
      const action = ['list', 'status', 'wait'].includes(args?.action) ? args.action : 'list'
      if (action === 'list') {
        const tasks = registry.listTasks().map((task) => registry.taskView(task))
        return { tasks, total: tasks.length }
      }
      const task = requireTask(registry, args?.taskId)
      if (action === 'wait' && !TERMINAL_STATUS.has(task.status)) {
        const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 60_000, 1), 3_600_000)
        await registry.awaitTerminal(task.taskId, { timeoutMs })
      }
      const current = requireTask(registry, task.taskId)
      return {
        task: registry.taskView(current),
        terminal: TERMINAL_STATUS.has(current.status),
        ...(current.handoff ? { handoff: handoffView(current.handoff) } : {}),
      }
    },
  })

  // ── remote_nodes ───────────────────────────────────────────────
  reg({
    name: 'remote_nodes',
    description:
      '列出所有已注册的远程副机节点（在线与离线都列出）。这是信息汇聚的入口：先看有哪些机器可用、各自的操作系统与允许的工作区根，再决定把任务派给谁。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                os: { type: 'string' },
                arch: { type: 'string' },
                hostname: { type: 'string' },
                online: { type: 'boolean' },
                roots: { type: 'array', items: { type: 'string' } },
                caps: { type: 'array', items: { type: 'string' } },
                agentMode: { type: 'boolean' },
                since: { type: 'number' },
                lastSeen: { type: 'number' },
                taskCount: { type: 'number' },
                repos: { type: 'array', items: { type: 'string' } },
                reposAt: { type: 'number' },
                // resource 内层字段可能为 null（首次采样无 CPU 基线等）——
                // 靠 stripNulls 按本 schema 剥掉 null 字段，这里只声明有值形态。
                resource: {
                  type: 'object',
                  properties: {
                    cpuPct: { type: 'number' },
                    load1: { type: 'number' },
                    memUsedMb: { type: 'number' },
                    memTotalMb: { type: 'number' },
                    at: { type: 'number' },
                  },
                },
                // 队列健康快照（提案 #26-3）：副机未上报（旧版本）时为 null，
                // 由 dropNullForSchema 剥掉。字段全部有值（0/false 兜底）。
                queue: {
                  type: 'object',
                  properties: {
                    queued: { type: 'number' },
                    running: { type: 'number' },
                    maxConcurrent: { type: 'number' },
                    oldestQueuedMs: { type: 'number' },
                    starved: { type: 'boolean' },
                  },
                },
                // 执行后端 + 默认模型（提案 #27）：副机未上报时为 null。
                runnerKind: { type: 'string' },
                defaultModel: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string' },
                    model: { type: 'string' },
                  },
                },
                // 可用模型清单（提案 #27 面板下拉的数据源）。
                // null = 副机未上报（旧版 / 探测未完成），由 dropNullForSchema
                // 剥掉；[] = 副机明确说"一个都没有"（保留，语义不同）。
                models: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      provider: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' },
                    },
                    required: ['id'],
                  },
                },
              },
              required: ['nodeId', 'online'],
            },
          },
          protocol: { type: 'number' },
        },
        required: ['nodes'],
      },
      render: renderText((_args, value) => {
        const nodes = arr(value?.nodes)
        if (nodes.length === 0) return '当前没有任何远程节点接入。'
        const lines = [`远程节点（${nodes.filter((n) => n.online).length}/${nodes.length} 在线）：`, '']
        for (const n of nodes) {
          lines.push(
            `- ${n.nodeId} [${n.online ? 'online' : 'offline'}] ${n.os}/${n.arch} host=${n.hostname} agentMode=${n.agentMode} tasks=${n.taskCount}`,
          )
          if (n.roots?.length) lines.push(`  roots: ${n.roots.join(', ')}`)
          if (n.caps?.length) lines.push(`  caps: ${n.caps.join(', ')}`)
          if (Array.isArray(n.repos) && n.repos.length > 0) lines.push(`  repos: ${n.repos.join(', ')}（remote_task 可用 repo:"名字" 按仓库路由）`)
          if (n.resource) {
            lines.push(`  资源: CPU ${n.resource.cpuPct ?? '—'}% · 内存 ${n.resource.memUsedMb ?? '—'}/${n.resource.memTotalMb ?? '—'}MB · load1 ${n.resource.load1 ?? '—'}`)
          }
          // 队列健康（提案 #26-3）：starved 是"该去副机看看卡在哪"的强信号
          if (n.queue) {
            if (n.queue.starved === true) {
              const waited = Math.round((n.queue.oldestQueuedMs ?? 0) / 60000)
              lines.push(`  ⚠ 队列疑似堵死：${n.queue.running}/${n.queue.maxConcurrent} 并发占满，${n.queue.queued} 条排队，最久已等 ${waited >= 1 ? `${waited} 分钟` : `${n.queue.oldestQueuedMs}ms`}。用 remote_status 逐条查 running 任务，必要时 remote_cancel。`)
            } else if ((n.queue.queued ?? 0) > 0) {
              lines.push(`  队列: ${n.queue.running}/${n.queue.maxConcurrent} 在跑，${n.queue.queued} 条排队`)
            }
          }
          // 后端与默认模型（提案 #27）：派模型单前先看这台副机有什么
          const bits = []
          if (n.runnerKind) bits.push(`后端 ${n.runnerKind}`)
          if (n.defaultModel?.model) bits.push(`默认模型 ${n.defaultModel.provider ? `${n.defaultModel.provider}/` : ''}${n.defaultModel.model}`)
          if (bits.length > 0) lines.push(`  ${bits.join(' · ')}`)
        }
        return lines.join('\n')
      }),
    },
    async execute() {
      return { protocol: PROTOCOL_VERSION, nodes: registry.list() }
    },
  })

  // ── remote_task ────────────────────────────────────────────────
  reg({
    name: 'remote_task',
    description:
      '把一条任务派给远程副机执行。副机在自己的机器上本地跑（默认起一个独立 agent 会话，mode=exec 则直接跑一段命令），任务在副机持久运行、断连不终止。本工具只等到副机"接受任务"就返回，不等结果；之后用 remote_status / remote_handoff 跟进。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '目标节点 id（或主机名）。省略时自动选：多节点按在跑任务数/CPU/内存自动路由（agent 模式只选支持 agent 的节点）。' },
        repo: { type: 'string', description: '按仓库路由（提案 #13）：传仓库名、远端 url 片段或本机路径片段，任务派给持有该仓库的节点（多个时按负载自动选）。省略 workspace 时自动用仓库在本机的路径。node 显式指定时 repo 不改路由、只兜 workspace。' },
        dryRun: { type: 'boolean', description: '只做派发预览（提案 #23）：走与真实派发完全相同的路由与校验，返回"会派到哪个节点、哪个工作区、什么模式"，不落库不派发。确认无误后去掉本参数正式派。' },
        precheck: { type: 'boolean', description: '派发前刷新副机自检。默认对声明 selfcheck 能力的新节点开启；旧节点自动跳过。false 可显式跳过。' },
        goal: { type: 'string', description: '任务目标。mode=agent 时是给副机 agent 的任务书；mode=exec 时是要执行的命令。' },
        workspace: { type: 'string', description: '副机上的绝对工作区路径，必须落在该节点允许的 roots 之内。省略则用节点默认工作区。' },
        mode: { type: 'string', enum: ['agent', 'exec'], description: 'agent=副机起独立 agent 会话（默认）；exec=直接执行命令。' },
        approval: { type: 'string', enum: ['auto', 'manual'], description: '两阶段审批（提案 #2）：manual=hub 挂起，等面板批准后才派给副机，超时自动拒绝（fail-closed）；auto=立即派发。省略时 exec 默认 manual、agent 默认 auto。' },
        model: {
          type: 'object',
          description:
            '副机执行本任务时使用的模型（可选，仅 mode=agent 生效）。只传**选择**、不传凭证 —— 副机用自己的 provider 配置跑；'
            + '指定的 provider/model 在副机不存在时任务会以明确错误失败。字段全部可选，缺的借副机默认补齐。'
            + '注意：headless 后端不支持指定模型，会以 modelUnsupported 失败。',
          properties: {
            provider: { type: 'string', description: 'provider 名（如 openai / deepseek）。省略则用副机默认 provider。' },
            model: { type: 'string', description: '模型名（如 gpt-4o / deepseek-chat）。' },
            reasoningEffort: { type: 'string', description: '推理力度（provider 支持时生效）。' },
          },
          additionalProperties: false,
        },
        outputs: { type: 'array', items: { type: 'string' }, description: '期望产出物的 glob（相对工作区），用于产物清单筛选。' },
        timeoutMs: { type: 'number', description: `副机侧任务超时（毫秒）。缺省按模式：exec ${EXEC_DEFAULT_TIMEOUT_MS / 60000} 分钟、agent ${AGENT_DEFAULT_TIMEOUT_MS / 60000} 分钟。` },
        denyPaths: { type: 'array', items: { type: 'string' }, description: '副机侧额外禁止访问的路径（绝对路径）。' },
        artifactRules: {
          type: 'object',
          description:
            '覆盖内置的产物角色判定。final=强制判为成品（可 pull）；intermediate=强制判为中间产物（不过河）。'
            + '用于内置表不适配的仓库，例如把 build/ 当源码目录时传 { intermediate: ["build/**"] }。',
          properties: {
            final: { type: 'array', items: { type: 'string' }, description: 'glob 列表，命中即判为 role:final。' },
            intermediate: { type: 'array', items: { type: 'string' }, description: 'glob 列表，命中即判为 role:intermediate（优先于 final）。' },
          },
          additionalProperties: false,
        },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          node: { type: 'string' },
          accepted: { type: 'boolean' },
          workspace: { type: 'string' },
          runner: { type: 'string' },
          status: { type: 'string' },
          duplicate: { type: 'boolean' },
          // dry-run（提案 #23）与审批（提案 #2）扩展字段
          dryRun: { type: 'boolean' },
          mode: { type: 'string' },
          approval: { type: 'string' },
          repo: { type: 'string' },
          // 模型回显（提案 #27）：dryRun 返回解析后的选择与来源；
          // 正式派发路径不填（模型生效情况看 handoff）。
          model: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
          },
          modelSource: { type: 'string' },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
          hint: { type: 'string' },
        },
        required: ['taskId', 'node', 'accepted'],
      },
      render: renderText((_args, value) => {
        if (!value) return 'remote_task: 无返回'
        if (value.dryRun === true) {
          const modelLine = value.model?.model
            ? `model: ${value.model.provider ? `${value.model.provider}/` : ''}${value.model.model}（${value.modelSource ?? ''}）`
            : 'model: 未指定'
          return [
            '[dry-run 预览] 未派发、未落库 —— 确认无误后去掉 dryRun 正式派发',
            `node: ${value.node}${value.repo ? `（repo 命中：${value.repo}）` : ''}`,
            `mode: ${value.mode ?? 'agent'}${value.approval === 'manual' ? '（将挂起等待审批）' : ''}`,
            modelLine,
            `workspace: ${value.workspace ?? '(节点默认)'}`,
            value.hint ?? '',
          ].filter((l) => l !== '').join('\n')
        }
        if (value.status === 'pending_approval') {
          return [
            `已创建 ${value.taskId} → ${value.node}（等待审批，副机尚未收到）`,
            `workspace: ${value.workspace ?? '(节点默认)'}`,
            value.hint ?? '',
          ].filter((l) => l !== '').join('\n')
        }
        const head = value.accepted
          ? `已派单 ${value.taskId} → ${value.node}（status=${value.status}）`
          : `派单未被接受 ${value.taskId} → ${value.node}：${value.error?.code ?? 'unknown'} ${value.error?.message ?? ''}`
        return [head, `workspace: ${value.workspace ?? '(节点默认)'}`, `runner: ${value.runner ?? '(未知)'}`, value.hint ?? '']
          .filter((l) => l !== '')
          .join('\n')
      }),
    },
    async execute(args, exec) {
      const routeMode = args?.mode === 'exec' ? 'exec' : 'agent'
      // 提案 #13：repo 参数路由 —— 在持有该仓库的在线节点里做负载感知自动选。
      // node 显式给出时 repo 不改路由（用户点名了机器就是点名了），只在
      // workspace 省略时借该节点上的仓库路径兜底。
      const repoSel = typeof args?.repo === 'string' ? args.repo.trim() : ''
      const explicitNode = typeof args?.node === 'string' && args.node.trim() !== ''
      let nodeId
      let repoHit = null
      if (repoSel !== '' && !explicitNode) {
        const hit = registry.pickNodeByRepo(repoSel, { mode: routeMode })
        if (!hit) {
          const known = registry.knownRepoNames()
          throw new RemoteAgentError(
            `没有在线节点持有仓库 "${repoSel}"`
              + (known.length > 0
                ? `；当前已上报的仓库：${known.slice(0, 20).join('、')}`
                : '；尚无节点上报仓库清单（副机需升级到支持仓库上报的版本，接入后约 10s 内上报）'),
            ERROR_CODE.INTERNAL,
          )
        }
        nodeId = hit.nodeId
        repoHit = hit.repo
      } else {
        // 提案 #14：mode 传入自动路由——agent 模式只选支持 agent 后端的节点
        nodeId = resolveNodeId(registry, args?.node, { mode: routeMode })
        if (repoSel !== '') repoHit = registry.findRepoOn(nodeId, repoSel)
      }
      const taskId = newTaskId()
      const hasWorkspace = typeof args?.workspace === 'string' && args.workspace.trim() !== ''
      const v = validateTaskStart({
        taskId,
        goal: String(args?.goal ?? ''),
        workspace: hasWorkspace ? args.workspace : repoHit?.path,
        mode: args?.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT,
        // 两阶段审批（提案 #2）：缺省语义在 validateTaskStart 里（exec→manual、
        // agent→auto），这里只透传显式选择。
        approval: args?.approval,
        // 模型选择：协议层 normalizeModelSelection 会把字符串/对象归一、
        // 丢掉类型不对的输入（见该函数说明）。exec 模式忽略之。
        model: args?.model,
        outputs: args?.outputs,
        // artifactRules 从工具参数透传到任务规格（F3-1 修复：此前该字段
        // 只有消费者没有生产者，用户无法覆盖内置的产物角色判定）
        artifactRules: args?.artifactRules,
        constraints: {
          // 提案 #26-1：缺省按模式分开（exec 10min / agent 1h），与副机兜底
          // 同源常量；defaults.timeoutMs（配置显式指定）优先于一切缺省。
          //
          // ⚠ 这里**必须用 `routeMode`，不能用 `v.spec.mode`**（2026-10-17 修）。
          //
          // 原实现写的是 `v.spec.mode`，而 `v` 正是这一行所属的
          // `const v = validateTaskStart({...})` 的初始化目标 —— 参数对象字面量
          // 在 `v` 初始化期间引用 `v` 自身，进入 TDZ（临时死区）：
          //
          //     const v = validateTaskStart({ constraints: {
          //       timeoutMs: ... ?? (v.spec.mode === 'exec' ? ... : ...)
          //                              ^ Cannot access 'v' before initialization
          //
          // 当 `??` 链左侧全空（args.timeoutMs 未传 且 explicitTimeoutMs 为
          // undefined）时抛 ReferenceError。
          //
          // 为什么 829 个测试全绿仍带此 bug：e2e helper 恒传 timeoutMs（`??`
          // 第一项短路）、单测构造时 defaults 也总有值 —— TDZ 分支从未被测到。
          //
          // 为什么生产没炸但更糟：`normalizeConfig` 用
          // `numOr(defaults.timeoutMs, 60*60*1000)` 兜底，使 explicitTimeoutMs
          // 恒为 3600000 → TDZ 永不触发，但 #26-1 的「args > 显式配置 >
          // 分模式默认」被压扁成「恒 1h」：exec 的 10min 默认成为死代码，
          // 一条失控命令比承诺的多跑 50 分钟才被杀。
          //
          // `routeMode`（L614）与 `v.spec.mode` 同义（都是 'exec' | 'agent'），
          // 且已在 `v` 之前求值 —— 用它彻底消除自引用。
          timeoutMs: num(args?.timeoutMs) ?? explicitTimeoutMs
            ?? (routeMode === TASK_MODE.EXEC ? EXEC_DEFAULT_TIMEOUT_MS : AGENT_DEFAULT_TIMEOUT_MS),
          denyPaths: Array.isArray(args?.denyPaths) ? args.denyPaths : [],
        },
        origin: 'hub',
      })
      if (!v.ok) throw new RemoteAgentError(`invalid task: ${v.error}`, ERROR_CODE.INTERNAL)

      // 提案 #27：模型选择的派发前校验。headless 后端不支持指定模型 ——
      // 旧链路要等任务跑到副机才失败（浪费一轮往返 + 烧一个 taskId），
      // 现在派发前就拦。runnerKind 是副机随资源帧自述的（#27），旧副机
      // 未上报时为 null → 不拦，保留副机侧兜底报错（向后兼容）。
      const recForModel = registry.getNode(nodeId)
      if (v.spec.mode === TASK_MODE.AGENT && v.spec.model && recForModel?.runnerKind === 'headless') {
        throw new RemoteAgentError(
          `节点 ${nodeId} 是 headless 后端，不支持指定模型（副机固定用默认模型）。去掉 model 参数重试，或让副机以 in-process 后端接入。`,
          ERROR_CODE.INTERNAL,
        )
      }

      const str = (x) => (typeof x === 'string' ? x : '')
      // 提案 #23：dry-run —— 只算"会怎么派"，不落库不派帧、不烧 taskId。
      // 路由与校验和真实派发走同一条代码路径（同一处 repo 解析、同一个
      // validateTaskStart）：预览说"可以"就真的可以派，预览报错就是真会报错。
      if (args?.dryRun === true) {
        // workspace 省略时副机会用 defaultWorkspace（= hello.roots[0]，见
        // node/index.js）—— 预览必须镜像同一回填，否则预览和实派不一致。
        const rec0 = registry.getNode(nodeId)
        // 提案 #27：回显解析后的模型与来源 —— "派之前就知道用什么模型"，
        // 而不是派完看 handoff。用户指定优先；否则借副机默认（若已上报）。
        const selModel = v.spec.model
          ? { provider: str(v.spec.model.provider), model: str(v.spec.model.model) }
          : (rec0?.defaultModel && typeof rec0.defaultModel === 'object' ? { provider: str(rec0.defaultModel.provider), model: str(rec0.defaultModel.model) } : null)
        const modelSource = v.spec.model
          ? '用户指定'
          : (rec0?.defaultModel ? '副机默认（用户未指定）' : '未指定（副机未上报默认模型）')
        return {
          taskId: '',
          node: nodeId,
          accepted: false,
          dryRun: true,
          mode: v.spec.mode,
          approval: v.spec.approval,
          workspace: str(v.spec.workspace) || str(rec0?.hello?.roots?.[0]),
          repo: str(repoHit?.name),
          ...(selModel ? { model: selModel } : {}),
          modelSource: str(modelSource),
          hint: '预览即真实（与正式派发同一套路由+校验）；确认无误后去掉 dryRun 正式派发。',
        }
      }

      // 新版节点的 fresh gate：真实读写 roots + runner/capability 检查。
      // 旧节点没有 selfcheck 能力时跳过，升级不误伤既有部署。
      const recForCheck = registry.getNode(nodeId)
      if (args?.precheck !== false && (recForCheck?.hello?.caps ?? recForCheck?.caps)?.includes?.('selfcheck')) {
        const report = await registry.fsRequest(nodeId, 'selfcheck', { purpose: v.spec.mode }, { timeoutMs: 30_000 })
        if (report?.verdict === 'blocked') {
          const ids = Array.isArray(report.blockingFailures) ? report.blockingFailures.map((x) => x.id).filter(Boolean).join(', ') : 'unknown'
          throw new RemoteAgentError(`副机自检未通过（${ids}）；先运行 remote_selfcheck 查看修复建议`, ERROR_CODE.INTERNAL)
        }
      }

      registry.createTask({ nodeId, spec: v.spec })

      // 两阶段审批（提案 #2）：manual 任务挂起在 hub 等面板批准 —— 不等
      // awaitAccepted（副机此刻根本没收到）。立即返回挂起回执，调用方用
      // remote_status 跟进；批准/拒绝都在面板完成。
      if (v.spec.approval === 'manual') {
        const rec0 = registry.getNode(nodeId)
        return {
          taskId,
          node: nodeId,
          accepted: false,
          status: 'pending_approval',
          mode: v.spec.mode,
          approval: 'manual',
          workspace: str(v.spec.workspace) || str(rec0?.hello?.roots?.[0]),
          hint: '任务已挂起等待审批（面板「远程同事」→ 待审批卡）。批准后副机才会收到；超时未批会自动拒绝。',
        }
      }

      const accepted = await registry.awaitAccepted(taskId, { signal: exec?.signal })
      const rec = registry.getNode(nodeId)
      // ⚠ 返回值每个字段都必须与 output.schema 的类型**严格一致**。
      //
      // 早先这里是 `accepted.workspace ?? rec?.hello?.roots?.[0] ?? null`，而 schema
      // 声明 `workspace: { type: 'string' }` —— 返回 null 时 DSH 直接报
      // `value is not lossless JSON`。**任务其实已成功派出**，但调用方只看到序列化
      // 错误，无从判断任务到底派没派出去（实测踩到，还误以为工具坏了）。
      // 所以一律用空字符串兜底；`error` 只在存在时才给。
      return {
        taskId,
        node: nodeId,
        accepted: accepted.accepted === true,
        workspace: str(accepted.workspace) || str(rec?.hello?.roots?.[0]),
        runner: str(accepted.runner),
        status: str(accepted.status),
        duplicate: accepted.duplicate === true,
        ...(accepted.error && typeof accepted.error === 'object'
          ? { error: { code: str(accepted.error.code), message: str(accepted.error.message) } }
          : {}),
        hint:
          accepted.accepted === true
            ? '用 remote_status 跟进进度；结束后用 remote_handoff 取交接卡。'
            : '副机未接受这条任务，检查 workspace 是否在节点允许的 roots 内。',
      }
    },
  })

  // ── remote_status ──────────────────────────────────────────────
  reg({
    name: 'remote_status',
    description: '查询一条远程任务的当前视图：状态、进度尾巴、日志尾巴、退出码、工作区变更、摘要。任务状态的真身在副机，这里读的是 hub 侧投影（断连不会丢，重连后由副机 task/sync 重建）。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          nodeId: { type: 'string' },
          nodeOnline: { type: 'boolean' },
          status: { type: 'string' },
          mode: { type: 'string' },
          goal: { type: 'string' },
          workspace: { type: 'string' },
          accepted: { type: 'boolean' },
          createdAt: { type: 'number' },
          updatedAt: { type: 'number' },
          startedAt: { type: 'number' },
          endedAt: { type: 'number' },
          durationMs: { type: 'number' },
          exit: { type: 'object' },
          changed: { type: 'array', items: { type: 'object' } },
          summary: { type: 'object' },
          error: { type: 'object' },
          manifestCounts: { type: 'object' },
          progressTail: { type: 'array', items: { type: 'object' } },
          logTail: { type: 'array', items: { type: 'string' } },
          handoffAvailable: { type: 'boolean' },
        },
        required: ['taskId', 'status'],
      },
      render: renderText((_args, value) => {
        const lines = [
          `任务 ${value.taskId} @ ${value.nodeId} [${value.status}]${value.nodeOnline ? '' : ' (节点离线)'}`,
          `mode=${value.mode ?? '?'} accepted=${value.accepted} 耗时=${value.durationMs ?? '?'}ms`,
          `goal: ${String(value.goal ?? '').slice(0, 400)}`,
        ]
        if (value.error) lines.push(`error: ${value.error.code}: ${value.error.message}`)
        if (value.exit) lines.push(`exit: code=${value.exit.code} timedOut=${value.exit.timedOut}`)
        const progress = arr(value.progressTail)
        if (progress.length) {
          lines.push('', '进度尾巴：')
          for (const p of progress.slice(-10)) lines.push(`- ${p.phase}${p.detail ? `: ${String(p.detail).slice(0, 200)}` : ''}`)
        }
        const logs = arr(value.logTail)
        if (logs.length) {
          lines.push('', '日志尾巴：')
          for (const l of logs.slice(-15)) lines.push(`> ${String(l).slice(0, 300)}`)
        }
        if (value.handoffAvailable) lines.push('', '交接卡已就绪：用 remote_handoff 取完整卡片。')
        return lines.join('\n')
      }),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      const v = registry.taskView(t)
      // ⚠ 共享投影（views.js 的 exitView / errorView）对"没有值"的输入返回 null，
      // 而本工具的 schema 声明 `exit`/`error` 是 object —— null 会让 DSH 的 schema
      // 校验报 `"value.error" must be an object`，整个调用失败（实测踩到：
      // remote_status 查一个刚创建、还没开始执行的任务）。
      //
      // 为什么不直接改 views.js：那两个函数是**共享层**，UI 路由也在用，UI 侧
      // 接受 null（只是不渲染该块）。改共享层会动到 UI 契约。
      // 所以在工具层收口 —— 把 null 换成**省略字段**（两者都不在 required 里）。
      const out = { ...v }
      if (!(out.exit && typeof out.exit === 'object')) delete out.exit
      if (!(out.error && typeof out.error === 'object')) delete out.error
      if (!(out.manifestCounts && typeof out.manifestCounts === 'object')) out.manifestCounts = {}
      return out
    },
  })

  // ── remote_handoff ─────────────────────────────────────────────
  reg({
    name: 'remote_handoff',
    description: '取一条远程任务的完整交接卡：状态、退出码、摘要文本、工作区变更、变更 diff（提案 #21，文本文件的 unified diff）、产物清单、日志尾巴、拉取提示。这张卡的设计目标是让主电脑在不看副机任何原始日志的情况下做决策。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          available: { type: 'boolean' },
          status: { type: 'string' },
          handoff: { type: 'object' },
          note: { type: 'string' },
        },
        required: ['taskId', 'available'],
      },
      render: renderText((_args, value) => (value?.handoff ? handoffSummaryText({
        taskId: value.taskId,
        // handoffView 刻意不含 workspace（防绝对路径回显），这里补占位，
        // 否则文本里会打出 "工作区：undefined"（与 subagent-provider 同一处理）。
        handoff: { ...value.handoff, workspace: value.handoff.workspace ?? '(未回传)' },
      }) : value?.note ?? '')),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      if (!t.handoff) {
        // ⚠ 不要写 `handoff: null` —— schema 声明 `handoff: { type: 'object' }`，
        // null 会触发 `value is not lossless JSON`（与 remote_task 的 workspace 同一类
        // 问题）。handoff 不在 required 里，所以**省略该字段**即可。
        return {
          taskId: t.taskId,
          available: false,
          status: t.status,
          note: TERMINAL_STATUS.has(t.status)
            ? '任务已结束但副机尚未上报交接卡（可能在上报途中）。稍后用 remote_status 复查。'
            : `任务还在 ${t.status}，交接卡要等任务结束后才有。用 remote_status 跟进。`,
        }
      }
      // handoff 是**副机上报**的对象，字段集不受本文件控制（副机版本升级、
      // 或将来有人往里加诊断字段）。必须经 handoffView 逐字段投影后再交给模型 ——
      // 工具返回值会进入会话日志，被后续每个请求带上，比 UI 那条路径更该加固。
      // （此前这里是裸直出 `handoff: t.handoff`，是"加固只做了一半"的实例。）
      return { taskId: t.taskId, available: true, status: t.status, handoff: handoffView(t.handoff), note: '' }
    },
  })

  // ── remote_manifest ────────────────────────────────────────────
  reg({
    name: 'remote_manifest',
    description: '取一条远程任务的产物清单（不含文件字节）。清单先于字节：只有 role:final 的条目可以 pull；intermediate（日志、缓存、中间构建文件）只在副机留存，这里只给计数。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string' },
          counts: { type: 'object' },
          bytesFinal: { type: 'number' },
          final: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'number' },
                sha256: { type: 'string' },
              },
              required: ['path'],
            },
          },
          intermediateCount: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['final'],
      },
      render: renderText((_args, value) => {
        const finalList = arr(value.final)
        const lines = [`产物清单 ${value.taskId} [${value.status}] final=${finalList.length} intermediate=${value.intermediateCount} 共 ${human(value.bytesFinal)}`]
        for (const f of finalList.slice(0, 60)) {
          lines.push(`- ${f.path} — ${f.kind}, ${human(f.bytes)}, sha256=${String(f.sha256 ?? 'n/a').slice(0, 12)}`)
        }
        lines.push('', value.note ?? '')
        return lines.join('\n')
      }),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      return buildManifestView(t)
    },
  })

  // ── remote_pull ────────────────────────────────────────────────
  reg({
    name: 'remote_pull',
    description:
      '把副机上的成品拉到本机。只有清单里 role:final 的文件可以拉；传输按块进行，落地前校验 sha256，不一致就丢弃并报 hash-mismatch。dest 是本机目标目录，文件名取产物路径的最后一段。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'remote_task 返回的 taskId。' },
        paths: { type: 'array', items: { type: 'string' }, description: '清单内的相对路径（可多个）。' },
        dest: { type: 'string', description: '本机目标目录（绝对路径）。省略则落到系统临时目录下的 dsh-remote-agent/<taskId>。' },
      },
      required: ['taskId', 'paths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          dest: { type: 'string' },
          pulled: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                bytes: { type: 'number' },
                sha256: { type: 'string' },
                dest: { type: 'string' },
              },
              required: ['path', 'dest'],
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, reason: { type: 'string' } },
              required: ['path', 'reason'],
            },
          },
        },
        required: ['pulled', 'skipped'],
      },
      render: renderText((_args, value) => {
        const pulled = arr(value.pulled)
        const skipped = arr(value.skipped)
        const lines = [`拉取完成：成功 ${pulled.length}，跳过 ${skipped.length}（目标目录 ${value.dest}）`]
        for (const p of pulled) lines.push(`- OK ${p.path} → ${p.dest} (${human(p.bytes)})`)
        for (const s of skipped) lines.push(`- SKIP ${s.path}: ${s.reason}`)
        return lines.join('\n')
      }),
    },
    async execute(args, exec) {
      const t = requireTask(registry, args?.taskId)
      const paths = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === 'string' && p !== '') : []
      if (paths.length === 0) throw new RemoteAgentError('paths must contain at least one entry', ERROR_CODE.INTERNAL)
      const destDir = typeof args?.dest === 'string' && args.dest !== ''
        ? path.resolve(args.dest)
        : path.join(os.tmpdir(), 'dsh-remote-agent', t.taskId)

      const pulled = []
      const skipped = []
      for (const relPath of paths) {
        try {
          const out = await pulls.pull({
            nodeId: t.nodeId,
            taskId: t.taskId,
            relPath,
            dest: destDir,
            manifest: t.manifest,
            signal: exec?.signal,
          })
          pulled.push({ path: out.path, bytes: out.bytes, sha256: out.sha256, dest: out.dest })
        } catch (err) {
          skipped.push({ path: relPath, reason: `${err?.code ?? 'error'}: ${String(err?.message ?? err)}` })
        }
      }
      return { taskId: t.taskId, dest: destDir, pulled, skipped }
    },
  })

  // ── remote_purge ────────────────────────────────────────────────
  reg({
    name: 'remote_purge',
    description:
      '清理 hub 侧的任务视图（只清视图，不碰副机的任务状态）。'
      + '用途：任务派多了之后 hub 视图会累积（副机的任务记录默认保留 7 天），'
      + '累积到上限就会拒绝新任务 —— 这个工具是那种情况的逃生舱。'
      + '默认只清已结束的任务；在跑的任务保留（除非显式 includeActive）。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '只清这个节点（省略则清全部节点的视图）。' },
        includeActive: {
          type: 'boolean',
          description: '是否连在跑的任务也清（默认 false）。清掉后 remote_status 查不到它，但副机上它仍在继续跑。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          removed: { type: 'number' },
          kept: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['removed', 'kept'],
      },
      render: renderText((_args, value) =>
        `已清理 ${value.removed} 条任务视图${value.kept > 0 ? `，保留 ${value.kept} 条在跑的` : ''}。${value.note ? `\n${value.note}` : ''}`),
    },
    execute(args) {
      // 显式指定 node 时先校验它存在 —— 否则会静默清 0 条，用户以为成功了。
      let nodeId
      if (typeof args?.node === 'string' && args.node.trim() !== '') {
        const rec = registry.pickNode(args.node)
        if (!rec) throw new RemoteAgentError(`unknown node: ${args.node}`, ERROR_CODE.TASK_UNKNOWN)
        nodeId = rec.nodeId
      }
      const { removed, kept } = registry.purgeTasks({
        nodeId,
        includeActive: args?.includeActive === true,
      })
      return {
        removed,
        kept,
        note:
          removed === 0
            ? '没有可清理的终态任务视图。若仍被"already has N active tasks"挡住，说明在跑的任务确实到了上限。'
            : '副机仍保留自己的任务记录（它是权威）。它下次上报 sync 时，未完成的任务会重新出现在这里。',
      }
    },
  })

  // ── remote_cancel ──────────────────────────────────────────────
  reg({
    name: 'remote_cancel',
    description: '请求副机中断一条正在跑的任务。请求是尽力而为的：副机会打断 agent 或杀掉进程树，并把状态落成 aborted。已在途的产物拉取会一并取消并清理临时文件。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          requested: { type: 'boolean' },
          status: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['taskId', 'requested'],
      },
      render: renderText((_args, value) => `${value.requested ? '已发送取消请求' : '取消请求未能送达'} ${value.taskId}（当前 status=${value.status}）${value.note ? `\n${value.note}` : ''}`),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      pulls.cancelTask(t.taskId)
      const requested = registry.cancelTask(t.taskId)
      return {
        taskId: t.taskId,
        requested,
        status: t.status,
        note: requested
          ? '副机侧任务会在下一个检查点停下；用 remote_status 确认最终状态。'
          : '节点当前不可达或任务已结束，取消请求没有送出。',
      }
    },
  })

  // remote_interrupt 与 remote_cancel 同义，便于从远程子代理语义发现它。
  reg({
    name: 'remote_interrupt',
    description: '中断远程后台 Agent（remote_cancel 的语义别名），同时取消它在途的产物拉取。',
    parameters: {
      type: 'object', properties: { taskId: { type: 'string' } },
      required: ['taskId'], additionalProperties: false,
    },
    output: { schema: { type: 'object' } },
    async execute(args) {
      const task = requireTask(registry, args?.taskId)
      pulls.cancelTask(task.taskId)
      const requested = registry.cancelTask(task.taskId)
      return { taskId: task.taskId, requested, status: task.status }
    },
  })

  // ── remote_ls / remote_read / remote_grep / remote_tree（提案 #25）──
  //
  // 四个只读文件工具共用同一条 RPC 通道：registry.fsRequest(nodeId, op, params)
  // （fs/req ↔ fs/res，15s 超时，断连即失败）。与任务链路的本质区别：
  // **不进副机任务队列、不 spawn、不占并发槽** —— 一条 grep 卡住锁死队列
  // 的形态在这里结构性不存在（fs-service 自带 10s/2000 文件等扫描上限）。
  //
  // 副机 reject 的形态是 { code, message }（node/index.js handleFsReq 从
  // FsError.code 透传），这里转成 RemoteAgentError 让 DSH 框架统一物化，
  // 同时保留 code（workspace-denied / artifact-missing / artifact-too-large）
  // —— 调用方可以区分"越界""不存在""太大"三种最常见的失败。
  const fsOp = (name, description, parameters, output, op) => {
    reg({
      name,
      description,
      parameters,
      output,
      async execute(args) {
        // resolveNodeId 会抛 unknown node / node offline（RemoteAgentError）
        const nodeId = resolveNodeId(registry, args?.node)
        // 只有 node 是路由概念不透传；path 是副机 op 的正式参数（fs-service 签名）
        const params = { ...(args ?? {}) }
        delete params.node
        try {
          const result = await registry.fsRequest(nodeId, op, params)
          return { node: nodeId, ...(result && typeof result === 'object' ? result : {}) }
        } catch (err) {
          const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
          throw new RemoteAgentError(`remote ${op} on ${nodeId} failed: ${String(err?.message ?? err)}`, code)
        }
      },
    })
  }

  // 通用参数块：path 必填（副机上的绝对路径）；node 可选（自动路由）。
  const pathParam = { type: 'string', description: '副机上的绝对路径，必须落在该节点允许的 roots 之内（超出会被副机以 workspace-denied 拒绝）。' }
  const nodeParam = { type: 'string', description: '目标节点 id（或主机名）。省略时自动选在线节点。' }
  const fsReq = (props, required) => ({ type: 'object', properties: { node: nodeParam, ...props }, required: ['path', ...required], additionalProperties: false })

  fsOp(
    'remote_ls',
    '列出远程副机上的一个目录（单层、分页，按名称/大小/修改时间/类型）。用于"看看副机这个文件夹里有什么"。安全模型：只读；路径必须在该节点允许的 roots 内；denyPaths 生效；符号链接只列条目不解引用。',
    fsReq({
      path: pathParam,
      limit: { type: 'number', description: '单页条目数（1-2000，默认 500）。' },
      offset: { type: 'number', description: '起始偏移（配合 limit 翻页，默认 0）。' },
    }, []),
    {
      schema: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          path: { type: 'string' },
          total: { type: 'number' },
          offset: { type: 'number' },
          truncated: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                size: { type: 'number' },
                mtimeMs: { type: 'number' },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['node', 'path', 'entries'],
      },
      render: renderText((_args, value) => {
        const entries = arr(value?.entries)
        if (entries.length === 0) return `${value?.path ?? '?'} 是空目录（或条目被 denyPaths 全部过滤）。`
        const lines = [`${value.path}（共 ${value.total} 项${value.truncated ? '，本页截断' : ''}）：`, '']
        for (const e of entries.slice(0, 200)) {
          lines.push(`- ${e.type === 'dir' ? '[目录]' : e.type === 'link' ? '[链接]' : '[文件]'} ${e.name}${e.type === 'file' ? ` (${human(e.size)})` : ''}`)
        }
        if (value.truncated) lines.push('', '还有更多：用 offset/limit 翻页。')
        return lines.join('\n')
      }),
    },
    'ls',
  )

  fsOp(
    'remote_read',
    '读取远程副机上的一个文件。文本文件（≤8MB）按行分段返回（offset+limit 翻页，单次响应 ≤256KB，超长行截断）；二进制文件只回元数据（sha256、大小、头部 hex 预览），不回原始字节。用于"读一眼副机上的某个文件"。只读；路径必须在 roots 内。',
    fsReq({
      path: pathParam,
      offset: { type: 'number', description: '起始行号（0 起，默认 0）。' },
      limit: { type: 'number', description: '本次读取行数（1-5000，默认 500）。' },
    }, []),
    {
      schema: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          path: { type: 'string' },
          binary: { type: 'boolean' },
          size: { type: 'number' },
          sha256: { type: 'string' },
          ext: { type: 'string' },
          head: { type: 'string' },
          totalLines: { type: 'number' },
          offset: { type: 'number' },
          truncated: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['node', 'path', 'binary'],
      },
      render: renderText((_args, value) => {
        if (value?.binary === true) {
          return [
            `二进制文件 ${value.path}（${human(value.size)}）`,
            `sha256: ${value.sha256 ?? 'n/a'}`,
            value.head ? `头部: ${String(value.head).slice(0, 64)}…` : '',
          ].filter((l) => l !== '').join('\n')
        }
        const lines = arr(value?.lines)
        if (lines.length === 0) return `${value?.path ?? '?'} 无内容（空文件或翻页越界）。`
        const out = [`${value.path} 第 ${value.offset} 行起（全文 ${value.totalLines} 行${value.truncated ? '，截断' : ''}）：`, '']
        for (const l of lines.slice(0, 400)) out.push(`│ ${l}`)
        if (value.truncated) out.push('', `还有更多：用 offset=${(value.offset ?? 0) + lines.length} 继续读。`)
        return out.join('\n')
      }),
    },
    'read',
  )

  fsOp(
    'remote_grep',
    '在远程副机上做全文搜索：递归扫描目录下的文本文件（可按 glob 过滤文件名），返回命中的文件/行号/内容。扫描在副机本地完成，只回命中结果——50GB 目录也不搬数据。上限：2000 文件 / 单文件 2MB / 命中 ≤200 / 总时长 10s，达到上限如实报告 truncated。只读；路径必须在 roots 内。',
    fsReq({
      path: pathParam,
      pattern: { type: 'string', description: '搜索内容。默认按字面量匹配；regex:true 时按正则解释。' },
      regex: { type: 'boolean', description: '是否把 pattern 当正则（默认 false=字面量）。' },
      ignoreCase: { type: 'boolean', description: '忽略大小写（默认 true）。' },
      glob: { type: 'string', description: '文件名过滤（如 "*.txt"、"log*"），默认扫全部文本文件。' },
      maxMatches: { type: 'number', description: '命中上限（1-200，默认 200）。想快就调小。' },
    }, ['pattern']),
    {
      schema: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          path: { type: 'string' },
          pattern: { type: 'string' },
          filesScanned: { type: 'number' },
          filesSkipped: { type: 'number' },
          matchCount: { type: 'number' },
          truncated: { type: 'boolean' },
          truncatedBy: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['file', 'line'],
            },
          },
        },
        required: ['node', 'path', 'matches'],
      },
      render: renderText((_args, value) => {
        const matches = arr(value?.matches)
        if (matches.length === 0) {
          return `无命中：pattern="${value?.pattern ?? ''}"（扫描 ${value?.filesScanned ?? 0} 个文件，跳过 ${value?.filesSkipped ?? 0} 个）。`
        }
        const lines = [
          `"${value.pattern}" 命中 ${value.matchCount} 处（扫描 ${value.filesScanned} 文件${value.truncated ? `，按${value.truncatedBy === 'time' ? '超时' : '命中上限'}截断` : ''}）：`,
          '',
        ]
        for (const m of matches.slice(0, 100)) lines.push(`${m.file}:${m.line}: ${String(m.text ?? '').slice(0, 300)}`)
        if (value.truncated) lines.push('', '（结果被截断——缩小搜索范围或减小 maxMatches 可拿到更完整的结果）')
        return lines.join('\n')
      }),
    },
    'grep',
  )

  fsOp(
    'remote_tree',
    '查看远程副机上一个目录树的结构摘要（深度与条目数可配，默认 3 层 / 最多 2000 条）。扫描在副机本地完成，只回结构不回内容——适合"50GB 文件夹里到底长什么样"这类问题。只读；路径必须在 roots 内；符号链接只列条目不深入。',
    fsReq({
      path: pathParam,
      depth: { type: 'number', description: '最大深度（1-6，默认 3）。' },
    }, []),
    {
      schema: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          path: { type: 'string' },
          depth: { type: 'number' },
          entries: { type: 'number' },
          maxEntries: { type: 'number' },
          truncated: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object' } },
        },
        required: ['node', 'path', 'items'],
      },
      render: renderText((_args, value) => {
        const renderItems = (items, prefix, sink) => {
          for (const it of arr(items).slice(0, 120)) {
            sink.push(`${prefix}${it.type === 'dir' ? '📁' : '·'} ${it.name}`)
            if (it.type === 'dir' && prefix.length <= 6) renderItems(it.children, `${prefix}  `, sink)
          }
        }
        const lines = [`${value?.path ?? '?'}（深度 ${value?.depth}，${value?.entries} 条目${value?.truncated ? '，截断' : ''}）`, '']
        renderItems(value?.items, '', lines)
        return lines.join('\n')
      }),
    },
    'tree',
  )

  /* ═══════════════════════════════════════════════════════════════════════
   * 写操作工具（2026-10-20，用户要求"更多工具 = 文件写操作"）
   * ═══════════════════════════════════════════════════════════════════════
   *
   * ⚠⚠ **这四个工具会改副机的文件** —— 前四个 fs 工具全是只读。
   *
   * 与只读工具的关键区别：**必须带 `confirm: 'yes'`**。
   *
   * 为什么强制确认而不是靠参数默认值：
   *   · 这些操作**不可逆**（删了就是删了）
   *   · 调用方通常是 AI，而 AI 会"顺手"多调一次工具
   *   · 用户对"AI 改了我的文件"的容忍度远低于"AI 读了我的文件"
   *
   * 确认不是形式主义：`confirm` 必须由**调用方显式表达**，缺了直接拒绝。
   * 副机侧还有一层护栏（roots / 不覆盖 / 不递归删），两层独立。
   */
  const confirmParam = {
    type: 'string',
    description: '必须显式传 "yes" 才能执行。这是不可逆的文件操作，插件要求调用方明确表示知情。',
  }

  /**
   * 写操作工具的通用包装。
   *
   * @param {string} name 工具名
   * @param {string} description 说明（要讲清危险）
   * @param {object} parameters 参数 schema
   * @param {object} output 输出 schema
   * @param {string} op 副机侧的 op 名
   */
  const writeOp = (name, description, parameters, output, op) => {
    reg({
      name,
      description,
      parameters,
      output,
      async execute(args) {
        // ⚠ 二次确认是**硬要求**：缺了直接拒，不给默认通过
        if (args?.confirm !== 'yes') {
          throw new RemoteAgentError(
            `${name} 会修改副机上的文件（不可逆）。`
            + '请在参数里显式传 confirm: "yes" 表示你已确认目标路径正确。',
            ERROR_CODE.WORKSPACE_DENIED,
          )
        }
        const nodeId = resolveNodeId(registry, args?.node)
        const params = { ...(args ?? {}) }
        // confirm / node 都是 hub 侧概念，不透传给副机
        delete params.node
        delete params.confirm
        try {
          const result = await registry.fsRequest(nodeId, op, params)
          return { node: nodeId, ...(result && typeof result === 'object' ? result : {}) }
        } catch (err) {
          const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
          throw new RemoteAgentError(
            `remote ${op} on ${nodeId} failed: ${String(err?.message ?? err)}`,
            code,
          )
        }
      },
    })
  }

  const writeReq = (props, required) => ({
    type: 'object',
    properties: { node: nodeParam, confirm: confirmParam, ...props },
    required: ['path', 'confirm', ...required],
    additionalProperties: false,
  })

  writeOp(
    'remote_write',
    '在副机上写一个文件（**会修改文件，不可逆**）。默认**不覆盖**已有文件 —— 要覆盖必须显式传 overwrite: true。'
    + '路径必须在副机允许的 roots 内。写盘是原子的（临时文件 + rename），不会留半截文件。'
    + '单次内容上限 8MB。**必须传 confirm: "yes"**。',
    writeReq({
      path: pathParam,
      content: { type: 'string', description: '文件内容（UTF-8 文本）。上限 8MB。' },
      overwrite: { type: 'boolean', description: '目标已存在时是否覆盖。默认 false（拒绝）。' },
    }, ['content']),
    {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        bytes: { type: 'number' },
        overwritten: { type: 'boolean' },
      },
      required: ['node', 'path'],
    },
    'write',
  )

  writeOp(
    'remote_mkdir',
    '在副机上建目录（递归，已存在视为成功）。路径必须在 roots 内。**必须传 confirm: "yes"**。',
    writeReq({ path: pathParam }, []),
    {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        created: { type: 'boolean' },
      },
      required: ['node', 'path'],
    },
    'mkdir',
  )

  writeOp(
    'remote_move',
    '在副机上移动/重命名文件（同盘 rename）。两端都必须在 roots 内。'
    + '默认不覆盖目标；跨盘移动会明确报错（不做静默复制）。**必须传 confirm: "yes"**。',
    {
      type: 'object',
      properties: {
        node: nodeParam,
        confirm: confirmParam,
        from: { type: 'string', description: '源路径（副机绝对路径，须在 roots 内）。' },
        to: { type: 'string', description: '目标路径（副机绝对路径，须在 roots 内）。' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖。默认 false。' },
      },
      required: ['from', 'to', 'confirm'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        node: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['node', 'from', 'to'],
    },
    'move',
  )

  writeOp(
    'remote_delete',
    '删除副机上的**单个文件或空目录**（**不可逆**）。'
    + '刻意**不支持递归删除** —— 非空目录会被拒绝，真有需要请用 exec 显式执行删除命令。'
    + '路径必须在 roots 内。**必须传 confirm: "yes"**。',
    writeReq({ path: pathParam }, []),
    {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        kind: { type: 'string' },
      },
      required: ['node', 'path'],
    },
    'delete',
  )

  /* ═══════════════════════════════════════════════════════════════════════
   * 进程与端口诊断（2026-10-20，用户要求"更多工具 = 进程与端口诊断"）
   * ═══════════════════════════════════════════════════════════════════════
   *
   * 为什么需要：远程排查时用户不在副机前面，看不见任务管理器。
   * 这两天排查"副机连不上"，最耗时的几步全靠手工敲 netstat / Get-Process。
   *
   *   · `remote_ps`   —— 列进程（**只读**）
   *   · `remote_port` —— 查端口占用（**只读**）
   *   · `remote_kill` —— 杀进程（**不可逆** → 必须 confirm: 'yes'）
   *
   * ⚠ 这三个工具**不受 roots 约束**（进程没有路径概念）。kill 的护栏在
   * 副机侧 `lib/node/process-service.js`：confirm + 拒杀自身/父进程/系统进程。
   */
  reg({
    name: 'remote_ps',
    description: '列出副机上的进程（PID / 名称 / 内存 / CPU 时间）。只读。'
    + '用于排查"副机上到底跑着什么"、"那个卡住的进程还在不在"。'
    + '可按进程名子串过滤。',
    parameters: {
      type: 'object',
      properties: {
        node: nodeParam,
        limit: { type: 'number', description: '最多返回多少个（1-1000，默认 200）。' },
        filter: { type: 'string', description: '按进程名子串过滤（不区分大小写）。留空返回全部。' },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        platform: { type: 'string' },
        processes: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
      },
      required: ['node'],
    },
    async execute(args) {
      const nodeId = resolveNodeId(registry, args?.node)
      const params = { ...(args ?? {}) }
      delete params.node
      try {
        const result = await registry.fsRequest(nodeId, 'ps', params)
        return { node: nodeId, ...(result && typeof result === 'object' ? result : {}) }
      } catch (err) {
        const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
        throw new RemoteAgentError(`remote ps on ${nodeId} failed: ${String(err?.message ?? err)}`, code)
      }
    },
  })

  reg({
    name: 'remote_port',
    description: '查副机上某个端口的占用情况（谁在监听、谁在连接、对应 PID）。只读。'
    + '用于排查"端口被占用"、"副机到底有没有在监听 19387"。',
    parameters: {
      type: 'object',
      properties: {
        node: nodeParam,
        port: { type: 'number', description: '要查的端口（1-65535）。' },
      },
      required: ['port'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        port: { type: 'number' },
        listeners: { type: 'array', items: { type: 'object' } },
      },
      required: ['node', 'port'],
    },
    async execute(args) {
      const nodeId = resolveNodeId(registry, args?.node)
      try {
        const result = await registry.fsRequest(nodeId, 'port', { port: args?.port })
        return { node: nodeId, ...(result && typeof result === 'object' ? result : {}) }
      } catch (err) {
        const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
        throw new RemoteAgentError(`remote port on ${nodeId} failed: ${String(err?.message ?? err)}`, code)
      }
    },
  })

  reg({
    name: 'remote_kill',
    description: '杀掉副机上的一个进程（**不可逆**）。**必须传 confirm: "yes"**。'
    + '副机侧有三道保护：拒绝杀本插件进程、拒绝杀其父进程（通常是 DSH 本体）、'
    + '拒绝杀系统关键进程（System/csrss/wininit/services/lsass 等）。'
    + '杀掉副机的 DSH 会让它彻底失联 —— 除非你确实无法通过其它方式恢复，否则不要这样做。',
    parameters: {
      type: 'object',
      properties: {
        node: nodeParam,
        pid: { type: 'number', description: '要杀的进程 PID（正整数）。先用 remote_ps 确认它是什么。' },
        confirm: confirmParam,
      },
      required: ['pid', 'confirm'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        ok: { type: 'boolean' },
        pid: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['node', 'ok', 'pid'],
    },
    async execute(args) {
      if (args?.confirm !== 'yes') {
        throw new RemoteAgentError(
          'remote_kill 会终止副机上的进程（不可逆）。请在参数里显式传 confirm: "yes"。',
          ERROR_CODE.WORKSPACE_DENIED,
        )
      }
      const nodeId = resolveNodeId(registry, args?.node)
      try {
        const result = await registry.fsRequest(nodeId, 'kill', {
          pid: args?.pid,
          confirm: 'yes',
        })
        return { node: nodeId, ...(result && typeof result === 'object' ? result : {}) }
      } catch (err) {
        const code = typeof err?.code === 'string' ? err.code : ERROR_CODE.INTERNAL
        throw new RemoteAgentError(`remote kill on ${nodeId} failed: ${String(err?.message ?? err)}`, code)
      }
    },
  })

  return disposers
}

/**
 * 解析目标节点：显式 id/主机名优先；省略时唯一在线节点直接用，多节点则
 * 负载感知自动选（提案 #14：在跑任务数 → CPU → 内存 → id 逐级比较，
 * mode=agent 只考虑支持 agent 后端的节点）。
 */
export function resolveNodeId(registry, wanted, { mode } = {}) {
  if (typeof wanted === 'string' && wanted.trim() !== '') {
    const rec = registry.pickNode(wanted)
    if (!rec) throw new RemoteAgentError(`unknown node: ${wanted}`, ERROR_CODE.TASK_UNKNOWN)
    if (!rec.online) throw new RemoteAgentError(`node offline: ${rec.nodeId}`, ERROR_CODE.INTERNAL)
    return rec.nodeId
  }
  const online = registry.onlineNodes()
  if (online.length === 0) {
    throw new RemoteAgentError('no online node: 先让副机接入（remote_nodes 可看当前状态）', ERROR_CODE.INTERNAL)
  }
  // 多节点不再强制显式指定（提案 #14）：负载感知自动选；选不出有能力匹配的
  // 节点（如 agent 模式但没有 agentMode 的节点）才报错并点名原因。
  const auto = registry.pickAutoNode({ mode })
  if (!auto) {
    throw new RemoteAgentError(
      mode === 'agent'
        ? 'no online node supports agent mode（agentMode）; 请显式指定 node 或改用 mode:"exec"'
        : 'no online node: 先让副机接入（remote_nodes 可看当前状态）',
      ERROR_CODE.INTERNAL,
    )
  }
  return auto
}

function requireTask(registry, taskId) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new RemoteAgentError('taskId is required', ERROR_CODE.TASK_UNKNOWN)
  }
  const t = registry.getTask(taskId)
  if (!t) throw new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN)
  return t
}
