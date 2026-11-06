/**
 * 副机面板（worker 视图）的回归。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景：一个结构性死设计
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dsh.client` 是**包级声明**（loader 扫 package.json 的 `dsh.client`），
 * 装了插件就加载面板，**无法按 role 条件化**。而 hub 的 UI 路由只在
 * `applyHub` 里注册 —— 副机跑 `applyWorkerBranch`，没有那些路由。
 *
 * 结果：副机侧栏有「远程同事」，点开是**全 404 的破面板**。
 *
 * ── 修法不是"藏掉 404" ──────────────────────────────────────────────────
 *
 * 副机**也有** webServer（`dsh-web-app` 是桌面版基础 bundle，实测监听
 * 19387），而 worker 分支早就有 `/api/remote-agent/status` 端点。
 * 所以让面板**显示副机自己**：角色 / 连的 hub / 任务队列 / roots / 错误。
 *
 * 这些断言锁住这个能力，防止它被"简化"回去。
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

const client = read('lib/client.js')
const nodeIndex = read('lib/node/index.js')

/* ─────────────── 1. 副机侧的状态端点必须存在 ─────────────── */

test('worker 分支注册了状态端点（面板的数据源）', () => {
  assert.match(nodeIndex, /const STATUS_PATH = ['"]\/api\/remote-agent\/status['"]/, '应定义 STATUS_PATH')
  // 必须真的注册（不是只定义常量）
  const i = nodeIndex.indexOf('webServer.register({ kind: \'exact\', path: STATUS_PATH')
  assert.ok(i >= 0, 'STATUS_PATH 必须被 webServer.register 注册')
  // 且注册在 optionalDisposers 里（可选服务，没有 webServer 时不报错）
  const around = nodeIndex.slice(i, i + 400)
  assert.match(around, /optionalDisposers\.push/, '注册的 disposer 应进 optionalDisposers（可选能力）')
})

test('statusSnapshot 覆盖面板要显示的每一项', () => {
  const i = nodeIndex.indexOf('function statusSnapshot()')
  assert.ok(i >= 0, '应存在 statusSnapshot')
  const seg = nodeIndex.slice(i, i + 1400)
  // 面板 worker 视图读的字段
  for (const f of ['nodeId', 'protocol', 'online', 'transportMode', 'url', 'stateDir', 'roots', 'runner', 'dshVersion', 'caps', 'tasks', 'lastError']) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(seg), `statusSnapshot 应提供 ${f}（面板要显示它）`)
  }
  // tasks 里要有队列计数（面板卡片用）
  assert.match(seg, /running/, 'tasks 应含 running')
  assert.match(seg, /queued/, 'tasks 应含 queued')
})

/* ─────────────── 2. client 半必须支持双角色 ─────────────── */

