/**
 * 副机侧的 agent 会话桥：把一条远程任务变成副机本地的一次真实 DSH agent 运行。
 *
 * 为什么不是"在副机跑一条 shell 命令"：
 *   用户锁定的形态是 **B** —— 副机拥有独立 Agent 循环、独立模型上下文，
 *   任务在副机本地持久运行，断连不终止。所以任务执行者必须是副机自己的 dsh。
 *
 * 两种后端，按可用性自动选择，对上层暴露同一个 run()：
 *
 *   1. **in-process**（首选）：worker 插件运行在副机 dsh 进程里，直接调
 *      `ctx.agentLoop.createAgent()` 起一个独立会话，把任务书 `followup()` 进它的
 *      inbox，`whenIdle()` 等它停稳，再从会话事件里取最终回答。
 *      好处：没有第二个 dsh 进程、共享副机的模型配置与凭证（凭证本就在副机本地，不外传）。
 *
 *   2. **headless**（回退）：worker 以独立进程运行（没有 dsh 上下文）时，spawn
 *      `dsh --profile <p> headless --json "<task>"`，解析 NDJSON 事件流取最终回答。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { PLATFORM, detectPlatform } from './exec.js'

/**
 * 本插件向副机 agent 投递任务书时的**消息来源身份**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 这个常量曾经写错，导致 agent 模式"假完成"（2026-10-15 定位）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 旧值：`{ kind: 'plugin', plugin: 'dsh-remote-agent' }`
 *
 * DSH 的 `MessageSourceMap` 是一张**封闭的联合类型表**，合法 kind 有 17 种：
 *
 *   user · model · tool · system-prompt · model-selection · user-approval ·
 *   ptc-mode · tool-registry · user-rpc · agent-message · subagent-settled ·
 *   skill-invocation · cordis-host-runner · goal · schedule ·
 *   compact-checkpoint · session-reference · user-question-reply
 *
 * **里面没有 `plugin`。** 传一个不认识的 kind 时，`followup` 表面上成功
 * （消息进 inbox、驱动被唤醒），但 turn 一启动就抛错 —— 而 DSH 的 `kick()`
 * 里是 `catch (_error) {}`，**错误被静默吞掉**。结果：
 *
 *   `whenIdle()` 在 ~20ms 内返回，`liveText` 为空，任务被标成 completed，
 *   产物为 0 —— 而**没有任何错误信息**（连日志都没有）。
 *
 * `cordis-host-runner` 正是为"cordis 宿主里的 runner 主动驱动一个 agent"
 * 这个场景准备的 kind，语义与我们完全对应。
 *
 * ── 教训 ────────────────────────────────────────────────────────────────
 * 往 DSH 的封闭联合类型里塞自造值**不会立刻报错**，而是在某个被
 * `catch {}` 包住的深层位置静默失效。改这类常量前先查 `MessageSourceMap`
 * 的完整声明（用 cordis_inspect 的 `listService` 查 `sessions`）。
 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'cordis-host-runner' })

/**
 * 从 dsh headless 的 NDJSON 事件流里提取最终回答。
 * 只认能确定识别的形状，认不出就保留原始尾部，绝不编造。
 */
export function extractFinalFromNdjson(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  let final = ''
  const toolCalls = []
  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object') continue
    const t = String(ev.type ?? ev.kind ?? '')
    if (t === 'assistant/message' || t === 'assistant.message' || t === 'message') {
      const blocks = ev.message?.content ?? ev.content ?? ev.blocks
      if (Array.isArray(blocks)) {
        const txt = blocks.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('')
        if (txt) final = txt
      } else if (typeof ev.text === 'string') {
        final = ev.text
      }
    } else if (t === 'tool/call' || t === 'tool.call') {
      toolCalls.push({ name: ev.name ?? ev.toolName ?? 'unknown', at: Date.now() })
    } else if (typeof ev.final === 'string') {
      final = ev.final
    }
  }
  return { final, toolCalls, eventCount: lines.length }
}

/** 在副机 PATH 上找 dsh 可执行文件。 */
export function resolveDshBin(explicit) {
  const candidates = [explicit, process.env.DSH_BIN, process.env.DSH_REMOTE_DSH_BIN].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

/** 从事件流里找 sessionId（记录在任务里，方便人在副机本地回溯这次会话）。 */
export function extractSessionId(text) {
  const m = text.match(/"sessionId"\s*:\s*"([^"]+)"/)
  return m ? m[1] : null
}

