// 工具返回值必须能安全出 DSH 边界（防回归）
//
// 背景：DSH 用 walkJsonValue 校验工具返回值，拒绝：类实例 / NaN / Infinity /
// -0 / undefined / 循环引用 / 带额外属性的数组。一旦被拒，工具报
// `returned invalid output: value is not lossless JSON` —— 而**工具其实已执行成功**。
// 这是最坏的失败形态（有副作用却报失败），所以必须锁死。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS = path.join(HERE, '..', 'lib', 'hub', 'tools.js')

/** 复刻 DSH 的 walkJsonValue 判定（只保留会 return undefined 的分支）。 */
function dshAccepts(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0)
  if (typeof v !== 'object') return false
  if (seen.has(v)) return false
  seen.add(v)
  try {
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return false
      if (Reflect.ownKeys(v).length !== v.length + 1) return false
      for (let i = 0; i < v.length; i += 1) if (!dshAccepts(v[i], seen)) return false
      return true
    }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.keys(v).every((k) => dshAccepts(v[k], seen))
  } finally {
    seen.delete(v)
  }
}

/** 从源码里取出 toPlainJson（它未导出，所以求值一次）。 */
function loadToPlainJson() {
  const src = fs.readFileSync(TOOLS, 'utf8')
  const start = src.indexOf('function toPlainJson(v) {')
  assert.ok(start >= 0, 'tools.js 里应存在 toPlainJson 函数（净化层被删了？）')
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.ok(end > 0, 'toPlainJson 花括号配对失败')
  const fnSrc = src.slice(start, end)
   
  return new Function(`${fnSrc}\nreturn toPlainJson`)()
}

const toPlainJson = loadToPlainJson()

test('净化层：类实例（DSH 拒绝）能被净化', () => {
  class FakeErr extends Error {}
  const input = { error: new FakeErr('boom'), ok: true }
  assert.equal(dshAccepts(input), false, '前提：类实例本身应被 DSH 拒绝')
  assert.equal(dshAccepts(toPlainJson(input)), true, '净化后应被 DSH 接受')
})

test('净化层：NaN / Infinity / -0 被归一为 0', () => {
  const cleaned = toPlainJson({ a: NaN, b: Infinity, c: -Infinity, d: -0 })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal(cleaned.a, 0)
  assert.equal(cleaned.b, 0)
  assert.equal(cleaned.c, 0)
  assert.equal(cleaned.d, 0)
})

test('净化层：undefined 属性被丢弃（不是变成 null）', () => {
  const cleaned = toPlainJson({ a: undefined, b: 1 })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal('a' in cleaned, false, 'undefined 属性应被丢弃')
  assert.equal(cleaned.b, 1)
})

test('净化层：函数与 Symbol 被丢弃', () => {
  const cleaned = toPlainJson({ f: () => 1, s: Symbol('x'), ok: 'yes' })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal('f' in cleaned, false)
  assert.equal('s' in cleaned, false)
  assert.equal(cleaned.ok, 'yes')
})

test('净化层：循环引用不抛错、不泄漏', () => {
  const o = { a: 1 }
  o.self = o
  const cleaned = toPlainJson(o)
  assert.equal(dshAccepts(cleaned), true)
  assert.equal(cleaned.a, 1)
})

test('净化层：数组额外属性被丢弃（保留元素）', () => {
  const a = [1, 2, 3]
  a.extra = 'x'
  const cleaned = toPlainJson({ list: a })
  assert.equal(dshAccepts(cleaned), true)
  assert.deepEqual(cleaned.list, [1, 2, 3])
})

test('净化层：Date 等内建实例被转成普通对象', () => {
  const cleaned = toPlainJson({ d: new Date('2026-01-01T00:00:00Z') })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal(Object.getPrototypeOf(cleaned.d), Object.prototype)
})

test('净化层：正常对象原样通过（不做多余改动）', () => {
  const input = { taskId: 't1', accepted: true, workspace: '', count: 3, nested: { x: [1, 2] } }
  assert.deepEqual(toPlainJson(input), input)
})

test('净化层：null 保持 null（DSH 接受 null）', () => {
  const cleaned = toPlainJson({ a: null, b: 1 })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal(cleaned.a, null)
})

test('净化层：BigInt 转字符串（JSON 无法表示）', () => {
  const cleaned = toPlainJson({ big: 10n })
  assert.equal(dshAccepts(cleaned), true)
  assert.equal(cleaned.big, '10')
})

