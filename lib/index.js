/**
 * dsh-remote-agent 插件入口：角色分发器。
 *
 * 一个包，两种角色，因为协议层、glob、产物判定这些地基是共用的：
 *
 *   role: 'hub'    主电脑 —— 节点注册表 + remote_* 工具 + subagent provider
 *   role: 'worker' 副机   —— 拨入 hub、本地跑任务、按需外发产物
 *   role: 'both'   同机自测（一台机器同时当 hub 与 worker）
 *
 * **为什么这里刻意不写 `export const inject`**：
 * 声明式 inject 是模块级的，一旦声明了 `['webServer','tools','systemPrompt']`，
 * 那么在没有 webServer 的副机 profile 里整个插件都不会激活 —— worker 分支会被
 * hub 的依赖一起拖死。所以 hub 侧改用作用域注入 `ctx.inject([...], cb)`：
 * 缺服务时 hub 分支自然不激活，worker 分支照常跑。这也是 E3 契约要求的形态。
 *
 * worker 分支走动态 import：hub 进程不需要加载副机的任务引擎、进程管理、
 * 文件遍历那一整套代码；副机进程也不需要在内存里挂着 hub 的注册表。
 */
// schemastery 由 dsh 运行时提供。**必须顶层 import**，且必须在 package.json 里
// 声明为 peerDependency，否则 loader 判定该行没有 Config（实测报 `status: absent`）。
// 这与 dsh-better-sidebar 等已发布插件一致，是唯一被验证可用的形态。
import z from '@deepseek-ai/schemastery'
import { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH } from './hub/index.js'
import { registerSetupRoutes } from './setup-routes.js'
// 配置分层（2026-10-18）：DSH 的插件管理器会重写 cordis.patch.yml、冲掉手工写的
// 段（实测把我们的 role + webserver 整段删掉）。所以真正的配置另存一份在
// <stateDir>/instance.json，加载时覆盖回来。见 lib/instance-config.js 头注释。
import { mergeInstanceConfig } from './instance-config.js'

/** 角色取值。 */
export const ROLE = Object.freeze({ HUB: 'hub', WORKER: 'worker', BOTH: 'both', AUTO: 'auto' })

/**
 * 解析本机角色。
 *
 * 为什么需要归一化 + 明确告警（t3 审计查出的真实风险）：
 * 原实现只做精确匹配，其余一律 `return ROLE.HUB`。于是 `role: 'Worker'`（大小写）、
 * `'hub '`（尾空格）、`42`、`true` 全都**静默**变成 hub —— 而副机 profile 写错一个
 * 字母的后果很严重：那台机器会以 **hub 身份**启动，注册 `/api/remote-agent/node`
 * 直连端点与 healthz，而 hub 的 `nodeToken` 默认为空串 → **该端点不校验任何凭证**。
 * 用户以为自己配的是"副机"，实际开了个无鉴权的直连入口。
 *
 * 修法：先归一化（trim + 小写）以容忍常见笔误，再对**无法识别**的值返回 hub 但
 * 附带 `invalid` 标记，由 apply() 记 warn —— 配置写错必须有反馈，不能静默。
 *
 * ── 2026-10-15 二次修订：未配置 ≠ hub ──────────────────────────────────────
 *
 * 原实现把 `''` / `undefined` 也当成 hub。这导致**首次安装的体验是错的**：
 *
 *   · 副机装完 → `role` 走默认值 hub → 面板认为自己是主机 → 全 404，
 *     而且**不会显示任何引导**（它以为自己配好了）
 *   · 用户必须去手工改 YAML 才能变成 worker —— 而改的时候还要同时改
 *     `inject`（hub 要 webServer/tools/systemPrompt，worker 不该要），
 *     两个字段联动，极易配错
 *
 * 改成"**未配置就是未配置**"：
 *   · `''` / `undefined` / `null` → `{ role: '', unconfigured: true }`
 *   · apply() 见到 unconfigured **什么都不注册**（不 hub、不 worker）
 *   · 面板两个端点都失败 → 显示引导 UI，让用户选
 *
 * 顺带这比原实现**更安全**：原实现下"配置写错"会静默变成 hub（注册一个
 * nodeToken 为空、不校验凭证的直连端点）；现在写错只是"未配置"，不开任何入口。
 *
 * @returns {{role:string, invalid?:string, unconfigured?:true}}
 *   role 为 hub/worker/both，或 `''`（未配置）；invalid 为原始非法值
 */
