import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { createDesktopService } from '../lib/node/desktop-service.js'
import { disposeWorkerResources, readDesktopChunk } from '../lib/node/index.js'

function tempStateDir(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  return stateDir
}

test('non-Windows capture is explicitly unsupported without executing a command', async (t) => {
  const stateDir = tempStateDir(t)
  let invoked = false
  const service = createDesktopService({
    stateDir,
    platform: 'linux',
    runCommand: async () => {
      invoked = true
      return { stdout: '', stderr: '' }
    },
  })

  await assert.rejects(service.capture(), (error) => error.code === 'unsupported')
  assert.equal(invoked, false)
})

test('capture returns metadata and readChunk returns only id-addressed bytes', async (t) => {
  const stateDir = tempStateDir(t)
  const payload = Buffer.from('fake-png-content-for-chunking')
  const calls = []
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    randomUUID: () => 'shot-fixed',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      const output = options.env.DSH_REMOTE_SCREENSHOT
      assert.equal(path.dirname(output), path.join(stateDir, 'screenshots'))
      fs.writeFileSync(output, payload)
      return { stdout: JSON.stringify({ width: 1280, height: 720 }), stderr: '' }
    },
  })

  const metadata = await service.capture()
  assert.deepEqual(metadata, {
    id: 'shot-fixed',
    width: 1280,
    height: 720,
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    format: 'png',
    capturedAt: '2026-01-02T03:04:05.000Z',
  })
  assert.equal('path' in metadata, false)
  assert.deepEqual(service.readChunk('shot-fixed', 2, 5), payload.subarray(2, 7))
  assert.match(calls[0].args.join('\n'), /CopyFromScreen/)
  assert.equal(calls[0].options.shell, false)
})

test('TTL cleanup, bounded retention and dispose remove only tracked screenshots', async (t) => {
  const stateDir = tempStateDir(t)
  let clock = 0
  let sequence = 0
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    ttlMs: 1_000,
    maxEntries: 2,
    now: () => clock,
    randomUUID: () => `shot-${++sequence}`,
    runCommand: async (_command, _args, options) => {
      fs.writeFileSync(options.env.DSH_REMOTE_SCREENSHOT, `png-${sequence}`)
      return { stdout: '{"width":10,"height":20}', stderr: '' }
    },
  })

  await service.capture()
  clock = 1_000
  assert.equal(service.cleanup(), 1)
  assert.throws(() => service.readChunk('shot-1', 0, 1), (error) => error.code === 'screenshot-not-found')
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'screenshots')), [])

  await service.capture()
  clock = 1_100
  await service.capture()
  clock = 1_200
  await service.capture()
  assert.throws(() => service.readChunk('shot-2', 0, 1), (error) => error.code === 'screenshot-not-found')
  assert.deepEqual(service.readChunk('shot-3', 0, 1), Buffer.from('p'))
  assert.deepEqual(service.readChunk('shot-4', 0, 1), Buffer.from('p'))
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'screenshots')).sort(), ['shot-3.png', 'shot-4.png'])

  assert.equal(service.dispose(), 2)
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'screenshots')), [])
})

test('oversized captures are rejected and their files are removed', async (t) => {
  const stateDir = tempStateDir(t)
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    maxBytes: 4,
    randomUUID: () => 'too-large',
    runCommand: async (_command, _args, options) => {
      fs.writeFileSync(options.env.DSH_REMOTE_SCREENSHOT, '12345')
      return { stdout: '{"width":1,"height":1}', stderr: '' }
    },
  })

  await assert.rejects(service.capture(), (error) => error.code === 'screenshot-too-large')
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'screenshots')), [])
  assert.throws(() => service.readChunk('too-large', 0, 1), (error) => error.code === 'screenshot-not-found')
})

test('chunk reads enforce bounds and never treat ids as paths', async (t) => {
  const stateDir = tempStateDir(t)
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    maxChunkBytes: 4,
    randomUUID: () => 'bounded',
    runCommand: async (_command, _args, options) => {
      fs.writeFileSync(options.env.DSH_REMOTE_SCREENSHOT, 'abcdef')
      return { stdout: '{"width":1,"height":1}', stderr: '' }
    },
  })
  await service.capture()

  assert.deepEqual(service.readChunk('bounded', 6, 1), Buffer.alloc(0))
  for (const [offset, length] of [[-1, 1], [7, 1], [0, 0], [0, 5]]) {
    assert.throws(() => service.readChunk('bounded', offset, length), (error) => error.code === 'invalid-range')
  }
  assert.throws(
    () => service.readChunk(path.join(stateDir, 'screenshots', 'bounded.png'), 0, 1),
    (error) => error.code === 'screenshot-not-found',
  )
})

test('chunk reads loop through short reads and never zero-fill a truncated file', async (t) => {
  const stateDir = tempStateDir(t)
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    randomUUID: () => 'short-read',
    runCommand: async (_command, _args, options) => {
      fs.writeFileSync(options.env.DSH_REMOTE_SCREENSHOT, 'abcdef')
      return { stdout: '{"width":1,"height":1}', stderr: '' }
    },
  })
  await service.capture()

  const originalReadSync = fs.readSync
  let reads = 0
  t.mock.method(fs, 'readSync', (handle, buffer, offset, length, position) => {
    reads += 1
    return originalReadSync(handle, buffer, offset, Math.min(length, 2), position)
  })
  assert.deepEqual(service.readChunk('short-read', 1, 5), Buffer.from('bcdef'))
  assert.equal(reads, 3)
  t.mock.restoreAll()

  fs.writeFileSync(path.join(stateDir, 'screenshots', 'short-read.png'), 'xy')
  assert.deepEqual(service.readChunk('short-read', 0, 6), Buffer.from('xy'))
})

test('worker desktop response marks eof from actual bytes read plus offset', async (t) => {
  const stateDir = tempStateDir(t)
  const service = createDesktopService({
    stateDir,
    platform: 'win32',
    randomUUID: () => 'eof',
    runCommand: async (_command, _args, options) => {
      fs.writeFileSync(options.env.DSH_REMOTE_SCREENSHOT, 'abcdef')
      return { stdout: '{"width":1,"height":1}', stderr: '' }
    },
  })
  await service.capture()

  assert.deepEqual(readDesktopChunk(service, { id: 'eof', offset: 0, length: 2 }), {
    id: 'eof', offset: 0, length: 2, base64: Buffer.from('ab').toString('base64'), eof: false,
  })
  assert.equal(readDesktopChunk(service, { id: 'eof', offset: 4, length: 2 }).eof, true)
  assert.equal(readDesktopChunk(service, { id: 'eof', offset: 5, length: 4 }).eof, true)
  assert.equal(readDesktopChunk(service, { id: 'eof', offset: 6, length: 4 }).eof, true)
})

test('worker resource teardown disposes screenshots and available upload cleanup API', () => {
  const calls = []
  disposeWorkerResources({
    desktop: { dispose() { calls.push('desktop') } },
    fileTransfer: { abortAll() { calls.push('abortAll') } },
  })
  assert.deepEqual(calls, ['desktop', 'abortAll'])

  calls.length = 0
  disposeWorkerResources({
    desktop: { dispose() { calls.push('desktop') } },
    fileTransfer: {
      dispose() { calls.push('dispose') },
      abortAll() { calls.push('abortAll') },
    },
  })
  assert.deepEqual(calls, ['desktop', 'dispose'])
})
