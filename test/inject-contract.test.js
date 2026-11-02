/**
 * `inject` 声明与代码实际访问的服务必须匹配（2026-10-16 翻车回归）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 事故
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 我把包内 `cordis.patch.yml` 的 inject 从
 *   `['webServer', 'tools', 'systemPrompt']`
 * 收窄成
 *   `['webServer']`
 * 理由是"未配置时只需要 webServer，够注册引导路由"。
 *
 * **漏了 `applyHub` 需要全部三个。** profile 里没写 inject 的机器（旧配置、
 * 手写配置）合并后就是 `['webServer']` → hub 分支一访问 `ctx.tools` 就抛
 *
 *     cannot get property "tools" without inject
 *
 * ── 为什么极难归因 ──────────────────────────────────────────────────────
 *
 * `applyHub` 里工具注册在路由注册**之后**，所以现象是**一半活一半死**：
 *
 *   · /api/remote-agent/healthz   → 200（还带着 nodes:1, online:1 的实时计数）
 *   · /api/remote-agent/ui/*      → 401（我的 guard，说明路由在）
 *   · **12 个 remote_* 工具全部消失**
 *   · 插件管理页显示「异常」（fiber phase: failed）
 *
 * 我花了很多轮才定位：先怀疑 pnpm 残留、再怀疑 GitHub 网络、再怀疑 UI 缓存，
 * 直到用 grep 在工具列表里搜 `remote_` 才确认"工具真的没了"。
 *
 * ── 两条防线 ────────────────────────────────────────────────────────────
 *
 * 1. **包内 inject 取 hub 全集**（本测试第 1 条）
 * 2. **代码容错**：拿不到 `ctx.tools` 时只让工具消失，不让整个 hub 挂掉，
 *    并把原因写进日志（本测试第 2、3 条）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const patch = read('cordis.patch.yml')
const hubIndex = read('lib/hub/index.js')

/**
 * 取包内 patch 里**生效的** inject 声明。
 *
 * ⚠ 必须锚定行首 `^\s*inject:` —— 文件里有多处**注释**提到 `inject: ['webServer']`
 * （那正是这次事故的记录），用 `/inject:\s*(\[...\])/` 会命中注释里那句，
 * 断言恒假（第一版就是这样，误报了两条）。
 */
function declaredInject() {
  const m = patch.match(/^\s*inject:\s*(\[[^\]]*\])/m)
  return m ? m[1] : ''
}

/* ─────────────── 1. 包内 inject 必须覆盖 hub 的三个服务 ─────────────── */

test('包内 inject 必须含 hub 需要的三个服务（webServer/tools/systemPrompt）', () => {
  // applyHub 会访问这三个（webServer 注册路由、tools 注册 19 个工具、
  // systemPrompt 挂提示词段）。少任何一个，hub 分支就抛。
  const declared = declaredInject()
  assert.ok(declared !== '', 'cordis.patch.yml 应有生效的 inject 声明')
  for (const svc of ['webServer', 'tools', 'systemPrompt']) {
    assert.ok(
      declared.includes(`'${svc}'`) || declared.includes(`"${svc}"`),
      `包内 inject 必须含 '${svc}'（实际 ${declared}）—— 少了它 hub 分支会抛 cannot get property without inject`,
    )
  }
})

test('applyHub 实际访问的服务必须都在 inject 里', () => {
  const code = stripComments(hubIndex)
  const declared = declaredInject()

  // 找 applyHub 里所有 `ctx.<service>` 的属性访问（排除方法名与已知非服务）
  const nonServices = new Set(['get', 'on', 'effect', 'logger', 'emit', 'plugin', 'root', 'scope', 'inject', 'set', 'provide', 'isolate', 'intercept', 'parallel', 'serial', 'waterfall'])
  const accessed = new Set()
  const start = code.indexOf('export function applyHub')
  const end = code.indexOf('\n  return {', start)
  const seg = code.slice(start, end > start ? end : start + 20000)
  for (const mm of seg.matchAll(/ctx\.([a-zA-Z][\w]*)/g)) {
    const name = mm[1]
    if (!nonServices.has(name)) accessed.add(name)
  }

  // 只检查真的会抛的那几个（属性访问）。ctx.get(...) 是非严格的，不算。
  const mustDeclare = ['webServer', 'tools', 'systemPrompt']
  for (const svc of mustDeclare) {
    if (!accessed.has(svc)) continue
    assert.ok(
      declared.includes(`'${svc}'`),
      `applyHub 访问了 ctx.${svc}，但 inject 里没有它 —— 会抛 cannot get property without inject`,
    )
  }
})

