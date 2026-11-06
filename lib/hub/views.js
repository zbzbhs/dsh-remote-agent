/**
 * 视图投影层：把**副机上报的数据**投影成"可以安全交给宿主"的形状。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 副机是一个独立的、可被攻陷的远端。它上报的 handoff / changed / exit / error /
 * manifest 全部是**不可信输入**：字段集由它决定，它可以往里面塞绝对路径
 * （回显主机目录结构）、环境变量、诊断信息、甚至凭证片段。
 *
 * 宿主有两种消费方，两边的要求一致：**只拿它真正需要的字段**。
 *   1. 工具返回值 → 进入会话日志 → 后续每个请求都带上（泄漏会被持久化）
 *   2. Web 面板   → 进入浏览器 → 可能被扩展/调试工具/截图带走
 *
 * ── 为什么集中在这一个文件 ────────────────────────────────────────
 * 曾经散在三处：`node-registry.taskView`、`tools.buildManifestView`、
 * `ui-routes.*View`。结果 `remote_handoff` 因为"没有对应的 View 函数"就
 * 裸直出了 `t.handoff` —— 加固做了一半，且是最该加固的那一半（工具路径
 * 会被写进会话日志）。集中后新增消费方无处可"绕开"投影。
 *
 * ── 一条硬规则 ───────────────────────────────────────────────────
 * 本文件的函数**只做逐字段构造**，永不 spread 输入对象。所有字符串截断，
 * 所有数字做类型检查，缺失一律给安全默认值。这样副机怎么改它的上报形状，
 * 都不可能让宿主这边出现"没预料到的字段"。
 */

/**
 * 取数组的**最后** n 条，`n <= 0` 回空数组。
 *
 * 为什么不用裸 `list.slice(-n)`：`slice(-0)` 等于 `slice(0)`，会把**整条数组**
 * 都留下 —— 与"不要尾巴"的直觉相反，是个静默的语义反转。`tail` 是公开选项，
 * 消费方传 0 时应当拿到空尾巴而不是全部（本层原先两处都踩了这个坑）。
 */
function tailSlice(list, n) {
  const want = Number.isFinite(n) ? Math.trunc(n) : 0
  if (want <= 0) return []
  return list.slice(-want)
}

/** 单个 changed 条目：只保留客户端/模型真正会读的四个字段。 */
export function changedItemView(c) {
  if (!c || typeof c !== 'object') return null
  return {
    op: typeof c.op === 'string' ? c.op : 'unknown',
    path: typeof c.path === 'string' ? c.path.slice(0, 500) : '',
    bytes: Number.isFinite(c.bytes) ? c.bytes : 0,
    deltaBytes: Number.isFinite(c.deltaBytes) ? c.deltaBytes : 0,
  }
}

/** changed 数组：投影 + 丢弃非对象元素（否则消费方解引用 c.op 会抛）。 */
export function changedView(list, { max = 50 } = {}) {
  if (!Array.isArray(list)) return []
  return list.slice(0, max).map(changedItemView).filter(Boolean)
}

/**
 * 单个 diff 条目：path + unified diff 文本 + truncated 标志。
 *
 * diff 文本是副机生成的机器可读输出，但仍按不可信输入对待：
 * 逐条挑字段 + 长度封顶（单条 16KB，与副机 diff.js 的截断口径一致，
 * 双保险 —— 副机版本更旧没有截断时，hub 侧兜底）。
 */
export function diffItemView(d) {
  if (!d || typeof d !== 'object') return null
  if (typeof d.path !== 'string' || d.path === '') return null
  if (typeof d.diff !== 'string' || d.diff === '') return null
  return {
    path: d.path.slice(0, 500),
    diff: d.diff.slice(0, 16 * 1024),
    truncated: d.truncated === true,
  }
}

/** diffs 数组：投影 + 封顶条数（与副机 buildDiffs 的 12 文件上限同口径）。 */
export function diffsView(list, { max = 12 } = {}) {
  if (!Array.isArray(list)) return []
  return list.slice(0, max).map(diffItemView).filter(Boolean)
}

