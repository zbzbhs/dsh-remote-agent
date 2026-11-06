/**
 * 投影共享层 lib/hub/views.js 的**行为测试**（安全边界）。
 *
 * 为什么这个文件必须有：views.js 的输入是**副机上报的数据**（独立、可被攻陷的
 * 远端），输出是会被两条消费路径读走的形状 ——
 *   ① 工具返回值（remote_status / remote_handoff / remote_manifest）→ 进会话日志
 *   ② Web 面板 → 进浏览器
 * 在此之前它只有**间接**覆盖（ui-routes.test.js 走 HTTP、engine/hub-worker e2e 走
 * 全链路），没有一条断言直接对着投影函数。于是"某个字段没被投影""某个畸形输入会
 * 抛"这类缺陷只能等下游偶发崩溃时才暴露。
 *
 * 本文件按六类断言组织（对应任务契约）：
 *   1. 敌意输入不泄漏（整体 JSON + 逐键 + 递归键扫描）
 *   2. 畸形元素被丢弃 / 被规范化
 *   3. 截断精确到声明上限
 *   4. 边界输入不抛，返回安全默认值
 *   5. 形状契约（summary/summaryText 双形状、artifacts vs manifest 语义不同）
 *   6. 数组上限 + 硬规则（逐字段构造，永不 spread 输入）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactsView,
  changedItemView,
  changedView,
  diffItemView,
  diffsView,
  errorView,
  exitView,
  finalItemView,
  handoffView,
  manifestView,
  nodeView,
  progressItemView,
  progressTailView,
  taskView,
} from '../lib/hub/views.js'

/* ══════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════ */

/** 声明的键集合（排序后比较）。加字段/加 spread 都会让这些断言失败。 */
const KEYS = {
  // diffs：提案 #21 变更 diff 视图（与 changed 平级的第三块内容）
  handoffView: ['taskId', 'nodeId', 'status', 'mode', 'runner', 'durationMs', 'startedAt', 'endedAt', 'exit', 'summary', 'summaryText', 'changed', 'diffs', 'artifacts', 'pullHint'].sort(),
  // approval：提案 #2 两阶段审批（'manual' | 'auto'）
  taskView: ['taskId', 'nodeId', 'nodeOnline', 'status', 'mode', 'approval', 'goal', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs', 'exit', 'error', 'summaryText', 'changedCount', 'changed', 'manifestCounts', 'progressTail', 'logTail'].sort(),
  taskViewNoLogs: ['taskId', 'nodeId', 'nodeOnline', 'status', 'mode', 'approval', 'goal', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs', 'exit', 'error', 'summaryText', 'changedCount', 'changed', 'manifestCounts'].sort(),
  manifestView: ['counts', 'bytesFinal', 'final'].sort(),
  artifactsView: ['counts', 'bytesFinal', 'final', 'intermediateCount', 'note'].sort(),
  exitView: ['code', 'timedOut', 'aborted', 'runner', 'toolCalls'].sort(),
  errorView: ['code', 'message'].sort(),
  // repos/reposAt：提案 #13 仓库清单（名字列表 + 上报时间）
  // runnerKind/defaultModel/models：提案 #27（后端 / 默认模型 / 可用清单）
  nodeView: [
    'nodeId', 'online', 'os', 'arch', 'agentMode', 'roots', 'caps', 'since', 'lastSeen',
    'taskCount', 'repos', 'reposAt', 'resource',
    'runnerKind', 'defaultModel', 'models', 'transportMode',
  ].sort(),
  finalItemView: ['path', 'kind', 'bytes', 'sha256'].sort(),
  changedItemView: ['op', 'path', 'bytes', 'deltaBytes'].sort(),
  progressItemView: ['phase', 'detail', 'at'].sort(),
  counts: ['total', 'final', 'intermediate', 'other'].sort(),
}

const sortedKeys = (o) => Object.keys(o).sort()

/** 递归收集输出树里出现的所有键（含嵌套对象与数组元素）。 */
function collectKeysDeep(value, acc = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeysDeep(v, acc)
    return acc
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k)
      collectKeysDeep(v, acc)
    }
  }
  return acc
}

/* ── 敌意上报 fixture ──
 *
 * 每一个敏感字段的值都带 LEAK 标记：这样"整体断言"只需查一个标记词，
 * 就能覆盖所有字段（包括将来新加的）。键名另有一份黑名单，用于逐键断言。
 */
const LEAK = 'LEAKSENTINEL'

/** 副机 handoff（形状取自 lib/node/task-engine.js 的 buildHandoff，并加塞敏感字段）。 */
function hostileHandoff() {
  return {
    taskId: 't-hostile',
    nodeId: 'node-hostile',
    status: 'completed',
    mode: 'exec',
    runner: 'claude',
    durationMs: 1234,
    startedAt: 10,
    endedAt: 20,
    // ① 绝对路径：会回显主机目录结构
    workspace: `D:\\${LEAK}\\host\\workspace`,
    // ② 副机内部标识
    sessionId: `${LEAK}-session`,
    // ③ 日志：可能含环境变量
    logs: { tail: [`${LEAK}_LOG_LINE`], full: `dsh-remote-agent://tasks/t-hostile/logs` },
    // ④ 任务原文（已在任务投影里，不该随卡片再来一遍）
    goal: `${LEAK}_GOAL_TEXT`,
    // ⑤ 任意键：副机版本升级/有人加诊断字段
    SECRET_TOP_KEY: `${LEAK}_top`,
    SECRET_ANY_KEY_2: `${LEAK}_any2`,
    summary: { text: '任务完成', sha256: `${LEAK}_sha`, source: 'agent', SECRET_SUMMARY_KEY: `${LEAK}_summary` },
    exit: { code: 0, timedOut: false, runner: 'claude', toolCalls: 2, SECRET_EXIT_KEY: `${LEAK}_exit`, stderr: `${LEAK}_STDERR` },
    error: { code: 'boom', message: 'diag', SECRET_ERROR_KEY: `${LEAK}_error`, stack: `${LEAK}_STACK` },
    changed: [{ op: 'add', path: 'a.txt', bytes: 1, deltaBytes: 1, SECRET_CHANGED_KEY: `${LEAK}_changed` }],
    // diffs（提案 #21）：投影后只留 path/diff/truncated，长度封顶
    diffs: [{ path: 'a.txt', diff: '--- a/a.txt\n', truncated: false, SECRET_DIFFS_KEY: `${LEAK}_diffs`, absPath: `D:\\${LEAK}\\host\\ws\\a.txt` }],
    artifacts: {
      counts: { total: 1, final: 1, intermediate: 0, other: 0, SECRET_COUNTS_KEY: `${LEAK}_counts` },
      bytesFinal: 1,
      final: [{ path: 'a.txt', kind: 'file', bytes: 1, sha256: 'ab', SECRET_FINAL_KEY: `${LEAK}_final` }],
      intermediateCount: 0,
      note: '只有 role:final 可以 pull。',
      SECRET_ARTIFACTS_KEY: `${LEAK}_artifacts`,
    },
    pullHint: '用 remote_pull 拉取 a.txt',
  }
}

