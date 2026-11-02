// 工具声明的 output 契约（2026-11-02 激活失败事故回归）
//
// ═══════════════════════════════════════════════════════════════════════════
// 事故
// ═══════════════════════════════════════════════════════════════════════════
//
// 0.10.0 装到主机 profile 后，DSH 报：
//
//   dsh: warning: 1 entry did not activate
//   remote-agent (dsh-remote-agent): TypeError: tool "remote_write" must declare
//   output { schema, render, presentationMeta? }
//
// `ctx.tools.register` 的校验（dsh-tools/lib/index.js:2977）是**注册期**硬校验：
//
//   if (output === void 0 || typeof output !== 'object'
//       || typeof output.render !== 'function' || ...) throw new TypeError(...)
//
// 所以**一个**工具声明不合法，整个插件条目不激活 —— 24 个工具全没、面板全空。
// 而单测之所以全绿，是因为测试里的 ctx.tools.register 是假实现，只存 map 不校验。
//
// 本测试把真实校验条件复刻一遍，对**两个注册入口的每一个工具**逐一检查，
// 让"少写 render"在单测阶段就炸，而不是等装到 profile 里才发现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRemoteTools, withOutputContract } from '../lib/hub/tools.js'
import { registerAdvancedTools } from '../lib/hub/advanced-tools.js'

/** 复刻 dsh-tools 的 register() 前置校验；通过则返回 undefined，否则返回错误文本。 */
function contractError(name, output) {
  if (output === undefined) return `tool "${name}" must declare output { schema, render, presentationMeta? }`
  if (typeof output !== 'object' || output === null) return `tool "${name}" output must be an object`
  if (typeof output.render !== 'function') return `tool "${name}" must declare output.render as a function`
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    return `tool "${name}" presentationMeta must be a function`
  }
  if (output.schema === undefined || typeof output.schema !== 'object' || output.schema === null) {
    return `tool "${name}" must declare output.schema as an object`
  }
  return undefined
}

function collect() {
  const defs = new Map()
  const ctx = {
    tools: {
      register(def) {
        // 真实 Host 在这里就会抛；测试里先存下来，由断言统一报，便于一次看全。
        defs.set(def.name, def)
        return () => defs.delete(def.name)
      },
    },
  }
  const registry = {
    list: () => [],
    onlineNodes: () => [],
    pickAutoNode: () => 'n1',
    pickNode: () => null,
    getNode: () => null,
    listTasks: () => [],
    taskView: () => null,
    getTask: () => null,
    async fsRequest() { throw new Error('not used') },
    limits: { ackTimeoutMs: 100 },
  }
  registerRemoteTools({ ctx, registry, pulls: {}, defaults: {} })
  registerAdvancedTools({ ctx, registry, stateDir: process.cwd() })
  return defs
}

test('every registered tool declares output { schema, render }', () => {
  const defs = collect()
  assert.ok(defs.size >= 24, `应注册至少 24 个工具，实际 ${defs.size}`)
  const broken = []
  for (const [name, def] of defs) {
    const err = contractError(name, def.output)
    if (err) broken.push(err)
  }
  assert.deepEqual(broken, [], `以下工具会被 Host 拒绝并让整个插件条目不激活：\n${broken.join('\n')}`)
})

test('withOutputContract wraps a bare JSON Schema and keeps an existing render', () => {
  const bare = withOutputContract({ name: 'x', output: { type: 'object', properties: { a: { type: 'string' } } } })
  assert.equal(bare.output.schema.type, 'object')
  assert.equal(typeof bare.output.render, 'function')

  const wrapped = withOutputContract({ name: 'y', output: { schema: { type: 'object' } } })
  assert.equal(wrapped.output.schema.type, 'object')
  assert.equal(typeof wrapped.output.render, 'function')

  const custom = () => [{ type: 'text', text: 'hi' }]
  const kept = withOutputContract({ name: 'z', output: { schema: { type: 'object' }, render: custom } })
  assert.equal(kept.output.render, custom, '已有的 render 不能被覆盖')
})

test('withOutputContract never throws on a malformed declaration', () => {
  for (const output of [undefined, null, 42, 'text']) {
    const fixed = withOutputContract({ name: 'q', output })
    assert.equal(contractError('q', fixed.output), undefined, `output=${String(output)} 应被补齐`)
  }
})

test('the default render is a display-only fallback and never throws', () => {
  const def = withOutputContract({ name: 'r', output: { type: 'object' } })
  const circular = {}
  circular.self = circular
  for (const value of [undefined, null, 42, 'text', circular, { a: 1 }]) {
    const parts = def.output.render({}, value)
    assert.ok(Array.isArray(parts) && parts.length > 0, 'render 必须返回非空内容数组')
    assert.equal(parts[0].type, 'text')
    assert.equal(typeof parts[0].text, 'string')
  }
})