/**
 * 单个进度条目：只留 `phase` / `detail` / `at`。
 *
 * 与 changedItemView 同理，progressTail 也是副机上报的数组（见下方
 * progressTailView 的说明），元素必须逐字段投影后才能给消费方解引用。
 */
export function progressItemView(p) {
  if (!p || typeof p !== 'object') return null
  return {
    phase: typeof p.phase === 'string' ? p.phase : 'progress',
    detail: typeof p.detail === 'string' ? p.detail.slice(0, 500) : '',
    at: Number.isFinite(p.at) ? p.at : null,
  }
}

/**
 * 进度尾巴：投影 + 丢弃非对象元素，保留**最后** tail 条。
 *
 * 为什么不能只 `slice(-tail)`（原实现，本层唯一的裸透传）：
 * progressTail 同样来自副机 —— `node-registry.applyView()` 把 task/sync 里的
 * `view.progressTail` 原样存下，只有 task/progress 帧那条路是自己构造 entry。
 * 而两个消费方都直接解引用元素：
 *   - `lib/hub/tools.js` 的 remote_status 渲染：`p.phase` / `p.detail`
 *   - `lib/hub/subagent-provider.js` 的兜底文本：`p.phase` / `p.detail`
 * 副机上报一个 `null` 元素就能让它们抛 TypeError。tools 那条会让渲染失败；
 * subagent 那条更隐蔽 —— 异常被 provider 的兜底 catch 吞掉，于是一个**已完成**
 * 的任务被上报成"未完成：Cannot read properties of null"。这既是崩溃源，
 * 也违反 remote_status 自己声明的输出 schema（`items: { type: 'object' }`）。
 *
 * `tail <= 0` 回空数组（注意 `slice(-0)` 会把整条数组都留下，不是"不要尾巴"）。
 */
export function progressTailView(list, { tail = 6, max = 20 } = {}) {
  if (!Array.isArray(list)) return []
  const cap = Number.isFinite(max) ? Math.trunc(max) : Infinity
  const want = Number.isFinite(tail) ? Math.trunc(tail) : 0
  const n = Math.min(want, cap)
  if (n <= 0) return []
  return tailSlice(list, n).map(progressItemView).filter(Boolean)
}

/** exit 摘要：副机可能往里塞诊断字段，只留可执行的语义。 */
export function exitView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: Number.isFinite(e.code) ? e.code : null,
    timedOut: e.timedOut === true,
    aborted: e.aborted === true,
    runner: typeof e.runner === 'string' ? e.runner : '',
    toolCalls: Number.isFinite(e.toolCalls) ? e.toolCalls : 0,
  }
}

/** error：只留稳定 code 与截断后的消息。 */
export function errorView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : '',
  }
}

