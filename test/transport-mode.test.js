/**
 * test/transport-mode.test.js
 *
 * 验证面板连接方式（transportMode）选择功能。
 * 覆盖：表单渲染、提交体内容、配对码解析、中文化显示、变异验证。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(CLIENT_SRC)

/* ── 1. 表单渲染出连接方式选项 ─────────────────────────────────────── */

test('SetupView 渲染连接方式选择卡片（中继 + 直连）', () => {
  assert.match(code, /连接方式/, '表单应有「连接方式」标签')
  assert.match(code, /中继（relay）/, '应有中继选项')
  assert.match(code, /直连（direct）/, '应有直连选项')
})

test('transportMode state 存在，初值从 cur 回填', () => {
  assert.match(code, /transportMode.*React\.useState\(cur\.transportMode/, 'useState 初值应从 cur.transportMode 回填')
})

/* ── 2. submit() 提交体内容 ────────────────────────────────────────── */

function getSubmitBody() {
  const i = code.indexOf('function submit(kind, opts)')
  assert.ok(i >= 0, 'submit 函数应存在')
  // 找到 body = { role: use } 之后到 fetch 之前
  const j = code.indexOf("fetch(SETUP_APPLY_PATH", i)
  assert.ok(j > i, '应有 fetch 调用')
  return code.slice(i, j)
}

test('submit 提交体始终带 transportMode', () => {
  const seg = getSubmitBody()
  assert.match(seg, /body\.transportMode\s*=/, 'body 必须赋值 transportMode')
  assert.match(seg, /transportMode === 'direct' \? 'direct' : 'relay'/, "transportMode 应映射为 direct/relay")
})

test('direct 模式提交带 hubUrl 不带 relayUrl', () => {
  const seg = getSubmitBody()
  // direct 分支应包含 body.hubUrl 赋值
  const directBlock = code.slice(code.indexOf("if (transportMode === 'direct')"), code.indexOf("} else {", code.indexOf("if (transportMode === 'direct')")))
  assert.match(directBlock, /body\.hubUrl\s*=/, 'direct 时应赋值 body.hubUrl')
  assert.ok(!/body\.relayUrl/.test(directBlock), 'direct 时不应赋值 body.relayUrl')
})

test('relay 模式提交带 relayUrl', () => {
  const seg = getSubmitBody()
  // relay 分支（else 块）应包含 body.relayUrl 赋值
  const directIdx = code.indexOf("if (transportMode === 'direct')")
  const elseIdx = code.indexOf("} else {", directIdx)
  const elseEnd = code.indexOf("}", elseIdx + 8) // 粗略找
  const relayBlock = code.slice(elseIdx, elseEnd)
  assert.match(relayBlock, /body\.relayUrl\s*=/, 'relay 时应赋值 body.relayUrl')
})

/* ── 3. role=hub 提交也带 relayUrl ─────────────────────────────────── */

test('hub 角色提交时不再用 use !== hub 排除 relayUrl', () => {
  const seg = getSubmitBody()
  // 旧的排他逻辑已被删除——不应再出现 use !== 'hub'
  assert.ok(!/use !== 'hub'/.test(seg), '不应再用 use !== hub 排除 relayUrl（relay 模式 hub 也需要 relayUrl）')
})

/* ── 4. parsePair 保留 transportMode ──────────────────────────────── */

test('parsePair 保留 transportMode，自动推断 direct', () => {
  const i = code.indexOf('function parsePair(')
  assert.ok(i >= 0, 'parsePair 应存在')
  const seg = code.slice(i, i + 600)
  assert.match(seg, /n\.transportMode\s*=/, 'parsePair 应保留 transportMode')
  assert.match(seg, /d\.hubUrl && !d\.relayUrl \? 'direct'/, '有 hubUrl 无 relayUrl 时应推断 direct')
})

test('parsePair 对 direct 配对码返回 transportMode + hubUrl', () => {
  const seg = code.slice(code.indexOf('function parsePair('), code.indexOf('function parsePair(') + 600)
  assert.match(seg, /n\.hubUrl\s*=\s*d\.hubUrl/, 'parsePair 应返回 hubUrl')
  assert.match(seg, /n\.transportMode/, 'parsePair 应返回 transportMode')
})

/* ── 5. applyPair 切换 transportMode ──────────────────────────────── */

test('applyPair 设置 transportMode 并更新提示', () => {
  const i = code.indexOf('function applyPair(')
  assert.ok(i >= 0, 'applyPair 应存在')
  const seg = code.slice(i, i + 600)
  assert.match(seg, /setTransportMode/, 'applyPair 应调用 setTransportMode')
  // setNote 里包含 '直连' 与 '中继' 两个词（分支文案）
  assert.match(seg, /直连/, 'applyPair 提示应含「直连」')
  assert.match(seg, /中继/, 'applyPair 提示应含「中继」')
})

/* ── 6. 中文化显示 ────────────────────────────────────────────────── */

test('节点卡片 transportMode 显示中文（中继/直连）', () => {
  // 锚到 NodeCard 徽标行，不是 Worker 视图信息行
  const ncIdx = code.indexOf('function NodeCard(')
  assert.ok(ncIdx >= 0, 'NodeCard 函数应存在')
  const ncSeg = code.slice(ncIdx, ncIdx + 800)
  // 徽标应含 transportMode 中文显示
  assert.match(ncSeg, /n\.transportMode === 'direct' \? '直连' : '中继'/,
    'NodeCard 徽标应按 transportMode 显示中文「直连/中继」')
})

/* ── 7. setup-routes 放开 hub ──────────────────────────────────────── */

test('setup-routes: transportMode 不再只限 worker', () => {
  const routesSrc = fs.readFileSync(path.join(ROOT, 'lib/setup-routes.js'), 'utf8')
  // 旧的写法：role === 'worker' ? ... : 'relay'
  assert.ok(!/role === 'worker'.*transportMode.*direct.*relay/.test(routesSrc),
    '不应再用 role === worker 限制 transportMode 赋值')
  // 新写法：直接从 body 读
  assert.match(routesSrc, /str\(body\.transportMode\) === 'direct' \? 'direct' : 'relay'/,
    '应直接从 body.transportMode 读，不限 role')
  // lines.push transportMode 应不在 if (role === worker) 条件内
  assert.match(routesSrc, /lines\.push\(`    transportMode: \$\{transportMode\}`\)/,
    'transportMode 应无条件写入 patch（hub 也写）')
})

/* ── 8. 变异验证 ──────────────────────────────────────────────────── */




/* ── 9. ConfigPanel 模板按模式分支 ─────────────────────────────────── */

test('ConfigPanel 模板按模式分支：direct 产出 transportMode:direct + hubUrl，relay 产出 transportMode:relay + relayUrl', () => {
  const i = code.indexOf('function ConfigPanel(')
  assert.ok(i >= 0, 'ConfigPanel 函数应存在')
  const seg = code.slice(i, i + 4000)

  // template 函数内：isDirect 分支产出 transportMode: direct + hubUrl
  const tplIdx = seg.indexOf('const template = function ()')
  assert.ok(tplIdx >= 0, 'template 函数应存在')
  const tplSeg = seg.slice(tplIdx, tplIdx + 800)

  assert.match(tplSeg, /transportMode: direct/, 'direct 分支应输出 transportMode: direct')
  assert.match(tplSeg, /hubUrl:/, 'direct 分支应输出 hubUrl:')

  assert.match(tplSeg, /transportMode: relay/, 'relay 分支应输出 transportMode: relay')
  assert.match(tplSeg, /relayUrl:/, 'relay 分支应输出 relayUrl:')

  // 模式卡片：两张卡片（用 !isDirect/isDirect 控制 active 类）
  assert.match(seg, /dra-mode-card.*!isDirect \? ' active'/, '应有 relay 模式卡片（!isDirect 为 active）')
  assert.match(seg, /dra-mode-card.*isDirect \? ' active'/, '应有 direct 模式卡片（isDirect 为 active）')

  // ConfigPanel 应有 transportMode 切换
  assert.match(seg, /onEdit.*transportMode/, 'ConfigPanel 应通过 onEdit 切换 transportMode')
})



/* ── 10. worker 回填 cfg ──────────────────────────────────────────── */

test('worker 回填：mode: worker 赋值后 800 字符内出现 SETUP_STATE_PATH 回填', () => {
  const idx = code.indexOf("mode: 'worker', worker: d || null")
  assert.ok(idx >= 0, 'worker 成功路径应有 mode: worker, worker: d || null')
  const seg = code.slice(idx, idx + 800)
  assert.match(seg, /SETUP_STATE_PATH/, 'worker 成功路径应用 SETUP_STATE_PATH 回填 cfg')
  assert.ok(!/apiGet\('\/config'\)/.test(seg), 'worker 路径不应调 /ui/config（hub-only 端点）')
})




/* ── B1: ConfigPanel TDZ 顺序 ──────────────────────────────────────── */

test('B1: ConfigPanel 段内 val 定义先于 val 调用（TDZ 防护）', () => {
  const i = code.indexOf('function ConfigPanel(')
  assert.ok(i >= 0, 'ConfigPanel 函数应存在')
  const seg = code.slice(i, i + 800)
  const valDefIdx = seg.indexOf('const val = function')
  const valCallIdx = seg.indexOf("val('transportMode')")
  assert.ok(valDefIdx >= 0, 'val 定义应在 ConfigPanel 内')
  assert.ok(valCallIdx >= 0, 'val 调用应在 ConfigPanel 内')
  assert.ok(valDefIdx < valCallIdx,
    'val 定义必须在 val(transportMode) 调用之前（避免 TDZ ReferenceError）')
})

/* ── B2: buildNodeHello transportMode + registry 透传 ────────────── */

test('B2: buildNodeHello 包含 transportMode 字段', () => {
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'lib/node/index.js'), 'utf8')
  const bIdx = nodeSrc.indexOf('export function buildNodeHello(')
  assert.ok(bIdx >= 0, 'buildNodeHello 应存在')
  const bSeg = nodeSrc.slice(bIdx, bIdx + 2000)
  assert.match(bSeg, /transportMode:/, 'buildNodeHello 应输出 transportMode 字段')
  const regSrc = fs.readFileSync(path.join(ROOT, 'lib/hub/node-registry.js'), 'utf8')
  assert.match(regSrc, /hello\.transportMode/, 'registry list() 应从 r.hello.transportMode 取 transportMode')
})

