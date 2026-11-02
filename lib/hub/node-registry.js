/**
 * 主机侧节点注册表·核心（零外部依赖）。
 *
 * 定位：hub 眼里"有哪些副机、它们各自在跑什么"的唯一真身。
 *
 * 三条不变式（与 protocol.js / task-store.js 的契约对齐）：
 *   1. **任务状态的真身在副机** —— hub 只维护投影。断连只把 online 置 false，
 *      绝不清 tasks；重连后靠副机主动 task/sync 全量重建视图。
 *   2. **同 nodeId 第二实例拒掉新的** —— 正在跑的任务不能被挤掉，保住已在跑的那个连接。
 *   3. **任何一帧的解析失败只记日志** —— 一个畸形帧不能打挂 host。
 *
 * 两种接入方式的接入/握手在 registry-handshake.js，帧摄入在 registry-ingest.js，
 * 各自以 mixin 合入（见文件尾的 NodeRegistry 组合）。
 *
 * 本文件是 hub 目录的依赖叶子（不反向 import index.js —— 会成环）。
 *
 * P1-4 拆分：RelayLink → relay-link.js（此处 re-export 保持 import 兼容），
 * 日志器与小工具 → hub-util.js，帧摄入 → registry-ingest.js，
 * 连接接入/握手/身份 → registry-handshake.js。本文件只留核心注册表。
 */
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  RemoteAgentError,
  TASK_STATUS,
  TERMINAL_STATUS,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
} from '../protocol.js'
// 视图投影共享层：registry 给工具用的任务视图与 UI 路由共用同一份白名单。
import { taskView as taskProjection } from './views.js'
import { errText } from './hub-util.js'
// 统一错误翻译层（2026-10-20，体验提升 ①）：连接失败时给面板"人话 + 下一步"。
import { explainError } from '../explain-error.js'
import { withIngest } from './registry-ingest.js'
import { withHandshake } from './registry-handshake.js'

// RelayLink 真身在 relay-link.js；re-export 让既有 import 路径继续可用。
export { RelayLink } from './relay-link.js'

/**
 * 节点注册表。
 *
 * @typedef {object} HubTask
 * @property {string} taskId
 * @property {string} nodeId
 * @property {object} spec          派单时的 TaskSpec（协议层已归一化）
 * @property {string} status
 * @property {boolean} accepted
 * @property {object|null} handoff  副机上报的交接卡
 * @property {object|null} manifest hub 侧从 handoff 派生的产物清单
 * @property {Set<object>} waiters  等待 accept / 终态的等待者
 */
class NodeRegistryCore {
  /**
   * @param {object} [identity] hub 身份（lib/identity.js loadOrCreateHubIdentity 的返回值）。
   *   缺省 / 不完整 = hub 身份认证能力关闭：welcome 不带 identity，relay 不追发，
   *   副机按旧协议处理 —— 身份子系统故障绝不演变成"拒绝所有副机"。
   */
  constructor({ log, limits = {}, relay = null, identity = null, audit = null } = {}) {
    this.log = log ?? (() => {})
    this.limits = {
      helloTimeoutMs: 10_000,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      pullTimeoutMs: DEFAULT_PULL_TIMEOUT_MS,
      maxPullBytes: 512 * 1024 * 1024,
      maxTasksPerNode: 64,
      // 两阶段审批（提案 #2）：挂起超过此时长自动拒绝（fail-closed）。
      // 0 = 不设超时（任务一直挂着等人，仍不会自动批准）。
      approvalTimeoutMs: 30 * 60 * 1000,
      ...limits,
    }
    /** @type {import('./audit-log.js').createAuditLog | null} 审计写入器（提案 #19，null = 关闭）。 */
    this.audit = audit && typeof audit.record === 'function' ? audit : null
    /** nodeId → rec */
    this.nodes = new Map()
    /**
     * 连接尝试历史（2026-10-20，体验提升 ①）。
     *
     * 问题：副机连不上时，主机只显示「0 在线」，**没有任何原因**。
     * 实测用户为此排查了两天（重启回引导页、19387 不监听、SMB 密码…）。
     *
     * 这里记**每一次连接尝试的结果**（成功/失败 + 原因 + 时间 + 远端地址），
     * 面板据此显示"最后尝试 2 分钟前 —— 握手超时 → 检查…"。
     *
     * 上限 50 条（环形）：这是给人看的诊断线索，不是审计日志
     * （审计是 audit.jsonl，那是给合规/追溯用的）。
     */
    this.connectionLog = []
    /** 等 hello 的连接 */
    this.pending = new Set()
    /** taskId → NodeJS.Timeout（两阶段审批的自动拒绝定时器，提案 #2） */
    this.pendingApprovals = new Map()
    /** taskId → HubTask（全局索引，工具只拿得到 taskId） */
    this.tasks = new Map()
    /** reqId → { resolve, timer }（提案 #25：远程文件请求的等待者表） */
    this.fsPending = new Map()
    /**
     * reqId → { resolve, timer }（2026-10-17：工作区共享请求的等待者表）。
     *
     * 与 fsPending **刻意分开**：fs 是"读文件内容"、share 是"探测共享状态并
     * 生成命令"，两者语义不同。混用一张表会让超时归因变模糊（一条 share 超时
     * 被记成 fs-timeout，排查方向直接跑偏）。
     */
    this.sharePending = new Map()
    /** @type {import('./pull-manager.js').PullManager | undefined} */
    this.pulls = undefined
    /** @type {import('./relay-link.js').RelayLink | undefined} */
    this.relay = relay ?? null
    /** hub 身份（P2-11）：privateKeyB64/publicKeyB64/fingerprint；null = 无身份能力。 */
    this.identity = identity && typeof identity.privateKeyB64 === 'string' ? identity : null
    this.timer = undefined
    this.closed = false
    this.startedAt = Date.now()
  }

  /** 绑定产物拉取管理器（二进制帧路由目标）。 */
  bindPulls(pulls) {
    this.pulls = pulls
  }

  /**
   * 审计一条事件（提案 #19）。绝不抛、绝不阻塞 —— 审计挂了任务链路照常跑，
   * 这是不变式（见 audit-log.js 头注释的优先级 1）。
   */
  auditRecord(event, fields) {
    try {
      this.audit?.record(event, fields)
    } catch {
      /* 审计层的任何异常都不上抛 */
    }
  }