/* ─────────────── 2. 代码必须容错（半死不比全死好） ─────────────── */

test('工具注册必须容错：拿不到 ctx.tools 只少工具，不让 hub 挂', () => {
  const code = stripComments(hubIndex)
  const i = code.indexOf("'remote-agent: tools'")
  assert.ok(i >= 0, '应找到 tools 注册段')
  // 往前找这个 __reg 的开头
  const start = code.lastIndexOf('__reg(', i)
  const seg = code.slice(start, i + 50)

  assert.match(seg, /try\s*\{[\s\S]*?ctx\.tools[\s\S]*?\}\s*catch/, 'ctx.tools 的访问必须在 try/catch 里')
  assert.match(seg, /tools service unavailable/, '拿不到服务时必须记日志说明原因（否则又是静默半死）')
  assert.match(seg, /return \(\) => \{\}/, '失败时应返回空 disposer 而不是抛出')
})

test('systemPrompt 注册同样容错', () => {
  const code = stripComments(hubIndex)
  const i = code.indexOf("'remote-agent: system-prompt'")
  assert.ok(i >= 0, '应找到 system-prompt 注册段')
  const start = code.lastIndexOf('__reg(', i)
  const seg = code.slice(start, i + 50)
  assert.match(seg, /try\s*\{[\s\S]*?ctx\.systemPrompt[\s\S]*?\}\s*catch/, 'ctx.systemPrompt 的访问必须在 try/catch 里')
})

/* ─────────────── 3. 日志必须说明修法 ─────────────── */

test('tools 缺失的日志要提示怎么修（改 inject）', () => {
  const code = stripComments(hubIndex)
  const i = code.indexOf('tools service unavailable')
  assert.ok(i >= 0, '应有该日志')
  const seg = code.slice(i, i + 400)
  assert.match(seg, /inject/, '日志应提示检查 loader 行的 inject')
})

/* ─────────────── 4. 反向验证：真的会抛 ─────────────── */

test('回归：applyHub 在缺 tools 的 inject 下**不再抛错**（容错生效）', async () => {
  const { applyHub } = await import(new URL('../lib/hub/index.js', import.meta.url).href)

  // 模拟 cordis：只有声明过的服务可属性访问
  const makeCtx = (declared) => {
    const registered = { routes: [], tools: [] }
    const values = {
      webServer: {
        register(r) { registered.routes.push(r.path); return () => {} },
        registerUpgrade(r) { registered.routes.push('u:' + r.path); return () => {} },
      },
      tools: { register(t) { registered.tools.push(t.name); return () => {} } },
      systemPrompt: { section() { return () => {} } },
    }
    const ctx = {
      registered,
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      on() { return () => {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get() { return undefined },
    }
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(ctx, name, {
        get() {
          if (!declared.includes(name)) throw new Error(`cannot get property "${name}" without inject`)
          return value
        },
      })
    }
    return ctx
  }

  // 缺 tools：应该**不抛**，只是没有工具
  const ctxA = makeCtx(['webServer'])
  const hA = applyHub(ctxA, { role: 'hub', nodeToken: 'nt_x' })
  assert.ok(hA, '缺 tools 时 applyHub 仍应返回句柄（不抛）')
  assert.equal(ctxA.registered.tools.length, 0, '缺 tools 时应没有工具')
  assert.ok(ctxA.registered.routes.length > 0, '缺 tools 时路由仍应注册')

  // 齐全：24 个工具（原 19 + 自检/后台管理/中断 + 文件互传 + 截图）
  const ctxB = makeCtx(['webServer', 'tools', 'systemPrompt'])
  applyHub(ctxB, { role: 'hub', nodeToken: 'nt_x' })
  assert.equal(ctxB.registered.tools.length, 24, 'inject 齐全时应有 24 个工具')
})