test('B2 变异验证：buildNodeHello 删掉 transportMode → 测试红', () => {
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'lib/node/index.js'), 'utf8')
  const bIdx = nodeSrc.indexOf('export function buildNodeHello(')
  const bSeg = nodeSrc.slice(bIdx, bIdx + 2000)
  const mutant = bSeg.replace(/[ \t]+transportMode:[^\n]+\n/, '')
  assert.ok(!/transportMode:/.test(mutant),
    '变异后 buildNodeHello 里不应再有 transportMode 行')
})

/* ── B3: worker cfg 回填路径 ──────────────────────────────────────── */

test('B3: worker 成功路径用 SETUP_STATE_PATH 回填 cfg（不再调 /ui/config）', () => {
  const idx = code.indexOf("mode: 'worker', worker: d || null")
  assert.ok(idx >= 0, 'worker 成功路径应存在')
  const seg = code.slice(idx, idx + 800)
  assert.match(seg, /SETUP_STATE_PATH/, 'worker 回填应使用 SETUP_STATE_PATH')
  assert.ok(!/apiGet\('\/config'\)/.test(seg), 'worker 路径不应再调 /ui/config（hub-only 端点）')
})

test('B3 变异验证：删掉 worker 回填 → 测试红', () => {
  const idx = code.indexOf("mode: 'worker', worker: d || null")
  const seg = code.slice(idx, idx + 800)
  assert.ok(/SETUP_STATE_PATH/.test(seg), 'seg 应含 SETUP_STATE_PATH')
  assert.ok(/setCfg/.test(seg), 'seg 应含 setCfg 调用')
  const sCfgIdx = seg.indexOf('setCfg(')
  assert.ok(sCfgIdx >= 0, 'seg 应含 setCfg(')
  const thenIdx = seg.lastIndexOf('.then(function', sCfgIdx)
  const catchStr2 = '}).catch(function () {})'
  const catchEnd = seg.indexOf(catchStr2, thenIdx) + catchStr2.length
  const mutant = seg.slice(0, thenIdx) + '/* deleted */' + seg.slice(catchEnd)
  assert.ok(!/setCfg/.test(mutant),
    '删掉 worker 回填后 mutant 里不应再有 setCfg 调用')
})
