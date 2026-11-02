/**
 * 文档 vs 实现 字段级比对（可复用收尾检查）。
 *
 * 由来：t12 期间出现过两次「文档写完后实现又改了」造成的漂移（t9 改了
 * ui-routes.js 的 pullRoot 语义与新增 guard 围栏，而文档没跟上）。手工比对
 * 每次都要重新读一遍代码，容易漏。这个脚本把比对固化成 13 项断言，
 * 任何改了 client.js / ui-routes.js 的改动落地后都能一键重跑。
 *
 * 用法：
 *   node scripts/check-doc-drift.mjs          # 只报告
 *   node scripts/check-doc-drift.mjs --json   # 机器可读
 *
 * 退出码：0 = 无漂移；1 = 有漂移（打印逐项结果）。
 *
 * 注意：它比对的是**关键契约**（字段名、默认值、路由、错误码），
 * 不是文档措辞。措辞差异不报，只有"文档说的与实现不符"才报。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const uiRoutes = read('lib/hub/ui-routes.js')
// views.js 是投影共享层（工具路径与 UI 路径共用一份白名单）。
// handoffView/changedView/taskView 等在它里面，不在 ui-routes.js。
const views = read('lib/hub/views.js')
const hubTools = read('lib/hub/tools.js')
const hubIndex = read('lib/hub/index.js')
const client = read('lib/client.js')
const readme = read('profiles/README.md')
const known = read('KNOWN-ISSUES.md')
const pkg = JSON.parse(read('package.json'))

const results = []
const check = (id, label, ok, detail) => results.push({ id, label, ok: Boolean(ok), detail })

/**
 * 取一个具名函数的完整函数体（花括号匹配）。
 *
 * 为什么不能用固定长度窗口：早先断言 15b 用 `slice(idx, idx + 900)`，
 * 而 `handoffView` 函数体有 2260 字符 —— 窗口只覆盖 40%，函数尾部的
 * 注入会被漏掉（假阴性）。固定窗口对"函数体长度会随改动变化"这件事
 * 天然脆弱，必须按花括号配对取完整体。
 */
