import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createSelfCheckService } from '../lib/node/selfcheck-service.js'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selfcheck-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function healthyService(root, extra = {}) {
  return createSelfCheckService({
    roots: [root],
    runner: { kind: 'fake', run() {} },
    capabilities: ['fs', 'exec', 'artifact', 'agent'],
    ...extra,
  })
}

test('agent readiness performs real root I/O and leaves no probe files', async (t) => {
  const root = tempRoot(t)
  const report = await healthyService(root).check({ purpose: 'agent' })

  assert.equal(report.verdict, 'ready')
  assert.deepEqual(report.blockingFailures, [])
  assert.deepEqual(report.warnings, [])
  assert.deepEqual(fs.readdirSync(root), [])
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  assert.ok(report.checks.some((check) => check.id === 'runner' && check.status === 'pass'))
  assert.ok(report.checks.some((check) => check.id === 'capability:agent' && check.status === 'pass'))
  assert.equal(report.checks.some((check) => check.id === 'capability:exec'), false)
})

test('desktop failure warns agent and exec but blocks GUI, including gui alias', async (t) => {
  const root = tempRoot(t)
  const service = healthyService(root, {
    desktopCheck: async () => ({
      status: 'fail',
      expected: 'unlocked interactive desktop',
      actual: 'desktop is locked',
      fix: 'Unlock the worker desktop.',
    }),
  })

  for (const request of [{ purpose: 'agent' }, { purpose: 'exec' }, { gui: false }]) {
    const report = await service.check(request)
    assert.equal(report.verdict, 'warn')
    assert.deepEqual(report.blockingFailures, [])
    assert.deepEqual(report.warnings.map((check) => check.id), ['desktop'])
  }

  for (const request of [{ purpose: 'gui' }, { gui: true }]) {
    const report = await service.check(request)
    assert.equal(report.verdict, 'blocked')
    assert.deepEqual(report.blockingFailures.map((check) => check.id), ['desktop'])
    assert.deepEqual(report.warnings, [])
  }
})

test('exec readiness checks its own capability without depending on agent runner or agentMode', async (t) => {
  const root = tempRoot(t)
  const fileRoot = path.join(root, 'not-a-directory')
  fs.writeFileSync(fileRoot, 'x')
  const service = createSelfCheckService({
    roots: [fileRoot],
    capabilities: { agent: false, exec: true },
  })

  const report = await service.check({ purpose: 'exec' })
  assert.equal(report.verdict, 'blocked')
  assert.deepEqual(report.blockingFailures.map((check) => check.id), ['root:0'])
  assert.equal(report.checks.some((check) => check.id === 'runner'), false)
  assert.equal(report.checks.some((check) => check.id === 'capability:agent'), false)
  for (const check of report.checks) {
    assert.deepEqual(Object.keys(check), ['id', 'name', 'severity', 'status', 'expected', 'actual', 'fix'])
  }
  assert.equal(report.checks.find((check) => check.id === 'capability:exec').status, 'pass')
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)

  const executable = createSelfCheckService({
    roots: [root],
    capabilities: { agent: false, exec: true },
  })
  assert.equal((await executable.check({ purpose: 'exec' })).verdict, 'ready')
})

test('agent readiness uses current agentMode and runner availability on every check', async (t) => {
  const root = tempRoot(t)
  const capabilities = { agent: true, exec: true }
  const runner = { kind: 'fake', available: true, run() {} }
  const service = createSelfCheckService({ roots: [root], runner, capabilities })

  assert.equal((await service.check({ purpose: 'agent' })).verdict, 'ready')

  runner.available = false
  capabilities.agent = false
  const blocked = await service.check({ purpose: 'agent' })
  assert.equal(blocked.verdict, 'blocked')
  assert.deepEqual(blocked.blockingFailures.map((check) => check.id), ['runner', 'capability:agent'])
  assert.equal((await service.check({ purpose: 'exec' })).verdict, 'ready')
})

test('empty roots and absent GUI probe fail closed for their respective purposes', async (t) => {
  const root = tempRoot(t)
  const noRoots = await healthyService(root, { roots: [] }).check({ purpose: 'agent' })
  assert.equal(noRoots.verdict, 'blocked')
  assert.deepEqual(noRoots.blockingFailures.map((check) => check.id), ['roots'])

  const noDesktop = await healthyService(root).check({ purpose: 'gui' })
  assert.equal(noDesktop.verdict, 'blocked')
  assert.deepEqual(noDesktop.blockingFailures.map((check) => check.id), ['desktop'])
})

test('injected desktop diagnostics are normalized to JSON-safe check data', async (t) => {
  const root = tempRoot(t)
  const report = await healthyService(root, {
    desktopCheck: () => ({
      status: 'fail',
      expected: 1n,
      actual: { size: 2n },
      fix: 'diagnostic',
    }),
  }).check({ purpose: 'agent' })

  const serialized = JSON.stringify(report)
  assert.ok(serialized)
  assert.deepEqual(JSON.parse(serialized), report)
  assert.deepEqual(report.warnings[0].actual, { size: '2' })
})