/** 节点注册表里的任务对象（形状取自 node-registry 的 ensureTask / applyView）。 */
function hostileTask() {
  return {
    taskId: 't-hostile',
    nodeId: 'node-hostile',
    nodeOnline: true,
    status: 'completed',
    mode: 'exec',
    // goal 是 taskView 的**合法**白名单字段，所以它的值用普通文本：
    // LEAK 标记只用于「绝不该出现在输出里」的字段值，否则断言会互相打架。
    goal: '把 X 编译成 Y',
    workspace: `D:\\${LEAK}\\host\\workspace`,
    sessionId: `${LEAK}-session`,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    exit: { code: 0, timedOut: false, SECRET_EXIT_KEY: `${LEAK}_exit`, stderr: `${LEAK}_STDERR` },
    error: { code: 'boom', message: 'diag', SECRET_ERROR_KEY: `${LEAK}_error`, stack: `${LEAK}_STACK` },
    summary: { text: '任务完成', sha256: `${LEAK}_sha`, SECRET_SUMMARY_KEY: `${LEAK}_summary` },
    changed: [{ op: 'add', path: 'a.txt', bytes: 1, deltaBytes: 1, SECRET_CHANGED_KEY: `${LEAK}_changed` }],
    manifest: { counts: { total: 1, final: 1, intermediate: 0, other: 0, SECRET_COUNTS_KEY: `${LEAK}_counts` } },
    SECRET_TOP_KEY: `${LEAK}_top`,
    progressTail: [{ phase: 'started', detail: 'x', at: 1, SECRET_PROGRESS_KEY: `${LEAK}_progress` }],
    logTail: ['build ok'],
  }
}

/** handoffView 输出里绝不允许出现的键（含嵌套层）。
 *
 * 注意：`sha256` **不**在此列 —— 它是 finalItemView 的合法白名单字段，
 * 副机上报的 sha256 本来就该投影给消费方（pull 时用它校验）。这里禁的是
 * 「不该被投影的字段」，不是「含敏感内容的字段」。
 */
const FORBIDDEN_KEYS = [
  'workspace', 'logs', 'sessionId', 'goal', 'stderr', 'stack',
  'SECRET_TOP_KEY', 'SECRET_ANY_KEY_2', 'SECRET_SUMMARY_KEY', 'SECRET_EXIT_KEY',
  'SECRET_ERROR_KEY', 'SECRET_CHANGED_KEY', 'SECRET_DIFFS_KEY', 'SECRET_COUNTS_KEY', 'SECRET_FINAL_KEY',
  'SECRET_ARTIFACTS_KEY', 'source',
]

/* ══════════════════════════════════════════════════════════════════
 * 1. 敌意输入：一个敏感字段都不许进输出
 * ══════════════════════════════════════════════════════════════════ */

test('敌意 handoff：整体 JSON 不含任何敏感值（含嵌套）', () => {
  const out = handoffView(hostileHandoff())
  const json = JSON.stringify(out)

  // 整体断言：所有敏感值都带同一个标记词，一个标记词就覆盖全部字段
  assert.ok(!json.includes(LEAK), `投影输出不得含副机敏感值：${json}`)
  // 绝对路径的两种写法都不许出现（Windows 反斜杠 / POSIX 斜杠）
  assert.ok(!json.includes('host\\\\'), '不得回显主机目录结构（反斜杠形式）')
  assert.ok(!json.includes('host/'), '不得回显主机目录结构（斜杠形式）')
  // 副机内部 URL / 会话标识
  assert.ok(!json.includes('dsh-remote-agent://'), '不得回显副机内部 URL')
  assert.ok(!json.includes('session'), '不得回显 sessionId')
})

test('敌意 handoff：逐键断言（顶层 + 每个嵌套层）', () => {
  const out = handoffView(hostileHandoff())

  // 顶层键（用 Object.hasOwn：`in` 会走原型链，`constructor` 之类会恒真）
  for (const k of FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(out, k), false, `handoffView 顶层不应含键 ${k}`)
  }
  // 递归：嵌套对象与数组元素里也不许出现
  const seen = collectKeysDeep(out)
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!seen.has(k), `handoffView 输出树里不应含键 ${k}（嵌套层也不行）`)
  }

  // 白名单键确实被投影出来（证明不是"整卡为空"式的假通过）
  assert.equal(out.taskId, 't-hostile')
  assert.equal(out.status, 'completed')
  assert.equal(out.exit.code, 0)
  assert.equal(out.changed[0].path, 'a.txt')
  // diffs：合法字段被投影（证明 diffs 路径不是"整段消失"式的假通过）
  assert.equal(out.diffs.length, 1)
  assert.equal(out.diffs[0].path, 'a.txt')
  assert.equal(out.diffs[0].diff, '--- a/a.txt\n')
  assert.equal(out.diffs[0].truncated, false)
  assert.equal(out.artifacts.final[0].path, 'a.txt')
})

