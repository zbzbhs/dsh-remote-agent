import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

function messageOf(error) {
  return String(error?.message ?? error)
}

function jsonSafe(value) {
  if (value instanceof Error) return { name: value.name, message: value.message }
  try {
    const text = JSON.stringify(value ?? null, (_key, item) => (
      typeof item === 'bigint' ? item.toString() : item
    ))
    return text === undefined ? String(value) : JSON.parse(text)
  } catch {
    return String(value)
  }
}

function makeCheck(id, name, status, expected, actual, fix = '', severity = 'error') {
  return { id, name, severity, status, expected, actual, fix }
}

function capabilityEnabled(capabilities, name) {
  if (Array.isArray(capabilities)) return capabilities.includes(name)
  return capabilities?.[name] === true
}

async function probeRoot(root, index) {
  const id = `root:${index}`
  const name = `Workspace root ${root}`
  const expected = 'directory is readable and writable; probe file is removed'
  const fix = 'Configure an existing readable and writable worker root.'
  let probePath = ''
  let handle
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) throw new Error('not a directory')
    probePath = `${root}/.dsh-remote-agent-selfcheck-${process.pid}-${randomUUID()}.tmp`
    handle = await fs.open(probePath, 'wx', 0o600)
    const payload = Buffer.from(`selfcheck:${randomUUID()}`)
    await handle.writeFile(payload)
    await handle.close()
    handle = undefined
    const observed = await fs.readFile(probePath)
    if (!observed.equals(payload)) throw new Error('probe read-back mismatch')
    await fs.unlink(probePath)
    probePath = ''
    return makeCheck(id, name, 'pass', expected, { path: root, cleaned: true }, fix)
  } catch (error) {
    return makeCheck(id, name, 'fail', expected, {
      path: root,
      error: messageOf(error),
    }, fix)
  } finally {
    if (handle) await handle.close().catch(() => {})
    if (probePath) await fs.unlink(probePath).catch(() => {})
  }
}

export function createSelfCheckService({ roots = [], runner, capabilities = {}, desktopCheck } = {}) {
  return {
    async check(request = {}) {
      const purpose = ['agent', 'exec', 'gui'].includes(request.purpose)
        ? request.purpose
        : request.gui === true ? 'gui' : 'agent'
      const checks = []
      if (roots.length === 0) {
        checks.push(makeCheck(
          'roots',
          'Workspace roots',
          'fail',
          'at least one worker root is configured',
          { count: 0 },
          'Configure at least one readable and writable worker root.',
        ))
      }
      for (const [index, root] of roots.entries()) {
        checks.push(await probeRoot(root, index))
      }

      // Exec tasks run through the command executor, not the agent runner. Keep
      // agent-only requirements out of that path so an exec-only worker remains usable.
      if (purpose !== 'exec') {
        // InProcessRunner.available is a live service probe; HeadlessRunner does not
        // declare it and is available whenever run() exists. Read it on every check.
        const runnerAvailable = Boolean(
          runner && typeof runner.run === 'function' && runner.available !== false,
        )
        checks.push(makeCheck(
          'runner',
          'Task runner',
          runnerAvailable ? 'pass' : 'fail',
          'runner exposes run() and is currently available',
          { available: runnerAvailable, kind: String(runner?.kind ?? 'unavailable') },
          'Start the worker with an available in-process or headless runner.',
        ))
      }

      // GUI work is still agent work plus a desktop requirement; exec checks only exec.
      const capability = purpose === 'exec' ? 'exec' : 'agent'
      const enabled = capabilityEnabled(capabilities, capability)
      checks.push(makeCheck(
        `capability:${capability}`,
        `${capability} capability`,
        enabled ? 'pass' : 'fail',
        true,
        enabled,
        `Enable the worker ${capability} capability.`,
      ))

      if (purpose === 'gui' && typeof desktopCheck !== 'function') {
        checks.push(makeCheck(
          'desktop',
          'Interactive desktop',
          'fail',
          'desktop probe is configured',
          { available: false },
          'Configure a desktop probe before dispatching GUI work.',
        ))
      } else if (typeof desktopCheck === 'function') {
          let result
          try {
            result = await desktopCheck({ purpose })
          } catch (error) {
            result = { status: 'fail', actual: messageOf(error) }
          }
          checks.push(makeCheck(
            'desktop',
            String(result?.name ?? 'Interactive desktop'),
            result?.status === 'pass' ? 'pass' : 'fail',
            jsonSafe(result?.expected ?? 'interactive desktop is available'),
            jsonSafe(result?.actual ?? result?.status ?? 'unavailable'),
            String(result?.fix ?? (purpose === 'gui' ? 'Prepare an interactive desktop.' : '')),
            purpose === 'gui' ? 'error' : 'warning',
          ))
      }

      const blockingFailures = checks.filter((check) => check.status === 'fail' && check.severity === 'error')
      const warnings = checks.filter((check) => check.status === 'fail' && check.severity !== 'error')
      return {
        verdict: blockingFailures.length > 0 ? 'blocked' : warnings.length > 0 ? 'warn' : 'ready',
        checks,
        blockingFailures,
        warnings,
      }
    },
  }
}