  // ─────────────────────────── 自动选节点（提案 #14） ───────────────────────────

  /**
   * 负载感知自动选节点：不指定 node 时按"在跑任务数 → CPU → 内存占用 → nodeId"
   * 逐级排序取最优。逐级比较而非加权求和——权重魔法数永远有反例，而字典序
   * 确定可解释、可测试。
   *
   * @param {object} [o]
   * @param {string} [o.mode] 'agent' 时只考虑支持 agent 后端的节点
   *   （hello.agentMode !== false）；'exec' 无能力要求。
   * @param {Array<{nodeId: string}>} [o.candidates] 候选节点摘要（repo 路由
   *   预筛后的子集，提案 #13）。省略用全部在线节点；空数组返回 null。
   * @returns {string|null} 最优节点 id；没有在线节点 / 无能力匹配的节点时 null。
   */
  pickAutoNode({ mode, candidates } = {}) {
    // candidates 传的是"候选节点引用"（repo 路由预筛出的子集，提案 #13）——
    // 统一按 nodeId 解析回完整 rec（与 onlineNodes 同形态），下游的
    // agentMode 过滤 / 负载字段都读 rec 上的 hello/resource。
    const online = Array.isArray(candidates)
      ? candidates.map((c) => this.nodes.get(c?.nodeId)).filter((r) => r && r.online)
      : this.onlineNodes()
    if (online.length === 0) return null
    const capable = mode === 'agent' ? online.filter((n) => n.hello?.agentMode === true) : online
    if (capable.length === 0) return null

    const activeOf = (n) => {
      const rec = this.nodes.get(n.nodeId)
      if (!rec || !(rec.tasks instanceof Map)) return 0
      let count = 0
      for (const t of rec.tasks.values()) {
        if (t && !TERMINAL_STATUS.has(t.status)) count += 1
      }
      return count
    }
    // cpuPct 缺失（老遥测未到）视为 +Inf——显式"有数据的优先"；
    // ⚠ 比较必须用 cmp 而非减法：Infinity - Infinity = NaN，会让 sort 行为未定义。
    const cpuOf = (n) => (typeof n.resource?.cpuPct === 'number' ? n.resource.cpuPct : Number.POSITIVE_INFINITY)
    const memRatioOf = (n) => {
      const used = n.resource?.memUsedMb
      const total = n.resource?.memTotalMb
      return typeof used === 'number' && typeof total === 'number' && total > 0 ? used / total : Number.POSITIVE_INFINITY
    }
    const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

    capable.sort((a, b) => {
      const byActive = cmp(activeOf(a), activeOf(b))
      if (byActive !== 0) return byActive
      const byCpu = cmp(cpuOf(a), cpuOf(b))
      if (byCpu !== 0) return byCpu
      const byMem = cmp(memRatioOf(a), memRatioOf(b))
      if (byMem !== 0) return byMem
      return a.nodeId < b.nodeId ? -1 : 1 // 稳定 tie-break：同负载按 id 字典序
    })
    return capable[0].nodeId
  }

  /**
   * 按仓库选节点（提案 #13）：在"持有匹配仓库的在线节点"里做负载感知
   * 自动选。匹配口径：repo 名精确（大小写不敏感）> url 包含 > 本机路径
   * 包含 —— 三种写法都收，用户给 `my-app`、`github.com/me/my-app` 或
   * `D:\code\my-app` 都能命中。
   *
   * @param {string} repo 仓库名 / url 片段 / 本机路径片段
   * @param {object} [o] 同 pickAutoNode 的 { mode }
   * @returns {{ nodeId: string, repo: {name,url,path} }|null} 命中的节点与
   *   具体匹配到的仓库条目（workspace 兜底用）；无匹配返回 null。
   */
  pickNodeByRepo(repo, o = {}) {
    const want = typeof repo === 'string' ? repo.trim().toLowerCase() : ''
    if (want === '') return null
    const online = this.onlineNodes()
    const matches = []
    for (const n of online) {
      const rec = this.nodes.get(n.nodeId)
      if (!rec || !Array.isArray(rec.repos)) continue
      // 名字精确优先于包含匹配：先记包含匹配，遇到精确匹配直接定胜负
      let hit = null
      for (const r of rec.repos) {
        if (r.name.toLowerCase() === want) {
          hit = { nodeId: n.nodeId, repo: r }
          break
        }
        if (!hit && ((r.url !== '' && r.url.toLowerCase().includes(want)) || (r.path !== '' && r.path.toLowerCase().includes(want)))) {
          hit = { nodeId: n.nodeId, repo: r }
        }
      }
      if (hit) matches.push(hit)
    }
    if (matches.length === 0) return null
    // 名字精确匹配优先于包含匹配（跨节点同理）——但用 filter 而非 find：
    // 多个节点都精确持有时仍要交给负载排序挑，不能偷懒取第一个。
    const exacts = matches.filter((m) => m.repo.name.toLowerCase() === want)
    const pool = exacts.length > 0 ? exacts : matches
    const best = this.pickAutoNode({ ...o, candidates: pool.map((m) => ({ nodeId: m.nodeId })) })
    if (!best) return null
    return pool.find((m) => m.nodeId === best) ?? null
  }

  /** 全部在线节点上报的仓库名集合（去重）——repo 路由失败时给调用方提示用。 */
  knownRepoNames() {
    const names = new Set()
    for (const rec of this.nodes.values()) {
      if (!rec.online || !Array.isArray(rec.repos)) continue
      for (const r of rec.repos) {
        if (typeof r.name === 'string' && r.name !== '') names.add(r.name)
      }
    }
    return [...names]
  }

  /**
   * 在**指定节点**的上报清单里找匹配仓库（与 pickNodeByRepo 同一匹配口径，
   * 但不做跨节点路由）——用户同时给了 node + repo 时，repo 只用来兜
   * workspace，不能悄悄把任务派去别的机器。
   *
   * @returns {{name,url,path}|null} 匹配的仓库条目；没有则 null。
   */
  findRepoOn(nodeId, repo) {
    const want = typeof repo === 'string' ? repo.trim().toLowerCase() : ''
    if (want === '') return null
    const rec = this.nodes.get(nodeId)
    if (!rec || !Array.isArray(rec.repos)) return null
    let contains = null
    for (const r of rec.repos) {
      if (r.name.toLowerCase() === want) return r
      if (!contains && ((r.url !== '' && r.url.toLowerCase().includes(want)) || (r.path !== '' && r.path.toLowerCase().includes(want)))) {
        contains = r
      }
    }
    return contains
  }