test('敌意 task：taskView 同样只出白名单字段', () => {
  const out = taskView(hostileTask())
  const json = JSON.stringify(out)

  assert.ok(!json.includes(LEAK), `taskView 输出不得含副机敏感值：${json}`)
  assert.ok(!('workspace' in out), 'taskView 不应含 workspace（绝对路径）')
  assert.ok(!('sessionId' in out), 'taskView 不应含 sessionId')

  const seen = collectKeysDeep(out)
  for (const k of ['workspace', 'sessionId', 'SECRET_TOP_KEY', 'SECRET_SUMMARY_KEY', 'SECRET_EXIT_KEY', 'SECRET_PROGRESS_KEY', 'SECRET_CHANGED_KEY', 'stderr', 'stack']) {
    assert.ok(!seen.has(k), `taskView 输出树里不应含键 ${k}`)
  }

  // goal 是 taskView 的合法字段，且必须被投影（不能被顺手删掉）
  assert.equal(out.goal, '把 X 编译成 Y')
  assert.equal(out.changed[0].op, 'add')
  assert.equal(out.progressTail[0].phase, 'started')
  assert.deepEqual(out.logTail, ['build ok'])
})

/* ══════════════════════════════════════════════════════════════════
 * 2. 畸形元素：非对象被丢弃，对象被规范化
 * ══════════════════════════════════════════════════════════════════ */

test('changed 畸形元素矩阵：非对象丢弃，对象规范化到 4 键', () => {
  const list = [
    null, // 丢弃
    'not-an-object', // 丢弃
    42, // 丢弃
    true, // 丢弃
    undefined, // 丢弃
    [], // typeof 'object' → 保留（空数组不是 null，不构成崩溃源）
    {}, // 保留，全默认值
    { path: 'only-path.txt' }, // 缺 op/bytes
    { op: 123 }, // op 类型错
    { op: 'add', path: 'ok.txt', bytes: 5, deltaBytes: -2 }, // 合法
  ]
  const out = changedView(list)

  // 只有对象活下来：null/字符串/数字/布尔/undefined 被丢
  assert.equal(out.length, 5, `应保留 5 个对象元素，实际 ${out.length}：${JSON.stringify(out)}`)
  assert.ok(out.every((x) => x && typeof x === 'object' && !Array.isArray(x)), '元素必须全是普通对象')

  // 每个元素恰 4 键（规范化：不多不少）
  for (const x of out) {
    assert.deepEqual(sortedKeys(x), KEYS.changedItemView, `元素键集不符：${JSON.stringify(x)}`)
  }

  // 缺字段 / 类型错 → 安全默认值
  // out[0] = []，out[1] = {}，out[2] = { path }，out[3] = { op: 123 }，out[4] = 合法
  assert.equal(out[1].op, 'unknown', '空对象应回 unknown')
  assert.equal(out[1].path, '')
  assert.equal(out[1].bytes, 0)
  assert.equal(out[1].deltaBytes, 0)
  assert.equal(out[2].path, 'only-path.txt', '只给 path 时 path 必须保留')
  assert.equal(out[2].op, 'unknown', '缺 op 应回 unknown')
  assert.equal(out[3].op, 'unknown', 'op 非字符串应回 unknown')
  assert.equal(out[3].path, '')

  // 合法元素完整保留（含负数 deltaBytes）
  const ok = out.find((x) => x.path === 'ok.txt')
  assert.ok(ok, '合法元素应保留')
  assert.equal(ok.op, 'add')
  assert.equal(ok.bytes, 5)
  assert.equal(ok.deltaBytes, -2)

  // 消费方解引用不崩（缺陷的原症状：渲染期抛错 → 面板整块空白）
  assert.doesNotThrow(() => {
    for (const c of out) {
      void c.op
      void c.path
      void c.bytes
      void c.deltaBytes
    }
  })
})

test('changedView：非数组输入回空数组，不抛', () => {
  for (const bad of [null, undefined, 'str', 42, {}, true]) {
    assert.deepEqual(changedView(bad), [], `changedView(${String(bad)}) 应回 []`)
  }
})

test('manifest.final / artifacts.final：畸形元素被丢弃且规范化', () => {
  const m = manifestView({
    items: [
      null,
      'x',
      7,
      { role: 'final' }, // 缺 path
      { role: 'final', path: 'ok.txt', kind: 1, bytes: 'nope', sha256: 42 },
      { role: 'intermediate', path: 'build.log' },
    ],
  })
  assert.equal(m.final.length, 2, `应保留 2 条 final，实际 ${m.final.length}`)
  for (const f of m.final) {
    assert.deepEqual(sortedKeys(f), KEYS.finalItemView)
  }
  assert.equal(m.final[0].path, '')
  assert.equal(m.final[0].kind, 'file')
  assert.equal(m.final[1].path, 'ok.txt')
  assert.equal(m.final[1].kind, 'file', 'kind 非字符串应回 file')
  assert.equal(m.final[1].bytes, 0, 'bytes 非数字应回 0')
  assert.equal(m.final[1].sha256, null, 'sha256 非字符串应回 null')

  const a = artifactsView({ final: [null, 'x', 9, {}, { path: 'p.txt', kind: 'report', bytes: 3, sha256: 'aa' }] })
  assert.equal(a.final.length, 2)
  for (const f of a.final) assert.deepEqual(sortedKeys(f), KEYS.finalItemView)
})

/* ══════════════════════════════════════════════════════════════════
 * 3. 截断：精确等于声明上限
 * ══════════════════════════════════════════════════════════════════ */

test('截断：超长 path 精确截到 500', () => {
  const long = 'p'.repeat(600)
  const c = changedItemView({ path: long })
  assert.equal(c.path.length, 500)
  assert.equal(c.path, 'p'.repeat(500))

  const f = finalItemView({ path: long })
  assert.equal(f.path.length, 500)
  assert.equal(f.path, 'p'.repeat(500))

  // 边界：恰好等于上限时不动它
  assert.equal(changedItemView({ path: 'p'.repeat(500) }).path.length, 500)
  assert.equal(changedItemView({ path: 'p'.repeat(499) }).path.length, 499)
})

test('截断：超长 error.message 精确截到 500', () => {
  const e = errorView({ code: 'x', message: 'm'.repeat(900) })
  assert.equal(e.message.length, 500)
  assert.equal(e.message, 'm'.repeat(500))
  assert.equal(errorView({ message: 'm'.repeat(500) }).message.length, 500)
})

