import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerAdvancedTools, TRANSFER_CHUNK_BYTES } from '../lib/hub/advanced-tools.js'
import { createFileTransferService } from '../lib/node/file-transfer-service.js'
import { createSessionGate } from '../lib/hub/session-gate.js'

function harness(t, { sessionGate = null, corruptRead = false, onFsRequest = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshra-advanced-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const remote = path.join(dir, 'remote')
  fs.mkdirSync(remote)
  const service = createFileTransferService({ roots: [remote] })
  t.after(() => service.dispose?.())
  const definitions = new Map()
  const calls = []
  const registry = {
    pickNode: () => ({ nodeId: 'worker', online: true }),
    onlineNodes: () => [{ nodeId: 'worker' }],
    pickAutoNode: () => 'worker',
    async fsRequest(nodeId, op, input) {
      calls.push({ nodeId, op, input })
      await onFsRequest?.({ nodeId, op, input, calls, service })
      if (op === 'fileStat') return service.stat(input)
      if (op === 'fileRead') {
        const result = service.readChunk(input)
        if (corruptRead) result.base64 = Buffer.from('corrupt').toString('base64')
        return result
      }
      if (op === 'fileBegin') return service.beginWrite(input)
      if (op === 'fileWrite') return service.writeChunk(input)
      if (op === 'fileCommit') return service.commit(input)
      if (op === 'fileAbort') return service.abort(input)
      if (op === 'desktopCapture') return { id: 'shot1', width: 2, height: 1, bytes: 4, sha256: createHash('sha256').update('PNG!').digest('hex'), format: 'png', capturedAt: new Date().toISOString() }
      if (op === 'desktopRead') return { id: 'shot1', offset: 0, length: 4, base64: Buffer.from('PNG!').toString('base64'), eof: true }
      if (op === 'desktopRelease') return { id: input.id, released: true }
      throw new Error(`unexpected op ${op}`)
    },
  }
  const ctx = { tools: { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) } } }
  const audit = []
  registerAdvancedTools({ ctx, registry, stateDir: dir, sessionGate, audit: { record: (...x) => audit.push(x) } })
  return { dir, remote, definitions, calls, audit }
}

test('remote_file requires confirmation before upload', async (t) => {
  const h = harness(t)
  const localPath = path.join(h.dir, 'a.txt')
  fs.writeFileSync(localPath, 'abc')
  await assert.rejects(h.definitions.get('remote_file').execute({ action: 'send', path: path.join(h.remote, 'a.txt'), localPath }), /confirm/)
  assert.equal(fs.existsSync(path.join(h.remote, 'a.txt')), false)
})

test('remote_file send/stat/fetch round-trips exact bytes and audits', async (t) => {
  const h = harness(t)
  const localPath = path.join(h.dir, 'a.bin')
  const target = path.join(h.remote, 'nested.bin')
  const returned = path.join(h.dir, 'returned.bin')
  fs.writeFileSync(localPath, Buffer.from([0, 1, 2, 255]))
  const sent = await h.definitions.get('remote_file').execute({ action: 'send', path: target, localPath, confirm: 'yes' })
  assert.equal(sent.size, 4)
  const stat = await h.definitions.get('remote_file').execute({ action: 'stat', path: target })
  assert.equal(stat.size, 4)
  const fetched = await h.definitions.get('remote_file').execute({ action: 'fetch', path: target, localPath: returned })
  assert.deepEqual(fs.readFileSync(returned), Buffer.from([0, 1, 2, 255]))
  assert.equal(fetched.sha256, sent.sha256)
  assert.deepEqual(h.audit.map((x) => x[0]), ['file.send', 'file.fetch'])
})

test('fetch hash mismatch never promotes partial bytes', async (t) => {
  const h = harness(t, { corruptRead: true })
  fs.writeFileSync(path.join(h.remote, 'a.txt'), 'original')
  const localPath = path.join(h.dir, 'bad.txt')
  await assert.rejects(h.definitions.get('remote_file').execute({ action: 'fetch', path: path.join(h.remote, 'a.txt'), localPath }), /SHA256|offset|size/)
  assert.equal(fs.existsSync(localPath), false)
  assert.equal(fs.readdirSync(h.dir).some((x) => x.includes('.part-')), false)
})

test('remote_screenshot downloads verified PNG and releases id', async (t) => {
  const h = harness(t)
  const result = await h.definitions.get('remote_screenshot').execute({})
  assert.deepEqual(fs.readFileSync(result.localPath), Buffer.from('PNG!'))
  assert.equal(h.calls.at(-1).op, 'desktopRelease')
  assert.equal(h.audit[0][0], 'desktop.capture')
})

