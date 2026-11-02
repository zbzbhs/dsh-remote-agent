import { execFile } from 'node:child_process'
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 256 * 1024

const CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($env:DSH_REMOTE_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
[Console]::WriteLine((@{ width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress))
`

function defaultRunCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr, code: 0 })
      }
    })
  })
}

function dimensionsFrom(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (Number.isInteger(value?.width) && value.width > 0
        && Number.isInteger(value?.height) && value.height > 0) {
        return { width: value.width, height: value.height }
      }
    } catch {
      // Try the preceding line; PowerShell may emit informational output.
    }
  }
  throw new Error('PowerShell did not return valid screenshot dimensions.')
}

export class DesktopError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
  }
}

export function createDesktopService({
  stateDir,
  platform = process.platform,
  runCommand = defaultRunCommand,
  powershell = process.env.DSH_REMOTE_PWSH || 'powershell.exe',
  timeoutMs = 15_000,
  maxBytes = DEFAULT_MAX_BYTES,
  maxChunkBytes = DEFAULT_CHUNK_BYTES,
  ttlMs = 10 * 60 * 1000,
  maxEntries = 16,
  now = Date.now,
  randomUUID = nodeRandomUUID,
} = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') {
    throw new TypeError('stateDir is required')
  }
  const screenshotDir = path.join(stateDir, 'screenshots')
  const entries = new Map()

  function remove(id) {
    const entry = entries.get(id)
    if (!entry) return false
    entries.delete(id)
    try {
      fs.unlinkSync(entry.filePath)
    } catch {
      // The file may already have been removed by external state cleanup.
    }
    return true
  }

  function cleanup() {
    let removed = 0
    const time = now()
    for (const [id, entry] of entries) {
      if (time - entry.capturedAtMs >= ttlMs && remove(id)) removed += 1
    }
    return removed
  }

  function requireEntry(id) {
    cleanup()
    const entry = entries.get(id)
    if (!entry) throw new DesktopError('Screenshot id was not found or has expired.', 'screenshot-not-found')
    return entry
  }

  return {
    async capture() {
      if (platform !== 'win32') {
        throw new DesktopError(`Desktop capture is unsupported on ${platform}.`, 'unsupported')
      }
      cleanup()
      await fsp.mkdir(screenshotDir, { recursive: true })
      const id = randomUUID()
      const filePath = path.join(screenshotDir, `${id}.png`)
      try {
        const result = await runCommand(powershell, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          CAPTURE_SCRIPT,
        ], {
          env: { ...process.env, DSH_REMOTE_SCREENSHOT: filePath },
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
        })
        if (typeof result?.code === 'number' && result.code !== 0) {
          throw new Error(String(result.stderr || `PowerShell exited with ${result.code}`))
        }
        const { width, height } = dimensionsFrom(result?.stdout)
        const stat = await fsp.stat(filePath)
        if (!stat.isFile() || stat.size <= 0) throw new Error('Screenshot file is empty.')
        if (stat.size > maxBytes) {
          throw new DesktopError(`Screenshot exceeds ${maxBytes} bytes.`, 'screenshot-too-large')
        }
        const bytes = await fsp.readFile(filePath)
        const capturedAtMs = now()
        const metadata = {
          id,
          width,
          height,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          format: 'png',
          capturedAt: new Date(capturedAtMs).toISOString(),
        }
        entries.set(id, { filePath, metadata, capturedAtMs })
        while (entries.size > maxEntries) remove(entries.keys().next().value)
        return { ...metadata }
      } catch (error) {
        await fsp.unlink(filePath).catch(() => {})
        if (error instanceof DesktopError) throw error
        throw new DesktopError(`Desktop capture failed: ${String(error?.message ?? error)}`, 'capture-failed')
      }
    },

    stat(id) {
      return { ...requireEntry(id).metadata }
    },

    readChunk(id, offset = 0, length = maxChunkBytes) {
      const entry = requireEntry(id)
      if (!Number.isInteger(offset) || offset < 0 || offset > entry.metadata.bytes
        || !Number.isInteger(length) || length <= 0 || length > maxChunkBytes) {
        throw new DesktopError('Invalid screenshot chunk range.', 'invalid-range')
      }
      const size = Math.min(length, entry.metadata.bytes - offset)
      const data = Buffer.alloc(size)
      let handle
      try {
        handle = fs.openSync(entry.filePath, 'r')
        let bytesRead = 0
        while (bytesRead < size) {
          const count = fs.readSync(handle, data, bytesRead, size - bytesRead, offset + bytesRead)
          if (count <= 0) break
          bytesRead += count
        }
        // A short read must not expose the zero-filled tail of Buffer.alloc().
        return bytesRead === size ? data : data.subarray(0, bytesRead)
      } finally {
        if (handle !== undefined) fs.closeSync(handle)
      }
    },

    release(id) {
      return remove(id)
    },

    cleanup,

    dispose() {
      let removed = 0
      for (const id of [...entries.keys()]) {
        if (remove(id)) removed += 1
      }
      return removed
    },
  }
}
