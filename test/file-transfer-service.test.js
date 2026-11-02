import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { createFileTransferService } from '../lib/node/file-transfer-service.js'

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-transfer-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  const service = createFileTransferService({
    roots: [root],
    caseInsensitive: process.platform === 'win32',
    maxChunkBytes: 4,
    maxFileBytes: 1024,
    ...overrides,
  })
  return { root, service }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('stat and readChunk expose size, whole-file sha256, bounded base64 and eof', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'input.bin')
  const content = Buffer.from([0, 1, 2, 3, 4, 255])
  fs.writeFileSync(file, content)

  const stat = service.stat({ path: file })
  assert.equal(stat.size, content.length)
  assert.equal(stat.sha256, sha256(content))

  const first = service.readChunk({ path: file, offset: 0, length: 4 })
  assert.equal(first.base64, content.subarray(0, 4).toString('base64'))
  assert.equal(first.sha256, stat.sha256)
  assert.equal(first.size, content.length)
  assert.equal(first.eof, false)

  const last = service.readChunk({ path: file, offset: 4, length: 4 })
  assert.deepEqual(Buffer.from(last.base64, 'base64'), content.subarray(4))
  assert.equal(last.eof, true)
  assert.equal(last.offset, 4)
  assert.equal(last.length, 2)
})

test('beginWrite, writeChunk and commit persist the exact bytes and hash', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'nested-output.bin')
  const content = Buffer.from([9, 8, 7, 6, 5, 4])
  const expectedHash = sha256(content)

  const begun = service.beginWrite({ path: file, size: content.length, sha256: expectedHash })
  assert.match(begun.transferId, /^ft-/)
  assert.equal(begun.expectedOffset, 0)

  const first = service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: content.subarray(0, 4).toString('base64'),
  })
  assert.equal(first.expectedOffset, 4)
  service.writeChunk({
    transferId: begun.transferId,
    offset: 4,
    base64: content.subarray(4).toString('base64'),
  })

  const committed = service.commit({ transferId: begun.transferId })
  assert.equal(committed.size, content.length)
  assert.equal(committed.sha256, expectedHash)
  assert.deepEqual(fs.readFileSync(file), content)
  assert.deepEqual(fs.readdirSync(root), ['nested-output.bin'])
})

test('writeChunk reports expectedOffset without consuming a conflicting chunk', (t) => {
  const { root, service } = fixture(t)
  const content = Buffer.from('abcd')
  const begun = service.beginWrite({
    path: path.join(root, 'offset.bin'),
    size: content.length,
    sha256: sha256(content),
  })

  assert.throws(
    () => service.writeChunk({
      transferId: begun.transferId,
      offset: 2,
      base64: Buffer.from('cd').toString('base64'),
    }),
    (error) => {
      assert.equal(error.code, 'offset-conflict')
      assert.equal(error.expectedOffset, 0)
      assert.equal(error.actualOffset, 2)
      assert.equal(error.details.expectedOffset, 0)
      return true
    },
  )

  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: content.toString('base64'),
  })
  service.commit({ transferId: begun.transferId })
  assert.equal(fs.readFileSync(path.join(root, 'offset.bin'), 'utf8'), 'abcd')
})

test('commit hash mismatch cleans up and preserves an overwritten target', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'protected.bin')
  fs.writeFileSync(file, 'old-content')
  const actual = Buffer.from('replacement')
  const begun = service.beginWrite({
    path: file,
    size: actual.length,
    sha256: '0'.repeat(64),
    overwrite: true,
  })
  for (let offset = 0; offset < actual.length; offset += 4) {
    service.writeChunk({
      transferId: begun.transferId,
      offset,
      base64: actual.subarray(offset, offset + 4).toString('base64'),
    })
  }

  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => {
      assert.equal(error.code, 'hash-mismatch')
      assert.equal(error.expectedSha256, '0'.repeat(64))
      assert.equal(error.actualSha256, sha256(actual))
      return true
    },
  )
  assert.equal(fs.readFileSync(file, 'utf8'), 'old-content')
  assert.deepEqual(fs.readdirSync(root), ['protected.bin'])
  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => error.code === 'transfer-not-found',
  )
})

test('writes default to no overwrite and explicit overwrite replaces atomically', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'existing.txt')
  fs.writeFileSync(file, 'before')
  assert.throws(
    () => service.beginWrite({ path: file, size: 5, sha256: sha256('after') }),
    (error) => error.code === 'already-exists',
  )
  assert.equal(fs.readFileSync(file, 'utf8'), 'before')

  const begun = service.beginWrite({
    path: file,
    size: 5,
    sha256: sha256('after'),
    overwrite: true,
  })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('aft').toString('base64'),
  })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 3,
    base64: Buffer.from('er').toString('base64'),
  })
  service.commit({ transferId: begun.transferId })
  assert.equal(fs.readFileSync(file, 'utf8'), 'after')
})