/** 节点：不含 hello / conn 等内部对象。 */
export function nodeView(n) {
  if (!n || typeof n !== 'object') return null
  return {
    nodeId: typeof n.nodeId === 'string' ? n.nodeId : '',
    online: n.online === true,
    os: typeof n.os === 'string' ? n.os : 'unknown',
    arch: typeof n.arch === 'string' ? n.arch : 'unknown',
    agentMode: n.agentMode === true,
    roots: Array.isArray(n.roots) ? n.roots.filter((r) => typeof r === 'string') : [],
    caps: Array.isArray(n.caps) ? n.caps.filter((c) => typeof c === 'string') : [],
    since: Number.isFinite(n.since) ? n.since : null,
    lastSeen: Number.isFinite(n.lastSeen) ? n.lastSeen : null,
    taskCount: Number.isFinite(n.taskCount) ? n.taskCount : 0,
    // 仓库清单（提案 #13）：只给名字列表（url/path 仅供路由，不进 UI）
    repos: Array.isArray(n.repos) ? n.repos.filter((x) => typeof x === 'string') : [],
    reposAt: Number.isFinite(n.reposAt) ? n.reposAt : null,
    // 资源遥测（最近一次 node/resource）：字段级投影，缺/null 都如实透传
    resource: (n.resource && typeof n.resource === 'object')
      ? {
        cpuPct: Number.isFinite(n.resource.cpuPct) ? n.resource.cpuPct : null,
        load1: Number.isFinite(n.resource.load1) ? n.resource.load1 : null,
        memUsedMb: Number.isFinite(n.resource.memUsedMb) ? n.resource.memUsedMb : null,
        memTotalMb: Number.isFinite(n.resource.memTotalMb) ? n.resource.memTotalMb : null,
        at: Number.isFinite(n.resource.at) ? n.resource.at : null,
      }
      : null,
    // 执行后端 + 默认模型（提案 #27）：面板节点行显示 + 派发前校验依据。
    transportMode: typeof n.transportMode === 'string' ? n.transportMode : 'relay',
    runnerKind: typeof n.runnerKind === 'string' ? n.runnerKind : null,
    defaultModel: (n.defaultModel && typeof n.defaultModel === 'object')
      ? {
        provider: typeof n.defaultModel.provider === 'string' ? n.defaultModel.provider : '',
        model: typeof n.defaultModel.model === 'string' ? n.defaultModel.model : '',
      }
      : null,
    // 可用模型清单（提案 #27 面板下拉的数据源）。
    //
    // **逐条投影**，绝不 spread —— 帧里的对象可能被构造，多带字段就等于让
    // 副机决定面板渲染什么。`null` 与 `[]` 语义不同：
    //   · null = 副机没上报（旧版 / 探测未完成）→ 面板退回自由文本
    //   · []   = 副机明确说"一个都没有"       → 面板显示空下拉 + 提示
    models: Array.isArray(n.models)
      ? n.models
        .map((m) => ({
          provider: typeof m?.provider === 'string' ? m.provider : '',
          id: typeof m?.id === 'string' ? m.id : '',
          name: typeof m?.name === 'string' && m.name !== '' ? m.name : (typeof m?.id === 'string' ? m.id : ''),
        }))
        .filter((m) => m.id !== '')
      : null,
  }
}

/** manifest 的 final 条目。 */
export function finalItemView(f) {
  if (!f || typeof f !== 'object') return null
  return {
    path: typeof f.path === 'string' ? f.path.slice(0, 500) : '',
    kind: typeof f.kind === 'string' ? f.kind : 'file',
    bytes: Number.isFinite(f.bytes) ? f.bytes : 0,
    sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
  }
}

/** manifest：计数 + final 清单（不传字节）。 */
export function manifestView(m, { max = 200 } = {}) {
  if (!m || typeof m !== 'object') return null
  const counts = m.counts && typeof m.counts === 'object' ? m.counts : null
  return {
    counts: counts
      ? {
        total: Number.isFinite(counts.total) ? counts.total : 0,
        final: Number.isFinite(counts.final) ? counts.final : 0,
        intermediate: Number.isFinite(counts.intermediate) ? counts.intermediate : 0,
        other: Number.isFinite(counts.other) ? counts.other : 0,
      }
      : null,
    bytesFinal: Number.isFinite(m.bytesFinal) ? m.bytesFinal : 0,
    final: Array.isArray(m.items)
      ? m.items
        .filter((i) => i && i.role === 'final')
        .slice(0, max)
        .map(finalItemView)
        .filter(Boolean)
      : [],
  }
}

/**
 * handoff 里的 `artifacts` 段。
 *
 * ⚠ 形状与 `manifestView` **不同**，不要混用：
 *   - `manifestView` 吃的是**副机的清单对象**（`items: [{role, path, ...}]`），
 *     需要按 `role === 'final'` 筛。
 *   - handoff 里的 `artifacts.final` 是**副机已经筛好的数组**（见
 *     lib/node/task-engine.js 的 buildHandoff），只有 `{path, kind, bytes, sha256}`。
 * 我第一版把两者当成一个形状，导致 final 恒为空数组（e2e 断言 `final 应含 产物.txt` 失败）。
 */