  // ─────────────────────────── 任务视图 ───────────────────────────

  /** 取任务；不存在则登记一个（副机先上报、hub 后知道的情况）。 */
  ensureTask(nodeId, taskId) {
    if (typeof taskId !== 'string' || taskId === '') {
      this.log('warn', 'frame without taskId', { nodeId })
      return undefined
    }
    const existing = this.tasks.get(taskId)
    if (existing) return existing
    const rec = this.nodes.get(nodeId)
    if (!rec) return undefined
    const t = {
      taskId,
      nodeId,
      spec: null,
      status: TASK_STATUS.QUEUED,
      accepted: false,
      adopted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      mode: null,
      goal: null,
      workspace: null,
      sessionId: null,
      exit: null,
      changed: [],
      error: null,
      summary: null,
      manifestCounts: null,
      manifest: null,
      handoff: null,
      progressTail: [],
      logTail: [],
      waiters: new Set(),
    }
    rec.tasks.set(taskId, t)
    this.tasks.set(taskId, t)
    this.log('info', 'task adopted from node report', { taskId, nodeId })
    return t
  }

  getTask(taskId) {
    return this.tasks.get(taskId)
  }

  listTasks() {
    return [...this.tasks.values()]
  }

  /**
   * 工具 remote_status 的输出形状。
   *
   * **必须经 views.js 投影**：这里的每个字段都源自副机上报（`exit`/`changed`/
   * `summary`/`error` 里可能有副机版本的诊断字段），而工具返回值会进会话日志。
   * 此前是逐字段裸拷贝（`exit: t.exit` 等），等于把"副机写什么就回什么"交给模型。
   *
   * 与 UI 路径共用同一份白名单 —— 这是把投影收敛到 views.js 的意义：
   * 新增消费方无处可绕开。
   */
  taskView(t) {
    const rec = this.nodes.get(t.nodeId)
    const base = taskProjection(
      {
        ...t,
        nodeOnline: Boolean(rec?.online),
        // taskProjection 读 t.summary.text，而注册表里存的是 summary 对象
        summary: t.summary && typeof t.summary === 'object' ? t.summary : null,
      },
      { tail: 6 },
    )
    return {
      ...base,
      accepted: t.accepted === true,
      handoffAvailable: Boolean(t.handoff),
    }
  }

  // ─────────────────────────── 等待器 ───────────────────────────

  /**
   * 等一个任务满足条件。超时与取消都会 reject，且一定清理定时器与监听器。
   */
  waitFor(t, predicate, { timeoutMs = 0, signal, label = 'wait' } = {}) {
    if (predicate(t)) return Promise.resolve(t)
    return new Promise((resolve, reject) => {
      const state = { settled: false, timer: undefined, onAbort: undefined }
      const waiter = { check: () => {}, fail: () => {} }
      const settle = (fn, arg) => {
        if (state.settled) return
        state.settled = true
        if (state.timer) clearTimeout(state.timer)
        if (state.onAbort && signal) {
          try {
            signal.removeEventListener('abort', state.onAbort)
          } catch {
            /* signal 可能已失效 */
          }
        }
        t.waiters.delete(waiter)
        fn(arg)
      }
      waiter.check = () => {
        if (predicate(t)) settle(resolve, t)
      }
      waiter.fail = (err) => settle(reject, err)

      if (timeoutMs > 0) {
        state.timer = setTimeout(() => {
          settle(reject, new RemoteAgentError(`${label}: timeout after ${timeoutMs}ms`, ERROR_CODE.INTERNAL))
        }, timeoutMs)
        if (state.timer.unref) state.timer.unref()
      }
      if (signal) {
        state.onAbort = () => settle(reject, new RemoteAgentError(`${label}: aborted`, 'aborted'))
        if (signal.aborted) {
          state.onAbort()
          return
        }
        signal.addEventListener('abort', state.onAbort, { once: true })
      }
      t.waiters.add(waiter)
      if (predicate(t)) waiter.check()
    })
  }

  /** 等 task/accept（或任务直接进入终态 —— 例如工作区被拒）。 */
  awaitAccepted(taskId, opts = {}) {
    const t = this.tasks.get(taskId)
    if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
    return this.waitFor(t, (x) => x.accepted === true || TERMINAL_STATUS.has(x.status), {
      label: `task ${taskId} accept`,
      timeoutMs: opts.timeoutMs ?? this.limits.ackTimeoutMs,
      signal: opts.signal,
    })
  }

  /** 等任务进入终态。 */
  awaitTerminal(taskId, opts = {}) {
    const t = this.tasks.get(taskId)
    if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
    return this.waitFor(t, (x) => TERMINAL_STATUS.has(x.status), {
      label: `task ${taskId} terminal`,
      timeoutMs: opts.timeoutMs ?? 0,
      signal: opts.signal,
    })
  }

  resolveWaiters(t) {
    if (!t.waiters || t.waiters.size === 0) return
    for (const w of [...t.waiters]) {
      try {
        w.check()
      } catch {
        /* 单个等待者出错不影响其他 */
      }
    }
  }

  // ─────────────────────────── 任务下发 ───────────────────────────