test('abort removes temporary data without publishing the target', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'aborted.bin')
  const content = Buffer.from('abcd')
  const begun = service.beginWrite({
    path: file,
    size: content.length,
    sha256: sha256(content),
  })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: content.toString('base64'),
  })
  assert.deepEqual(service.abort({ transferId: begun.transferId }), {
    transferId: begun.transferId,
    aborted: true,
  })
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(root), [])
  assert.throws(
    () => service.writeChunk({
      transferId: begun.transferId,
      offset: 4,
      base64: content.toString('base64'),
    }),
    (error) => error.code === 'transfer-not-found',
  )
})

test('realpath, roots and denyPaths reject direct and symlink escapes', (t) => {
  const { root, service } = fixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-transfer-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const secret = path.join(outside, 'secret.bin')
  fs.writeFileSync(secret, 'secret')

  assert.throws(() => service.stat({ path: 'relative.bin' }), (error) => {
    return error.code === 'workspace-denied'
  })
  assert.throws(() => service.stat({ path: secret }), (error) => {
    return error.code === 'workspace-denied'
  })

  const deniedFile = path.join(root, 'credentials.txt')
  fs.writeFileSync(deniedFile, 'denied')
  const denied = createFileTransferService({
    roots: [root],
    denyPaths: ['credentials.txt'],
    caseInsensitive: process.platform === 'win32',
  })
  assert.throws(() => denied.stat({ path: deniedFile }), (error) => {
    return error.code === 'workspace-denied'
  })

  const fileLink = path.join(root, 'file-link.bin')
  const dirLink = path.join(root, 'dir-link')
  try {
    fs.symlinkSync(secret, fileLink, 'file')
    fs.symlinkSync(outside, dirLink, 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  assert.throws(() => service.stat({ path: fileLink }), (error) => {
    return error.code === 'workspace-denied'
  })
  assert.throws(() => service.beginWrite({
    path: path.join(dirLink, 'escape.bin'),
    size: 0,
    sha256: sha256(Buffer.alloc(0)),
  }), (error) => error.code === 'workspace-denied')
})

test('chunk and total-size limits fail before publishing data', (t) => {
  const { root, service } = fixture(t)
  const input = path.join(root, 'limits.bin')
  fs.writeFileSync(input, 'abcd')
  assert.throws(
    () => service.readChunk({ path: input, offset: 0, length: 5 }),
    (error) => error.code === 'artifact-too-large' && error.maxChunkBytes === 4,
  )
  assert.throws(
    () => service.beginWrite({
      path: path.join(root, 'too-large.bin'),
      size: 1025,
      sha256: '0'.repeat(64),
    }),
    (error) => error.code === 'artifact-too-large' && error.maxFileBytes === 1024,
  )

  const begun = service.beginWrite({
    path: path.join(root, 'chunk-limit.bin'),
    size: 5,
    sha256: sha256('abcde'),
  })
  assert.throws(
    () => service.writeChunk({
      transferId: begun.transferId,
      offset: 0,
      base64: Buffer.from('abcde').toString('base64'),
    }),
    (error) => error.code === 'artifact-too-large' && error.maxChunkBytes === 4,
  )
  service.abort({ transferId: begun.transferId })
  assert.deepEqual(fs.readdirSync(root), ['limits.bin'])
})

test('empty files commit and read back with a canonical digest and eof', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'empty.bin')
  const empty = Buffer.alloc(0)
  const begun = service.beginWrite({ path: file, size: 0, sha256: sha256(empty) })
  const committed = service.commit({ transferId: begun.transferId })
  assert.equal(committed.transferId, begun.transferId)
  assert.equal(committed.path, file)
  assert.equal(committed.size, 0)
  assert.equal(committed.sha256, sha256(empty))
  const chunk = service.readChunk({ path: file, offset: 0, length: 4 })
  assert.equal(chunk.base64, '')
  assert.equal(chunk.size, 0)
  assert.equal(chunk.sha256, sha256(empty))
  assert.equal(chunk.eof, true)
})

test('incomplete commit reports the resume offset and preserves the transfer', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'resume.bin')
  const begun = service.beginWrite({ path: file, size: 4, sha256: sha256('abcd') })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('ab').toString('base64'),
  })
  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => error.code === 'size-mismatch' && error.expectedOffset === 2,
  )
  const resumed = service.writeChunk({
    transferId: begun.transferId,
    offset: 2,
    base64: Buffer.from('cd').toString('base64'),
  })
  assert.equal(resumed.transferId, begun.transferId)
  assert.equal(resumed.offset, 4)
  assert.equal(resumed.expectedOffset, 4)
  service.commit({ transferId: begun.transferId })
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcd')
})

test('commit rechecks no-overwrite if the target appears after beginWrite', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'race.bin')
  const begun = service.beginWrite({ path: file, size: 3, sha256: sha256('new') })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('new').toString('base64'),
  })
  fs.writeFileSync(file, 'external')
  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => error.code === 'already-exists',
  )
  assert.equal(fs.readFileSync(file, 'utf8'), 'external')
  assert.deepEqual(fs.readdirSync(root), ['race.bin'])
})