/** 从 agent 会话里抽取助手文本与工具调用名。 */
function readSessionOutcome(session) {
  const textParts = []
  const toolCalls = []
  if (!session || typeof session.ownEvents !== 'function') return { textParts, toolCalls }
  let events
  try {
    events = session.ownEvents()
  } catch {
    return { textParts, toolCalls }
  }
  for (const ev of events) {
    if (ev.type === 'assistant/message') {
      const blocks = ev.data?.message?.content ?? []
      const txt = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
      if (txt) textParts.push(txt)
    } else if (ev.type === 'tool/call') {
      toolCalls.push({ name: ev.data?.name ?? 'unknown', at: ev.time ?? Date.now() })
    }
  }
  return { textParts, toolCalls }
}

/**
 * headless 后端：spawn 一个副机本地 dsh 进程跑任务。
 */
export class HeadlessRunner {
  constructor({ dshBin, profile, platform = detectPlatform(), extraArgs = [] } = {}) {
    this.dshBin = resolveDshBin(dshBin)
    this.profile = profile
    this.platform = platform
    this.extraArgs = extraArgs
    this.children = new Set()
  }

  get kind() {
    return 'headless'
  }

  /**
   * @param {object} o
   * @param {string} o.goal 任务书
   * @param {string} o.cwd 工作区（副机绝对路径）
   * @param {number} o.timeoutMs
   * @param {AbortSignal} [o.signal]
   * @param {(chunk:string, stream:string)=>void} [o.onData]
   */
  run(o) {
    const { goal, cwd, timeoutMs, signal, onData } = o

    // ═══════════════════════════════════════════════════════════════════
    // headless 后端不支持主机指定模型 —— 明确报错，不静默忽略
    // ═══════════════════════════════════════════════════════════════════
    //
    // `dsh headless` 的 run() 是 `const selection = defaultModel.currentSelection()`
    // —— 模型**硬编码**为副机自己的默认选择，CLI 没有模型 flag（已对照
    // app.asar 里的 dsh-headless 源码核实，2026-10-15）。
    //
    // 静默忽略是最坏的回退：主机以为派给了指定模型，副机实际跑的是默认模型
    // —— 结果对得上、行为对不上，排查方向直接跑偏。所以这里如实失败，
    // 让 hub 端看到明确的错误信息。
    if (o.model && (o.model.model || o.model.provider)) {
      return Promise.resolve({
        ok: false,
        exitCode: null,
        final: '',
        stderr:
          'headless 后端不支持指定模型（dsh headless 固定使用副机默认模型）。'
          + '请在副机使用 in-process 后端（默认），或不指定 model 参数。',
        toolCalls: [],
        durationMs: 0,
        sessionId: null,
        modelUnsupported: true,
      })
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 命令构造：**绝不能把 goal 拼进命令行**
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 旧实现：
    //   args.push('headless', '--json', ...this.extraArgs, goal)
    //   spawn(this.dshBin, args, { shell: this.platform === PLATFORM.WINDOWS })
    //
    // 两个问题叠加成一个**命令注入**向量（2026-10-15 独立评审发现）：
    //
    //   1. `shell: true` 时 Node 把 args **用空格拼接**成一个命令行字符串，
    //      交给 `cmd.exe /c` —— **不做任何转义**（Windows 上尤其如此）。
    //   2. `goal` 是 `buildTaskBrief()` 生成的**多行 Markdown 任务书**，
    //      含换行、`#`、`-`、引号，且内容来自远端**不可信**（任务书由 hub 侧
    //      的调用方给出，中间还经过协议传输）。
    //
    // 后果：任务书里出现 `&`、`|`、`"` 或换行时，命令行会被 cmd 截断/拆开 ——
    // 轻则调用损坏（表现为"任务莫名失败"），重则**执行任务书里夹带的第二条命令**。
    //
    // ── 修法 ──────────────────────────────────────────────────────────────
    // ① **去掉 `shell: true`** —— `dshBin` 已由 `resolveDshBin()` 解析成绝对
    //    路径，不需要 shell 参与解析。这样 args 走真正的 argv 传递，
    //    元字符不再有特殊含义。
    // ② **goal 从 stdin 传**，不进 argv —— 这是纵深防御：即使将来有人把
    //    `shell: true` 加回来，goal 也不在命令行上。
    //    （`--json` 模式下 dsh headless 从 stdin 读任务书；见 bin 的用法。）
    //
    // 注意 `--` 分隔符：它告诉 argv 解析器"后面全是位置参数"，
    // 防止 goal 以 `-` 开头时被当成选项。
    const args = []
    if (this.profile) args.push('--profile', this.profile)
    args.push('headless', '--json', ...this.extraArgs, '-')
    const useStdinForGoal = true

    const startedAt = Date.now()
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(this.dshBin, args, {
          cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
          env: { ...process.env },
          windowsHide: true,
          // stdin 要可写（goal 从那里进），stdout/stderr 照旧管道读。
          stdio: ['pipe', 'pipe', 'pipe'],
          // ⚠ 永远 false。见上面的说明 —— 这一行曾经是注入向量的成因之一。
          shell: false,
        })
      } catch (err) {
        resolve({
          ok: false,
          exitCode: null,
          final: '',
          stderr: String(err?.message ?? err),
          toolCalls: [],
          durationMs: 0,
          sessionId: null,
          spawnError: true,
        })
        return
      }

      this.children.add(child)
      const outChunks = []
      const errChunks = []
      let settled = false
      let timedOut = false

      // 把任务书写进 stdin（argv 里传的是 `-`）。
      // dsh headless 的文档明示：`task` 参数的 `-` 表示读 stdin。
      // 这样 goal 完全不经过命令行 —— 元字符（`&` `|` `"` 换行）没有特殊含义。
      //
      // 写失败要处理：子进程可能立刻退出（例如 profile 不存在），此时 stdin
      // 已关闭，write 会触发 EPIPE。吞掉它即可 —— 真正的失败会由 exit code
      // 与 stderr 反映。
      try {
        if (useStdinForGoal && child.stdin) {
          child.stdin.on('error', () => { /* EPIPE：子进程提前退出，由 exit 反映 */ })
          child.stdin.end(String(goal ?? ''), 'utf8')
        }
      } catch {
        /* 同上 */
      }

      const killTree = () => {
        try {
          if (this.platform === PLATFORM.WINDOWS) {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          } else {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已退出 */
          }
        }
      }

      const timer = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true
          killTree()
        }, timeoutMs)
        : undefined
      if (timer?.unref) timer.unref()

      const onAbort = () => killTree()
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.on('data', (b) => {
        const s = b.toString('utf8')
        outChunks.push(s)
        if (typeof onData === 'function') onData(s, 'stdout')
      })
      child.stderr?.on('data', (b) => {
        const s = b.toString('utf8')
        errChunks.push(s)
        if (typeof onData === 'function') onData(s, 'stderr')
      })

      const finish = (code) => {
        if (settled) return
        settled = true
        this.children.delete(child)
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        const stdout = outChunks.join('')
        const parsed = extractFinalFromNdjson(stdout)
        resolve({
          ok: code === 0 && !timedOut,
          exitCode: code,
          timedOut,
          final: parsed.final,
          rawTail: stdout.slice(-4000),
          stderr: errChunks.join('').slice(-8000),
          toolCalls: parsed.toolCalls,
          eventCount: parsed.eventCount,
          durationMs: Date.now() - startedAt,
          sessionId: extractSessionId(stdout),
        })
      }

      child.on('error', (err) => {
        errChunks.push(String(err?.message ?? err))
        finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  }

  killAll() {
    for (const c of this.children) {
      try {
        c.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    this.children.clear()
  }
}

/**
 * 把"副机默认模型选择"与"主机指定的模型选择"合成 createAgent 的 agentOptions。
 *
 * 合成规则（主机指定的字段优先）：
 *   - 两边都是 {provider, model} 成对 → 直接用主机的
 *   - 主机只给了 model → provider 用副机默认的（"副机默认 provider + 主机指定的模型"）
 *   - 主机只给了 provider → 无效（provider 必须配 model），退回默认
 *   - 主机什么都没给 → 副机默认（与 2026-10-15 修复后的行为一致）
 *   - 默认也没有 → undefined（DSH 自己的默认行为）
 *
 * reasoningEffort：主机给了就用主机的；没给继承默认。
 *
 * 纯函数，无副作用 —— 便于单测穷举合成矩阵。
 */
export function buildAgentOptions(defaultSel, requested) {
  const cleanPair = (sel) => {
    if (!sel || typeof sel !== 'object') return undefined
    const o = {}
    if (typeof sel.provider === 'string' && sel.provider !== '') o.provider = sel.provider
    if (typeof sel.model === 'string' && sel.model !== '') o.model = sel.model
    if (sel.reasoningEffort !== undefined && sel.reasoningEffort !== null) {
      o.reasoningEffort = sel.reasoningEffort
    }
    // provider 与 model 必须成对 —— 只给一个是无效选择，不如不给。
    return o.provider && o.model ? o : undefined
  }

  const base = cleanPair(defaultSel) ?? {}
  const req = requested && typeof requested === 'object' ? requested : {}

  const model = typeof req.model === 'string' && req.model !== '' ? req.model : base.model
  const provider =
    typeof req.provider === 'string' && req.provider !== ''
      ? req.provider
      : typeof req.model === 'string' && req.model !== ''
        ? base.provider // 只指定模型 → 借副机默认 provider
        : base.provider

  if (!provider || !model) return base.provider && base.model ? base : undefined

  const out = { provider, model }
  const effort =
    typeof req.reasoningEffort === 'string' && req.reasoningEffort !== ''
      ? req.reasoningEffort
      : base.reasoningEffort
  if (effort) out.reasoningEffort = effort
  return out
}

/**
 * in-process 后端：在副机 dsh 进程里起一个真实 agent 会话。
 *
 * 用 ctx.agentLoop.createAgent() 创建带独立 id 的会话，把任务书 followup 进 inbox，
 * 用 whenIdle() 等它停稳。这比 headless 少一个进程，且直接复用副机的
 * 模型配置 / 凭证 / 插件 —— 凭证一步都没有离开副机。
 */
export class InProcessRunner {
  /**
   * @param {object} o
   * @param {import('@deepseek-ai/cordis').Context} o.ctx 副机 dsh 的根上下文
   * @param {string} o.nodeId
   * @param {string} [o.preset] 指定 agent preset（可选）
   */
  constructor({ ctx, nodeId, preset }) {
    this.ctx = ctx
    this.nodeId = nodeId
    this.preset = preset
    this.active = new Map() // taskId → { handle, controller }
  }

  get kind() {
    return 'in-process'
  }

  /**
   * 这两个服务是否可用。
   *
   * 必须用 `ctx.get(name)` 而不是 `ctx.agentLoop` —— 在 cordis 里访问一个
   * **未在 inject 中声明**的服务属性会**抛错**（`cannot get property "agentLoop"
   * without inject`），而不是返回 undefined。所以可选链 `ctx?.agentLoop` 挡不住它，
   * 反而让"探测可用性"这一步自己炸掉：实测在 headless profile（无 agentLoop）里
   * 启动 worker 会得到 `worker disabled after startup error cannot get property
   * "agentLoop" without inject` —— 一个本该优雅降级的地方变成了启动失败。
   */
  get available() {
    const ctx = this.ctx
    if (!ctx || typeof ctx.get !== 'function') return false
    try {
      return Boolean(ctx.get('agentLoop') && ctx.get('sessions'))
    } catch {
      // get() 本身在某些组合下也可能抛；探测失败一律当作"不可用"，交给 headless 后端
      return false
    }
  }

  /**
   * @param {object} o
   * @param {string} o.taskId
   * @param {string} o.goal
   * @param {string} o.cwd
   * @param {number} o.timeoutMs
   * @param {AbortSignal} [o.signal]
   * @param {(evt:object)=>void} [o.onEvent] 会话事件回调（用于进度）
   */
  async run(o) {
    const { taskId, goal, cwd, timeoutMs, signal, onEvent } = o
    const startedAt = Date.now()

    if (!this.available) {
      return {
        ok: false,
        exitCode: null,
        final: '',
        stderr: 'agentLoop/sessions service unavailable in this dsh composition',
        toolCalls: [],
        durationMs: 0,
        sessionId: null,
        unavailable: true,
      }
    }

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }

    let timer
    let timedOut = false
    let aborted = false
    /**
     * agent 在 turn 内部报过错（2026-10-21 真实使用发现的 bug）。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * 为什么必须有这个标志
     * ═══════════════════════════════════════════════════════════════════════
     *
     * DSH 的 `kick()` 是 `try { while (await this.turn()) } catch (_error) {}`
     * —— **turn 内的错误被完全吞掉**，只通过 `agent/error` 事件暴露。
     *
     * 我们**已经**监听了那个事件，但原来只做了一件事：把错误文案推进
     * `liveText`（所以它出现在 handoff 摘要里）。`ok` 的判定是
     * `!timedOut && !aborted` —— **完全没看这个错误**。
     *
     * 真实后果（2026-10-21 用户实测）：
     *
     *     任务状态: completed          ← 显示成功
     *     结果摘要: [agent 错误] DeepSeek Messages transport failed.
     *     成品: 0 项
     *
     * 用户看到一个"成功"的任务，实际上 agent 一步都没跑成。这比直接报错
     * **更糟** —— 报错至少知道要重试，"假成功"会让人以为事情做完了。
     */
    let hadError = false
    /** 第一个错误的文案（用于 stderr，让失败原因能透出到任务详情）。 */
    let firstError = ''
    const timeoutPromise = new Promise((resolve) => {
      if (!(timeoutMs > 0)) return
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve({ timedOut: true })
      }, timeoutMs)
      if (timer.unref) timer.unref()
    })

    /**
     * 取消信号也必须参与 `Promise.race`（提案 #26-5）。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * 原实现：cancel 不真打断
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `race` 里只有两个竞争者 —— `agent.whenIdle()` 与 `timeoutPromise`：
     *
     *     const raced = await Promise.race([
     *       agent.whenIdle().then(() => ({ timedOut: false })),
     *       timeoutPromise,
     *     ])
     *
     * 而 `InProcessRunner.cancel()` 做的是：
     *   `agent.cancel({ kind: 'user' })` + `controller.abort()`
     *
     * **`controller.abort()` 只是置了个信号，没有任何人在 await 它** ——
     * `whenIdle()` 不因 signal 而停（DSH 的 agent 循环不监听外部 AbortSignal），
     * 于是：
     *
     *   用户 cancel → race 还在等 whenIdle → agent 继续跑到自然结束 →
     *   按 `ok: !timedOut` 落成 **completed**（不是 aborted）。
     *
     * 实测症状：hub 发 `task/cancel`，`remote_cancel` 返回 `requested: true`，
     * 但任务**一直 running 到 agent 自己跑完**，最终状态 completed ——
     * 用户以为取消成功，实际白跑一遍还烧了额度。
     *
     * ── 修法 ──────────────────────────────────────────────────────────────
     *
     * 把 abort 也做成可 race 的 promise：一旦触发立即 resolve，race 立刻返回，
     * `finally` 里 `handle.dispose()` 收掉 agent。
     *
     * ⚠ 两个语义细节：
     *   1. `timedOut` 为真时 abort 是**超时的副作用**，不该把状态改写成
     *      aborted（超时 ≠ 用户取消，下游据此外报不同的错误码）。
     *   2. resolve 之后 agent 可能还跑一小会儿（dispose 是异步的），所以
     *      状态判定必须用 `aborted` 而不是 `!timedOut`。
     */
    const abortPromise = new Promise((resolve) => {
      if (controller.signal.aborted) {
        aborted = true
        resolve({ aborted: true })
        return
      }
      controller.signal.addEventListener(
        'abort',
        () => {
          if (!timedOut) aborted = true
          resolve({ aborted: !timedOut })
        },
        { once: true },
      )
    })

    const sessionIdFor = `session-remote-${String(taskId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)}`
    let handle
    let disposeListener
    let disposeAgentErrorListener
    const liveText = []
    /**
     * agent 后端的**按需**流程日志。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * 这个东西救过一次大忙，但默认必须是关的（2026-10-15 两次修正）
     * ═══════════════════════════════════════════════════════════════════════
     *
     * **为什么留着**：它定位了「agent 模式 20ms 假完成、零输出、零报错」——
     * 一个 DSH 用 `catch (_error) {}` 吞掉错误、因而完全不可观测的故障
     * （根因是消息 source 类型非法，见 CHANGELOG）。没有它这条路径是黑的。
     *
     * **为什么默认关**：第一版写死 `<temp>/dsh-remote-agent-runner.log`、
     * 无条件 `appendFileSync`，有两个问题：
     *   1. **无限增长** —— 长期运行的副机会把这个文件刷到任意大小
     *   2. **泄漏信息** —— 记录里含 taskId、goal 长度、cwd、错误正文
     *
     * **怎么开**：设环境变量 `DSH_REMOTE_AGENT_TRACE=1`（或 `true`/`yes`）。
     * 排查时临时开、排查完关掉。同时受 `MAX_TRACE_BYTES` 约束：
     * 超过就整文件轮转一次（只留最近的一段），不会无限长。
     */
    const TRACE_ON = /^(1|true|yes|on)$/i.test(String(process.env.DSH_REMOTE_AGENT_TRACE ?? ''))
    const traceFile = `${process.env.TEMP || process.env.TMP || '/tmp'}/dsh-remote-agent-runner.log`
    const MAX_TRACE_BYTES = 2 * 1024 * 1024
    const dlog = (msg, extra) => {
      if (!TRACE_ON) return
      try {
        // 轮转：超上限就换成只写开头一行标记，避免无限增长。
        try {
          const st = fs.statSync(traceFile)
          if (st.size > MAX_TRACE_BYTES) {
            fs.writeFileSync(traceFile, `${new Date().toISOString()} [trace rotated, previous exceeded ${MAX_TRACE_BYTES} bytes]\n`, 'utf8')
          }
        } catch {
          /* 文件不存在 = 首次写，无需轮转 */
        }
        fs.appendFileSync(traceFile, `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`, 'utf8')
      } catch {
        /* 诊断不影响主流程 */
      }
    }
    dlog('InProcessRunner.run ENTER', {
      taskId,
      goalLen: String(goal ?? '').length,
      cwd,
      timeoutMs,
      available: this.available,
      hasAgentLoop: Boolean(this.ctx?.get?.('agentLoop')),
      hasSessions: Boolean(this.ctx?.get?.('sessions')),
      // 注意：agentDefaultModel 缺了**不算不可用** —— 它只是"能提供默认模型"。
      // 缺了会走"不指定模型"的路径，而那条路会在 system prompt 组装时报
      // `{{model}} has no value`（见下面 createAgent 处的说明）。
      // 所以这里记下来，便于区分"服务缺失"与"部署没配默认模型"。
      hasAgentDefaultModel: Boolean(this.ctx?.get?.('agentDefaultModel')),
    })

    try {
      // 用 ctx.get() 取服务，不用属性访问 —— 见 available getter 的说明
      const agentLoop = this.ctx.get('agentLoop')
      const sessions = this.ctx.get('sessions')

      // ═══════════════════════════════════════════════════════════════════
      // 必须显式带上模型选择 —— 否则 turn 1 就抛错（2026-10-15 定位）
      // ═══════════════════════════════════════════════════════════════════
      //
      // 旧实现传 `agentOptions: undefined`，即"不指定模型"。结果是
      // system prompt 组装时报：
      //   prompt variable "{{model}}" has no value for this assembly
      //   (section "deployment:persona-prefix")
      //
      // 即：persona 前缀段用了 `{{model}}` 变量，而**没有选定模型时它没有值**。
      // 而 DSH 的 `kick()` 是 `catch (_error) {}` —— 错误被吞、phase 转 idle、
      // `whenIdle()` 立即返回，任务被标 completed 且产物为空，**全程无报错**。
      //
      // 正解：从 `agentDefaultModel` 取部署的默认选择填进去，再叠加主机在
      // 派单时指定的 `model`（remote_task 的可选参数）。合成规则见
      // buildAgentOptions —— 主机指定的字段优先，缺的字段借副机默认补齐。
      //   `currentSelection()` 的文档："Read the current default model selection.
      //   returns a detached provider, model, and optional reasoning selection."
      // 这个服务是**可选**的（用 ctx.get 探测），取不到时只靠主机指定 ——
      // 若主机也没指定，则回到"不传"路径（部署配置问题，不是本插件能补救的）。
      const agentOptions = buildAgentOptions(
        (() => {
          try {
            const dm = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : undefined
            return dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
          } catch {
            return undefined
          }
        })(),
        o.model,
      )

      dlog('before createAgent', { sessionIdFor, cwd, agentOptions })

      // ⚠ **先占位再 await**（2026-10-17 修 L3）。
      //
      // 原实现把 `this.active.set(taskId, { handle, controller })` 放在
      // `await createAgent()` **之后**。于是 createAgent 在途的那几毫秒里，
      // hub 发 `task/cancel` → `cancel(taskId)` 查不到记录 → 返回 false →
      // hub 认为"取消失败"，而任务最终会跑完并按 completed 落账 ——
      // **正是 #26-5 修过的形态在窗口期复现**。
      //
      // 窗口窄（createAgent 毫秒级）但取消语义的承诺是"请求即达"。所以先占位
      // （handle 置 null），createAgent 完成后再补上。`cancel()` 里对
      // `rec.handle` 的空值已有保护（`rec.handle.agent.cancel` 包在 try 里，
      // 而 `controller.abort()` 一定生效 —— 后者正是 #26-5 的修复点）。
      this.active.set(taskId, { handle: null, controller })

      handle = await agentLoop.createAgent(this.ctx, {
        sessionId: sessionIdFor,
        meta: { cwd },
        signal: controller.signal,
        agentOptions,
      })
      const agent = handle.agent
      const session = agent.session ?? sessions.get(agent.id)
      dlog('after createAgent', {
        agentId: agent?.id ?? null,
        hasSession: Boolean(session),
        sessionStatus: session?.status ?? null,
        handleKeys: (() => { try { return Object.keys(handle ?? {}).slice(0, 10) } catch { return null } })(),
      })

      // 补齐占位记录里的 handle（cancel 可能已经在 createAgent 期间触发过，
      // 此时 controller 已被 abort —— 后续 followup 会因 signal 已中止而立刻
      // 走 abortPromise 分支，符合预期）
      this.active.set(taskId, { handle, controller })

      // 观察事件：给 hub 送进度，并在会话日志之外保留一份实时文本（防日志投影差异）
      if (typeof this.ctx.on === 'function') {
        disposeListener = this.ctx.on('session/event', (s, event) => {
          if (!s || s.id !== agent.id) return
          if (event.type === 'assistant/message') {
            const blocks = event.data?.message?.content ?? []
            const txt = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
            if (txt) {
              liveText.push(txt)
              if (typeof onEvent === 'function') onEvent({ kind: 'assistant', text: txt.slice(0, 2000) })
            }
          } else if (event.type === 'tool/call') {
            if (typeof onEvent === 'function') onEvent({ kind: 'tool', name: event.data?.name ?? 'unknown' })
          }
        })
      }
      // ⚠ 必须单独监听 `agent/error` —— 否则 turn 内部的错误**完全不可见**。
      //
      // DSH 的 `kick()` 里是 `try { while (await this.turn()) } catch (_error) {}`：
      // 任何 turn 错误都被吞掉，只通过 `agent/error` 事件暴露（见 Agent 的
      // `throwError()`）。我们曾因为漏了这条监听，把一个"消息 source 类型非法"
      // 的错误查了很久 —— 表现只是"任务 20ms 完成、无输出、无报错"。
      //
      // 这里把错误记进诊断日志，并塞进 liveText，让它在 handoff 摘要里也可见。
      //
      // ⚠ 错误对象的形状不受我们控制：第一版只取 `err?.message`，结果记到的是
      // `[object Object]`（DSH 发的 payload 是嵌套对象，没有顶层 message）。
      // 所以这里做**深度序列化**：先试常见字段，再退到 JSON.stringify，
      // 最后兜底到 String()。任何一步都不能抛。
      const describeError = (e) => {
        if (e === null || e === undefined) return String(e)
        if (typeof e === 'string') return e
        if (typeof e !== 'object') return String(e)
        // 常见字段优先（FiberError / CordisError / LlmFailure 之类）
        for (const k of ['message', 'reason', 'error', 'failure', 'code', 'name']) {
          const v = e[k]
          if (typeof v === 'string' && v !== '') {
            return k === 'message' ? v : `${k}=${v}`
          }
        }
        // 深度：把可枚举字段拼出来（含嵌套一层）
        try {
          const flat = {}
          for (const k of Object.keys(e)) {
            const v = e[k]
            if (v === undefined) continue
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v
            else if (v === null) flat[k] = null
            else if (typeof v === 'object') {
              // 嵌套对象再取一层常见字段，避免无限深
              const inner = {}
              for (const k2 of ['message', 'code', 'name', 'kind', 'status', 'failure']) {
                const v2 = v[k2]
                if (typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean') inner[k2] = v2
              }
              flat[k] = Object.keys(inner).length > 0 ? inner : String(v)
            } else flat[k] = String(v)
          }
          const s = JSON.stringify(flat)
          if (s && s !== '{}') return s
        } catch {
          /* 循环引用等 */
        }
        try {
          return JSON.stringify(e)
        } catch {
          return String(e)
        }
      }

      if (typeof this.ctx.on === 'function') {
        disposeAgentErrorListener = this.ctx.on('agent/error', (err, agentInfo) => {
          try {
            const a = agentInfo?.agent ?? agentInfo
            if (a && a.id !== undefined && agent.id !== undefined && a.id !== agent.id) return
            const msg = describeError(err)
            dlog('agent/error', { msg: msg.slice(0, 1200), rawKeys: (() => { try { return Object.keys(err ?? {}) } catch { return null } })() })
            // ⚠ 标记失败（2026-10-21 修复）：只记录文案是不够的 ——
            // `ok` 必须把它算进去，否则任务会显示"completed"但实际什么都没做成。
            hadError = true
            if (firstError === '') firstError = msg
            liveText.push(`[agent 错误] ${msg}`)
            if (typeof onEvent === 'function') onEvent({ kind: 'error', text: msg.slice(0, 2000) })
          } catch {
            /* 诊断不影响主流程 */
          }
        })
      }

      // 投递任务书：followup 排队下一轮并唤醒驱动器。
      // 必须带 plugin source —— 省略 source 会被当成人类输入，这是不能继承的权限。
      dlog('before followup', { hasFollowup: typeof agent.followup === 'function' })
      agent.followup({
        role: 'user',
        content: [{ type: 'text', text: goal }],
        source: PLUGIN_SOURCE,
      })
      dlog('after followup, before whenIdle', { hasWhenIdle: typeof agent.whenIdle === 'function' })

      const raced = await Promise.race([
        agent.whenIdle().then(() => ({ timedOut: false })),
        timeoutPromise,
        // #26-5：取消必须能赢 race。少了这一项，cancel 只会置 signal，
        // agent 继续跑到自然结束，状态落成 completed。
        abortPromise,
      ])
      if (raced.timedOut === true) timedOut = true
      if (raced.aborted === true) aborted = true
      dlog('whenIdle resolved', {
        timedOut,
        aborted,
        liveTextLen: liveText.join('').length,
        elapsedMs: Date.now() - startedAt,
      })

      // 会话日志优先；日志取不到就用实时累积
      const fromLog = readSessionOutcome(session)
      const finalText = fromLog.textParts.length > 0 ? fromLog.textParts.join('\n\n').trim() : liveText.join('\n\n').trim()
      dlog('outcome read', {
        fromLogParts: fromLog.textParts.length,
        fromLogToolCalls: fromLog.toolCalls.length,
        finalLen: finalText.length,
        finalHead: finalText.slice(0, 200),
      })

      return {
        // #26-5：取消不是成功。`ok` 必须把 aborted 排除掉，否则 engine 会把
        // 取消落成 completed（engine 的映射是 `result.aborted ? ABORTED : ...`，
        // 但那是 exec 侧；agent 侧靠这里的 ok 判定）。
        //
        // 2026-10-21（真实使用发现的 bug）：`ok` 还必须排除 **turn 内报过错**。
        // DSH 的 kick() 吞掉 turn 错误，若不看 hadError，一次 agent 完全失败的
        // 任务会显示 completed —— 比直接报错更糟（用户以为做完了）。
        ok: !timedOut && !aborted && !hadError,
        exitCode: timedOut || aborted ? null : (hadError ? 1 : 0),
        timedOut,
        aborted,
        // agent 内部报错时，把第一个错误放进 stderr —— engine 会把它带进
        // task/end 的 error 字段，任务详情里就能看到原因（而不只是一句 completed）。
        stderr: hadError ? firstError : '',
        hadError,
        final: finalText,
        toolCalls: fromLog.toolCalls,
        durationMs: Date.now() - startedAt,
        sessionId: agent.id,
      }
    } catch (err) {
      return {
        ok: false,
        exitCode: null,
        final: liveText.join('\n\n').trim(),
        stderr: String(err?.message ?? err),
        toolCalls: [],
        durationMs: Date.now() - startedAt,
        sessionId: handle?.agent?.id ?? sessionIdFor,
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
      this.active.delete(taskId)
      try {
        disposeListener?.()
      } catch {
        /* 上下文已卸载 */
      }
      try {
        disposeAgentErrorListener?.()
      } catch {
        /* 同上 */
      }
      try {
        await handle?.dispose()
      } catch {
        /* agent 可能已自行结束 */
      }
    }
  }

  /** 中断一个在跑的任务（hub 发 task/cancel 时调用）。 */
  async cancel(taskId) {
    const rec = this.active.get(taskId)
    if (!rec) return false
    try {
      // handle 可能还是 null（L3 修复后先占位再 await createAgent）——
      // 此时 agent 还没建出来，没有 agent.cancel 可调。抛错被吞掉即可，
      // 真正的取消靠下面的 controller.abort()：createAgent 拿到的 signal
      // 已经中止，后续 followup 会立刻走 abortPromise 分支。
      rec.handle.agent.cancel({ kind: 'user' })
    } catch {
      /* agent 可能已停，或还没建出来（占位阶段） */
    }
    try {
      rec.controller.abort()
    } catch {
      /* 已中止 */
    }
    return true
  }

  /** 插件卸载：中断全部在跑任务（任务记录留在磁盘上，重启后可查）。 */
  async disposeAll() {
    for (const [taskId] of this.active) {
      await this.cancel(taskId)
    }
    this.active.clear()
  }
}

/**
 * 按可用性挑一个后端。
 * in-process 优先 —— 少一个进程，且模型凭证不用经过任何额外路径。
 */
export function selectRunner({ ctx, nodeId, profile, dshBin, preferHeadless = false }) {
  const inProc = new InProcessRunner({ ctx, nodeId })
  if (!preferHeadless && inProc.available) return inProc
  return new HeadlessRunner({ dshBin, profile })
}