test('截断：超长 summary.text 精确截到 4000，且两种形状一致', () => {
  const out = handoffView({ summary: { text: 's'.repeat(9000) } })
  assert.equal(out.summary.text.length, 4000)
  assert.equal(out.summary.text, 's'.repeat(4000))
  assert.equal(out.summaryText.length, 4000)
  assert.equal(out.summaryText, 's'.repeat(4000))
  assert.equal(out.summary.text, out.summaryText)
})

test('截断：taskView 的 summaryText 上限是 2000，pullHint 1000，goal 500，note 500', () => {
  assert.equal(taskView({ summary: { text: 's'.repeat(9000) } }).summaryText.length, 2000)
  assert.equal(handoffView({ pullHint: 'h'.repeat(3000) }).pullHint.length, 1000)
  assert.equal(taskView({ goal: 'g'.repeat(900) }).goal.length, 500)
  assert.equal(artifactsView({ note: 'n'.repeat(900) }).note.length, 500)
})

test('截断：logTail 每条截到 2000 且元素必为字符串', () => {
  const out = taskView({ logTail: ['a'.repeat(3000), null, 42, { x: 1 }] })
  assert.equal(out.logTail.length, 4)
  for (const l of out.logTail) assert.equal(typeof l, 'string', `logTail 元素必须是字符串：${JSON.stringify(l)}`)
  assert.equal(out.logTail[0].length, 2000)
  assert.equal(out.logTail[1], 'null', '非字符串被 String() 归一，不抛')
  assert.equal(out.logTail[2], '42')
})

/* ══════════════════════════════════════════════════════════════════
 * 4. 边界：null / undefined / 字符串 / 数字 / 数组 / 空对象 都不抛
 * ══════════════════════════════════════════════════════════════════ */

const OBJECT_FNS = {
  changedItemView,
  exitView,
  errorView,
  nodeView,
  finalItemView,
  manifestView,
  artifactsView,
  handoffView,
  taskView,
  progressItemView,
}

test('边界：对象类投影对 nullish / 标量输入回 null', () => {
  for (const [name, fn] of Object.entries(OBJECT_FNS)) {
    for (const bad of [null, undefined, '', 0, false, NaN]) {
      let r
      assert.doesNotThrow(() => {
        r = fn(bad)
      }, `${name}(${String(bad)}) 不应抛`)
      assert.equal(r, null, `${name}(${String(bad)}) 应回 null`)
    }
  }
})

test('边界：数组类投影对非数组输入回 []', () => {
  for (const [name, fn] of [['changedView', changedView], ['progressTailView', progressTailView]]) {
    for (const bad of [null, undefined, '', 0, {}, true]) {
      let r
      assert.doesNotThrow(() => {
        r = fn(bad)
      }, `${name}(${String(bad)}) 不应抛`)
      assert.deepEqual(r, [], `${name}(${String(bad)}) 应回 []`)
    }
  }
})

test('边界：数组当对象喂进来也不抛（typeof [] === "object"），返回全默认值对象', () => {
  for (const [name, fn] of Object.entries(OBJECT_FNS)) {
    let r
    assert.doesNotThrow(() => {
      r = fn([])
    }, `${name}([]) 不应抛`)
    assert.ok(r && typeof r === 'object', `${name}([]) 应回对象`)
  }
  // 逐项确认默认值
  assert.deepEqual(handoffView([]), {
    taskId: null,
    nodeId: null,
    status: null,
    mode: null,
    runner: null,
    durationMs: null,
    startedAt: null,
    endedAt: null,
    exit: null,
    summary: null,
    summaryText: '',
    changed: [],
    diffs: [],
    artifacts: null,
    pullHint: '',
  })
  assert.deepEqual(manifestView([]), { counts: null, bytesFinal: 0, final: [] })
  assert.deepEqual(artifactsView([]), { counts: null, bytesFinal: 0, final: [], intermediateCount: 0, note: '' })
  assert.deepEqual(exitView([]), { code: null, timedOut: false, aborted: false, runner: '', toolCalls: 0 })
  assert.deepEqual(errorView([]), { code: '', message: '' })
  assert.deepEqual(changedItemView([]), { op: 'unknown', path: '', bytes: 0, deltaBytes: 0 })
  assert.deepEqual(finalItemView([]), { path: '', kind: 'file', bytes: 0, sha256: null })
  assert.deepEqual(progressItemView([]), { phase: 'progress', detail: '', at: null })
})

test('边界：空对象喂进来 → 全默认值，不抛', () => {
  const h = handoffView({})
  assert.deepEqual(sortedKeys(h), KEYS.handoffView)
  assert.equal(h.exit, null)
  assert.equal(h.summary, null)
  assert.equal(h.summaryText, '')
  assert.deepEqual(h.changed, [])
  assert.equal(h.artifacts, null)

  const t = taskView({})
  assert.deepEqual(sortedKeys(t), KEYS.taskView)
  assert.equal(t.status, 'unknown')
  assert.equal(t.changedCount, 0)
  assert.deepEqual(t.changed, [])
  // manifestCounts 的 schema 声明是 object，**不能是 null** —— DSH 的工具返回值
  // schema 校验会报 `"value.manifestCounts" must be an object`，整个工具调用失败
  // （而任务其实已派出，属"有副作用却报失败"）。所以改成空对象兜底。
  assert.deepEqual(t.manifestCounts, {})
  assert.deepEqual(t.progressTail, [])
  assert.deepEqual(t.logTail, [])

  assert.equal(nodeView({}).os, 'unknown')
  assert.deepEqual(nodeView({}).roots, [])
  assert.deepEqual(nodeView({}).caps, [])
})

