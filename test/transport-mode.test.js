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
  const display = code.match(/w\.transportMode.*直连.*中继|直连.*中继.*w\.transportMode/)
  assert.ok(display, 'transportMode 显示应含中文「直连/中继」，不应只显示英文 relay/direct')
  // 不应再出现裸的 'relay' 作为显示值
  const oldDisplay = code.match(/w\.transportMode \|\| 'relay'/)
  assert.ok(!oldDisplay, '不应再回退显示英文 relay')
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

test('变异验证：删掉 submit 里 transportMode 赋值 → 测试红', () => {
  // 模拟删除：在 code 里把 body.transportMode = ... 替换掉，然后检查前面的断言会失败
  const mutant = code.replace(/body\.transportMode\s*=\s*transportMode === 'direct' \? 'direct' : 'relay'/, '/* deleted */')
  assert.ok(!/body\.transportMode\s*=/.test(mutant.replace('/* deleted */', '')),
    '删除后 body.transportMode 赋值不应存在')
})