export function artifactsView(a, { max = 200 } = {}) {
  if (!a || typeof a !== 'object') return null
  const counts = a.counts && typeof a.counts === 'object' ? a.counts : null
  return {
    counts: counts
      ? {
        total: Number.isFinite(counts.total) ? counts.total : 0,
        final: Number.isFinite(counts.final) ? counts.final : 0,
        intermediate: Number.isFinite(counts.intermediate) ? counts.intermediate : 0,
        other: Number.isFinite(counts.other) ? counts.other : 0,
      }
      : null,
    bytesFinal: Number.isFinite(a.bytesFinal) ? a.bytesFinal : 0,
    final: Array.isArray(a.final)
      ? a.final.slice(0, max).map(finalItemView).filter(Boolean)
      : [],
    intermediateCount: Number.isFinite(a.intermediateCount) ? a.intermediateCount : 0,
    note: typeof a.note === 'string' ? a.note.slice(0, 500) : '',
  }
}

/**
 * handoff 卡片：**投影最严的一处**。
 *
 * 副机的 buildHandoff() 会带上 workspace（绝对路径）、logs（可能含环境变量）、
 * 以及它版本的任何新字段。这里逐字段挑出消费方要用的部分，其余一律丢弃。
 */
export function handoffView(h) {
  if (!h || typeof h !== 'object') return null
  const summary = h.summary && typeof h.summary === 'object' ? h.summary : null
  return {
    taskId: typeof h.taskId === 'string' ? h.taskId : null,
    nodeId: typeof h.nodeId === 'string' ? h.nodeId : null,
    status: typeof h.status === 'string' ? h.status : null,
    mode: typeof h.mode === 'string' ? h.mode : null,
    runner: typeof h.runner === 'string' ? h.runner : null,
    durationMs: Number.isFinite(h.durationMs) ? h.durationMs : null,
    startedAt: Number.isFinite(h.startedAt) ? h.startedAt : null,
    endedAt: Number.isFinite(h.endedAt) ? h.endedAt : null,
    exit: exitView(h.exit),
    // **两个形状都提供**，因为两条消费路径的历史契约不同：
    //   - 工具路径（remote_handoff）的既有契约是嵌套 `summary.text`，
    //     已被测试与下游依赖（e2e 断言 `card.summary.text` 是字符串）。
    //   - UI 路径读的是扁平 `summaryText`。
    // 统一投影时若只留一个形状，就会静默破坏另一条路径 —— 这正是我第一版
    // 改动造成的回归（9 个测试失败）。两个都给，各有明确来源。
    summary: summary
      ? { text: typeof summary.text === 'string' ? summary.text.slice(0, 4000) : '' }
      : null,
    summaryText: summary && typeof summary.text === 'string' ? summary.text.slice(0, 4000) : '',
    changed: changedView(h.changed, { max: 50 }),
    // 任务变更 diff 视图（提案 #21）：副机对文本文件改动生成的 unified diff。
    diffs: diffsView(h.diffs),
    // handoff 里的 artifacts 走**专用**投影（它的 final 已是筛好的数组）
    artifacts: artifactsView(h.artifacts, { max: 200 }),
    pullHint: typeof h.pullHint === 'string' ? h.pullHint.slice(0, 1000) : '',
    // 刻意**不含**：workspace（绝对路径，回显主机目录）、logs（可能带环境变量）、
    // goal（原文已在任务投影里）、sessionId（副机内部标识）
  }
}

/**
 * 任务投影：工具与 UI 共用的"一条任务长什么样"。
 *
 * ── 必须**幂等**（对已投影过的对象再投影一次，结果不变） ──────────────
 * 共享层会被两条路径**叠加**调用：`registry.taskView(t)` 内部先做一次共享投影
 * （见 node-registry.js），而 UI 路由 `/tasks` 拿到它之后再调一次
 * `taskView(t)`（ui-routes.js）。若本函数假设输入一定是"原始注册表对象"，
 * 第二次投影就会把第一次的成果丢掉：
 *   - `summary.text` 在投影结果里变成了 `summaryText`，再读 `t.summary.text`
 *     就得到空串 → 面板展开任务时"结果摘要"整块消失
 *   - `changedCount` 从原始长度（例如 120）被降级成**已截断**的 `changed.length`（50）
 *   - `manifestCounts` 同理丢失（原始对象里是 `manifest`，投影后是 `manifestCounts`）
 * 所以三个字段都做"原始形状优先，已投影形状兜底"，让重复投影成为恒等操作。
 *
 * @param {object} t 节点注册表里的任务对象（含 nodeId/status/changed/manifest/…），
 *   或本函数先前的输出（幂等）
 * @param {object} [o]
 * @param {number} [o.tail] 日志/进度尾部保留几条
 * @param {boolean} [o.includeLogs] 是否带日志尾部（UI 要，工具的轻量视图可省）
 */
