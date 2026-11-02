import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionGate } from '../lib/hub/session-gate.js'
import { createRemoteAgentProvider } from '../lib/hub/subagent-provider.js'

const agent = (id = 's1') => ({ id })

test('session gate is backward compatible when not required', () => {
  const gate = createSessionGate()
  assert.equal(gate.isEnabled(agent()), true)
  assert.equal(gate.guard({ name: 'remote_task', agent: agent() }), undefined)
  assert.deepEqual(gate.commands(), [])
})

test('required gate is fail closed, including a missing agent', () => {
  const gate = createSessionGate({ required: true })
  assert.match(gate.guard({ name: 'remote_task' }), /remote-agent on/)
  assert.match(gate.guard({ name: 'remote_task', agent: agent() }), /remote-agent on/)
  assert.equal(gate.guard({ name: 'pwsh', agent: agent() }), undefined)
})

test('on/off/status are scoped to the exact session', async () => {
  const gate = createSessionGate({ required: true })
  const commands = gate.commands()
  assert.deepEqual(commands.map((c) => c.name), ['remote-agent', 'remote-use'])
  const command = commands[0]
  assert.equal((await command.handler({ agent: agent(), rawInput: 'on' })).kind, 'success')
  assert.equal(gate.isEnabled(agent()), true)
  assert.equal(gate.isEnabled(agent('s2')), false)
  assert.match((await command.handler({ agent: agent(), rawInput: 'status' })).text, /已开启/)
  await command.handler({ agent: agent(), rawInput: 'off' })
  assert.equal(gate.isEnabled(agent()), false)
  assert.equal((await command.handler({ agent: agent(), rawInput: 'nonsense' })).kind, 'error')
})

test('a session without an id cannot be accidentally authorized', async () => {
  const gate = createSessionGate({ required: true })
  const command = gate.commands()[0]
  assert.equal((await command.handler({ agent: {}, rawInput: 'on' })).kind, 'error')
  assert.equal(gate.isEnabled({}), false)
})

test('subagent provider cannot bypass the session gate', async () => {
  const gate = createSessionGate({ required: true })
  let created = 0
  const registry = {
    limits: { ackTimeoutMs: 1000 },
    onlineNodes: () => [{ nodeId: 'n1', online: true, hello: { caps: [] } }],
    getNode: () => ({ nodeId: 'n1', online: true, hello: { caps: [] } }),
    createTask: () => { created += 1 },
    cancelTask: () => {},
    awaitAccepted: () => new Promise(() => {}),
    awaitTerminal: () => new Promise(() => {}),
  }
  const provider = createRemoteAgentProvider({ registry, sessionGate: gate })
  const parent = agent('parent')
  await assert.rejects(
    provider.start({ parent, label: 'n1', prompt: [{ type: 'text', text: 'work' }] }),
    /remote-agent on/,
  )
  assert.equal(created, 0)
  gate.enable(parent)
  const run = await provider.start({ parent, label: 'n1', prompt: [{ type: 'text', text: 'work' }] })
  assert.equal(created, 1)
  await run.dispose()
})
