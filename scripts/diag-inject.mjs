#!/usr/bin/env node
/**
 * 诊断：`inject` 契约是否与代码实际访问的服务匹配。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `inject` 声明与 `applyHub`/`applyWorker` 实际访问的服务**必须匹配**。
 * 不匹配时的失败形态**特别隐蔽**，我们为它付出过一整轮排查：
 *
 *   · **hub 半死**：`applyHub` 里工具注册在路由注册之后 —— 缺 `tools` 时
 *     路由全部注册成功、`/healthz` 返回 200 还带着 `nodes`/`online` 实时计数，
 *     但 **8 个 remote_* 工具全部消失**，插件管理页显示「异常」。
 *   · **agent 无工具**：副机缺 `tools` 时 agent 能推理、能调
 *     `load_workspace_dependencies`（DSH 全局注入的），但**没有 shell / 文件读写** ——
 *     看起来"能用"，实际干不了活。
 *
 * 两者的共同点是**没有明确报错**：一个是"一半活"，一个是"能说话不能干活"。
 *
 * ── 本脚本做什么 ────────────────────────────────────────────────────────
 *
 * 1. 读包内 `cordis.patch.yml` 的 inject
 * 2. 扫 `lib/hub/index.js` 的 `applyHub` 与 `lib/node/index.js` 的 worker 分支，
 *    找出所有 `ctx.<service>` 属性访问（属性访问在未声明 inject 时会**抛**）
 * 3. 断言这些服务都在 inject 里
 * 4. 用**假 ctx** 真跑一遍 `applyHub`，确认：
 *    · inject 齐全时 8 个工具都注册
 *    · 缺 `tools` 时**不抛错**（只少工具 + 记日志）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *
 *   node scripts/diag-inject.mjs           # 人读
 *   node scripts/diag-inject.mjs --json    # 机器读（CI 用）
 *
 * 退出码：0 = 契约成立；1 = 有问题（并打印是哪一条）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/* ── 1. 读包内 inject ───────────────────────────────────────────────── */

/**
 * 取**生效的** inject（锚定行首 —— 文件注释里有多处提到 inject，不锚定会命中注释）。
 * 这个坑我们踩过：断言用了 `/inject:\s*(\[...\])/`，命中了注释里那句事故记录。
 */
function declaredInject() {
  const patch = read('cordis.patch.yml')
  const m = patch.match(/^\s*inject:\s*(\[[^\]]*\])/m)
  return m ? m[1] : ''
}

const injectRaw = declaredInject()
const declared = [...injectRaw.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2])
check('包内 cordis.patch.yml 有 inject 声明', injectRaw !== '', injectRaw || '(未找到)')

/* ── 2. 扫代码里实际访问的服务 ──────────────────────────────────────── */

/** 非服务的方法名（`ctx.get` / `ctx.on` / …），不算服务访问。 */
const NON_SERVICES = new Set([
  'get', 'on', 'once', 'emit', 'effect', 'logger', 'plugin', 'root', 'scope',
  'inject', 'set', 'provide', 'isolate', 'intercept', 'parallel', 'serial',
  'waterfall', 'bail',
])

/** 取某个具名函数的函数体（花括号配对）。 */
function bodyOf(src, header) {
  const i = src.indexOf(header)
  if (i < 0) return ''
  const parenEnd = src.indexOf(')', i)
  const braceStart = src.indexOf('{', parenEnd > 0 ? parenEnd : i)
  if (braceStart < 0) return ''
  let depth = 0
  for (let k = braceStart; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1
    else if (src[k] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(i, k + 1)
    }
  }
  return ''
}

/** 从一段代码里找出所有 `ctx.<service>` 属性访问。 */
function servicesAccessed(code) {
  const found = new Set()
  for (const m of code.matchAll(/ctx\.([a-zA-Z][\w]*)/g)) {
    if (!NON_SERVICES.has(m[1])) found.add(m[1])
  }
  return found
}

const hubSrc = stripComments(read('lib/hub/index.js'))
const hubBody = bodyOf(hubSrc, 'export function applyHub')
check('找到 applyHub', hubBody !== '')
const hubServices = servicesAccessed(hubBody)

const workerSrc = stripComments(read('lib/node/index.js'))
const workerBody = bodyOf(workerSrc, 'function startWorker')
const workerServices = servicesAccessed(workerBody)

/* ── 3. 契约：hub 访问的服务必须在 inject 里 ────────────────────────── */

