/**
 * 主机侧 subagent provider（零外部依赖）。
 *
 * 定位：把"远程副机"接成 DSH 的一个**委派目标**。主 agent 用普通的
 * subagent 工具派活，实际上任务跑在另一台电脑上；主 agent 拿到的是
 * 一张交接卡，而不是副机的原始日志。
 *
 * 三条刻意的设计取舍：
 *
 *   1. `inheritsParentContext: false` —— 副机 agent 有独立的模型上下文，
 *      不继承主机会话。这也意味着主机侧不需要（也不应该）把会话内容送出去。
 *
 *   2. `capabilities` 全 false —— provider 不实现 agentOptions / outputSchema /
 *      depthLimit / toolFilter / persona。声称支持却忽略参数，比明确不支持更糟：
 *      上层会以为限制生效了。深度与并发由副机自己的 agent 循环负责。
 *
 *   3. **start() 不等待任务被接受** —— 只做同步可判定的拒绝（无在线节点、
 *      多节点且未指定、节点不可达），然后立刻把 SubagentRun 交给持有者。
 *      等 accept 是 result 的事：否则持有者在最长 ackTimeoutMs 内拿不到
 *      dispose 句柄，也就无法取消一条刚派出去的任务。
 *
 * 节点选择：request.label 里出现节点 id 或主机名就用它，否则要求恰好一个在线节点。
 */
import { ERROR_CODE, TERMINAL_STATUS, TASK_MODE, TASK_STATUS, newTaskId, validateTaskStart } from '../protocol.js'
import { handoffSummaryText } from './tools.js'
// 投影共享层：副机上报的 handoff / progressTail / logTail 全部是不可信输入，
// 必须与工具路径、UI 路径用**同一份**白名单（见 views.js 的说明）。
import { handoffView, progressTailView } from './views.js'

/** goal 上限：控制帧上限 4 MiB，而 goal 会被塞进 task/start 帧。 */
const MAX_GOAL_CHARS = 64 * 1024
const GOAL_TRUNCATED_MARK = '\n\n[goal truncated: exceeded 65536 characters]'
/** 非文本块的 type 名也来自调用方，渲染前截断（否则 `[xxx… block omitted]` 无上界）。 */
const MAX_BLOCK_TYPE_CHARS = 64
/** 节点 id / 主机名的字符集，与 protocol.validateHello 的 nodeId 规则一致。 */
const NODE_TOKEN_CHAR = /[a-z0-9._-]/

/**
 * 从 label 里认出节点名。label 形如 "build on DESKTOP-01" / "node:DESKTOP-01"。
 *
 * ── 为什么不能"第一个子串命中就返回"（修复前） ─────────────────────
 * 旧实现按 `registry.nodes` 的插入顺序遍历，对每个节点做
 * `text.includes(id)`，命中即返回。于是 **短 id 会劫持长 id 的 label**：
 * 同时在线 `pc` 与 `pc-2` 时，label `"run on pc-2"` 会命中 `pc`
 * （"pc-2" 里含 "pc"），任务被派到**错误的机器**上 —— 而且结果看起来
 * 完全正常（有节点接单、任务跑完、回传交接卡），只是跑错了电脑。
 * 谁先被插入取决于连接顺序，所以这是"有时对、有时错"的间歇性错误。
 *
 * 修法两条：
 *   ① **最长匹配优先** —— `pc-2`(4) 胜过 `pc`(2)，把劫持消掉；
 *   ② **词边界** —— 匹配位置的相邻字符不能也是 id 字符，避免
 *      `pc` 命中 `apc` / `pcx` 这类"包含关系"。
 * 等长冲突（两个不同 id 以同样长度命中）时返回 '' 让上层走"唯一在线节点"
 * 规则或报"请在 label 里写明节点名"—— 宁可让调用方补一句，不可猜错机器。
 */