export function resolveRoleDetail(config) {
  const raw = config && typeof config === 'object' ? config.role : undefined
  if (raw === undefined || raw === null || raw === '') return { role: '', unconfigured: true }
  if (typeof raw === 'string') {
    const norm = raw.trim().toLowerCase()
    if (norm === ROLE.HUB || norm === ROLE.WORKER || norm === ROLE.BOTH) return { role: norm }
    // ── auto：按配置推断（2026-10-17，"开箱即用"的落点）──────────────
    //
    // 判据只有一条，但它是**副机与主机最本质的区别**：
    //   · 配了 `hubUrl` = 这台机器要去连别人 = **副机**
    //   · 没配 hubUrl = 这台机器不需要连别人 = **主机**
    //
    // 为什么这条判据可靠：
    //   · hubUrl 是副机独有的字段，hub 侧根本不读它（hub 是监听方）
    //   · 用户配 hubUrl 的唯一目的就是"连主机"
    //   · 配对码展开后必然产出 hubUrl（见 lib/pairing.js），所以"贴了配对码"
    //     就等于"有 hubUrl"
    //
    // 这样主机装完零操作（默认 hub），副机贴完配对码也零操作（自动 worker）。
    // 比"两台都要点一下"更接近开箱即用，又不像"写死 hub"那样给副机开一个
    // 不该开的无鉴权端点。
    if (norm === 'auto' || norm === ROLE.AUTO) {
      const hubUrl = typeof config.hubUrl === 'string' ? config.hubUrl.trim() : ''
      if (hubUrl !== '') return { role: ROLE.WORKER, inferred: 'hubUrl' }
      return { role: ROLE.HUB, inferred: 'no-hubUrl' }
    }
  }
  // 无法识别：**不再回退 hub**（那会静默开一个无鉴权入口）。
  // 当成"未配置"，由面板引导用户重新选。
  return { role: '', invalid: raw, unconfigured: true }
}

/** 兼容旧签名：只返回角色字符串。 */
export function resolveRole(config) {
  return resolveRoleDetail(config).role
}