export function taskView(t, { tail = 6, includeLogs = true } = {}) {
  if (!t || typeof t !== 'object') return null
  const summaryText = t.summary && typeof t.summary.text === 'string'
    ? t.summary.text.slice(0, 2000)
    : typeof t.summaryText === 'string'
      ? t.summaryText.slice(0, 2000)
      : ''
  const out = {
    taskId: typeof t.taskId === 'string' ? t.taskId : '',
    nodeId: typeof t.nodeId === 'string' ? t.nodeId : '',
    nodeOnline: t.nodeOnline === true,
    status: typeof t.status === 'string' ? t.status : 'unknown',
    mode: typeof t.mode === 'string' ? t.mode : '',
    // 两阶段审批（提案 #2）：'manual'（挂起待批）| 'auto'
    approval: t.approval === 'manual' ? 'manual' : 'auto',
    goal: typeof t.goal === 'string' ? t.goal.slice(0, 500) : '',
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
    // ⚠ 时间字段的 schema 声明是 number，**不能返回 null**。
    //
    // DSH 在工具返回值出边界时跑 schema 校验（`validateJsonSchemaValue`），
    // null 会被判为 "must be a number" → 整个工具调用报
    // `returned invalid output: "value.startedAt" must be a number`。
    // 实测：remote_status 查一个刚创建、还没开始执行的任务就踩到
    // （createdAt 有值，但 startedAt/endedAt/durationMs 都还没有）。
    // 用 0 表达"还没有这个时间点" —— 消费方判 `> 0` 即可。
    startedAt: Number.isFinite(t.startedAt) ? t.startedAt : 0,
    endedAt: Number.isFinite(t.endedAt) ? t.endedAt : 0,
    durationMs: Number.isFinite(t.durationMs) ? t.durationMs : 0,
    exit: exitView(t.exit),
    error: errorView(t.error),
    summaryText,
    // changedCount 是"原始条数"（面板标题用它），不能被投影后的截断值覆盖。
    // 已投影对象里没有原始数组长度，只能信它带来的 changedCount。
    changedCount: Array.isArray(t.changed)
      ? (Number.isFinite(t.changedCount) ? t.changedCount : t.changed.length)
      : (Number.isFinite(t.changedCount) ? t.changedCount : 0),
    changed: changedView(t.changed, { max: 50 }),
    // manifestCounts 的 schema 是 object，同样不能用 null → 空对象兜底。
    manifestCounts: manifestView(t.manifest)?.counts
      ?? (t.manifestCounts && typeof t.manifestCounts === 'object' ? t.manifestCounts : {}),
    // workspace 刻意不回传：绝对路径会回显主机目录结构，而两个消费方都不读它。
  }
  if (includeLogs) {
    // progressTail 必须做**元素级**投影，不能只 slice：它同样源自副机上报
    // （node-registry 的 applyView 把 task/sync 里的数组原样存下），而消费方
    // 会解引用 `p.phase` / `p.detail`。详见 progressTailView 的说明。
    out.progressTail = progressTailView(t.progressTail, { tail })
    // logTail 用同一个 tailSlice：原先的裸 slice(-tail) 在 tail=0 时会把**整条**
    // 日志留下（slice(-0) === slice(0)），与"不要尾巴"相反。
    out.logTail = Array.isArray(t.logTail)
      ? tailSlice(t.logTail, tail).map((l) => (typeof l === 'string' ? l.slice(0, 2000) : String(l).slice(0, 2000)))
      : []
  }
  return out
}