export function nodeHintFromLabel(label, registry) {
  // 句末标点不属于节点名，先剥掉：否则 "run on pc." 会被词边界判成不匹配。
  const text = String(label ?? '').trim().toLowerCase().replace(/[.!?,;。！？，；]+$/, '')
  if (text === '') return ''
  const nodes = registry?.nodes
  if (!nodes || typeof nodes.values !== 'function') return ''

  let best = ''
  let bestLen = 0
  let ambiguous = false
  for (const rec of nodes.values()) {
    const id = typeof rec?.nodeId === 'string' ? rec.nodeId : ''
    if (id === '') continue
    const host = String(rec.hello?.hostname ?? '')
    for (const token of [id, host]) {
      if (token === '') continue
      const needle = token.toLowerCase()
      if (!containsNodeToken(text, needle)) continue
      if (needle.length > bestLen) {
        best = id
        bestLen = needle.length
        ambiguous = false
      } else if (needle.length === bestLen && best !== '' && best !== id) {
        // 两个不同节点等长命中：label 不足以定位，交给上层。
        ambiguous = true
      }
    }
  }
  return ambiguous ? '' : best
}

/** needle 是否在 text 里以"完整节点名"的形态出现（两侧不能还是 id 字符）。 */
function containsNodeToken(text, needle) {
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + needle.length] ?? ''
    if (!NODE_TOKEN_CHAR.test(before) && !NODE_TOKEN_CHAR.test(after)) return true
    from = at + 1
  }
}

/** goal 收敛：截断而不是抛（一条超长 prompt 不该让整个派单失败）。 */
function clampGoal(text) {
  if (text.length <= MAX_GOAL_CHARS) return text
  return `${text.slice(0, MAX_GOAL_CHARS)}${GOAL_TRUNCATED_MARK}`
}

/**
 * request.prompt（ContentBlock[]）里的文本拼成 goal。非文本块如实标注，不静默丢弃。
 *
 * 两种输入形态都收：
 *   - `ContentBlock[]` —— 框架契约。
 *   - 裸 `string` —— 旧实现直接当成"不是数组 → 空 parts → goal 为 ''"，
 *     于是 `start()` 回落到用 **label 当 goal**：派出去的活变成了派单标题，
 *     调用方看不到任何异常（静默数据丢失）。多认一种输入比丢掉内容安全。
 */
export function promptToGoal(prompt) {
  if (typeof prompt === 'string') return clampGoal(prompt.trim())
  const blocks = Array.isArray(prompt) ? prompt : []
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
      continue
    }
    if (typeof b.type === 'string') parts.push(`[${b.type.slice(0, MAX_BLOCK_TYPE_CHARS)} block omitted]`)
  }
  return clampGoal(parts.join('\n\n').trim())
}

/**
 * 任务状态 → SubagentStopReason。
 *
 * **显式全表**，不用 switch 的 default 兜底：default 会让"protocol.js 新增了
 * 一个状态"这件事静默通过（新状态自动落进 error，看起来一切正常），而状态机
 * 是冻结层里最该被钉住的东西。这里逐条列出 TASK_STATUS 全集，测试再遍历
 * TASK_STATUS 断言每个键都在表里 —— 将来加状态就会红。
 */
export const STOP_REASON_BY_STATUS = Object.freeze({
  [TASK_STATUS.COMPLETED]: 'completed',
  [TASK_STATUS.ABORTED]: 'aborted',
  [TASK_STATUS.FAILED]: 'error',
  [TASK_STATUS.INTERRUPTED]: 'error',
  // 非终态：正常路径不会走到这里（result 等的是 awaitTerminal）。真到了说明
  // "run 结束了但任务没有终态"，那本身就是错误，如实报 error 而不是假装完成。
  [TASK_STATUS.QUEUED]: 'error',
  [TASK_STATUS.RUNNING]: 'error',
  // 两阶段审批（提案 #2）：PENDING_APPROVAL 非终态（到这儿同样是异常）；
  // REJECTED 终态 —— 任务从未跑过，按不变式归 error（没有"完成"语义）。
  [TASK_STATUS.PENDING_APPROVAL]: 'error',
  [TASK_STATUS.REJECTED]: 'error',
})

/** 未知状态（副机上报了本 hub 不认识的 status）→ error，不返回 undefined。 */
export function stopReasonOf(status) {
  return STOP_REASON_BY_STATUS[status] ?? 'error'
}