test('client 定义了副机状态端点的常量', () => {
  assert.match(client, /(?:var|let|const) STATUS_PATH = ['"]\/api\/remote-agent\/status['"]/, '应定义 STATUS_PATH')
})

test('client 有 apiGetPath（拉绝对路径，不走 UI 前缀）', () => {
  const code = stripComments(client)
  assert.match(code, /function apiGetPath\(/, '应定义 apiGetPath')
  // 它必须拉**传入的完整路径**，而不是 API + 路径。
  // ⚠ 花括号配对取函数体：`indexOf('\n    }')` 会被内部更深的 `}` 截断。
  const i = code.indexOf('function apiGetPath(')
  let depth = 0
  let end = -1
  for (let k = code.indexOf('{', i); k < code.length; k += 1) {
    if (code[k] === '{') depth += 1
    else if (code[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, 'apiGetPath 花括号配对失败')
  const seg = code.slice(i, end)
  assert.match(seg, /fetch\(fullPath/, 'apiGetPath 应直接 fetch 传入的完整路径')
  assert.ok(!/fetch\(API \+/.test(seg), 'apiGetPath 不得再加 API 前缀（STATUS_PATH 不在那个前缀下）')
})

test('client 的轮询会先探测角色，再决定拉哪个端点', () => {
  const code = stripComments(client)
  // 必须同时出现 hub 与 worker 两条拉取路径
  assert.match(code, /apiGet\('\/overview'\)/, '应拉 hub 的 /overview')
  assert.match(code, /apiGetPath\(STATUS_PATH\)/, '应拉副机的 STATUS_PATH')
  // 判定逻辑：hub 失败后试 worker（而不是直接报错）
  const i = code.indexOf("apiGet('/overview')")
  const seg = code.slice(i, i + 1800)
  assert.match(seg, /apiGetPath\(STATUS_PATH\)/, 'hub 端点失败后应回退到副机端点')
  assert.match(seg, /mode: 'worker'/, '回退成功时应标记 mode=worker')
  assert.match(seg, /mode: 'hub'/, 'hub 成功时应标记 mode=hub')
})

test('两个端点都失败时**如实报错**（不静默）', () => {
  const code = stripComments(client)
  const i = code.indexOf('apiGetPath(STATUS_PATH)')
  const seg = code.slice(i, i + 1400)
  // 副机端点也失败 → setState error（不是空字符串）
  assert.match(seg, /error: String\(/, '两端点都失败时应设置 error（不能吞掉）')
})

/* ─────────────── 3. worker 视图渲染 ─────────────── */

/**
 * 取 worker **渲染**分支的代码。
 *
 * ⚠ `if (state.mode === 'worker')` 在文件里出现**两次**：一次在轮询里
 * （决定拉哪个端点），一次在渲染里（决定画哪个视图）。用 `indexOf` 会
 * 命中第一个 —— 那是轮询，不含任何 UI 文案（第一版断言就是这样误报的）。
 *
 * 渲染分支的特征：里面有 `workerCards` 的声明。所以以它为锚点回溯到
 * 最近的 `if (state.mode === 'worker')`。（声明关键字 var/let/const 都接受
 * —— eslint no-var 上线后源码已统一切到 const。）
 */
function workerRenderBranch(code) {
  const cards = code.search(/(?:var|let|const) workerCards/)
  if (cards < 0) return ''
  const i = code.lastIndexOf("if (state.mode === 'worker')", cards)
  if (i < 0) return ''
  // 到下一个顶层视图根节点之前：支持旧的 h('div', className:'dra-root') 和新的 h(Root,
  const endOld = code.indexOf("return h('div', { className: 'dra-root' }", cards)
  const endNew = code.indexOf("return h(Root, { theme: theme }", cards)
  const candidates = [endOld, endNew].filter(function (x) { return x > i })
  const end = candidates.length > 0 ? Math.min.apply(null, candidates) : -1
  return end > i ? code.slice(i, end) : code.slice(i, i + 8000)
}

test('client 有 worker 分支的渲染', () => {
  const code = stripComments(client)
  const seg = workerRenderBranch(code)
  assert.ok(seg.length > 500, `worker 渲染分支应存在且非空（实际 ${seg.length} 字符）`)
  for (const label of ['角色', '节点 ID', '连接', '主机地址', '执行后端', '工作区', '能力', '任务状态分布']) {
    assert.ok(seg.includes(label), `worker 视图应显示「${label}」`)
  }
})

test('worker 视图不显示 hub 专属的操作（派发/拉产物）', () => {
  const code = stripComments(client)
  const seg = workerRenderBranch(code)
  assert.ok(seg.length > 500, 'worker 渲染分支应存在')
  assert.ok(!/dispatchForm/.test(seg), 'worker 视图不该有派发表单（副机不派活）')
  assert.ok(!/pairSection/.test(seg), 'worker 视图不该有配对码区（那是主机的事）')
  // 但应该有"去主机看"的提示
  assert.match(seg, /主机面板/, 'worker 视图应提示"任务在主机的面板上看"')
})

test('worker 视图用独立变量名，不与 hub 视图冲突', () => {
  const code = stripComments(client)
  const seg = workerRenderBranch(code)
  assert.ok(seg.length > 500, 'worker 渲染分支应存在')
  assert.match(seg, /(?:var|let|const) workerCards/, 'worker 视图应用自己的 workerCards')
  assert.match(seg, /(?:var|let|const) workerInfo/, 'worker 视图应用自己的 workerInfo')
  // 不得重新声明 hub 的变量（那会 shadow 或报错）
  assert.ok(!/(?:var|let|const) cards = /.test(seg), 'worker 分支不得重新声明 cards（hub 已有）')
  assert.ok(!/(?:var|let|const) head = /.test(seg), 'worker 分支不得重新声明 head（hub 已有）')
})

/* ─────────────── 4. 刷新按钮在两种视图下都可用 ─────────────── */

test('轮询依赖里带 tick（刷新按钮靠它触发重拉）', () => {
  const code = stripComments(client)
  const i = code.search(/(?:var|let|const) timer = setInterval\(load, 4000\)/)
  assert.ok(i >= 0, '应存在轮询 timer')
  const seg = code.slice(i, i + 400)
  assert.match(seg, /\}, \[setState, state\.mode, tick\]\)/, '依赖数组应含 tick（否则刷新按钮无效）')
})
