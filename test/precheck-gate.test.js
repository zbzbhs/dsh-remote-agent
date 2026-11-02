import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRemoteTools } from '../lib/hub/tools.js'

function setup(report) {
  const tools = new Map()
  const calls = []
  let created = 0
  const node = { nodeId: 'n1', online: true, status: 'online', hello: { caps: ['fs', 'exec', 'selfcheck'] }, roots: ['D:\\work'] }
  const registry = {
    list: () => [node],
    onlineNodes: () => [node],
    pickAutoNode: () => 'n1',
    getNode: () => node,
    fsRequest: async (...args) => { calls.push(args); return typeof report === 'function' ? report() : report },
    createTask: () => { created += 1 },
    listTasks: () => [],
    taskView: () => null,
    getTask: () => null,
    limits: { ackTimeoutMs: 100 },
  }
  registerRemoteTools({
    ctx: { tools: { register(def) { tools.set(def.name, def); return () => {} } } },
    registry,
    pulls: {},
    defaults: {},
  })
  return { tools, calls, created: () => created }
}

const args = { goal: 'echo ok', mode: 'exec', approval: 'manual', workspace: 'D:\\work' }

test('remote_task refreshes selfcheck before dispatch by default', async () => {
  const env = setup({ verdict: 'ok', blockingFailures: [] })
  const result = await env.tools.get('remote_task').execute(args)
  assert.equal(result.status, 'pending_approval')
  assert.equal(env.created(), 1)
  assert.equal(env.calls.length, 1)
  assert.deepEqual(env.calls[0].slice(0, 3), ['n1', 'selfcheck', { purpose: 'exec' }])
})

test('a blocked fresh gate fails before creating a task', async () => {
  const env = setup({ verdict: 'blocked', blockingFailures: [{ id: 'root-writable' }] })
  await assert.rejects(env.tools.get('remote_task').execute(args), /root-writable/)
  assert.equal(env.created(), 0)
})

test('precheck:false explicitly skips the network probe', async () => {
  const env = setup({ verdict: 'blocked', blockingFailures: [{ id: 'root-writable' }] })
  const result = await env.tools.get('remote_task').execute({ ...args, precheck: false })
  assert.equal(result.status, 'pending_approval')
  assert.equal(env.calls.length, 0)
  assert.equal(env.created(), 1)
})