/**
 * 把副机上报的任务视图收敛成 fallbackText 能安全解引用的形状。
 *
 * 副机的 `progressTail` / `logTail` 是**不可信输入**（`node-registry.applyView`
 * 把 task/sync 里的数组原样存下）。旧实现直接 `for (const p of progress)` 读
 * `p.phase` —— 副机上报一个 `null` 元素就让这里抛 TypeError，异常被 provider
 * 的兜底 catch 吞掉，于是一个**已完成**的任务被上报成
 * "未完成：Cannot read properties of null"。这既是崩溃源，也让调用方完全
 * 看不到真实结果。views.js 里已经为此写过一次（`progressTailView`），
 * 这里改用同一份投影，不再各写一份。
 */
function projectTaskForText(task) {
  if (!task || typeof task !== 'object') return {}
  return {
    taskId: typeof task.taskId === 'string' ? task.taskId : null,
    nodeId: typeof task.nodeId === 'string' ? task.nodeId : null,
    status: typeof task.status === 'string' ? task.status : 'unknown',
    // workspace 是**绝对路径**，会回显主机目录结构，与 handoffView 的取舍一致：不回传。
    error: task.error && typeof task.error === 'object'
      ? {
        code: typeof task.error.code === 'string' ? task.error.code : '',
        message: typeof task.error.message === 'string' ? task.error.message.slice(0, 500) : '',
      }
      : null,
    progressTail: progressTailView(task.progressTail, { tail: 10 }),
    logTail: Array.isArray(task.logTail)
      ? task.logTail.slice(-15).map((l) => String(l).slice(0, 300))
      : [],
  }
}

/**
 * @param {object} o
 * @param {import('./node-registry.js').NodeRegistry} o.registry
 * @param {import('./pull-manager.js').PullManager} o.pulls
 * @param {(level:string,msg:string,extra?:object)=>void} [o.log]
 * @param {object} [o.defaults]
 * @returns {object} SubagentProvider
 */