  /**
   * 下发一条任务（spec 必须是 validateTaskStart 归一化后的形状）。
   */
  createTask({ nodeId, spec }) {
    const rec = this.nodes.get(nodeId)
    if (!rec) throw new RemoteAgentError(`unknown node: ${nodeId}`, ERROR_CODE.TASK_UNKNOWN)
    if (!rec.online) throw new RemoteAgentError(`node offline: ${nodeId}`, ERROR_CODE.INTERNAL)

    // ═══════════════════════════════════════════════════════════════════════
    // 上限必须按**在跑的任务**算，不能按历史累计
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 原实现：`if (rec.tasks.size >= maxTasksPerNode)` —— 而 `rec.tasks` 里
    // **包含已完成的任务**：它们只在副机的 `task/sync` 不再上报时才被移除
    // （见 applySync 的清理分支），而副机的 TaskStore 默认保留 7 天。
    //
    // 后果（实测踩到）：连续派几十条测试任务后，hub 侧累计到 64 条，
    // **之后任何新任务都被拒**，报 `already holds 64 tasks` —— 连"派一条
    // 清理命令"都做不到，节点彻底不可用。这不是"限制并发"的本意。
    //
    // 正确语义：上限约束**同时进行的任务数**（防一个节点被压垮），
    // 终态任务不该占额度。这里按状态过滤。
    const activeCount = [...rec.tasks.values()].filter(
      (t) => t && !TERMINAL_STATUS.has(t.status),
    ).length
    if (activeCount >= this.limits.maxTasksPerNode) {
      throw new RemoteAgentError(
        `node ${nodeId} already has ${activeCount} active tasks (maxTasksPerNode=${this.limits.maxTasksPerNode})`,
        ERROR_CODE.INTERNAL,
      )
    }
    if (this.tasks.has(spec.taskId)) {
      throw new RemoteAgentError(`taskId already used: ${spec.taskId}`, ERROR_CODE.TASK_DUPLICATE)
    }

    const t = {
      taskId: spec.taskId,
      nodeId,
      spec,
      status: TASK_STATUS.QUEUED,
      accepted: false,
      adopted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      mode: spec.mode,
      goal: spec.goal,
      approval: spec.approval === 'manual' ? 'manual' : 'auto',
      workspace: spec.workspace ?? null,
      sessionId: null,
      exit: null,
      changed: [],
      error: null,
      summary: null,
      manifestCounts: null,
      manifest: null,
      handoff: null,
      progressTail: [],
      logTail: [],
      waiters: new Set(),
    }
    rec.tasks.set(spec.taskId, t)
    this.tasks.set(spec.taskId, t)

    // 两阶段审批（提案 #2）：manual 任务**挂起在 hub**，不派帧 —— 副机根本
    // 不知道它的存在，直到面板批准。超时自动拒绝（fail-closed：等不到人
    // 就是不跑，绝不默认放行）；approvalTimeoutMs=0 表示无限等待。
    if (spec.approval === 'manual') {
      t.status = TASK_STATUS.PENDING_APPROVAL
      this.log('info', 'task pending approval', { taskId: spec.taskId, nodeId })
      this.auditRecord('approval.pending', {
        taskId: spec.taskId,
        nodeId,
        mode: spec.mode,
        goal: typeof spec.goal === 'string' ? spec.goal : '',
        timeoutMs: this.limits.approvalTimeoutMs,
      })
      if (this.limits.approvalTimeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pendingApprovals.delete(spec.taskId)
          this.rejectTask(spec.taskId, { by: 'timeout', reason: 'approval-timeout' })
        }, this.limits.approvalTimeoutMs)
        if (timer.unref) timer.unref()
        this.pendingApprovals.set(spec.taskId, timer)
      }
      return t
    }

    const sent = this.send(nodeId, HUB_TO_NODE.TASK_START, { ...spec })
    if (!sent) {
      rec.tasks.delete(spec.taskId)
      this.tasks.delete(spec.taskId)
      throw new RemoteAgentError(`node unreachable: ${nodeId}`, ERROR_CODE.INTERNAL)
    }
    this.log('info', 'task dispatched', { taskId: spec.taskId, nodeId, mode: spec.mode })
    // 审计（提案 #19）：任务派发是"hub 替谁在哪台机器上跑了什么"的证据链起点。
    // 字段刻意保持扁平且过 sanitizeExtra（打码 + 400 字符截断）—— goal 可能
    // 含整段任务书，绝不能整段落盘。
    this.auditRecord('task.dispatch', {
      taskId: spec.taskId,
      nodeId,
      mode: spec.mode,
      workspace: typeof spec.workspace === 'string' ? spec.workspace : '',
      goal: typeof spec.goal === 'string' ? spec.goal : '',
      outputsCount: Array.isArray(spec.outputs) ? spec.outputs.length : 0,
      timeoutMs: spec.constraints?.timeoutMs,
    })
    return t
  }

  /** 取消任务。找不到 / 节点不在线都返回 false，不抛。 */
  cancelTask(taskId) {
    const t = this.tasks.get(taskId)
    if (!t) return false
    // 审批挂起中的任务还没到副机：发 TASK_CANCEL 只会换来 unknown taskId。
    // 直接本地拒绝（终态 rejected），副作用一致、语义更真。
    if (t.status === TASK_STATUS.PENDING_APPROVAL) {
      this.rejectTask(taskId, { by: 'hub-cancel', reason: 'cancelled while pending approval' })
      return true
    }
    const ok = this.send(t.nodeId, HUB_TO_NODE.TASK_CANCEL, { taskId, reason: 'hub-request' })
    if (ok) this.log('info', 'task cancel requested', { taskId, nodeId: t.nodeId })
    this.auditRecord('task.cancel', { taskId, nodeId: t.nodeId, delivered: ok === true })
    return ok
  }

  // ─────────────────────────── 两阶段审批（提案 #2） ───────────────────────────

  /**
   * 批准一个挂起任务：此刻才把 TASK_START 派给副机。
   *
   * 返回 false 表示"没有这条任务 / 不在挂起态"（调用方映射 404/409）；
   * 副机不可达时抛 node unreachable（与 createTask 同款，调用方映射 502）——
   * 批准动作要给出**明确的失败**，而不是把任务留在挂起态假装成功。
   *
   * @param {string} taskId
   * @param {object} [o]
   * @param {string} [o.by] 审批人标识（面板固定 'ui'；审计留痕用）
   * @returns {boolean}
   */
  approveTask(taskId, { by = 'ui' } = {}) {
    const t = this.tasks.get(taskId)
    if (!t || t.status !== TASK_STATUS.PENDING_APPROVAL) return false
    const timer = this.pendingApprovals.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.pendingApprovals.delete(taskId)
    }
    const rec = this.nodes.get(t.nodeId)
    const sent = rec?.online ? this.send(t.nodeId, HUB_TO_NODE.TASK_START, { ...t.spec }) : false
    if (!sent) {
      // 批准时节点已掉线：任务转 **failed 终态**，绝不静默退回挂起
      // （退回挂起会让"批了但没跑"变成无头案）。
      //
      // ⚠ 2026-10-17 修：原实现是 `this.tasks.delete(taskId)` —— 那让任务从
      // hub 视图**彻底消失**（不是失败、不是挂起，是不存在），与这段注释
      // 自称的"转 failed 终态"直接矛盾。后果：
      //   · `remote_status` / 面板都查不到该任务，用户以为批准成功
      //   · subagent provider 的 `awaitTerminal` 等不到终态，只能靠超时兜底
      //     （最长可挂 1 小时+）
      //   · 与 ui-routes 的 502 分支文案（"任务已转 failed"）不符
      //
      // 改成**保留记录并置终态**：状态可见、可查、可重试。
      t.status = TASK_STATUS.FAILED
      t.endedAt = Date.now()
      t.error = {
        code: 'node-unreachable',
        message: `approval could not be delivered: node ${t.nodeId} is unreachable`,
      }
      rec?.tasks.delete(taskId)
      this.auditRecord('approval.granted', { taskId, nodeId: t.nodeId, by, delivered: false })
      // 唤醒 awaitTerminal 等待者（不唤醒会让它们挂到超时）
      this.resolveWaiters(t)
      throw new RemoteAgentError(`node unreachable: ${t.nodeId}`, ERROR_CODE.INTERNAL)
    }
    t.status = TASK_STATUS.QUEUED
    t.updatedAt = Date.now()
    this.log('info', 'task approved and dispatched', { taskId, nodeId: t.nodeId, by })
    this.auditRecord('approval.granted', { taskId, nodeId: t.nodeId, by, delivered: true })
    this.auditRecord('task.dispatch', {
      taskId,
      nodeId: t.nodeId,
      mode: t.spec?.mode,
      workspace: typeof t.spec?.workspace === 'string' ? t.spec.workspace : '',
      goal: typeof t.spec?.goal === 'string' ? t.spec.goal : '',
      outputsCount: Array.isArray(t.spec?.outputs) ? t.spec.outputs.length : 0,
      timeoutMs: t.spec?.constraints?.timeoutMs,
    })
    return true
  }

  /**
   * 拒绝一个挂起任务（面板拒绝 / 审批超时 / 挂起期间取消共用此路径）。
   * 幂等：任务不存在或已不在挂起态返回 false。
   */
  rejectTask(taskId, { by = 'ui', reason = '' } = {}) {
    const t = this.tasks.get(taskId)
    if (!t || t.status !== TASK_STATUS.PENDING_APPROVAL) return false
    const timer = this.pendingApprovals.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.pendingApprovals.delete(taskId)
    }
    t.status = TASK_STATUS.REJECTED
    t.endedAt = Date.now()
    t.updatedAt = t.endedAt
    t.error = { code: reason === 'approval-timeout' ? 'approval-timeout' : 'approval-rejected', message: `审批未通过（${by}）${reason ? `：${reason}` : ''}` }
    this.log('info', 'task approval rejected', { taskId, nodeId: t.nodeId, by, reason })
    this.auditRecord('approval.rejected', { taskId, nodeId: t.nodeId, by, reason })
    this.resolveWaiters(t)
    return true
  }

  /**
   * 清理 hub 侧的**终态**任务视图。
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 为什么需要它（实测踩到的死锁）
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * hub 侧的任务视图只在**副机的 `task/sync` 不再上报某任务**时才清理
   * （见 `applySync`）。而副机的 TaskStore 默认保留 7 天 —— 于是：
   *
   *   连续派 N 条任务 → hub 视图累积 N 条 → 撞上 `maxTasksPerNode`
   *   → **之后任何新任务都被拒**，连"派一条清理命令"都做不到
   *
   * 这是**自锁**：唯一的解法是人工去副机删文件。实测连续几十条测试任务后
   * 节点就不可用了。
   *
   * ── 这个方法的语义 ────────────────────────────────────────────────────────
   * **只清 hub 侧的视图，不碰副机的任务状态** —— 副机是任务状态的权威
   * （见 lib/node/task-store.js），hub 只是投影。所以：
   *
   *   - 清掉后，如果副机还在 sync 里上报这些任务，它们会**自动重建**
   *     （`applySync` → `ensureTask`）。这没问题 —— 说明副机还认为它们该在。
   *   - 清掉后，`remote_status` 查不到已清的任务。这是**用户主动要求**的结果。
   *
   * 也就是说：本方法是"重置 hub 视图"的逃生舱，幂等、可重复调用。
   *
   * @param {object} [o]
   * @param {string} [o.nodeId] 只清这个节点；省略则清全部
   * @param {boolean} [o.includeActive=false] 是否连**在跑的任务**也清
   *   （默认只清终态。清在跑的会让 `remote_status` 查不到，但任务仍在副机继续跑）
   * @returns {{removed: number, kept: number}}
   */
  purgeTasks({ nodeId, includeActive = false } = {}) {
    let removed = 0
    let kept = 0
    for (const [taskId, t] of [...this.tasks]) {
      if (typeof nodeId === 'string' && nodeId !== '' && t.nodeId !== nodeId) continue
      const terminal = TERMINAL_STATUS.has(t.status)
      if (!terminal && !includeActive) {
        kept += 1
        continue
      }
      this.tasks.delete(taskId)
      const rec = this.nodes.get(t.nodeId)
      if (rec) rec.tasks.delete(taskId)
      removed += 1
    }
    if (removed > 0) this.log('info', 'task views purged', { removed, kept, nodeId: nodeId ?? '(all)' })
    return { removed, kept }
  }

  // ─────────────────────────── 发送 ───────────────────────────

  /**
   * E2E 明文帧类型（提案 #1）：这些帧在会话存在时也**不加密**。
   *
   *   - welcome / hub-identity：握手帧，会话建立之前发；hub 重启后重发时
   *     rec.e2e 可能还是旧会话（副机侧已重置）—— 封了密副机就解不开，
     *     永远上不了线。这两帧的内容是公钥与指纹，本就可公开。
   *   - hub/e2e：确认帧本身就是密钥交换的一部分，必须明文。
   *   - error(e2e-reset)：会话丢失时的重协商信号，双方此时无共享密钥。
   *   - ping/pong：应用层心跳，无秘密；明文还能在会话半建立期保活。
   */
  static E2E_CLEAR_TYPES = new Set([
    HUB_TO_NODE.WELCOME,
    HUB_TO_NODE.IDENTITY,
    HUB_TO_NODE.E2E_ACK,
    HUB_TO_NODE.PING,
    NODE_TO_HUB.PONG,
  ])

  /**
   * 发一个文本帧给节点。
   * `to` 始终带上：直连时无害，经中继时是路由依据。
   * 节点有 E2E 会话（提案 #1）时 d 字段自动封密（上述明文白名单除外）。
   */
  send(nodeId, type, data, opts = {}) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    const rec = this.nodes.get(nodeId)
    const env = envelope(type, data, opts)
    const e2eReset = type === HUB_TO_NODE.ERROR && data?.code === ERROR_CODE.E2E_RESET
    if (rec?.e2e && !NodeRegistryCore.E2E_CLEAR_TYPES.has(type) && !e2eReset) {
      try {
        env.d = rec.e2e.sealFrame(type, env.id, env.d)
      } catch (err) {
        // 封密失败（会话已销毁等）：丢帧比发明文更安全 —— 明文会进中继日志。
        this.log('warn', 'e2e seal failed, frame dropped', { nodeId, type, error: errText(err) })
        return false
      }
    }
    const text = encodeFrame({ ...env, to: nodeId })
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.send(text)
        return true
      } catch (err) {
        this.log('warn', 'send failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.send(nodeId, text)
    return false
  }

  /**
   * 远程文件请求（提案 #25）：发 fs/req 并等 fs/res，超时 fail-fast。
   *
   * 为什么不用既有工具的"发完就走"模式：ls/read/grep/tree 是**查询语义**，
   * 调用方（AI 工具）必须拿到结果才有意义 —— 所以这里把"发帧 + 等 replyTo"
   * 包成一个 promise。超时拒收而不是无限等：节点掉线 / 帧丢失时调用方拿到
   * fs-timeout 而不是永久挂起。
   *
   * @returns {Promise<object>} node 回的 result（或 reject {code, message}）
   */
  fsRequest(nodeId, op, params = {}, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const rec = this.nodes.get(nodeId)
      if (!rec?.online) {
        reject(Object.assign(new Error(`node not online: ${nodeId}`), { code: ERROR_CODE.TASK_UNKNOWN }))
        return
      }
      const env = envelope(HUB_TO_NODE.FS_REQ, { op, ...params })
      const reqId = env.id
      const timer = setTimeout(() => {
        this.fsPending.delete(reqId)
        this.log('warn', 'fs request timeout', { nodeId, op, reqId, timeoutMs })
        reject(Object.assign(new Error(`fs ${op} timed out after ${timeoutMs}ms`), { code: ERROR_CODE.FS_TIMEOUT }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.fsPending.set(reqId, { resolve, reject, timer, op, nodeId })
      const sent = this.send(nodeId, HUB_TO_NODE.FS_REQ, { op, ...params }, { id: reqId })
      if (!sent) {
        clearTimeout(timer)
        this.fsPending.delete(reqId)
        reject(Object.assign(new Error(`failed to send fs request to ${nodeId}`), { code: ERROR_CODE.TASK_UNKNOWN }))
      }
    })
  }

  /** fs/res 到达：按 replyTo 找等待者并唤醒（registry-ingest 的 FS_RES case 转发到这里）。 */
  handleFsRes(nodeId, d) {
    const reqId = typeof d.replyTo === 'string' ? d.replyTo : ''
    const waiter = reqId !== '' ? this.fsPending.get(reqId) : undefined
    if (!waiter) {
      // 迟到的响应（超时后才回来）：丢弃即可，等待者已经拿到 fs-timeout
      this.log('info', 'late fs response dropped', { nodeId, reqId })
      return
    }
    clearTimeout(waiter.timer)
    this.fsPending.delete(reqId)
    if (d.ok === true) {
      waiter.resolve(d.result ?? {})
    } else {
      waiter.reject(Object.assign(
        new Error(typeof d.message === 'string' ? d.message : 'fs request failed'),
        {
          code: typeof d.code === 'string' ? d.code : ERROR_CODE.INTERNAL,
          ...(Number.isSafeInteger(d.expectedOffset) ? { expectedOffset: d.expectedOffset } : {}),
          ...(Number.isSafeInteger(d.actualOffset) ? { actualOffset: d.actualOffset } : {}),
        },
      ))
    }
  }

  /** 节点断连：清掉它名下还没等到 fs/res 的等待者（fail-fast，不挂调用方）。 */
  fsCancelForNode(nodeId) {
    for (const [reqId, w] of this.fsPending) {
      if (w.nodeId !== nodeId) continue
      clearTimeout(w.timer)
      w.reject(Object.assign(new Error('node disconnected during fs request'), { code: ERROR_CODE.FS_TIMEOUT }))
      this.fsPending.delete(reqId)
    }
  }

  /**
   * 工作区共享请求（2026-10-17）。
   *
   * 与 `fsRequest` 同款 RPC 模式（发帧 + 等 replyTo），但走独立的 SHARE 帧与
   * 独立的 pending 表 —— 两者语义不同（fs 是"读文件"，share 是"探测共享状态
   * 并生成命令"），混用一张表会让超时归因变模糊。
   *
   * @param {string} nodeId
   * @param {'probe'|'plan'|'unshare-plan'} op
   * @param {object} [params]
   * @returns {Promise<object>}
   */
  shareRequest(nodeId, op, params = {}, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const rec = this.nodes.get(nodeId)
      if (!rec?.online) {
        reject(Object.assign(new Error(`node not online: ${nodeId}`), { code: ERROR_CODE.TASK_UNKNOWN }))
        return
      }
      const env = envelope(HUB_TO_NODE.SHARE_REQ, { op, ...params })
      const reqId = env.id
      const timer = setTimeout(() => {
        this.sharePending.delete(reqId)
        this.log('warn', 'share request timeout', { nodeId, op, reqId, timeoutMs })
        reject(Object.assign(new Error(`share ${op} timed out after ${timeoutMs}ms`), { code: ERROR_CODE.FS_TIMEOUT }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.sharePending.set(reqId, { resolve, reject, timer, op, nodeId })
      const sent = this.send(nodeId, HUB_TO_NODE.SHARE_REQ, { op, ...params }, { id: reqId })
      if (!sent) {
        clearTimeout(timer)
        this.sharePending.delete(reqId)
        reject(Object.assign(new Error(`failed to send share request to ${nodeId}`), { code: ERROR_CODE.TASK_UNKNOWN }))
      }
    })
  }

  /** share/res 到达：按 replyTo 唤醒等待者。 */
  handleShareRes(nodeId, d) {
    const reqId = typeof d.replyTo === 'string' ? d.replyTo : ''
    const waiter = reqId !== '' ? this.sharePending.get(reqId) : undefined
    if (!waiter) {
      this.log('info', 'late share response dropped', { nodeId, reqId })
      return
    }
    clearTimeout(waiter.timer)
    this.sharePending.delete(reqId)
    if (d.ok === true) {
      waiter.resolve(d.result ?? {})
    } else {
      waiter.reject(Object.assign(
        new Error(typeof d.message === 'string' ? d.message : 'share request failed'),
        { code: typeof d.code === 'string' ? d.code : ERROR_CODE.INTERNAL },
      ))
    }
  }

  /** 节点断连：清掉它名下还没等到 share/res 的等待者。 */
  shareCancelForNode(nodeId) {
    for (const [reqId, w] of this.sharePending) {
      if (w.nodeId !== nodeId) continue
      clearTimeout(w.timer)
      w.reject(Object.assign(new Error('node disconnected during share request'), { code: ERROR_CODE.FS_TIMEOUT }))
      this.sharePending.delete(reqId)
    }
  }

  /**
   * 发一个二进制帧给节点（header.to 由中继用来路由）。
   * E2E 会话存在时整体封密：外层只留 t/seq/iv + to。
   */
  sendBinary(nodeId, header, payload) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    const rec = this.nodes.get(nodeId)
    let hdr = header ?? {}
    let pl = payload ?? Buffer.alloc(0)
    if (rec?.e2e) {
      try {
        const sealed = rec.e2e.sealBinary(hdr.t, hdr, pl)
        hdr = sealed.header
        pl = sealed.payload
      } catch (err) {
        this.log('warn', 'e2e binary seal failed, frame dropped', { nodeId, error: errText(err) })
        return false
      }
    }
    let buf
    try {
      buf = encodeBinaryFrame({ ...hdr, to: nodeId }, pl)
    } catch (err) {
      // 头部过大等编码失败：如实记日志并返回 false，不让调用方炸掉。
      this.log('warn', 'binary frame encode failed', { nodeId, error: errText(err) })
      return false
    }
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.sendBinary(buf)
        return true
      } catch (err) {
        this.log('warn', 'sendBinary failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.sendBinary(nodeId, buf)
    return false
  }

  // ─────────────────────────── 节点视图 ───────────────────────────

  getNode(nodeId) {
    return this.nodes.get(nodeId)
  }

  onlineNodes() {
    return [...this.nodes.values()].filter((r) => r.online)
  }

  /** 按 nodeId 或主机名挑节点；prefer 为空时返回唯一在线节点。 */
  pickNode(prefer = '') {
    const online = this.onlineNodes()
    const want = String(prefer ?? '').trim().toLowerCase()
    if (want !== '') {
      const hit = online.find(
        (r) => r.nodeId.toLowerCase() === want || String(r.hello?.hostname ?? '').toLowerCase() === want,
      )
      if (hit) return hit
      const known = this.nodes.get(prefer)
      if (known) return known
      return undefined
    }
    if (online.length === 1) return online[0]
    return undefined
  }

  /** 工具 remote_nodes 的输出。 */
  list() {
    return [...this.nodes.values()].map((r) => ({
      nodeId: r.nodeId,
      os: r.hello?.os ?? 'unknown',
      arch: r.hello?.arch ?? 'unknown',
      hostname: r.hello?.hostname ?? r.nodeId,
      online: r.online === true,
      roots: Array.isArray(r.hello?.roots) ? r.hello.roots : [],
      caps: Array.isArray(r.hello?.caps) ? r.hello.caps : [],
      agentMode: r.hello?.agentMode === true,
      since: r.since,
      lastSeen: r.lastSeen,
      taskCount: r.tasks.size,
      // 资源遥测（最近一次 node/resource；null = 尚未上报）。离线节点保留
      // 最后一份 —— 带 at 时间戳，消费方自行判断新鲜度。
      resource: r.resource ?? null,
      // 队列健康快照（提案 #26-3）：null = 副机未上报（旧版本）。starved=true
      // 表示"有排队且并发占满且最久排队超 2 分钟"——派发前值得先看一眼。
      queue: r.queue ?? null,
      // 执行后端 + 默认模型（提案 #27）：面板显示与派发前校验的依据。
      // null = 副机未上报或未配置默认模型。
      runnerKind: typeof r.runnerKind === 'string' ? r.runnerKind : null,
      defaultModel: r.defaultModel && typeof r.defaultModel === 'object' ? r.defaultModel : null,
      // 可用模型清单（提案 #27 面板下拉的数据源）。null = 副机未上报
      // （旧版本 / 探测还没完成 / 全部失败）—— 消费方据此退回自由文本。
      // 空数组是**权威事实**（"确实一个都没有"），与 null 语义不同。
      models: Array.isArray(r.models) ? r.models : null,
      // 仓库清单（提案 #13）：路由提示。remote_nodes 给名字列表供选型，
      // repo 路由细节在 pickNodeByRepo。
      repos: Array.isArray(r.repos) ? r.repos.map((x) => x.name) : [],
      reposAt: r.reposAt ?? null,
    }))
  }

  // ─────────────────────────── 连接尝试历史 ───────────────────────────

  /**
   * 记一次连接尝试（2026-10-20，体验提升 ①）。
   *
   * @param {object} o
   * @param {'ok'|'fail'} o.result
   * @param {string} [o.code] 失败码（协议错误码 / errno / 'hello-timeout' 等）
   * @param {string} [o.message] 原始错误文案
   * @param {string} [o.nodeId] 若已知
   * @param {string} [o.remote] 远端地址（IP:port 或 IP）
   * @param {string} [o.transport] 'direct' | 'relay'
   */
  noteConnectionAttempt({ result, code = '', message = '', nodeId = '', remote = '', transport = '' } = {}) {
    try {
      const entry = {
        at: Date.now(),
        result: result === 'ok' ? 'ok' : 'fail',
        code: typeof code === 'string' ? code : '',
        message: typeof message === 'string' ? message.slice(0, 300) : '',
        nodeId: typeof nodeId === 'string' ? nodeId : '',
        remote: typeof remote === 'string' ? remote : '',
        transport: typeof transport === 'string' ? transport : '',
      }
      // 失败时附上人话解释（面板直接用，不用再翻译一遍）
      if (entry.result === 'fail') {
        try {
          const ex = explainError({ code: entry.code, message: entry.message }, { isHub: true, context: '副机接入' })
          entry.title = ex.title
          entry.detail = ex.detail
          entry.hint = ex.hint
        } catch {
          /* 翻译失败不影响记录 */
        }
      }
      this.connectionLog.push(entry)
      // 环形上限 50：这是诊断线索，不是审计
      if (this.connectionLog.length > 50) this.connectionLog.splice(0, this.connectionLog.length - 50)
    } catch {
      /* 诊断记录绝不能影响连接流程本身 */
    }
  }

  /**
   * 取连接尝试历史（新的在前）+ 每台已知节点的最后状态。
   *
   * @param {number} [limit]
   */
  connectionReport(limit = 20) {
    const recent = this.connectionLog.slice(-Math.max(1, limit)).reverse()
    // 按 nodeId 归并：每台机器最后一次尝试是什么结果
    const byNode = new Map()
    for (const e of this.connectionLog) {
      if (e.nodeId !== '') byNode.set(e.nodeId, e)
    }
    return {
      recent,
      byNode: [...byNode.entries()].map(([k, v]) => ({ nodeId: k, ...v })),
      // 有没有过任何成功的连接 —— 面板据此区分"从没连上过"与"连上又断了"
      everConnected: this.connectionLog.some((e) => e.result === 'ok'),
    }
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  markOffline(nodeId, reason) {
    const rec = this.nodes.get(nodeId)
    if (!rec) return
    if (!rec.online && !rec.conn) return
    rec.online = false
    rec.lastSeen = Date.now()
    rec.conn = undefined
    this.log('info', 'node offline', { nodeId, reason })
    // 断连时在途的产物分块必然残缺，直接失败掉，别让临时文件挂着
    this.pulls?.onNodeOffline?.(nodeId)
    // 在途的远程文件请求同样 fail-fast（提案 #25）：等不到 fs/res 就别挂调用方
    this.fsCancelForNode(nodeId)
    // 在途的工作区共享请求同样 fail-fast（2026-10-17）
    this.shareCancelForNode(nodeId)
  }

  startHeartbeat() {
    if (this.timer || this.closed) return
    // 下限 1000ms：心跳巡检没必要更密，避免在大量节点时打满定时器
    const ms = Math.max(1000, this.limits.heartbeatMs)
    this.timer = setInterval(() => this.tick(), ms)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * 一次心跳巡检。
   *
   * 两条路径都要有超时兜底（D7 修复）：
   *
   *   direct 模式（rec.conn 存在）：ping + 超时 conn.destroy()
   *
   *   relay 模式（rec.conn === undefined）：早期版本这里只靠"中继会发 node/offline"，
   *   但**中继自己死了就没人发** —— 实测 relay 整体死亡后 rec.online 永远为 true
   *   （+20s 仍 online:true），remote_nodes 报在线、remote_task 才失败，
   *   运维看到的是"节点在线但派不动活"。现在同样用 lastSeen 做超时判定。
   *
   * 公开方法（不只是内部回调），因为它是 C2-1/D7 的可测试入口。
   */
  tick() {
    if (this.closed) return
    const now = Date.now()
    for (const rec of this.nodes.values()) {
      if (!rec.online) continue
      const conn = rec.conn

      if (conn && !conn.closed) {
        try {
          conn.ping()
        } catch {
          /* 已断，close 事件会接手 */
        }
        if (now - rec.lastSeen > this.limits.heartbeatMs * 4) {
          this.log('warn', 'node heartbeat timeout', { nodeId: rec.nodeId, mode: 'direct' })
          try {
            conn.destroy(new Error('heartbeat timeout'))
          } catch {
            /* 已销毁 */
          }
        }
        continue
      }

      // relay 模式：没有专属 socket 可 ping，只能看 lastSeen。
      // 阈值放宽到 8 倍（direct 是 4 倍）：relay 的上行帧要经一跳，
      // 且节点侧 heartbeat 与中继转发都有各自的抖动，宁可晚判也不误杀。
      const relayTimeoutMs = this.limits.heartbeatMs * 8
      if (now - rec.lastSeen > relayTimeoutMs) {
        this.log('warn', 'node heartbeat timeout', {
          nodeId: rec.nodeId,
          mode: 'relay',
          silentMs: now - rec.lastSeen,
        })
        // 没有 socket 可 destroy，走与"节点主动断开"相同的下线路径，
        // 保证 tasks 投影保留（任务状态真身在副机）而 online 翻 false。
        try {
          this.markOffline(rec.nodeId, 'heartbeat timeout (relay)')
        } catch {
          /* 已被其他路径下线 */
        }
      }
    }
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const pending of [...this.pending]) {
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      try {
        pending.conn.close(1001, 'hub shutting down')
      } catch {
        /* 已断 */
      }
    }
    this.pending.clear()
    // 两阶段审批的自动拒绝定时器一并清掉（否则卸载后定时器还会触发）
    for (const timer of this.pendingApprovals.values()) clearTimeout(timer)
    this.pendingApprovals.clear()
    for (const rec of this.nodes.values()) {
      const conn = rec.conn
      rec.online = false
      rec.conn = undefined
      if (conn && !conn.closed) {
        try {
          conn.close(1001, 'hub shutting down')
        } catch {
          /* 已断 */
        }
      }
    }
    for (const t of this.tasks.values()) {
      for (const w of [...t.waiters]) w.fail(new RemoteAgentError('hub shutting down', 'aborted'))
      t.waiters.clear()
    }
    this.tasks.clear()
    // rec.tasks 用可选链：dispose 是清理路径，不该因为某个 rec 形状不全而抛错
    // 把整个卸载流程打断（那会让后面的 nodes.clear / relay.stop 都执行不到）。
    for (const rec of this.nodes.values()) rec.tasks?.clear?.()
    // 节点表也要清：卸载后不该再有任何引用挂着副机的主机名 / 工作区根。
    this.nodes.clear()
    try {
      this.relay?.stop()
    } catch {
      /* 已停 */
    }
    this.relay = null
    this.pulls = undefined
  }
}

/**
 * NodeRegistry = 核心注册表（本文件：任务视图 / 下发 / 发送 / 心跳 / 生命周期）
 * + 帧摄入 mixin（registry-ingest.js：上行帧分发与 task/sync 对账）
 * + 接入握手 mixin（registry-handshake.js：direct/relay 接入、hello、hub 身份）。
 * 对外形状与拆分前完全一致 —— 所有方法都在同一个原型链上。
 */
export class NodeRegistry extends withHandshake(withIngest(NodeRegistryCore)) {}