// 只查**会抛**的那几个（属性访问）。`ctx.get(name)` 是非严格的，不算。
const HUB_MUST = ['webServer', 'tools', 'systemPrompt']
for (const svc of HUB_MUST) {
  if (!hubServices.has(svc)) continue
  check(
    `hub 需要的 '${svc}' 在 inject 里`,
    declared.includes(svc),
    declared.includes(svc) ? '' : `applyHub 访问 ctx.${svc}，但 inject = ${injectRaw}`,
  )
}

// worker 侧：agent 的 ctx 继承本行 inject，所以 tools 必须有
const WORKER_MUST = ['tools', 'agentLoop', 'sessions']
for (const svc of WORKER_MUST) {
  if (!workerServices.has(svc)) continue
  check(
    `worker 需要的 '${svc}' 在 worker profile 模板里`,
    (() => {
      try {
        return read('profiles/worker.cordis.yml').includes(`'${svc}'`)
      } catch {
        return false
      }
    })(),
    `worker 分支访问 ctx.${svc}（agent 的 ctx 继承本行 inject，少了它 agent 拿不到该服务）`,
  )
}

/* ── 4. 真跑一遍 applyHub（假 ctx）─────────────────────────────────── */

/**
 * 造一个**模拟 cordis 语义**的 ctx：
 *   · 属性访问未声明的服务 → 抛（真实行为）
 *   · `ctx.get(name, false)` → 不管声明都返回（非严格）
 */
function fakeCtx(injectList) {
  const registered = { routes: [], tools: [], sections: [] }
  const values = {
    webServer: {
      register(r) { registered.routes.push(r.path); return () => {} },
      registerUpgrade(r) { registered.routes.push('upgrade:' + r.path); return () => {} },
    },
    tools: { register(t) { registered.tools.push(t.name); return () => {} } },
    systemPrompt: { section(s) { registered.sections.push(s.name); return () => {} } },
  }
  const ctx = {
    registered,
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on() { return () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined },
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!injectList.includes(name)) {
          throw new Error(`cannot get property "${name}" without inject`)
        }
        return value
      },
    })
  }
  return ctx
}

let applyHub
try {
  ;({ applyHub } = await import(new URL('../lib/hub/index.js', import.meta.url).href))
} catch (err) {
  check('能 import applyHub', false, String(err?.message ?? err))
}

if (applyHub) {
  // 4a. inject 齐全 → 不抛，且 24 个工具都在（任务/文件/进程/自检/后台/桌面）。
  try {
    const ctx = fakeCtx(declared)
    applyHub(ctx, { role: 'hub', nodeToken: 'nt_diag' })
    check('inject 齐全时 applyHub 不抛', true)
    check(
      'inject 齐全时注册 24 个 remote_* 工具',
      ctx.registered.tools.length === 24,
      `实际 ${ctx.registered.tools.length} 个：${ctx.registered.tools.join(', ') || '(无)'}`,
    )
    check('inject 齐全时注册了路由', ctx.registered.routes.length > 0, `${ctx.registered.routes.length} 条`)
  } catch (err) {
    check('inject 齐全时 applyHub 不抛', false, String(err?.message ?? err))
  }

  // 4b. 缺 tools → **不该抛**（容错），只少工具
  try {
    const ctx = fakeCtx(['webServer'])
    applyHub(ctx, { role: 'hub', nodeToken: 'nt_diag' })
    check('缺 tools 时 applyHub 仍不抛（容错生效）', true)
    check(
      '缺 tools 时没有工具（符合预期，不是 bug）',
      ctx.registered.tools.length === 0,
      `实际 ${ctx.registered.tools.length} 个`,
    )
    check('缺 tools 时路由仍注册（半活但不挂）', ctx.registered.routes.length > 0, `${ctx.registered.routes.length} 条`)
  } catch (err) {
    check(
      '缺 tools 时 applyHub 仍不抛（容错生效）',
      false,
      `抛了 ${String(err?.message ?? err)} —— lib/hub/index.js 的 tools 注册段缺 try/catch`,
    )
  }
}

/* ── 输出 ───────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
} else {
  console.log('inject 契约诊断')
  console.log('─'.repeat(64))
  console.log(`  包内 inject: ${injectRaw || '(未找到)'}`)
  console.log(`  hub 访问的服务: ${[...hubServices].sort().join(', ') || '(无)'}`)
  console.log(`  worker 访问的服务: ${[...workerServices].sort().join(', ') || '(无)'}`)
  console.log('─'.repeat(64))
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? `\n         ${r.detail}` : ''}`)
  }
  console.log('─'.repeat(64))
  console.log(failed.length === 0 ? `  ✓ 全部通过（${results.length} 项）` : `  ✗ ${failed.length}/${results.length} 项失败`)
}

process.exit(failed.length === 0 ? 0 : 1)
