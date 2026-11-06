/**
 * NodeRegistry 的「上行帧处理」职责（P1-4 自 node-registry.js 拆出）。
 *
 * 以 mixin 形式合入：`class NodeRegistry extends withIngest(NodeRegistryCore)`。
 * 这是**纯搬移** —— 四个方法体与拆分前的 node-registry.js 一字不差，行为由
 * 652 条既有测试整体兜底（task/sync 对账、资源遥测摄入、产物分块路由等都在
 * 这段里）。搬出动机：帧摄入是「协议→注册表状态」的翻译层，与注册表的
 * 连接管理/视图查询是两种变更节奏，混在一个 1465 行的文件里没法读。
 *
 * this.* 依赖面（全部由 NodeRegistryCore 提供）：
 *   nodes / tasks / limits / log / pulls / send / ensureTask / resolveWaiters
 */
import { ERROR_CODE, HUB_TO_NODE, NODE_TO_HUB, TASK_STATUS, TERMINAL_STATUS } from '../protocol.js'
import { E2E_MARKER } from '../e2e.js'
import { errText, numOr } from './hub-util.js'

/**
 * 单个节点可上报的模型数量上限（提案 #27）。
 *
 * 与副机侧的 MAX_MODELS 同量级 —— hub 侧必须**独立封顶**：不能信任对端
 * 遵守了自己的上限（旧版副机、或刻意构造的帧都可能更大）。这是"单帧
 * 故障隔离"不变式的一部分：畸形帧不能把注册表撑爆。
 */
const MAX_NODE_MODELS = 64