function bodyOf(src, fnName) {
  const start = src.indexOf(`function ${fnName}`)
  if (start === -1) return ''
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/**
 * 剥掉块注释与行注释，只留代码。
 *
 * 为什么需要：t9 在注释里写了反例说明「为什么不能 `{ handoff: t.handoff }` 直接回」。
 * 不剥注释时，这句反例会被"裸直出"断言当成真代码命中 —— 造成**假阳性**
 * （干净代码报告漂移）。假阳性比漏报更糟：它会让人开始无视这个脚本。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/* ── 1. /overview 字段 + capabilities 三项 ── */
check('1', '/overview 返回 nodes/counts/capabilities',
  /nodes,/.test(uiRoutes) && /counts:/.test(uiRoutes) && /capabilities:/.test(uiRoutes),
  'ui-routes.js overview handler')
check('2', 'capabilities 含 pull/pullRoot/dispatch 三项',
  /pull:\s*typeof pullRoot/.test(uiRoutes) && /pullRoot:/.test(uiRoutes) && /dispatch:\s*true/.test(uiRoutes),
  'ui-routes.js capabilities')

/* ── 3. pullRoot 未配置回 null（配置层是空串） ── */
check('3', 'API 层 pullRoot 未配置回 null',
  /pullRoot:\s*typeof pullRoot === 'string' && pullRoot !== '' \? pullRoot : null/.test(uiRoutes),
  'ui-routes.js:412 附近')
check('4', '配置层 uiPullRoot 默认空串',
  /uiPullRoot:\s*typeof c\.uiPullRoot === 'string' && c\.uiPullRoot !== '' \? c\.uiPullRoot : ''/.test(hubIndex),
  'hub/index.js:47 附近')
check('5', '文档说明了两层空值差异（配置层 \'\' vs API 层 null）',
  /空值|空串|null/.test(readme) && /uiPullRoot/.test(readme),
  'profiles/README.md 配置节')

/* ── 6. 7 条路由路径 ── */
const UI_PREFIX = '/api/remote-agent/ui'
for (const seg of ['overview', 'nodes', 'tasks', 'task', 'dispatch', 'cancel', 'pull', 'config']) {
  check(`6.${seg}`, `路由 ${UI_PREFIX}/${seg} 已注册`,
    uiRoutes.includes(`\${UI_API_PREFIX}/${seg}`) || uiRoutes.includes(`${UI_PREFIX}/${seg}`),
    'ui-routes.js route 注册')
}
check('7', 'UI_API_PREFIX 常量值正确', uiRoutes.includes(`'${UI_PREFIX}'`), 'ui-routes.js:23 附近')

// /config 是只读的配置视图。断言两条不变量：
//   ① 凭证只以 `*Set` 布尔形式出现（绝不能有明文 token 回给浏览器）
//   ② 客户端读的字段名与 Host 返回的一致（不一致会让面板显示空白但不报错）
check('7a', '/config 只回凭证的 set 布尔，不回明文',
  /nodeTokenSet:/.test(uiRoutes) && /relayTokenSet:/.test(uiRoutes) && !/nodeToken:\s*typeof config\.nodeToken/.test(uiRoutes),
  'ui-routes.js configView')
check('7b', 'client 读 nodeTokenSet（与 Host 字段对齐）',
  /cfg\.nodeTokenSet/.test(client), 'client.js 设置区')

/* ── 8. 方法约束 ── */
check('8', 'GET 路由拒绝非 GET', /method !== 'GET'/.test(uiRoutes), 'ui-routes.js 各 GET route')
check('9', 'POST 路由拒绝非 POST', /method !== 'POST'/.test(uiRoutes), 'ui-routes.js 各 POST route')

/* ── 10. 错误码 ── */
for (const [code, where] of [
  ['pull-disabled', '未配置 uiPullRoot 时 pull 拒绝'],
  ['dest-outside-pull-root', 'dest 越界'],
  ['pull-root-unusable', 'pullRoot 不可用'],
  ['goal-required', 'dispatch 缺 goal'],
  ['node-unknown', 'dispatch 未知节点'],
  ['taskId-and-paths-required', 'pull 缺参数'],
]) {
  check(`10.${code}`, `错误码 ${code}（${where}）`, uiRoutes.includes(`'${code}'`) || uiRoutes.includes(`"${code}"`), 'ui-routes.js')
}

/* ── 11. 请求围栏（t9 新增，t12 曾漏写文档） ── */
check('11', '存在请求围栏 makeGuard',
  /makeGuard/.test(uiRoutes) && /requestRejection/.test(uiRoutes),
  'ui-routes.js guard')
// 围栏必须**真的失败关闭**，不只是"文件里出现过 403 这个词"。
// 早先用 `/403/.test(uiRoutes) && /requestRejection/.test(uiRoutes)` —— 那只是
// "两个词存在即通过"。实测把 catch 里的 `rejection = 403` 改成 `undefined`
// （安全语义反转成"失败放行"）仍然通过 = 假阴性。文件里有 7 处 403、2 处
// `rejection = 403`，所以必须**锚定 catch 分支那一处**。
check('12', '围栏失败关闭（不静默放行）',
  /failing closed[\s\S]{0,200}?\n\s*rejection = 403\b/.test(uiRoutes)
  // 调用点：必须「guard 为假即返回」，但**允许中间夹诊断日志**。
  // 早先写成 `if \(!guard\(req, res, pathname\)\) return` 的单行精确匹配 ——
  // 后来给拒绝路径加了一行 log（`if (...) { log(...); return }`），语义没变
  // （仍是失败关闭）却让断言变红。断言该锚定**语义**而非字面形态：
  // 现在要求「guard 之后、handler 调用之前必须出现 return」，
  // 即无论中间夹什么，拒绝路径都不得继续执行 handler。
  && (() => {
    const i = uiRoutes.indexOf('if (!guard(req, res, pathname))')
    if (i < 0) return false
    const rest = uiRoutes.slice(i, i + 400)
    const retIdx = rest.indexOf('return')
    const handlerIdx = rest.indexOf('await handler(req, res)')
    return retIdx > 0 && (handlerIdx < 0 || retIdx < handlerIdx)
  })(),
  'ui-routes.js guard catch 分支（行首赋值）+ 调用点（失败即 return，允许夹日志）')
check('13', '文档提到路由自带同源/鉴权围栏',
  /围栏/.test(readme),
  'profiles/README.md 第 4 节')

/* ── 14. handoff 投影 ──
 *
 * ⚠ 投影函数已从 ui-routes.js 提取到 lib/hub/views.js（共享层，见该文件说明）。
 * 断言相应改为读 views，并**新增两条**：投影必须真的被两条消费路径调用 ——
 * 这正是重构前漏掉的那半条加固（remote_handoff 曾裸直出 t.handoff）。
 */
check('14', 'handoffView 定义在共享层 views.js',
  /export function handoffView/.test(views),
  'lib/hub/views.js')
check('14b', 'UI 路径调用 handoffView',
  /handoff:\s*handoffView\(/.test(uiRoutes),
  'ui-routes.js 调用点')
// 关键回归：工具路径也必须走投影。
// 工具返回值会进入会话日志，被后续每个请求带上 —— 比 UI 那条路径更该加固。
// 逐个站点检查，而不是「文件里出现过一次 handoffView」——
// 0.10.0 新增 remote_agents 后 tools.js 有两处 handoff 出口，
// 「存在即通过」会让注入回裸直出的自检静默失效（doc-drift-selfcheck 实测抓到）。
//
// 这里不能复用 stripComments：它按 /\/\*[\s\S]*?\*\// 一刀切，
// 而 tools.js 的注释里就有 `/* */` 字面量，会把大段真代码一起吃掉，
// 于是被注入的裸直出落进被吃掉的区域 → 永远看不见。
// 改为逐行剔除注释行（`//`、`*`、`/*` 开头），保留所有代码行。
const hubToolsCode = hubTools
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')
const handoffSites = [...hubToolsCode.matchAll(/handoff:\s*([^,\n}]*)/g)]
  .map((m) => m[1].trim())
  // 只挑返回值站点；`handoff: { type: 'object' }` 这类工具 schema 声明不是出口。
  .filter((site) => site !== '' && !site.startsWith('{'))
check('14c', '工具路径（remote_handoff / remote_agents）每个 handoff 出口都走 handoffView',
  handoffSites.length > 0 && handoffSites.every((site) => site.startsWith('handoffView(')),
  `lib/hub/tools.js 的 ${handoffSites.length} 处 handoff 出口`)
// 同理：registry.taskView（remote_status 用它）必须走共享投影，
// 不能逐字段裸拷贝副机上报的 exit/changed/summary/error。
check('14d', 'registry.taskView 走共享投影（remote_status 不裸拷贝）',
  /taskProjection\(/.test(read('lib/hub/node-registry.js')),
  'lib/hub/node-registry.js')

// 直出形态是代码里的 `handoff: t.handoff`，不是注释里的反例说明。
// 两处踩过的坑：(a) `\b` 在 `)` 前也成立，把 `handoff: handoffView(t.handoff)`
// 误判为直出；(b) 不剥注释时，t9 写的「为什么不能 `{ handoff: t.handoff }` 直接回」
// 这句注释会被当成真代码。所以先剥注释，再匹配。
const uiRoutesCode = stripComments(uiRoutes)
check('15', 'handoff 无裸直出（handoff: t.handoff）',
  !/handoff:\s*t\.handoff\s*[,}]/.test(uiRoutesCode),
  'ui-routes.js 代码区（已剥注释）')
check('15b', 'handoffView 移除了 logs 与 workspace 键',
  (() => {
    // 用花括号匹配取完整函数体，且**两个键都要查**。
    // 早先的写法有两个问题：(a) 900 字符固定窗口只覆盖函数体 40%；
    // (b) 标签说查 logs 与 workspace，正则却只查了 logs。
    const body = bodyOf(views, 'handoffView')
    return body !== '' && !/^\s*logs:/m.test(body) && !/^\s*workspace:/m.test(body)
  })(),
  'lib/hub/views.js handoffView 函数体（花括号匹配，查 logs 与 workspace）')

/* ── 15c. 已清理的冗余监听器不得被补回来 ──
 *
 * KNOWN-ISSUES 第 2 节记录过：hub 的 attachDirect 曾有一层 `conn.socket.on('end')`
 * 兜底，在冻结层（ws.js）修好硬 FIN 处理之后变成冗余，唯一副作用是对端干净 FIN 时
 * 'node socket closed' 日志打两条。清理已完成。
 *
 * 为什么要断言：这段兜底**看起来像是必要的防御**，后来者很容易"好心"补回来。
 * 而它的旧注释（"只监听 close 会让死节点永远在线"）在冻结层修好后已经不成立，
 * 属误导性注释。这条断言保证：要么代码里没有它，要么文档必须同步说明为什么有。
 */
// P1-4：attachDirect 已随接入/握手段拆到 registry-handshake.js，负向锚点跟着走
const registrySrc = read('lib/hub/registry-handshake.js')
const registryCode = stripComments(registrySrc)
// ⚠ 正则形态踩过坑：第一版写 `conn\.socket\??\.on\??\(`，而 `\??` 是贪婪的 ——
// 它会把 `socket?.on?.('end'` 里的 `?` 吃掉，剩下的 `?.on` 无法匹配紧跟的 `\.on`，
// 于是**只认得 `conn.socket.on('end')` 这种不带可选链的写法**，对真实代码
// （`conn.socket?.on?.('end'`）反而漏报。实测：注入回旧实现后断言仍报 OK —— 守了个空。
// 现在改成「conn.socket 到 ('end' 之间只允许可选链符号与空白」，覆盖所有写法。
const SOCKET_END_RE = /conn\.socket[^;\n]{0,24}\(\s*['"`]end['"`]/
check('15c', 'hub 不再补 socket "end" 兜底（冻结层已统一处理）',
  !SOCKET_END_RE.test(registryCode),
  'lib/hub/registry-handshake.js attachDirect（已剥注释）')
check('15d', 'KNOWN-ISSUES 第 2 节标记为已清理（与实现同步）',
  /##\s*2\.[^\n]*已清理/.test(known),
  'KNOWN-ISSUES.md 第 2 节标题')
// 第 6 节记录测试方法论（等价性判定 / 假绿 / 还原比注入危险 / Windows 编码坑）。
// 它是写给后续维护者的经验，删掉不会让任何测试变红 —— 所以在这里钉住。
check('15e', 'KNOWN-ISSUES 第 6 节记录测试方法论',
  /##\s*6\.[^\n]*测试方法论/.test(known) && /与原实现等价/.test(known) && /U\+FFFD/.test(known),
  'KNOWN-ISSUES.md 第 6 节')
// 第 7 节记录加固轮审计的剩余盲区（真机未覆盖的分支 / 设计取舍 / 自我纠正）。
// 它同样是"删掉不会让测试变红"的经验文档，需要显式守卫。
check('15f', 'KNOWN-ISSUES 第 7 节记录审计结论',
  /##\s*7\.[^\n]*审计结论/.test(known) && /pwsh/.test(known) && /RELAY_QUEUE_BUDGET/.test(known),
  'KNOWN-ISSUES.md 第 7 节')
// 6.3b：变异脚本被 kill 时「还原」步骤一并被跳过 —— 这是真实事故（整个仓库被改坏，
// 且导致 captain 拿坏状态去质疑他人交付物）。它比 6.3 更硬，必须钉住。
check('15g', 'KNOWN-ISSUES 6.3b 记录「kill 致还原被跳过」+ 结构性防御',
  /###\s*6\.3b/.test(known) && /try\/finally/.test(known) && /ALLOW_MUTATE_WORKTREE/.test(known),
  'KNOWN-ISSUES.md 第 6.3b 节')

/* ── 16. client.js 契约 ── */check('16', 'PANEL_KEY 是单符号常量', /PANEL_KEY\s*=\s*'dsh-remote-agent'/.test(client), 'client.js')
check('17', 'sidebar.panellist 用 id: PANEL_KEY', /id:\s*PANEL_KEY/.test(client), 'client.js')
check('18', 'main 用 key: PANEL_KEY', /key:\s*PANEL_KEY/.test(client), 'client.js')
check('19', 'client 侧 API 前缀与 Host 一致',
  client.includes(`'${UI_PREFIX}'`), 'client.js var API')
check('20', '轮询间隔 4 秒（文档已声明）',
  /setInterval\(load,\s*4000\)/.test(client) && /4\s*秒/.test(readme),
  'client.js + README')
check('21', '主题 token 带兜底 currentColor（t11 误报后的加固）',
  /state-idle-primary,currentColor/.test(client), 'client.js')

/* ── 22. 配置字段存在且文档覆盖 ── */
check('22', 'uiEnabled 配置存在且默认 true',
  /uiEnabled:\s*c\.uiEnabled !== false/.test(hubIndex), 'hub/index.js:46 附近')
check('23', '文档提到 uiEnabled 与 uiPullRoot',
  /uiEnabled/.test(readme) && /uiPullRoot/.test(readme), 'profiles/README.md')

/* ── 24. package.json 的 client 声明 ── */
check('24', 'dsh.client.platform 为 web',
  pkg.dsh?.client?.platform === 'web', 'package.json')
check('25', 'exports["./client"] 指向 lib/client.js',
  pkg.exports?.['./client'] === './lib/client.js', 'package.json')
check('26', 'KNOWN-ISSUES 记录了 combo 路由与 404 正常性',
  /combo/.test(known) && /404/.test(known), 'KNOWN-ISSUES.md 第 4 节')

/* ── 27. 文档声明的 DSH 版本 ──
 *
 * 这个版本号**必须**与实际验证过的 DSH 一致 —— 早先这里写的是 "44.0.0"，
 * 而实测环境是 0.2.0-rc.2。断言当时也跟着写错，等于没防。
 * 现在锚定到真实版本；升 DSH 时两边一起改。
 */
check('27', 'KNOWN-ISSUES 声明了验证的 DSH 版本（0.2.0-rc.2）',
  /0\.2\.0-rc\.2/.test(known), 'KNOWN-ISSUES.md')

/* ── 28. 长期维护项目的基本设施 ──
 *
 * 这些文件不参与运行，但缺了会让项目难以被他人接手。
 * 断言存在性即可 —— 内容质量靠人工评审，没法自动判断。
 */
const MAINT_FILES = [
  ['CHANGELOG.md', '记录每个修复的根因，0.x 期间升级前必读'],
  ['CONTRIBUTING.md', '贡献指南（含会静默失败的陷阱）'],
  ['SECURITY.md', '安全策略与部署检查清单'],
  ['.editorconfig', '统一编辑器行为（行尾/编码/缩进）'],
  ['.github/workflows/ci.yml', 'CI：打包自洽 + 文档漂移 + 测试'],
  ['.github/PULL_REQUEST_TEMPLATE.md', 'PR 模板'],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', 'Bug 报告模板'],
  ['.github/ISSUE_TEMPLATE/feature_request.yml', '功能请求模板'],
]
for (const [i, [file, why]] of MAINT_FILES.entries()) {
  check(`28.${i + 1}`, `维护设施存在：${file}`,
    fs.existsSync(path.join(ROOT, file)), why)
}

/* ── 29~31. 副机配置必须写明 inject: [] ──
 *
 * 部署必读：包内 patch 给 remote-agent 行声明了
 * inject: ['webServer','tools','systemPrompt']（hub 需要），而副机没有这些服务。
 * 不清空的话该行永远停在 PENDING、永不激活 —— 副机永远不拨入，
 * 且没有任何报错（实测踩到）。
 */
{
  const workerProfile = read('profiles/worker.cordis.yml')
  const rootReadme = read('README.md')
  check('29', 'profiles/worker.cordis.yml 里有 inject: []',
    /^\s*inject:\s*\[\]\s*$/m.test(workerProfile),
    'profiles/worker.cordis.yml（副机不清空 inject 会永远 PENDING）')
  // 2026-10-17 改：原断言锁的是 `inject: []`（README 教用户写这个）——
  // **那是错的**：副机 agent 的 ctx 继承插件的依赖声明，`inject: []` 会让
  // agent 没有任何 shell/文件工具，任务"跑完了但什么都没干"（实测踩过）。
  // 正确写法是 worker 三件套。断言跟着改，否则文档会退回错误建议。
  check('30', 'README 说明了副机 inject 的正确写法（tools/agentLoop/sessions，不是 []）',
    /inject:\s*\[[^\]]*agentLoop[^\]]*\]/.test(rootReadme)
    && /agentLoop/.test(rootReadme)
    && /没有[^\n]*工具|无[^\n]*工具/.test(rootReadme),
    'README.md（副机配置一节：inject 三件套 + 缺了会怎样的说明）')
  check('31', '包内 cordis.patch.yml 声明了 hub 需要的 inject',
    /inject:\s*\[[^\]]*webServer[^\]]*\]/.test(read('cordis.patch.yml')),
    'cordis.patch.yml')
}