test('边界：summary / exit / manifest / artifacts 类型错（非对象）时按缺失处理', () => {
  for (const bad of ['str', 42, true]) {
    const h = handoffView({ summary: bad, exit: bad, changed: bad, artifacts: bad })
    assert.equal(h.summary, null, `summary=${String(bad)} 应按缺失处理`)
    assert.equal(h.summaryText, '')
    assert.equal(h.exit, null)
    assert.deepEqual(h.changed, [])
    assert.equal(h.artifacts, null)
  }
  // summary 是对象但 text 不是字符串 → 两种形状都给空串（保持一致）
  const h2 = handoffView({ summary: { text: 123 } })
  assert.equal(h2.summary.text, '')
  assert.equal(h2.summaryText, '')
  // manifest / artifacts 的 counts 非对象 → null（不是 {} 这种半成品）
  assert.equal(manifestView({ counts: 'nope' }).counts, null)
  assert.equal(artifactsView({ counts: 5 }).counts, null)
  // counts 是对象但字段类型错 → 逐字段归零
  assert.deepEqual(manifestView({ counts: { total: 'x', final: null } }).counts, {
    total: 0,
    final: 0,
    intermediate: 0,
    other: 0,
  })
})

test('边界：nodeView 过滤非字符串 roots/caps（副机上报的数组元素不可信）', () => {
  const n = nodeView({ nodeId: 'n1', online: true, roots: ['/a', 42, null, '/b'], caps: ['exec', {}], taskCount: 'x' })
  assert.deepEqual(n.roots, ['/a', '/b'])
  assert.deepEqual(n.caps, ['exec'])
  assert.equal(n.taskCount, 0)
  assert.equal(n.online, true)
})

/* ══════════════════════════════════════════════════════════════════
 * 5. 形状契约（重点，容易回归）
 * ══════════════════════════════════════════════════════════════════ */

test('形状：handoffView 同时给嵌套 summary.text 与扁平 summaryText，内容一致', () => {
  const text = '副机的摘要文本'
  const out = handoffView({ summary: { text } })
  assert.equal(typeof out.summary, 'object')
  assert.equal(out.summary.text, text, '工具路径读的是嵌套 summary.text（e2e 依赖）')
  assert.equal(out.summaryText, text, 'UI 路径读的是扁平 summaryText')
  assert.equal(out.summary.text, out.summaryText)

  // 一致性不变量：对任意输入都成立（含缺失 / 类型错 / 超长）
  const cases = [
    {},
    { summary: null },
    { summary: {} },
    { summary: { text: '' } },
    { summary: { text: 42 } },
    { summary: { text: 'x'.repeat(9000) } },
    { summary: 'not-an-object' },
    { summary: { text: 'ok', sha256: 'SECRET', source: 'agent' } },
  ]
  for (const c of cases) {
    const v = handoffView(c)
    assert.equal(v.summary?.text ?? '', v.summaryText, `两形状必须一致：${JSON.stringify(c)}`)
  }

  // 只留一个形状会静默破坏另一条路径 —— 显式锁住两个键都在
  assert.ok('summary' in out, 'summary 键必须存在')
  assert.ok('summaryText' in out, 'summaryText 键必须存在')
})

test('形状：artifacts.final 是"已筛好的数组"，manifest.final 是"按 role 筛"', () => {
  // ① handoff.artifacts 的形状（lib/node/task-engine.js buildHandoff）：
  //    条目只有 {path,kind,bytes,sha256}，**没有 role 字段**
  const handoffArtifacts = {
    counts: { total: 2, final: 2, intermediate: 1, other: 0 },
    bytesFinal: 6,
    final: [
      { path: '产物.txt', kind: 'report', bytes: 3, sha256: 'aa' },
      { path: 'build.exe', kind: 'file', bytes: 3, sha256: 'bb' },
    ],
    intermediateCount: 1,
    note: '只有 role:final 可以 pull。',
  }
  const a = artifactsView(handoffArtifacts)
  assert.equal(a.final.length, 2, 'artifactsView 不得按 role 筛：这些条目根本没有 role')
  assert.deepEqual(a.final.map((f) => f.path), ['产物.txt', 'build.exe'])

  // ② manifest 的形状（lib/artifacts.js buildManifest）：{items:[{role,...}]}
  const manifest = {
    counts: { total: 3, final: 1, intermediate: 1, other: 1 },
    bytesFinal: 3,
    items: [
      { role: 'final', path: '产物.txt', kind: 'report', bytes: 3, sha256: 'aa' },
      { role: 'intermediate', path: 'build.log', kind: 'file', bytes: 9 },
      { role: 'other', path: 'src.ts', kind: 'file', bytes: 9 },
    ],
  }
  const m = manifestView(manifest)
  assert.deepEqual(m.final.map((f) => f.path), ['产物.txt'], 'manifestView 必须按 role === "final" 筛')

  // ③ 两个形状**不同** —— 显式锁死差异。
  //    曾经把两者当同一形状（manifestView 的"按 role 筛"用到了 artifacts 上），
  //    结果 handoff.artifacts.final 恒为空数组（e2e「final 应含 产物.txt」失败）。
  assert.notDeepEqual(a.final.length, m.final.length)
  assert.equal(artifactsView({ final: manifest.items }).final.length, 3, 'artifacts 形状不筛 role：3 条全留')
  assert.equal(manifestView({ items: handoffArtifacts.final }).final.length, 0, 'manifest 形状必须筛 role：没有 role 就恒为空')

  // ④ 两者共享的字段投影一致（counts / bytesFinal / 条目键集）
  assert.deepEqual(sortedKeys(a.counts), KEYS.counts)
  assert.deepEqual(sortedKeys(m.counts), KEYS.counts)
  for (const f of [...a.final, ...m.final]) assert.deepEqual(sortedKeys(f), KEYS.finalItemView)
  // artifacts 独有字段，manifest 不该长出来（反之亦然）
  assert.equal('intermediateCount' in m, false)
  assert.equal('note' in m, false)
})

/* ══════════════════════════════════════════════════════════════════
 * 6. 数组上限 + 硬规则（逐字段构造，永不 spread）
 * ══════════════════════════════════════════════════════════════════ */

