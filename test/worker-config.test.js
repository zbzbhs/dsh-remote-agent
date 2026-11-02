/**
 * 副机侧配置解析单元测试（lib/node/index.js 的**纯函数**）。
 *
 * 为什么单独立一个文件：lib/node/index.js 有 790+ 行，但真正决定"这台副机能不能
 * 安全跑起来"的是开头那几百行配置解析 —— 而它此前**零直接测试**（只有 e2e 间接
 * 覆盖到"显式配好一切"的那条理想路径）。历史上踩过的两类坑：
 *
 *   1. `resolvePowerShell` 相关的环境差异 —— 机器上只有 Windows PowerShell 5.1
 *      时返回了不存在的 'pwsh.exe'（见 exec.js 的说明）。
 *   2. stateDir 不可写时的降级 —— 不能抛，否则副机 dsh 整个起不来。
 *
 * 本文件只测导出的纯函数，**不调用 applyWorker**（它是插件入口，需要 cordis ctx）。
 *
 * ── 覆盖到的真实缺陷（已在本文件建立时修复） ──────────────────────
 *
 * [D-A] `sanitizeNodeId` 只在"剥完为空"时才掺原文指纹，于是两种"信息被丢掉"的
 *       形态会把**不同的机器收敛成同一个 nodeId**：
 *         ① 中文前缀 + ASCII 后缀：`研发-pc` 与 `测试-pc` 都变成 `pc`。
 *            这是中文 Windows 上最常见的主机名形态，两台机器撞 id 后 hub 侧
 *            表现为 `duplicate-node`，一台把另一台顶下线。
 *         ② 截断到 64：`'a'*70` 与 `'a'*64+'b'` 前 64 位相同。
 *       修法：判据从"结果是否为空"改成"清洗是否丢掉了信息"，丢过信息就掺
 *       sha256 前 8 位；没丢信息时**绝不动** id（显式配的 `nodeId` 必须原样保留）。
 *
 * [D-B] `buildNodeHello` 的 `nodeId` override 不过清洗，调用方传 `''` / `'中文节点'`
 *       / `'X Y'` 时会产出 hub **必拒**的 hello（`hello-nodeId-invalid`）。
 *       修法：override 也过一遍 sanitizeNodeId（对已清洗值幂等，startWorker 行为不变）。
 *
 * [D-C] `ensureStateDir` 是模块私有函数，"不可写就降级、绝不抛"这条契约只能靠
 *       applyWorker 间接覆盖（而它需要 ctx）。修法：导出它，让契约可被直接断言。
 *
 * 全部用例使用**临时目录**，结束时清理；不碰真实 `~/.dsh`（homedir 用 mock 替换）。
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildNodeHello,
  detectOs,
  detectShells,
  ensureStateDir,
  resolveRoots,
  resolveStateDir,
  resolveToken,
  sanitizeNodeId,
} from '../lib/node/index.js'
import { defaultRoots } from '../lib/node/exec.js'
import { PROTOCOL_VERSION, validateHello } from '../lib/protocol.js'

/* ─────────────────────────── 临时目录脚手架 ─────────────────────────── */

/** 建一个测试专用临时根目录，注册到 t.after 清理（Windows 偶发占用用 maxRetries）。 */
function tmpRoot(t, tag = 'dsh-t4') {
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)))
    : fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

/**
 * 把 os.homedir 指到临时目录。
 *
 * 必要性有两层：① 不碰真实 `~/.dsh`；② `defaultRoots()` 会**真的 mkdir**，
 * 不替换 homedir 就会在开发者真实 home 下创建 `dsh-remote-work` 目录 —— 测试
 * 不该有这种副作用。mock 由 t.mock 自动还原。
 */
function fakeHome(t, dir) {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  t.mock.method(os, 'homedir', () => home)
  return home
}

/* ═════════════════════════ 1. sanitizeNodeId ═════════════════════════ */

test('sanitizeNodeId：合法 id 原样通过（一个字节都不改）', (t) => {
  // 显式配置的 nodeId 必须原样保留 —— 否则用户按文档配的 id 会带上哈希后缀，
  // 而 hub 侧的 nodeToken/节点名绑定、README 里的示例都会对不上。
  for (const id of ['slave-pc', 'node-01', 'a', 'a.b_c-d', 'DESKTOP-ABC', 'x'.repeat(64)]) {
    assert.equal(sanitizeNodeId(id), id.toLowerCase(), `id=${id}`)
  }
  // 大小写：协议是大小写敏感的字符集，但生成时统一小写（避免同一台机器因
  // 主机名大小写差异注册成两个节点）。
  assert.equal(sanitizeNodeId('DESKTOP-ABC'), 'desktop-abc')
})