export function withIngest(Base) {
  return class extends Base {
    // ─────────────────────────── 上行帧处理 ───────────────────────────

    /**
     * 上行文本帧分发。未知帧记日志忽略；任何异常都被吞掉。
     */
    handleFrameFor(nodeId, frame, meta = {}) {
      const rec = this.nodes.get(nodeId)
      if (rec) {
        rec.lastSeen = Date.now()
        if (rec.transport === 'direct' && !rec.conn && meta.conn) rec.conn = meta.conn
      } else if (frame.t !== NODE_TO_HUB.HELLO) {
        // 未知来源的上行帧（hub 重启后副机仍在跑）：登记一个"影子节点"，不丢任务视图
        this.log('warn', 'frame from unknown node', { nodeId, type: frame.t })
      }

      // E2E 解密（提案 #1）：带标记的帧先拆密再做业务分发。
      // 会话不存在（hub 重启后副机的连接还在、密钥已丢）→ 回 e2e-reset 让
      // 副机重新握手，本帧丢弃 —— 副机的遥测/仓库帧是周期性的，重协商
      // 最迟一个遥测周期内自动完成。
      let payload = frame.d
      if (payload && payload.e2e === E2E_MARKER) {
        if (!rec?.e2e) {
          this.log('warn', 'e2e frame without session, requesting re-key', { nodeId, type: frame.t })
          this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e session unknown; please re-offer' })
          return
        }
        try {
          payload = rec.e2e.openFrame(frame.t, frame.id, payload)
        } catch (err) {
          // 认证失败 = 中间人伪造 / 实现错乱。丢这一帧并大声记录；
          // 不杀连接 —— 单帧失败不应放大成断连，连续伪造会在日志里显形。
          this.log('warn', 'e2e open failed, frame dropped', { nodeId, type: frame.t, error: errText(err) })
          return
        }
      }
      const d = payload && typeof payload === 'object' ? payload : {}

      switch (frame.t) {
        case NODE_TO_HUB.HELLO:
          this.ingestHello({ helloData: d, conn: meta.conn, transport: meta.transport ?? 'direct', pending: undefined })
          return

        case NODE_TO_HUB.TASK_ACCEPT: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          t.accepted = true
          t.acceptedAt = Date.now()
          t.duplicate = d.duplicate === true
          if (typeof d.status === 'string') t.status = d.status
          if (typeof d.workspace === 'string') t.workspace = d.workspace
          if (typeof d.runner === 'string') t.runner = d.runner
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_PROGRESS: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (typeof d.status === 'string') t.status = d.status
          const entry = {
            phase: typeof d.phase === 'string' ? d.phase : 'progress',
            detail: typeof d.detail === 'string' ? d.detail : typeof d.command === 'string' ? d.command : undefined,
            at: typeof d.at === 'number' ? d.at : Date.now(),
          }
          t.progressTail.push(entry)
          if (t.progressTail.length > 20) t.progressTail.splice(0, t.progressTail.length - 20)
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_SUMMARY: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (d.handoff && typeof d.handoff === 'object') {
            t.handoff = d.handoff
            // ⚠ 终态守卫（2026-10-17 修 v0.9.0 审查 L5）。
            //
            // 场景：approveTask 时 send 返回 false → 我们已把任务置成
            // FAILED(node-unreachable)，但那一帧其实在途 → 节点跑完回传
            // 真实终态。原实现无条件 `t.status = d.handoff.status`，会把
            // 已置的 FAILED 改写掉。
            //
            // 后果良性（记录反而更真实），但破坏"终态即终态"的心智模型，
            // 且让"批准者已收到 unreachable 错误、可能重派"的双跑风险更难察觉。
            //
            // 守卫规则：**已经是终态就不再被后来的帧改写**。
            // 例外：同一个终态值重复到达是幂等的，允许（无副作用）。
            const incoming = typeof d.handoff.status === 'string' ? d.handoff.status : ''
            if (incoming !== '' && (t.status === incoming || !TERMINAL_STATUS.has(t.status))) {
              t.status = incoming
            }
            if (Array.isArray(d.handoff.changed)) t.changed = d.handoff.changed
            if (d.handoff.summary && typeof d.handoff.summary === 'object') t.summary = d.handoff.summary
            if (d.handoff.exit && typeof d.handoff.exit === 'object') t.exit = d.handoff.exit
            if (typeof d.handoff.workspace === 'string') t.workspace = d.handoff.workspace
            const a = d.handoff.artifacts
            if (a && typeof a === 'object') {
              t.manifest = {
                counts: a.counts ?? null,
                bytesFinal: typeof a.bytesFinal === 'number' ? a.bytesFinal : 0,
                final: Array.isArray(a.final) ? a.final : [],
                intermediateCount: typeof a.intermediateCount === 'number' ? a.intermediateCount : 0,
                note: typeof a.note === 'string' ? a.note : '',
              }
            }
          }
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_END: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          // ⚠ 终态守卫（2026-10-17 修 v0.9.0 审查 L5，与 TASK_SUMMARY 同款）：
          // 已是终态就不再被改写，除非到达的是**同一个**终态（幂等重发）。
          if (typeof d.status === 'string' && (t.status === d.status || !TERMINAL_STATUS.has(t.status))) {
            t.status = d.status
          }
          t.endedAt = typeof d.endedAt === 'number' ? d.endedAt : Date.now()
          if (typeof d.durationMs === 'number') t.durationMs = d.durationMs
          if (d.error && typeof d.error === 'object') t.error = d.error
          if (d.manifestCounts && typeof d.manifestCounts === 'object') t.manifestCounts = d.manifestCounts
          t.updatedAt = Date.now()
          this.log('info', 'task ended', { taskId: t.taskId, nodeId, status: t.status })
          // 任务终态事件广播（供 ds-bot worker-bridge 的 waitForTask 订阅）
          try { this.emit('taskEnd', { taskId: t.taskId, nodeId, status: t.status, exitCode: t.exit?.code, summary: t.summary?.text }) } catch {}
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_SYNC:
          this.applySync(nodeId, d)
          return

        case NODE_TO_HUB.ARTIFACT_MANIFEST: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (d.manifest && typeof d.manifest === 'object') t.manifest = d.manifest
          t.updatedAt = Date.now()
          return
        }

        case NODE_TO_HUB.ARTIFACT_DONE:
          // 允许副机把 done 走文本帧（正常走二进制帧，见 handleBinaryFor）
          this.pulls?.ingestDone?.(d)
          return

        case HUB_TO_NODE.PING: {
          // 副机的应用层心跳：回 pong，并顺手刷新 lastSeen（上面已做）
          this.send(nodeId, NODE_TO_HUB.PONG, { echo: frame.id })
          return
        }

        case NODE_TO_HUB.RESOURCE: {
          // 资源遥测（~30s 一次）：只更新 rec.resource，绝不影响任务链路。
          // 尽力而为的字段级校验：缺/类型不对就落 null —— 一个畸形遥测帧
          // 不能让节点记录缺胳膊少腿，更不能抛（单帧故障隔离不变式）。
          //
          // ⚠ `rec` 必须判空（2026-10-17 修）。未知节点（hub 重启后副机还没
          // 重连的"影子节点"竞态）发来 resource 帧 —— 30s 一次，**必然发生**：
          // `rec.resource = {...}` 对 undefined 抛 TypeError。外层 try/catch
          // 能兜住（不崩溃、不断连），但会打一条误导性 error 日志并丢一帧遥测。
          //
          // 同文件 REPOS 分支有 `if (rec)` 护栏 —— 同一份单帧隔离不变式，
          // 两个分支一个做一个漏。
          if (!rec) return
          const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
          rec.resource = {
            cpuPct: num(d.cpuPct),
            load1: num(d.load1),
            memUsedMb: num(d.memUsedMb),
            memTotalMb: num(d.memTotalMb),
            at: Date.now(),
          }
          // 资源遥测事件广播（供 ds-bot worker-bridge 负载均衡订阅）
          try { this.emit('nodeResource', { nodeId: rec.nodeId, cpu: rec.resource.cpuPct, mem: rec.resource.memUsedMb, taskCount: rec.tasks instanceof Map ? rec.tasks.size : 0 }) } catch {}
          // 队列健康快照（提案 #26-3，新副机随帧搭车）。旧副机不发 queue ——
          // 保留 rec.queue 原值（可能是 undefined），remote_nodes 按 null 展示。
          const q = d.queue && typeof d.queue === 'object' && !Array.isArray(d.queue) ? d.queue : null
          if (q) {
            rec.queue = {
              queued: num(q.queued) ?? 0,
              running: num(q.running) ?? 0,
              maxConcurrent: num(q.maxConcurrent) ?? 0,
              oldestQueuedMs: num(q.oldestQueuedMs) ?? 0,
              starved: q.starved === true,
            }
          }
          // 执行后端 + 默认模型（提案 #27）：面板显示与派发前校验的依据。
          // 每帧整体替换（副机是这一事实的权威）；旧副机不上报则保留原值。
          if (typeof d.runnerKind === 'string' && d.runnerKind !== '') rec.runnerKind = d.runnerKind.slice(0, 32)
          const dm = d.defaultModel && typeof d.defaultModel === 'object' && !Array.isArray(d.defaultModel) ? d.defaultModel : null
          if (dm && typeof dm.model === 'string' && dm.model !== '') {
            rec.defaultModel = {
              provider: typeof dm.provider === 'string' ? dm.provider.slice(0, 64) : '',
              model: dm.model.slice(0, 128),
            }
          } else {
            // 显式 null 是合法上报（副机没配默认模型）—— 清掉旧值避免误导
            if (d.defaultModel === null) rec.defaultModel = null
          }

          // 可用模型清单（提案 #27 面板下拉的数据源）。
          //
          // 与 defaultModel 一样是"副机自述"，但**整帧替换**的语义要更小心：
          //   · 副机上报 `models: null`（探测失败 / 还没探完）→ **保留旧值**，
          //     不要清空。否则一次网络抖动会让面板下拉退回自由文本，
          //     用户刚记住的选项突然消失。
          //   · 副机上报 `models: {models: [...]}` → 替换（含空数组：那是
          //     "确实一个都没有"的权威事实）。
          //
          // 字段级清洗 + 上限：一个畸形帧不能伤害注册表（单帧故障隔离不变式）。
          const rawModels = d.models && typeof d.models === 'object' && !Array.isArray(d.models) ? d.models : null
          if (rawModels) {
            const list = Array.isArray(rawModels.models) ? rawModels.models : []
            const cleaned = []
            for (const m of list.slice(0, MAX_NODE_MODELS)) {
              if (!m || typeof m !== 'object') continue
              const id = typeof m.id === 'string' ? m.id.trim() : ''
              if (id === '') continue
              cleaned.push({
                provider: typeof m.provider === 'string' ? m.provider.slice(0, 64) : '',
                id: id.slice(0, 128),
                name: typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id.slice(0, 128),
              })
            }
            rec.models = cleaned
          }
          return
        }

        case NODE_TO_HUB.REPOS: {
          // 仓库清单（提案 #13）：整帧替换 rec.repos —— 清单是全量快照，
          // 不是增量。字段级清洗 + 数量/长度封顶，与遥测同一条不变式：
          // 一个畸形帧不能伤害注册表，更不能抛。节点下线后清单保留
          // （rec 是持久的），路由时靠 online 过滤，重连后副机会重报。
          // rec 为空（hub 重启后的影子节点）直接丢帧 —— 没有登记点可挂。
          const REPOS_CAP = 50
          const s = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '')
          const list = Array.isArray(d.repos) ? d.repos : []
          if (rec) {
            rec.repos = []
            for (const r of list) {
              if (rec.repos.length >= REPOS_CAP) break
              if (!r || typeof r !== 'object') continue
              const name = s(r.name, 200)
              const url = s(r.url, 500)
              const p = s(r.path, 500)
              if (name === '' && url === '' && p === '') continue
              rec.repos.push({ name, url, path: p })
            }
            rec.reposAt = Date.now()
            this.log('info', 'node repos updated', { nodeId, count: rec.repos.length })
          }
          return
        }

        case NODE_TO_HUB.E2E_OFFER:
          // E2E 密钥交换提议（提案 #1）：握手职责在 registry-handshake（那里
          // 有身份密钥）。明文帧 —— 此时还没有任何共享密钥。
          this.handleE2EOffer(nodeId, d)
          return

        case NODE_TO_HUB.PONG:
          return

        case NODE_TO_HUB.FS_RES:
          // 远程文件响应（提案 #25）：按 replyTo 唤醒 hub 侧的 fsRequest 等待者。
          // 加密帧 —— fs 结果（目录结构 / 文件内容）不许明文过中继。
          this.handleFsRes(nodeId, d)
          return

        case NODE_TO_HUB.SHARE_RES:
          // 工作区共享响应（2026-10-17）：按 replyTo 唤醒 shareRequest 等待者。
          // 与 FS_RES 分开 —— 两张 pending 表不能混（混了会让超时归因变模糊）。
          this.handleShareRes(nodeId, d)
          return

        case NODE_TO_HUB.ERROR:
          this.log('warn', 'node reported error', { nodeId, code: d.code, taskId: d.taskId })
          if (d.code === ERROR_CODE.E2E_REQUIRED) {
            // 副机在会话已建立后收到明文业务帧才会报这个错 —— 典型成因是
            // hub 侧丢了会话（重启）。让副机重新走一次握手（它还握着旧会话，
            // 但 hub 这边已经没有了）。
            this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'hub lost e2e session; please re-offer' })
          }
          if (d.taskId) {
            const t = this.tasks.get(d.taskId)
            if (t) {
              t.error = { code: d.code ?? 'node-error', message: d.message ?? '' }
              t.updatedAt = Date.now()
              this.resolveWaiters(t)
            }
          }
          return

        default:
          this.log('info', 'unknown frame ignored', { nodeId, type: String(frame.t) })
      }
    }

    /** 二进制上行帧：产物分块 / 完成帧交给 PullManager。 */
    handleBinaryFor(nodeId, header, payload, meta = {}) {
      // E2E 解密（提案 #1）：带标记的先拆密。外层 header 只留 t/seq/iv，
      // pullId/offset/sha256 等都在内层密文里 —— 中继看不到文件名与完整性字段。
      let hdr = header
      let pl = payload
      if (header && header.e2e === E2E_MARKER) {
        const rec = this.nodes.get(nodeId)
        if (!rec?.e2e) {
          this.log('warn', 'e2e binary frame without session, dropped', { nodeId, type: header.t })
          this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e session unknown; please re-offer' })
          return
        }
        try {
          const opened = rec.e2e.openBinary(header.t, header, payload)
          hdr = opened.header
          pl = opened.payload
        } catch (err) {
          this.log('warn', 'e2e binary open failed, frame dropped', { nodeId, type: header.t, error: errText(err) })
          return
        }
      }
      const type = hdr?.t
      if (type === NODE_TO_HUB.ARTIFACT_CHUNK) {
        this.pulls?.ingestBinary?.(hdr, pl, { conn: meta.conn })
        return
      }
      if (type === NODE_TO_HUB.ARTIFACT_DONE) {
        this.pulls?.ingestDone?.(hdr)
        return
      }
      this.log('info', 'unknown binary frame ignored', { nodeId, type: String(type) })
    }

    /**
     * task/sync：副机的**全量**任务列表 → 重建该节点视图。
     * 列表里没有的、且不是"刚派出去还在途"的任务，从 hub 视图里移除。
     */
    applySync(nodeId, d) {
      const rec = this.nodes.get(nodeId)
      if (!rec) return
      const list = Array.isArray(d?.tasks) ? d.tasks : null
      if (!list) {
        this.log('warn', 'task/sync without tasks[]', { nodeId })
        return
      }
      const seen = new Set()
      for (const view of list) {
        if (!view || typeof view.taskId !== 'string') continue
        seen.add(view.taskId)
        const t = this.ensureTask(nodeId, view.taskId)
        if (!t) continue
        this.applyView(t, view)
      }
      for (const [taskId, t] of [...rec.tasks]) {
        if (seen.has(taskId)) continue
        // 审批挂起中的任务从未到过副机（提案 #2）：它本来就不会出现在
        // sync 里，宽限期逻辑不适用 —— 绝不能因为 sync 里没有就被清掉。
        if (t.status === TASK_STATUS.PENDING_APPROVAL) continue
        // 宽限期只给"本 hub 派出去、还没等到 accept"的任务 —— 它可能正在路上。
        // 副机上报过（adopted）却不再出现在 sync 里的任务，说明副机那边已经没有了，
        // 以副机为权威直接移除；否则幽灵任务会一直挂在 hub 视图里。
        if (t.adopted !== true && t.accepted !== true && Date.now() - t.createdAt < this.limits.ackTimeoutMs) continue
        rec.tasks.delete(taskId)
        if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
      }

      // ── 顺手做一次自动清理（防视图无限累积）────────────────────────────
      //
      // 副机的 TaskStore 默认保留 7 天，所以它会在 sync 里**持续上报**这些终态
      // 任务 —— 上面那个"不在 sync 里就删"的循环因此不会清理它们。hub 视图
      // 一路累积到 `maxTasksPerNode`，然后**任何新任务都被拒**（实测踩到，
      // 连"派一条清理命令"都做不到）。
      //
      // 所以这里主动清：**终态 + 已上报 + 超过保留期**的视图。条件是保守的 ——
      // 只看超过 retainMs 的，刚结束的任务仍可被 remote_status / remote_handoff
      // 查到（那是用户最需要看结果的时候）。
      //
      // 想立即清（不等保留期）用 `remote_purge`。
      const retainMs = this.limits.taskViewRetainMs
      if (retainMs > 0) {
        const cutoff = Date.now() - retainMs
        let pruned = 0
        for (const [taskId, t] of [...rec.tasks]) {
          if (!TERMINAL_STATUS.has(t.status)) continue
          const endedAt = numOr(t.endedAt, 0) || numOr(t.updatedAt, 0) || numOr(t.createdAt, 0)
          if (endedAt >= cutoff) continue
          rec.tasks.delete(taskId)
          if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
          pruned += 1
        }
        if (pruned > 0) {
          this.log('info', 'pruned old task views', { nodeId, pruned, retainMs })
        }
      }

      this.log('info', 'node task view rebuilt from sync', { nodeId, count: seen.size })
    }

    applyView(t, view) {
      const strFields = ['status', 'mode', 'goal', 'workspace', 'sessionId']
      for (const f of strFields) {
        if (typeof view[f] === 'string') t[f] = view[f]
      }
      const numFields = ['createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs']
      for (const f of numFields) {
        if (typeof view[f] === 'number') t[f] = view[f]
      }
      if (view.exit && typeof view.exit === 'object') t.exit = view.exit
      if (Array.isArray(view.changed)) t.changed = view.changed
      if (view.error && typeof view.error === 'object') t.error = view.error
      if (view.summary && typeof view.summary === 'object') t.summary = view.summary
      if (view.manifestCounts && typeof view.manifestCounts === 'object') t.manifestCounts = view.manifestCounts
      if (Array.isArray(view.progressTail)) t.progressTail = view.progressTail.slice(-20)
      if (Array.isArray(view.logTail)) t.logTail = view.logTail.slice(-40)
      t.viewUpdatedAt = Date.now()
      this.resolveWaiters(t)
    }
  }
}