test('malformed base64 is rejected without advancing expectedOffset', (t) => {
  const { root, service } = fixture(t)
  const file = path.join(root, 'base64.bin')
  const begun = service.beginWrite({ path: file, size: 4, sha256: sha256('abcd') })
  assert.throws(
    () => service.writeChunk({ transferId: begun.transferId, offset: 0, base64: '%%%%' }),
    (error) => error.code === 'invalid-base64',
  )
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('abcd').toString('base64'),
  })
  service.commit({ transferId: begun.transferId })
})

test('stat and readChunk reject directories as non-file paths', (t) => {
  const { root, service } = fixture(t)
  const directory = path.join(root, 'directory')
  fs.mkdirSync(directory)
  assert.throws(() => service.stat({ path: directory }), (error) => {
    return error.code === 'workspace-denied'
  })
  assert.throws(() => service.readChunk({ path: directory }), (error) => {
    return error.code === 'workspace-denied'
  })
})

test('commit uses atomic no-clobber when a target appears at final publish', (t) => {
  const file = { current: null }
  const fsImpl = {
    ...fs,
    renameSync(temp, target) {
      if (target === file.current) fs.writeFileSync(target, 'external')
      return fs.renameSync(temp, target)
    },
    linkSync(temp, target) {
      if (target === file.current) fs.writeFileSync(target, 'external')
      return fs.linkSync(temp, target)
    },
  }
  const { root, service } = fixture(t, { fs: fsImpl })
  file.current = path.join(root, 'atomic-race.bin')
  const begun = service.beginWrite({ path: file.current, size: 3, sha256: sha256('new') })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('new').toString('base64'),
  })

  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => error.code === 'already-exists',
  )
  assert.equal(fs.readFileSync(file.current, 'utf8'), 'external')
  assert.deepEqual(fs.readdirSync(root), ['atomic-race.bin'])
})

test('unsupported no-clobber hard links fail conservatively without rename', (t) => {
  let renamed = false
  const fsImpl = {
    ...fs,
    linkSync() {
      const error = new Error('hard links unavailable')
      error.code = 'EPERM'
      throw error
    },
    renameSync(temp, target) {
      renamed = true
      return fs.renameSync(temp, target)
    },
  }
  const { root, service } = fixture(t, { fs: fsImpl })
  const file = path.join(root, 'no-link.bin')
  const begun = service.beginWrite({ path: file, size: 3, sha256: sha256('new') })
  service.writeChunk({
    transferId: begun.transferId,
    offset: 0,
    base64: Buffer.from('new').toString('base64'),
  })

  assert.throws(
    () => service.commit({ transferId: begun.transferId }),
    (error) => error.code === 'no-clobber-unavailable',
  )
  assert.equal(renamed, false)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('readChunk reuses a path size mtime hash cache and invalidates changes', (t) => {
  let hashReads = 0
  const fsImpl = {
    ...fs,
    readSync(fd, buffer, offset, length, position) {
      if (buffer.length === 1024 * 1024) hashReads += 1
      return fs.readSync(fd, buffer, offset, length, position)
    },
  }
  const { root, service } = fixture(t, { fs: fsImpl })
  const file = path.join(root, 'cached.bin')
  fs.writeFileSync(file, 'abcdefgh')
  const firstStat = service.stat({ path: file })
  const afterStat = hashReads
  assert.equal(service.readChunk({ path: file, offset: 0, length: 4 }).sha256, firstStat.sha256)
  assert.equal(service.readChunk({ path: file, offset: 4, length: 4 }).sha256, firstStat.sha256)
  assert.equal(hashReads, afterStat)

  fs.writeFileSync(file, 'ABCDEFGH')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  const changed = service.readChunk({ path: file, offset: 0, length: 4 })
  assert.equal(changed.sha256, sha256('ABCDEFGH'))
  assert.ok(hashReads > afterStat)
})

test('abortAll and dispose close pending writes and remove temporary files', (t) => {
  const { root, service } = fixture(t)
  const first = service.beginWrite({
    path: path.join(root, 'first.bin'), size: 4, sha256: sha256('abcd'),
  })
  const second = service.beginWrite({
    path: path.join(root, 'second.bin'), size: 4, sha256: sha256('efgh'),
  })
  service.writeChunk({
    transferId: first.transferId,
    offset: 0,
    base64: Buffer.from('ab').toString('base64'),
  })

  assert.equal(service.abortAll().aborted, 2)
  assert.deepEqual(fs.readdirSync(root), [])
  assert.throws(
    () => service.writeChunk({
      transferId: first.transferId, offset: 2, base64: Buffer.from('cd').toString('base64'),
    }),
    (error) => error.code === 'transfer-not-found',
  )
  assert.throws(
    () => service.abort({ transferId: second.transferId }),
    (error) => error.code === 'transfer-not-found',
  )

  service.beginWrite({ path: path.join(root, 'third.bin'), size: 0, sha256: sha256('') })
  assert.equal(service.dispose().aborted, 1)
  assert.equal(service.dispose().aborted, 0)
  assert.deepEqual(fs.readdirSync(root), [])
})