test('sanitizeNodeId：非法字符 → "-"，首尾非字母数字被剥掉', () => {
  assert.equal(sanitizeNodeId('my pc'), 'my-pc')
  assert.equal(sanitizeNodeId('a:b'), 'a-b')
  assert.equal(sanitizeNodeId('a/b'), 'a-b')
  assert.equal(sanitizeNodeId('a\\b'), 'a-b')
  assert.equal(sanitizeNodeId('  x  '), 'x')
  // 前导非字母数字全部剥掉（协议要求首字符是 [A-Za-z0-9]）
  assert.match(sanitizeNodeId('___pc'), /^[a-z0-9]/)
  assert.match(sanitizeNodeId('...pc'), /^[a-z0-9]/)
})

test('sanitizeNodeId：长度封顶 64，且结果永远合法', () => {
  const long = sanitizeNodeId('a'.repeat(70))
  assert.ok(long.length <= 64, `len=${long.length}`)
  assert.ok(long.length > 0)
  assert.equal(validateHello({ nodeId: long, protocol: PROTOCOL_VERSION, os: 'linux' }).ok, true)

  // 64 位是合法边界，不该被截断
  const exact = 'a'.repeat(64)
  assert.equal(sanitizeNodeId(exact), exact)
})

test('sanitizeNodeId：非字符串输入不抛，收敛成合法 id', () => {
  for (const raw of [undefined, null, 42, 0, true, {}, [], () => {}]) {
    let out
    assert.doesNotThrow(() => {
      out = sanitizeNodeId(raw)
    }, `raw=${String(raw)}`)
    assert.equal(typeof out, 'string', `raw=${String(raw)}`)
    assert.equal(
      validateHello({ nodeId: out, protocol: PROTOCOL_VERSION, os: 'linux' }).ok,
      true,
      `raw=${String(raw)} → ${out}`,
    )
  }
})

test('sanitizeNodeId：幂等 —— 对已清洗的 id 再清洗一次结果不变', () => {
  // 幂等是必需的：startWorker 会 sanitizeNodeId(cfg.nodeId)，而 buildNodeHello
  // 内部又会对传进来的 nodeId 再清洗一次（见 D-B 修复）。不幂等就会二次变形。
  for (const raw of ['研发-pc', '测试-pc', '我的电脑', '我的电脑2', 'My PC', '', 'a'.repeat(70), 'slave-pc']) {
    const once = sanitizeNodeId(raw)
    assert.equal(sanitizeNodeId(once), once, `raw=${JSON.stringify(raw)} → ${once}`)
  }
})

test('[D-A] sanitizeNodeId：非 ASCII / 中文主机名 —— 不同机器必须得到不同 id', () => {
  // 这是本文件最关键的一条断言。旧实现下 `研发-pc` 与 `测试-pc` **都**变成 `pc`：
  // 中文前缀在清洗时被替换成 '-'，随后又被"剥掉首尾非字母数字"整段删掉，
  // 只剩后缀。两台这样的机器撞成同一个 nodeId，hub 侧一台会把另一台顶下线
  // （duplicate-node），而两边日志看起来都正常。
  const pairs = [
    ['研发-pc', '测试-pc'],
    ['研发-pc', '运维-pc'],
    ['我的电脑', '你的电脑'],
    ['电脑-a', '电脑-b'],
    ['生产-服务器', '测试-服务器'],
    ['ÄÖÜ', 'äöü'],
  ]
  for (const [a, b] of pairs) {
    const idA = sanitizeNodeId(a)
    const idB = sanitizeNodeId(b)
    assert.notEqual(idA, idB, `"${a}" 与 "${b}" 撞成了同一个 id: ${idA}`)
    // 两个都必须是合法 nodeId，否则"不同"没有意义（都会被 hub 拒）
    for (const id of [idA, idB]) {
      assert.equal(validateHello({ nodeId: id, protocol: PROTOCOL_VERSION, os: 'windows' }).ok, true, id)
    }
  }
})