function loggerOf(ctx) {
  return (level, msg, extra) => {
    try {
      const l = ctx?.logger
      if (l && typeof l[level] === 'function') l[level](`[remote-agent] ${msg}`, extra)
      else if (l && typeof l.info === 'function') l.info(`[remote-agent] ${msg}`, extra)
      else if (level === 'warn' || level === 'error') console.warn(`[remote-agent] ${msg}`, extra ?? '')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

/** 动态加载副机实现并调用 applyWorker。 */
async function applyWorkerBranch(ctx, config, log) {
  let mod
  try {
    mod = await import('./node/index.js')
  } catch (err) {
    log('error', 'worker 分支加载失败：lib/node/index.js 不可用', {
      error: String(err?.message ?? err),
    })
    return undefined
  }
  const fn = typeof mod?.applyWorker === 'function' ? mod.applyWorker : typeof mod?.apply === 'function' ? mod.apply : undefined
  if (typeof fn !== 'function') {
    log('error', 'worker 分支加载失败：lib/node/index.js 未导出 applyWorker')
    return undefined
  }
  try {
    return fn(ctx, config)
  } catch (err) {
    log('error', 'worker 分支挂载失败', { error: String(err?.message ?? err) })
    return undefined
  }
}

/**
 * 每个"注册宿主"上当前这一代的清理函数。
 *
 * 键选 **`ctx.webServer` 服务实例**，不是 `ctx`：
 * 撞车的是**宿主的路由表**（`webServer.upgrades` 这张 Map）。同一个 ctx 当然
 * 共用同一张表，但 DSH 热重载时也可能给每代一个新的子 ctx —— 那时按 ctx 记
 * 就会漏掉，照样撞车。按服务实例记才对应"真正会冲突的那个东西"。
 *
 * 读不到 `ctx.webServer`（副机 profile 的 `inject: []` 一读就抛）时退回 ctx，
 * 这条兜底只是让字典有键，不影响正确性。
 *
 * 用 WeakMap：既不阻止 GC，也不会把多个 profile / 多个 host 实例串在一起。
 */
const GENERATIONS = new WeakMap()

/** 取"注册宿主"作为字典键。读服务可能抛（无 inject），所以必须 try。 */
function generationKey(ctx) {
  try {
    const ws = ctx && ctx.webServer
    return ws !== undefined && ws !== null ? ws : ctx
  } catch {
    return ctx
  }
}

/**
 * DSH 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] 行配置（profiles/*.cordis.yml 里的 config）
 */
export function apply(ctx, config = {}) {
  // ── 配置分层合并（2026-10-18，解决"配置被 DSH 重写冲掉"）──────────────
  //
  // 实测事故：用户在 DSH 里卸载重装插件后，`cordis.patch.yml` 从 3962B/15 条
  // 被重写成 696B/4 条 —— **我们的 role 与 webserver 段整段消失**。DSH 的插件
  // 管理器改依赖时会重写那个文件，只保留它自己管理的条目。
  //
  // 结果就是"每次设置完重启又回引导页"：写进去的 role 被外力冲掉，重启后
  // 只剩包内默认（role: auto）。
  //
  // 所以配置分两层：
  //   1. `cordis.patch.yml` 的 `- id: remote-agent` —— 只负责让 loader 加载
  //   2. `<stateDir>/instance.json` —— 存真正的配置，**DSH 冲不掉**
  //
  // 这里把第 2 层合并进来，且**独立配置优先**（那是用户明确设置过的值）。
  // 读失败/损坏时安静退回 loader config（配置读不出来不该让 DSH 起不来）。
  const merged = mergeInstanceConfig(config)
  if (merged.source) {
    config = merged.config
  }

  const { role, invalid, unconfigured } = resolveRoleDetail(config)
  const log = loggerOf(ctx)

  // M3（2026-10-20）：独立配置优先，会**压住** loader（patch/插件 UI）里的同名字段。
  // 这是设计（它才抗得住 DSH 重写），但必须留痕 —— 否则用户"改了 patch 没生效"
  // 时完全无从判断。只记字段名，不记值（token 等敏感字段不能进日志）。
  if (Array.isArray(merged.shadowed) && merged.shadowed.length > 0) {
    log('info', 'instance.json overrides loader config (patch edits ignored for these keys)', {
      keys: merged.shadowed,
      fix: '要让 patch 生效，请删掉 instance.json 里对应的键（或用面板改）',
    })
  }

  // 配置写错必须有反馈。注意**不再回退 hub** —— 那会静默开一个
  // nodeToken 为空、不校验凭证的直连端点（见 resolveRoleDetail 的说明）。
  // 现在当成"未配置"处理：什么都不注册，面板显示引导让用户重选。
  if (invalid !== undefined) {
    log('warn', 'unrecognized role: treating as unconfigured (not falling back to hub)', {
      got: invalid,
      expected: [ROLE.HUB, ROLE.WORKER, ROLE.BOTH],
    })
  }
  const handles = { role, hub: undefined, worker: undefined, unconfigured: unconfigured === true }

  // ══════════════════════════════════════════════════════════════════════════
  // 可重入：同一个 ctx 上只允许存在**一代**注册（0.9.5 修 duplicate 激活失败）
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 0.9.4 装上后 DSH 报：
  //
  //     webserver: duplicate upgrade route "/api/remote-agent/node"
  //     1 entry did not activate remote-agent (dsh-remote-agent)
  //
  // 根因不是"注册了两次"写错，而是**我们的注册不可回收**：
  //
  //   · DSH 的 `webServer.registerUpgrade(path)` 是**按 path 查表**的，
  //     同路径第二次注册直接抛（这是它的组合级契约，合理）：
  //       if (this.upgrades.has(route.path)) throw new Error('webserver: duplicate upgrade route ...')
  //   · 我们的注册全部收集在 `__disposers` 里、由 `applyHub()` 的返回值
  //     `disposeAll` 交给调用方保管 —— 但 **DSH 不认识这个返回值**，
  //     热重载/安装后 reload 时它只会重新 `apply`，不会回头调我们的 disposer。
  //   · 于是第二代在第一代的残留上注册 → 撞车 → 整个 entry 激活失败。
  //
  // 为什么以前没暴露：只有"同一个 ctx 上重新 apply"才触发。DSH 在
  // 插件安装/升级后会热重载，这正是用户装 0.9.4 时踩到的那一步。
  //
  // 修法：**不指望宿主帮我们清理**。按 ctx 记住上一代的 dispose，重新
  // apply 时先自己摘干净再装。这样无论宿主是否调用 disposer，都不会重复注册。
  const genKey = generationKey(ctx)
  const prevDispose = GENERATIONS.get(genKey)
  if (typeof prevDispose === 'function') {
    try {
      prevDispose()
      log('info', 're-apply on the same host: previous generation disposed first')
    } catch (err) {
      log('warn', 'previous generation dispose failed (continuing)', {
        error: String(err?.message ?? err),
      })
    }
  }

  let released = false
  const dispose = () => {
    if (released) return
    released = true
    // 只摘自己：新一代可能已经顶替了这一格，别把它的注册也拆了
    if (GENERATIONS.get(genKey) === dispose) GENERATIONS.delete(genKey)
    // 顺序：hub 的路由/监听 → setup 路由 → worker 拨号。
    // 每一步独立兜底：一个失败不能让后面的漏摘（否则又变成"摘一半"）。
    try { handles.hub?.disposeAll?.() } catch (err) {
      log('warn', 'hub dispose failed', { error: String(err?.message ?? err) })
    }
    if (Array.isArray(handles.setup)) {
      for (const d of handles.setup) {
        try { if (typeof d === 'function') d() } catch { /* 已摘 */ }
      }
    }
    try { if (typeof handles.worker === 'function') handles.worker() } catch { /* 已摘 */ }
  }
  GENERATIONS.set(genKey, dispose)
  handles.dispose = dispose

  // ── 未配置：什么都不注册 ────────────────────────────────────────────────
  //
  // 为什么要有这个分支：首次安装时**插件无法知道这台机器是主机还是副机** ——
  // 只有用户知道。而包内 `cordis.patch.yml` 必须有某个默认值，无论选哪个都会
  // 让一半的装机场景是错的（原实现默认 hub：副机装完会以 hub 身份启动）。
  //
  // 所以默认值改成空，并在这里"什么都不做"：
  //   · 不注册 hub 路由/工具（不开任何入口）
  //   · 不启动 worker 拨入
  //   · 面板两个端点都失败 → 显示引导 UI → 用户选 → 写入配置 → 重启
  //
  // 这也顺带修了一个安全问题：原实现下"role 写错"会静默变成 hub，
  // 而 hub 的 nodeToken 默认为空 → 该直连端点不校验任何凭证。
  //
  // ⚠ 但**不能真的什么都不注册** —— 那样面板两个端点都失败，用户只看到
  // 两个错误，拿不到引导。所以这里注册**一组最小引导路由**（只有 setup
  // 相关的两三个），由它们承载引导 UI 的数据源。
  //
  // ── 2026-10-15 二次修订：引导路由**始终注册**（不只未配置时）──────────
  //
  // 原先只在 unconfigured 时注册，结果是：**已配置的机器无法通过面板改角色** ——
  // 用户想从 hub 改成 worker（或反过来）只能去命令行或手改 YAML，而手改时
  // 还要同时改 `inject`（两个字段联动，极易配错 —— 我们踩过）。
  //
  // 所以改成**无条件注册**：
  //   · `/setup/state` 在已配置时返回 `configured: true` + 当前值
  //   · `/setup/apply` 在已配置时**覆盖**（writePatchBlock 本就是 upsert）
  //   · 成本极低（两个路由，只用 webServer），收益是"任何状态下都能改角色"
  //
  // 注册时机：**先于** hub/worker 分支，这样即使后面某步抛错，改角色的
  // 入口仍然可用（它是配置层面的逃生舱）。
  handles.setup = registerSetupRoutes(ctx, config, log)

  if (unconfigured === true) {
    log('info', 'remote-agent is not configured yet: only setup routes are active')
    return handles
  }

  if (role === ROLE.HUB || role === ROLE.BOTH) {
    // ═══════════════════════════════════════════════════════════════════════
    // 服务可见性：靠 loader 行上的**声明式 inject**（见 cordis.patch.yml）
    // ═══════════════════════════════════════════════════════════════════════
    //
    // cordis 的防护：没有声明 inject 就直接读 `ctx.webServer` 会抛
    // `cannot get property "webServer" without inject`（实测）。
    //
    // 而"运行时 ctx.inject(deps, cb)"这条路走不通（实测，2026-10-14）：
    //   - inject 返回 thenable fiber，要 await 才算"加载完成"
    //   - 插件的 apply 是同步的，父 fiber 同步返回后框架清理未 settle 的子 fiber
    //   - 诊断：注册成功 13ms 后 `DISPOSED (fiber unloaded)`，路由被删且不再回来
    //   - `ctx.plugin({inject, apply})` 更糟：子插件的 apply 根本没被调用
    //
    // 所以 inject 声明在**行上**（cordis.patch.yml 的 `inject: [...]`）：框架推迟
    // 本行激活直到服务就绪，只 apply 一次、无子 fiber 抖动。这是唯一可用的形态。
    //
    // 副机（worker）不需要这些服务，必须在自己的 profile 里覆盖 `inject: []`，
    // 否则该行永远 PENDING。见 profiles/worker.cordis.yml。
    handles.hub = applyHub(ctx, config)
  }

  if (role === ROLE.WORKER || role === ROLE.BOTH) {
    // 动态 import 是异步的；不 await —— apply 本身是同步契约。
    // 失败已在 applyWorkerBranch 内部记日志，不让 host 因副机缺件而起不来。
    void applyWorkerBranch(ctx, config, log).then((h) => {
      // 竞态：这一代已经被 dispose（热重载/卸载）了，把刚挂上的 worker 立刻摘掉。
      // 否则它会留在后台继续拨号 —— 一份回收不掉的僵尸连接。
      if (released) {
        try { if (typeof h === 'function') h() } catch { /* 已摘 */ }
        return
      }
      handles.worker = h
    })
  }

  return handles
}

export const Config = z.object({
  role: z
    // ⚠ 默认 `'auto'`：**按配置推断角色**，而不是写死一个（2026-10-17）。
    //
    // ── 为什么不是写死 hub ──────────────────────────────────────────────
    //
    // v0.7.0 之前默认 hub，问题是：**副机装完会以 hub 身份启动** —— 注册一个
    // nodeToken 为空、不校验凭证的直连端点。这在安全上是实打实的漏洞面。
    //
    // ── 为什么不是写死 ''（未配置）──────────────────────────────────────
    //
    // v0.7.0~0.8.1 默认 `''`，问题是：**两台机器都要操作一次**，而"开箱即用"
    // 的目标是主机装完零操作。而且升级时包内默认容易把 profile 里没显式写的
    // role 冲成空（实测踩过）。
    //
    // ── auto 的判据（见 resolveRoleDetail）─────────────────────────────
    //
    //   1. 用户显式写了 hub/worker/both  → 用它（最高优先，永不猜错）
    //   2. 配了 `hubUrl`（副机的特征）    → worker
    //   3. 都没配                        → hub（默认主机）
    //
    // 这样：
    //   · 主机装完 → 没 hubUrl → 自动 hub → **零操作** ✅
    //   · 副机填完配对码 → 有 hubUrl → 自动 worker → **零操作** ✅
    //   · 副机还没填 → 暂时 hub，但面板立刻显示"填配对码成为副机"
    //
    // 空字符串仍是**合法值**，表示"用户主动清空了，需要引导"。
    .union([
      z.const('hub'),
      z.const('worker'),
      z.const('both'),
      z.const('auto'),
      z.const(''),
    ])
    .default('auto')
    .description(
      '本机角色：auto=自动推断（默认：配了 hubUrl 就是副机，否则是主机）；'
      + 'hub=主机（派活方）；worker=副机（干活方）；both=同一台机器自测；'
      + '留空=未配置（打开 Web 面板会显示引导，让你选）',
    ),

  // ── 副机（worker）专用 ────────────────────────────────────────
  nodeId: z
    .string()
    .default('')
    .description('副机唯一标识（留空则取主机名）。只能含字母数字 . _ -，以字母或数字开头。'),
  transportMode: z
    .union([z.const('direct'), z.const('relay')])
    .default('relay')
    .description('direct=副机主动连主机（主机地址需可达）；relay=经中继 VPS 会合（双方都在 NAT 后时用）。'),
  hubUrl: z
    .string()
    .default('')
    .description('direct 模式：主机地址，形如 ws://主机IP:19387/api/remote-agent/node。'),
  relayUrl: z
    .string()
      .default('')
      .description('relay 模式：中继地址，形如 ws://中继IP:8890/relay。'),
    roots: z.array(z.string())
      .default([])
      .description('副机允许任务操作的工作区根目录（绝对路径，必须真实存在）。留空退回保守默认。'),
    stateDir: z.string()
      .default('')
      .description('副机任务状态落盘目录（留空用 ~/.dsh-remote-agent）。任务状态真身在这里。'),

    // ── 主机（hub）专用 ──────────────────────────────────────────
    relay: z.object({
      url: z.string().default('').description('中继地址，留空表示不用中继。'),
      token: z.string().default('').description('中继的 hub token（rt_ 开头那一半）。'),
    })
      .default({ url: '', token: '' })
      .description('主机经中继接入时的地址与凭证。'),
    nodeToken: z.string()
      .default('')
      .description('direct 模式下校验副机的共享口令。留空=不校验（仅限可信内网；公网暴露时必须填）。'),
    uiPullRoot: z.string()
      .default('')
      .description('Web 面板拉取产物时唯一允许落地的目录（绝对路径）。留空则面板拉取按钮禁用。'),

    // ── 独立监听（2026-10-18 引入，2026-10-20 补进 schema）───────────────
    //
    // ⚠ 这两个字段 0.9.3 就已在用，但**没有在这里声明** —— 靠 schemastery 的
    // passthrough 才勉强能读到。后果：插件配置页里根本没有这两项（无表单）、
    // 没有类型校验（`listenPort: "19387"` 会静默回弹默认值）、也无法在 UI 上改。
    // 现在正式声明：能配、能校验、能在面板/插件页里看到。
    listenHost: z.string()
      .default('')
      .description('独立监听绑定的具体本机 IP（留空=自动选：Tailscale > 私网 > 回环）。'
        + '不能填 0.0.0.0 —— 通配地址会把服务暴露到所有网卡，且新版 DSH 同规则拒绝。'),
    // 取值范围由 normalizeConfig 归一（0 <= port < 65536），这里只声明类型与默认值。
    listenPort: z.number()
      .default(19387)
      .description('独立监听端口（副机从这里拨入）。0 = 关闭独立监听，只走 DSH 自己的 Web 服务通道。'),

    uiEnabled: z.boolean()
      .default(true)
      .description('是否注册 Web 面板的控制路由。'),
    sessionGate: z.boolean()
      .default(false)
      .description('开启后每个会话须先输入 /remote-agent on，才能调用 remote_* 工具；重启或新会话默认关闭。'),
})

// ⚠ 这里刻意**不写** `export default apply`。
//
// cordis loader 用 `unwrapExports()` 解析模块：
//     exports = exports.default ?? exports
// 也就是说，只要模块有 default 导出，它就会**把整个命名空间替换成那个 default**。
// 我们的 default 是 `apply` 函数，于是 loader 拿到的是函数、而不是命名空间 ——
// 函数上没有 `Config`，判定链直接落到 `status: 'absent'`，插件页因此不出现配置表单。
// （对照：dsh-better-sidebar 等有 schema 的插件都没有 default 导出。）
//
// 保持只用具名导出（apply + Config + 若干常量），命名空间完整，Config 才能被读到。
// `apply` 已由上面的 `export function apply` 具名导出，这里不重复列出。
export { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH }
