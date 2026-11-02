/** 高级远程工具：显式文件互传与桌面截图。字节走现有 FS RPC，因此 direct/relay/E2E 语义不变。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { resolveNodeId, withOutputContract } from './tools.js'

export const TRANSFER_CHUNK_BYTES = 256 * 1024
export const TRANSFER_MAX_BYTES = 512 * 1024 * 1024

function cleanName(value, fallback = 'download.bin') {
  const base = Array.from(path.basename(String(value || '')).replace(/[<>:"/\\|?*]/g, '_'), (ch) => ch.charCodeAt(0) < 32 ? '_' : ch).join('')
  return base && base !== '.' && base !== '..' ? base : fallback
}

function ensureLocalTarget(file, overwrite) {
  if (fs.existsSync(file)) {
    if (!overwrite) throw new Error(`local file already exists: ${file}（覆盖需 overwrite:true）`)
    if (!fs.statSync(file).isFile()) throw new Error(`local target is not a regular file: ${file}`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function promoteLocalFile(temp, file, overwrite) {
  if (overwrite) {
    fs.renameSync(temp, file)
    return
  }
  try {
    // A same-directory hard link publishes atomically without replacing a winner.
    fs.linkSync(temp, file)
  } catch (cause) {
    const exists = cause?.code === 'EEXIST'
    const error = new Error(
      exists
        ? `local file already exists: ${file}（覆盖需 overwrite:true）`
        : `atomic no-clobber is unavailable for ${file}: ${String(cause?.message ?? cause)}`,
      { cause },
    )
    error.code = exists ? 'already-exists' : 'no-clobber-unavailable'
    throw error
  }
  fs.unlinkSync(temp)
}

function readLocalChunk(fd, buffer, offset, length = buffer.length) {
  return fs.readSync(fd, buffer, 0, length, offset)
}

function hashLocalPrefix(fd, length) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES)
  let offset = 0
  while (offset < length) {
    const wanted = Math.min(buffer.length, length - offset)
    const count = fs.readSync(fd, buffer, 0, wanted, offset)
    if (count <= 0) throw new Error(`unexpected local EOF at ${offset}`)
    hash.update(buffer.subarray(0, count))
    offset += count
  }
  return hash
}

/**
 * @returns {Array<() => void>} disposers
 */