/* ── 32~35. 工具返回值收口层 ──
 *
 * DSH 对工具返回值有两条独立校验（序列化 + schema），两条失败都会让
 * 「已成功的调用」报失败 —— 有副作用却报失败，是最坏的失败形态。
 * 收口层在 reg() 里，必须同时应用 dropNullForSchema 与 toPlainJson，且顺序固定。
 */
{
  const t = read('lib/hub/tools.js')
  check('32', 'tools.js 定义了 dropNullForSchema',
    /function dropNullForSchema/.test(t), 'lib/hub/tools.js')
  check('33', 'tools.js 定义了 toPlainJson',
    /function toPlainJson/.test(t), 'lib/hub/tools.js')
  check('34', 'reg() 里两者都应用且顺序正确（dropNull 在内层）',
    (() => {
      const i = t.indexOf('const reg = (definition) => {')
      if (i < 0) return false
      // 边界用花括号配对 —— 不能用 `\n  }`，reg 内部有更深缩进的 `}` 会截断 body。
      let depth = 0
      let end = -1
      for (let k = t.indexOf('{', i); k < t.length; k += 1) {
        if (t[k] === '{') depth += 1
        else if (t[k] === '}') {
          depth -= 1
          if (depth === 0) { end = k + 1; break }
        }
      }
      if (end < 0) return false
      const body = t.slice(i, end)
      // ⚠ 顺序检查不能比较字符串位置：源码里写的是
      //     return toPlainJson(dropNullForSchema(value, schema))
      // `toPlainJson(` 在**源码位置上更靠前**，但执行顺序是**从内到外** ——
      // 先 dropNullForSchema，再 toPlainJson。所以必须断言**嵌套关系**。
      // （第一版用了 indexOf 比较位置，恒为 false，是假断言。）
      return /toPlainJson\(\s*dropNullForSchema\(value,\s*schema\)\s*\)/.test(body)
    })(),
    'lib/hub/tools.js 的 reg()（dropNullForSchema 必须在 toPlainJson 内层）')
  check('35', '有工具返回值出边界的回归测试',
    fs.existsSync(path.join(ROOT, 'test', 'tool-output-plain.test.js')),
    'test/tool-output-plain.test.js')
}

/* ── 41~44. 任务视图累积的自锁（2026-10-15 实测踩到）──
 *
 * 连续派几十条任务后节点彻底不可用（`already holds 64 tasks`），
 * 连"派一条清理命令"都做不到 —— 自锁，只能人工去副机删文件。
 *
 * 两个根因都在代码里，必须钉住：
 *   1. 上限按历史累计算（`rec.tasks.size` 含终态）
 *   2. 视图只增不减（没有主动清理，也没有手动入口）
 */
{
  const registry = read('lib/hub/node-registry.js')
  // P1-4：applySync 已随帧摄入段拆到 registry-ingest.js，锚点跟着走
  const registryIngest = read('lib/hub/registry-ingest.js')
  const hubToolsSrc = read('lib/hub/tools.js')
  const uiRoutesSrc = read('lib/hub/ui-routes.js')
  const clientSrc = read('lib/client.js')
  const hubIdx = read('lib/hub/index.js')

  // ⚠ 断言必须锚定"按非终态过滤"这个语义 —— 而不是"文件里没有 rec.tasks.size"。
  // 后者太弱：只要注释里提一句就失效。这里查真正的判断表达式。
  check('41', 'createTask 的上限按非终态任务数算（不按历史累计）',
    /TERMINAL_STATUS\.has\(/.test(registry)
    && /activeCount/.test(registry)
    && /active tasks/.test(registry),
    'lib/hub/node-registry.js 的 createTask（曾经按 rec.tasks.size 算，导致自锁）')

  check('42', 'applySync 会主动清理超过保留期的终态视图',
    /taskViewRetainMs/.test(registryIngest) && /taskViewRetainMs/.test(hubIdx),
    'lib/hub/registry-ingest.js 的 applySync + lib/hub/index.js 的 limits 默认值')

  check('43', '提供了立即清理的入口（工具 + UI 路由 + 面板按钮）',
    /name:\s*'remote_purge'/.test(hubToolsSrc)
    && /UI_API_PREFIX\}\/purge/.test(uiRoutesSrc)
    && /apiPost\('\/purge'/.test(clientSrc),
    'remote_purge 工具 / /purge 路由 / 面板「清理」按钮 —— 三者缺一，死局就没有出口')

  check('44', 'purgeTasks 只清 hub 视图，不给副机发帧',
    (() => {
      const i = registry.indexOf('purgeTasks(')
      if (i < 0) return false
      const seg = registry.slice(i, i + 2500)
      // 剥注释：注释里解释了"不碰副机"，不剥会误判
      const code = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      return !/this\.send\(/.test(code)
    })(),
    'lib/hub/node-registry.js 的 purgeTasks（副机是任务状态的权威，不能替它删）')
}

/* ── 36~40. 小白向导（lib/setup.js + bin/dsh-remote-setup.js） ──
 *
 * 向导的存在意义是"小白不看细节也能配好"，所以它的关键承诺必须钉住：
 *   - README 有五分钟上手入口（否则向导等于不存在）
 *   - 生成器替用户填好 inject: []（部署失败头号坑）
 *   - doctor 每条失败检查都带修法（只报问题不给修法等于没查）
 *   - worker 的连接错误有"人话翻译"（小白看到 ECONNREFUSED 会直接放弃）
 *   - package.json 声明了 bin 入口（否则 npm 包里找不到命令）
 */
{
  const rootReadme = read('README.md')
  const setupLib = read('lib/setup.js')
  const nodeIndex = read('lib/node/index.js')
  check('36', 'README 有「五分钟上手」且提到向导与 --doctor',
    /五分钟上手/.test(rootReadme) && /--doctor/.test(rootReadme) && /dsh-remote-setup/.test(rootReadme),
    'README.md 五分钟上手一节')
  check('37', 'package.json 声明了 dsh-remote-setup 的 bin 入口且文件存在',
    // ⚠ 路径写法：**规范形态是不带 `./` 前缀**。
    //
    // npm 对 `bin` 里的 `./bin/x.js` 会给出警告并在发布时**自动移除前缀**：
    //   npm warn publish "bin[dsh-remote-setup]" script name bin/dsh-remote-setup.js
    //                      was invalid and removed
    // 那条 warn 的措辞容易误读成"这条 bin 被删了"，实际是"前缀被修正了" ——
    // 但它说明**写 `./` 是非规范形态**，应当避免。
    //
    // 这条断言原本写死 `'./bin/dsh-remote-setup.js'`，等于在保护一个
    // npm 会改写掉的写法。现在接受规范形态（无前缀），并容忍带前缀的历史
    // 配置 —— `npm pkg fix` 会把带前缀的改成规范形态。
    (() => {
      const v = pkg.bin?.['dsh-remote-setup']
      if (typeof v !== 'string') return false
      return v.replace(/^\.\//, '') === 'bin/dsh-remote-setup.js'
        && fs.existsSync(path.join(ROOT, 'bin', 'dsh-remote-setup.js'))
    })(),
    'package.json bin（规范形态：不带 ./ 前缀）+ bin/dsh-remote-setup.js')
  check('38', '生成器替用户填好 inject: []（worker 片段必须自带）',
    /inject:\s*\[\]/.test(setupLib),
    'lib/setup.js buildWorkerYaml')
  check('39', 'doctor 检查结果带修法（chk 的 fix 字段被 renderDoctor 输出）',
    /怎么修/.test(setupLib) && /fix: ok \? '' : fix/.test(setupLib),
    'lib/setup.js chk/renderDoctor')
  check('40', 'worker 连接错误走 friendlyConnectError 人话翻译',
    /friendlyConnectError/.test(nodeIndex),
    'lib/node/index.js error 监听')
  check('41', 'README 工具表声明了 model 参数',
    /model/.test(rootReadme) && /normalizeModelSelection/.test(read('lib/protocol.js')),
    'README.md remote_task 参数表 + lib/protocol.js')
}

/* ── 42~44. 配对码（lib/pairing.js） ──
 *
 * 配对码的核心承诺必须钉住：
 *   - README 有用法入口（否则这个功能等于不存在）
 *   - worker 启动路径真的展开 pair（只在 lib/pairing.js 里定义而没接线 = 假功能）
 *   - 向导真的生成配对码（encodePairCode 必须被 bin 引用）
 *   - "显式配置优先" 与 "roots 不进配对码" 两条安全语义要在文档里说清
 */
{
  const pairing = read('lib/pairing.js')
  const nodeIndex = read('lib/node/index.js')
  const setupBin = read('bin/dsh-remote-setup.js')
  const rootReadme = read('README.md')
  check('42', 'README 说明了配对码（dshra1://）与显式配置优先/roots 不进码的安全语义',
    /dshra1:\/\//.test(rootReadme) && /显式配置优先/.test(rootReadme) && /roots.*不在配对码|roots 不在配对码/.test(rootReadme),
    'README.md 副机配置一节')
  check('43', 'worker 启动路径真的展开 pair（expandPairConfig 被接线）',
    /expandPairConfig/.test(nodeIndex) && /export function expandPairConfig/.test(pairing),
    'lib/node/index.js startWorker + lib/pairing.js')
  check('44', '向导生成/解析配对码（encodePairCode 与 decodePairCode 均被 bin 引用）',
    /encodePairCode/.test(setupBin) && /decodePairCode/.test(setupBin),
    'bin/dsh-remote-setup.js')
  check('44b', '配对码解析失败永不抛（结构化 error，worker 只降级）',
    /export function decodePairCode/.test(pairing) && /return \{ ok: false, error/.test(pairing),
    'lib/pairing.js decodePairCode')
}

/* ── 45~47. 面板 GUI 化（pair-info + dispatch 模型输入） ──
 *
 * 零终端小白的图形入口承诺必须钉住：
 *   - /pair-info 路由存在且 token 披露边界（loopback-only 全码）不被"好心"放宽
 *   - 面板真的有"副机接入"入口与 pair 复制按钮（API 存在而面板没接 = 假功能）
 *   - dispatch 表单的模型输入真的进请求体
 */
{
  const panelClient = read('lib/client.js')
  const rootReadme = read('README.md')
  check('45', '/pair-info 路由存在，token 披露仅限回环（策略不被放宽）',
    /pair-info/.test(uiRoutes) && /loopback/.test(uiRoutes) && /remoteAddress/.test(uiRoutes),
    'lib/hub/ui-routes.js pair-info（loopback 判定 + remoteAddress 读取）')
  check('46', '面板有副机接入入口与 pair 复制按钮（GUI 落点真实存在）',
    /副机接入/.test(panelClient) && /复制 pair 配置行/.test(panelClient) && /loadPair/.test(panelClient),
    'lib/client.js 副机接入卡片')
  check('47', 'dispatch 表单的模型输入进请求体，README 说明面板两条入口',
    /model:\s*fv\.model/.test(panelClient) && /副机接入/.test(rootReadme) && /模型/.test(rootReadme),
    'lib/client.js dispatch + README.md')
}

/* ── 48. Windows 双击入口 ──
 *
 * 零终端用户的第一道墙是"开终端"。启动器文件有**三条**硬规矩：
 *   内容必须 ASCII（cmd.exe 按 OEM 码页解析批处理，非 ASCII 必乱码），
 *   行尾必须 CRLF（LF-only 的批处理有解析边缘案例），
 *   **文件名也必须 ASCII**（见下）。
 *
 * ── 文件名为什么也必须 ASCII（2026-10-16 实测翻车）──────────────────────
 *
 * 这条断言原本的注释写的是"文件名可以是中文（NTFS 是 Unicode）"。
 * **在本地是对的，发布出去是错的。** 0.4.0 的 npm tarball 里实际躺着：
 *
 *     package/bin/˫������-������.cmd
 *
 * 原名 `双击运行-配置向导.cmd`（8 个中文字符）。npm 打成 **tar 归档**，
 * tar 层的文件名编码不可靠 —— NTFS 的 Unicode 文件名在这里丢了，
 * 解压出来是乱码。Windows 用户看到的就是一个打不开的怪文件，
 * 双击入口等于不存在。
 *
 * 所以现在改名 `setup.cmd`，并且这条断言用**字节级**检查两件事：
 * 文件名全 ASCII、文件内容全 ASCII + CRLF。
 */
{
  const cmdName = 'setup.cmd'
  const cmdPath = path.join(ROOT, 'bin', cmdName)
  const ok48 = (() => {
    if (!fs.existsSync(cmdPath)) return false
    if (!/^[\x20-\x7E]+$/.test(cmdName)) return false // 文件名 ASCII（tar 安全）
    const buf = fs.readFileSync(cmdPath)
    if (buf.some((b) => b > 127)) return false // 内容 ASCII
    if (!buf.includes(Buffer.from('@echo off\r\n'))) return false // CRLF
    return buf.includes(Buffer.from('dsh-remote-setup.js')) // 确实启动向导
  })()
  check('48', 'Windows 双击入口存在且**文件名与内容**都 ASCII/CRLF，README 有双击路径',
    ok48 && /双击/.test(read('README.md')) && read('README.md').includes(cmdName),
    `bin/${cmdName} + README.md`)
}

/* ── 49. 真实运行时自检工具与 KNOWN-ISSUES 验证记录 ──
 *
 * 打活 hub 的自检脚本（独立 OS 进程 worker → 真实 DSH 桌面 hub）是
 * "发布前跑一遍"的入口，必须存在；KNOWN-ISSUES 第 8 节记录实测边界
 * （哪些验了/哪些要人肉/哪些要两台真机），删了会让"待实机确认"的
 * 状态重新变成没人说得清的黑箱。
 */
check('49', '真实运行时自检脚本存在，KNOWN-ISSUES 第 8 节记录验证边界',
  fs.existsSync(path.join(ROOT, 'scripts', 'e2e-live-check.mjs'))
  && /e2e-live-check/.test(known) && /##\s*8\./.test(known),
  'scripts/e2e-live-check.mjs + KNOWN-ISSUES.md 第 8 节')

/* ── 50~56. relay 跨 NAT 降级链与 VPS 部署模板（2026-10-15 P1-6） ──
 *
 * 对标竞品四级降级链的"最小可感知版本"：三条接入路径被组织成一条
 * 条件式降级链（direct → 中继 VPS / cloudflared → 本地续跑），
 * 并给出可直接抄的 VPS 部署模板（deploy/relay-vps/）。
 *
 * 为什么钉这条：降级链是**文档形态的承诺**，删了不会有任何测试变红，
 * 但"链路断了怎么办"恰恰是新用户最易感知的功能性差距。模板文件同理 ——
 * 少了 unit/env/TLS 任何一个，公网中继就只剩"明文 ws:// 裸奔"一条路。
 */
{
  const profilesReadme = read('profiles/README.md')
  const rootReadme = read('README.md')
  const security = read('SECURITY.md')
  const unit = read('deploy/relay-vps/dsh-remote-relay.service')
  const envTpl = read('deploy/relay-vps/relay.env.example')
  const caddy = read('deploy/relay-vps/Caddyfile')
  const nginx = read('deploy/relay-vps/nginx.conf')

  check('50', 'deploy/relay-vps/ 模板五件套齐全',
    fs.existsSync(path.join(ROOT, 'deploy/relay-vps/README.md'))
    && unit.length > 0 && envTpl.length > 0 && caddy.length > 0 && nginx.length > 0,
    'deploy/relay-vps/{README.md,dsh-remote-relay.service,relay.env.example,Caddyfile,nginx.conf}')

  check('51', 'profiles/README.md 有降级链一节（含降级判据表）',
    /降级链/.test(profilesReadme) && /该降级了的判据/.test(profilesReadme)
    && /最深的降级/.test(profilesReadme),
    'profiles/README.md「怎么选路径：降级链」')

  check('52', 'profiles/README.md 路径一要求公网套 TLS 并指向 deploy 模板',
    /wss:\/\//.test(profilesReadme) && /deploy\/relay-vps\//.test(profilesReadme)
    && /必须套 TLS|部署在 TLS 之后/.test(profilesReadme),
    'profiles/README.md 路径一 TLS 小节')

  check('53', 'unit 模板保留加固段，env 模板声明 0600 与占位符',
    /NoNewPrivileges=true/.test(unit) && /ProtectSystem=strict/.test(unit)
    && /ReadWritePaths=/.test(unit)
    && /0600/.test(envTpl) && /REPLACE_WITH_GENERATED/.test(envTpl),
    'deploy/relay-vps/dsh-remote-relay.service + relay.env.example')

  check('54', 'nginx 模板含 WebSocket 三件套（缺一不可）',
    /proxy_http_version 1\.1;/.test(nginx)
    && /proxy_set_header Upgrade \$http_upgrade;/.test(nginx)
    && /proxy_set_header Connection "upgrade";/.test(nginx),
    'deploy/relay-vps/nginx.conf')

  check('55', 'SECURITY.md 传输加密表指向 deploy 模板，威胁模型声明中继可见明文帧',
    /deploy\/relay-vps\//.test(security) && /端到端加密/.test(security)
    && /中继挂了任务照跑|task\/sync/.test(security),
    'SECURITY.md 传输加密表 + 威胁模型')

  check('56', 'README 接入路径段提降级链，package.json files 带上 deploy',
    /降级链/.test(rootReadme) && /deploy\/relay-vps\//.test(rootReadme)
    && pkg.files?.includes('deploy'),
    'README.md 接入路径段 + package.json files')

  // 派发自动化评估（P1-7）：决策记录是"删了不会有测试变红"的知识，
  // 与 KNOWN-ISSUES 各节同规格钉住。三个锚点对应三个结论：
  // 设计使然（B）/ 预设计未实施（A2）/ 明确拒绝（A1）。
  // 存在性守卫：文档被删时报 DRIFT 而不是让 read() 抛栈 ——
  // 自检用例「删文档必须被检出」依赖这个形态（与 28.x 同风格）。
  const automationEvalPath = path.join(ROOT, 'docs/dispatch-automation-eval.md')
  const automationEval = fs.existsSync(automationEvalPath)
    ? read('docs/dispatch-automation-eval.md')
    : ''
  check('57', '派发自动化评估文档存在且三个结论锚点齐全',
    automationEval !== ''
    && /设计使然/.test(automationEval) && /预设计/.test(automationEval)
    && /明确拒绝/.test(automationEval) && /pair-info/.test(automationEval),
    'docs/dispatch-automation-eval.md（B/A2/A1 三结论 + scope 不含 pair-info）')
  check('58', 'KNOWN-ISSUES §8 第 3 条链接到评估文档',
    /dispatch-automation-eval\.md/.test(known) && /整台 401/.test(known),
    'KNOWN-ISSUES.md §8 第 3 条')

  // ── P2-11：hub 身份认证（指纹钉住 / TOFU / relay 宽限窗口）──────────
  // 文档承诺的验证链与三态语义必须与代码实际存在的锚点一一对应：
  // 文档侧（59-61、64）钉 SECURITY/profiles/README/CHANGELOG，
  // 代码侧（62-63）钉 hub 与副机两条接线的核心函数名。
  const p2Transport = read('lib/node/transport.js')
  const p2HubPin = read('lib/node/hub-pin.js')
  const p2Identity = read('lib/identity.js')
  const p2Changelog = read('CHANGELOG.md')
  const p2Pairing = read('lib/pairing.js')
  // P1-4：sendIdentityFrame/buildIdentityPayload 已拆到 registry-handshake.js
  const p2Registry = read('lib/hub/registry-handshake.js')
  const p2HubIdx = read('lib/hub/index.js')
  const p2NodeIdx = read('lib/node/index.js')
  const p2SetupBin = read('bin/dsh-remote-setup.js')
  const p2Profiles = read('profiles/README.md')

  check('59', 'SECURITY.md：威胁模型有副机验 hub 行，检查清单第 7 条覆盖 TOFU/宽限/剩余边界',
    /副机能识别/.test(security) && /pinnedHubFingerprint/.test(security)
    && /hub-identity\.json/.test(security) && /hub-pin\.json/.test(security)
    && /TOFU/.test(security) && /hub-identity-pending/.test(security)
    && /宽限/.test(security) && /剩余边界/.test(security),
    'SECURITY.md 检查清单第 7 条 + 威胁模型表')

  check('60', 'profiles/README.md：有 hub 身份认证一节 + 排障表两行',
    /hubFingerprint/.test(p2Profiles) && /hub-pin\.json/.test(p2Profiles)
    && /重新钉住/.test(p2Profiles) && /hub-identity-pending/.test(p2Profiles)
    && /SECURITY\.md/.test(p2Profiles),
    'profiles/README.md 第 7 节 + 排障速查')

  check('61', 'README worker 配置段说明 hub 身份认证与 pinnedHubFingerprint',
    /pinnedHubFingerprint/.test(rootReadme) && /hub-pin\.json/.test(rootReadme)
    && /TOFU/.test(rootReadme),
    'README.md 副机配置段')

  check('62', '代码锚点（hub 侧）：身份加载 / welcome 带 identity / relay 追发 / 配对码带指纹都在',
    /loadOrCreateHubIdentity/.test(p2HubIdx) && /stateDir/.test(p2HubIdx)
    && /sendIdentityFrame/.test(p2Registry) && /buildIdentityPayload/.test(p2Registry)
    && /hubFingerprint/.test(p2Pairing)
    && /hubFingerprintForPairCode/.test(p2SetupBin),
    'lib/hub/index.js + registry-handshake.js + lib/pairing.js + bin/dsh-remote-setup.js')

  check('63', '代码锚点（副机侧）：验证链五环 / 宽限窗口 / TOFU 落盘 / 任务拦截都在',
    /verifyHubIdentity/.test(p2Transport) && /armIdentityGrace/.test(p2Transport)
    && /pinnedFingerprint/.test(p2Transport) && /failHubIdentity/.test(p2Transport)
    && /saveHubPin/.test(p2HubPin) && /loadHubPin/.test(p2HubPin)
    && /normalizeFingerprint/.test(p2Identity) && /writeJsonAtomic/.test(p2Identity)
    && /HUB_IDENTITY_PENDING/.test(p2NodeIdx) && /pinnedHubFingerprint/.test(p2NodeIdx),
    'lib/node/transport.js + hub-pin.js + lib/identity.js + lib/node/index.js')

  check('64', 'CHANGELOG 未发布段记录 P2-11（身份认证 + TOFU + 宽限窗口）',
    /身份认证/.test(p2Changelog) && /TOFU/.test(p2Changelog)
    && /hub-identity-pending/.test(p2Changelog) && /hubFingerprint/.test(p2Changelog),
    'CHANGELOG.md [未发布] 段')
}

/* ── 71/72. 中继链路端到端加密（提案 #1）──
 *
 * E2E 是安全承诺：文档说"中继只见密文"，代码就得真的有会话协商与
 * 明文业务帧拒绝。钉两侧：文档侧（71）钉 README 不变式行 + SECURITY
 * 专节（含已知局限的如实声明）+ CHANGELOG 条目；代码侧（72）钉
 * lib/e2e.js 核心导出、协议帧常量与 hub/node 两侧接线的函数名。
 */
{
  const e2eReadme = read('README.md')
  const e2eSecurity = read('SECURITY.md')
  const e2eChangelog = read('CHANGELOG.md')
  const e2eLib = read('lib/e2e.js')
  const e2eProtocol = read('lib/protocol.js')
  const e2eTransport = read('lib/node/transport.js')
  const e2eIngest = read('lib/hub/registry-ingest.js')
  const e2eNodeReg = read('lib/hub/node-registry.js')

  check('71', 'E2E 文档承诺：README 不变式行 + SECURITY 专节（含主动降级与明文拒绝）+ CHANGELOG 条目',
    /中继只见密文/.test(e2eReadme) && /lib\/e2e\.js/.test(e2eReadme)
    && /中继链路端到端加密（提案 #1）/.test(e2eSecurity) && /e2e-required/.test(e2eSecurity)
    && /主动降级/.test(e2eSecurity) && /X25519/.test(e2eSecurity)
    && /中继链路端到端加密（提案 #1）/.test(e2eChangelog) && /relayE2E/.test(e2eChangelog),
    'README.md + SECURITY.md + CHANGELOG.md 的 E2E 锚点')

  check('72', 'E2E 代码锚点：密钥协商/帧封核心 + 协议常量 + hub/node 两侧接线都在',
    /generateEphemeral/.test(e2eLib) && /deriveSessionKey/.test(e2eLib)
    && /E2E_OFFER/.test(e2eProtocol) && /E2E_ACK/.test(e2eProtocol)
    && /E2E_REQUIRED/.test(e2eProtocol) && /E2E_RESET/.test(e2eProtocol)
    && /handleE2EAck/.test(e2eTransport) && /E2E_REQUIRED_TYPES/.test(e2eTransport)
    && /handleE2EOffer/.test(e2eIngest) && /E2E_CLEAR_TYPES/.test(e2eNodeReg),
    'lib/e2e.js + protocol.js + transport.js + registry-ingest.js + node-registry.js')
}

/* ── 65. eslint 严格档三件套 ──
 *
 * lint 是 CI 的第三条防线（no-undef 首跑就抓到过 numOr 真 bug）。
 * 锚点钉 run: npm run lint 整行 —— ci.yml 顶部注释也含 npm run lint 字样，
 * 只查裸字样会在 job 被删时被注释救活（自检变异抓过）。
 * 钉住三件事：lint script 存在、配置文件存在、CI 真的跑它 ——
 * 防"配置还在、CI 早就不跑"的静默失效。
 */
check('65', 'eslint 严格档：lint script + 配置文件 + CI job 三件套齐全',
  pkg.scripts?.lint === 'eslint .'
  && fs.existsSync(path.join(ROOT, 'eslint.config.js'))
  // ⚠ 原写法是 `/run://s*npm run lint/` —— 反斜杠丢了，`\s` 变成 `//s`。
  // 于是正则字面量在 `run:` 处就结束了，剩下的 `//s*npm run lint/...` 被当成
  // 注释，整行变成 `... && /run:/ / s * npm ...` —— **语法错误**，脚本直接抛
  // SyntaxError 崩掉（而不是"断言失败"）。
  //
  // 后果比断言失败严重：脚本崩溃让**整份漂移检查 exit 1 但没有任何 [NN] 输出**，
  // 于是 doc-drift-selfcheck 的"注入后必须报出 [65]"用例永远失败，
  // 而其他用例因为"exit 1"而假绿。
  && /run:\s*npm run lint/.test(read('.github/workflows/ci.yml')),
  'package.json scripts.lint + eslint.config.js + .github/workflows/ci.yml')

/* ── 66. 资源遥测链路 ──
 *
 * node/resource 帧的整条链：协议常量 → 副机采样器 → hub 摄入 → 投影透出。
 * 四个锚点缺一，遥测就静默断在半路（而遥测断了没有任何报错）。
 */
{
  const p66Protocol = read('lib/protocol.js')
  const p66Registry = read('lib/hub/registry-ingest.js')
  const p66Resource = read('lib/node/resource.js')
  check('66', '资源遥测链路：协议帧 + 副机采样器 + hub 摄入 + 投影透出都在',
    /RESOURCE:\s*'node\/resource'/.test(p66Protocol)
    && /case NODE_TO_HUB\.RESOURCE:/.test(p66Registry) && /rec\.resource = {/.test(p66Registry)
    && /createResourceSampler/.test(p66Resource) && /cpuPctBetween/.test(p66Resource)
    && /memTotalMb/.test(views) && /资源: CPU/.test(hubTools),
    'lib/protocol.js + lib/hub/registry-ingest.js + lib/node/resource.js + views.js + tools.js')
}

/* ── 67. 产物断点续传 ──
 *
 * 三段链缺一不可：hub 侧半成品晋升/续传探测（pull-manager）→ startOffset 下发
 * → 副机中段续流（artifact-service）+ 帧入口接线（node/index）。
 * 任何一段被拆掉，续传就静默退化成"每次全量重传"（无报错、无症状）。
 */
{
  const p67Pull = read('lib/hub/pull-manager.js')
  const p67Service = read('lib/node/artifact-service.js')
  const p67Node = read('lib/node/index.js')
  check('67', '产物断点续传：hub 半成品晋升 + startOffset 下发 + 副机中段续流都在',
    /resumeKeyOf/.test(p67Pull)
    && /promotePartial/.test(p67Pull)
    && /prefixSha256/.test(p67Pull)
    && /startOffset/.test(p67Pull)
    && /createReadStream\(real, { start: startOffset/.test(p67Service)
    && /beyond file size/.test(p67Service)
    && /invalid startOffset/.test(p67Node),
    'lib/hub/pull-manager.js + lib/node/artifact-service.js + lib/node/index.js')
}

/* ── 68~70. 守卫的守卫（2026-10-16 加）──
 *
 * 检查脚本自己坏掉时**不会报错** —— 它们静默变成永远通过，比没有守卫更危险。
 * 我们为此付出过代价：本文件的断言 65 曾因正则里 `\s` 写成 `//s` 而 SyntaxError，
 * 整份检查 exit 1 但**没有任何 [NN] 输出**，于是自检里"必须报出 [65]"那条永远
 * 失败、而**其他用例全部假绿**（它们只断言 exit 码）。
 *
 * 这三条锁住那次修复的成果：诊断脚本在、踩坑文档在、崩溃形态没有回来。
 */
{
  const pkgGuard = JSON.parse(read('package.json'))
  check('68', 'inject 契约诊断脚本存在且挂在 check 链上',
    fs.existsSync(path.join(ROOT, 'scripts', 'diag-inject.mjs'))
    && typeof pkgGuard.scripts?.['diag:inject'] === 'string'
    && /diag:inject/.test(String(pkgGuard.scripts?.check ?? '')),
    'scripts/diag-inject.mjs + package.json scripts.diag:inject + scripts.check')

  check('69', '副机部署踩坑文档存在且在发布清单里',
    fs.existsSync(path.join(ROOT, 'docs', 'worker-setup-pitfalls.md'))
    && Array.isArray(pkgGuard.files)
    && pkgGuard.files.includes('docs'),
    'docs/worker-setup-pitfalls.md + package.json files 含 docs')

  // 断言 65 的正则不得退回"反斜杠丢失"的形态（那会让整个脚本 SyntaxError）
  const driftSelf = read('scripts/check-doc-drift.mjs')
  check('70', '断言 65 的正则没有退回 /run://s*.../ 的崩溃形态',
    /run:\\s\*npm run lint/.test(driftSelf),
    'scripts/check-doc-drift.mjs 断言 65（`\\s` 必须带反斜杠，否则脚本崩）')
}

/* ── 73~74. 队列残余风险的两条防线（#26-4 / #26-5，2026-10-17）──
 *
 * 背景：副机的 `maxConcurrent=2` 被两条卡住的 exec 占满后，后续任务全部排队。
 * 排查时发现两个让问题"不可见/不可控"的缺陷：
 *
 *   #26-4 面板只显示 `running: 2` 这个数字 —— 看不到是哪两条、在跑什么、
 *         跑了多久。用户只知道"卡了"，没有任何可操作的东西。
 *   #26-5 `cancel` 只置 AbortSignal，没进 `Promise.race` —— agent 循环
 *         不监听它，任务继续跑到自然结束，最终落成 **completed**（不是
 *         aborted）。用户以为取消成功，实际白跑一遍还烧了额度。
 *
 * 这两条都是"静默失效"型：没有报错、没有日志、行为看起来"正常"。
 * 所以用断言把修复钉住。
 */
{
  const panelClient = read('lib/client.js')
  check('73', '#26-4 面板任务列表按状态分组，运行中置顶且显示已跑时长',
    /ACTIVE_STATUSES/.test(panelClient)
    && /activeTasks/.test(panelClient)
    && /运行中（/.test(panelClient)
    && /已跑 /.test(panelClient),
    'lib/client.js（ACTIVE_STATUSES + 运行中分组 + 已跑时长）')

  const runnerSrc = read('lib/node/runner.js')
  check('74', '#26-5 agent 取消真打断：abortPromise 参与 race，ok 排除 aborted',
    /const abortPromise/.test(runnerSrc)
    && /abortPromise,/.test(runnerSrc)
    && /ok:\s*!timedOut\s*&&\s*!aborted/.test(runnerSrc)
    && /if\s*\(!timedOut\)\s*aborted\s*=\s*true/.test(runnerSrc),
    'lib/node/runner.js（abortPromise 进 race + ok 排除 aborted + 超时不误标）')
}

/* ── 75. #27 完整链路：模型清单自述 → 面板下拉（2026-10-17）──
 *
 * v0.7.0 只做了"自述 + 派发前拦截"，面板仍是自由文本 —— 当时的判断是
 * "DSH 没有稳定的清单 API"。**那个判断已过时**：`ctx.llm.listProviders()`
 * 与 `listModels(provider)` 现在就是稳定服务面。
 *
 * 链路四段，任一断掉面板就退回自由文本：
 *   1. 副机 readAvailableModels（探测 + 缓存 + 上限）
 *   2. RESOURCE 帧带缓存值（interval 回调是同步的，不能 await）
 *   3. hub 字段级清洗 + 独立封顶
 *   4. registry.list → nodeView → 面板 <select>
 *
 * 安全边界：只报 provider/id/name，绝不带 apiKeyEnv / baseURL / 凭证。
 */
{
  const nodeIdx = read('lib/node/index.js')
  const ingestSrc = read('lib/hub/registry-ingest.js')
  const viewsSrc = read('lib/hub/views.js')
  const clientSrc = read('lib/client.js')

  check('75', '#27 模型清单链路：副机探测 + 帧自述 + hub 清洗 + 视图投影 + 面板下拉都在',
    /export async function readAvailableModels/.test(nodeIdx)
    && /llm\.listProviders\(\)/.test(nodeIdx)
    && /llm\.listModels\(/.test(nodeIdx)
    && /models:\s*cachedModels/.test(nodeIdx)
    && /MAX_NODE_MODELS/.test(ingestSrc)
    && /models: Array\.isArray\(r\.models\)/.test(read('lib/hub/node-registry.js'))
    && /models: Array\.isArray\(n\.models\)/.test(viewsSrc)
    && /跟随副机默认/.test(clientSrc)
    && /__custom__/.test(clientSrc),
    'lib/node/index.js + registry-ingest.js + node-registry.js + views.js + client.js')

  check('76', '#27 安全：模型自述只含 provider/id/name，不碰凭证',
    (() => {
      const code = nodeIdx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const i = code.indexOf('export async function readAvailableModels')
      if (i < 0) return false
      const seg = code.slice(i, i + 2600)
      // 上报对象里不得出现凭证相关字段
      if (/apiKeyEnv/.test(seg) || /baseURL/.test(seg)) return false
      const push = seg.match(/models\.push\(\{([^}]*)\}\)/)
      if (!push) return false
      const inner = push[1]
      const keys = new Set()
      for (const m of inner.matchAll(/(\w+)\s*:/g)) keys.add(m[1])
      for (const part of inner.split(',')) {
        const t = part.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t)
      }
      const got = [...keys].sort().join(',')
      return got === 'id,name,provider'
    })(),
    'lib/node/index.js readAvailableModels（上报字段恰好 provider/id/name）')
}

/* ── 77~78. 环境体检（2026-10-17）──
 *
 * 这个插件最贵的失败全是**静默**的：
 *   · webserver 绑 loopback → 副机永远连不上，主机侧毫无异常
 *   · inject 缺服务 → hub 半死（路由活着但工具全丢）
 *   · roots 不存在 → 任务全被 workspace-denied 拒绝
 *
 * 用户只能猜"地址错了？token 错了？防火墙？"。所以体检必须覆盖这些前置条件、
 * 每条都给**具体修法**，且命令行与面板共用同一份逻辑（两处不一致更坏）。
 *
 * 另外钉住一条产品边界：**不代用户下载第三方软件**（零依赖是核心卖点，
 * 代下载会让我们变成软件分发方）。
 */
{
  const envLib = read('lib/env-check.js')
  const uiSrc2 = read('lib/hub/ui-routes.js')
  const clientSrc2 = read('lib/client.js')

  check('77', '环境体检：共享模块 + 面板路由 + 面板按钮三处都在',
    /export function envChecks/.test(envLib)
    && /export function isLoopbackOrigin/.test(envLib)
    && /export function renderEnvChecks/.test(envLib)
    && /UI_API_PREFIX\}\/env-check/.test(uiSrc2)
    && /apiGet\('\/env-check'\)/.test(clientSrc2)
    && /'体检'/.test(clientSrc2),
    'lib/env-check.js + ui-routes.js /env-check + client.js 体检按钮')

  check('78', '环境体检：覆盖静默失败项 + 每条带修法 + 不代下载',
    /'reachability'/.test(envLib)
    && /'inject'/.test(envLib)
    && /'roots'/.test(envLib)
    && /'role'/.test(envLib)
    && /fix:/.test(envLib)
    && /不会代你下载/.test(envLib),
    'lib/env-check.js（可达性/inject/roots/role + fix + 不代下载边界）')
}

/* ── 79~80. 开箱即用（2026-10-17，2026-10-18 修订）──
 *
 * 产品标准：用户装完就该能用，不该读文档、改 YAML、猜字段。
 *
 * 核心设计：`role` 默认 **auto**，按 `hubUrl` 推断。
 *   · 默认 hub → 副机装完以 hub 身份启动，注册无鉴权端点（**攻击面**）
 *   · 默认 ''  → 两台都要操作，不是开箱即用
 *   · 默认 auto → 主机零操作、副机贴完配对码零操作，且不给副机开错端点
 *
 * ⚠ **2026-10-18 事故修订**：79 号断言原来**要求**包内 patch 绑
 * `host: '0.0.0.0'` —— 那正是导致 **DSH 启动崩溃**的写法。新版
 * `dsh-host-webserver` 在 schema 校验阶段就硬拒绝通配地址：
 *
 *     host "0.0.0.0" is an unspecified (wildcard) address, which is not
 *     supported: binding every interface would expose remote code execution
 *     to the network; bind one concrete IPv4 or IPv6 address ...
 *
 * 后果：webserver（required）激活失败 → webServer 服务缺失 → 至少 6 个插件
 * 排队等它 → host 启动失败（实测 10 份 crash 日志）。
 *
 * 所以断言方向**反过来**：现在要求包内 patch **不碰** webserver 的任何字段，
 * 且所有提示文案都不得建议 0.0.0.0。
 */
{
  const indexSrc = read('lib/index.js')
  const patchSrc = read('cordis.patch.yml')
  const clientSrc3 = read('lib/client.js')
  const setupSrc = read('lib/setup-routes.js')
  const envSrc = read('lib/env-check.js')
  const hubSrc = read('lib/hub/index.js')

  // ⚠ 只扫**非注释行**：注释里必须保留那次事故的原文（含 `0.0.0.0` 与
  // `- id: webserver` 示例），那是给后来者的警示 —— 不该被断言判违规。
  // 这一点和 L3 断言踩过的坑同源（扫全文会命中"正确留档的注释"）。
  const patchCode = patchSrc
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

  check('79', '开箱即用：role 默认 auto；且包内 patch **不得**绑 0.0.0.0（会让 DSH 崩溃）',
    /\.default\('auto'\)/.test(indexSrc)
    && /ROLE\.AUTO/.test(indexSrc)
    && /config\.hubUrl/.test(indexSrc)
    // ⚠ 关键：包内 patch 的**生效行**不得 override webserver 的 host
    && !/^- id: webserver$/m.test(patchCode)
    && !/host:\s*'0\.0\.0\.0'/.test(patchCode)
    // 必须把这个坑写进注释（防止后来者又"帮用户改好"）
    && /启动崩溃/.test(patchSrc),
    'lib/index.js（auto 推断）+ cordis.patch.yml（生效行不碰 webserver + 事故留档）')

  check('80', '开箱即用：副机表单简化 + 工作区自动创建 + 首次自动体检',
    // 工作区预填
    /function defaultRootsHint/.test(clientSrc3)
    // 节点 ID 折叠
    && /默认用主机名/.test(clientSrc3)
    // 首次自动体检
    && /autoChecked/.test(clientSrc3)
    // 服务端自动建目录
    && /mkdirSync\(r, \{ recursive: true \}\)/.test(setupSrc)
    && /warnings: applyWarnings/.test(setupSrc),
    'lib/client.js（预填/折叠/自动体检）+ lib/setup-routes.js（自动建目录）')

  // ── 79b：**所有面向用户的修法文案**都不得建议 0.0.0.0 ──────────────
  //
  // 这是本次事故最有价值的一条守卫：代码自己不能犯那个错，提示文案也不能。
  // 检查的是字符串字面量（`host: '0.0.0.0'` 这种形态），不是注释里的说明。
  check('79b', '所有修法文案都不得建议 host 0.0.0.0（会让 DSH 启动崩溃）',
    !/host:\s*'0\.0\.0\.0'/.test(clientSrc3)
    && !/host:\s*'0\.0\.0\.0'/.test(envSrc)
    && !/加 host:\s*'0\.0\.0\.0'/.test(hubSrc)
    // 但要**明确警告不能用**它（否则用户可能自己想到这个"标准做法"）
    && /不能用 0\.0\.0\.0/.test(envSrc)
    && /不能用 0\.0\.0\.0/.test(clientSrc3),
    'lib/client.js + lib/env-check.js + lib/hub/index.js（修法不含 0.0.0.0，且有明确警告）')
}

/* ── 81~82. 工作区 SMB 共享（2026-10-17）──
 *
 * 用户需求：想用本地 IDE 直接打开副机的项目目录 —— 唯一现实路径是把工作区
 * 通过 SMB 共享出去，主机 `net use X: \\副机\dsh-work` 映射成盘符。
 *
 * ⚠ **这是本插件唯一主动放宽安全边界的功能**：
 *   · roots / denyPaths 全部失效（Windows 内核直读，插件拦不住）
 *   · 「清单先于字节」失效（.env / .git 密钥 / 中间产物全部可见）
 *   · 新增凭证面（主机需要副机 Windows 账号）
 *
 * 所以产品要求（用户确认）：二次确认 + 只读/读写两选项 + 不代执行（需管理员）。
 * 这两条断言把安全约束钉住 —— 它们比功能本身更重要。
 */
{
  const shareSvc = read('lib/node/share-service.js')
  const nodeIdx2 = read('lib/node/index.js')
  const uiSrc3 = read('lib/hub/ui-routes.js')
  const clientSrc4 = read('lib/client.js')
  const transportSrc = read('lib/node/transport.js')

  check('81', '工作区共享：协议帧 + E2E 强制 + 独立 pending 表 + 副机 handler 都在',
    /SHARE_REQ: 'share\/req'/.test(read('lib/protocol.js'))
    && /SHARE_RES: 'share\/res'/.test(read('lib/protocol.js'))
    // 工作区绝对路径不许明文过中继
    && /HUB_TO_NODE\.SHARE_REQ/.test(transportSrc)
    // 两张 pending 表不能混（混了超时归因变模糊）
    && /this\.sharePending = new Map\(\)/.test(read('lib/hub/node-registry.js'))
    && /shareCancelForNode/.test(read('lib/hub/node-registry.js'))
    && /handleShareRes/.test(read('lib/hub/registry-ingest.js'))
    && /function handleShareReq/.test(nodeIdx2),
    'protocol.js + transport.js + node-registry.js + registry-ingest.js + node/index.js')

  check('82', '工作区共享安全：二次确认硬要求 + 只读默认 + 不代执行',
    // 二次确认是硬要求（缺 confirm 必须 400，不能有默认通过）
    /body\?\.confirm !== 'yes'/.test(uiSrc3)
    && /confirm-required/.test(uiSrc3)
    // 只读默认（最小权限）
    && /React\.useState\('read'\)/.test(clientSrc4)
    && /disabled: busy \|\| !ack/.test(clientSrc4)
    // 读写用 -ChangeAccess，不用 -FullAccess（后者会把 ACL 也交出去）
    && /ChangeAccess/.test(shareSvc)
    && !/'-FullAccess'/.test(shareSvc)
    // 不代执行（需管理员，Node 提权失败比让用户手动跑难排查）
    && !/spawn.*New-SmbShare/.test(nodeIdx2)
    && /admin: isAdmin\(\)/.test(nodeIdx2)
    // 共享目录必须过 roots 边界
    && /resolveWorkspace\(/.test(nodeIdx2),
    'ui-routes.js（二次确认）+ client.js（勾选框/只读默认）+ share-service.js + node/index.js')
}

/* ── 83. README 声明的工具数量必须等于代码里实际注册的数量 ──
 *
 * 起因（2026-10-17）：README 写「7 个 remote_* 工具」，实际早已是 12 个
 * （8 个 remote_* + 4 个 fs 工具）。这种数字漂移是最容易积累的文档债务 ——
 * 每次加工具都忘了改 README，而读者会拿它当事实。
 *
 * 断言做法：数 `reg(` / `fsOp(` 的注册调用，与 README 里的声明比对。
 * 两边任一变化都会立刻失败，逼着改的人同步另一处。
 */
{
  const toolsSrc = read('lib/hub/tools.js')
  const advancedToolsSrc = read('lib/hub/advanced-tools.js')
  const rootReadme2 = read('README.md')

  // 数实际注册：三种注册入口都要算进来（2026-10-20 加了 writeOp 与进程工具）
  //   · `reg(`      —— 任务工具 + 进程诊断工具
  //   · `fsOp(`     —— 只读文件工具
  //   · `writeOp(`  —— 写操作文件工具
  const regCount = (toolsSrc.match(/^\s{2}reg\(/gm) || []).length
  const fsOpCount = (toolsSrc.match(/^\s{2}fsOp\(/gm) || []).length
  const writeOpCount = (toolsSrc.match(/^\s{2}writeOp\(/gm) || []).length
  const advancedCount = (advancedToolsSrc.match(/^\s{2}reg\(/gm) || []).length
  const actual = regCount + fsOpCount + writeOpCount + advancedCount

  // 从 README 里抽声明（形如「12 个 remote_* 工具」或「工具速查（共 12 个）」）
  const m = /(?:共\s*(\d+)\s*个|(\d+)\s*个\s*remote_\*)/.exec(rootReadme2)
  const declared = m ? Number(m[1] ?? m[2]) : null

  check('83', 'README 声明的工具数量等于代码里实际注册的数量',
    declared !== null && declared === actual,
    `lib/hub（实际 ${actual} 个：reg=${regCount} + fsOp=${fsOpCount} + writeOp=${writeOpCount} + advanced=${advancedCount}）`
    + ` vs README.md（声明 ${declared === null ? '未找到' : declared} 个）`)
}

/* ── 84~85. v0.9.0 审查的两个 High：**接线断链**（2026-10-17）──
 *
 * 这两个 bug 的共同点：**模块本身完全正确，装配进系统时接线断了**。
 *
 *   H1  env-check.js 的 24 条单测全绿，但 /env-check 路由传的是**原始
 *       config.role**（'auto'）→ 五项检查全跳过、两项误报 → 对 100% 默认
 *       安装用户失效，且首次自动体检让它在每个新用户面前弹出。
 *   H2  share-service.js 的 17 条单测全绿，但面板恒发 dir: '' → 副机按设计
 *       拒绝 → SMB 共享的唯一主动作 100% 失败。
 *
 * 单测证明不了"模块被装配进系统时的形状"。这两条断言锚在接线处。
 */
{
  const uiSrc4 = read('lib/hub/ui-routes.js')
  const clientSrc5 = read('lib/client.js')
  const setupBin = read('bin/dsh-remote-setup.js')

  check('84', 'env-check 路由传解析后角色（v0.9.0 审查 H1：否则 auto 判成非 hub）',
    // 反例：把原始 config.role 直接传给 envChecks
    (() => {
      const i = uiSrc4.indexOf('/env-check`')
      if (i < 0) return false
      const seg = uiSrc4.slice(i, i + 900)
      // 不得出现 `role: typeof config.role === 'string' ? config.role`
      if (/role:\s*typeof config\.role === 'string'\s*\?\s*config\.role/.test(seg)) return false
      // 必须用 resolveRole（或字面量 'hub'）
      return /resolveRole/.test(seg)
    })(),
    'lib/hub/ui-routes.js（role: resolveRole(config) 而非原始 config.role）')

  check('85', 'SMB 面板发真实 dir + CLI doctor 走独立监听判可达性（H2 / M1 / H5）',
    // H2：不得写死 dir: ''
    (() => {
      const i = clientSrc5.indexOf('function doPlan()')
      if (i < 0) return false
      const seg = clientSrc5.slice(i, i + 900)
      return !/dir:\s*''/.test(seg) && /dir:\s*shareDir/.test(seg)
    })()
    // H2：必须有目录选择 UI（数据源 node.roots）
    && /nodeRoots/.test(clientSrc5)
    // M1：CLI 必须调 envChecks（否则没有 loopback 诊断）
    && /envChecks/.test(setupBin)
    // H5：回环判据必须来自 listen-server（一份实现），不是 CLI 自己拼 origin
    && /isLoopbackHost/.test(setupBin)
    // H5 负向守卫：CLI **不得**再从 patch 里找 webserver 段判可达性。
    // 0.9.3 起端点由插件自己的独立监听承载，webserver 的 host 与副机接入
    // 毫无关系 —— 读了会把人引向"改 webserver"这个改了也会被冲掉的死路。
    // ⚠ 扫**剥注释后**的代码：注释里必须保留事故说明（含 `- id: webserver`
    // 字样），那是给后来者的警示，不该被这条断言判违规。
    && !/- id:\s*webserver/.test(stripComments(setupBin))
    // 生效配置以 instance.json 为准（否则体检报告的是已失效的 patch 值）
    && /readInstanceConfig/.test(setupBin),
    'lib/client.js（dir: shareDir + nodeRoots UI）+ bin/dsh-remote-setup.js（envChecks + listen-server 判据）')
}

/* ── 86~87. 独立监听端口（2026-10-18，架构级修复）──
 *
 * 副机端点原来注册在 `ctx.webServer` 上 → 副机必须访问 DSH 的 webserver 端口。
 * 而那个端口：
 *   · **DSH 每次启动重写 profile patch**，把写进去的 `webserver` 段删掉
 *     （实测：3962B/15 条 → 661B/3 条）→ 绑回 127.0.0.1 → 副机永远连不上
 *   · `webServer` 激活即 listen，没有 rebind 方法
 *   · 新版硬拒绝 0.0.0.0（会让 DSH 启动崩溃，踩过 10 份 crash 日志）
 *
 * 所以插件自己开一个 node:http server 服务节点端点，完全绕开 DSH 的 webserver。
 * 这两条断言钉住"这条通道存在且不依赖 webServer"。
 */
{
  const hubSrc2 = read('lib/hub/index.js')
  const listenSrc = read('lib/listen-server.js')

  check('86', '独立监听：插件自己开端口服务节点端点（不依赖 webServer 配置）',
    /startListenServer/.test(hubSrc2)
    && /resolveListenHost/.test(hubSrc2)
    // 默认端口 19387（与历史配置/配对码/文档一致）
    && /DEFAULT_LISTEN_PORT/.test(listenSrc)
    && /19387/.test(listenSrc)
    // 必须真的用 node:http 起 server（不是只 import 不用）
    && /createServer/.test(listenSrc)
    && /node:http/.test(listenSrc)
    // 路径精确匹配（只承载节点端点，不做通用 web server）
    && /pathname !== upgradePath/.test(listenSrc),
    'lib/hub/index.js + lib/listen-server.js（node:http + acceptUpgrade + 精确路径）')

  check('87', '独立监听：拒绝 0.0.0.0 + Tailscale 优先 + 测试环境不占端口',
    // 拒绝通配地址（与新版 DSH 同规则；0.0.0.0 会让 DSH 崩溃，我们踩过）
    /h !== '0\.0\.0\.0'/.test(listenSrc)
    // 自动选地址时 Tailscale 优先（本插件的目标场景就是跨网）
    && /isTailscaleIp/.test(listenSrc)
    // 测试环境下不真的监听（否则 npm test 会挂住 —— 实测过）
    && /NODE_TEST_CONTEXT/.test(hubSrc2),
    'lib/listen-server.js（拒 0.0.0.0 + Tailscale 优先）+ hub/index.js（测试环境跳过）')
}

/* ── 88~90. 用户体验五项（2026-10-20）──
 *
 * 实测用户反馈："出了问题不知道原因"。五个断层：
 *   ① 副机连不上时主机只显示「0 在线」，没有原因
 *   ② 体检能查出来，但修法要手抄 YAML
 *   ③ 首次使用不知道从哪开始
 *   ④ 原始错误（ECONNREFUSED / 401 / timeout after 40000ms）直接抛给用户
 *   ⑤ 长任务只能看到"运行中"，不知道在干什么
 *
 * 这三条断言钉住"每条都有对应实现"，防止后续重构把它们悄悄拿掉。
 */
{
  const explainSrc = read('lib/explain-error.js')
  const regSrc = read('lib/hub/node-registry.js')
  const clientSrc6 = read('lib/client.js')
  const uiSrc5 = read('lib/hub/ui-routes.js')

  check('88', '体验④：统一错误翻译层覆盖 errno + 协议码 + HTTP + 文案特征',
    /export function explainError/.test(explainSrc)
    // errno 分支
    && /ECONNREFUSED/.test(explainSrc)
    && /ETIMEDOUT/.test(explainSrc)
    && /EADDRINUSE/.test(explainSrc)
    // 协议码（用 ERROR_CODE 常量，不写死字符串）
    && /ERROR_CODE\.UNAUTHORIZED/.test(explainSrc)
    && /ERROR_CODE\.PROTOCOL_MISMATCH/.test(explainSrc)
    // HTTP 状态
    && /case 401:/.test(explainSrc)
    && /case 404:/.test(explainSrc)
    // 文案特征
    && /handshake timeout/.test(explainSrc)
    // 每条都有 hint（下一步做什么）
    && /hint:/.test(explainSrc),
    'lib/explain-error.js（errno + 17 个协议码 + HTTP + 文案特征，每条带 hint）')

  check('89', '体验①：连接尝试历史（记录 + 面板空态诊断）',
    // 注册表记录每次尝试
    /noteConnectionAttempt/.test(regSrc)
    && /connectionLog/.test(regSrc)
    && /connectionReport/.test(regSrc)
    // 拒绝点与成功点都要记
    && /noteConnectionAttempt/.test(read('lib/hub/registry-handshake.js'))
    // 路由透出
    && /connection: connReport/.test(uiSrc5)
    // 面板渲染诊断（区分"从没连过"与"连过又断"）
    && /connDiag/.test(clientSrc6)
    && /everConnected/.test(clientSrc6),
    'node-registry.js + registry-handshake.js + ui-routes.js + client.js')

  check('90', '体验②③⑤：复制修法按钮 + 编号步骤 + 任务进度摘要',
    // ② 复制修法
    /复制修法/.test(clientSrc6)
    && /copyText\(it\.fix\)/.test(clientSrc6)
    // ③ 编号步骤（hub 侧 1-4 步）
    && /'重启 DSH'/.test(clientSrc6)
    && /'生成配对码'/.test(clientSrc6)
    && /'在副机上粘贴'/.test(clientSrc6)
    && /'等它连上'/.test(clientSrc6)
    // ③ 角色选择提示
    && /你现在用的这台/.test(clientSrc6)
    // ⑤ 任务行进度摘要
    && /progressLine/.test(clientSrc6)
    && /最近：/.test(clientSrc6),
    'lib/client.js（复制按钮 + 编号步骤 + 角色提示 + 任务进度摘要）')
}

/* ── 91~94. 四项新能力（2026-10-20）──
 *
 * 用户要求"一键修复 / 自动装依赖 / 更多工具 / 重写 UI"。
 * 每一项都在**放宽边界**，所以断言的重点不是"能用"，而是**护栏在不在**：
 *
 *   · 一键修复  → 会改 DSH 自己的 cordis.patch.yml
 *   · 写操作    → 会改副机的文件（不可逆）
 *   · kill      → 会杀副机的进程（杀错会失联）
 *   · 外部工具  → "自动装依赖"的诱惑要顶住（只给命令，不代下载）
 */
{
  const autoFixSrc = read('lib/auto-fix.js')
  const extSrc = read('lib/external-tools.js')
  const fsSrc = read('lib/node/fs-service.js')
  const procSrc = read('lib/node/process-service.js')
  const toolsSrc2 = read('lib/hub/tools.js')
  const clientSrc7 = read('lib/client.js')
  const uiSrc6 = read('lib/hub/ui-routes.js')

  check('91', '一键修复：只改托管块 + 备份 + 写后校验 + 二次确认 + 可撤销',
    // 只读预览与写盘分离
    /export function planFixes/.test(autoFixSrc)
    && /export function applyFixPlan/.test(autoFixSrc)
    // 写盘复用带备份的 writePatchBlock
    && /writePatchBlock/.test(uiSrc6)
    // 写后校验：重复 id / 条目缺失
    && /重复 id/.test(autoFixSrc)
    // 撤销
    && /export function undoFix/.test(autoFixSrc)
    // 路由层强制 confirm
    && /confirm !== 'yes'/.test(uiSrc6)
    // 绝不给 0.0.0.0（会让 DSH 崩溃）
    && /h !== '0\.0\.0\.0'/.test(read('lib/listen-server.js')),
    'lib/auto-fix.js + lib/hub/ui-routes.js（plan/apply/undo + confirm 硬要求）')

  check('92', '写操作：roots 护栏 + 默认不覆盖 + 不递归删 + 原子写',
    // 写操作专用解析（允许目标不存在）
    /function resolveWritable/.test(fsSrc)
    // 默认不覆盖
    && /overwrite !== true/.test(fsSrc)
    // 不递归删：非空目录必须拒绝
    && /directory not empty/.test(fsSrc)
    // 原子写
    && /dshra-tmp/.test(fsSrc)
    // 单次写入上限
    && /WRITE_MAX_BYTES/.test(fsSrc)
    // hub 侧强制 confirm
    && /const writeOp = /.test(toolsSrc2)
    && /args\?\.confirm !== 'yes'/.test(toolsSrc2),
    'lib/node/fs-service.js（resolveWritable + 不覆盖 + 不递归删）+ tools.js（confirm）')

  check('93', '进程诊断：kill 三道护栏（confirm / 拒杀自身与父进程 / 拒杀系统进程）',
    /export function killProcess/.test(procSrc)
    // 约束 1：confirm
    && /confirm !== 'yes'/.test(procSrc)
    // 约束 2：拒杀自己与父进程
    && /n === selfPid/.test(procSrc)
    && /n === parentPid/.test(procSrc)
    // 约束 3：系统关键进程
    && /PROTECTED_PROCESS_NAMES/.test(procSrc)
    // 命令注入面：PID/端口必须归一化
    && /export function normalizePid/.test(procSrc)
    && /export function normalizePort/.test(procSrc),
    'lib/node/process-service.js（kill 三道护栏 + pid/port 归一化）')

  check('94', '外部工具：只检测 + 给命令，绝不代下载（守供应链边界）',
    /export function probeExternalTools/.test(extSrc)
    && /export function toolCatalog/.test(extSrc)
    // 每个工具都要说明"缺了会怎样"
    && /why:/.test(extSrc)
    // 给安装命令与官方链接，但不执行
    && /install:/.test(extSrc)
    && /url:/.test(extSrc)
    // 反例：不得出现代执行安装命令的调用
    && !/spawnSync\(\s*['"`](winget|brew|apt|choco|curl|wget)/.test(extSrc),
    'lib/external-tools.js（探测 + 说明 + 命令，不执行）')

  check('95', 'UI：折叠区块（信息密度）—— 首屏只留当下需要的',
    // 原生 details（零 JS 状态）
    /className: 'dra-fold'/.test(clientSrc7)
    && /<details|h\('details'/.test(clientSrc7)
    // 折叠样式
    && /\.dra-fold/.test(clientSrc7)
    // 默认展开策略：没节点时展开接入
    && /open: state\.nodes\.length === 0/.test(clientSrc7)
    // 体检有失败项时默认展开
    && /open: Boolean\(envCheck && envCheck\.failed > 0\)/.test(clientSrc7),
    'lib/client.js（Fold 组件 + dra-fold 样式 + 默认展开策略）')
}

/* ── 96. README 必须介绍四项新能力（2026-10-20）──
 *
 * 起因：0.9.8 加了四项能力（一键修复 / 外部工具 / 写操作 / 进程诊断），
 * 但 README 只更新了工具数量，**没有任何功能介绍** —— 用户反馈"readme 好像
 * 没有功能相关的介绍"（这是第 2 次）。
 *
 * 断言做法：每个能力在 README 里必须有对应的小节标题。这样以后加功能忘了
 * 写文档，这条会立刻失败。
 */
{
  // ⚠ 变量名不能叫 readme —— 模块顶部已有 `const readme`（用于 read() 帮助），
  // 同名会被 eslint 的 no-shadow 拦下。
  const rootReadme3 = read('README.md')
  const required = [
    ['七、一键修复', '一键修复'],
    ['八、外部工具检测', '外部工具检测'],
    ['九、文件写入与进程诊断', '写操作 + 进程诊断'],
  ]
  const missing = required.filter(([heading]) => !rootReadme3.includes(heading)).map(([, name]) => name)

  check('96', 'README 介绍了四项新能力（一键修复 / 外部工具 / 写操作 / 进程诊断）',
    missing.length === 0
    // 安全边界也必须写清楚（写操作与 kill 是主动放宽边界的能力）
    && /主动放宽边界/.test(rootReadme3)
    // 每项都要说明"为什么这么做"，而不只是"有什么功能"
    && /为什么不代下载/.test(rootReadme3)
    && /三道护栏/.test(rootReadme3),
    missing.length === 0
      ? 'README.md（七/八/九 三节 + 安全边界 + 设计理由）'
      : `README.md 缺少小节：${missing.join('、')}`)
}

/* ── 97~98. 0.10.0 全面升级：实现接线与公开文档必须同步 ── */
{
  const hubIdx = read('lib/hub/index.js')
  const hubToolsSrc = read('lib/hub/tools.js')
  const advancedSrc = read('lib/hub/advanced-tools.js')
  const workerSrc = read('lib/node/index.js')
  const fileSvc = read('lib/node/file-transfer-service.js')
  const desktopSvc = read('lib/node/desktop-service.js')
  const selfcheckSvc = read('lib/node/selfcheck-service.js')
  const sessionGateSrc = read('lib/hub/session-gate.js')
  const rootReadme4 = read('README.md')
  const securityDoc = read('SECURITY.md')

  check('97', '0.10.0 新能力完整接线：fresh gate + 文件 + 截图 + 后台 + 会话门禁',
    /registerAdvancedTools\(/.test(hubIdx)
    && /precheck/.test(hubToolsSrc)
    && /remote_selfcheck/.test(hubToolsSrc)
    && /remote_agents/.test(hubToolsSrc)
    && /remote_interrupt/.test(hubToolsSrc)
    && /name: 'remote_file'/.test(advancedSrc)
    && /name: 'remote_screenshot'/.test(advancedSrc)
    && /fileBegin:/.test(workerSrc)
    && /desktopCapture:/.test(workerSrc)
    && /selfcheck:/.test(workerSrc)
    && /createFileTransferService/.test(fileSvc)
    && /createDesktopService/.test(desktopSvc)
    && /createSelfCheckService/.test(selfcheckSvc)
    && /createSessionGate/.test(sessionGateSrc),
    'hub/index.js + tools.js + advanced-tools.js + node 三个服务 + session-gate.js')

  check('98', '0.10.0 文档说明新能力、限制与安全边界',
    /真实环境自检与派单前门禁/.test(rootReadme4)
    && /后台代理管理与会话级开关/.test(rootReadme4)
    && /双向文件互传与桌面截图/.test(rootReadme4)
    && /512MiB/.test(rootReadme4)
    && /256KiB/.test(rootReadme4)
    && /remote_file/.test(securityDoc)
    && /remote_screenshot/.test(securityDoc)
    && /sessionGate/.test(securityDoc)
    && /SHA256/.test(securityDoc)
    && /没有另开 Bearer HTTP/.test(securityDoc),
    'README.md 十/十一/十二节 + SECURITY.md 0.10.0 安全专节')
}

/* ── 输出 ── */
const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
} else {
  console.log('=== 文档 vs 实现 字段级比对 ===\n')
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'DRIFT'}  [${r.id}] ${r.label}${r.ok ? '' : `  <- ${r.detail}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} 一致`)
  if (failed.length > 0) {
    console.log(`\n⚠ ${failed.length} 处漂移（文档与实现不符）：`)
    for (const f of failed) console.log(`  [${f.id}] ${f.label} —— 依据：${f.detail}`)
  }
}
process.exit(failed.length === 0 ? 0 : 1)
