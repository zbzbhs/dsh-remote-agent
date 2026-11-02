/**
 * Explicit, task-independent file transfer primitives.
 *
 * Paths are confined to realpath-normalized roots and checked against denyPaths.
 * No task, artifact-manifest, or pull state is consulted by this module.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { isDenied } from './exec.js'
import { normalizePath } from '../glob.js'
import { ERROR_CODE } from '../protocol.js'

export const DEFAULT_TRANSFER_CHUNK_BYTES = 256 * 1024
export const DEFAULT_TRANSFER_MAX_BYTES = 512 * 1024 * 1024

export class FileTransferError extends Error {
  constructor(message, code = ERROR_CODE.INTERNAL, details = undefined) {
    super(message)
    this.name = 'FileTransferError'
    this.code = code
    this.details = details
    if (details && typeof details === 'object') Object.assign(this, details)
  }
}

function positiveInteger(value, fallback, name) {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return result
}

/** Create a synchronous file-transfer service. All public errors carry a stable code. */
export function createFileTransferService(cfg = {}) {
  const fsImpl = cfg.fs ?? fs
  const roots = Array.isArray(cfg.roots) ? cfg.roots : []
  const denyPaths = Array.isArray(cfg.denyPaths) ? cfg.denyPaths : []
  const caseInsensitive = cfg.caseInsensitive === true
  const maxChunkBytes = positiveInteger(
    cfg.maxChunkBytes,
    DEFAULT_TRANSFER_CHUNK_BYTES,
    'maxChunkBytes',
  )
  const maxFileBytes = positiveInteger(
    cfg.maxFileBytes,
    DEFAULT_TRANSFER_MAX_BYTES,
    'maxFileBytes',
  )

  const realpath = (value) => (
    typeof fsImpl.realpathSync.native === 'function'
      ? fsImpl.realpathSync.native(value)
      : fsImpl.realpathSync(value)
  )
  const normalized = (value) => normalizePath(value, { caseInsensitive })
  const denied = (value) => isDenied(value, denyPaths, { caseInsensitive })

  function requireAbsolute(value) {
    if (typeof value !== 'string' || value === '') {
      throw new FileTransferError('path is required', ERROR_CODE.WORKSPACE_DENIED)
    }
    if (!path.isAbsolute(value)) {
      throw new FileTransferError(`path must be absolute: ${value}`, ERROR_CODE.WORKSPACE_DENIED)
    }
    if (denied(value)) {
      throw new FileTransferError(`path denied: ${value}`, ERROR_CODE.WORKSPACE_DENIED)
    }
  }

  function assertAllowed(value) {
    const candidate = normalized(value)
    const allowed = roots.some((root) => {
      let base
      try {
        base = realpath(root)
      } catch {
        // Unavailable roots deny their entire subtree.
        return false
      }
      const normalizedRoot = normalized(base)
      return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`)
    })
    if (!allowed) {
      throw new FileTransferError(
        `path outside allowed roots: ${value}`,
        ERROR_CODE.WORKSPACE_DENIED,
      )
    }
    if (denied(value)) {
      throw new FileTransferError(`path denied by denyPaths: ${value}`, ERROR_CODE.WORKSPACE_DENIED)
    }
    return value
  }

  function resolveExisting(value) {
    requireAbsolute(value)
    let resolved
    try {
      resolved = realpath(value)
    } catch {
      throw new FileTransferError(`path not found: ${value}`, ERROR_CODE.ARTIFACT_MISSING)
    }
    return assertAllowed(resolved)
  }

  function hashFd(fd) {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    for (;;) {
      const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    return hash.digest('hex')
  }

  function cachedFileHash(file, fd, info) {
    const key = normalized(file)
    const now = Date.now()
    for (const [cachedKey, entry] of hashCache) {
      if (entry.expiresAt <= now) hashCache.delete(cachedKey)
    }
    const cached = hashCache.get(key)
    if (
      cached
      && cached.size === info.size
      && cached.mtimeMs === info.mtimeMs
      && cached.expiresAt > now
    ) return cached.sha256

    const sha256 = hashFd(fd)
    while (hashCache.size >= HASH_CACHE_MAX_ENTRIES) {
      hashCache.delete(hashCache.keys().next().value)
    }
    hashCache.set(key, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256,
      expiresAt: now + HASH_CACHE_TTL_MS,
    })
    return sha256
  }

  function openFile(value) {
    const file = resolveExisting(value)
    let fd
    try {
      fd = fsImpl.openSync(file, 'r')
      const info = fsImpl.fstatSync(fd)
      if (!info.isFile()) {
        throw new FileTransferError(`not a regular file: ${file}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      if (info.size > maxFileBytes) {
        throw new FileTransferError(
          `file too large: ${info.size} bytes (max ${maxFileBytes})`,
          ERROR_CODE.ARTIFACT_TOO_LARGE,
          { size: info.size, maxFileBytes },
        )
      }
      return { file, fd, stat: info }
    } catch (error) {
      if (fd !== undefined) {
        try { fsImpl.closeSync(fd) } catch { /* preserve the original error */ }
      }
      if (error instanceof FileTransferError) throw error
      throw new FileTransferError(
        `open failed: ${String(error?.message ?? error)}`,
        ERROR_CODE.INTERNAL,
      )
    }
  }

  function stat({ path: requested } = {}) {
    const opened = openFile(requested)
    try {
      return {
        path: opened.file,
        size: opened.stat.size,
        sha256: cachedFileHash(opened.file, opened.fd, opened.stat),
        mtimeMs: opened.stat.mtimeMs,
      }
    } finally {
      fsImpl.closeSync(opened.fd)
    }
  }

  function readChunk({ path: requested, offset = 0, length = maxChunkBytes } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FileTransferError('offset must be a non-negative safe integer', 'invalid-offset')
    }
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new FileTransferError('length must be a positive safe integer', 'invalid-length')
    }
    if (length > maxChunkBytes) {
      throw new FileTransferError(
        `chunk too large: ${length} bytes (max ${maxChunkBytes})`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
        { maxChunkBytes },
      )
    }
    const opened = openFile(requested)
    try {
      const size = opened.stat.size
      if (offset > size) {
        throw new FileTransferError(
          `offset ${offset} exceeds file size ${size}`,
          'invalid-offset',
          { offset, size },
        )
      }
      const digest = cachedFileHash(opened.file, opened.fd, opened.stat)
      const buffer = Buffer.alloc(Math.min(length, size - offset))
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const count = fsImpl.readSync(
          opened.fd,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          offset + bytesRead,
        )
        if (count === 0) break
        bytesRead += count
      }
      return {
        path: opened.file,
        offset,
        length: bytesRead,
        base64: buffer.subarray(0, bytesRead).toString('base64'),
        sha256: digest,
        size,
        eof: offset + bytesRead >= size,
      }
    } finally {
      fsImpl.closeSync(opened.fd)
    }
  }

  function lstatOrNull(value) {
    try {
      return fsImpl.lstatSync(value)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  function resolveWritable(value) {
    requireAbsolute(value)
    const requested = path.resolve(value)
    const existing = lstatOrNull(requested)
    if (existing) {
      let resolved
      try {
        resolved = realpath(requested)
      } catch {
        throw new FileTransferError(`path not found: ${value}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      assertAllowed(resolved)
      if (!fsImpl.statSync(resolved).isFile()) {
        throw new FileTransferError(`not a regular file: ${resolved}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      return { file: resolved, existed: true }
    }
    const parent = resolveExisting(path.dirname(requested))
    if (!fsImpl.statSync(parent).isDirectory()) {
      throw new FileTransferError(`parent is not a directory: ${parent}`, ERROR_CODE.WORKSPACE_DENIED)
    }
    const file = path.join(parent, path.basename(requested))
    assertAllowed(file)
    return { file, existed: false }
  }

  const writes = new Map()
  // Short-lived whole-file digests shared by stat/readChunk; keyed by file identity metadata.
  const hashCache = new Map()
  const HASH_CACHE_TTL_MS = 5_000
  const HASH_CACHE_MAX_ENTRIES = 32

  function requireHash(value) {
    if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) {
      throw new FileTransferError('sha256 must be 64 hexadecimal characters', 'invalid-sha256')
    }
    return value.toLowerCase()
  }

  function requireWrite(transferId) {
    const session = writes.get(transferId)
    if (!session) {
      throw new FileTransferError(
        `write transfer not found: ${transferId}`,
        'transfer-not-found',
        { transferId },
      )
    }
    return session
  }

  function discard(session) {
    writes.delete(session.transferId)
    if (session.fd !== undefined) {
      try { fsImpl.closeSync(session.fd) } catch { /* already closed */ }
      session.fd = undefined
    }
    try { fsImpl.unlinkSync(session.tempPath) } catch (error) {
      if (error?.code !== 'ENOENT') session.cleanupError = error
    }
  }

  function decodeChunk(value) {
    if (typeof value !== 'string' || value === '') {
      throw new FileTransferError('base64 chunk must be a non-empty string', 'invalid-base64')
    }
    if (value.length > Math.ceil(maxChunkBytes / 3) * 4 + 4) {
      throw new FileTransferError(
        `base64 chunk exceeds maxChunkBytes ${maxChunkBytes}`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
        { maxChunkBytes },
      )
    }
    if (!/^[a-z\d+/]*={0,2}$/i.test(value) || value.length % 4 !== 0) {
      throw new FileTransferError('base64 chunk is not canonical base64', 'invalid-base64')
    }
    const buffer = Buffer.from(value, 'base64')
    if (buffer.toString('base64') !== value) {
      throw new FileTransferError('base64 chunk is not canonical base64', 'invalid-base64')
    }
    if (buffer.length === 0) {
      throw new FileTransferError('zero-length chunks are not allowed', 'invalid-length')
    }
    if (buffer.length > maxChunkBytes) {
      throw new FileTransferError(
        `chunk too large: ${buffer.length} bytes (max ${maxChunkBytes})`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
        { size: buffer.length, maxChunkBytes },
      )
    }
    return buffer
  }

  function beginWrite({ path: requested, size, sha256, overwrite = false } = {}) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new FileTransferError('size must be a non-negative safe integer', 'invalid-size')
    }
    if (size > maxFileBytes) {
      throw new FileTransferError(
        `file too large: ${size} bytes (max ${maxFileBytes})`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
        { size, maxFileBytes },
      )
    }
    const expectedHash = requireHash(sha256)
    const resolved = resolveWritable(requested)
    if (resolved.existed && overwrite !== true) {
      throw new FileTransferError(
        `target already exists (pass overwrite:true to replace): ${resolved.file}`,
        'already-exists',
        { path: resolved.file },
      )
    }
    const transferId = `ft-${randomUUID()}`
    const tempPath = path.join(
      path.dirname(resolved.file),
      `.${path.basename(resolved.file)}.dsh-transfer-${randomUUID()}.tmp`,
    )
    let fd
    try {
      fd = fsImpl.openSync(tempPath, 'wx', 0o600)
    } catch (error) {
      throw new FileTransferError(
        `create temporary file failed: ${String(error?.message ?? error)}`,
        ERROR_CODE.INTERNAL,
      )
    }
    writes.set(transferId, {
      transferId,
      requestedPath: requested,
      path: resolved.file,
      tempPath,
      fd,
      size,
      sha256: expectedHash,
      overwrite: overwrite === true,
      expectedOffset: 0,
    })
    return {
      transferId,
      path: resolved.file,
      size,
      sha256: expectedHash,
      expectedOffset: 0,
    }
  }

  function writeChunk({ transferId, offset, base64 } = {}) {
    const session = requireWrite(transferId)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FileTransferError('offset must be a non-negative safe integer', 'invalid-offset')
    }
    if (offset !== session.expectedOffset) {
      throw new FileTransferError(
        `offset conflict: expected ${session.expectedOffset}, received ${offset}`,
        'offset-conflict',
        { expectedOffset: session.expectedOffset, actualOffset: offset, transferId },
      )
    }
    const buffer = decodeChunk(base64)
    const nextOffset = offset + buffer.length
    if (nextOffset > session.size) {
      throw new FileTransferError(
        `chunk exceeds declared size ${session.size}`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
        { expectedOffset: offset, size: session.size, maxFileBytes },
      )
    }
    try {
      let written = 0
      while (written < buffer.length) {
        const count = fsImpl.writeSync(
          session.fd,
          buffer,
          written,
          buffer.length - written,
          offset + written,
        )
        if (count === 0) throw new Error('zero-byte write')
        written += count
      }
    } catch (error) {
      discard(session)
      throw new FileTransferError(
        `write failed: ${String(error?.message ?? error)}`,
        ERROR_CODE.INTERNAL,
        { transferId, expectedOffset: offset },
      )
    }
    session.expectedOffset = nextOffset
    return { transferId, offset: nextOffset, expectedOffset: nextOffset }
  }

  function abort({ transferId } = {}) {
    const session = requireWrite(transferId)
    discard(session)
    return { transferId, aborted: true }
  }

  function commit({ transferId } = {}) {
    const session = requireWrite(transferId)
    if (session.expectedOffset !== session.size) {
      throw new FileTransferError(
        `incomplete transfer: ${session.expectedOffset}/${session.size} bytes`,
        'size-mismatch',
        {
          transferId,
          expectedOffset: session.expectedOffset,
          expectedSize: session.size,
          actualSize: session.expectedOffset,
        },
      )
    }

    try {
      const resolved = resolveWritable(session.requestedPath)
      if (resolved.file !== session.path || (resolved.existed && !session.overwrite)) {
        throw new FileTransferError(
          'target changed after beginWrite',
          'already-exists',
          { path: session.path },
        )
      }
      fsImpl.closeSync(session.fd)
      session.fd = undefined
      const fd = fsImpl.openSync(session.tempPath, 'r')
      let actualHash
      let actualSize
      try {
        actualSize = fsImpl.fstatSync(fd).size
        actualHash = hashFd(fd)
      } finally {
        fsImpl.closeSync(fd)
      }
      if (actualSize !== session.size) {
        throw new FileTransferError(
          `temporary file size mismatch: ${actualSize}/${session.size}`,
          'size-mismatch',
          { expectedSize: session.size, actualSize },
        )
      }
      if (actualHash !== session.sha256) {
        throw new FileTransferError(
          `sha256 mismatch: expected ${session.sha256}, received ${actualHash}`,
          ERROR_CODE.HASH_MISMATCH,
          { expectedSha256: session.sha256, actualSha256: actualHash },
        )
      }
      const beforeRename = resolveWritable(session.requestedPath)
      if (beforeRename.file !== session.path || (beforeRename.existed && !session.overwrite)) {
        throw new FileTransferError(
          'target changed before atomic rename',
          'already-exists',
          { path: session.path },
        )
      }
      if (session.overwrite) {
        fsImpl.renameSync(session.tempPath, session.path)
      } else {
        // Same-directory hard link publishes atomically and never replaces a winner.
        try {
          fsImpl.linkSync(session.tempPath, session.path)
        } catch (cause) {
          const exists = cause?.code === 'EEXIST'
          throw new FileTransferError(
            exists
              ? `target already exists: ${session.path}`
              : `atomic no-clobber is unavailable: ${String(cause?.message ?? cause)}`,
            exists ? 'already-exists' : 'no-clobber-unavailable',
            { path: session.path },
          )
        }
        try { fsImpl.unlinkSync(session.tempPath) } catch { /* published; temp is best effort */ }
      }
      writes.delete(transferId)
      return { transferId, path: session.path, size: session.size, sha256: actualHash }
    } catch (error) {
      discard(session)
      if (error instanceof FileTransferError) throw error
      throw new FileTransferError(
        `commit failed: ${String(error?.message ?? error)}`,
        ERROR_CODE.INTERNAL,
        { transferId },
      )
    }
  }

  /** Abort every in-flight upload; used on teardown so no fd or temp file outlives the worker. */
  function abortAll() {
    let aborted = 0
    for (const session of [...writes.values()]) {
      discard(session)
      aborted += 1
    }
    hashCache.clear()
    return { aborted }
  }

  function dispose() {
    return abortAll()
  }

  return { stat, readChunk, beginWrite, writeChunk, commit, abort, abortAll, dispose }
}