test('收口：reg() 必须给每个工具包上净化层', () => {
  const src = fs.readFileSync(TOOLS, 'utf8')
  // reg 里必须出现 toPlainJson 调用（形态可能是 toPlainJson(value) 或
  // toPlainJson(dropNullForSchema(value, schema))）
  const regStart = src.indexOf('const reg = (definition) => {')
  assert.ok(regStart >= 0, '应存在 reg 定义')
  const regEnd = src.indexOf('\n  }', regStart)
  const regBody = src.slice(regStart, regEnd)
  assert.match(regBody, /toPlainJson\(/, 'reg 必须把 execute 的返回值过一遍 toPlainJson')
})

test('收口：toPlainJson 必须覆盖 tools.js 全部 22 个工具（经 reg 注册）', () => {
  const src = fs.readFileSync(TOOLS, 'utf8')
  // 工具名以三种形态出现，全部要数进来（否则新增工具时这条断言会静默漏掉）：
  //   1. 8 个任务工具：`reg({ name: 'remote_x', ... })` —— 出现 `name: '...'`
  //   2. 4 个只读文件工具：`fsOp('remote_x', ...)` —— 第一实参独立一行、4 空格缩进
  //   3. 4 个写操作工具（2026-10-20）：`writeOp('remote_x', ...)` —— 同样形态
  const direct = [...src.matchAll(/name: '(remote_[a-z_]+)'/g)].map((m) => m[1])
  const viaHelper = [...src.matchAll(/\n {4}'(remote_[a-z_]+)',\n/g)].map((m) => m[1])
  const names = [...direct, ...viaHelper]
  assert.equal(names.length, 22, `应有 22 个工具，实际 ${names.length}: ${names.join(', ')}`)
  // 直接 reg：原 11 + selfcheck/agents/interrupt = 14；高级文件/截图工具在 advanced-tools.js 单独收口。
  const regCalls = (src.match(/\n {2}reg\(\{/g) || []).length
  assert.equal(regCalls, 14, `应有 14 处直接 reg({...}) 调用，实际 ${regCalls}`)
  assert.match(src, /const fsOp = /, '只读文件工具应经 fsOp 包装注册（统一 fsRequest 错误转译）')
  assert.match(src, /const writeOp = /, '写操作工具应经 writeOp 包装注册（强制 confirm 二次确认）')
  // 锁住工具集合本身：新增/删除工具时这条会提醒你同步文档与断言
  assert.deepEqual(
    names.slice().sort(),
    [
      'remote_agents',
      'remote_cancel',
      'remote_delete',
      'remote_grep',
      'remote_handoff',
      'remote_interrupt',
      'remote_kill',
      'remote_ls',
      'remote_manifest',
      'remote_mkdir',
      'remote_move',
      'remote_nodes',
      'remote_port',
      'remote_ps',
      'remote_pull',
      'remote_purge',
      'remote_read',
      'remote_selfcheck',
      'remote_status',
      'remote_task',
      'remote_tree',
      'remote_write',
    ],
    '工具集合变了 —— 记得同步 README、check-doc-drift 与这里的断言',
  )
})

/** 从源码取出 dropNullForSchema 并求值。 */
function loadDropNull() {
  const src = fs.readFileSync(TOOLS, 'utf8')
  const start = src.indexOf('function dropNullForSchema(value, schema) {')
  assert.ok(start >= 0, 'tools.js 里应存在 dropNullForSchema')
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
   
  return new Function(`${src.slice(start, end)}\nreturn dropNullForSchema`)()
}

const dropNull = loadDropNull()

test('schema 收口：可选字段的 null 被删除（object 类型）', () => {
  const schema = {
    type: 'object',
    properties: { taskId: { type: 'string' }, error: { type: 'object' } },
    required: ['taskId'],
  }
  const out = dropNull({ taskId: 't1', error: null }, schema)
  assert.equal('error' in out, false, 'error 应被删除')
  assert.equal(out.taskId, 't1')
})

test('schema 收口：可选字段的 null 被删除（number 类型）', () => {
  const schema = {
    type: 'object',
    properties: { startedAt: { type: 'number' }, endedAt: { type: 'number' } },
    required: [],
  }
  const out = dropNull({ startedAt: null, endedAt: 123 }, schema)
  assert.equal('startedAt' in out, false)
  assert.equal(out.endedAt, 123)
})

test('schema 收口：required 字段的 null 不删（不掩盖实现 bug）', () => {
  const schema = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }
  const out = dropNull({ taskId: null }, schema)
  assert.equal(out.taskId, null, 'required 字段应保留，让校验暴露真问题')
})

test('schema 收口：schema 显式允许 null 时保留', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: ['string', 'null'] }, b: { type: 'string', nullable: true } },
  }
  const out = dropNull({ a: null, b: null }, schema)
  assert.equal(out.a, null, 'type 数组含 null 应保留')
  assert.equal(out.b, null, 'nullable:true 应保留')
})

test('schema 收口：非 null 值不受影响', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }
  const input = { a: 'x', b: 0, c: false }
  assert.deepEqual(dropNull(input, schema), input)
})

test('schema 收口：没有 schema 时原样返回', () => {
  const input = { a: null }
  assert.deepEqual(dropNull(input, undefined), input)
  assert.deepEqual(dropNull(input, null), input)
})

test('收口：reg 必须同时应用 dropNullForSchema 与 toPlainJson', () => {
  const src = fs.readFileSync(TOOLS, 'utf8')
  const regStart = src.indexOf('const reg = (definition) => {')
  const regEnd = src.indexOf('\n  }', regStart)
  const regBody = src.slice(regStart, regEnd)
  assert.match(regBody, /dropNullForSchema\(value, schema\)/, 'reg 必须先按 schema 删 null')
  assert.match(regBody, /toPlainJson\(/, 'reg 必须净化')
  // 顺序：先 dropNull 再 toPlainJson
  assert.ok(
    regBody.indexOf('dropNullForSchema') < regBody.indexOf('toPlainJson'),
    'dropNullForSchema 必须在 toPlainJson 之前（净化会丢弃 undefined）',
  )
})