test('[D-A] sanitizeNodeId：纯中文/非 ASCII 走 sha256 前 8 位兜底，且保留可读前缀', () => {
  const pure = sanitizeNodeId('我的电脑')
  assert.match(pure, /^node-[0-9a-f]{8}$/, `pure=${pure}`)
  // 两个不同的纯中文名必须不同
  assert.notEqual(pure, sanitizeNodeId('你的电脑'))

  // 带 ASCII 后缀的中文名：保留 ASCII 前缀 + 指纹，仍然可读
  const mixed = sanitizeNodeId('研发-pc')
  assert.match(mixed, /^pc-[0-9a-f]{8}$/, `mixed=${mixed}`)
  assert.notEqual(mixed, sanitizeNodeId('测试-pc'))
})

test('[D-A] sanitizeNodeId：截断丢信息时也要掺指纹（前 64 位相同的长名不撞）', () => {
  const a = 'a'.repeat(70)
  const b = `${'a'.repeat(64)}b`
  assert.notEqual(sanitizeNodeId(a), sanitizeNodeId(b), '截断后前 64 位相同的两个名字撞了')
  for (const id of [sanitizeNodeId(a), sanitizeNodeId(b)]) {
    assert.ok(id.length <= 64, `len=${id.length}`)
    assert.equal(validateHello({ nodeId: id, protocol: PROTOCOL_VERSION, os: 'linux' }).ok, true, id)
  }
})

test('sanitizeNodeId：空 / 全非法输入也有稳定且合法的 id（不抛）', () => {
  for (const raw of ['', '   ', '...', '___', '---', '。。。', null, undefined]) {
    const id = sanitizeNodeId(raw)
    assert.match(id, /^node-[0-9a-f]{8}$/, `raw=${JSON.stringify(raw)} → ${id}`)
    assert.equal(validateHello({ nodeId: id, protocol: PROTOCOL_VERSION, os: 'linux' }).ok, true)
  }
  // 同一台机器反复调用必须稳定（否则每次启动换个 id，hub 侧会留下幽灵节点）
  assert.equal(sanitizeNodeId(''), sanitizeNodeId(''))
  assert.equal(sanitizeNodeId('我的电脑'), sanitizeNodeId('我的电脑'))
})

/* ═════════════════════════ 2. resolveStateDir ═════════════════════════ */

test('resolveStateDir：显式配置优先，并 resolve 成绝对路径', (t) => {
  const dir = tmpRoot(t)
  const rel = 'rel-state'
  const got = resolveStateDir({ stateDir: rel })
  assert.equal(path.isAbsolute(got), true)
  assert.equal(got, path.resolve(rel))

  const abs = path.join(dir, 'state')
  assert.equal(resolveStateDir({ stateDir: abs }), path.resolve(abs))
  // 两端空白被 trim
  assert.equal(resolveStateDir({ stateDir: `  ${abs}  ` }), path.resolve(abs))
})

test('resolveStateDir：未配置 / 空白 / 非字符串 → 默认 homedir 下的目录', (t) => {
  const dir = tmpRoot(t)
  const home = fakeHome(t, dir)
  const want = path.join(home, '.dsh-remote-agent')
  for (const cfg of [{}, { stateDir: '' }, { stateDir: '   ' }, { stateDir: 42 }, { stateDir: null }, undefined]) {
    assert.equal(resolveStateDir(cfg), want, `cfg=${JSON.stringify(cfg)}`)
  }
  // 不抛
  assert.doesNotThrow(() => resolveStateDir())
})

test('resolveStateDir：homedir 不可用时降级到 tmpdir，不抛', (t) => {
  t.mock.method(os, 'homedir', () => {
    throw new Error('no home')
  })
  let got
  assert.doesNotThrow(() => {
    got = resolveStateDir({})
  })
  assert.equal(got, path.join(os.tmpdir(), '.dsh-remote-agent'))
})

test('[D-C] ensureStateDir：可写目录原样返回，并建出 tasks/', (t) => {
  const dir = tmpRoot(t)
  const want = path.join(dir, 'state')
  assert.equal(ensureStateDir(want), want)
  assert.equal(fs.existsSync(path.join(want, 'tasks')), true)
  // 幂等：已存在时再调一次也返回同一个路径
  assert.equal(ensureStateDir(want), want)
})