export function createRemoteAgentProvider({ registry, pulls, log, defaults = {}, sessionGate = null }) {
  // 三个都做兜底：provider 是**可选服务**（hub 可能跑在没有 subagents 的组合里），
  // 少传一个 log / pulls 不该让派单在 `log(...)` 处抛 TypeError —— 那是
  // "装配期少一个依赖 → 运行期炸在第一个任务上"，最难排查的一类失败。
  const emit = typeof log === 'function' ? log : () => {}
  const cancelPulls = (taskId) => {
    try {
      pulls?.cancelTask?.(taskId)
    } catch {
      /* 取消是尽力而为：pull 侧状态异常不该影响 result 落定 */
    }
  }
  // 只接受**正的**有限数：`0` / 负数会被 validateTaskStart 夹到下限 1000ms，
  // 于是一个配错成 `timeoutMs: -1` 的部署会让每条任务在 1 秒后被判超时 ——
  // 比回落到 1 小时更糟（错得静默且看起来像"任务真的失败了"）。
  const defaultTimeoutMs =
    Number.isFinite(defaults.timeoutMs) && defaults.timeoutMs > 0 ? defaults.timeoutMs : 60 * 60 * 1000
  const ackTimeoutMs = registry?.limits?.ackTimeoutMs ?? 60_000

  return {
    name: 'remote-agent',
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,

    async start(request) {
      const denied = sessionGate?.guard?.({ name: 'remote_task', agent: request?.parent })
      if (denied) throw new Error(denied)
      const label = typeof request?.label === 'string' ? request.label : ''
      const goal = promptToGoal(request?.prompt)
      const hint = nodeHintFromLabel(label, registry)

      let nodeId
      if (hint !== '') {
        nodeId = hint
      } else {
        const online = registry.onlineNodes()
        if (online.length === 0) throw new Error('remote-agent: 没有在线节点，先让副机接入')
        if (online.length > 1) {
          throw new Error(
            `remote-agent: 有多个在线节点（${online.map((n) => n.nodeId).join(', ')}），请在 label 里写明节点名`,
          )
        }
        nodeId = online[0].nodeId
      }

      const taskId = newTaskId()
      const v = validateTaskStart({
        taskId,
        goal: goal === '' ? label || '(empty prompt)' : goal,
        mode: TASK_MODE.AGENT,
        constraints: { timeoutMs: defaultTimeoutMs },
        origin: 'subagent',
      })
      if (!v.ok) throw new Error(`remote-agent: invalid task (${v.error})`)

      const rec = registry.getNode?.(nodeId)
      if ((rec?.hello?.caps ?? rec?.caps)?.includes?.('selfcheck')) {
        const report = await registry.fsRequest(nodeId, 'selfcheck', { purpose: 'agent' }, { timeoutMs: 30_000 })
        if (report?.verdict === 'blocked') {
          const ids = Array.isArray(report.blockingFailures) ? report.blockingFailures.map((x) => x.id).filter(Boolean).join(', ') : 'unknown'
          throw new Error(`remote-agent: 副机自检未通过（${ids}），请先修复节点环境`)
        }
      }

      // 同步可判定的失败在这里抛出：框架约定"start 拒绝 ⇒ 没有 run 需要释放"。
      registry.createTask({ nodeId, spec: v.spec })
      emit('info', 'subagent run dispatched', { taskId, nodeId, label })

      let cancelled = false
      // result 落定后 dispose() 不该再发 task/cancel：任务已经跑完，再发一条取消
      // 只会让副机日志里多一条莫名其妙的 cancel，也可能打断同 id 的后续状态上报。
      let settled = false
      let resolveCancel
      const cancelPromise = new Promise((r) => {
        resolveCancel = r
      })
      const cancel = () => {
        if (cancelled) return
        cancelled = true
        cancelPulls(taskId)
        try {
          registry.cancelTask(taskId)
        } catch {
          /* 节点已离线等：取消尽力而为 */
        }
        resolveCancel()
      }

      const result = (async () => {
        const signal = request?.signal
        const onAbort = () => cancel()
        try {
          if (signal) {
            if (signal.aborted) cancel()
            else signal.addEventListener('abort', onAbort, { once: true })
          }

          // 两条路竞争：任务真的跑到终态，或持有者放弃了这次运行。
          //
          // 为什么取消要单独成一条路：dispose() / signal abort 的语义是
          // "持有者不再要这次运行"，result 必须**及时**落定。若只等副机的终态帧，
          // 一条刚派出去、副机还没回话的任务会把 result 挂到 ackTimeout 之后。
          // 取消请求照发不误 —— 副机侧的任务该停还是要停。
          const work = (async () => {
            // 等 accept：节点拒绝工作区时会立刻回终态，所以两条路一起等。
            await registry.awaitAccepted(taskId, { timeoutMs: ackTimeoutMs })
            // 等终态。任务超时由副机自己执行并如实上报；这里的上界只是兜底，
            // 防止节点中途彻底失联时把 subagent 永久挂住。
            return registry.awaitTerminal(taskId, { timeoutMs: defaultTimeoutMs + ackTimeoutMs * 2 })
          })()
          work.catch(() => {}) // 竞争失败的那条不产生未处理 rejection

          const raced = await Promise.race([
            work.then(
              (terminal) => ({ kind: 'terminal', terminal }),
              (err) => ({ kind: 'error', err }),
            ),
            cancelPromise.then(() => ({ kind: 'cancelled' })),
          ])

          if (raced.kind === 'cancelled') {
            const task = registry.getTask(taskId)
            return {
              output: [
                {
                  type: 'text',
                  text: `远程任务 ${taskId} 已请求取消（节点 ${nodeId}，最后一次状态 ${task?.status ?? 'unknown'}）。`,
                },
              ],
              structured: { taskId, nodeId, status: task?.status ?? 'unknown', cancelled: true },
              stopReason: 'aborted',
              diagnostic: 'run cancelled by the holder',
            }
          }

          if (raced.kind === 'error') {
            cancel()
            const task = registry.getTask(taskId)
            return {
              output: [{ type: 'text', text: `远程任务 ${taskId} 未完成：${String(raced.err?.message ?? raced.err)}` }],
              structured: { taskId, nodeId, status: task?.status ?? 'unknown' },
              stopReason: String(raced.err?.code ?? '') === 'aborted' ? 'aborted' : 'error',
              diagnostic: String(raced.err?.message ?? raced.err),
            }
          }

          const terminal = raced.terminal
          const handoff = terminal.handoff
          // handoff 是**副机上报**的对象，字段集不受本文件控制：它会带
          // workspace（绝对路径）、logs（可能含环境变量）、以及它版本的任何
          // 新字段。工具路径（remote_handoff）早已改成走 handoffView，这里
          // 曾经是 `structured: handoff` 裸直出 —— 而 provider 的返回值会进
          // 主机会话日志，比 UI 那条路径更该加固（views.js 记的正是这个教训）。
          const projected = handoffView(handoff)
          // 文本渲染里有一行"工作区"，而 handoffView **刻意**不含 workspace
          // （绝对路径会回显主机目录结构）。这里给一个明确的占位，而不是让
          // handoffSummaryText 打出 "undefined" —— 交付给人看的文本不该出现
          // 未定义值，而且 "未回传" 本身就是正确信息。
          const textSource = projected ? { ...projected, workspace: '(未回传)' } : null
          const body = textSource
            ? handoffSummaryText({ taskId, handoff: textSource })
            : fallbackText(projectTaskForText(terminal))
          return {
            output: [{ type: 'text', text: body }],
            structured: projected ?? { taskId, nodeId, status: terminal.status },
            stopReason: stopReasonOf(terminal.status),
            diagnostic:
              terminal.status === TASK_STATUS.COMPLETED
                ? undefined
                : `${terminal.error?.code ?? terminal.status}: ${terminal.error?.message ?? 'remote task did not complete'}`,
          }
        } catch (err) {
          // 兜底：任何意外都要落成一个 SubagentResult，绝不让 result 悬挂。
          cancel()
          const task = registry.getTask(taskId)
          return {
            output: [{ type: 'text', text: `远程任务 ${taskId} 未完成：${String(err?.message ?? err)}` }],
            structured: { taskId, nodeId, status: task?.status ?? 'unknown' },
            stopReason: String(err?.code ?? '') === 'aborted' ? 'aborted' : 'error',
            diagnostic: String(err?.message ?? err),
          }
        } finally {
          settled = true
          if (signal) {
            try {
              signal.removeEventListener('abort', onAbort)
            } catch {
              /* signal 已失效 */
            }
          }
        }
      })()
      // result 的拒绝已在内部全部转成 SubagentResult，这里再兜一层，
      // 避免一个未处理的 rejection 打挂 host。
      result.catch(() => {})

      return {
        id: taskId,
        localAgent: undefined,
        result,
        async dispose() {
          if (settled) return
          cancel()
        },
      }
    },
  }
}

function fallbackText(task) {
  const t = task && typeof task === 'object' ? task : {}
  const lines = [
    `# 远程任务 ${t.taskId ?? '(unknown)'}`,
    '',
    `- 节点：${t.nodeId ?? '(unknown)'}`,
    `- 状态：${t.status ?? 'unknown'}`,
  ]
  if (t.error) lines.push(`- 错误：${t.error.code}: ${t.error.message}`)
  const progress = Array.isArray(t.progressTail) ? t.progressTail : []
  if (progress.length > 0) {
    lines.push('', '进度尾巴：')
    for (const p of progress.slice(-10)) lines.push(`- ${p.phase}${p.detail ? `: ${String(p.detail).slice(0, 200)}` : ''}`)
  }
  const logs = Array.isArray(t.logTail) ? t.logTail : []
  if (logs.length > 0) {
    lines.push('', '日志尾巴：')
    for (const l of logs.slice(-15)) lines.push(`> ${String(l).slice(0, 300)}`)
  }
  if (!TERMINAL_STATUS.has(t.status)) lines.push('', '（任务尚未结束，副机仍在本地运行。）')
  return lines.join('\n')
}

export { ERROR_CODE }