test('数组上限：changed 截到 50，final 截到 200（默认值 + 调用点一致）', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ op: 'add', path: `f${i}.txt`, bytes: i }))
  assert.equal(changedView(many).length, 50, 'changedView 默认 max=50')
  // handoffView / taskView 里硬编码的就是 50，不能各自漂移
  assert.equal(handoffView({ changed: many }).changed.length, 50)
  assert.equal(taskView({ changed: many }).changed.length, 50)

  const finals = Array.from({ length: 300 }, (_, i) => ({ role: 'final', path: `f${i}.txt` }))
  assert.equal(manifestView({ items: finals }).final.length, 200, 'manifestView 默认 max=200')
  assert.equal(artifactsView({ final: finals }).final.length, 200, 'artifactsView 默认 max=200')
  assert.equal(handoffView({ artifacts: { final: finals } }).artifacts.final.length, 200)

  // 正好等于上限时不动它
  assert.equal(changedView(many.slice(0, 50)).length, 50)
  assert.equal(manifestView({ items: finals.slice(0, 200) }).final.length, 200)
})

test('数组上限：diffs 截到 12（与副机 buildDiffs 上限同口径），handoffView 硬编码一致', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt`, diff: `x${i}`, truncated: false }))
  assert.equal(diffsView(many).length, 12, 'diffsView 默认 max=12')
  assert.equal(handoffView({ diffs: many }).diffs.length, 12, 'handoffView 里硬编码的就是 12')
  assert.equal(diffsView(many.slice(0, 12)).length, 12, '正好等于上限时不动')
  assert.deepEqual(diffsView(many, { max: 2 }).map((d) => d.path), ['f0.txt', 'f1.txt'])
  assert.equal(diffsView(null).length, 0)
  assert.equal(diffsView('nope').length, 0)
})

test('diffItemView：path/diff 双非空门槛 + 长度封顶（path 500 / diff 16KB）', () => {
  // 缺 path 或 diff 的条目直接丢弃
  assert.equal(diffItemView({ path: 'a.txt', diff: '' }), null)
  assert.equal(diffItemView({ path: '', diff: 'x' }), null)
  assert.equal(diffItemView({ path: 'a.txt' }), null)
  assert.equal(diffItemView({ diff: 'x' }), null)
  assert.equal(diffItemView(null), null)
  assert.equal(diffItemView(42), null)

  // 长度封顶：path 截 500，diff 截 16KB，truncated 非真归 false
  const d = diffItemView({
    path: 'p'.repeat(900),
    diff: 'd'.repeat(20 * 1024),
    truncated: 'yes',
    SECRET_KEY: 'LEAKSENTINEL_diffs',
  })
  assert.equal(d.path.length, 500)
  assert.equal(d.diff.length, 16 * 1024)
  assert.equal(d.truncated, false)
  assert.deepEqual(Object.keys(d).sort(), ['diff', 'path', 'truncated'], '逐字段构造，塞进来的任意键不得带出')
})

test('handoffView：diffs 是数组才投影，类型错归空数组（不抛）', () => {
  assert.deepEqual(handoffView({ diffs: 'nope' }).diffs, [])
  assert.deepEqual(handoffView({ diffs: 42 }).diffs, [])
  assert.deepEqual(handoffView({ diffs: [null, 3, { path: 'a.txt', diff: 'x' }] }).diffs,
    [{ path: 'a.txt', diff: 'x', truncated: false }], '非对象/缺字段元素被过滤')
})

test('数组上限：max 选项生效，且截断保留的是**前** max 条', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ op: 'add', path: `f${i}.txt` }))
  assert.deepEqual(changedView(many, { max: 3 }).map((c) => c.path), ['f0.txt', 'f1.txt', 'f2.txt'])
  assert.equal(changedView(many, { max: 0 }).length, 0)

  const finals = Array.from({ length: 10 }, (_, i) => ({ role: 'final', path: `f${i}.txt` }))
  assert.deepEqual(manifestView({ items: finals }, { max: 2 }).final.map((f) => f.path), ['f0.txt', 'f1.txt'])
  assert.deepEqual(artifactsView({ final: finals }, { max: 2 }).final.map((f) => f.path), ['f0.txt', 'f1.txt'])
})

test('数组上限：tail 保留的是**后** tail 条（进度/日志方向相反）', () => {
  const progress = Array.from({ length: 30 }, (_, i) => ({ phase: `p${i}`, detail: '', at: i }))
  const v = taskView({ progressTail: progress }, { tail: 5 })
  assert.deepEqual(v.progressTail.map((p) => p.phase), ['p25', 'p26', 'p27', 'p28', 'p29'])

  const logs = Array.from({ length: 50 }, (_, i) => `l${i}`)
  assert.deepEqual(taskView({ logTail: logs }, { tail: 3 }).logTail, ['l47', 'l48', 'l49'])

  // tail: 0 的语义是"不要尾巴"，而不是 slice(-0) 把整条数组都留下
  assert.deepEqual(taskView({ progressTail: progress, logTail: logs }, { tail: 0 }).progressTail, [])
  assert.deepEqual(taskView({ progressTail: progress, logTail: logs }, { tail: 0 }).logTail, [])
})

test('硬规则：输出键集合恰好等于声明的键集合（加 spread 会立刻失败）', () => {
  const t = hostileTask()
  const h = hostileHandoff()

  assert.deepEqual(sortedKeys(taskView(t)), KEYS.taskView)
  assert.deepEqual(sortedKeys(taskView(t, { includeLogs: false })), KEYS.taskViewNoLogs)
  assert.deepEqual(sortedKeys(handoffView(h)), KEYS.handoffView)
  assert.deepEqual(sortedKeys(manifestView(t.manifest)), KEYS.manifestView)
  assert.deepEqual(sortedKeys(artifactsView(h.artifacts)), KEYS.artifactsView)
  assert.deepEqual(sortedKeys(exitView(t.exit)), KEYS.exitView)
  assert.deepEqual(sortedKeys(errorView(t.error)), KEYS.errorView)
  assert.deepEqual(sortedKeys(nodeView({ nodeId: 'n', roots: [], caps: [] })), KEYS.nodeView)
  assert.deepEqual(sortedKeys(finalItemView({ path: 'a' })), KEYS.finalItemView)
  assert.deepEqual(sortedKeys(changedItemView({ op: 'add' })), KEYS.changedItemView)
  assert.deepEqual(sortedKeys(progressItemView({ phase: 'p' })), KEYS.progressItemView)

  // 嵌套层同样锁住（spread 输入最容易在 counts 这种"直接带过去"的地方漏）
  assert.deepEqual(sortedKeys(manifestView(t.manifest).counts), KEYS.counts)
  assert.deepEqual(sortedKeys(artifactsView(h.artifacts).counts), KEYS.counts)
  assert.deepEqual(sortedKeys(handoffView(h).exit), KEYS.exitView)
  assert.deepEqual(sortedKeys(handoffView(h).summary), ['text'])
  assert.deepEqual(sortedKeys(handoffView(h).changed[0]), KEYS.changedItemView)
  assert.deepEqual(sortedKeys(handoffView(h).artifacts.final[0]), KEYS.finalItemView)
})

test('硬规则：输入对象的可枚举 getter 一次都不被触发（spread/Object.assign 会触发）', () => {
  let touched = 0
  const hostile = { taskId: 't', status: 'completed', summary: { text: 'ok' } }
  for (const k of ['SECRET_GETTER_A', 'workspace', 'logs']) {
    Object.defineProperty(hostile, k, {
      enumerable: true,
      configurable: true,
      get() {
        touched += 1
        return `${LEAK}_${k}`
      },
    })
  }
  // 嵌套对象的 getter 同样不能触发（证明没有对 summary 做 spread）
  Object.defineProperty(hostile.summary, 'SECRET_GETTER_B', {
    enumerable: true,
    configurable: true,
    get() {
      touched += 1
      return `${LEAK}_nested`
    },
  })

  const h = handoffView(hostile)
  const v = taskView(hostile)

  assert.equal(touched, 0, '投影必须逐字段读取，绝不枚举输入对象的键')
  assert.ok(!JSON.stringify(h).includes(LEAK))
  assert.ok(!JSON.stringify(v).includes(LEAK))
  assert.equal(h.summary.text, 'ok', '白名单字段仍要正常读到')
})

test('硬规则：输入带 __proto__ / constructor 键也不污染输出原型', () => {
  const evil = JSON.parse('{"taskId":"t","__proto__":{"polluted":true},"constructor":{"x":1},"status":"completed"}')
  const h = handoffView(evil)
  const v = taskView(evil)
  assert.equal({}.polluted, undefined, '不得污染 Object.prototype')
  assert.equal(Object.getPrototypeOf(h), Object.prototype)
  assert.equal(Object.getPrototypeOf(v), Object.prototype)
  // 用 Object.hasOwn 而不是 `in`：`in` 会走原型链，而每个对象都从
  // Object.prototype 继承 constructor —— 那样断言恒为假，测的是空气。
  assert.equal(Object.hasOwn(h, 'polluted'), false)
  assert.equal(Object.hasOwn(v, 'polluted'), false)
  assert.equal(Object.hasOwn(h, 'constructor'), false)
  assert.equal(Object.hasOwn(v, 'constructor'), false)
  assert.equal(Object.hasOwn(h, '__proto__'), false)
  assert.equal(Object.hasOwn(v, '__proto__'), false)
  assert.deepEqual(sortedKeys(h), KEYS.handoffView)
  assert.deepEqual(sortedKeys(v), KEYS.taskView)
})

/* ══════════════════════════════════════════════════════════════════
 * 回归：progressTail 必须做元素级投影
 *
 * 缺陷（本文件测出）：taskView 的 progressTail 是**唯一的裸透传**——
 * `t.progressTail.slice(-tail)`，元素原样出。而 progressTail 来自副机：
 *   - registry-ingest.js applyView 把 task/sync 里的 view.progressTail 原样存下
 *   - registry-ingest.js task/progress 帧自己构造 entry，但 task/sync 那条路不校验
 * 两条消费方都直接解引用元素：
 *   - lib/hub/tools.js:384        `p.phase` / `p.detail`（remote_status 渲染）
 *   - lib/hub/subagent-provider.js:258 `p.phase` / `p.detail`（subagent 兜底文本）
 * 副机上报一个 null 元素 → TypeError。tools 那条会让工具渲染抛错；
 * subagent 那条更隐蔽：异常被 provider 的 try/catch 兜住，于是**一个已完成的任务
 * 被上报成"未完成：Cannot read properties of null"**。
 * 同一缺陷还违反 remote_status 自己声明的输出 schema
 * （tools.js:367 `progressTail: { items: { type: 'object' } }`）。
 * ══════════════════════════════════════════════════════════════════ */

test('[回归] taskView 对 progressTail 做元素级投影（副机上报畸形进度不崩渲染）', () => {
  const task = {
    taskId: 't-progress',
    nodeId: 'n1',
    status: 'running',
    progressTail: [
      null,
      'not-an-object',
      42,
      {},
      { phase: 'started', detail: 'cmd', at: 1, SECRET_PROGRESS_KEY: `${LEAK}_p` },
    ],
  }
  const v = taskView(task)

  // ① 非对象元素被丢弃（null / 字符串 / 数字），对象留下
  assert.equal(v.progressTail.length, 2, `应保留 2 个对象元素，实际 ${JSON.stringify(v.progressTail)}`)
  assert.ok(v.progressTail.every((p) => p && typeof p === 'object' && !Array.isArray(p)))

  // ② 每个元素恰 3 键（白名单）
  for (const p of v.progressTail) {
    assert.deepEqual(sortedKeys(p), KEYS.progressItemView, `元素键集不符：${JSON.stringify(p)}`)
  }

  // ③ 缺字段给安全默认值
  assert.equal(v.progressTail[0].phase, 'progress')
  assert.equal(v.progressTail[0].detail, '')
  assert.equal(v.progressTail[0].at, null)
  assert.equal(v.progressTail[1].phase, 'started')
  assert.equal(v.progressTail[1].at, 1)

  // ④ 敏感字段不透传
  assert.ok(!JSON.stringify(v).includes(LEAK), 'progressTail 不得透传副机字段')

  // ⑤ 两条消费方的渲染路径都不崩（缺陷的原症状）
  assert.doesNotThrow(() => {
    for (const p of v.progressTail) {
      void p.phase
      void p.detail
    }
  }, 'tools.js / subagent-provider.js 的渲染路径不应抛 TypeError')

  // ⑥ 声明的输出 schema：progressTail 元素必须全是对象
  assert.ok(v.progressTail.every((p) => typeof p === 'object' && p !== null), '违反 tools.js:367 的 items:{type:"object"}')
})

test('[回归] progressTailView / progressItemView 直接契约', () => {
  assert.equal(progressItemView(null), null)
  assert.equal(progressItemView('x'), null)
  assert.equal(progressItemView(1), null)
  assert.deepEqual(progressItemView({ phase: 'p', detail: 'd', at: 5 }), { phase: 'p', detail: 'd', at: 5 })
  assert.deepEqual(progressItemView({ phase: 1, detail: 2, at: 'x' }), { phase: 'progress', detail: '', at: null })
  assert.equal(progressItemView({ detail: 'd'.repeat(900) }).detail.length, 500, 'detail 截到 500')

  const list = [null, { phase: 'a' }, 'x', { phase: 'b' }]
  assert.deepEqual(progressTailView(list).map((p) => p.phase), ['a', 'b'])
  assert.deepEqual(progressTailView(null), [])
  assert.equal(progressTailView(Array.from({ length: 30 }, (_, i) => ({ phase: `p${i}` })), { max: 3 }).length, 3)
})

/* ══════════════════════════════════════════════════════════════════
 * 回归：taskView 必须**幂等**（共享层被两条路径叠加调用）
 *
 * 缺陷（本文件测出）：taskView 假设输入一定是"原始注册表对象"，而实际有两条
 * 路径把它叠加调用两次：
 *   ① registry.taskView(t)   —— node-registry.js taskView 先调一次共享投影
 *   ② UI 路由 /tasks         —— ui-routes.js:377 拿到①的结果再调一次 taskView
 * 第二次投影把第一次的成果丢掉（实测）：
 *   - summaryText：投影后原 `summary.text` 不存在了，只剩 `summaryText`，
 *     于是重投影读出空串 → 面板展开任务时"结果摘要"整块消失（client.js:523 判空）
 *   - changedCount：从原始 120 降级成已截断的 50 → 面板标题"工作区变更（50）"骗人
 *   - manifestCounts：原始对象里是 `manifest`，投影后是 `manifestCounts`，重投影丢
 * 根因是"投影函数只认原始形状"，而共享层被当成可重入的。
 * ══════════════════════════════════════════════════════════════════ */

test('[回归] taskView 幂等：对已投影对象再投影，结果不变', () => {
  const raw = {
    taskId: 't-idem',
    nodeId: 'n1',
    nodeOnline: true,
    status: 'completed',
    mode: 'exec',
    goal: '编译',
    summary: { text: '副机真正上报的摘要' },
    changed: Array.from({ length: 120 }, (_, i) => ({ op: 'add', path: `f${i}.txt` })),
    manifest: { counts: { total: 5, final: 3, intermediate: 1, other: 1 } },
    exit: { code: 0, timedOut: false },
    error: null,
    progressTail: [{ phase: 'started', at: 1 }],
    logTail: ['line'],
  }
  const once = taskView(raw)
  const twice = taskView(once)

  // 幂等：第二次投影不改变任何字段
  assert.deepEqual(twice, once, 'taskView(taskView(x)) 必须等于 taskView(x)')

  // 逐条锁住三个曾被丢掉的字段（防回归到"只认原始形状"）
  assert.equal(once.summaryText, '副机真正上报的摘要')
  assert.equal(twice.summaryText, '副机真正上报的摘要', '重投影不得丢掉 summaryText')
  assert.equal(once.changedCount, 120, 'changedCount 是原始条数')
  assert.equal(twice.changedCount, 120, '重投影不得把 changedCount 降级成截断值')
  assert.deepEqual(once.manifestCounts, { total: 5, final: 3, intermediate: 1, other: 1 })
  assert.deepEqual(twice.manifestCounts, once.manifestCounts, '重投影不得丢掉 manifestCounts')
  assert.equal(once.changed.length, 50, 'changed 仍按 max 截断')
  assert.equal(twice.changed.length, 50)
  assert.deepEqual(twice.progressTail, [{ phase: 'started', detail: '', at: 1 }])
})

test('[回归] taskView 幂等：复刻 registry + UI 路由的叠加调用（真实消费路径）', () => {
  // registry.taskView（node-registry.js）先投影一次，再补两个自有字段
  const registryTaskView = (t) => ({
    ...taskView({ ...t, nodeOnline: true }, { tail: 6 }),
    accepted: t.accepted === true,
    handoffAvailable: Boolean(t.handoff),
  })

  const raw = {
    taskId: 't-real',
    nodeId: 'n1',
    status: 'completed',
    goal: '编译',
    summary: { text: '副机真正上报的摘要' },
    changed: Array.from({ length: 120 }, (_, i) => ({ op: 'add', path: `f${i}.txt` })),
    manifest: { counts: { total: 5, final: 3, intermediate: 1, other: 1 } },
    accepted: true,
    handoff: { taskId: 't-real' },
  }

  const listed = registryTaskView(raw) // ① /overview、/tasks 列表用的形状
  const sent = taskView(listed) // ② ui-routes.js:377 的第二次投影

  assert.equal(sent.summaryText, '副机真正上报的摘要', '面板"结果摘要"不得因重投影消失')
  assert.equal(sent.changedCount, 120, '面板"工作区变更（N）"不得被降级')
  assert.deepEqual(sent.manifestCounts, { total: 5, final: 3, intermediate: 1, other: 1 })
  assert.equal(sent.status, 'completed')
  assert.equal(sent.goal, '编译')

  // accepted / handoffAvailable 不是共享层字段（registry 补的），重投影后丢失是
  // 既有行为，不在本层修 —— 但必须显式记录，避免有人误以为它们是白名单成员。
  assert.equal(sent.accepted, undefined)
  assert.equal(sent.handoffAvailable, undefined)
  assert.deepEqual(sortedKeys(sent), KEYS.taskView)
})