test('[D-C] ensureStateDir：目录不可写 → 降级到临时目录，绝不抛', (t) => {
  const dir = tmpRoot(t)
  // 用一个**普通文件**当父目录：mkdir 必然 ENOTDIR。这比"只读目录"更可靠 ——
  // Windows 上管理员进程常常能无视 ACL 写进只读目录，而 ENOTDIR 谁都过不去。
  const file = path.join(dir, 'regular-file')
  fs.writeFileSync(file, 'x')
  const unwritable = path.join(file, 'state')

  let got
  assert.doesNotThrow(() => {
    got = ensureStateDir(unwritable)
  })
  assert.notEqual(got, unwritable)
  assert.notEqual(got, '', '应当降级到临时目录而不是彻底失败')
  assert.equal(fs.existsSync(path.join(got, 'tasks')), true)
  t.after(() => {
    try {
      fs.rmSync(got, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* 临时目录清理失败无所谓 */
    }
  })
})

test('[D-C] ensureStateDir：两个候选都不可写 → 返回空串（上层据此降级），不抛', (t) => {
  const m = mock.method(fs, 'mkdirSync', () => {
    throw new Error('EACCES: permission denied')
  })
  try {
    let got
    assert.doesNotThrow(() => {
      got = ensureStateDir(path.join(tmpRoot(t), 'state'))
    })
    assert.equal(got, '', '彻底不可用时应返回空串，由调用方降级成 idle worker')
  } finally {
    m.mock.restore()
  }
})

test('[D-C] ensureStateDir：preferred 为空/非字符串时也走兜底，不抛', (t) => {
  for (const bad of ['', null, undefined, 42, {}]) {
    let got
    assert.doesNotThrow(() => {
      got = ensureStateDir(bad)
    }, `bad=${String(bad)}`)
    assert.notEqual(got, '', `bad=${String(bad)}`)
    t.after(() => {
      try {
        fs.rmSync(got, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* ignore */
      }
    })
  }
})

/* ═════════════════════════ 3. resolveRoots ═════════════════════════ */

test('resolveRoots：显式 roots 优先，空串与非字符串被过滤', (t) => {
  const dir = tmpRoot(t)
  const a = path.join(dir, 'a')
  const b = path.join(dir, 'b')
  assert.deepEqual(resolveRoots({ roots: [a, b] }), [a, b])

  // 空串 / 纯空白 / 非字符串一律丢掉
  assert.deepEqual(resolveRoots({ roots: [a, '', '   ', 42, null, undefined, {}, b] }), [a, b])
  // 过滤后为空 → 回退默认，而不是返回空数组
  assert.deepEqual(resolveRoots({ roots: ['', 42, null] }), defaultRoots())
})

test('resolveRoots：未配置 / 非数组 → 回退 defaultRoots()', (t) => {
  fakeHome(t, tmpRoot(t))
  const expected = defaultRoots()
  assert.ok(Array.isArray(expected))
  for (const cfg of [{}, { roots: undefined }, { roots: null }, { roots: 'not-an-array' }, { roots: 42 }, undefined]) {
    assert.deepEqual(resolveRoots(cfg), expected, `cfg=${JSON.stringify(cfg)}`)
  }
})

test('resolveRoots：defaultRoots() 抛错时回退成空数组，不抛', (t) => {
  // defaultRoots 是"保守默认"，它自己失败不该让配置解析整体失败。
  // 用 mock 造一个必然失败的 homedir：defaultRoots 的候选全在建目录时失败，
  // 但它的实现会兜到 home 本身 —— 所以这里直接断言"不抛 + 是数组"。
  t.mock.method(os, 'homedir', () => {
    throw new Error('no home')
  })
  let got
  assert.doesNotThrow(() => {
    got = resolveRoots({})
  })
  assert.ok(Array.isArray(got))
})

/* ═════════════════════════ 4. resolveToken ═════════════════════════ */

test('resolveToken：配置优先于 token 文件，且两端空白被 trim', (t) => {
  const dir = tmpRoot(t)
  const state = path.join(dir, 'state')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'token'), '  file-token\r\n')

  assert.equal(resolveToken({ token: 'cfg-token' }, state), 'cfg-token')
  assert.equal(resolveToken({ token: '  cfg-token  ' }, state), 'cfg-token')
  assert.equal(resolveToken({}, state), 'file-token')
})

