/**
 * dsh-remote-agent 的浏览器半边（零依赖纯 JS，无 JSX/TS/import）。
 *
 * 两个插槽配对使用，这是 DSH 的标准"点侧栏图标打开面板"模式：
 *   - `sidebar.panellist`（list）：注册一个图标，id = 'dsh-remote-agent'
 *   - `main`（keyed）：注册面板，**key 必须等于那个 id** —— 点图标时 owner
 *     用该 id 去 main 里找对应面板。两边对不上就是"点了没反应"。
 *
 * 数据来源：fetch 本包 Host 半边注册的 `/api/remote-agent/ui/*` 路由。
 * 为什么不用别的通道：静态 bundle 的 client 半能拿到的 Client 服务只有
 * layout/sessions/slots/theme/timer/workspaces，**没有任何一个能读到远程节点或任务**；
 * 而 `host.call()` 属于动态包（cordis_run）机制。同 profile 的 dsh-context 与
 * dsh-better-sidebar 都是用 fetch 自己的路由，这是本机已验证可行的模式。
 *
 * 约束（来自 references/practices.md 与 ui-plugin.md）：
 *   - 不 import 任何 @deepseek-ai/* 客户端包（会随版本变，且无类型检查）
 *   - 只用 --dsw-alias-* 主题 token，不写死颜色（除图标本身的艺术色）
 *   - 不在组件外写 DOM；样式用 styles.insert 并随 apply 一起释放
 *   - 文本走 ctx.locale（此处未注册字典，直接给中文，避免引入未声明依赖）
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/remote-agent/ui'
    const PANEL_KEY = 'dsh-remote-agent'
    /**
     * 副机自己的状态端点。
     *
     * 副机**也有** webServer（实测监听 19387）—— 因为 `dsh-web-app` 是
     * 桌面版的基础 bundle。所以副机也能提供一个面板；而 worker 分支早就有
     * 这个端点（见 lib/node/index.js 的 STATUS_PATH）。
     *
     * 为什么需要它：`dsh.client` 是**包级声明**（loader 扫 package.json），
     * 装了插件就加载面板，**无法按 role 条件化**。而 UI 路由只在 hub 分支
     * 注册 —— 所以副机的面板原先必然全 404。
     *
     * 方案不是"藏掉 404"，而是**让副机面板显示它自己**：
     * 本机角色 / 连的哪个 hub / 任务队列 / roots / 连接状态。
     * 这些数据副机全都有（TaskStore 在它本地），原先只是没有 UI 暴露。
     */
    const STATUS_PATH = '/api/remote-agent/status'
    /**
     * 引导端点（未配置时的数据源）。
     *
     * 未配置时 `applyHub` 不跑（没有 `/ui/*` 那组路由），`applyWorkerBranch`
     * 也不跑 —— 只有 `lib/setup-routes.js` 注册的这组在。所以它是第三层回退。
     */
    const SETUP_STATE_PATH = '/api/remote-agent/setup/state'
    const SETUP_APPLY_PATH = '/api/remote-agent/setup/apply'

    /* ───────────────────────── 样式 ───────────────────────── */

    const CSS = [
      // ── 设计 token（vps-workbench §3 规范）──────────────────────────
      '.dra-root{',
      '--dra-surface-0:#05070d;--dra-surface-1:rgba(14,21,38,.85);--dra-surface-2:#0e1526;',
      '--dra-surface-3:rgba(26,35,56,.86);',
      '--dra-accent:#2ee6ff;--dra-ok:#25e58c;--dra-warn:#ffb525;--dra-danger:#ff4d6e;',
      '--dra-ink-1:#f4f8ff;--dra-ink-2:#cfdcef;--dra-ink-3:#a9bad6;--dra-ink-4:#8695b0;',
      '--dra-line-1:rgba(120,165,255,.14);--dra-line-2:rgba(120,165,255,.26);--dra-line-3:rgba(120,165,255,.42);',
      '--dra-r-xs:6px;--dra-r-sm:9px;--dra-r-md:13px;--dra-r-lg:18px;--dra-r-xl:24px;--dra-r-pill:999px;',
      '--dra-shadow-1:0 1px 2px rgba(0,0,0,.3),0 2px 8px -2px rgba(0,0,0,.2);',
      '--dra-shadow-2:0 2px 4px rgba(0,0,0,.25),0 8px 20px -4px rgba(0,0,0,.3),0 16px 40px -12px rgba(0,0,0,.4);',
      '--dra-shadow-3:0 2px 4px rgba(0,0,0,.25),0 8px 20px -4px rgba(0,0,0,.3),0 24px 48px -16px rgba(0,0,0,.5);',
      '--dra-gloss:inset 0 1px 0 rgba(255,255,255,.04);',
      '--dra-inset:inset 0 1px 2px rgba(0,0,0,.3);',
      "--dra-font-num:'JetBrains Mono','SF Mono',ui-monospace,monospace;",
      "--dra-font-ui:-apple-system,'SF Pro Text','PingFang SC','Segoe UI',system-ui,sans-serif;",
      '--dra-t-fast:140ms;--dra-t-base:260ms;--dra-t-slow:520ms;',
      '--dra-ease:cubic-bezier(.22,1,.36,1);',
      'font-family:var(--dra-font-ui);display:flex;flex-direction:column;height:100%;min-height:0;',
      'background:var(--dra-surface-0);color:var(--dra-ink-2);font-size:12px;line-height:1.5}',
      // ── 浅色主题 ──
      '.dra-root.dra-light{',
      '--dra-surface-0:#eef0f4;--dra-surface-1:#f7f8fa;--dra-surface-2:#ffffff;',
      '--dra-accent:#2f6bff;--dra-ok:#12a150;--dra-warn:#e08400;--dra-danger:#e5484d;',
      '--dra-ink-1:#0b0d10;--dra-ink-2:#3d4450;--dra-ink-3:#6f7885;--dra-ink-4:#9aa3b0;',
      '--dra-line-1:rgba(11,13,16,.06);--dra-line-2:rgba(11,13,16,.1);--dra-line-3:rgba(11,13,16,.16)}',
      // ── 关键帧动画（§6 规范）──
      '@keyframes draRiseIn{from{opacity:0;transform:translateY(20px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes draPopIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}',
      '@keyframes draPulse{0%,100%{box-shadow:0 0 0 2px rgba(37,229,140,.25),0 0 8px -1px var(--dra-ok)}50%{box-shadow:0 0 0 4px rgba(37,229,140,.15),0 0 14px -1px var(--dra-ok)}}',
      '@keyframes draMeterGrow{from{width:0;opacity:0}to{opacity:1}}',
      // ── 统计条（§5.1: .dra-statbar）──
      '.dra-statbar{display:flex;gap:0;padding:0 18px;',
      'background:var(--dra-surface-1);border-bottom:1px solid var(--dra-line-1);',
      'flex:0 0 auto;animation:draPopIn var(--dra-t-base) var(--dra-ease) 60ms both}',
      '.dra-stat{flex:1;display:flex;flex-direction:column;gap:2px;padding:10px 0 10px 18px;',
      'border-left:1px solid var(--dra-line-1);min-width:0}',
      '.dra-stat:first-child{border-left:0;padding-left:0}',
      '.dra-stat-n{font-size:21px;font-weight:700;color:var(--dra-accent);',
      "font-family:var(--dra-font-num);font-variant-numeric:tabular-nums;line-height:1.1;letter-spacing:-.02em}",
      '.dra-stat-l{font-size:10.5px;color:var(--dra-ink-4);text-transform:uppercase;letter-spacing:.06em}',
      // ── 工具栏 ──
      '.dra-head{display:flex;align-items:center;gap:6px;padding:10px 14px;',
      'border-bottom:1px solid var(--dra-line-1);flex:0 0 auto;flex-wrap:wrap}',
      '.dra-title{font-weight:700;font-size:14px;color:var(--dra-ink-1);letter-spacing:.02em}',
      '.dra-spacer{flex:1}',
      // ── 按钮（§4.2）──
      '.dra-btn{appearance:none;border:1px solid var(--dra-line-1);',
      'background:var(--dra-surface-2);color:var(--dra-ink-2);',
      'border-radius:var(--dra-r-sm);padding:0 13px;font-size:12.5px;height:30px;',
      'cursor:pointer;line-height:1;white-space:nowrap;',
      'transition:border-color var(--dra-t-fast) var(--dra-ease),background var(--dra-t-fast) var(--dra-ease),transform var(--dra-t-fast) var(--dra-ease),box-shadow var(--dra-t-fast) var(--dra-ease)}',
      '.dra-btn:hover{background:var(--dra-surface-3);border-color:var(--dra-accent);',
      'color:var(--dra-ink-1);transform:translateY(-1px);box-shadow:var(--dra-shadow-1)}',
      '.dra-btn:active{transform:translateY(.5px) scale(.985);box-shadow:none}',
      '.dra-btn:focus-visible{outline:2px solid var(--dra-accent);outline-offset:2px}',
      '.dra-btn[disabled]{opacity:.42;cursor:not-allowed;transform:none;box-shadow:none}',
      '.dra-btn.loading{opacity:.7;cursor:default;pointer-events:none}',
      '.dra-btn.primary{background:rgba(46,230,255,.1);border-color:var(--dra-accent);color:var(--dra-accent)}',
      '.dra-btn.primary:hover{background:rgba(46,230,255,.18);box-shadow:0 0 0 1px var(--dra-accent),var(--dra-shadow-1)}',
      '.dra-btn.danger{color:var(--dra-danger);border-color:rgba(255,77,110,.5)}',
      '.dra-btn.ghost{background:transparent;border-color:transparent;color:var(--dra-ink-3)}',
      '.dra-btn.ghost:hover{background:var(--dra-surface-3);border-color:var(--dra-line-1);color:var(--dra-ink-1)}',
      // ── 主体 ──
      '.dra-body{flex:1;min-height:0;overflow:auto;padding:12px 14px}',
      // ── 双列工作区布局 ──
      '.dra-workspace{display:grid;grid-template-columns:2fr 1fr;gap:14px;align-items:start;margin-top:10px}',
      '.dra-workspace-main{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dra-workspace-side{display:flex;flex-direction:column;min-width:0}',
      '.dra-side-card{background:var(--dra-s1);border:1px solid var(--dra-line);border-radius:var(--dra-r-lg);padding:14px 16px}',
      // 添加副机按钮：虚线 accent 边框
      '.dra-enroll-btn{width:100%;border-style:dashed !important;border-color:var(--dra-accent) !important;color:var(--dra-accent) !important;justify-content:center}',
      '.dra-enroll-card{background:var(--dra-s2);border:1px solid var(--dra-line2);border-radius:var(--dra-r-md);padding:12px 14px}',
      // 派发按钮：全宽 accent 色 + hover 发光
      '.dra-dispatch-btn{width:100%;justify-content:center;font-size:13px;font-weight:700;padding:9px 16px;margin-top:6px;background:var(--dra-accent);color:var(--dra-s0);border:none;border-radius:var(--dra-r-sm)}',
      '.dra-dispatch-btn:hover{box-shadow:0 0 16px -2px var(--dra-accent);transform:translateY(-1px)}',
      '.dra-dispatch-btn:active{transform:scale(.985)}',
      '.dra-dispatch-btn:disabled{opacity:.5;cursor:not-allowed;box-shadow:none;transform:none}',
      // 高级选项折叠
      '.dra-advanced{border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:6px 10px;margin-top:4px}',
      '.dra-advanced summary{list-style:none}',
      '.dra-advanced summary::-webkit-details-marker{display:none}',
      '.dra-advanced summary::before{content:"▸ ";color:var(--dra-i4)}',
      '.dra-advanced[open] summary::before{content:"▾ "}',
      // 响应式：窄屏单列
      '@media(max-width:720px){.dra-workspace{grid-template-columns:1fr}}',
      // ── 旧统计卡片（保留兼容，不再用于主渲染）──
      '.dra-cards{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
      '.dra-card{flex:1;min-width:90px;border:1px solid var(--dra-line-1);',
      'background:var(--dra-surface-2);border-radius:var(--dra-r-lg);padding:14px 16px;',
      'position:relative;overflow:hidden;box-shadow:var(--dra-gloss),var(--dra-shadow-1)}',
      '.dra-card-n{font-size:24px;font-weight:700;color:var(--dra-accent);',
      "font-family:var(--dra-font-num);font-variant-numeric:tabular-nums;line-height:1.1;letter-spacing:-.02em}",
      '.dra-card-l{font-size:10.5px;color:var(--dra-ink-4);margin-top:3px;text-transform:uppercase;letter-spacing:.06em}',
      // ── 区块标题 ──
      '.dra-sec{margin:14px 0 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dra-ink-4)}',
      '.dra-sub{margin:10px 0 4px;font-size:11px;font-weight:600;color:var(--dra-ink-4);opacity:.85}',
      // ── 节点卡片网格（§5.2 网格）──
      '.dra-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));',
      'gap:16px;margin:6px 0 16px;align-items:stretch}',
      // ── 节点卡片（§5.3 卡片内部结构）──
      '.dra-node-card{position:relative;background:var(--dra-surface-2);border-radius:var(--dra-r-lg);',
      'border:1px solid rgba(120,165,255,.24);padding:0;overflow:hidden;',
      'display:flex;flex-direction:column;',
      'box-shadow:var(--dra-gloss),var(--dra-shadow-1);',
      'animation:draRiseIn var(--dra-t-slow) var(--dra-ease) both;',
      'transition:border-color var(--dra-t-fast) var(--dra-ease),box-shadow var(--dra-t-fast) var(--dra-ease)}',
      '.dra-node-card:hover{border-color:rgba(120,165,255,.42);',
      'box-shadow:0 0 0 1.5px rgba(46,230,255,.25),var(--dra-shadow-2)}',
      // ── 左侧状态色带（§8.3: 3px rail）──
      '.dra-card-rail{position:absolute;left:0;top:10px;bottom:10px;width:3px;',
      'border-radius:var(--dra-r-pill);background:var(--dra-ink-4)}',
      '.dra-node-card.online .dra-card-rail{background:var(--dra-ok);box-shadow:0 0 8px -1px var(--dra-ok)}',
      '.dra-node-card.offline .dra-card-rail{background:var(--dra-danger);box-shadow:0 0 8px -1px var(--dra-danger)}',
      // ── 卡片头部（§5.3: cardHead）──
      '.dra-card-head{display:flex;align-items:center;gap:8px;min-width:0;',
      'padding:15px 18px 12px 22px}',
      '.dra-node-id{font-size:13px;font-weight:600;color:var(--dra-ink-1);',
      "font-family:var(--dra-font-num);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}",
      '.dra-node-badges{display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding:0 18px 0 22px}',
      // ── 卡片体（§5.3: cardBody）──
      '.dra-card-body{padding:14px 18px 18px 22px;display:flex;flex-direction:column;gap:15px;flex:1 1 auto}',
      // ── 指标列表（§5.3: metricList）──
      '.dra-metric-list{display:flex;flex-direction:column;gap:11px}',
      '.dra-metric-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11.5px}',
      '.dra-metric-label{color:var(--dra-ink-3);flex:0 0 auto}',
      '.dra-metric-value{color:var(--dra-ink-1);font-family:var(--dra-font-num);font-variant-numeric:tabular-nums;text-align:right}',
      // ── 资源进度条 ──
      '.dra-node-res{display:flex;align-items:center;gap:8px;font-size:11px}',
      '.dra-node-res .dra-dim{flex:0 0 28px;font-size:10.5px}',
      '.dra-meter{flex:1;height:5px;background:rgba(120,165,255,.1);border-radius:var(--dra-r-pill);overflow:hidden}',
      '.dra-meter-fill{height:100%;border-radius:var(--dra-r-pill);transition:width var(--dra-t-slow);',
      'animation:draMeterGrow var(--dra-t-slow) var(--dra-ease) both;box-shadow:0 0 6px -1px currentColor}',
      // ── 快捷操作行（§5.3: quickRow）──
      '.dra-quick-row{display:flex;gap:6px;flex-wrap:wrap}',
      // ── 卡片底栏（§5.3: cardFoot, margin-top:auto 推到底）──
      '.dra-card-foot{display:flex;justify-content:space-between;align-items:center;',
      'border-top:1px solid var(--dra-line-1);padding:8px 18px 8px 22px;margin-top:auto}',
      // ── 状态圆点 ──
      '.dra-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;',
      'background:var(--dsw-alias-state-idle-primary,currentColor);',
      'background:var(--dra-ink-4)}',
      '.dra-dot.on{background:var(--dra-ok);animation:draPulse 2.4s ease-in-out infinite}',
      // ── 文字工具类 ──
      '.dra-mono{font-family:var(--dra-font-num);font-variant-numeric:tabular-nums}',
      '.dra-dim{color:var(--dra-ink-4);font-size:11px}',
      '.dra-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // ── 徽章（§4.4）──
      '.dra-badge{font-size:11px;font-weight:600;padding:0 8px;height:20px;border-radius:var(--dra-r-pill);',
      'border:1px solid var(--dra-line-1);color:var(--dra-ink-3);white-space:nowrap;',
      'display:inline-flex;align-items:center;',
      'font-variant-numeric:tabular-nums}',
      '.dra-badge.run{color:var(--dra-accent);border-color:var(--dra-accent);background:rgba(46,230,255,.08);',
      'box-shadow:inset 0 0 0 1px rgba(46,230,255,.4),0 0 12px -4px rgba(46,230,255,.5)}',
      '.dra-badge.ok{color:var(--dra-ok);border-color:var(--dra-ok);background:rgba(37,229,140,.08);',
      'box-shadow:inset 0 0 0 1px rgba(37,229,140,.4),0 0 12px -4px rgba(37,229,140,.45)}',
      '.dra-badge.err{color:var(--dra-danger);border-color:var(--dra-danger);background:rgba(255,77,110,.08);',
      'box-shadow:inset 0 0 0 1px rgba(255,77,110,.4),0 0 12px -4px rgba(255,77,110,.45)}',
      // ── 日志/代码块 ──
      '.dra-pre{margin:6px 0 0;padding:10px 12px;border-radius:var(--dra-r-sm);overflow:auto;max-height:220px;',
      'border:1px solid var(--dra-line-1);background:#02040a;color:var(--dra-ink-2);',
      "font-size:11.5px;white-space:pre-wrap;word-break:break-word;font-family:var(--dra-font-num)}",
      // ── 错误/警告框 ──
      '.dra-err{margin:8px 0;padding:9px 12px;border-radius:var(--dra-r-sm);font-size:12px;',
      'border:1px solid rgba(255,77,110,.4);background:rgba(255,77,110,.07);color:var(--dra-danger)}',
      '.dra-warn{margin:8px 0;padding:9px 12px;border-radius:var(--dra-r-sm);font-size:12px;',
      'border:1px solid rgba(255,181,37,.4);background:rgba(255,181,37,.07);color:var(--dra-warn)}',
      // ── 表单控件（§4.3）──
      '.dra-form{display:flex;flex-direction:column;gap:6px;margin:8px 0 4px}',
      '.dra-in,.dra-ta,.dra-sel{width:100%;box-sizing:border-box;border-radius:var(--dra-r-sm);',
      'border:1px solid var(--dra-line-1);background:var(--dra-surface-1);color:var(--dra-ink-2);',
      'padding:6px 10px;font-size:12px;font-family:inherit;box-shadow:var(--dra-inset);',
      'transition:border-color var(--dra-t-fast) var(--dra-ease)}',
      '.dra-in:focus,.dra-ta:focus,.dra-sel:focus{outline:none;border-color:var(--dra-accent);',
      'box-shadow:var(--dra-inset),0 0 0 2px rgba(46,230,255,.1)}',
      '.dra-ta{min-height:64px;resize:vertical}',
      '.dra-actions{display:flex;gap:8px;align-items:center;margin-top:2px}',
      '.dra-empty{color:var(--dra-ink-4);padding:14px 2px;font-size:12px}',
      '.dra-file{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px}',
      // ── 设置区键值行 ──
      '.dra-kv{display:flex;gap:10px;padding:6px 0;align-items:baseline;border-bottom:1px solid var(--dra-line-1)}',
      '.dra-kv:last-of-type{border-bottom:0}',
      '.dra-k{flex:0 0 auto;min-width:92px;color:var(--dra-ink-4);font-size:11.5px}',
      '.dra-hint{margin-top:8px;padding:9px 12px;border-radius:var(--dra-r-sm);font-size:11.5px;',
      'background:var(--dra-surface-1);color:var(--dra-ink-3);border:1px solid var(--dra-line-1)}',
      // ── 引导视图 ──
      '.dra-choices{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 4px}',
      '.dra-choice{flex:1;min-width:150px;text-align:left;cursor:pointer;appearance:none;',
      'border:1px solid var(--dra-line-1);background:var(--dra-surface-2);color:var(--dra-ink-2);',
      'border-radius:var(--dra-r-lg);padding:16px 18px;',
      'transition:border-color var(--dra-t-fast) var(--dra-ease),background var(--dra-t-fast) var(--dra-ease)}',
      '.dra-choice:hover{border-color:var(--dra-accent);background:var(--dra-surface-3)}',
      '.dra-choice-t{font-size:15px;font-weight:700;color:var(--dra-ink-1);margin-bottom:6px}',
      '.dra-choice-d{font-size:12px;color:var(--dra-ink-3);line-height:1.5}',
      '.dra-input{flex:1;min-width:0;appearance:none;border:1px solid var(--dra-line-1);',
      'background:var(--dra-surface-1);color:var(--dra-ink-2);border-radius:var(--dra-r-sm);',
      'padding:5px 9px;font-size:12px;font-family:inherit;box-shadow:var(--dra-inset)}',
      '.dra-input:focus{outline:none;border-color:var(--dra-accent);box-shadow:var(--dra-inset),0 0 0 2px rgba(46,230,255,.1)}',
      '.dra-ok{padding:9px 12px;border-radius:var(--dra-r-sm);margin-bottom:10px;font-size:12px;',
      'background:rgba(37,229,140,.08);color:var(--dra-ok);border:1px solid rgba(37,229,140,.3)}',
      // ── 模板行 ──
      '.dra-tplrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 0 2px;margin-bottom:2px}',
      '.dra-tplrow .dra-sel{flex:1 1 150px;width:auto;min-width:130px}',
      '.dra-tplrow .dra-in{flex:1 1 120px;min-width:110px}',
      '.dra-tplrow .dra-btn{flex:0 0 auto}',
      '.dra-tplnote{font-size:11px;color:var(--dra-ink-4);padding:2px 0 4px;flex:1 1 100%}',
      // ── 可折叠区块 ──
      '.dra-fold{border:1px solid var(--dra-line-1);border-radius:var(--dra-r-lg);margin:10px 0;background:var(--dra-surface-2);overflow:hidden}',
      '.dra-fold>summary{padding:9px 14px;cursor:pointer;font-size:12px;font-weight:600;color:var(--dra-ink-3);',
      'list-style:none;user-select:none;display:flex;align-items:center;gap:6px}',
      '.dra-fold>summary::-webkit-details-marker{display:none}',
      ".dra-fold>summary::before{content:'\u25B8';font-size:10px;opacity:.7;transition:transform var(--dra-t-fast) var(--dra-ease)}",
      '.dra-fold[open]>summary::before{transform:rotate(90deg)}',
      '.dra-fold>summary:hover{background:var(--dra-surface-3)}',
      '.dra-fold-b{padding:4px 14px 14px}',
      '.dra-fold .dra-sec{margin:8px 0 4px;font-size:10px}',
      // ── 任务行 ──
      '.dra-task-row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;',
      'border-radius:var(--dra-r-sm);border:1px solid transparent;cursor:pointer;',
      'transition:background var(--dra-t-fast) var(--dra-ease);margin-bottom:2px}',
      '.dra-task-row:hover{background:var(--dra-surface-3)}',
      '.dra-task-row.sel{border-color:var(--dra-accent);background:var(--dra-surface-2)}',
      '.dra-task-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dra-task-goal{font-size:12px;color:var(--dra-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-task-sub{font-size:10.5px;color:var(--dra-ink-4)}',
      '.dra-task-prog{font-size:10.5px;color:var(--dra-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
    ].join('')

    /* ───────────────────────── 数据层 ───────────────────────── */

    function apiGet(p) {
      return fetch(API + p, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {} }).then(function (b) {
          throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
        })
        return r.json()
      })
    }

    /**
     * 拉一个**绝对路径**（不以 API 前缀开头）。
     *
     * 用途：副机的状态端点在 `/api/remote-agent/status`，**不在**
     * `/api/remote-agent/ui` 前缀下 —— 它是 worker 分支注册的
     * （见 lib/node/index.js 的 STATUS_PATH），与 hub 的 UI 路由是两套。
     *
     * 错误处理与 apiGet 一致：非 2xx 时优先用响应体里的 message/error，
     * 否则报 HTTP 码。**不吞错误** —— 调用方要能据此判断"端点不存在"。
     */
    function apiGetPath(fullPath) {
      return fetch(fullPath, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {} }).then(function (b) {
          throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
        })
        return r.json()
      })
    }

    function apiPost(p, body) {
      return fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().catch(function () { return {} }).then(function (b) {
          if (!r.ok) throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
          return b
        })
      })
    }

    /** 复制到剪贴板：优先 clipboard API，降级 execCommand（Electron 内嵌页两者都试）。 */
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(function () { return true })
        }
      } catch { /* 走降级 */ }
      return new Promise(function (resolve, reject) {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(ta)
          ok ? resolve(true) : reject(new Error('copy failed'))
        } catch (e) { reject(e) }
      })
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    /**
     * 样式标签：**静态 bundle 的唯一正确注入方式**。
     *
     * 为什么不能只靠 ctx.get('styles').insert()：
     *   `styles` 是 **dynamic lane**（cordis-client-runner 闭包）的 builtin，
     *   静态 bundle（window.__ModuleLoader__ factory 形式）的 ctx 上没有这个服务 ——
     *   实测 ctx.get('styles') 返回 undefined，CSS 永远不会被注入，
     *   面板退化成无样式（.dra-root 拿不到 display:flex，字号回落 16px）。
     *
     * 官方给静态 bundle 的指引是"Component-local styles can render as React
     * elements so unmounting removes them"（references/practices.md）。所以这里把
     * <style> 作为 React 元素渲染：随组件挂载生效、随卸载自动移除，
     * 既不在组件外写 DOM，也不需要手动释放。
     *
     * 两处都保留：动态 lane 走 styles.insert（apply 里），静态 lane 走本组件。
     * 同时存在时只是多一份同内容样式，选择器相同，无副作用。
     */
    function StyleTag() {
      return h('style', { key: 'dra-css' }, CSS)
    }

    function Dot(props) {
      return h('span', { className: 'dra-dot' + (props.on ? ' on' : ''), title: props.on ? '在线' : '离线' })
    }

    function StatusBadge(props) {
      const s = props.status || 'unknown'
      let cls = 'dra-badge'
      if (s === 'running' || s === 'queued') cls += ' run'
      else if (s === 'completed') cls += ' ok'
      else if (s === 'failed') cls += ' err'
      return h('span', { className: cls }, s)
    }

    function fmtTime(ms) {
      if (!ms) return ''
      try { return new Date(ms).toLocaleTimeString() } catch { return '' }
    }

    function fmtDur(ms) {
      if (typeof ms !== 'number' || ms < 0) return ''
      if (ms < 1000) return ms + 'ms'
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
      return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
    }

    /* ───────────────────────── 侧栏图标 ───────────────────────── */

    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        // 两个屏幕 + 中间一条连线：远程同事的直白隐喻
        h('rect', { x: 2, y: 4, width: 8, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 13, width: 8, height: 7, rx: 1.5 }),
        h('path', { d: 'M10 7.5h2.5a1.5 1.5 0 0 1 1.5 1.5v4' }),
      )
    }

    /* ───────────────────────── 引导视图（未配置）───────────────────────── */

    /**
     * 首次安装的引导：让用户选"这台电脑是主机还是副机"。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * 为什么要有这一屏
     * ═══════════════════════════════════════════════════════════════════════
     *
     * 插件**无法自己判断**角色 —— 只有用户知道。原实现让包内默认值取 `hub`，
     * 于是副机装完会以 hub 身份启动（注册一个 nodeToken 为空、不校验凭证的
     * 直连端点），而且面板不会给任何提示（它以为自己配好了）。
     *
     * 现在 `role` 默认为空，未配置时显示这一屏：两个按钮，选完写盘、重启生效。
     *
     * ── 三种选择 ──────────────────────────────────────────────────────────
     *   我是主机 → 只写 `role: hub`，然后显示配对码给副机用
     *   我是副机 → 填主机地址（或粘配对码）+ 工作区，写 `role: worker`
     *   同机自测 → 写 `role: both`（单机验证用）
     */

    /**
     * 工作区共享面板（2026-10-17）。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * 这是什么
     * ═══════════════════════════════════════════════════════════════════════
     *
     * 把副机的一个工作区目录通过 SMB 共享出去，主机 `net use X: \\副机\dsh-work`
     * 映射成盘符 —— 这样可以用本地 IDE 直接打开副机的项目。
     *
     * ═══════════════════════════════════════════════════════════════════════
     * ⚠ 为什么这个面板的 UI 必须"啰嗦"
     * ═══════════════════════════════════════════════════════════════════════
     *
     * 这是本插件**唯一主动放宽安全边界**的功能。开启后：
     *   · roots / denyPaths 全部失效（Windows 内核直读，插件拦不住）
     *   · 「清单先于字节」失效（.env / .git 密钥 / 中间产物全部对主机可见）
     *   · 新增凭证面（主机需要副机 Windows 账号）
     *
     * 所以按用户要求做**二次确认**：
     *   1. 点「共享工作区」→ 先展示风险说明 + 只读/读写选择
     *   2. 必须勾选「我知道风险」才能点「生成共享命令」
     *   3. 生成后给**可复制的命令**（需要管理员，本插件不代执行）
     *
     * 写权限（read/write）默认 read，选 write 要再确认一次 —— 最小权限原则。
     */
    function SharePanel(props) {
      const nodes = (props.nodes || []).filter(function (n) { return n.online })
      const nodeS = React.useState(nodes.length > 0 ? nodes[0].nodeId : '')
      const nodeId = nodeS[0]
      const setNodeId = nodeS[1]

      // ── 要共享哪个目录（2026-10-17 修 v0.9.0 审查 H2）────────────────
      //
      // 原实现**恒定发送 `dir: ''`** —— 面板里根本没有选择目录的 UI，
      // 而副机侧 `if (dir === '') reply ok:false 'plan 需要 dir'` 按设计拒绝。
      // 于是「生成共享命令」**100% 失败**，SMB 共享的唯一主动作完全不可用。
      //
      // 数据源现成：`nodeView` 一直透出 `roots`（views.js 的 `roots: [...]`），
      // 那是副机的安全边界，也正是该共享的目录。这里做下拉，默认第一项。
      //
      // 目录随 `plan` 一起发；副机侧仍会 `resolveWorkspace` 校验它在 roots 内
      // （面板给的只是候选，真正的边界判定在副机）。
      const nodeRoots = (function () {
        const n = nodes.filter(function (x) { return x.nodeId === nodeId })[0]
        const rs = n && Array.isArray(n.roots) ? n.roots.filter(function (r) { return typeof r === 'string' && r !== '' }) : []
        return rs
      })()
      const dirS = React.useState(nodeRoots.length > 0 ? nodeRoots[0] : '')
      const shareDir = dirS[0]
      const setShareDir = dirS[1]

      const accessS = React.useState('read')
      const access = accessS[0]
      const setAccess = accessS[1]
      const ackS = React.useState(false)
      const ack = ackS[0]
      const setAck = ackS[1]
      const busyS = React.useState(false)
      const busy = busyS[0]
      const setBusy = busyS[1]
      const noteS = React.useState('')
      const note = noteS[0]
      const setNote = noteS[1]
      const planS = React.useState(null)
      const plan = planS[0]
      const setPlan = planS[1]
      const probeS = React.useState(null)
      const probe = probeS[0]
      const setProbe = probeS[1]

      function doProbe() {
        if (nodeId === '') return
        apiGet('/share?node=' + encodeURIComponent(nodeId))
          .then(function (r) { setProbe(r || null) })
          .catch(function (e) { setNote('探测失败：' + ((e && e.message) || e)) })
      }

      function doPlan() {
        // dir 是**必填**（副机侧拒绝空目录）。面板已在上面从 node.roots 取到
        // 候选并默认选第一项；这里再守一道，防止 roots 为空的极端情况。
        if (nodeId === '' || !ack || shareDir === '') return
        setBusy(true)
        setNote('')
        apiPost('/share', {
          action: 'plan',
          node: nodeId,
          dir: shareDir,
          access: access,
          confirm: 'yes',
        })
          .then(function (r) {
            if (r && r.ok) { setPlan(r); setNote('') } else { setNote((r && r.message) || '生成失败') }
          })
          .catch(function (e) { setNote('生成失败：' + ((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      const warnBox = h('div', { className: 'dra-err', style: { marginBottom: '8px' } },
        h('div', { style: { fontWeight: '600', marginBottom: '4px' } },
          '⚠ 开启共享会绕过本插件的安全边界'),
        h('div', null, '共享出去的文件由 Windows 内核直接读写，本插件**无法**再拦：'),
        h('div', { className: 'dra-dim', style: { marginLeft: '12px' } },
          '· roots / denyPaths 全部失效'),
        h('div', { className: 'dra-dim', style: { marginLeft: '12px' } },
          '· 中间产物、日志、.env、.git 里的密钥全部对主机可见'),
        h('div', { className: 'dra-dim', style: { marginLeft: '12px' } },
          '· 主机需要副机的 Windows 账号（新增凭证面）'),
        h('div', { style: { marginTop: '4px' } },
          '只共享工作区目录，别共享整个盘。'),
      )

      if (nodes.length === 0) {
        return h('div', null,
          h('div', { className: 'dra-sec' }, '工作区共享（SMB）'),
          h('div', { className: 'dra-empty' }, '没有在线副机 —— 共享需要在副机上开启。'),
        )
      }

      return h('div', null,
        h('div', { className: 'dra-sec' }, '工作区共享（SMB）'),
        h('div', { className: 'dra-dim', style: { marginBottom: '8px' } },
          '把副机的工作区映射成本地盘（net use X: \\\\副机\\...），可以用本地 IDE 直接打开。'),
        warnBox,

        h('div', { className: 'dra-row' },
          h('span', { className: 'dra-k' }, '副机'),
          h('select', {
            className: 'dra-in',
            value: nodeId,
            onChange: function (e) {
              // 换副机 → 目录候选也要换（roots 是每台机器自己的），
              // 顺带清掉上一次的 plan/probe 结果（否则会显示别人的共享命令）。
              const nextId = e.target.value
              setNodeId(nextId)
              setPlan(null)
              setProbe(null)
              const n = nodes.filter(function (x) { return x.nodeId === nextId })[0]
              const rs = n && Array.isArray(n.roots) ? n.roots.filter(function (r) { return typeof r === 'string' && r !== '' }) : []
              setShareDir(rs.length > 0 ? rs[0] : '')
              setAck(false)
            },
          }, nodes.map(function (n) {
            return h('option', { key: n.nodeId, value: n.nodeId }, n.nodeId)
          })),
          h('button', { className: 'dra-btn', disabled: busy, onClick: doProbe }, '探测当前状态'),
        ),

        // ── 要共享哪个目录（2026-10-17 修 H2）────────────────────────────
        //
        // 数据源是副机的 roots —— 那是它的安全边界，也正是该共享的目录。
        // 没有 roots 时（旧副机 / 未配置）退回可手填的输入框。
        h('div', { className: 'dra-row' },
          h('span', { className: 'dra-k' }, '共享目录'),
          nodeRoots.length > 0
            ? h('select', {
              className: 'dra-in',
              value: shareDir,
              onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
            }, nodeRoots.map(function (r) {
              return h('option', { key: r, value: r }, r)
            }))
            : h('input', {
              className: 'dra-in',
              placeholder: '副机工作区绝对路径（如 D:\\work），需在副机 roots 内',
              value: shareDir,
              onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
            }),
        ),
        nodeRoots.length === 0
          ? h('div', { className: 'dra-dim', style: { marginLeft: '20px' } },
            '这台副机没上报 roots —— 请先确认它已配置工作区（工作区共享只允许 roots 内的目录）。')
          : h('div', { className: 'dra-dim', style: { marginLeft: '20px' } },
            '只共享这一个目录，不要共享整个盘。'),

        probe
          ? h('div', { className: 'dra-dim', style: { marginLeft: '20px' } },
            probe.ok === false
              ? ('探测失败：' + (probe.message || ''))
              : ('管理员：' + (probe.admin ? '是' : '否（生成命令后需用管理员 PowerShell 执行）')
                + ' ｜ 已有 dsh-work 共享：' + ((probe.shares || []).length || 0) + ' 个'))
          : null,

        h('div', { className: 'dra-row' },
          h('span', { className: 'dra-k' }, '权限'),
          h('select', {
            className: 'dra-in',
            value: access,
            onChange: function (e) { setAccess(e.target.value); setPlan(null) },
          },
            h('option', { value: 'read' }, '只读（主机能看、不能改）—— 推荐'),
            h('option', { value: 'write' }, '读写（主机能看能改）'),
          ),
        ),
        access === 'write'
          ? h('div', { className: 'dra-dim', style: { marginLeft: '20px', color: 'var(--dsw-alias-state-error-primary, currentColor)' } },
            '⚠ 读写模式下主机可以修改/删除副机的文件。')
          : null,

        h('div', { className: 'dra-row', style: { marginTop: '8px' } },
          h('input', {
            type: 'checkbox',
            checked: ack,
            onChange: function (e) { setAck(e.target.checked) },
          }),
          h('span', { className: 'dra-dim' }, '我知道上面的风险，确认开启共享'),
        ),
        h('div', { className: 'dra-actions' },
          h('button', {
            className: 'dra-btn',
            // shareDir 为空时也要禁用 —— 副机按设计拒绝空 dir，
            // 不禁用只会让用户点了才看到"生成失败"（v0.9.0 的 H2 就是这样）。
            disabled: busy || !ack || nodeId === '' || shareDir.trim() === '',
            onClick: doPlan,
          }, busy ? '生成中…' : '生成共享命令'),
          note ? h('span', { className: 'dra-dim' }, note) : null,
        ),

        plan && plan.ok
          ? h('div', { style: { marginTop: '8px' } },
            h('div', { className: 'dra-sec' }, '① 在副机上执行（需要管理员 PowerShell）'),
            h('pre', {
              className: 'dra-mono',
              style: {
                background: 'var(--dsw-alias-bg-layer-2)',
                padding: '8px',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            }, plan.shareCommand),
            h('div', { className: 'dra-dim' }, '共享名：' + plan.shareName
              + ' ｜ 目录：' + plan.dir + ' ｜ 权限：' + (plan.access === 'write' ? '读写' : '只读')),

            h('div', { className: 'dra-sec' }, '② 在主机上映射（普通 PowerShell 即可）'),
            h('pre', {
              className: 'dra-mono',
              style: {
                background: 'var(--dsw-alias-bg-layer-2)',
                padding: '8px',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            }, plan.mountCommand),
            h('div', { className: 'dra-dim' },
              '执行后主机上会出现 X: 盘，就是副机的 ' + plan.dir + '。'),
          )
          : null,
      )
    }

    function SetupView(props) {
      const cur = (props.setup && props.setup.current) || {}
      const patchFile = (props.setup && props.setup.patchFile) || ''
      // switching = "改角色"（已配置）而不是"初次配"（未配置）。
      // 差别只在文案、默认值、以及多一个「取消」—— 写盘逻辑完全共用。
      const switching = props.switching === true

      // step: 'choose' | 'hub' | 'worker'
      // switching 时默认落在「选择」页（因为目的就是改选择）
      const s1 = React.useState('choose')
      const step = s1[0]
      const setStep = s1[1]

      const f1 = React.useState({
        hubUrl: cur.hubUrl || '',
        relayUrl: cur.relayUrl || '',
        nodeId: cur.nodeId || '',
        roots: (cur.roots && cur.roots.length ? cur.roots.join(', ') : defaultRootsHint()),
        transportMode: cur.transportMode === 'relay' ? 'relay' : 'direct',
        pair: '',
      })
      const f = f1[0]
      const setF = f1[1]

      // 高级选项折叠（2026-10-17，开箱即用）：节点 ID 默认取主机名，
      // 90% 的用户不需要改它。折叠起来少一个"必须理解"的字段。
      const advS = React.useState(false)
      const showAdv = advS[0]
      const setShowAdv = advS[1]

      const b1 = React.useState(false)
      const busy = b1[0]
      const setBusy = b1[1]

      const m1 = React.useState('')
      const note = m1[0]
      const setNote = m1[1]

      const r1 = React.useState(null)
      const result = r1[0]
      const setResult = r1[1]

      // 手写配置冲突：服务端返回 409 + error:'handwritten-conflict'。
      // 这时**不是失败**，而是需要用户确认"替换手写的那条" —— 面板据此
      // 显示一个明确的按钮，而不是把错误文案丢给用户自己琢磨。
      const c1 = React.useState(null)
      const conflict = c1[0]
      const setConflict = c1[1]

      function set(k, v) {
        setF(function (prev) { const n = Object.assign({}, prev); n[k] = v; return n })
      }

      // ── 工作区默认值（2026-10-17，开箱即用）──────────────────────────
      //
      // 此前工作区是**空**的，必须用户自己填一个绝对路径。小白不知道填什么：
      // 填相对路径会被拒（roots 必须是绝对路径）、填 `C:\` 太宽（安全边界）、
      // 填一个不存在的目录任务会全报 workspace-denied。
      //
      // 现在给一个**安全且大概率可用**的默认值：
      //   · Windows → `D:\work`（有 D 盘用 D，没有用 C:\Users\<name>\work）
      //   · 其他    → `~/work`
      //
      // 这只是**表单预填**，真正的目录创建由服务端在写入配置时做（见
      // setup-routes 的 ensureRoots）—— 面板不该直接碰文件系统。
      //
      // 注意：不能写 `C:\` 或 `~` 这种"整盘/整家目录"的默认值 ——
      // roots 是安全边界，默认值必须是个**具体子目录**。
      function defaultRootsHint() {
        // 面板跑在浏览器里，拿不到服务端的 os.homedir()。
        // 用 userAgent 判平台足够（这是预填提示，不是安全判定）。
        try {
          const ua = (navigator && navigator.userAgent) || ''
          if (/Windows/i.test(ua)) return 'D:\\work'
          if (/Mac/i.test(ua)) return '~/work'
          return '~/work'
        } catch {
          return ''
        }
      }

      // 粘贴配对码时自动解出 hubUrl / relayUrl / nodeId
      // 码的格式见 lib/pairing.js（dshra1:// + base64url(JSON)）。
      function applyPair(code) {
        set('pair', code)
        const raw = String(code || '').trim()
        const m = /^dshra1:\/\/([A-Za-z0-9_-]+)$/.exec(raw)
        if (!m) return
        try {
          let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
          while (b64.length % 4 !== 0) b64 += '='
          // atob 在浏览器里可用；中文要转 UTF-8
          const json = decodeURIComponent(escape(window.atob(b64)))
          const d = JSON.parse(json)
          setF(function (prev) {
            const n = Object.assign({}, prev)
            if (typeof d.hubUrl === 'string') { n.hubUrl = d.hubUrl; n.transportMode = 'direct' }
            if (typeof d.relayUrl === 'string') { n.relayUrl = d.relayUrl; n.transportMode = 'relay' }
            if (typeof d.nodeId === 'string') n.nodeId = d.nodeId
            return n
          })
          setNote('已从配对码解析出连接信息')
        } catch {
          setNote('配对码解析失败，请检查是否完整复制')
        }
      }

      function submit(role, opts) {
        if (busy) return
        const force = opts && opts.force === true
        setBusy(true)
        setNote('')
        setConflict(null)
        const body = { role: role }
        if (force) body.force = true
        if (role === 'worker') {
          body.transportMode = f.transportMode
          body.hubUrl = f.hubUrl
          body.relayUrl = f.relayUrl
          body.nodeId = f.nodeId
          body.roots = String(f.roots || '').split(/[,\n]/).map(function (x) { return x.trim() }).filter(Boolean)
        }
        fetch(SETUP_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (b) {
              if (r.ok) return b
              // 409 + handwritten-conflict：不是失败，是需要用户确认
              if (r.status === 409 && b && b.error === 'handwritten-conflict') {
                const e = new Error(b.message || '配置里有手写条目')
                e.conflict = true
                e.role = role
                throw e
              }
              throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
            })
          })
          .then(function (b) { setResult(b); setNote('') })
          .catch(function (err) {
            if (err && err.conflict) {
              setConflict({ message: err.message, role: err.role })
              setNote('')
            } else {
              setNote('写入失败：' + (err.message || err))
            }
          })
          .then(function () { setBusy(false) })
      }

      const head = h('div', { className: 'dra-head' },
        h('span', { className: 'dra-title' }, '远程同事'),
        h('span', { className: 'dra-dim' }, switching ? ('当前：' + (cur.role || '未配置')) : '未配置'),
        h('span', { className: 'dra-spacer' }),
        switching && typeof props.onCancel === 'function'
          ? h('button', { className: 'dra-btn', onClick: props.onCancel }, '取消')
          : null,
      )

      // ── 写完后的结果页 ──
      if (result) {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          head,
          h('div', { className: 'dra-body' },
            h('div', { className: 'dra-ok' }, '✓ 已写入配置'),
            h('div', { className: 'dra-kv' }, h('span', { className: 'dra-k' }, '角色'), h('span', null, result.role)),
            h('div', { className: 'dra-kv' }, h('span', { className: 'dra-k' }, '配置文件'), h('span', { className: 'dra-mono dra-ell', title: result.file }, result.file || '')),
            result.backup ? h('div', { className: 'dra-kv' }, h('span', { className: 'dra-k' }, '备份'), h('span', { className: 'dra-mono dra-ell', title: result.backup }, result.backup)) : null,
            h('div', { className: 'dra-sec' }, '下一步'),
            // ── 编号步骤（2026-10-20，体验提升 ③）─────────────────────
            //
            // 原来只有一句"重启 DSH 后生效"，用户不知道接下来分几步、
            // 每步做什么、做完该看到什么。
            //
            // 现在给明确的编号流程，**每步一个动作 + 一个"你应该看到什么"**：
            // 用户卡住时能立刻判断自己停在哪一步。
            h('div', { style: { paddingLeft: '4px' } },
              h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                h('span', { className: 'dra-badge' }, '1'),
                h('span', { style: { flex: '1' } }, '重启 DSH'),
                h('span', { className: 'dra-dim' }, '必须'),
              ),
              h('div', { className: 'dra-dim', style: { paddingLeft: '28px', marginBottom: '6px' } },
                '关掉 DSH 窗口再打开。配置只在启动时读取。'),

              result.role === 'hub'
                ? h('div', null,
                  h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                    h('span', { className: 'dra-badge' }, '2'),
                    h('span', { style: { flex: '1' } }, '生成配对码'),
                  ),
                  h('div', { className: 'dra-dim', style: { paddingLeft: '28px', marginBottom: '6px' } },
                    '重启后这个面板会出现「副机接入」按钮 —— 点它，复制那行 dshra1:// 开头的码。'),

                  h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                    h('span', { className: 'dra-badge' }, '3'),
                    h('span', { style: { flex: '1' } }, '在副机上粘贴'),
                  ),
                  h('div', { className: 'dra-dim', style: { paddingLeft: '28px', marginBottom: '6px' } },
                    '副机也装本插件 → 打开面板 → 把码粘进「配对码」框 → 保存 → 重启副机 DSH。'),

                  h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                    h('span', { className: 'dra-badge' }, '4'),
                    h('span', { style: { flex: '1' } }, '等它连上'),
                  ),
                  h('div', { className: 'dra-dim', style: { paddingLeft: '28px' } },
                    '回到这个面板 —— 「在线节点」会从 0 变成 1。',
                    '若一直是 0，看「节点」区：那里会显示最后一次连接失败的原因和修法。'),
                )
                : h('div', null,
                  h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                    h('span', { className: 'dra-badge' }, '2'),
                    h('span', { style: { flex: '1' } }, '确认连上了主机'),
                  ),
                  h('div', { className: 'dra-dim', style: { paddingLeft: '28px' } },
                    '重启后打开这个面板 —— 应显示「本机状态」而不是引导页。',
                    '若又回到引导页，说明配置被覆盖了：看「最近一次错误」和日志尾巴。'),
                ),
            ),
          ),
        )
      }

      // ── 选择页 ──
      if (step === 'choose') {
        const card = function (title, desc, onClick, key) {
          return h('button', {
            key: key,
            className: 'dra-choice',
            onClick: onClick,
          },
            h('div', { className: 'dra-choice-t' }, title),
            h('div', { className: 'dra-choice-d' }, desc),
          )
        }
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          head,
          h('div', { className: 'dra-body' },
            h('div', { className: 'dra-sec' }, switching ? '改成什么角色？' : '这台电脑要做什么？'),
            // 判断提示（2026-10-20，体验提升 ③）：用户第一次打开时不知道选哪个。
            // 实测最常见的困惑是"我要在另一台电脑上跑任务，那我这台算什么？"
            switching
              ? null
              : h('div', { className: 'dra-dim', style: { marginBottom: '10px' } },
                '通常：你现在用的这台（你在这里操作 DSH 的）= 主机；',
                '另一台要被派活的电脑 = 副机。'),
            // 提示放在卡片**上方**：用户点完按钮后的反馈必须紧邻按钮，
            // 否则会被滚动位置藏在折叠线以下（实测踩过）。
            note ? h('div', { className: 'dra-err', style: { marginBottom: '8px' } }, note) : null,
            h('div', { className: 'dra-choices' },
              card('我是主机', '派活方 —— 给别的电脑派任务，看结果', function () { setStep('hub') }, 'h'),
              card('我是副机', '干活方 —— 接收并执行主机派来的任务', function () { setStep('worker') }, 'w'),
            ),
            h('div', { className: 'dra-sec' }, '或者'),
            h('div', { className: 'dra-row' },
              h('button', { className: 'dra-btn', onClick: function () { submit('both') }, disabled: busy }, '同机自测（both）'),
              h('span', { className: 'dra-dim' }, '单机验证用：既是主机又是副机'),
            ),
            // 手写配置冲突：给出**明确的动作**，而不是让用户自己琢磨。
            // 这是可预期的状态（用户早先手改过 YAML），不是故障。
            conflict
              ? h('div', { className: 'dra-warn' },
                h('div', null, conflict.message),
                h('div', { style: { marginTop: '8px' } },
                  h('button', {
                    className: 'dra-btn',
                    disabled: busy,
                    onClick: function () { submit(conflict.role, { force: true }) },
                  }, busy ? '写入中…' : '替换手写配置并写入'),
                ),
                h('div', { className: 'dra-dim', style: { marginTop: '6px' } },
                  '会先把那段手写的 remote-agent 条目（连同它上方的注释）删掉，再写托管块。原文件已备份。'),
              )
              : null,
            patchFile ? h('div', { className: 'dra-dim', style: { marginTop: '14px' } }, '配置将写入：' + patchFile) : null,
            h('div', { className: 'dra-dim', style: { marginTop: '6px' } }, '写入前会自动备份原文件。'),
            switching
              ? h('div', { className: 'dra-dim', style: { marginTop: '6px' } }, '切换会同时改写 inject（角色不同，依赖的服务不同），所以你不用手动改两处。')
              : null,
          ),
        )
      }

      // ── 主机：确认 + 提示配对码 ──
      if (step === 'hub') {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          head,
          h('div', { className: 'dra-body' },
            h('div', { className: 'dra-sec' }, '配置为主机'),
            h('div', { className: 'dra-empty' }, '本机会派活给副机，并提供一个 Web 面板。副机通过配对码接入（下一步会显示）。'),
            // 提示在按钮上方（同 worker 表单的理由）
            note ? h('div', { className: 'dra-err', style: { marginTop: '12px' } }, note) : null,
            conflict
              ? h('div', { className: 'dra-warn' },
                h('div', null, conflict.message),
                h('div', { style: { marginTop: '8px' } },
                  h('button', {
                    className: 'dra-btn',
                    disabled: busy,
                    onClick: function () { submit(conflict.role, { force: true }) },
                  }, busy ? '写入中…' : '替换手写配置并写入'),
                ),
                h('div', { className: 'dra-dim', style: { marginTop: '6px' } },
                  '会先把那段手写的 remote-agent 条目（连同它上方的注释）删掉，再写托管块。原文件已备份。'),
              )
              : null,
            h('div', { className: 'dra-row', style: { marginTop: '10px' } },
              h('button', { className: 'dra-btn', onClick: function () { submit('hub') }, disabled: busy }, busy ? '写入中…' : '确认，写入配置'),
              h('button', { className: 'dra-btn', onClick: function () { setStep('choose') }, disabled: busy }, '返回'),
            ),
          ),
        )
      }

      // ── 副机：填连接信息 ──
      return h('div', { className: 'dra-root' },
        h(StyleTag),
        head,
        h('div', { className: 'dra-body' },
          h('div', { className: 'dra-sec' }, '配置为副机'),

          h('div', { className: 'dra-sec' }, '① 怎么连主机'),
          h('div', { className: 'dra-row' },
            h('span', { className: 'dra-k' }, '配对码'),
            h('input', {
              className: 'dra-input',
              placeholder: 'dshra1://...（主机面板能生成，粘进来会自动解析）',
              value: f.pair,
              onChange: function (e) { applyPair(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-row' },
            h('span', { className: 'dra-k' }, '或填地址'),
            h('input', {
              className: 'dra-input',
              placeholder: 'ws://主机IP:19387/api/remote-agent/node',
              value: f.hubUrl,
              onChange: function (e) { set('hubUrl', e.target.value); set('transportMode', 'direct') },
            }),
          ),

          // ── ② 本机标识：折叠为高级选项（2026-10-17，开箱即用）──────────
          //
          // 节点 ID 默认取主机名（lib/node/index.js 的 sanitizeNodeId），
          // 90% 的用户不需要改。此前它是**平铺的必看字段**，小白会卡在
          // "节点 ID 是什么？我要填什么？"。
          //
          // 折叠后：不展开就完全不用理解它；要改的人点一下就能改。
          h('div', { className: 'dra-sec' },
            h('span', null, '② 本机标识'),
            h('span', {
              className: 'dra-dim',
              style: { marginLeft: '8px', cursor: 'pointer', textDecoration: 'underline' },
              onClick: function () { setShowAdv(!showAdv) },
            }, showAdv ? '收起' : '默认用主机名（点此自定义）'),
          ),
          showAdv
            ? h('div', null,
              h('div', { className: 'dra-row' },
                h('span', { className: 'dra-k' }, '节点 ID'),
                h('input', {
                  className: 'dra-input',
                  placeholder: '留空 = 自动用本机主机名',
                  value: f.nodeId,
                  onChange: function (e) { set('nodeId', e.target.value) },
                }),
              ),
            )
            : null,

          h('div', { className: 'dra-sec' }, '③ 允许任务在哪些目录干活（已预填，一般不用改）'),
          h('div', { className: 'dra-row' },
            h('span', { className: 'dra-k' }, '工作区'),
            h('input', {
              className: 'dra-input',
              placeholder: '例如 D:\\work',
              value: f.roots,
              onChange: function (e) { set('roots', e.target.value) },
            }),
          ),
          h('div', { className: 'dra-dim' },
            '任务只能在这些目录内动作 —— 这是安全边界，别填整个盘。'
            + '目录不存在时写入配置会自动创建。'),

          // ⚠ 提示必须放在**按钮上方**。
          //
          // 原先放在按钮下方 —— 实测用户点完按钮后视线停在按钮处，而面板
          // 滚动位置没变，提示在折叠线以下看不见，用户以为"点了没反应"。
          // （第一次验收就是这样：截图只到按钮为止，看不到任何反馈。）
          //
          // 顺序：错误/冲突在前（需要用户决策），按钮在后。
          note ? h('div', { className: 'dra-err', style: { marginTop: '12px' } }, note) : null,
          conflict
            ? h('div', { className: 'dra-warn' },
              h('div', null, conflict.message),
              h('div', { style: { marginTop: '8px' } },
                h('button', {
                  className: 'dra-btn',
                  disabled: busy,
                  onClick: function () { submit(conflict.role, { force: true }) },
                }, busy ? '写入中…' : '替换手写配置并写入'),
              ),
              h('div', { className: 'dra-dim', style: { marginTop: '6px' } },
                '会先把那段手写的 remote-agent 条目（连同它上方的注释）删掉，再写托管块。原文件已备份。'),
            )
            : null,

          h('div', { className: 'dra-row', style: { marginTop: '12px' } },
            h('button', { className: 'dra-btn', onClick: function () { submit('worker') }, disabled: busy }, busy ? '写入中…' : '确认，写入配置'),
            h('button', { className: 'dra-btn', onClick: function () { setStep('choose') }, disabled: busy }, '返回'),
          ),
        ),
      )
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    function Panel() {
      const st = React.useState({
        loading: true, error: '', nodes: [], tasks: [], counts: null, caps: null,
        // 连接尝试历史（体验提升 ①）：null = 还没拉到，空对象 = 拉到了但没记录
        connection: null,
        // 'hub'    = 本机是派活方（有 UI 路由）
        // 'worker' = 本机是干活方（读 STATUS_PATH）
        // 'setup'  = 本机未配置（读 SETUP_STATE_PATH，显示引导）
        // ''       = 还没判定出来
        mode: '', worker: null, setup: null,
      })
      const state = st[0]
      const setState = st[1]

      const sel = React.useState(null)
      const selected = sel[0]
      const setSelected = sel[1]

      const det = React.useState(null)
      const detail = det[0]
      const setDetail = det[1]

      const form = React.useState({ goal: '', node: '', mode: 'agent', workspace: '', outputs: '', model: '', timeoutMs: '', templateId: '' })
      const fv = form[0]
      const setForm = form[1]

      // 模型下拉的「自定义…」开关（2026-10-17 修 v0.9.0 审查 M2）。
      //
      // 原实现靠 `fv.model === '__custom__'` 判定 —— 但表单里存的是**真实
      // 模型名**（或空串），从来不是字面量 '__custom__'，所以：
      //   · 从"跟随默认"（model=''）选「自定义…」→ 旧值仍为 '' → isCustom=false
      //     → select 的 value 弹回原选项，文本框不出现
      //   · 从任一有效选项选「自定义…」→ 旧模型名被保留 → isCustom=false → 同样弹回
      // 唯一能进 isCustom 的路径是"表单里预先有个不在清单里的模型名"（先有鸡）。
      //
      // 修法：用独立的布尔 state 表达"用户主动选了自定义"，
      // 与 model 的值解耦。isCustom = modelCustom || (model 非空且不在清单里)。
      const customS = React.useState(false)
      const modelCustom = customS[0]
      const setModelCustom = customS[1]

      const busy = React.useState(false)
      const isBusy = busy[0]
      const setBusy = busy[1]

      const msg = React.useState('')
      const note = msg[0]
      const setNote = msg[1]

      const tick = React.useState(0)
      const setTick = tick[1]

      // 配置视图（只读）。单独一次拉取，不放进 4 秒轮询 —— 配置不会自己变。
      const cfgS = React.useState(null)
      const cfg = cfgS[0]
      const setCfg = cfgS[1]

      // 「切换角色」：打开后复用 SetupView（同一个组件、同一套写盘逻辑）。
      // 为什么复用而不是另写一个：写配置这件事**只该有一份实现** ——
      // inject 跟 role 走的规则、YAML 逐字段构造、备份回滚，都在那一条路上。
      const switchRoleS = React.useState(false)
      const switchRole = switchRoleS[0]
      const setSwitchRole = switchRoleS[1]

      const showCfgS = React.useState(false)
      const showCfg = showCfgS[0]
      const setShowCfg = showCfgS[1]

      // ── 环境体检（2026-10-17）───────────────────────────────────────────
      //
      // 与命令行 `dsh-remote-setup --doctor` 共用 lib/env-check.js 的同一份逻辑。
      //
      // 为什么面板上必须有：这个插件最贵的失败全是**静默**的 —— 绑 loopback
      // 导致副机永远连不上、inject 缺服务导致 hub 半死、roots 不存在导致任务
      // 全被拒。这些在主机侧都"看起来正常"，用户只能猜。
      //
      // 三档处置（产品决策）：能自动修的标「可自动修」；需要装东西的只给
      // 命令/链接（**不代下载**）；需要人判断的只报清楚。
      //
      // ⚠ 顺序是硬要求：state 与 runEnvCheck 都必须定义在**按钮之前** ——
      // `const` 有 TDZ，反过来会在渲染时 ReferenceError（第一版就是这样，
      // 靠人工核对行号才发现）。所以 state → 函数 → 按钮 → 渲染区，不能乱。
      //
      // 只在点「体检」时拉一次，不进 4 秒轮询：体检含系统探测，没必要反复跑。
      const envS = React.useState(null)
      const envCheck = envS[0]
      const setEnvCheck = envS[1]
      const envBusyS = React.useState(false)
      const envBusy = envBusyS[0]
      const setEnvBusy = envBusyS[1]

      const runEnvCheck = function () {
        if (envBusy) return
        setEnvBusy(true)
        apiGet('/env-check')
          .then(function (r) { setEnvCheck(r || null) })
          .catch(function (err) { setNote('体检失败：' + (err.message || err)) })
          .then(function () { setEnvBusy(false) })
      }

      // ── 一键修复状态（2026-10-20）────────────────────────────────────
      //
      // 三步流程，每一步都要用户看得见：
      //   fixPlan === null   → 只显示「预览修复」按钮
      //   fixPlan !== null   → 显示"将要改什么"，给「确认修复」
      //   点确认后            → 写盘 + 写后校验 + 提示重启
      const fixPlanS = React.useState(null)
      const fixPlan = fixPlanS[0]
      const setFixPlan = fixPlanS[1]
      const fixBusyS = React.useState(false)
      const fixBusy = fixBusyS[0]
      const setFixBusy = fixBusyS[1]
      const fixMsgS = React.useState('')
      const fixMsg = fixMsgS[0]
      const setFixMsg = fixMsgS[1]

      /** 第一步：只读预览（不写任何文件）。 */
      const previewFix = function () {
        if (fixBusy) return
        setFixBusy(true)
        setFixMsg('')
        apiPost('/fix', { action: 'plan' })
          .then(function (r) {
            if (r && r.ok) {
              setFixPlan(r.plan || null)
            } else {
              setFixMsg((r && r.error) || '预览失败')
            }
          })
          .catch(function (err) { setFixMsg('预览失败：' + ((err && err.message) || err)) })
          .then(function () { setFixBusy(false) })
      }

      /** 第二步：确认后写盘（带 confirm: 'yes'）。 */
      const applyFix = function () {
        if (fixBusy) return
        setFixBusy(true)
        setFixMsg('')
        apiPost('/fix', { action: 'apply', confirm: 'yes' })
          .then(function (r) {
            if (r && r.ok) {
              setFixMsg('已修复：' + (r.applied || []).join(', ') + ' —— 重启 DSH 生效')
              setFixPlan(null)
              // 修完重新体检一次，让用户看到"确实好了"
              runEnvCheck()
            } else {
              setFixMsg((r && r.error) || '修复失败')
            }
          })
          .catch(function (err) { setFixMsg('修复失败：' + ((err && err.message) || err)) })
          .then(function () { setFixBusy(false) })
      }

      // ── 外部工具检测（2026-10-20）───────────────────────────────────
      //
      // 用户要求"自动装依赖"。我们把范围收窄到**外部工具**，且**不代下载**：
      //   · 零 npm 依赖是核心卖点，代装 npm 包会自毁卖点
      //   · 代下载第三方二进制会让我们变成软件分发方（供应链责任）
      //
      // 所以这里只做：探测 → 说清缺了会怎样 → 给官方链接 + 安装命令（可复制）。
      const toolsS = React.useState(null)
      const extTools = toolsS[0]
      const setExtTools = toolsS[1]
      const toolsBusyS = React.useState(false)
      const toolsBusy = toolsBusyS[0]
      const setToolsBusy = toolsBusyS[1]

      const runToolProbe = function () {
        if (toolsBusy) return
        setToolsBusy(true)
        apiGet('/tools')
          .then(function (r) { setExtTools(r || null) })
          .catch(function (err) { setNote('工具检测失败：' + ((err && err.message) || err)) })
          .then(function () { setToolsBusy(false) })
      }

      // 首次自动体检的闸门。用 ref（不是 state）—— 它只控制"要不要跑一次"，
      // 改了不需要重渲染。
      const autoChecked = React.useRef(false)
    const purgeBusyS = React.useState(false)
    const purgeBusy = purgeBusyS[0]
    const setPurgeBusy = purgeBusyS[1]
    const monitorNodeS = React.useState(null)
    const monitorNode = monitorNodeS[0]
    const setMonitorNode = monitorNodeS[1]

      // ── 主题切换（日/夜）──────────────────────────────────────────
      const themeS = React.useState(function () {
        try { return localStorage.getItem('dra-theme') || 'dark' } catch { return 'dark' }
      })
      const theme = themeS[0]
      const setTheme = themeS[1]
      const toggleTheme = function () {
        const next = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        try { localStorage.setItem('dra-theme', next) } catch {}
      }

      // 副机接入卡片（生成配对码）
      const pairS = React.useState(null)
      const pair = pairS[0]
      const setPair = pairS[1]
      const showPairS = React.useState(false)
      const showPair = showPairS[0]
      const setShowPair = showPairS[1]
      const pairNoteS = React.useState('')
      const pairNote = pairNoteS[0]
      const setPairNote = pairNoteS[1]

      // ── 添加副机槽位（relay token 铸造）──────────────────────────────
      const enrollS = React.useState({ open: false, loading: false, data: null, error: '' })
      const enroll = enrollS[0]
      const setEnroll = enrollS[1]

      function mintEnrollToken() {
        setEnroll({ open: true, loading: true, data: null, error: '' })
        apiPost('/relay-enroll', {})
          .then(function (d) {
            if (d && d.ok && d.enrollToken) {
              setEnroll({ open: true, loading: false, data: d, error: '' })
            } else {
              setEnroll({ open: true, loading: false, data: null, error: String(d?.message || d?.error || '铸造失败') })
            }
          })
          .catch(function (e) {
            setEnroll({ open: true, loading: false, data: null, error: String(e?.message || e) })
          })
      }

      function loadPair() {
        // 2026-10-20（C1）：**端口不再由前端决定**。
        // 原来传 window.location.port，理由是"面板与节点端点同端口"——
        // 0.9.3 把端点搬到独立监听（19387）后这个前提就不成立了，
        // 于是生成的每个配对码都指向 DSH 面板端口（且每次启动还随机变）。
        // 现在服务端从真实监听状态取端口；这里仍带 port 只是为了兼容
        // "独立监听没起来、退回老通道"的旧部署。
        const port = window.location.port
          ? Number(window.location.port)
          : (window.location.protocol === 'https:' ? 443 : 80)
        apiGet('/pair-info?port=' + port)
          .then(function (d) { setPair(d || null); setPairNote('') })
          .catch(function (e) { setPair(null); setPairNote(String(e && e.message ? e.message : e)) })
      }

      // ── 任务模板库（配方）────────────────────────────────────────────
      //
      // 数据源是 hub 本地的 templates.json（见 lib/hub/templates.js）——
      // 不经过任何云端。面板这边的职责只有三件：拉列表、回填表单、存/删。
      //
      // 为什么模板状态**不进 4 秒轮询**：模板只在用户点"保存/删除"时变，
      // 而每次拉取都会把表单的下拉框重建一次（正在编辑时选中项会被打断）。
      // 所以它跟配置视图一样，单独拉、按需拉。
      const tplS = React.useState({ loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' })
      const tpl = tplS[0]
      const setTpl = tplS[1]
      const tplMsgS = React.useState('')
      const tplMsg = tplMsgS[0]
      const setTplMsg = tplMsgS[1]

      function loadTemplates() {
        return apiGet('/templates')
          .then(function (d) {
            setTpl({
              loading: false,
              list: (d && d.templates) || [],
              max: (d && d.max) || 0,
              degraded: !!(d && d.degraded),
              reason: (d && d.reason) || '',
              file: (d && d.file) || '',
              error: '',
            })
            return d
          })
          .catch(function (err) {
            setTpl(function (t) { return Object.assign({}, t, { loading: false, error: String((err && err.message) || err) }) })
            return null
          })
      }

      React.useEffect(function () {
        let disposed = false
        apiGet('/templates')
          .then(function (d) {
            if (disposed) return
            setTpl({
              loading: false,
              list: (d && d.templates) || [],
              max: (d && d.max) || 0,
              degraded: !!(d && d.degraded),
              reason: (d && d.reason) || '',
              file: (d && d.file) || '',
              error: '',
            })
          })
          .catch(function (err) {
            if (disposed) return
            setTpl(function (t) { return Object.assign({}, t, { loading: false, error: String((err && err.message) || err) }) })
          })
        return function () { disposed = true }
      }, [setTpl])

      /**
       * 一键填充：把模板字段灌进表单。
       *
       * 三条必须显式处理的语义：
       *   ① **可选字段要清空而不是保留** —— 用户从"带 workspace 的模板"切到
       *      "不带的模板"，如果保留旧值，就会拿 A 模板的目录跑 B 模板的任务。
       *   ② `model` 在服务端是对象 {provider, model}，而表单里是一个字符串
       *      （服务端 /dispatch 的 normalizeModelSelection 两种都认）。这里拼成
       *      `provider/model`，与用户在输入框里手写的格式一致 —— 否则显示成
       *      `[object Object]`，用户既看不懂也改不了。
       *   ③ `timeoutMs` 同样进表单（毫秒字符串），留空表示用服务端默认。
       */
      function applyTemplate(id) {
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        setTplMsg('')
        if (!t) {
          // 选回「（不使用模板）」：只取消关联，**不动**已填的字段 ——
          // 用户的意图是"不用模板了"，不是"把表单清空重来"。
          setForm(function (f) { const n = Object.assign({}, f); n.templateId = ''; return n })
          return
        }
        const m = t.model
        const modelStr = !m ? '' : (m.provider ? (m.provider + '/' + (m.model || '')) : (m.model || ''))
        setForm(function (f) {
          const n = Object.assign({}, f)
          n.templateId = t.id
          n.goal = t.goal || ''
          n.mode = t.mode === 'exec' ? 'exec' : 'agent'
          n.workspace = t.workspace || ''
          n.model = modelStr
          n.outputs = (t.outputs || []).join(', ')
          n.timeoutMs = t.timeoutMs ? String(t.timeoutMs) : ''
          return n
        })
        setTplMsg('已填充模板「' + t.name + '」')
      }

      /** 保存当前表单为模板。名字让用户填（默认取 goal 的前一段，省一次输入）。 */
      function saveTemplate() {
        if (!fv.goal.trim()) { setTplMsg('先填任务目标，再存为模板'); return }
        const suggested = fv.goal.trim().split('\n')[0].slice(0, 30)
        const name = window.prompt('模板名（之后在下拉框里选它）', suggested)
        if (name === null) return
        const trimmed = String(name).trim()
        if (trimmed === '') { setTplMsg('模板名不能为空'); return }
        const outputs = fv.outputs.split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean)
        const body = {
          name: trimmed,
          goal: fv.goal.trim(),
          mode: fv.mode === 'exec' ? 'exec' : 'agent',
        }
        // 可选字段：留空就**不传**（服务端把缺失当"没有预设"；
        // 传空串反而会因为"给了但不合法"被拒 —— 让两端语义一致）
        if (fv.workspace.trim()) body.workspace = fv.workspace.trim()
        if (fv.model.trim()) body.model = fv.model.trim()
        if (outputs.length) body.outputs = outputs
        const tmo = Number(fv.timeoutMs)
        if (fv.timeoutMs.trim() !== '' && Number.isFinite(tmo)) body.timeoutMs = tmo
        // 覆盖已有模板：表单里当前选中的那条就是更新目标（否则一律新建）
        if (fv.templateId) body.id = fv.templateId

        setTplMsg('保存中…')
        apiPost('/templates/save', body)
          .then(function (r) {
            const t = r.template || {}
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = t.id || ''; return n })
            setTplMsg(r.updated ? ('已更新模板「' + (t.name || '') + '」') : ('已保存模板「' + (t.name || '') + '」'))
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('保存失败：' + (err.message || err)) })
      }

      function deleteTemplate() {
        const id = fv.templateId
        if (!id) { setTplMsg('先在下拉框里选中一条模板'); return }
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        if (!window.confirm('删除模板「' + ((t && t.name) || id) + '」？\n\n· 只删这条预设，不影响已派出的任务\n· 删掉后表单里已填的内容不变')) return
        setTplMsg('删除中…')
        apiPost('/templates/delete', { id: id })
          .then(function () {
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = ''; return n })
            setTplMsg('已删除模板')
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('删除失败：' + (err.message || err)) })
      }

      React.useEffect(function () {
        let disposed = false
        apiGet('/config')
          .then(function (d) { if (!disposed) setCfg((d && d.config) || null) })
          .catch(function () { if (!disposed) setCfg(null) })
        return function () { disposed = true }
      }, [setCfg])

      // 现场自报：把页面来源与一次探测结果报回 Host（进 DSH 日志）。
      //
      // 为什么需要：桌面版（Electron）的页面来源是 `dsh-app://app/`，请求经
      // forwardWebRequest 转发到本机 HTTP 服务。这条链路上任何一环出问题都只
      // 表现为面板里一个 HTTP 错误码，光看那个码无法区分是哪一环。自报让
      // 排查有据可依，而不是靠猜。
      //
      // 只报一次（用 ref 标记），失败静默 —— 诊断代码绝不能影响面板本身。
      React.useEffect(function () {
        let done = false
        function report(probe) {
          if (done) return
          done = true
          try {
            fetch(API + '/diag', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({
                href: String(window.location.href || '').slice(0, 300),
                origin: String(window.location.origin || '').slice(0, 300),
                protocol: String(window.location.protocol || '').slice(0, 40),
                apiBase: String(API).slice(0, 300),
                probeUrl: probe && probe.url ? String(probe.url).slice(0, 300) : null,
                probeStatus: probe && typeof probe.status === 'number' ? probe.status : null,
                probeError: probe && probe.error ? String(probe.error).slice(0, 300) : null,
              }),
            }).catch(function () { /* 诊断失败不影响面板 */ })
          } catch { /* 同上 */ }
        }
        // 探测一次 overview，把结果一并报回
        const probeUrl = API + '/overview'
        fetch(probeUrl, { cache: 'no-store' })
          .then(function (r) { report({ url: probeUrl, status: r.status }) })
          .catch(function (e) { report({ url: probeUrl, error: (e && e.message) || String(e) }) })
      }, [])

      // 角色探测 + 数据拉取。
      //
      // ═══════════════════════════════════════════════════════════════════
      // 为什么要探测角色（而不是直接拉 hub 的端点）
      // ═══════════════════════════════════════════════════════════════════
      //
      // `dsh.client` 是**包级声明**（loader 扫 package.json 的 `dsh.client`），
      // 装了插件就加载面板，**无法按 role 条件化**。而 hub 的 UI 路由只在
      // `applyHub` 里注册 —— 副机跑的是 `applyWorkerBranch`，没有那些路由。
      //
      // 所以副机的面板**必然拿不到 hub 数据**。两条路：
      //   · 藏掉它（不渲染）—— 副机侧栏留空，且浪费了"副机本可以有面板"
      //   · **让它显示副机自己** —— 这是本实现的选择
      //
      // 副机**也有** webServer（`dsh-web-app` 是桌面版基础 bundle，实测监听
      // 19387），而 worker 分支早就有 `/api/remote-agent/status` 端点。
      // 所以副机面板能显示：本机角色、连的哪个 hub、任务队列、roots、连接状态。
      //
      // 探测方式：先试 hub 的 `/overview`。
      //   · 成功 → 本机是 hub，走 hub 视图
      //   · 失败 → 试副机的 `/status`；成功则是 worker，走 worker 视图
      //   · 都失败 → 真故障，报错（不藏）
      React.useEffect(function () {
        let disposed = false
        let inflight = false

        function load() {
          if (disposed || inflight) return
          inflight = true
          const done = function () { inflight = false }

          if (state.mode === 'worker') {
            // 已判定为副机：只拉本机状态
            apiGetPath(STATUS_PATH)
              .then(function (w) {
                if (disposed) return
                setState(function (s) { return Object.assign({}, s, { loading: false, error: '', worker: w || null }) })
              })
              .catch(function (err) {
                if (disposed) return
                setState(function (s) {
                  return Object.assign({}, s, { loading: false, error: String((err && err.message) || err) })
                })
              })
              .then(done)
            return
          }

          if (state.mode === 'setup') {
            // 已判定为未配置：只拉引导状态
            apiGetPath(SETUP_STATE_PATH)
              .then(function (d) {
                if (disposed) return
                setState(function (s) { return Object.assign({}, s, { loading: false, error: '', setup: d || null }) })
              })
              .catch(function (err) {
                if (disposed) return
                setState(function (s) {
                  return Object.assign({}, s, { loading: false, error: String((err && err.message) || err) })
                })
              })
              .then(done)
            return
          }

          Promise.all([apiGet('/overview'), apiGet('/tasks')])
            .then(function (res) {
              if (disposed) return
              const ov = res[0] || {}
              const tk = res[1] || {}
              setState(function (s) {
                return Object.assign({}, s, {
                  loading: false, error: '', mode: 'hub',
                  nodes: ov.nodes || [],
                  counts: ov.counts || null,
                  caps: ov.capabilities || null,
                  // 连接尝试历史（体验提升 ①）：副机连不上时面板要能说清原因
                  connection: ov.connection || null,
                  tasks: tk.tasks || [],
                })
              })
              // ── 首次自动体检（2026-10-17，开箱即用）──────────────────
              //
              // 此前体检要用户主动点「体检」按钮 —— 但小白不知道要点。
              // 而这个插件最贵的失败全是静默的（绑 loopback 副机连不上、
              // inject 缺服务 hub 半死、roots 不存在任务全被拒），不主动
              // 检查就等于"永远不知道哪里错了"。
              //
              // 只在**第一次**成功加载时自动跑一次（autoChecked 是 ref，
              // 不触发重渲染）。之后 4 秒轮询不会重复体检（体检含系统探测）。
              if (!autoChecked.current) {
                autoChecked.current = true
                runEnvCheck()
              }
            })
            .catch(function (err) {
              if (disposed) return
              // hub 端点不通 —— 试副机端点。**这一步是"显示副机自己"的关键**，
              // 不是把错误吞掉：只有所有端点都失败时才报错。
              return apiGetPath(STATUS_PATH)
                .then(function (w) {
                  if (disposed) return
                  setState(function (s) {
                    return Object.assign({}, s, { loading: false, error: '', mode: 'worker', worker: w || null })
                  })
                })
                .catch(function () {
                  if (disposed) return
                  // 副机端点也不通 —— 试引导端点。
                  //
                  // 走到这一层说明**本机未配置**（role 为空）：那时 hub 分支
                  // 不跑（没有 UI 路由），worker 分支也不跑（不拨入），只有
                  // setup 那一组路由在。**这不是错误，是首次安装的正常状态**，
                  // 所以要显示引导而不是报错。
                  return apiGetPath(SETUP_STATE_PATH)
                    .then(function (d) {
                      if (disposed) return
                      setState(function (s) {
                        return Object.assign({}, s, { loading: false, error: '', mode: 'setup', setup: d || null })
                      })
                    })
                    .catch(function () {
                      if (disposed) return
                      // 三个端点都不通：真故障，如实报（不藏）
                      setState(function (s) {
                        return Object.assign({}, s, {
                          loading: false,
                          error: String((err && err.message) || err),
                        })
                      })
                    })
                })
            })
            .then(done)
        }

        load()
        const timer = setInterval(load, 4000)
        return function () { disposed = true; clearInterval(timer) }
        // 依赖里带 `tick`：面板的「刷新」按钮只改 tick，靠它触发重新拉取。
        // 带 `state.mode`：首次探测出角色后要切到对应的拉取分支。
        //   （只在 mode 真的变化时重建，不会每轮都重建 —— setState 是稳定的，
        //    而 mode 只在 '' → 'hub'/'worker' 时变一次。）
      }, [setState, state.mode, tick])

      // 选中任务时拉详情（含 handoff）
      React.useEffect(function () {
        if (!selected) { setDetail(null); return }
        let disposed = false
        apiGet('/task?taskId=' + encodeURIComponent(selected))
          .then(function (d) { if (!disposed) setDetail(d) })
          .catch(function () { if (!disposed) setDetail(null) })
        return function () { disposed = true }
      }, [selected, tick, setDetail])

      function refresh() { setTick(function (n) { return n + 1 }) }

      function dispatch() {
        if (isBusy) return
        if (!fv.goal.trim()) { setNote('请填写任务目标'); return }
        setBusy(true); setNote('')
        const outputs = fv.outputs.split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean)
        // 超时（可选）：模板里带过来的预设值也走这里。空 / 非数字一律**不传**，
        // 让服务端用 defaults.timeoutMs —— 传 NaN 会被 validateTaskStart 判成
        // "非有限数"从而静默回落，看起来一样但日志里多一个假值。
        const tmo = Number(fv.timeoutMs)
        const timeoutMs = fv.timeoutMs.trim() !== '' && Number.isFinite(tmo) && tmo > 0 ? tmo : undefined
        apiPost('/dispatch', {
          goal: fv.goal.trim(),
          node: fv.node || undefined,
          mode: fv.mode,
          workspace: fv.workspace.trim() || undefined,
          outputs: outputs.length ? outputs : undefined,
          // 模型选择（可选）：原始字符串交给服务端 normalizeModelSelection 归一
          // （"deepseek-reasoner" 或 "provider/model" 两种写法都认）
          model: fv.model.trim() || undefined,
          timeoutMs: timeoutMs,
        })
          .then(function (r) {
            setNote(r.approval === 'manual' ? '已创建，等待审批（批准后副机才会收到）：' + r.taskId : '已派发：' + r.taskId)
            setForm(function (f) { const n = Object.assign({}, f); n.goal = ''; return n })
            refresh()
          })
          .catch(function (err) { setNote('派发失败：' + (err.message || err)) })
          .then(function () { setBusy(false) })
      }

      function cancel(taskId) {
        apiPost('/cancel', { taskId: taskId })
          .then(function (r) {
            setNote(r.requested ? '已发送取消请求' : '取消请求未送达（节点可能离线）')
            refresh()
          })
          .catch(function (err) { setNote('取消失败：' + (err.message || err)) })
      }

      // 两阶段审批（提案 #2）：批准此刻才真正派给副机；拒绝转 rejected 终态
      function approve(taskId) {
        apiPost('/approve', { taskId: taskId })
          .then(function () { setNote('已批准并派发：' + taskId); refresh() })
          .catch(function (err) { setNote('批准失败：' + (err.message || err)) })
      }
      function reject(taskId) {
        apiPost('/reject', { taskId: taskId })
          .then(function () { setNote('已拒绝：' + taskId); refresh() })
          .catch(function (err) { setNote('拒绝失败：' + (err.message || err)) })
      }

      function pull(taskId, paths) {
        apiPost('/pull', { taskId: taskId, paths: paths })
          .then(function (r) {
            const okN = (r.results || []).filter(function (x) { return x.ok }).length
            setNote('已拉取 ' + okN + '/' + (r.results || []).length + ' → ' + r.dest)
            refresh()
          })
          .catch(function (err) { setNote('拉取失败：' + (err.message || err)) })
      }

      // ── 引导视图（未配置）──────────────────────────────────────────────
      //
      // 首次安装时插件无法知道这台机器是主机还是副机 —— 只有用户知道。
      // `role` 的默认值是空，此时 hub/worker 分支都不跑，只有 setup 路由在。
      //
      // **这一屏是整个首次体验的关键**：它把"去改 YAML"变成"点一下按钮"。
      // 写盘走 `/setup/apply`（复用 lib/setup.js 的 writePatchBlock ——
      // 有冲突检测、备份、托管块、写后校验、失败回滚）。
      if (state.mode === 'setup') {
        return h(SetupView, { setup: state.setup, onDone: refresh })
      }

      // ── Worker 监控覆盖层 ─────────────────────────────────────────────
      if (monitorNode) {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          h(NodeMonitor, {
            nodeId: monitorNode,
            tasks: state.tasks,
            onClose: function () { setMonitorNode(null) },
          }),
        )
      }

      // ── 切换角色（已配置后想改）────────────────────────────────────────
      //
      // 引导 UI 只在未配置时出现；已配好之后改角色走这里 —— 复用同一个
      // SetupView，但传 `switching` 让它知道"这是改，不是初次配"（文案与
      // 默认值都不同），并回填当前值。
      if (switchRole) {
        return h(SetupView, {
          setup: {
            configured: true,
            current: {
              role: cfg && cfg.role ? cfg.role : '',
              nodeId: cfg && cfg.nodeId ? cfg.nodeId : '',
              transportMode: cfg && cfg.transportMode ? cfg.transportMode : 'relay',
              hubUrl: cfg && cfg.hubUrl ? cfg.hubUrl : '',
              relayUrl: cfg && cfg.relayUrl ? cfg.relayUrl : '',
              roots: cfg && cfg.roots ? cfg.roots : [],
            },
            patchFile: cfg && cfg.patchFile ? cfg.patchFile : '',
          },
          switching: true,
          onDone: refresh,
          onCancel: function () { setSwitchRole(false) },
        })
      }

      if (state.loading) {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          h('div', { className: 'dra-body' }, '加载中…'),
        )
      }

      const counts = state.counts || {}
      const caps = state.caps || {}

      const head = h('div', { className: 'dra-head' },
        h('span', { className: 'dra-title' }, '远程同事'),
        // counts 可能为空对象（/overview 失败时）：直接相加会渲染 "undefined/undefined 在线"。
        h('span', { className: 'dra-dim' }, (counts.online || 0) + '/' + (counts.nodes || 0) + ' 在线'),
        h('span', { className: 'dra-spacer' }),
        // ── 主题切换按钮 ──────────────────────────────────────────────
        h('button', {
          className: 'dra-btn ghost',
          title: theme === 'dark' ? '切换到浅色' : '切换到深色',
          onClick: toggleTheme,
        }, theme === 'dark' ? '☀' : '🌙'),
        h('button', {
          className: 'dra-btn',
          onClick: function () { setShowCfg(function (v) { return !v }) },
        }, showCfg ? '收起设置' : '设置'),
        h('button', {
          className: 'dra-btn',
          onClick: function () {
            setShowPair(function (v) {
              const next = !v
              if (next && !pair) loadPair()
              return next
            })
          },
        }, showPair ? '收起接入' : '副机接入'),
        h('button', { className: 'dra-btn', onClick: refresh }, '刷新'),
        // ── 环境体检 ─────────────────────────────────────────────────
        //
        // 这个插件的失败大多是**静默**的（绑 loopback 副机连不上、inject 缺
        // 服务 hub 半死、roots 不存在任务全被拒），主机侧都"看起来正常"。
        // 体检把这些问题逐条列出来，每条带修法 —— 能自动修的标出来。
        h('button', {
          className: 'dra-btn',
          disabled: envBusy,
          onClick: runEnvCheck,
        }, envBusy ? '体检中…' : '体检'),
        // ── 外部工具检测（2026-10-20）────────────────────────────────
        //
        // 不自动跑：每次要 spawn 4 个进程查版本。用户点了才查。
        h('button', {
          className: 'dra-btn',
          disabled: toolsBusy,
          onClick: runToolProbe,
        }, toolsBusy ? '检测中…' : '检测工具'),
        // ── 清理任务视图 ─────────────────────────────────────────────
        //
        // 为什么面板上需要这个按钮：hub 侧任务视图会累积（副机的任务记录
        // 默认保留 7 天，所以会持续 sync 回来），累积到 maxTasksPerNode
        // 之后**任何新任务都被拒** —— 那种情况下连"派一条清理命令"都做不到。
        // 这个按钮不依赖派任务，是那个死局的唯一出口。
        //
        // 确认框是必须的：它会清掉已结束任务的视图（remote_status 之后查不到），
        // 用户该知道这一点。但在"节点已经不能用"的场景里，用户按一下就想解决，
        // 所以只问一次、不搞二次确认。
        h('button', {
          className: 'dra-btn',
          disabled: purgeBusy,
          onClick: function () {
            if (!window.confirm('清理已结束任务的视图？\n\n· 只清主机侧的视图，副机的任务记录不动\n· 在跑的任务会保留\n· 清理后这些任务不再出现在面板和 remote_status 里')) return
            setPurgeBusy(true)
            setNote('正在清理…')
            apiPost('/purge', { includeActive: false })
              .then(function (r) { setNote('已清理 ' + (r.removed || 0) + ' 条任务视图' + ((r.kept || 0) > 0 ? '，保留 ' + r.kept + ' 条' : '')); refresh() })
              .catch(function (err) { setNote('清理失败：' + (err.message || err)) })
              .finally(function () { setPurgeBusy(false) })
          },
        }, purgeBusy ? '清理中…' : '清理'),
      )

      // ── 副机接入区（生成配对码）──────────────────────────────────
      // 零终端路径：点按钮 → 复制配对码 → 副机配置里 pair: 一行（向导或手粘均可）。
      const pairSection = !showPair ? null : h('div', null,
        h('div', { className: 'dra-sec' }, '副机接入（把另一台电脑变成远程同事）'),
        !pair
          ? h('div', { className: 'dra-empty' }, pairNote || '读取中…（/pair-info 不可达时请刷新重试）')
          : h('div', null,
            // ── 独立监听状态（2026-10-20）──────────────────────────────
            // 0.9.3 起副机拨的是插件自己的端口，不是 DSH 面板的端口。
            // 这里必须如实告诉用户"在听哪个 host:port"，否则拿到配对码也
            // 无从判断它指向哪里（这正是 C1 隐蔽的地方）。
            (function () {
              const L = pair.listener
              if (!L) return null
              if (L.state === 'listening') {
                return h('div', { className: 'dra-kv', style: { padding: '4px 9px' } },
                  h('span', { className: 'dra-k' }, '节点端口'),
                  h('span', { className: 'dra-mono' }, (L.host || '?') + ':' + (L.port || '?')),
                  h('span', { className: 'dra-dim', style: { fontSize: '11px' } },
                    '（独立监听' + (L.source ? ' · ' + L.source : '') + '）'),
                )
              }
              return h('div', {
                className: L.state === 'failed' ? 'dra-err' : 'dra-warn',
                style: { margin: '4px 9px 8px' },
              },
              h('div', { style: { fontWeight: '600' } },
                L.state === 'failed' ? '⚠ 独立监听启动失败 —— 下面这些码连不上'
                  : (L.state === 'disabled' ? '⚠ 独立监听已关闭 —— 走 DSH 的 Web 服务通道' : '⏳ 独立监听尚未就绪')),
              L.hint ? h('div', { style: { marginTop: '2px' } }, L.hint) : null)
            })(),
            // ── 生成口令（2026-10-20，H3）──────────────────────────────
            // 面板此前**没有**任何生成 nodeToken 的入口：YAML 与 instance.json
            // 都不写它，所以走面板配的 hub 永远空口令 → 独立监听只能绑回环
            // → 副机连不上，而用户完全不知道"口令"这件事。
            h('div', { className: 'dra-kv', style: { padding: '4px 9px' } },
              h('span', { className: 'dra-k' }, '入网口令'),
              h('span', { className: 'dra-mono' }, pair.tokenSet ? '已设置 ✓' : '未设置（副机连不上）'),
              !pair.tokenSet
                ? h('button', {
                  className: 'dra-btn',
                  onClick: function () {
                    const ok = window.confirm('生成一个新口令？\n\n生成后旧口令立即失效，'
                      + '已配置旧口令的副机需要重新贴一次配对码。\n\nDSH 需要重启才生效。')
                    if (!ok) return
                    apiPost('/setup/rotate-token', {}).then(function (d) {
                      if (d && d.token) {
                        // 只显示这一次，之后服务端不再回显明文
                        setPairNote('新口令（复制保存，只显示这一次）：' + d.token)
                        window.setTimeout(loadPair, 400)
                      } else {
                        setPairNote('生成失败：' + ((d && d.message) || '未知原因'))
                      }
                    }, function (e) { setPairNote('生成失败：' + (e && e.message ? e.message : e)) })
                  },
                }, '生成口令')
                : null,
            ),
            pair.note ? h('div', { className: 'dra-dim', style: { padding: '2px 9px' } }, pair.note) : null,
            (pair.codes || []).length === 0
              ? h('div', { className: 'dra-empty' }, '本机没有可用的局域网地址。')
              : (pair.codes || []).map(function (c, i) {
                return h('div', {
                  key: c.address,
                  // 只有真正绑定的那个地址能用；其余标灰并说明原因（C2）
                  style: { padding: '6px 9px', opacity: c.usable === false ? 0.45 : 1 },
                },
                h('div', { className: 'dra-kv' },
                  h('span', { className: 'dra-k' },
                    '地址 ' + (i + 1) + (c.usable === false ? '（不是监听地址，连不上）' : '')),
                  h('span', { className: 'dra-mono' }, c.address + (c.private ? '' : '（公网）')),
                ),
                h('div', { className: 'dra-mono dra-ell', style: { fontSize: '11px', padding: '2px 9px' }, title: c.hubUrl }, c.hubUrl),
                h('div', { className: 'dra-mono', style: {
                  fontSize: '11px', margin: '4px 9px', padding: '6px',
                  background: 'rgba(127,127,127,.12)', borderRadius: '4px',
                  wordBreak: 'break-all', userSelect: 'all',
                } }, c.pairCode),
                h('div', { className: 'dra-actions', style: { padding: '0 9px 4px' } },
                  h('button', {
                    className: 'dra-btn',
                    disabled: c.usable === false,
                    onClick: function () {
                      copyText("pair: '" + c.pairCode + "'").then(function () {
                        setPairNote('已复制 pair 配置行 —— 粘到副机 cordis.patch.yml 后重启副机 DSH')
                      }, function () {
                        setPairNote('复制失败 —— 请手动选中上面的配对码复制（整行，含 dshra1:// 开头）')
                      })
                    },
                  }, '复制 pair 配置行'),
                  h('button', {
                    className: 'dra-btn',
                    disabled: c.usable === false,
                    onClick: function () { copyText(c.pairCode).then(function () { setPairNote('已复制配对码') }, function () { setPairNote('复制失败 —— 请手动选中复制') }) },
                  }, '只复制码'),
                ),
                )
              }),
            h('div', { className: 'dra-kv', style: { padding: '4px 9px' } },
              h('span', { className: 'dra-k' }, '放行防火墙（Windows 主机执行一次）'),
              h('span', { className: 'dra-mono dra-ell', title: pair.firewallHint }, pair.firewallHint),
              h('button', {
                className: 'dra-btn',
                onClick: function () { copyText(pair.firewallHint).then(function () { setPairNote('已复制防火墙命令 —— 在主机上以管理员运行一次') }, function () { setPairNote('复制失败') }) },
              }, '复制'),
            ),
            h('div', { className: 'dra-dim', style: { padding: '2px 9px 8px' } },
              '副机配置里写一行 pair: 后重启副机 DSH；或在这台副机上跑 bin/dsh-remote-setup.js 粘贴配对码自动写盘。配对码含 token，等同凭证，勿贴公开群。'),
          ),
          // ── 添加副机槽位（relay 模式）──────────────────────────────────
          // 中继已配置时显示，允许用户为新副机铸造一次性 enrollToken
          cfg && cfg.relayUrl
            ? h('div', { style: { marginTop: '10px' } },
              h('div', { className: 'dra-sec' }, '添加副机（中继模式）'),
              !enroll.open
                ? h('button', {
                  className: 'dra-btn primary',
                  onClick: mintEnrollToken,
                }, '+ 添加副机')
                : h('div', {
                  style: {
                    background: 'var(--dra-surface-2)',
                    borderRadius: 'var(--dra-r-md)',
                    border: '1px solid var(--dra-line-2)',
                    padding: '14px 16px',
                    marginTop: '6px',
                  },
                },
                  enroll.loading
                    ? h('div', { className: 'dra-empty' }, '铸造中…')
                    : enroll.error
                      ? h('div', null,
                        h('div', { className: 'dra-err' }, enroll.error),
                        h('button', { className: 'dra-btn', onClick: mintEnrollToken }, '重试'),
                        h('button', { className: 'dra-btn', style: { marginLeft: '6px' }, onClick: function () { setEnroll({ open: false, loading: false, data: null, error: '' }) } }, '关闭'),
                      )
                      : enroll.data
                        ? h('div', null,
                          h('div', { className: 'dra-kv' },
                            h('span', { className: 'dra-k' }, '中继地址'),
                            h('span', { className: 'dra-mono dra-ell' }, enroll.data.relayUrl),
                          ),
                          h('div', { className: 'dra-kv', style: { alignItems: 'center' } },
                            h('span', { className: 'dra-k' }, '一次性 Token'),
                            h('span', {
                              className: 'dra-mono',
                              style: { fontSize: '15px', fontWeight: '700', color: 'var(--dra-accent)', letterSpacing: '.04em', flex: '1', wordBreak: 'break-all' },
                            }, enroll.data.enrollToken),
                            h('button', {
                              className: 'dra-btn',
                              style: { marginLeft: '8px', flexShrink: '0' },
                              onClick: function () { copyText(enroll.data.enrollToken).then(function () { setPairNote('已复制 enrollToken') }, function () { setPairNote('复制失败') }) },
                            }, '复制'),
                          ),
                          h('div', { className: 'dra-kv' },
                            h('span', { className: 'dra-k' }, '有效期'),
                            h('span', { className: 'dra-mono' }, Math.round((enroll.data.expiresInMs || 900000) / 60000) + ' 分钟'),
                          ),
                          h('div', { className: 'dra-hint', style: { marginTop: '8px' } },
                            '在副机的 remote-agent 面板选「中继模式」，填入上方中继地址和 Token 即可接入。Token 仅限使用一次，15 分钟内有效。'),
                          h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
                            h('button', { className: 'dra-btn', onClick: mintEnrollToken }, '再铸一个'),
                            h('button', { className: 'dra-btn ghost', onClick: function () { setEnroll({ open: false, loading: false, data: null, error: '' }) } }, '关闭'),
                          ),
                        )
                        : null,
                ),
              )
            : null,
      )

      // ── 设置区（只读配置视图）────────────────────────────────────
      //
      // 为什么是只读：改配置要写回 profile 的 cordis.patch.yml，而那条路径由
      // loader 拥有。插件在运行时改它，会让"下次启动的配置"与"当前进程的配置"
      // 不一致，且没有事务保证。所以这里展示当前生效值 + 指明改动位置 ——
      // 比给一个半可靠的写入按钮更诚实。
      const cfgSection = !showCfg ? null : h('div', null,
        h('div', { className: 'dra-sec' }, '主机设置（当前生效值）'),
        cfg === null
          ? h('div', { className: 'dra-empty' }, '读不到配置（/api/remote-agent/ui/config 不可达）。')
          : h('div', null,
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, '角色'),
              h('span', { className: 'dra-mono' },
                cfg.role === 'hub' ? 'hub — 主机（派活方）'
                  : cfg.role === 'worker' ? 'worker — 副机（干活方）'
                    : cfg.role + ' — 同机自测'),
              h('span', { className: 'dra-spacer' }),
              // ── 切换角色 ──────────────────────────────────────────────
              //
              // 为什么要有它：引导 UI 只在**未配置**时出现。已经配好之后想改
              // 角色（hub ↔ worker）原本只能去命令行或手改 YAML —— 而手改时
              // 还要**同时改 inject**（hub 要 webServer/tools/systemPrompt，
              // worker 要 tools/agentLoop/sessions），两个字段联动，极易配错。
              //
              // 这里复用同一套 `/setup/apply`：它会**把 role 和 inject 一起
              // 写对**，用户只需要点一下。写盘走 writePatchBlock（含备份、
              // 托管块、写后校验、失败回滚）。
              h('button', {
                className: 'dra-btn',
                onClick: function () { setSwitchRole(true) },
              }, '切换角色'),
            ),
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, 'direct 口令'),
              // 服务端只回布尔（不回明文），所以这里也只看 set/unset
              h('span', { className: 'dra-mono' }, cfg.nodeTokenSet ? '已设置' : '未设置（内网可留空）'),
            ),
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, '中继'),
              h('span', { className: 'dra-mono dra-ell' },
                cfg.relayUrl ? (cfg.relayUrl + (cfg.relayTokenSet ? ' · token 已设置' : ' · token 未设置')) : '未启用'),
            ),
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, '成品落地目录'),
              h('span', { className: 'dra-mono dra-ell' }, cfg.uiPullRoot || '未配置 → 面板拉取按钮禁用'),
            ),
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, '面板路由'),
              h('span', { className: 'dra-mono' }, cfg.uiEnabled ? '已启用' : '已关闭'),
            ),
            h('div', { className: 'dra-kv' },
              h('span', { className: 'dra-k' }, '会话级开关'),
              h('span', { className: 'dra-mono' }, cfg.sessionGate
                ? '已开启 — 每个会话要先 /remote-agent on'
                : '未开启 — 所有会话可直接用 remote_*'),
            ),
            h('div', { className: 'dra-hint' }, cfg.editHint || '以上配置在 profile 的 cordis.patch.yml 里修改，改完重启 DSH 生效。'),
          ),
      )

      const envSection = envCheck === null
        ? null
        : h('div', null,
          h('div', { className: 'dra-sec' }, '环境体检'),
          h('div', { className: 'dra-dim', style: { marginBottom: '6px' } },
            (envCheck.failed === 0
              ? '核心项全部通过'
              : '共 ' + envCheck.failed + ' 项需要处理')
            + (envCheck.autoFixable > 0 ? '（其中 ' + envCheck.autoFixable + ' 项修法机械，可一键修复）' : '')),
          // ── 一键修复（2026-10-20）─────────────────────────────────
          //
          // ⚠ 这会改 profile 的 cordis.patch.yml（DSH 自己的配置文件）。
          // 所以流程刻意做成**两步**：
          //   1. 点「预览修复」→ 只读，列出"将要改什么"+"不会做什么"
          //   2. 看清后点「确认修复」→ 才写盘（带 confirm: 'yes'）
          //
          // 写盘有备份 + 写后校验，改完给「撤销」按钮。
          fixPlan !== null
            ? h('div', { className: 'dra-warn', style: { marginBottom: '8px' } },
              h('div', { style: { fontWeight: '600' } }, '将要修改 profile 配置（需重启生效）'),
              h('div', { className: 'dra-dim', style: { marginTop: '4px' } }, '文件：' + (fixPlan.file || '')),
              fixPlan.fixable.length > 0
                ? h('div', { style: { marginTop: '4px' } },
                  fixPlan.fixable.map(function (f) {
                    return h('div', { key: f.id, className: 'dra-dim' }, '· ' + f.change)
                  }))
                : h('div', { className: 'dra-dim', style: { marginTop: '4px' } }, '没有可自动修的项。'),
              // 明确列出"不会做什么"——比承诺做什么更重要
              fixPlan.fixable.length > 0
                ? h('div', { className: 'dra-dim', style: { marginTop: '4px' } },
                  '只会改托管块里那几个字段，你的其它配置条目一个字节不动；'
                  + '写前自动备份，改坏可一键撤销。')
                : null,
              fixPlan.skipped.length > 0
                ? h('div', { className: 'dra-dim', style: { marginTop: '4px' } },
                  '这些项需要你判断，不会自动改：' + fixPlan.skipped.map(function (s) { return s.label }).join('、'))
                : null,
              h('div', { className: 'dra-actions', style: { marginTop: '6px' } },
                fixPlan.fixable.length > 0
                  ? h('button', {
                    className: 'dra-btn',
                    disabled: fixBusy,
                    onClick: function () { applyFix() },
                  }, fixBusy ? '写入中…' : '确认修复')
                  : null,
                h('button', {
                  className: 'dra-btn',
                  onClick: function () { setFixPlan(null); setFixMsg('') },
                }, '取消'),
                fixMsg ? h('span', { className: 'dra-dim' }, fixMsg) : null,
              ),
            )
            : (envCheck.failed > 0 || envCheck.autoFixable > 0)
              ? h('div', { className: 'dra-actions', style: { marginBottom: '8px' } },
                h('button', {
                  className: 'dra-btn',
                  disabled: fixBusy,
                  onClick: function () { previewFix() },
                }, fixBusy ? '检查中…' : '预览修复'),
                h('span', { className: 'dra-dim' }, '只读预览 —— 先看要改什么，再决定'),
              )
              : null,
          (envCheck.items || []).map(function (it) {
            const mark = it.ok ? '✓' : (it.severity === 'warn' ? '⚠' : '✗')
            return h('div', { key: it.id, className: 'dra-env-item' },
              h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                h('span', {
                  className: 'dra-mono',
                  style: { color: it.ok ? 'var(--dsw-alias-state-success-primary, currentColor)' : 'var(--dsw-alias-state-error-primary, currentColor)' },
                }, mark),
                h('span', { style: { flex: '1' } }, it.label),
                // v0.9.0 审查 L3：原来写「可自动修」，但**没有修复按钮**（
                // 全仓库无 fix 路由）—— 虚假承诺。改成如实描述：修法是机械的。
                it.autoFix ? h('span', { className: 'dra-badge' }, '照抄即可') : null,
              ),
              it.detail
                ? h('div', { className: 'dra-dim', style: { paddingLeft: '20px' } }, it.detail)
                : null,
              !it.ok && it.fix
                ? h('div', { style: { paddingLeft: '20px', marginTop: '2px' } },
                  h('div', { className: 'dra-dim' }, '↳ 怎么修：' + it.fix),
                  // 一键复制（2026-10-20，体验提升 ②）：
                  // 修法里常含可直接粘贴的命令/YAML 片段，让用户手抄是纯粹的摩擦。
                  // **只做复制，不做"一键修复"** —— 后者会改用户文件，风险 > 收益
                  // （我们刚因为改 DSH 文件出过事故）。
                  h('button', {
                    className: 'dra-btn',
                    style: { marginTop: '4px', padding: '2px 8px', fontSize: '11px' },
                    onClick: function () {
                      copyText(it.fix).then(function (ok) {
                        setNote(ok ? '已复制修法到剪贴板' : '复制失败，请手动选中复制')
                      })
                    },
                  }, '复制修法'),
                )
                : null,
            )
          }),
        )

      // ── 外部工具（2026-10-20）──────────────────────────────────────
      //
      // 只在用户点了「检测工具」后显示（不自动跑：每次要 spawn 4 个进程）。
      // 缺失的项给"为什么需要 + 安装命令（可复制）+ 官方链接"。
      // **不代下载** —— 边界写在 lib/external-tools.js 头注释。
      const toolsSection = extTools === null
        ? null
        : h('div', null,
          h('div', { className: 'dra-sec' }, '外部工具'),
          (extTools.tools || []).map(function (t) {
            return h('div', { key: t.id, style: { marginBottom: '6px' } },
              h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                h('span', {
                  className: 'dra-mono',
                  style: { color: t.installed ? 'var(--dsw-alias-state-success-primary, currentColor)' : 'var(--dsw-alias-state-warning-primary, currentColor)' },
                }, t.installed ? '✓' : '⚠'),
                h('span', { style: { flex: '1' } }, t.name + (t.required ? '（必需）' : '')),
                t.installed
                  ? h('span', { className: 'dra-dim' }, t.version)
                  : h('span', { className: 'dra-dim' }, '未安装'),
              ),
              !t.installed
                ? h('div', null,
                  h('div', { className: 'dra-dim', style: { paddingLeft: '20px' } }, t.why),
                  h('div', { className: 'dra-row', style: { paddingLeft: '20px', marginTop: '2px' } },
                    t.install
                      ? h('button', {
                        className: 'dra-btn',
                        style: { padding: '2px 8px', fontSize: '11px' },
                        onClick: function () {
                          copyText(t.install).then(function (ok) {
                            setNote(ok ? '已复制安装命令' : '复制失败，请手动选中')
                          })
                        },
                      }, '复制安装命令')
                      : null,
                    t.url
                      ? h('button', {
                        className: 'dra-btn',
                        style: { padding: '2px 8px', fontSize: '11px' },
                        onClick: function () {
                          // 用系统浏览器打开官方下载页（不是我们代理下载）
                          try { window.open(t.url, '_blank', 'noopener') } catch { setNote('打开失败：' + t.url) }
                        },
                      }, '官方下载页')
                      : null,
                    t.install
                      ? h('span', { className: 'dra-dim dra-mono', style: { fontSize: '11px' } }, t.install)
                      : null,
                  ),
                )
                : null,
            )
          }),
          h('div', { className: 'dra-dim', style: { marginTop: '4px' } },
            '本插件不代下载第三方软件 —— 只告诉你缺什么、怎么装。'),
        )

      const errBox = state.error
        ? h('div', { className: 'dra-err' }, '读取失败：' + state.error)
        : null

      // ── 可达性横幅（2026-10-17）─────────────────────────────────────────
      //
      // 这是本插件**最贵的一个静默失败**：DSH 的 webserver 默认绑 127.0.0.1
      // （它面向"本机浏览器访问自己"），而本插件的用法是跨机 —— 副机拿
      // `ws://<主机IP>:19387/...` 拨入。绑 loopback 时：
      //
      //   · hub 自己一切正常（healthz 200、面板能开、工具都在）
      //   · 副机**永远连不上**（ECONNREFUSED / connect timeout）
      //   · 主机侧没有任何异常 → 用户只能猜"地址错了？token 错了？防火墙？"
      //
      // 实测三种用户会踩：全新安装（绝大多数）、装过改 lanBind 的插件又卸载
      // （托管块残留）、自己改错。
      //
      // 所以这里渲染成**红色横幅 + 具体修法**。日志用户不会看，面板会看。
      //
      // ═══════════════════════════════════════════════════════════════════════
      // 2026-10-20 重写（v0.9.3 审查 H5）：横幅要按**独立监听**判断
      // ═══════════════════════════════════════════════════════════════════════
      //
      // 0.9.3 把节点端点搬到了插件自己的监听端口（默认 19387），不再跟 DSH 的
      // webserver 同端口。但这里的判断条件仍是 `reach.loopback === true` ——
      // 而 DSH 的 webserver 默认就绑 127.0.0.1。
      //
      // 结果：副机明明能从 19387 连上，面板却天天挂一条大红条说"连不上"，
      // 还把用户引向"改 webserver 的 host"这个**已被证伪**的修法
      // （DSH 每次启动都重写 patch，改了就丢，而且跟新通道无关）。
      //
      // 现在分三种情况，只有真的连不上才红：
      //   · 独立监听在听且绑非回环 → 不显示横幅（正常）
      //   · 独立监听在听但绑回环   → 黄条：多半是 nodeToken 为空（安全策略）
      //   · 独立监听没起来          → 红条：端口被占/地址不可用，给改法
      const reach = caps && caps.reachability ? caps.reachability : null
      const lis = caps && caps.listener ? caps.listener : null
      const listenUp = lis && lis.ok === true
      const listenLoop = listenUp && reach ? reach.loopback === true : false

      // 只有"确实没有可用通道"才用红色；回环是策略问题，用黄色提示
      const reachBox = (function () {
        if (listenUp && listenLoop !== true) return null // 主通道正常，什么都不显示

        if (listenUp && listenLoop === true) {
          return h('div', { className: 'dra-warn', style: { marginBottom: '10px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '4px' } },
              '⚠ 独立监听绑在回环（' + (reach && reach.origin ? reach.origin : lis.host) + '），副机还连不上'),
            h('div', null, '这是**安全策略**：nodeToken 为空时，端点不暴露到网络'
              + '（否则同网络里任何人都能无口令接入）。'),
            h('div', { style: { marginTop: '6px' } },
              '修法：点右上角「副机接入」→「生成口令」，然后按提示重启 DSH。'),
          )
        }

        if (lis && lis.ok === false) {
          return h('div', { className: 'dra-err', style: { marginBottom: '10px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '4px' } },
              '⚠ 独立监听启动失败：副机拨不进来'),
            h('div', null, '原因：', h('code', null, lis.error || '未知')),
            h('div', { style: { marginTop: '6px' } },
              '修法：多半是端口 ' + (lis.port || 19387) + ' 被占用，'
              + '或者 listenHost 填的本机 IP 在这台机器上不存在（换网卡/换网络后很常见）。'
              + '改一个空闲的 listenPort、或把 listenHost 留空让它自动选，然后重启 DSH。'
              + '注意 listenHost 不能用 0.0.0.0（新版 DSH 直接拒绝，必须填具体 IP）。'),
          )
        }

        // 独立监听关闭/未就绪 → 退回老通道判断
        if (reach && reach.loopback === true) {
          return h('div', { className: 'dra-err', style: { marginBottom: '10px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '4px' } },
              '⚠ 副机连不上：没有可用的节点端口'),
            h('div', null, '独立监听未启用',
              lis && lis.disabled ? '（' + lis.disabled + '）' : '',
              '，而 DSH 的 Web 服务只监听 ', h('code', null, reach.origin || '127.0.0.1'), '。'),
            h('div', { style: { marginTop: '6px' } },
              '修法：去掉配置里的 ', h('code', null, 'listenPort: 0'), '，让独立监听启用。'),
          )
        }
        return null
      })()

      const offline = counts.nodes != null ? (counts.nodes - (counts.online || 0)) : 0
      const doneCount = (state.tasks || []).filter(function (t) { return t.status === 'completed' }).length
      const failCount = (state.tasks || []).filter(function (t) { return t.status === 'failed' || t.status === 'aborted' }).length
      const statbar = h('div', { className: 'dra-statbar' },
        h('div', { className: 'dra-stat' },
          h('div', { className: 'dra-stat-n' }, String(counts.nodes || 0)),
          h('div', { className: 'dra-stat-l' }, '节点总数')),
        h('div', { className: 'dra-stat' },
          h('div', { className: 'dra-stat-n' }, String(counts.online || 0)),
          h('div', { className: 'dra-stat-l' }, '在线')),
        h('div', { className: 'dra-stat' },
          h('div', { className: 'dra-stat-n' }, String(counts.running || 0)),
          h('div', { className: 'dra-stat-l' }, '任务中')),
        h('div', { className: 'dra-stat' },
          h('div', { className: 'dra-stat-n', style: { color: 'var(--dra-ok)' } }, String(doneCount)),
          h('div', { className: 'dra-stat-l' }, '完成')),
        h('div', { className: 'dra-stat' },
          h('div', { className: 'dra-stat-n', style: { color: 'var(--dra-danger)' } }, String(failCount)),
          h('div', { className: 'dra-stat-l' }, '失败')),
      )

      // ── 可折叠区块（2026-10-20，UI 改进）──────────────────────────
      //
      // 加了一键修复 / 外部工具 / SMB 共享之后，面板区块到了 9 个，
      // 首屏被淹没：用户打开面板先看到一堆"当前不需要"的东西。
      //
      // 用原生 `<details>`：
      //   · 零 JS 状态（不用 React 管展开/收起）
      //   · 可访问性好（键盘可操作、屏幕阅读器认）
      //   · 无 hydration 问题
      //
      // 默认展开策略由调用方决定（见下面的 render）：
      //   · 没副机在线 → 展开「接入与配置」（那是用户当下要解决的）
      //   · 有副机在线 → 展开「任务」
      const Fold = function (props) {
        return h('details', {
          className: 'dra-fold',
          open: props.open === true,
        },
          h('summary', null,
            h('span', null, props.title || ''),
            props.badge
              ? h('span', { className: 'dra-badge' }, props.badge)
              : null,
          ),
          h('div', { className: 'dra-fold-b' }, props.children),
        )
      }

      // ── 节点 ──
      //
      // 空态不能只说"还没有节点接入"（2026-10-20，体验提升 ①）。
      // 实测用户为此排查了两天：副机连不上时主机只显示「0 在线」，
      // **没有任何原因**。现在把连接尝试历史渲染出来：
      //   · 有过失败 → 显示"最后尝试 N 前 —— 人话原因 → 下一步做什么"
      //   · 从没尝试过 → 说明"副机还没开始连"（方向完全不同！）
      const conn = state.connection || { everConnected: false, byNode: [], recent: [] }
      const fmtAgo = function (at) {
        if (!at) return '未知时间'
        const sec = Math.max(0, Math.round((Date.now() - at) / 1000))
        if (sec < 60) return sec + ' 秒前'
        if (sec < 3600) return Math.round(sec / 60) + ' 分钟前'
        if (sec < 86400) return Math.round(sec / 3600) + ' 小时前'
        return Math.round(sec / 86400) + ' 天前'
      }

      const connDiag = function () {
        const fails = (conn.byNode || []).filter(function (e) { return e.result === 'fail' })
        if (fails.length > 0) {
          // 有失败记录：逐台显示最后一次失败的人话
          return h('div', null,
            fails.slice(0, 5).map(function (e) {
              return h('div', { key: (e.nodeId || '') + (e.remote || ''), style: { marginBottom: '8px' } },
                h('div', { className: 'dra-row', style: { alignItems: 'baseline' } },
                  h('span', { className: 'dra-mono', style: { color: 'var(--dsw-alias-state-error-primary, currentColor)' } }, '✗'),
                  h('span', { style: { flex: '1' } }, (e.nodeId || e.remote || '未知来源') + ' 连接失败'),
                  h('span', { className: 'dra-dim' }, fmtAgo(e.at)),
                ),
                e.title
                  ? h('div', { className: 'dra-dim', style: { paddingLeft: '20px' } }, e.title)
                  : null,
                e.hint
                  ? h('div', { className: 'dra-dim', style: { paddingLeft: '20px' } }, '→ ' + e.hint)
                  : null,
                e.raw
                  ? h('div', { className: 'dra-dim', style: { paddingLeft: '20px', opacity: 0.6 } }, '原始：' + e.raw)
                  : null,
              )
            }),
            conn.everConnected
              ? null
              : h('div', { className: 'dra-dim', style: { marginTop: '4px' } },
                '这台副机从未成功连上过 —— 先确认副机上的插件已配置 role: worker 并填了正确的 hubUrl。'),
          )
        }
        // 没有任何失败记录：区分"从没尝试"与"连上过但当前离线"
        return h('div', { className: 'dra-empty' },
          conn.everConnected
            ? '副机之前连上过，现在不在线 —— 检查副机 DSH 是否在跑。'
            : '还没有任何副机尝试连接。在副电脑上装本插件，把 config.role 设为 worker 并填 hubUrl（或用面板的配对码）。')
      }

      // 节点卡片网格（vps-workbench 风格：每节点一张独立卡片）
      const meterColor = function (pct) {
        if (pct >= 90) return 'var(--dra-danger)'
        if (pct >= 75) return 'var(--dra-warning)'
        return 'var(--dra-success)'
      }
      const nodeRows = state.nodes.map(function (n, i) {
        n._idx = i
        const r = n.resource
        const cpuPct = r && r.cpuPct != null ? Math.round(r.cpuPct) : null
        const memPct = r && r.memUsedMb != null && r.memTotalMb
          ? Math.round(r.memUsedMb / r.memTotalMb * 100) : null
        return h('div', { key: n.nodeId, className: 'dra-node-card' + (n.online ? ' online' : ' offline'),
          style: { animationDelay: (Math.min(n._idx || 0, 9) * 45) + 'ms' } },
          // ── 左侧状态色带 ──
          h('div', { className: 'dra-card-rail' }),
          // ── 头部: 状态点 + 节点名 ──
          h('div', { className: 'dra-card-head' },
            h(Dot, { on: n.online }),
            h('span', { className: 'dra-node-id' }, n.nodeId),
          ),
          // ── 徽章行 ──
          h('div', { className: 'dra-node-badges' },
            n.os ? h('span', { className: 'dra-badge' }, n.os) : null,
            n.agentMode ? h('span', { className: 'dra-badge' }, 'agent') : null,
            n.caps && n.caps.indexOf('file-transfer') >= 0
              ? h('span', { className: 'dra-badge', title: '支持双向文件互传（remote_file）' }, 'file')
              : null,
            n.caps && n.caps.indexOf('desktop') >= 0
              ? h('span', { className: 'dra-badge', title: '支持桌面截图（remote_screenshot）' }, 'screen')
              : null,
            n.caps && n.caps.indexOf('selfcheck') < 0
              ? h('span', { className: 'dra-badge', title: '副机插件版本较旧' }, '旧版')
              : null,
          ),
          // ── 卡片体: 指标列表 + 资源进度条 + 快捷操作 ──
          h('div', { className: 'dra-card-body' },
            h('div', { className: 'dra-metric-list' },
              h('div', { className: 'dra-metric-row' },
                h('span', { className: 'dra-metric-label' }, '任务'),
                h('span', { className: 'dra-metric-value' }, String(n.taskCount || 0)),
              ),
              h('div', { className: 'dra-metric-row' },
                h('span', { className: 'dra-metric-label' }, '最后在线'),
                h('span', { className: 'dra-metric-value' }, fmtTime(n.lastSeen)),
              ),
              cpuPct != null ? h('div', { className: 'dra-metric-row' },
                h('span', { className: 'dra-metric-label' }, 'CPU'),
                h('div', { className: 'dra-meter' },
                  h('div', { className: 'dra-meter-fill', style: { width: cpuPct + '%', background: meterColor(cpuPct) } })
                ),
              ) : null,
              memPct != null ? h('div', { className: 'dra-metric-row' },
                h('span', { className: 'dra-metric-label' }, 'MEM'),
                h('div', { className: 'dra-meter' },
                  h('div', { className: 'dra-meter-fill', style: { width: memPct + '%', background: meterColor(memPct) } })
                ),
              ) : null,
            ),
            // ── 快捷操作 ──
            h('div', { className: 'dra-quick-row' },
              h('button', {
                className: 'dra-btn',
                style: { fontSize: '11px', height: '26px', padding: '0 10px' },
                onClick: function (e) { e.stopPropagation(); setMonitorNode(n.nodeId) },
              }, '监控'),
            ),
          ),
          // ── 底栏 ──
          h('div', { className: 'dra-card-foot' },
            h('span', { className: 'dra-dim' }, n.online ? '在线' : '离线'),
            h('span', { className: 'dra-dim' }, fmtDur(n.uptime || 0)),
          ),
        )
      })

      const nodeSection = h('div', null,
        h('div', { className: 'dra-sec' }, '节点'),
        state.nodes.length === 0
          ? connDiag()
          : h('div', { className: 'dra-grid' }, nodeRows),
      )

      // ── 派任务表单 ──
      const nodeOptions = [{ id: '', label: state.nodes.length === 1 ? '（自动：唯一节点）' : '（请选择）' }]
        .concat(state.nodes.map(function (n) { return { id: n.nodeId, label: n.nodeId + (n.online ? '' : '（离线）') } }))

      const dispatchForm = h('div', null,
        h('div', { className: 'dra-sec' }, '派发任务'),
        // ── 模板行（配方）────────────────────────────────────────────
        //
        // 为什么放在表单**最上方**：它是对整张表单的操作（一键填充 / 把当前
        // 表单存下来），用户的动作顺序也是"先选模板，再看要不要改"。
        // 放在派发按钮旁边会让人以为它是"派发的一个选项"。
        //
        // 三个控件共用一行（flex-wrap 窄面板自动折行）：
        //   下拉 = 选模板并**立即填充**（不设"应用"按钮：多一步点击没有收益，
        //          而选错的代价只是再选一次，表单内容本来就随时可改）
        //   「存为模板」= 用当前表单内容新建/覆盖
        //   「删除」= 删掉当前选中的那条
        h('div', { className: 'dra-tplrow' },
          h('select', {
            className: 'dra-sel',
            value: fv.templateId,
            title: tpl.error
              ? ('模板库不可读：' + tpl.error)
              : (tpl.file ? ('模板存于 ' + tpl.file) : ''),
            onChange: function (e) { applyTemplate(e.target.value) },
          },
            h('option', { value: '' }, tpl.loading
              ? '模板：读取中…'
              : ((tpl.list || []).length === 0 ? '模板：（还没有，可把当前表单存下来）' : '模板：选一个一键填充')),
            (tpl.list || []).map(function (t) {
              return h('option', { key: t.id, value: t.id },
                t.name + (t.mode === 'exec' ? '（exec）' : '')
                  + (t.workspace ? ' · ' + t.workspace : ''))
            }),
          ),
          h('button', {
            className: 'dra-btn',
            disabled: isBusy || !fv.goal.trim() || !!tpl.error,
            title: tpl.error ? '模板库不可读（见下方提示）' : '把当前表单内容存成模板',
            onClick: saveTemplate,
          }, fv.templateId ? '更新模板' : '存为模板'),
          h('button', {
            className: 'dra-btn',
            disabled: isBusy || !fv.templateId,
            title: fv.templateId ? '删除当前选中的模板' : '先在下拉框里选一条模板',
            onClick: deleteTemplate,
          }, '删除模板'),
          // 数量上限提示：只在接近上限时出现 —— 平时它是噪音。
          // 到上限后保存会被服务端拒（409），这里提前说清原因。
          (tpl.max && (tpl.list || []).length >= tpl.max)
            ? h('span', { className: 'dra-tplnote' }, '模板已达上限 ' + tpl.max + ' 条 —— 先删掉不用的再存新的。')
            : null,
          // 降级提示：文件坏了 / 读不了时服务端回 degraded=true。
          // 必须显式说，否则用户看到空列表会以为"我的模板被删光了"。
          tpl.degraded
            ? h('span', { className: 'dra-tplnote' },
              '模板文件读不出来（' + (tpl.reason || 'unknown') + '）—— 已按空库显示。'
              + '下次保存会就地覆盖重建。文件：' + (tpl.file || '(未知)'))
            : null,
          tpl.error
            ? h('span', { className: 'dra-tplnote' }, '模板库不可用：' + tpl.error)
            : null,
          tplMsg ? h('span', { className: 'dra-tplnote' }, tplMsg) : null,
        ),
        h('div', { className: 'dra-form' },
          // ── 3 个核心字段（始终可见）──────────────────────────────────
          h('select', {
            className: 'dra-sel',
            value: fv.node,
            onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.node = e.target.value; return n }) },
          }, nodeOptions.map(function (o) { return h('option', { key: o.id, value: o.id }, o.label) })),
          h('textarea', {
            className: 'dra-ta',
            placeholder: '任务目标，例如：在这个工作区里跑一遍测试并写出报告',
            value: fv.goal,
            onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.goal = e.target.value; return n }) },
          }),
          h('select', {
            className: 'dra-sel',
            value: fv.mode,
            onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.mode = e.target.value; return n }) },
          },
            h('option', { value: 'agent' }, 'agent（独立会话）'),
            h('option', { value: 'exec' }, 'exec（直接命令）'),
          ),
          // ── 高级选项（折叠）──────────────────────────────────────────
          h('details', { className: 'dra-fold dra-advanced', style: { marginTop: '4px' } },
            h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: 'var(--dra-i4)', padding: '4px 0' } }, '高级选项（模板 / 工作区 / 模型 / 产出 / 超时）'),
            h('div', { className: 'dra-form', style: { marginTop: '6px', gap: '6px' } },
              // 模板行
              h('div', { className: 'dra-tplrow' },
                h('select', {
                  className: 'dra-sel',
                  value: fv.templateId,
                  title: tpl.error ? ('模板库不可读：' + tpl.error) : '',
                  onChange: function (e) { applyTemplate(e.target.value) },
                },
                  h('option', { value: '' }, tpl.loading ? '模板：读取中…' : ((tpl.list || []).length === 0 ? '模板：（还没有）' : '模板：选一个填充')),
                  (tpl.list || []).map(function (t) {
                    return h('option', { key: t.id, value: t.id }, t.name + (t.mode === 'exec' ? '（exec）' : '') + (t.workspace ? ' · ' + t.workspace : ''))
                  }),
                ),
                h('button', { className: 'dra-btn', disabled: isBusy || !fv.goal.trim() || !!tpl.error, title: '把当前表单存成模板', onClick: saveTemplate }, fv.templateId ? '更新' : '存为模板'),
                h('button', { className: 'dra-btn', disabled: isBusy || !fv.templateId, title: '删除当前选中模板', onClick: deleteTemplate }, '删除'),
              ),
              tplMsg ? h('span', { className: 'dra-tplnote' }, tplMsg) : null,
              tpl.degraded ? h('span', { className: 'dra-tplnote' }, '模板文件读不出来（' + (tpl.reason || 'unknown') + '）—— 下次保存会就地覆盖重建') : null,
              tpl.error ? h('span', { className: 'dra-tplnote' }, '模板库不可用：' + tpl.error) : null,
              h('input', {
                className: 'dra-in',
                placeholder: '工作区（留空用节点默认；须在副机 roots 内）',
                value: fv.workspace,
                onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.workspace = e.target.value; return n }) },
              }),
              // 模型选择（复用原有逻辑，提案 #27）
              (function () {
                const chosen = fv.node.trim()
                const targets = chosen !== ''
                  ? state.nodes.filter(function (n) { return n.nodeId === chosen || n.hostname === chosen })
                  : state.nodes.filter(function (n) { return n.online })
                const seen = {}
                const opts = []
                targets.forEach(function (n) {
                  (Array.isArray(n.models) ? n.models : []).forEach(function (m) {
                    const key = m.provider + '\u0000' + m.id
                    if (seen[key]) return
                    seen[key] = true
                    opts.push({ provider: m.provider, id: m.id, name: m.name || m.id, nodeId: n.nodeId })
                  })
                })
                const hasList = targets.some(function (n) { return Array.isArray(n.models) })
                const def = targets.length > 0 ? targets[0].defaultModel : null
                const defLabel = def && def.model
                  ? '跟随副机默认（' + (def.provider ? def.provider + '/' : '') + def.model + '）'
                  : '跟随副机默认'
                if (!hasList || opts.length === 0) {
                  return h('div', null,
                    h('input', {
                      className: 'dra-in',
                      placeholder: '模型（可选，如 deepseek-reasoner 或 provider/model）',
                      value: fv.model,
                      onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.model = e.target.value; return n }) },
                    }),
                    hasList ? h('div', { className: 'dra-dim', style: { marginTop: '2px' } }, '副机上报的模型清单为空 —— 需手动填写，或先在副机配置模型。') : null,
                  )
                }
                const isCustom = modelCustom || (fv.model !== '' && !opts.some(function (o) {
                  return (o.provider ? o.provider + '/' : '') + o.id === fv.model
                }))
                const multi = targets.length > 1
                return h('div', null,
                  h('select', {
                    className: 'dra-in',
                    value: isCustom ? '__custom__' : fv.model,
                    onChange: function (e) {
                      const v = e.target.value
                      if (v === '__custom__') { setModelCustom(true); setForm(function (f) { const n = Object.assign({}, f); n.model = ''; return n }); return }
                      setModelCustom(false); setForm(function (f) { const n = Object.assign({}, f); n.model = v; return n })
                    },
                  },
                    h('option', { value: '' }, defLabel),
                    opts.map(function (o) {
                      const val = (o.provider ? o.provider + '/' : '') + o.id
                      return h('option', { key: val + o.nodeId, value: val }, (o.name || o.id) + (o.provider ? '（' + o.provider + '）' : '') + (multi ? ' · ' + o.nodeId : ''))
                    }),
                    h('option', { value: '__custom__' }, '自定义…'),
                  ),
                  isCustom ? h('input', { className: 'dra-in', style: { marginTop: '4px' }, placeholder: '自定义模型（provider/model）', value: fv.model, onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.model = e.target.value; return n }) } }) : null,
                )
              })(),
              h('input', {
                className: 'dra-in',
                placeholder: '期望产出 glob，逗号分隔（可选）',
                value: fv.outputs,
                onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.outputs = e.target.value; return n }) },
              }),
              h('input', {
                className: 'dra-in',
                placeholder: '超时毫秒（可选，留空用主机默认；如 1800000 = 30 分钟）',
                value: fv.timeoutMs,
                onChange: function (e) { setForm(function (f) { const n = Object.assign({}, f); n.timeoutMs = e.target.value; return n }) },
              }),
            ),
          ),
          // ── 派发按钮（全宽 accent，hover 发光）────────────────────────
          h('button', {
            className: 'dra-btn dra-dispatch-btn',
            disabled: isBusy || !fv.goal.trim() || state.nodes.filter(function (n) { return n.online }).length === 0,
            onClick: dispatch,
          }, isBusy ? '派发中…' : '▶ 派发任务'),
          note ? h('div', { className: 'dra-dim', style: { marginTop: '4px' } }, note) : null,
        ),
      )

      // ── 任务列表 ──
      //
      // ═══════════════════════════════════════════════════════════════════
      // #26-4：按状态分组，**运行中置顶且显示已跑多久**
      // ═══════════════════════════════════════════════════════════════════
      //
      // 事故（2026-10-17 实测）：副机的 `maxConcurrent=2` 被两条卡住的
      // exec 占满，后续任务全部排队。但面板只显示**一个数字**
      // （`running: 2`），用户看不到是哪两条、在跑什么、跑了多久 ——
      // 只知道"卡了"，没有任何可操作的东西。
      //
      // 那次的代价：排查花了很久，因为"卡住的任务"在面板上完全不可见。
      //
      // 所以这里把任务列表改成三段：
      //   · 运行中 —— 置顶，显示**已跑时长**（`startedAt` 与现在的时间差）
      //   · 待审批 —— 次之（等用户动作的也要显眼）
      //   · 其它 —— 按 updatedAt 倒序
      //
      // 只在有运行中任务时才显示"运行中"小标题，避免空分组占位。
      const ACTIVE_STATUSES = ['running', 'queued', 'pending_approval']
      const activeTasks = state.tasks.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 })
      const restTasks = state.tasks.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) < 0 })

      /** 单条任务的行（分组内复用）。 */
      const renderTaskRow = function (t) {
        const isSel = t.taskId === selected
        // 运行中的任务显示"已跑 N 秒"—— 这是判断"是不是卡住了"的唯一线索。
        const liveSec = t.status === 'running' && t.startedAt
          ? Math.max(0, Math.round((Date.now() - t.startedAt) / 1000))
          : 0

        // ── 进度摘要（2026-10-20，体验提升 ⑤）─────────────────────────
        //
        // 原来只有展开详情才能看到「进行步骤」。但长任务（agent 跑 10 分钟）
        // 用户最想知道的是"它现在在干什么"—— 为此点开详情是多余的摩擦。
        //
        // 这里在**任务行下方**加一行摘要：最后一步 + 总步数。
        //   · 只对运行中的任务显示（已完成的任务看结果摘要更有用）
        //   · 只取最后一条有 detail 的（tool/assistant 事件才有内容）
        let progressLine = null
        if (t.status === 'running' && Array.isArray(t.progressTail) && t.progressTail.length > 0) {
          const tail = t.progressTail
          // 从后往前找第一条带 detail 的（"started"/"agent-start" 这类没有内容）
          let last = null
          for (let i = tail.length - 1; i >= 0; i -= 1) {
            const p = tail[i]
            if (p && typeof p.detail === 'string' && p.detail.trim() !== '') { last = p; break }
          }
          if (last) {
            const phase = typeof last.phase === 'string' ? last.phase : ''
            progressLine = h('div', {
              className: 'dra-task-prog',
              style: { paddingLeft: '20px' },
              title: last.detail,
            },
              '最近：' + (phase === 'tool' ? '调用工具 ' : '') + last.detail.slice(0, 120),
              ' · 共 ' + tail.length + ' 步',
            )
          }
        }

        return h('div', { key: t.taskId },
          h('div', {
            className: 'dra-task-row' + (isSel ? ' sel' : ''),
            onClick: function () { setSelected(isSel ? null : t.taskId) },
          },
            h(StatusBadge, { status: t.status }),
            h('div', { className: 'dra-task-meta' },
              h('div', { className: 'dra-task-goal', title: t.goal }, t.goal || t.taskId),
              h('div', { className: 'dra-task-sub' },
                t.nodeId,
                liveSec > 0
                  ? ' · 已跑 ' + fmtDur(liveSec * 1000)
                  : (t.durationMs ? ' · ' + fmtDur(t.durationMs) : ''),
              ),
            ),
          ),
          progressLine,
          isSel ? h(TaskDetail, {
            task: t, detail: detail, caps: caps, onCancel: cancel, onPull: pull,
            onApprove: approve, onReject: reject,
          }) : null,
        )
      }

      const taskRows = state.tasks.length === 0
        ? h('div', { className: 'dra-empty' }, '还没有任务。')
        : h('div', null,
          activeTasks.length > 0
            ? h('div', null,
              h('div', { className: 'dra-sub' }, '运行中（' + activeTasks.length + '）'),
              activeTasks.map(renderTaskRow),
            )
            : null,
          restTasks.length > 0
            ? h('div', null,
              activeTasks.length > 0 ? h('div', { className: 'dra-sub' }, '已完成 / 已结束') : null,
              restTasks.map(renderTaskRow),
            )
            : null,
        )

      const taskSection = h('div', null,
        h('div', { className: 'dra-sec' }, '任务'),
        taskRows,
      )

      // ── 副机视图 ────────────────────────────────────────────────────────
      //
      // 本机是 worker（不是派活方）时走这里。**不是"藏掉 404"**，而是显示
      // 副机自己的状态 —— 这些数据本来就在它本地（TaskStore），原先只是没有
      // UI 暴露。副机面板能回答的问题：
      //   · 我是谁（nodeId / 角色）
      //   · 我连的是谁（hubUrl / 中继）
      //   · 我连上了吗（online）
      //   · 我在干什么（任务队列：running / queued / 各状态计数）
      //   · 我允许在哪干活（roots）
      //   · 出过错吗（lastError）
      if (state.mode === 'worker') {
        const w = state.worker || {}
        const wt = w.tasks || {}
        const byStatus = wt.byStatus || {}
        const workerCards = h('div', { className: 'dra-cards' },
          h('div', { className: 'dra-card' },
            h('div', { className: 'dra-card-n' }, String(wt.running || 0)),
            h('div', { className: 'dra-card-l' }, '进行中')),
          h('div', { className: 'dra-card' },
            h('div', { className: 'dra-card-n' }, String(wt.queued || 0)),
            h('div', { className: 'dra-card-l' }, '排队中')),
          h('div', { className: 'dra-card' },
            h('div', { className: 'dra-card-n' }, String(wt.total || 0)),
            h('div', { className: 'dra-card-l' }, '任务总数')),
        )

        // 键值行：与 hub 视图的「主机设置」保持同一视觉语言
        const kv = function (k, v, mono) {
          return h('div', { className: 'dra-kv' },
            h('span', { className: 'dra-k' }, k),
            h('span', { className: mono ? 'dra-mono dra-ell' : 'dra-ell', title: String(v) }, String(v)),
          )
        }
        const workerInfo = h('div', null,
          h('div', { className: 'dra-sec' }, '本机状态'),
          kv('角色', 'worker — 副机（干活方）'),
          kv('节点 ID', w.nodeId || '(未设置)'),
          kv('连接', w.online ? '已连上主机' : '未连接'),
          kv('传输方式', w.transportMode || '-'),
          kv('主机地址', w.url || '(未配置)'),
          kv('执行后端', w.runner || '-'),
          kv('状态目录', w.stateDir || '-'),
          kv('DSH 版本', w.dshVersion || '-'),
          kv('协议版本', w.protocol || '-'),
        )

        const workerRoots = h('div', null,
          h('div', { className: 'dra-sec' }, '允许的工作区（roots）'),
          (w.roots && w.roots.length)
            ? w.roots.map(function (r) { return h('div', { key: r, className: 'dra-row' }, h('span', { className: 'dra-mono dra-ell' }, r)) })
            : h('div', { className: 'dra-empty' }, '未配置 roots —— 任务无法执行。请在 profile 的 cordis.patch.yml 里设置 config.roots。'),
        )

        const workerCaps = h('div', null,
          h('div', { className: 'dra-sec' }, '本机能力'),
          (w.caps && w.caps.length)
            ? h('div', { className: 'dra-row' }, w.caps.map(function (c) {
              return h('span', { key: c, className: 'dra-badge' }, c)
            }))
            : h('div', { className: 'dra-dim' }, '-'),
        )

        const workerTasks = h('div', null,
          h('div', { className: 'dra-sec' }, '任务状态分布'),
          Object.keys(byStatus).length
            ? Object.keys(byStatus).map(function (k) {
              return h('div', { key: k, className: 'dra-row' },
                h('span', { className: 'dra-mono' }, k),
                h('span', { className: 'dra-spacer' }),
                h('span', { className: 'dra-dim' }, String(byStatus[k])),
              )
            })
            : h('div', { className: 'dra-empty' }, '还没有任务。任务由主机派发。'),
        )

        const workerErr = w.lastError
          ? h('div', null,
            h('div', { className: 'dra-sec' }, '最近一次错误'),
            h('div', { className: 'dra-pre' }, String(w.lastError)),
          )
          : null

        // 提示：任务详情/成品清单在主机的面板上看（副机只有自己的状态）
        const workerHint = h('div', { className: 'dra-empty', style: { marginTop: '12px' } },
          '本机是副机：任务的派发与结果查看在主机面板上。这里只显示本机自己的状态。')

        const workerHead = h('div', { className: 'dra-head' },
          h('span', { className: 'dra-title' }, '远程同事'),
          h('span', { className: 'dra-dim' }, w.online ? '已连上主机' : '未连接'),
          h('span', { className: 'dra-spacer' }),
          h('button', { className: 'dra-btn', onClick: refresh }, '刷新'),
        )

        return h('div', { className: 'dra-root' },
          h(StyleTag),
          workerHead,
          h('div', { className: 'dra-body' },
            errBox, workerCards, workerInfo, workerRoots, workerCaps, workerTasks, workerErr, workerHint,
          ),
        )
      }

      return h('div', { className: 'dra-root' + (theme === 'light' ? ' dra-light' : '') },
        h(StyleTag),
        head,
        h('div', { className: 'dra-body' },
          errBox,
          reachBox,
          statbar,
          // ── 主工作区双列布局 2fr / 1fr ──────────────────────────────
          h('div', { className: 'dra-workspace' },
            // 左列：节点卡片 + 任务列表
            h('div', { className: 'dra-workspace-main' },
              nodeSection,
              taskSection,
            ),
            // 右列：快速派发 + 接入副机
            h('div', { className: 'dra-workspace-side' },
              // 快速派发面板
              h('div', { className: 'dra-side-card' },
                h('div', { className: 'dra-sec' }, '快速派发'),
                dispatchForm,
              ),
              // 接入副机（含 relay-enroll）
              h('div', { className: 'dra-side-card', style: { marginTop: '12px' } },
                h('div', { className: 'dra-sec' }, '接入副机'),
                !enroll.open
                  ? h('button', {
                    className: 'dra-btn dra-enroll-btn',
                    onClick: mintEnrollToken,
                  }, '+ 添加副机')
                  : h('div', { className: 'dra-enroll-card' },
                    enroll.loading
                      ? h('div', { className: 'dra-empty' }, '铸造中…')
                      : enroll.error
                        ? h('div', null,
                          h('div', { className: 'dra-err' }, enroll.error),
                          h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                            h('button', { className: 'dra-btn', onClick: mintEnrollToken }, '重试'),
                            h('button', { className: 'dra-btn ghost', onClick: function () { setEnroll({ open: false, loading: false, data: null, error: '' }) } }, '关闭'),
                          ),
                        )
                        : enroll.data
                          ? h('div', null,
                            h('div', { className: 'dra-kv' },
                              h('span', { className: 'dra-k' }, '中继地址'),
                              h('span', { className: 'dra-mono dra-ell' }, enroll.data.relayUrl),
                            ),
                            h('div', { className: 'dra-kv', style: { alignItems: 'flex-start', marginTop: '8px' } },
                              h('span', { className: 'dra-k' }, 'Token'),
                              h('div', { style: { flex: '1' } },
                                h('div', {
                                  className: 'dra-mono',
                                  style: { fontSize: '13px', fontWeight: '700', color: 'var(--dra-accent)', wordBreak: 'break-all', lineHeight: '1.4' },
                                }, enroll.data.enrollToken),
                                h('button', {
                                  className: 'dra-btn',
                                  style: { marginTop: '5px' },
                                  onClick: function () { copyText(enroll.data.enrollToken).then(function () { setPairNote('已复制 enrollToken') }) },
                                }, '复制 Token'),
                              ),
                            ),
                            h('div', { className: 'dra-kv' },
                              h('span', { className: 'dra-k' }, '有效期'),
                              h('span', { className: 'dra-mono' }, Math.round((enroll.data.expiresInMs || 900000) / 60000) + ' 分钟'),
                            ),
                            h('div', { className: 'dra-hint', style: { marginTop: '8px', fontSize: '11px' } },
                              '在副机 remote-agent 面板选中继模式，填入上方地址和 Token。'),
                            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
                              h('button', { className: 'dra-btn', onClick: mintEnrollToken }, '再铸一个'),
                              h('button', { className: 'dra-btn ghost', onClick: function () { setEnroll({ open: false, loading: false, data: null, error: '' }) } }, '关闭'),
                            ),
                          )
                          : null,
                  ),
                pairNote ? h('div', { className: 'dra-note', style: { marginTop: '6px' } }, pairNote) : null,
              ),
            ),
          ),
          // ── 底部折叠区 ────────────────────────────────────────────────
          Fold({
            title: '接入与配置',
            open: state.nodes.length === 0,
            children: h('div', null, cfgSection, pairSection),
          }),
          Fold({
            title: '环境体检与工具',
            open: Boolean(envCheck && envCheck.failed > 0),
            badge: envCheck && envCheck.failed > 0 ? String(envCheck.failed) : '',
            children: h('div', null, envSection, toolsSection),
          }),
          Fold({
            title: '工作区共享（SMB）',
            children: h('div', null, h(SharePanel, { nodes: state.nodes })),
          }),
        ),
      )
    }


    /** 单台副机的日志监控视图（全屏覆盖式） */
    function NodeMonitor(props) {
      const nodeId = props.nodeId
      const tasks = (props.tasks || []).filter(function (t) { return t.nodeId === nodeId })
      const ACTIVE = ['running', 'queued', 'pending_approval']
      const activeTasks = tasks.filter(function (t) { return ACTIVE.indexOf(t.status) >= 0 })
      const doneTasks = tasks.filter(function (t) { return ACTIVE.indexOf(t.status) < 0 })
      const selS = React.useState(activeTasks.length > 0 ? activeTasks[0].taskId : null)
      const selId = selS[0]
      const setSel = selS[1]

      function renderMonitorRow(t) {
        const isSel = t.taskId === selId
        const liveSec = t.status === 'running' && t.startedAt
          ? Math.max(0, Math.round((Date.now() - t.startedAt) / 1000))
          : 0
        return h('div', {
          key: t.taskId,
          style: {
            padding: '6px 10px',
            cursor: 'pointer',
            background: isSel ? 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.08))' : 'transparent',
            borderRadius: '4px',
          },
          onClick: function () { setSel(isSel ? null : t.taskId) },
        },
          h('div', { className: 'dra-row' },
            h(StatusBadge, { status: t.status }),
            h('span', { className: 'dra-ell', style: { flex: '1', fontSize: '12px' }, title: t.goal }, t.goal || t.taskId),
            liveSec > 0
              ? h('span', { className: 'dra-dim' }, fmtDur(liveSec * 1000))
              : (t.durationMs ? h('span', { className: 'dra-dim' }, fmtDur(t.durationMs)) : null),
          ),
          isSel ? h('div', { style: { marginTop: '6px' } },
            // 进行步骤
            (t.progressTail && t.progressTail.length > 0)
              ? h('div', null,
                h('div', { className: 'dra-sec' }, '执行步骤 (' + t.progressTail.length + ')'),
                h('div', { className: 'dra-pre', style: { maxHeight: '200px', overflowY: 'auto' } },
                  t.progressTail.slice().reverse().map(function (p) {
                    if (!p) return ''
                    const ts = p.at ? fmtTime(p.at) + ' ' : ''
                    const phase = p.phase ? '[' + p.phase + '] ' : ''
                    return ts + phase + (p.detail || '')
                  }).join('\n'),
                ),
              ) : null,
            // 日志尾部
            (t.logTail && t.logTail.length > 0)
              ? h('div', null,
                h('div', { className: 'dra-sec' }, '日志尾部'),
                h('div', { className: 'dra-pre', style: { maxHeight: '200px', overflowY: 'auto' } },
                  t.logTail.join('\n'),
                ),
              ) : null,
            // 错误
            t.error
              ? h('div', { className: 'dra-err', style: { marginTop: '4px' } },
                (t.error.code || '') + ': ' + (t.error.message || ''),
              ) : null,
            // 摘要
            t.summaryText
              ? h('div', null,
                h('div', { className: 'dra-sec' }, '结果摘要'),
                h('div', { className: 'dra-pre', style: { maxHeight: '120px', overflowY: 'auto' } }, t.summaryText),
              ) : null,
          ) : null,
        )
      }

      return h('div', {
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,.75)', zIndex: 9999,
          display: 'flex', flexDirection: 'column',
        },
      },
        // 头部
        h('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-1, #04060c)',
            borderBottom: '1px solid var(--dsw-alias-border-default, rgba(255,255,255,.1))',
            padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0,
          },
        },
          h('span', { style: { fontWeight: 700, fontSize: '14px' } }, '副机监控'),
          h('span', { className: 'dra-mono', style: { color: 'var(--dsw-alias-fg-muted, rgba(255,255,255,.5))' } }, nodeId),
          h('span', { style: {
            background: 'rgba(46,230,255,.1)', color: '#2ee6ff',
            border: '1px solid rgba(46,230,255,.25)', borderRadius: '10px',
            padding: '1px 8px', fontSize: '11px', fontWeight: 600,
          } }, activeTasks.length + ' 运行中 · ' + tasks.length + ' 总计'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            className: 'dra-btn',
            onClick: props.onClose,
          }, '关闭'),
        ),
        // 主体：左侧任务列表 + 右侧（空间预留）
        h('div', {
          style: {
            flex: 1, overflow: 'hidden', display: 'flex',
            background: 'var(--dsw-alias-bg-layer-1, #04060c)',
          },
        },
          h('div', {
            style: {
              width: '100%', overflowY: 'auto', padding: '12px',
              display: 'flex', flexDirection: 'column', gap: '4px',
            },
          },
            activeTasks.length > 0
              ? h('div', null,
                h('div', { className: 'dra-sub' }, '运行中 / 排队中 (' + activeTasks.length + ')'),
                activeTasks.map(renderMonitorRow),
              ) : null,
            doneTasks.length > 0
              ? h('div', null,
                h('div', { className: 'dra-sub', style: { marginTop: activeTasks.length > 0 ? '12px' : 0 } }, '已完成 / 已结束 (' + doneTasks.length + ')'),
                doneTasks.slice(0, 30).map(renderMonitorRow),
              ) : null,
            tasks.length === 0
              ? h('div', { className: 'dra-empty' }, '这台副机还没有任何任务记录。')
              : null,
          ),
        ),
      )
    }

    /** 单任务展开区：结果卡 + 成品清单 + 操作。 */
    function TaskDetail(props) {
      const t = props.task || {}
      const d = props.detail || {}
      const handoff = d.handoff || null
      const manifest = (handoff && handoff.artifacts) || null
      const finals = (manifest && manifest.final) || []

      return h('div', { style: { padding: '4px 9px 12px' } },
        // 摘要
        t.summaryText ? h('div', null,
          h('div', { className: 'dra-sec' }, '结果摘要'),
          h('div', { className: 'dra-pre' }, t.summaryText),
        ) : null,

        // 失败原因
        t.error ? h('div', null,
          h('div', { className: 'dra-sec' }, '错误'),
          h('div', { className: 'dra-pre' }, (t.error.code || '') + ': ' + (t.error.message || '')),
        ) : null,

        // 变更
        //
        // 服务端已对 changed 做元素级投影（ui-routes.js 的 changedView），
        // 这里再挡一层：`c` 若非对象（null / 字符串 / 数字），直接解引用 `c.op`
        // 会抛 TypeError，而**渲染期抛错会让整个 slot entry 空白**（面板白屏）。
        // 纵深防御：不假设上游数据永远干净，因为上游数据源自副机上报。
        t.changedCount > 0 ? h('div', null,
          h('div', { className: 'dra-sec' }, '工作区变更（' + t.changedCount + '）'),
          (t.changed || []).slice(0, 12).map(function (c, i) {
            if (!c || typeof c !== 'object') return null
            return h('div', { key: i, className: 'dra-file' },
              h('span', { className: 'dra-badge' }, typeof c.op === 'string' ? c.op : 'unknown'),
              h('span', { className: 'dra-mono dra-ell' }, typeof c.path === 'string' ? c.path : ''),
              c.bytes ? h('span', { className: 'dra-dim' }, c.bytes + 'B') : null,
            )
          }),
        ) : null,

        // 变更 diff（提案 #21）：文本文件改动的 unified diff，随 handoff 卡回传。
        // 每文件一块（先给 6 块防面板爆长）；副机旧版本不带 diffs 字段时整段消失。
        (handoff && handoff.diffs && handoff.diffs.length) ? h('div', null,
          h('div', { className: 'dra-sec' }, '变更 diff（' + handoff.diffs.length + ' 个文件）'),
          handoff.diffs.slice(0, 6).map(function (df, i) {
            if (!df || typeof df !== 'object' || typeof df.diff !== 'string') return null
            return h('div', { key: i },
              h('div', { className: 'dra-file' },
                h('span', { className: 'dra-badge' }, 'diff'),
                h('span', { className: 'dra-mono dra-ell', style: { flex: '1' }, title: df.path }, typeof df.path === 'string' ? df.path : ''),
                df.truncated ? h('span', { className: 'dra-dim' }, '截断') : null,
              ),
              h('div', { className: 'dra-pre' }, df.diff),
            )
          }),
          handoff.diffs.length > 6 ? h('div', { className: 'dra-dim' }, '… 另有 ' + (handoff.diffs.length - 6) + ' 个文件的 diff 未展示') : null,
        ) : null,

        // 成品清单 + 拉取
        h('div', null,
          h('div', { className: 'dra-sec' }, '成品（role:final）' +
            (manifest && manifest.counts ? '  ' + manifest.counts.final + ' 项' : '')),
          finals.length === 0
            ? h('div', { className: 'dra-dim' }, '本次没有可拉取的成品。中间产物只上报元数据，留在副机。')
            : h('div', null,
              finals.slice(0, 20).map(function (f, i) {
                return h('div', { key: i, className: 'dra-file' },
                  h('span', { className: 'dra-mono dra-ell', style: { flex: '1' }, title: f.path }, f.path),
                  h('span', { className: 'dra-badge' }, f.kind || 'file'),
                  h('span', { className: 'dra-dim' }, f.bytes + 'B'),
                )
              }),
              h('div', { className: 'dra-actions' },
                h('button', {
                  className: 'dra-btn',
                  disabled: !props.caps || !props.caps.pull,
                  title: props.caps && props.caps.pull
                    ? ('落地到 ' + props.caps.pullRoot)
                    : '未配置 uiPullRoot，拉取已禁用',
                  onClick: function () { props.onPull(t.taskId, finals.map(function (f) { return f.path })) },
                }, '拉取全部成品'),
              ),
            ),
        ),

        // 操作
        h('div', { className: 'dra-actions' },
          // 两阶段审批（提案 #2）：挂起中的任务先给批准/拒绝 —— 批准才真正
          // 派给副机；取消按钮保留（对挂起任务等价于拒绝，走 cancelTask 的
          // 本地拒绝分支）。
          t.status === 'pending_approval'
            ? h('span', { className: 'dra-actions' },
              h('button', { className: 'dra-btn', onClick: function () { props.onApprove(t.taskId) } }, '批准并派发'),
              h('button', { className: 'dra-btn', onClick: function () { props.onReject(t.taskId) } }, '拒绝'),
            )
            : null,
          h('button', { className: 'dra-btn', onClick: function () { props.onCancel(t.taskId) } }, '取消任务'),
        ),

        // 进行步骤（提案 #15）：副机 task/progress 帧的实时投影 —— 长任务
        // 不用等 handoff 就能看到"现在跑到哪一步"。面板 4s 自动轮询刷新。
        // 客户端只渲染尾部 8 条（hub 侧已存 20），倒序最新在上。
        (t.progressTail && t.progressTail.length) ? h('div', null,
          h('div', { className: 'dra-sec' }, '进行步骤'),
          t.progressTail.slice(-8).reverse().map(function (p, i) {
            if (!p || typeof p !== 'object') return null
            return h('div', { key: i, className: 'dra-file' },
              h('span', { className: 'dra-badge' }, typeof p.phase === 'string' ? p.phase : 'progress'),
              h('span', { className: 'dra-ell', style: { flex: '1' }, title: p.detail }, typeof p.detail === 'string' ? p.detail : ''),
              h('span', { className: 'dra-dim' }, fmtTime(p.at)),
            )
          }),
        ) : null,

        // 日志尾部
        (t.logTail && t.logTail.length) ? h('div', null,
          h('div', { className: 'dra-sec' }, '日志尾部'),
          h('div', { className: 'dra-pre' }, t.logTail.join('\n')),
        ) : null,
      )
    }

    /* ───────────────────────── 插件导出 ───────────────────────── */

    return {
      // slots 是硬依赖（没有它整个插件没有意义）；locale 可选，本版未用字典。
      inject: ['slots'],
      apply: function (ctx) {
        const disposers = []

        // 样式随 apply 生命周期：卸载时自动摘掉 <style>
        const stylesSvc = ctx.get ? ctx.get('styles') : null
        if (stylesSvc && typeof stylesSvc.insert === 'function') {
          disposers.push(stylesSvc.insert(CSS))
        }

        // ① 侧栏图标
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 30, label: function () { return '远程同事' } },
            PanelIcon,
          )
        })

        // ② 主面板 —— key 必须与上面的 id 相同，否则点图标没有反应
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel)
        })

        return function () {
          for (let i = 0; i < disposers.length; i++) {
            try { disposers[i]() } catch { /* 已释放 */ }
          }
        }
      },
    }
  },
})