export function registerAdvancedTools({ ctx, registry, stateDir, sessionGate = null, audit = null }) {
  const disposers = []
  const reg = (definition) => {
    const original = definition.execute
    definition = withOutputContract({
      ...definition,
      async execute(...args) {
        const rejection = sessionGate?.guard?.({ name: definition.name, agent: args[1]?.agent })
        if (rejection) throw new Error(rejection)
        const value = await original.apply(this, args)
        return JSON.parse(JSON.stringify(value))
      },
    })
    disposers.push(ctx.tools.register(definition))
  }

  const rpc = (nodeId, op, params = {}, timeoutMs = 30_000) =>
    registry.fsRequest(nodeId, op, params, { timeoutMs })

  reg({
    name: 'remote_file',
    description: '在主机与副机授权 roots 之间显式互传文件。stat 只看元数据；send 上传需 confirm=yes；fetch 下载到主机。分块校验 offset、完整 SHA256 后原子落盘，与任务产物 remote_pull 相互独立。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stat', 'send', 'fetch'] },
        node: { type: 'string', description: '副机节点 id；仅一台在线时可省略。' },
        path: { type: 'string', description: '副机文件路径，必须位于该节点 roots 内。' },
        localPath: { type: 'string', description: 'send 的主机源文件；fetch 的主机目标文件（省略时存到插件 received 目录）。' },
        overwrite: { type: 'boolean', description: '允许覆盖目标，默认 false。' },
        confirm: { type: 'string', enum: ['yes'], description: 'send 必须显式填 yes。' },
      },
      required: ['action', 'path'], additionalProperties: false,
    },
    output: { schema: { type: 'object' } },
    async execute(args) {
      const nodeId = resolveNodeId(registry, args?.node)
      const remotePath = String(args?.path || '')
      if (!remotePath) throw new Error('path is required')
      const action = args?.action
      const overwrite = args?.overwrite === true

      if (action === 'stat') return rpc(nodeId, 'fileStat', { path: remotePath })

      if (action === 'send') {
        if (args?.confirm !== 'yes') throw new Error('remote_file send 需要 confirm:"yes"')
        const localPath = path.resolve(String(args?.localPath || ''))
        if (!args?.localPath || !fs.statSync(localPath).isFile()) throw new Error(`local source is not a file: ${localPath}`)
        const size = fs.statSync(localPath).size
        if (size > TRANSFER_MAX_BYTES) throw new Error(`file too large: ${size} > ${TRANSFER_MAX_BYTES}`)
        let fd
        let transferId
        try {
          fd = fs.openSync(localPath, 'r')
          const sha256 = hashLocalPrefix(fd, size).digest('hex')
          const begun = await rpc(nodeId, 'fileBegin', { path: remotePath, size, sha256, overwrite })
          transferId = begun.transferId
          let offset = Number.isInteger(begun.expectedOffset) ? begun.expectedOffset : 0
          const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES)
          while (offset < size) {
            const wanted = Math.min(buffer.length, size - offset)
            const count = readLocalChunk(fd, buffer, offset, wanted)
            if (count <= 0) throw new Error(`unexpected local EOF at ${offset}`)
            const chunk = Buffer.from(buffer.subarray(0, count))
            try {
              await rpc(nodeId, 'fileWrite', { transferId, offset, base64: chunk.toString('base64') })
            } catch (err) {
              if (
                err?.code !== 'offset-conflict'
                || !Number.isInteger(err?.expectedOffset)
                || err.expectedOffset < 0
                || err.expectedOffset > size
              ) throw err
              offset = err.expectedOffset
              continue
            }
            offset += count
          }
          const result = await rpc(nodeId, 'fileCommit', { transferId })
          audit?.record?.('file.send', { nodeId, path: remotePath, size, sha256: result.sha256 })
          return { ...result, action, nodeId, localPath }
        } catch (err) {
          await rpc(nodeId, 'fileAbort', { transferId }).catch(() => {})
          throw err
        } finally {
          if (fd !== undefined) fs.closeSync(fd)
        }
      }

      if (action === 'fetch') {
        const meta = await rpc(nodeId, 'fileStat', { path: remotePath })
        if (meta.size > TRANSFER_MAX_BYTES) throw new Error(`file too large: ${meta.size} > ${TRANSFER_MAX_BYTES}`)
        const localPath = args?.localPath
          ? path.resolve(String(args.localPath))
          : path.join(stateDir, 'received', cleanName(remotePath))
        ensureLocalTarget(localPath, overwrite)
        const temp = `${localPath}.part-${process.pid}-${randomUUID()}`
        const hash = createHash('sha256')
        let fd
        try {
          fd = fs.openSync(temp, 'wx', 0o600)
          let offset = 0
          while (offset < meta.size) {
            const part = await rpc(nodeId, 'fileRead', { path: remotePath, offset, length: TRANSFER_CHUNK_BYTES })
            if (part.offset !== offset) throw new Error(`offset mismatch: expected ${offset}, got ${part.offset}`)
            const data = Buffer.from(String(part.base64 ?? part.data ?? ''), 'base64')
            if (data.length === 0) throw new Error(`unexpected remote EOF at ${offset}`)
            fs.writeSync(fd, data)
            hash.update(data)
            offset += data.length
            if (part.eof === true) break
          }
          if (offset !== meta.size) throw new Error(`size mismatch: expected ${meta.size}, got ${offset}`)
          const sha256 = hash.digest('hex')
          if (sha256 !== meta.sha256) throw new Error('SHA256 mismatch; local .part was not promoted')
          fs.closeSync(fd)
          fd = undefined
          promoteLocalFile(temp, localPath, overwrite)
          audit?.record?.('file.fetch', { nodeId, path: remotePath, localPath, size: meta.size, sha256 })
          return { action, nodeId, path: remotePath, localPath, size: meta.size, sha256 }
        } finally {
          if (fd !== undefined) fs.closeSync(fd)
          if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
        }
      }
      throw new Error(`unknown remote_file action: ${action}`)
    },
  })

  reg({
    name: 'remote_screenshot',
    description: '捕获副机当前交互桌面并下载 PNG 到主机。元数据与字节分块传输，截图只能按随机 id 读取，不开放任意路径；relay 下仍走既有 E2E 通道。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        localPath: { type: 'string', description: '主机 PNG 目标；省略时存到插件 screenshots 目录。' },
        overwrite: { type: 'boolean' },
      },
      required: [], additionalProperties: false,
    },
    output: { schema: { type: 'object' } },
    async execute(args) {
      const nodeId = resolveNodeId(registry, args?.node)
      const meta = await rpc(nodeId, 'desktopCapture', {}, 45_000)
      let localPath
      let temp
      let fd
      try {
        localPath = args?.localPath
          ? path.resolve(String(args.localPath))
          : path.join(stateDir, 'screenshots', `${cleanName(nodeId, 'node')}-${cleanName(meta.id, 'screenshot')}.png`)
        ensureLocalTarget(localPath, args?.overwrite === true)
        temp = `${localPath}.part-${process.pid}-${randomUUID()}`
        const hash = createHash('sha256')
        fd = fs.openSync(temp, 'wx', 0o600)
        let offset = 0
        while (offset < meta.bytes) {
          const part = await rpc(nodeId, 'desktopRead', { id: meta.id, offset, length: TRANSFER_CHUNK_BYTES })
          const data = Buffer.from(String(part.base64 ?? part.data ?? ''), 'base64')
          if (part.offset !== offset || data.length === 0) throw new Error('invalid screenshot chunk')
          fs.writeSync(fd, data)
          hash.update(data)
          offset += data.length
          if (part.eof === true) break
        }
        const sha256 = hash.digest('hex')
        if (offset !== meta.bytes || sha256 !== meta.sha256) throw new Error('screenshot integrity check failed')
        fs.closeSync(fd)
        fd = undefined
        promoteLocalFile(temp, localPath, args?.overwrite === true)
        audit?.record?.('desktop.capture', { nodeId, id: meta.id, localPath, bytes: meta.bytes, sha256 })
        return { ...meta, nodeId, localPath, sha256 }
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
        if (temp && fs.existsSync(temp)) fs.rmSync(temp, { force: true })
        await rpc(nodeId, 'desktopRelease', { id: meta.id }).catch(() => {})
      }
    },
  })

  return disposers
}