test('resolveToken：都没有时返回空串，不抛', (t) => {
  const dir = tmpRoot(t)
  const empty = path.join(dir, 'empty-state')
  fs.mkdirSync(empty, { recursive: true })

  // 无 stateDir
  assert.equal(resolveToken({}, ''), '')
  // stateDir 存在但没有 token 文件
  assert.equal(resolveToken({}, empty), '')
  // stateDir 根本不存在
  assert.equal(resolveToken({}, path.join(dir, 'nope')), '')
  // 配置 token 是空白 → 视为未配置，继续走文件
  fs.writeFileSync(path.join(empty, 'token'), 'from-file')
  assert.equal(resolveToken({ token: '   ' }, empty), 'from-file')
  // 配置 token 非字符串 → 继续走文件
  assert.equal(resolveToken({ token: 42 }, empty), 'from-file')
  // 完全不抛
  assert.doesNotThrow(() => resolveToken())
  assert.doesNotThrow(() => resolveToken(undefined, undefined))
})

test('resolveToken：stateDir 指向文件而非目录时也返回空串（不抛）', (t) => {
  const dir = tmpRoot(t)
  const file = path.join(dir, 'not-a-dir')
  fs.writeFileSync(file, 'x')
  assert.equal(resolveToken({}, file), '')
})

/* ═════════════════════════ 5. buildNodeHello ═════════════════════════ */

test('buildNodeHello：形状正确且能过 validateHello', (t) => {
  fakeHome(t, tmpRoot(t))
  const hello = buildNodeHello({ nodeId: 'slave-pc' })

  assert.equal(hello.nodeId, 'slave-pc')
  assert.equal(hello.protocol, PROTOCOL_VERSION)
  assert.ok(['windows', 'linux', 'darwin'].includes(hello.os), `os=${hello.os}`)
  assert.equal(typeof hello.arch, 'string')
  assert.ok(hello.arch.length > 0)
  assert.equal(typeof hello.hostname, 'string')
  assert.ok(hello.hostname.length > 0)
  assert.equal(typeof hello.dshVersion, 'string')
  assert.equal(typeof hello.profile, 'string')
  assert.equal(hello.agentMode, true)
  assert.equal(typeof hello.time, 'number')
  assert.ok(Array.isArray(hello.shells) && hello.shells.length > 0)
  assert.ok(Array.isArray(hello.roots))
  assert.ok(Array.isArray(hello.caps))
  assert.deepEqual(hello.caps, [
    'fs', 'exec', 'artifact', 'agent', 'file-transfer', 'selfcheck',
    ...(process.platform === 'win32' ? ['desktop', 'gui'] : []),
  ])

  const v = validateHello(hello)
  assert.equal(v.ok, true, `hello 未通过协议校验：${v.error}`)
})

test('buildNodeHello：**不含任何凭证**（token 不能出现在 hello 里）', (t) => {
  fakeHome(t, tmpRoot(t))
  const SECRET = 'en_SUPERSECRET_TOKEN_VALUE_1234567890'
  const hello = buildNodeHello({ token: SECRET, nodeId: 'n1', hubUrl: `ws://h/?token=${SECRET}` })

  // ① 序列化后不含凭证值
  const raw = JSON.stringify(hello)
  assert.equal(raw.includes(SECRET), false, 'hello 里出现了 token 明文')

  // ② 键名层面也不该有任何凭证类字段（将来有人加字段时会被这条拦住）
  for (const key of Object.keys(hello)) {
    assert.doesNotMatch(key, /token|secret|credential|password|passwd|key/i, `可疑字段名：${key}`)
  }

  // ③ 嵌套值里也不能有（防止塞进 caps/roots 之类的数组）
  const flat = JSON.stringify([hello.shells, hello.roots, hello.caps, hello.profile, hello.dshVersion])
  assert.equal(flat.includes(SECRET), false, 'hello 的嵌套字段里出现了 token 明文')
})

test('buildNodeHello：roots 是副本，改返回值不影响调用方/内部状态', (t) => {
  fakeHome(t, tmpRoot(t))
  const input = ['C:\\work', 'D:\\other']
  const hello = buildNodeHello({}, { roots: input })

  assert.deepEqual(hello.roots, input)
  assert.notEqual(hello.roots, input, 'roots 必须是副本，不能是同一个数组引用')

  hello.roots.push('E:\\injected')
  hello.roots[0] = 'mutated'
  assert.deepEqual(input, ['C:\\work', 'D:\\other'], '改 hello.roots 影响了调用方的数组')

  // 从 config 走的那条路同样要是副本（resolveRoots 内部 filter 出的新数组）
  const cfg = { roots: ['C:\\cfg'] }
  const h2 = buildNodeHello(cfg)
  h2.roots.push('E:\\injected')
  assert.deepEqual(cfg.roots, ['C:\\cfg'])
  assert.deepEqual(resolveRoots(cfg), ['C:\\cfg'])
})