test('session gate blocks advanced tools before any RPC', async (t) => {
  const h = harness(t, { sessionGate: createSessionGate({ required: true }) })
  await assert.rejects(h.definitions.get('remote_screenshot').execute({}, { agent: { id: 's1' } }), /remote-agent on/)
  assert.equal(h.calls.length, 0)
})

test('send caps reads to the declared size when the local source grows', async (t) => {
  const localPath = { current: null }
  let writes = 0
  const h = harness(t, {
    onFsRequest({ op }) {
      if (op !== 'fileWrite') return
      writes += 1
      if (writes > 3) throw new Error('bounded RPC guard: retry storm')
      if (writes === 1) fs.appendFileSync(localPath.current, Buffer.from('X'))
    },
  })
  localPath.current = path.join(h.dir, 'growing.bin')
  const original = Buffer.alloc(TRANSFER_CHUNK_BYTES + 1, 0x61)
  fs.writeFileSync(localPath.current, original)
  const target = path.join(h.remote, 'growing.bin')

  const result = await h.definitions.get('remote_file').execute({
    action: 'send', path: target, localPath: localPath.current, confirm: 'yes',
  })

  assert.equal(result.size, original.length)
  assert.deepEqual(fs.readFileSync(target), original)
  assert.equal(writes, 2)
  const writeCalls = h.calls.filter((call) => call.op === 'fileWrite')
  assert.equal(Buffer.from(writeCalls[1].input.base64, 'base64').length, 1)
})

test('send aborts non-offset errors even when they carry expectedOffset', async (t) => {
  let writes = 0
  const h = harness(t, {
    onFsRequest({ op }) {
      if (op !== 'fileWrite') return
      writes += 1
      if (writes > 1) throw new Error('non-offset error was retried')
      const error = new Error('declared size exceeded')
      error.code = 'artifact-too-large'
      error.expectedOffset = 0
      throw error
    },
  })
  const localPath = path.join(h.dir, 'source.bin')
  fs.writeFileSync(localPath, 'abcd')

  await assert.rejects(
    h.definitions.get('remote_file').execute({
      action: 'send', path: path.join(h.remote, 'target.bin'), localPath, confirm: 'yes',
    }),
    (error) => error.code === 'artifact-too-large',
  )
  assert.equal(writes, 1)
  assert.equal(h.calls.filter((call) => call.op === 'fileAbort').length, 1)
})

test('send still resumes a genuine offset conflict', async (t) => {
  let injected = false
  const h = harness(t, {
    onFsRequest({ op }) {
      if (op !== 'fileWrite' || injected) return
      injected = true
      const error = new Error('resume at zero')
      error.code = 'offset-conflict'
      error.expectedOffset = 0
      throw error
    },
  })
  const localPath = path.join(h.dir, 'resume.bin')
  fs.writeFileSync(localPath, 'abcd')
  const target = path.join(h.remote, 'resume.bin')

  await h.definitions.get('remote_file').execute({
    action: 'send', path: target, localPath, confirm: 'yes',
  })
  assert.equal(fs.readFileSync(target, 'utf8'), 'abcd')
  assert.equal(h.calls.filter((call) => call.op === 'fileWrite').length, 2)
})

test('fetch no-clobber link rejects a target appearing at final publish', async (t) => {
  const h = harness(t)
  const remotePath = path.join(h.remote, 'source.bin')
  const localPath = path.join(h.dir, 'race.bin')
  fs.writeFileSync(remotePath, 'downloaded')
  const originalLink = fs.linkSync
  t.mock.method(fs, 'linkSync', (temp, target) => {
    fs.writeFileSync(target, 'external')
    return originalLink(temp, target)
  })

  await assert.rejects(
    h.definitions.get('remote_file').execute({
      action: 'fetch', path: remotePath, localPath,
    }),
    /already exists|no-clobber/,
  )
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'external')
  assert.equal(fs.readdirSync(h.dir).some((name) => name.includes('.part-')), false)
})

test('screenshot releases capture when local target validation fails', async (t) => {
  const h = harness(t)
  const localPath = path.join(h.dir, 'existing.png')
  fs.writeFileSync(localPath, 'keep')

  await assert.rejects(
    h.definitions.get('remote_screenshot').execute({ localPath }),
    /already exists/,
  )
  assert.deepEqual(h.calls.map((call) => call.op), ['desktopCapture', 'desktopRelease'])
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'keep')
})