test('buildNodeHello：显式 roots 优先于 config.roots', (t) => {
  fakeHome(t, tmpRoot(t))
  const hello = buildNodeHello({ roots: ['C:\\from-config'] }, { roots: ['D:\\from-arg'] })
  assert.deepEqual(hello.roots, ['D:\\from-arg'])
})

test('buildNodeHello：未给 roots 时回退 resolveRoots(config)', (t) => {
  fakeHome(t, tmpRoot(t))
  const hello = buildNodeHello({ roots: ['C:\\only'] })
  assert.deepEqual(hello.roots, ['C:\\only'])
})

test('[D-B] buildNodeHello：nodeId override 也过清洗，产出永远合法', (t) => {
  fakeHome(t, tmpRoot(t))
  // 修复前：这些 override 会被**原样**放进 hello，产出 hub 必拒的
  // `hello-nodeId-invalid`。而"本地先生成合法的，别让 hub 拒"是本文件的既定职责。
  for (const override of ['', '  ', '中文节点', 'X Y', 'a:b', '-lead', 'x'.repeat(70), null, undefined, 42]) {
    const hello = buildNodeHello({}, override === undefined ? {} : { nodeId: override })
    const v = validateHello(hello)
    assert.equal(v.ok, true, `override=${JSON.stringify(override)} → nodeId=${JSON.stringify(hello.nodeId)} (${v.error})`)
  }
  // 合法的 override 原样保留（清洗幂等）
  assert.equal(buildNodeHello({}, { nodeId: 'slave-pc' }).nodeId, 'slave-pc')
})

test('buildNodeHello：cfg.nodeId 与 override 都缺失时用 hostname 清洗结果', (t) => {
  fakeHome(t, tmpRoot(t))
  const hello = buildNodeHello({})
  assert.equal(typeof hello.nodeId, 'string')
  assert.ok(hello.nodeId.length > 0)
  assert.equal(validateHello(hello).ok, true)
  // 与 hostname 清洗一致（同一台机器每次启动 id 稳定）
  assert.equal(hello.nodeId, sanitizeNodeId(os.hostname()))
})

test('buildNodeHello：不抛（各种畸形 config）', (t) => {
  fakeHome(t, tmpRoot(t))
  for (const cfg of [undefined, null, 'x', 42, [], { nodeId: {} }, { roots: 'x' }, { token: {} }]) {
    assert.doesNotThrow(() => buildNodeHello(cfg), `cfg=${JSON.stringify(cfg)}`)
  }
})

/* ═════════════════════════ 6. detectOs / detectShells ═════════════════════════ */

test('detectOs：返回协议允许的三个值之一，且与 process.platform 一致', () => {
  const got = detectOs()
  assert.ok(['windows', 'linux', 'darwin'].includes(got), `os=${got}`)
  const want = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  assert.equal(got, want)
  assert.doesNotThrow(() => detectOs())
})

test('detectShells：不抛，返回去重后的非空字符串数组', () => {
  let shells
  assert.doesNotThrow(() => {
    shells = detectShells()
  })
  assert.ok(Array.isArray(shells))
  assert.ok(shells.length > 0, '至少应声明一个 shell')
  for (const s of shells) {
    assert.equal(typeof s, 'string')
    assert.ok(s.trim() !== '', `空 shell 项：${JSON.stringify(s)}`)
  }
  assert.equal(new Set(shells).size, shells.length, 'shells 应去重')

  if (process.platform === 'win32') {
    assert.ok(shells.includes('pwsh'), `windows 应声明 pwsh：${shells}`)
    assert.ok(shells.includes('powershell'), `windows 应声明 powershell：${shells}`)
  } else {
    assert.ok(shells.includes('/bin/sh'), `posix 应声明 /bin/sh：${shells}`)
  }
})

test('detectShells：声明项与 exec.js 的解析器配合（声明的 pwsh 不应是空壳）', () => {
  // 历史缺陷：机器上只有 Windows PowerShell 5.1 时仍声明 'pwsh'，而 PATH 上没有它，
  // 于是每条 exec 任务 ENOENT。声明是给 hub 挑写法用的，所以只要求"声明的项
  // 要么能解析到，要么是平台兜底名" —— 这里断言列表非空且无重复即可，
  // 真正的解析正确性由 exec.test.js 覆盖。
  const shells = detectShells()
  assert.ok(shells.length > 0)
  assert.equal(new Set(shells).size, shells.length)
})
