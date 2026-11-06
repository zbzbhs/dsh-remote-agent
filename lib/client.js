/**
 * dsh-remote-agent 的浏览器半边（零依赖纯 JS，无 JSX/TS/import）。
 *
 * v2 从零重写（fork.17）：
 *   · Panel 顶部集中声明全部 useState —— 任何条件 return 之前
 *   · Hub / Worker 两张模式卡片，点击切换；接入配置区始终可见
 *   · 深色科技感（#05070d + #2ee6ff），hover 显示次要信息
 *   · 数据只走本包 Host 半边注册的真实路由，不臆造端点
 *
 * 两个插槽配对使用（DSH 标准「点侧栏图标打开面板」）：
 *   - sidebar.panellist：注册图标，id = 'dsh-remote-agent'
 *   - main：注册面板，key 必须等于那个 id
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/remote-agent/ui'
    const PANEL_KEY = 'dsh-remote-agent'
    const STATUS_PATH = '/api/remote-agent/status'
    const SETUP_STATE_PATH = '/api/remote-agent/setup/state'
    const SETUP_APPLY_PATH = '/api/remote-agent/setup/apply'

    /* 运行中（+ 待派发）状态集合。终态一律不进「运行中」分组。 */
    const ACTIVE_STATUSES = ['running', 'queued', 'pending', 'provisioning']
    const STATUS_LABEL = {
      running: '运行中', queued: '排队中', pending: '待批准', provisioning: '准备中',
      done: '已完成', failed: '失败', aborted: '已中止', rejected: '已拒绝',
    }

    /* ───────────────────────────── 样式 ───────────────────────────── */
    const CSS = [
      /* 设计 token */
      '.dra-root{',
      '--dra-s0:#05070d;--dra-s1:#0b0e18;--dra-s2:#111523;--dra-s3:#171d2e;',
      '--dra-line:rgba(120,165,255,.14);--dra-line2:rgba(46,230,255,.38);',
      '--dra-text:#e0e6f0;--dra-dim:#6b7a99;--dra-faint:#3d4860;',
      '--dra-accent:#2ee6ff;--dra-ok:#25e58c;--dra-danger:#ff4d6e;--dra-warn:#ffb547;',
      '--dra-r-sm:8px;--dra-r-md:12px;--dra-r-lg:18px;',
      '--dra-gloss:inset 0 1px 0 rgba(255,255,255,.06);',
      '--dra-shadow-1:0 2px 8px rgba(0,0,0,.4);--dra-shadow-2:0 10px 28px rgba(0,0,0,.55);',
      '--dra-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;',
      '--dra-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      'color:var(--dra-text);background:var(--dra-s0);font-family:var(--dra-sans);font-size:11.5px;',
      'min-height:100%;padding:14px 16px 22px;box-sizing:border-box;',
      'background-image:radial-gradient(1200px 380px at 18% -8%,rgba(46,230,255,.07),transparent 60%),radial-gradient(900px 320px at 92% 0,rgba(120,165,255,.06),transparent 55%);',
      '}',
      '.dra-root *, .dra-root *::before, .dra-root *::after{box-sizing:border-box}',
      '.dra-light{--dra-s0:#eef2f8;--dra-s1:#ffffff;--dra-s2:#f4f7fc;--dra-s3:#e9eff8;--dra-text:#17202f;--dra-dim:#5a6a83;--dra-faint:#8d9bb0;--dra-line:rgba(30,60,110,.14)}',

      /* 顶层结构 */
      '.dra-topbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}',
      '.dra-brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.06em;font-size:13px}',
      '.dra-brand-dot{width:9px;height:9px;border-radius:50%;background:var(--dra-accent);box-shadow:0 0 10px var(--dra-accent);animation:dra-pulse 2.4s ease-in-out infinite}',
      '.dra-modes{display:flex;gap:8px;flex-wrap:wrap}',
      '.dra-mode-card{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);color:var(--dra-dim);cursor:pointer;transition:all .18s ease;box-shadow:var(--dra-gloss)}',
      '.dra-mode-card:hover{border-color:var(--dra-line2);color:var(--dra-text);transform:translateY(-1px)}',
      '.dra-mode-card.active{border-color:var(--dra-accent);color:var(--dra-accent);box-shadow:0 0 0 1px rgba(46,230,255,.25),0 0 18px rgba(46,230,255,.14),var(--dra-gloss)}',
      '.dra-mode-icon{font-family:var(--dra-mono);font-size:12px}',
      '.dra-mode-txt{display:flex;flex-direction:column;line-height:1.15}',
      '.dra-mode-txt b{font-size:11.5px;font-weight:600}',
      '.dra-mode-txt span{font-size:10px;color:var(--dra-faint)}',
      '.dra-tools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dra-spacer{flex:1}',

      /* 按钮 */
      '.dra-btn{border:1px solid var(--dra-line);background:var(--dra-s2);color:var(--dra-text);border-radius:var(--dra-r-sm);padding:6px 11px;font-size:11.5px;cursor:pointer;transition:all .16s ease;font-family:inherit}',
      '.dra-btn:hover{border-color:var(--dra-line2);box-shadow:0 0 14px rgba(46,230,255,.15)}',
      '.dra-btn:active{transform:translateY(1px)}',
      '.dra-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}',
      '.dra-btn:focus-visible{outline:2px solid var(--dra-accent);outline-offset:2px}',
      '.dra-btn.primary{background:rgba(46,230,255,.14);border-color:var(--dra-accent);color:var(--dra-accent);font-weight:600}',
      '.dra-btn.primary:hover{background:rgba(46,230,255,.22);box-shadow:0 0 22px rgba(46,230,255,.3)}',
      '.dra-btn.danger{border-color:rgba(255,77,110,.5);color:var(--dra-danger)}',
      '.dra-btn.danger:hover{background:rgba(255,77,110,.12);box-shadow:0 0 16px rgba(255,77,110,.2)}',
      '.dra-btn.sm{padding:3px 8px;font-size:10.5px}',
      '.dra-check{display:flex;align-items:center;gap:6px;color:var(--dra-dim);cursor:pointer;user-select:none}',
      '.dra-check input{accent-color:var(--dra-accent)}',

      /* 横幅 */
      '.dra-banner{border:1px solid var(--dra-line);border-left:3px solid var(--dra-warn);background:rgba(255,181,71,.07);border-radius:var(--dra-r-sm);padding:8px 12px;margin-bottom:12px;line-height:1.55}',
      '.dra-banner.err{border-left-color:var(--dra-danger);background:rgba(255,77,110,.08)}',
      '.dra-banner.ok{border-left-color:var(--dra-ok);background:rgba(37,229,140,.07)}',
      '.dra-banner .dra-banner-title{font-weight:600;margin-bottom:2px}',

      /* 统计栏 */
      '.dra-statbar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}',
      '.dra-stat{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:linear-gradient(180deg,rgba(255,255,255,.025),transparent),var(--dra-s1);padding:9px 12px;box-shadow:var(--dra-gloss),var(--dra-shadow-1);transition:all .18s ease;position:relative;overflow:hidden}',
      '.dra-stat:hover{border-color:var(--dra-line2);box-shadow:var(--dra-gloss),var(--dra-shadow-2)}',
      '.dra-stat-value{font-family:var(--dra-mono);font-size:18px;font-weight:700;line-height:1.15}',
      '.dra-stat-label{font-size:10px;color:var(--dra-dim);letter-spacing:.06em;margin-top:2px}',
      '.dra-stat.ok .dra-stat-value{color:var(--dra-ok)}',
      '.dra-stat.bad .dra-stat-value{color:var(--dra-danger)}',
      '.dra-stat.acc .dra-stat-value{color:var(--dra-accent)}',
      '.dra-stat-tip{display:none;position:absolute;inset:auto 6px 6px 6px;background:var(--dra-s0);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:5px 7px;font-size:10px;color:var(--dra-dim);z-index:5}',
      '.dra-stat:hover .dra-stat-tip{display:block}',

      /* 主栅格 */
      '.dra-main-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px;align-items:start}',
      '.dra-col{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.dra-card{border:1px solid var(--dra-line);border-radius:var(--dra-r-lg);background:linear-gradient(180deg,rgba(255,255,255,.02),transparent 42%),var(--dra-s1);box-shadow:var(--dra-gloss),var(--dra-shadow-1);overflow:hidden;animation:dra-fade-in .3s ease both}',
      '.dra-card-head{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--dra-line)}',
      '.dra-card-title{font-weight:600;font-size:11.5px;letter-spacing:.05em}',
      '.dra-card-sub{color:var(--dra-dim);font-size:10.5px}',
      '.dra-card-body{padding:11px 13px}',
      '.dra-card-head .dra-tools{margin-left:auto;display:flex;gap:6px;align-items:center}',

      /* 节点卡片 */
      '.dra-node-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
      '.dra-node-card{position:relative;border:1px solid var(--dra-line);border-left:3px solid var(--dra-faint);border-radius:var(--dra-r-md);background:var(--dra-s2);padding:10px 11px;transition:all .18s ease;box-shadow:var(--dra-gloss)}',
      '.dra-node-card:hover{border-color:var(--dra-line2);box-shadow:var(--dra-shadow-2);transform:translateY(-1px)}',
      '.dra-node-card.online{border-left-color:var(--dra-accent);box-shadow:0 0 14px rgba(46,230,255,.12),var(--dra-gloss)}',
      '.dra-node-card.offline{border-left-color:var(--dra-faint);opacity:.82}',
      '.dra-node-top{display:flex;align-items:center;gap:7px;margin-bottom:7px}',
      '.dra-node-name{font-family:var(--dra-mono);font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-node-meta{color:var(--dra-dim);font-size:10px;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}',
      '.dra-node-actions{display:flex;gap:5px;margin-top:8px;opacity:0;transform:translateY(2px);transition:all .16s ease;pointer-events:none}',
      '.dra-node-card:hover .dra-node-actions{opacity:1;transform:none;pointer-events:auto}',
      '.dra-act{border:1px solid var(--dra-line);background:transparent;color:var(--dra-dim);border-radius:6px;padding:2px 7px;font-size:10px;cursor:pointer}',
      '.dra-act:hover{color:var(--dra-accent);border-color:var(--dra-line2)}',

      /* 徽章 / 圆点 */
      '.dra-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,currentColor);box-shadow:0 0 8px currentColor;flex:none}',
      '.dra-badge{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dra-line);border-radius:999px;padding:1px 7px;font-size:9.5px;color:var(--dra-dim);white-space:nowrap;line-height:1.6}',
      '.dra-badge.glow{box-shadow:0 0 8px currentColor}',
      '.dra-badge.acc{color:var(--dra-accent);border-color:rgba(46,230,255,.4)}',
      '.dra-badge.ok{color:var(--dra-ok);border-color:rgba(37,229,140,.4)}',
      '.dra-badge.bad{color:var(--dra-danger);border-color:rgba(255,77,110,.4)}',
      '.dra-badge.warn{color:var(--dra-warn);border-color:rgba(255,181,71,.4)}',
      '.dra-badge.soft{background:rgba(120,165,255,.08)}',

      /* 进度条 */
      '.dra-bars{display:grid;gap:4px;margin-top:6px}',
      '.dra-bar-row{display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--dra-dim)}',
      '.dra-bar{flex:1;height:4px;border-radius:99px;background:var(--dra-s0);overflow:hidden}',
      '.dra-bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,rgba(46,230,255,.55),var(--dra-accent));box-shadow:0 0 8px rgba(46,230,255,.5);transition:width .4s ease}',

      /* 拓扑 */
      '.dra-topo-wrap{position:relative;height:200px;border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:radial-gradient(420px 160px at 50% 0,rgba(46,230,255,.08),transparent 70%),var(--dra-s0);overflow:hidden}',
      '.dra-topo-svg{width:100%;height:100%;display:block}',
      '.dra-topo-line{stroke:rgba(120,165,255,.18);stroke-width:1;fill:none}',
      '.dra-topo-line.active{stroke:var(--dra-accent);stroke-width:1.6;stroke-dasharray:5 5;animation:dra-flow .8s linear infinite;filter:drop-shadow(0 0 4px rgba(46,230,255,.8))}',
      '.dra-topo-node{fill:var(--dra-s3);stroke:var(--dra-faint);stroke-width:1;transition:all .2s ease}',
      '.dra-topo-node.online{fill:rgba(46,230,255,.16);stroke:var(--dra-accent)}',
      '.dra-topo-node.hub{fill:rgba(46,230,255,.22);stroke:var(--dra-accent);filter:drop-shadow(0 0 8px rgba(46,230,255,.7))}',
      '.dra-topo-pulse{fill:none;stroke:var(--dra-accent);stroke-width:1;opacity:0;transform-box:fill-box;transform-origin:center;animation:dra-pulse 1.6s ease-out infinite}',
      '.dra-topo-label{fill:var(--dra-dim);font-size:8.5px;font-family:var(--dra-mono);text-anchor:middle}',
      '.dra-topo-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dra-faint);font-size:11px}',

      /* 任务列表 */
      '.dra-filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dra-chip{border:1px solid var(--dra-line);background:transparent;color:var(--dra-dim);border-radius:999px;padding:2px 9px;font-size:10px;cursor:pointer;transition:all .15s ease}',
      '.dra-chip:hover{color:var(--dra-text);border-color:var(--dra-line2)}',
      '.dra-chip.active{color:var(--dra-accent);border-color:var(--dra-accent);background:rgba(46,230,255,.08)}',
      '.dra-tasklist{display:flex;flex-direction:column;max-height:420px;overflow:auto}',
      '.dra-group-label{position:sticky;top:0;z-index:2;padding:6px 13px;background:var(--dra-s1);border-bottom:1px solid var(--dra-line);color:var(--dra-dim);font-size:10px;letter-spacing:.06em}',
      '.dra-task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 13px;border-bottom:1px solid rgba(120,165,255,.07);cursor:pointer;transition:background .15s ease}',
      '.dra-task:hover{background:rgba(46,230,255,.045)}',
      '.dra-task-main{min-width:0}',
      '.dra-task-title{display:flex;align-items:center;gap:7px;min-width:0}',
      '.dra-task-goal{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}',
      '.dra-task-sub{display:flex;gap:9px;flex-wrap:wrap;color:var(--dra-dim);font-size:10px;margin-top:3px}',
      '.dra-task-actions{display:flex;align-items:center;gap:5px;opacity:0;transition:opacity .15s ease}',
      '.dra-task:hover .dra-task-actions{opacity:1}',
      '.dra-progress{color:var(--dra-dim);font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      /* 表单 */
      '.dra-field{display:flex;flex-direction:column;gap:4px;margin-bottom:9px}',
      '.dra-label{color:var(--dra-dim);font-size:10px;letter-spacing:.04em}',
      '.dra-input,.dra-textarea,.dra-select{width:100%;background:var(--dra-s0);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);color:var(--dra-text);padding:6px 8px;font-size:11.5px;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease}',
      '.dra-textarea{min-height:62px;resize:vertical;line-height:1.5}',
      '.dra-input:focus,.dra-textarea:focus,.dra-select:focus{outline:none;border-color:var(--dra-accent);box-shadow:0 0 0 2px rgba(46,230,255,.14)}',
      '.dra-input::placeholder,.dra-textarea::placeholder{color:var(--dra-faint)}',
      '.dra-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dra-hint{color:var(--dra-faint);font-size:10px;line-height:1.5}',
      '.dra-mono{font-family:var(--dra-mono);font-size:11px}',
      '.dra-copy{border:1px dashed rgba(46,230,255,.4);background:transparent;color:var(--dra-accent);border-radius:6px;padding:2px 7px;font-size:10px;cursor:pointer}',
      '.dra-copy:hover{background:rgba(46,230,255,.08)}',
      '.dra-dim{color:var(--dra-dim)}',
      '.dra-ok{color:var(--dra-ok)}',
      '.dra-danger{color:var(--dra-danger)}',
      '.dra-warn{color:var(--dra-warn)}',
      '.dra-acc{color:var(--dra-accent)}',
      '.dra-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-wrap{word-break:break-all}',

      /* 折叠 */
      '.dra-fold{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);margin-top:10px;overflow:hidden}',
      '.dra-fold>summary{list-style:none;cursor:pointer;padding:8px 13px;color:var(--dra-dim);font-size:11px;display:flex;align-items:center;gap:8px;user-select:none}',
      '.dra-fold>summary::-webkit-details-marker{display:none}',
      '.dra-fold>summary:hover{color:var(--dra-text)}',
      '.dra-fold>summary::before{content:"▸";color:var(--dra-accent);transition:transform .15s ease}',
      '.dra-fold[open]>summary::before{transform:rotate(90deg)}',
      '.dra-fold-body{padding:0 13px 12px}',

      /* 体检 / 工具 / 共享 */
      '.dra-env-item{display:flex;gap:8px;padding:6px 0;border-bottom:1px dashed rgba(120,165,255,.1);align-items:flex-start}',
      '.dra-env-item:last-child{border-bottom:none}',
      '.dra-env-mark{flex:none;width:14px;text-align:center;font-family:var(--dra-mono)}',
      '.dra-tools-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}',
      '.dra-tool{border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:7px 9px;background:var(--dra-s2)}',
      '.dra-tool-name{display:flex;align-items:center;gap:6px;font-weight:600}',
      '.dra-tool-meta{color:var(--dra-dim);font-size:10px;margin-top:3px;line-height:1.5}',
      '.dra-steps{display:grid;gap:5px;margin-top:6px}',
      '.dra-step{display:flex;gap:7px;align-items:baseline;color:var(--dra-dim);font-size:10.5px}',
      '.dra-step b{font-family:var(--dra-mono);color:var(--dra-accent);font-weight:600}',

      /* 详情抽屉 */
      '.dra-detail{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);padding:10px 12px;margin-top:10px}',
      '.dra-kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:3px 8px;font-size:10.5px;line-height:1.6}',
      '.dra-kv dt{color:var(--dra-faint)}',
      '.dra-kv dd{margin:0;word-break:break-all}',
      '.dra-pre{margin:5px 0 0;padding:7px 9px;background:var(--dra-s0);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);font-family:var(--dra-mono);font-size:10px;line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:190px;overflow:auto;color:var(--dra-dim)}',

      /* 添加副机 */
      '.dra-enroll-btn{width:100%;border:1px dashed rgba(46,230,255,.55);background:rgba(46,230,255,.04);color:var(--dra-accent)}',
      '.dra-enroll-card{border:1px solid var(--dra-line2);border-radius:var(--dra-r-md);background:rgba(46,230,255,.05);padding:10px 11px;margin-top:9px}',
      '.dra-token{font-family:var(--dra-mono);font-size:13px;color:var(--dra-accent);word-break:break-all;margin:4px 0}',

      /* 派发模板行 */
      '.dra-tplrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px}',
      '.dra-tplrow .dra-select{flex:1 1 160px;min-width:140px}',
      '.dra-tplrow .dra-btn{flex:0 0 auto;white-space:nowrap}',

      /* 空态 */
      '.dra-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 12px;color:var(--dra-faint);text-align:center;line-height:1.6}',

      /* 动画 */
      '@keyframes dra-fade-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '@keyframes dra-pulse{0%{opacity:.85;transform:scale(1)}70%{opacity:0;transform:scale(1.9)}100%{opacity:0;transform:scale(1.9)}}',
      '@keyframes dra-flow{to{stroke-dashoffset:-20}}',
      '@keyframes dra-glow{0%,100%{box-shadow:0 0 12px rgba(46,230,255,.18)}50%{box-shadow:0 0 24px rgba(46,230,255,.4)}}',

      /* 响应式 */
      '@media (max-width:720px){.dra-main-grid{grid-template-columns:1fr}.dra-statbar{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (prefers-reduced-motion:reduce){.dra-root *{animation:none !important;transition:none !important}}',
    ]

    function StyleTag() { return null }

    /* ───────────────────────────── 请求与工具 ───────────────────────────── */
    function readJson(r) {
      return r.json().catch(function () { return {} }).then(function (b) {
        if (r.ok) return b
        const e = new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
        e.status = r.status
        e.body = b
        throw e
      })
    }

    function apiGet(p) {
      return fetch(API + p, { cache: 'no-store' }).then(readJson)
    }

    /* 拉**传入的完整路径**（副机状态 / 引导端点不在 UI 前缀下）。 */
    function apiGetPath(fullPath) {
      return fetch(fullPath, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(p, body) {
      return fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function apiPostPath(fullPath, body) {
      return fetch(fullPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function copyText(text) {
      const s = String(text == null ? '' : text)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(function () { return true }, function () { return false })
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = s
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return Promise.resolve(ok)
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    function fmtTime(ms) {
      if (!ms || typeof ms !== 'number') return '—'
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function fmtDur(ms) {
      if (!ms || typeof ms !== 'number' || ms < 0) return '—'
      const s = Math.floor(ms / 1000)
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + (s % 60) + 's'
      const hh = Math.floor(m / 60)
      return hh + 'h' + (m % 60) + 'm'
    }

    function pct(n) {
      const v = Number(n)
      if (!isFinite(v)) return 0
      return Math.max(0, Math.min(100, Math.round(v)))
    }

    function shortId(id) {
      const s = String(id || '')
      return s.length > 10 ? s.slice(0, 10) : s
    }

    /* 任务的一行进度摘要：优先 progressTail 最后一条，其次 summaryText。 */
    function progressLine(t) {
      if (!t || typeof t !== 'object') return ''
      const tail = Array.isArray(t.progressTail) ? t.progressTail : []
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const p = tail[i]
        if (p && typeof p.detail === 'string' && p.detail.trim() !== '') return p.detail.trim()
      }
      if (typeof t.summaryText === 'string' && t.summaryText.trim() !== '') return t.summaryText.trim().split('\n')[0]
      return ''
    }

    /* ───────────────────────────── 基础组件 ───────────────────────────── */
    function Dot(props) {
      return h('span', {
        className: 'dra-dot',
        style: { color: props.color || 'var(--dra-accent)' },
        title: props.title || '',
      })
    }

    function Badge(props) {
      const cls = 'dra-badge' + (props.tone ? ' ' + props.tone : '') + (props.glow ? ' glow' : '')
      return h('span', { className: cls, title: props.title || '' }, props.children)
    }

    function Card(props) {
      const head = props.title ? h('div', { className: 'dra-card-head' },
        h('span', { className: 'dra-card-title' }, props.title),
        props.sub ? h('span', { className: 'dra-card-sub' }, props.sub) : null,
        props.actions ? h('div', { className: 'dra-tools' }, props.actions) : null,
      ) : null
      return h('section', { className: 'dra-card' + (props.className ? ' ' + props.className : '') },
        head,
        h('div', { className: 'dra-card-body' }, props.children),
      )
    }

    function Fold(props) {
      return h('details', {
        className: 'dra-fold',
        open: props.open === true,
      },
        h('summary', null,
          h('span', null, props.title),
          props.badge ? h('span', { className: 'dra-badge soft' }, props.badge) : null,
        ),
        h('div', { className: 'dra-fold-body' }, props.children),
      )
    }

    function CopyBtn(props) {
      return h('button', {
        className: 'dra-copy',
        title: props.title || '复制',
        onClick: function (e) {
          e.stopPropagation()
          copyText(props.text).then(function (ok) {
            if (props.onDone) props.onDone(ok)
          })
        },
      }, props.label || '复制')
    }

    /* ───────────────────────────── 工具栏 ───────────────────────────── */
    function Toolbar(props) {
      const modeCard = function (key, icon, name, desc) {
        return h('button', {
          className: 'dra-mode-card' + (props.mode === key ? ' active' : ''),
          onClick: function () { if (props.onSwitchMode) props.onSwitchMode(key) },
          title: desc,
        },
          h('span', { className: 'dra-mode-icon' }, icon),
          h('span', { className: 'dra-mode-txt' },
            h('b', null, name),
            h('span', null, desc),
          ),
        )
      }
      return h('div', { className: 'dra-topbar' },
        h('div', { className: 'dra-brand' },
          h('span', { className: 'dra-brand-dot' }),
          h('span', null, '远程同事'),
        ),
        h('div', { className: 'dra-modes' },
          modeCard('hub', '◉', 'Hub 中控', '管副机 · 派任务'),
          modeCard('worker', '◌', 'Worker 副机', '本机状态 · 等任务'),
        ),
        h('div', { className: 'dra-tools' },
          h('label', { className: 'dra-check', title: '每 4 秒自动刷新' },
            h('input', {
              type: 'checkbox',
              checked: props.autoRefresh === true,
              onChange: function (e) { props.onToggleAuto(e.target.checked) },
            }),
            h('span', null, '自动'),
          ),
          h('button', {
            className: 'dra-btn',
            title: props.theme === 'dark' ? '切换到浅色' : '切换到深色',
            onClick: props.onToggleTheme,
          }, props.theme === 'dark' ? '☀' : '☾'),
          h('button', {
            className: 'dra-btn primary',
            onClick: props.onRefresh,
            disabled: props.loading === true,
          }, props.loading ? '刷新中…' : '刷新'),
        ),
      )
    }

    /* ───────────────────────────── 统计栏 ───────────────────────────── */
    function StatBar(props) {
      const c = props.counts || {}
      const cell = function (label, value, tone, tip) {
        return h('div', { className: 'dra-stat' + (tone ? ' ' + tone : '') },
          h('div', { className: 'dra-stat-value' }, String(value == null ? 0 : value)),
          h('div', { className: 'dra-stat-label' }, label),
          tip ? h('div', { className: 'dra-stat-tip' }, tip) : null,
        )
      }
      return h('div', { className: 'dra-statbar' },
        cell('节点总数', c.nodes, '', '注册到本 hub 的副机数量'),
        cell('在线', c.online, 'ok', '当前握手在线的副机'),
        cell('任务中', c.active != null ? c.active : c.running, 'acc', '运行中 + 排队 + 待批准'),
        cell('已完成', c.done, 'ok', '历史任务中 status=done 的数量'),
        cell('失败', c.failed, 'bad', 'failed / aborted / rejected 的数量'),
      )
    }

    /* ───────────────────────────── 节点卡片 ───────────────────────────── */
    function NodeCard(props) {
      const n = props.node || {}
      const res = n.resource || null
      const memPct = res && res.memTotalMb > 0 ? pct((res.memUsedMb / res.memTotalMb) * 100) : 0
      const cpu = res ? pct(res.cpuPct) : 0
      return h('div', { className: 'dra-node-card ' + (n.online ? 'online' : 'offline') },
        h('div', { className: 'dra-node-top' },
          h(Dot, { color: n.online ? 'var(--dra-accent)' : 'var(--dra-faint)' }),
          h('span', { className: 'dra-node-name', title: n.nodeId }, shortId(n.nodeId)),
          h('span', { style: { marginLeft: 'auto' } },
            h(Badge, { tone: n.online ? 'ok' : '', glow: n.online }, n.online ? '在线' : '离线'),
          ),
        ),
        h('div', { className: 'dra-node-meta' },
          h('span', null, (n.os || '?') + '/' + (n.arch || '?')),
          h('span', null, '任务 ' + (n.taskCount || 0)),
          n.agentMode ? h('span', { className: 'dra-acc' }, 'agent') : null,
          n.runnerKind ? h('span', null, n.runnerKind) : null,
        ),
        res ? h('div', { className: 'dra-bars' },
          h('div', { className: 'dra-bar-row' },
            h('span', { style: { width: 24 } }, 'CPU'),
            h('div', { className: 'dra-bar' }, h('div', { className: 'dra-bar-fill', style: { width: cpu + '%' } })),
            h('span', { className: 'dra-mono' }, cpu + '%'),
          ),
          h('div', { className: 'dra-bar-row' },
            h('span', { style: { width: 24 } }, 'MEM'),
            h('div', { className: 'dra-bar' }, h('div', { className: 'dra-bar-fill', style: { width: memPct + '%' } })),
            h('span', { className: 'dra-mono' }, (res.memUsedMb || 0) + '/' + (res.memTotalMb || 0)),
          ),
        ) : h('div', { className: 'dra-hint', style: { marginTop: 4 } }, '资源未上报'),
        (n.roots && n.roots.length) ? h('div', {
          className: 'dra-hint dra-ell',
          title: n.roots.join('\n'),
          style: { marginTop: 5 },
        }, '工作区 ' + n.roots.length + ' 个：' + n.roots[0]) : null,
        h('div', { className: 'dra-node-actions' },
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'detail') } }, '详情'),
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'copy') } }, '复制 ID'),
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'purge') } }, '清理'),
        ),
      )
    }

    function NodeCardGrid(props) {
      const nodes = props.nodes || []
      return h(Card, {
        title: '副机节点',
        sub: (props.onlineCount || 0) + '/' + nodes.length + ' 在线',
        actions: props.actions || null,
      },
        nodes.length === 0
          ? h('div', { className: 'dra-empty' }, '暂无副机节点，先在右侧「副机接入」把另一台电脑接进来')
          : h('div', { className: 'dra-node-grid' },
            nodes.map(function (n) {
              return h(NodeCard, { key: n.nodeId, node: n, onAction: props.onAction })
            }),
          ),
      )
    }

    /* ───────────────────────────── 拓扑动画 ───────────────────────────── */
    function TopologyMap(props) {
      const nodes = props.nodes || []
      const tasks = props.tasks || []
      const activeIds = {}
      tasks.forEach(function (t) {
        if (t && t.status === 'running' && t.nodeId) activeIds[t.nodeId] = true
      })
      if (nodes.length === 0) {
        return h(Card, { title: '拓扑连接', sub: 'Hub → Worker' },
          h('div', { className: 'dra-topo-wrap' },
            h('div', { className: 'dra-topo-empty' }, '暂无副机连接'),
          ),
        )
      }
      const W = 640
      const H = 200
      const hubX = W / 2
      const hubY = 34
      const maxPerRow = 6
      const rows = Math.ceil(nodes.length / maxPerRow)
      const positions = nodes.map(function (n, i) {
        const row = Math.floor(i / maxPerRow)
        const inRow = Math.min(maxPerRow, nodes.length - row * maxPerRow)
        const idx = i - row * maxPerRow
        const step = W / (inRow + 1)
        return { n: n, x: step * (idx + 1), y: 118 + row * 34 }
      })
      const runningCount = Object.keys(activeIds).length
      return h(Card, {
        title: '拓扑连接',
        sub: runningCount > 0 ? runningCount + ' 条链路传输中' : 'Hub → Worker',
      },
        h('div', { className: 'dra-topo-wrap' },
          h('svg', { className: 'dra-topo-svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet' },
            h('defs', null,
              h('filter', { id: 'dra-topo-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' },
                h('feGaussianBlur', { stdDeviation: '3', result: 'b' }),
                h('feMerge', null,
                  h('feMergeNode', { in: 'b' }),
                  h('feMergeNode', { in: 'SourceGraphic' }),
                ),
              ),
            ),
            positions.map(function (p) {
              const active = activeIds[p.n.nodeId] === true
              return h('line', {
                key: 'l-' + p.n.nodeId,
                x1: hubX, y1: hubY + 14, x2: p.x, y2: p.y - 10,
                className: 'dra-topo-line' + (active ? ' active' : ''),
              })
            }),
            h('circle', { cx: hubX, cy: hubY, r: 20, className: 'dra-topo-node hub', filter: 'url(#dra-topo-glow)' }),
            h('text', { x: hubX, y: hubY + 4, className: 'dra-topo-label', style: { fill: 'var(--dra-accent)', fontSize: '9px' } }, '中控'),
            positions.map(function (p) {
              const active = activeIds[p.n.nodeId] === true
              const online = p.n.online === true
              return h('g', { key: 'n-' + p.n.nodeId },
                active ? h('circle', { cx: p.x, cy: p.y, r: 10, className: 'dra-topo-pulse' }) : null,
                h('circle', {
                  cx: p.x, cy: p.y, r: 8,
                  className: 'dra-topo-node' + (online ? ' online' : ''),
                }),
                h('text', { x: p.x, y: p.y + 24, className: 'dra-topo-label' }, shortId(p.n.nodeId).slice(0, 8)),
              )
            }),
          ),
        ),
      )
    }

    /* ───────────────────────────── 任务列表 ───────────────────────────── */
    function TaskRow(props) {
      const t = props.task || {}
      const active = ACTIVE_STATUSES.indexOf(t.status) >= 0
      const tone = t.status === 'done' ? 'ok' : (t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected') ? 'bad' : (t.status === 'pending' ? 'warn' : 'acc')
      const dur = active
        ? (t.startedAt ? Date.now() - t.startedAt : 0)
        : (t.durationMs || (t.startedAt && t.endedAt ? t.endedAt - t.startedAt : 0))
      const line = progressLine(t)
      return h('div', {
        className: 'dra-task',
        onClick: function () { props.onAction(t.taskId, 'detail') },
      },
        h('div', { className: 'dra-task-main' },
          h('div', { className: 'dra-task-title' },
            h('span', { className: 'dra-task-goal', title: t.goal }, t.goal || '(无目标)'),
            h(Badge, { tone: tone, glow: active }, STATUS_LABEL[t.status] || t.status),
            t.mode ? h(Badge, { tone: 'soft' }, t.mode) : null,
            t.approval === 'manual' && t.status === 'pending' ? h(Badge, { tone: 'warn' }, '需批准') : null,
          ),
          h('div', { className: 'dra-task-sub' },
            h('span', { className: 'dra-mono' }, shortId(t.taskId)),
            h('span', null, shortId(t.nodeId)),
            active ? h('span', { className: 'dra-acc' }, '已跑 ' + fmtDur(dur)) : h('span', null, '耗时 ' + fmtDur(dur)),
            h('span', null, fmtTime(t.updatedAt || t.createdAt)),
            t.changedCount ? h('span', null, '改动 ' + t.changedCount) : null,
          ),
          line ? h('div', { className: 'dra-progress', title: line }, '最近：' + line) : null,
        ),
        h('div', { className: 'dra-task-actions' },
          h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'detail') } }, '详情'),
          active ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'cancel') } }, '取消') : null,
          t.status === 'pending' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'approve') } }, '批准') : null,
          t.status === 'pending' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'reject') } }, '拒绝') : null,
          t.status === 'done' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'pull') } }, '拉取') : null,
        ),
      )
    }

    function TaskList(props) {
      const all = props.tasks || []
      const filter = props.filter || 'all'
      const active = all.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 })
      const history = all.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) < 0 })
      const chips = [
        ['all', '全部'], ['running', '运行中'], ['done', '已完成'], ['failed', '失败'],
      ]
      const head = h('div', { className: 'dra-filterbar' },
        chips.map(function (c) {
          return h('button', {
            key: c[0],
            className: 'dra-chip' + (filter === c[0] ? ' active' : ''),
            onClick: function () { props.onFilter(c[0]) },
          }, c[1] + (c[0] === 'all' ? ' ' + all.length : ''))
        }),
      )
      const body = []
      if (filter === 'all' || filter === 'running') {
        if (active.length) {
          body.push(h('div', { key: 'g-active', className: 'dra-group-label' }, '运行中（' + active.length + '）'))
          active.forEach(function (t) { body.push(h(TaskRow, { key: t.taskId, task: t, onAction: props.onAction })) })
        } else if (filter === 'running') {
          body.push(h('div', { key: 'e-active', className: 'dra-empty' }, '当前没有运行中的任务'))
        }
      }
      const shown = filter === 'done'
        ? history.filter(function (t) { return t.status === 'done' })
        : filter === 'failed'
          ? history.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' })
          : history
      if (shown.length) {
        if (filter === 'all') body.push(h('div', { key: 'g-hist', className: 'dra-group-label' }, '历史（' + shown.length + '）'))
        shown.forEach(function (t) { body.push(h(TaskRow, { key: t.taskId, task: t, onAction: props.onAction })) })
      } else if (filter !== 'running') {
        body.push(h('div', { key: 'e-hist', className: 'dra-empty' }, '没有匹配的任务'))
      }
      return h(Card, {
        title: '任务',
        sub: all.length + ' 条（保留历史）',
        actions: head,
      },
        h('div', null,
          h('div', { className: 'dra-row', style: { justifyContent: 'space-between', paddingBottom: 4 } },
            h('span', { className: 'dra-hint' }, '点击任务行看详情；hover 显示操作'),
            h('button', {
              className: 'dra-btn sm danger',
              disabled: props.purgeBusy === true,
              onClick: props.onClear,
            }, props.purgeBusy ? '清理中…' : '清理'),
          ),
          h('div', { className: 'dra-tasklist' }, body),
        ),
      )
    }

    /* ───────────────────────────── 接入配置 ───────────────────────────── */
    function ConfigPanel(props) {
      const cfg = props.cfg || {}
      const edit = props.edit || {}
      const isWorker = props.mode === 'worker'
      const val = function (k) {
        return edit[k] != null ? edit[k] : (cfg[k] || '')
      }
      const template = function () {
        const lines = [
          '- id: remote-agent',
          '  name: dsh-remote-agent',
          '  config:',
          '    role: ' + (isWorker ? 'worker' : 'hub'),
          '    relayUrl: ' + (val('relayUrl') || '<中继地址>'),
        ]
        if (isWorker) {
          lines.push('    enrollToken: ' + (val('enrollToken') || '<enrollToken>'))
        } else {
          lines.push('    nodeToken: ' + (val('hubToken') || '<hubToken>'))
        }
        return lines.join('\n')
      }
      const field = function (key, label, placeholder, type) {
        return h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, label),
          h('input', {
            className: 'dra-input dra-mono',
            type: type || 'text',
            value: val(key),
            placeholder: placeholder,
            onChange: function (e) { props.onEdit(key, e.target.value) },
          }),
        )
      }
      return h(Card, {
        title: '接入与配置',
        sub: isWorker ? 'Worker 模式' : 'Hub 模式',
        actions: h(Badge, { tone: 'soft' }, 'role: ' + (cfg.role || '—')),
      },
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '中继地址（relayUrl）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: val('relayUrl'),
            placeholder: 'ws://<主机地址>:8890/relay',
            onChange: function (e) { props.onEdit('relayUrl', e.target.value) },
          }),
        ),
        isWorker
          ? field('enrollToken', '接入口令（enrollToken）', 'enr_…')
          : field('hubToken', '主机口令（hubToken）', '留空表示沿用当前口令', 'password'),
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginTop: 2 } },
          h('span', { className: 'dra-hint' },
            isWorker
              ? (cfg.relayTokenSet ? '口令已设置' : '口令未设置')
              : (cfg.nodeTokenSet ? '主机口令已设置' : '主机口令未设置（独立监听只能绑回环，副机连不上）'),
          ),
          h(CopyBtn, { label: '复制配置模板', text: template() }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } },
          '以上地址写回 profile 的 cordis.patch.yml 后重启 DSH 生效；面板只做本地编辑与复制。',
        ),
        h('div', { className: 'dra-hint dra-warn', style: { marginTop: 3 } },
          '中继地址请填具体的局域网 / Tailscale IP，不能用 0.0.0.0 或 localhost。',
        ),
      )
    }

    /* ───────────────────────────── 快速派发 ───────────────────────────── */
    function DispatchForm(props) {
      const f = props.form || {}
      const modelCustom = props.modelCustom === true
      const setModelCustom = function (v) { if (typeof props.setModelCustom === 'function') props.setModelCustom(v) }
      const nodes = props.nodes || []
      const onlineNodes = nodes.filter(function (n) { return n.online === true })
      const selNode = nodes.filter(function (n) { return n.nodeId === f.node })[0] || null
      /* 提案 #27：副机上报的模型清单 → 节点视图 → 这里渲染成下拉。
       * 有清单用 select；没清单（旧副机 / 探测失败）退回自由文本。 */
      const modelOptions = []
      const seenModel = {}
      nodes.forEach(function (o) {
        ;(o.models || []).forEach(function (m) {
          const key = (m.provider || '') + '/' + (m.id || '')
          if (seenModel[key]) return
          seenModel[key] = true
          modelOptions.push({ key: key, label: m.name || m.id, nodeId: o.nodeId })
        })
      })
      const hasList = modelOptions.length > 0
      const isCustom = modelCustom || (!!f.model && hasList && !modelOptions.some(function (o) { return o.key === f.model }))
      const set = function (k, v) {
        const patch = {}
        patch[k] = v
        props.onFormChange(patch)
      }
      return h(Card, { title: '快速派发', sub: 'Hub → 选中的副机' },
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '目标节点'),
          h('select', {
            className: 'dra-select',
            value: f.node || '',
            onChange: function (e) { set('node', e.target.value) },
          },
            h('option', { value: '' }, '自动选择（按负载路由）'),
            onlineNodes.map(function (n) {
              return h('option', { key: n.nodeId, value: n.nodeId }, shortId(n.nodeId) + (n.os ? ' · ' + n.os : ''))
            }),
          ),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '任务目标'),
          h('textarea', {
            className: 'dra-textarea',
            value: f.goal || '',
            placeholder: '例如：运行测试并修复失败的用例；或执行 npm run build 并汇报结果',
            onChange: function (e) { set('goal', e.target.value) },
          }),
        ),
        h('div', { className: 'dra-row' },
          h('div', { className: 'dra-field', style: { flex: '1 1 120px' } },
            h('label', { className: 'dra-label' }, '执行模式'),
            h('select', {
              className: 'dra-select',
              value: f.mode || 'agent',
              onChange: function (e) { set('mode', e.target.value) },
            },
              h('option', { value: 'agent' }, 'agent · 新开独立会话'),
              h('option', { value: 'exec' }, 'exec · 直接执行命令'),
            ),
          ),
        ),
        h('details', { className: 'dra-fold' },
          h('summary', null, '高级选项'),
          h('div', { className: 'dra-fold-body' },
            h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, '工作区（副机 roots 内）'),
              h('input', {
                className: 'dra-input dra-mono',
                value: f.workspace || '',
                placeholder: selNode && selNode.roots && selNode.roots[0] ? selNode.roots[0] : '留空 = 副机默认工作区',
                list: 'dra-ws-list',
                onChange: function (e) { set('workspace', e.target.value) },
              }),
              h('datalist', { id: 'dra-ws-list' },
                !selNode ? null : (selNode.roots || []).map(function (r) {
                  return h('option', { key: r, value: r })
                }),
              ),
            ),
            h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, '模型'),
              hasList ? h('select', {
                className: 'dra-select',
                value: isCustom ? '__custom__' : (f.model || ''),
                onChange: function (e) {
                  const v = e.target.value
                  if (v === '__custom__') { setModelCustom(true); set('model', ''); return }
                  setModelCustom(false)
                  set('model', v)
                },
              },
                h('option', { value: '' }, '跟随副机默认'),
                modelOptions.map(function (o) {
                  return h('option', { key: o.key, value: o.key }, o.label + ' · ' + o.nodeId)
                }),
                h('option', { value: '__custom__' }, '自定义模型…'),
              ) : h('input', {
                className: 'dra-input dra-mono',
                value: f.model || '',
                placeholder: '没有清单，手动填 provider/model',
                onChange: function (e) { setModelCustom(true); set('model', e.target.value) },
              }),
              isCustom ? h('input', {
                className: 'dra-input dra-mono',
                style: { marginTop: 4 },
                value: f.model || '',
                placeholder: 'provider/model 或 model',
                onChange: function (e) { set('model', e.target.value) },
              }) : null,
            ),
            h('div', { className: 'dra-row' },
              h('div', { className: 'dra-field', style: { flex: '1 1 130px' } },
                h('label', { className: 'dra-label' }, '产出 glob（逗号分隔）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: f.outputs || '',
                  placeholder: 'dist/**, *.md',
                  onChange: function (e) { set('outputs', e.target.value) },
                }),
              ),
              h('div', { className: 'dra-field', style: { flex: '0 0 100px' } },
                h('label', { className: 'dra-label' }, '超时（ms）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: f.timeoutMs || '',
                  placeholder: '600000',
                  onChange: function (e) { set('timeoutMs', e.target.value) },
                }),
              ),
            ),
            h('label', { className: 'dra-check' },
              h('input', {
                type: 'checkbox',
                checked: f.needApproval === true,
                onChange: function (e) { set('needApproval', e.target.checked) },
              }),
              h('span', null, '需要先审批再派给副机'),
            ),
          ),
        ),
        h('button', {
          className: 'dra-btn primary',
          style: { width: '100%', marginTop: 8, padding: '8px 12px' },
          disabled: props.busy === true,
          onClick: props.onSubmit,
        }, props.busy ? '派发中…' : '派发任务'),
        h('div', { className: 'dra-hint', style: { marginTop: 5 } },
          'agent = 在副机新开独立会话；exec = 直接执行命令。两条路径都由副机本地执行。',
        ),
      )
    }

    /* ───────────────────────────── 副机接入 ───────────────────────────── */
    function StepGuide() {
      const steps = ['重启 DSH', '生成配对码', '在副机上粘贴', '等它连上']
      return h('div', null,
        h('div', { className: 'dra-hint' }, '首次接入按这四步走，不需要手写 YAML：'),
        h('div', { className: 'dra-steps' },
          steps.map(function (s, i) {
            return h('div', { key: s, className: 'dra-step' },
              h('b', null, String(i + 1)),
              h('span', null, s),
            )
          }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 5 } },
          '你现在用的这台是主机；副机装好 dsh-remote-agent 后把配对码贴进它的配置即可。',
        ),
      )
    }

    function PairPanel(props) {
      const pair = props.pair || null
      const codes = (pair && Array.isArray(pair.codes)) ? pair.codes : []
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'dra-hint' }, pair && pair.listener ? ('监听 ' + (pair.listener.host || '') + ':' + (pair.listener.port || '')) : '尚未读到监听状态'),
          h('button', { className: 'dra-btn sm', onClick: props.onLoadPair }, '刷新配对码'),
        ),
        props.pairNote ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 4 } }, props.pairNote) : null,
        codes.length === 0
          ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '还没有可用配对码。先确认独立监听已启动（端口默认 19387），再点「刷新配对码」。')
          : codes.map(function (c) {
            const line = 'pair: ' + (c.pairCode || '')
            return h('div', { key: c.address || c.name, className: 'dra-field', style: { marginTop: 7 } },
              h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
                h('span', { className: 'dra-label' }, (c.name || 'address') + (c.private ? ' · 内网' : '') + (c.usable ? '' : ' · 不可用')),
                h(CopyBtn, { label: '复制 pair 配置行', text: line }),
              ),
              h('div', { className: 'dra-mono dra-wrap', style: { color: 'var(--dra-accent)' } }, line),
              c.hubUrl ? h('div', { className: 'dra-hint dra-wrap' }, c.hubUrl) : null,
            )
          }),
      )
    }

    function EnrollPanel(props) {
      const e = props.enroll || {}
      return h('div', null,
        h('button', {
          className: 'dra-btn dra-enroll-btn',
          disabled: e.loading === true,
          onClick: props.onEnroll,
        }, e.loading ? '铸造中…' : '+ 添加副机（生成一次性接入口令）'),
        e.error ? h('div', { className: 'dra-hint dra-danger', style: { marginTop: 5 } }, e.error) : null,
        e.data ? h('div', { className: 'dra-enroll-card' },
          h('div', { className: 'dra-label' }, '中继地址'),
          h('div', { className: 'dra-token' }, e.data.relayUrl || '—'),
          h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
            h('span', { className: 'dra-label' }, '一次性 enrollToken'),
            h(CopyBtn, { label: '复制口令', text: e.data.enrollToken || '' }),
          ),
          h('div', { className: 'dra-token' }, e.data.enrollToken || '—'),
          h('div', { className: 'dra-hint' },
            '15 分钟内有效（约 ' + Math.round((e.data.expiresInMs || 0) / 60000) + ' 分钟）。在副机的 DSH remote-agent 面板选中继模式，填入上面两项即可接入。',
          ),
        ) : null,
      )
    }

    /* ───────────────────────────── 体检 ───────────────────────────── */
    function EnvPanel(props) {
      const ec = props.envCheck || null
      const items = ec && Array.isArray(ec.items) ? ec.items : []
      const plan = props.fixPlan || null
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { className: 'dra-hint' },
            ec ? (ec.failed > 0 ? ec.failed + ' 项需要处理' : '全部通过') : '尚未体检',
          ),
          h('div', { className: 'dra-row' },
            h('button', { className: 'dra-btn sm primary', disabled: props.envBusy === true, onClick: props.onRun },
              props.envBusy ? '体检中…' : '体检'),
            h('button', { className: 'dra-btn sm', disabled: props.fixBusy === true, onClick: props.onPreviewFix }, '一键修复预览'),
            plan ? h('button', { className: 'dra-btn sm danger', disabled: props.fixBusy === true, onClick: props.onApplyFix }, '应用修复') : null,
          ),
        ),
        items.length === 0 ? h('div', { className: 'dra-hint' }, '点「体检」检查可达性 / inject / roots / role。') : null,
        items.map(function (it, i) {
          return h('div', { key: it.id || i, className: 'dra-env-item' },
            h('span', { className: 'dra-env-mark ' + (it.ok ? 'dra-ok' : 'dra-danger') }, it.ok ? '✓' : '✗'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
                h('span', null, it.label || it.id),
                it.autoFix ? h(Badge, { tone: 'warn' }, '可自动修复') : null,
              ),
              it.ok ? null : h('div', { className: 'dra-hint dra-wrap' }, it.detail || ''),
              it.ok ? null : h('div', { className: 'dra-row', style: { marginTop: 3, gap: 6 } },
                h('span', { className: 'dra-hint dra-wrap', style: { flex: 1 } }, it.fix || ''),
                h('button', {
                  className: 'dra-copy',
                  title: '复制这条修法',
                  onClick: function () { copyText(it.fix) },
                }, '复制修法'),
              ),
            ),
          )
        }),
        plan ? h('div', { className: 'dra-pre' }, typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2)) : null,
        props.fixMsg ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, props.fixMsg) : null,
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '一键修复只改托管块并备份，写后校验；不会改动其它插件配置。'),
      )
    }

    /* ───────────────────────────── 外部工具 ───────────────────────────── */
    function ToolPanel(props) {
      const d = props.tools || null
      const tools = d && Array.isArray(d.tools) ? d.tools : []
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { className: 'dra-hint' }, d ? (d.platform || '') + ' · 缺 ' + ((d.missing || []).length) + ' 项' : '尚未检测'),
          h('button', { className: 'dra-btn sm', disabled: props.busy === true, onClick: props.onRefresh },
            props.busy ? '检测中…' : '检测工具'),
        ),
        tools.length === 0 ? h('div', { className: 'dra-hint' }, '点「检测工具」探测 git / node / rg 等外部工具。') : null,
        h('div', { className: 'dra-tools-grid' },
          tools.map(function (t) {
            return h('div', { key: t.id, className: 'dra-tool' },
              h('div', { className: 'dra-tool-name' },
                h('span', null, t.name || t.id),
                h(Badge, { tone: t.installed ? 'ok' : (t.required ? 'bad' : 'warn') }, t.installed ? (t.version || '已装') : (t.required ? '必需缺失' : '未装')),
              ),
              h('div', { className: 'dra-tool-meta' }, t.why || ''),
              t.installed ? null : h('div', { className: 'dra-tool-meta' },
                h('div', { className: 'dra-mono dra-wrap' }, t.install || ''),
                h('div', { className: 'dra-row', style: { marginTop: 3 } },
                  t.install ? h(CopyBtn, { label: '复制命令', text: t.install }) : null,
                  t.url ? h('a', { className: 'dra-hint', href: t.url, target: '_blank', rel: 'noreferrer' }, '官方链接') : null,
                ),
              ),
            )
          }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '只检测并给出安装命令，不会代你下载或执行安装。'),
      )
    }

    /* ───────────────────────────── 工作区共享（SMB）────────────────────────────── */
    function SharePanel(props) {
      const nodes = (props.nodes || []).filter(function (n) { return n.online === true })
      const nodeS = React.useState(nodes.length > 0 ? nodes[0].nodeId : '')
      const nodeId = nodeS[0]
      const setNodeId = nodeS[1]
      function rootsOf(id) {
        const n = nodes.filter(function (x) { return x.nodeId === id })[0]
        const rs = n && Array.isArray(n.roots) ? n.roots.filter(function (r) { return typeof r === 'string' && r !== '' }) : []
        return rs
      }
      const nodeRoots = rootsOf(nodeId)
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

      function doPlan() {
        if (!nodeId) { setNote('先选一台在线副机'); return }
        if (!ack) { setNote('请先勾选已知情'); return }
        // dir 必填：副机按设计拒绝空目录，空值不拦只会让用户点了才失败。
        if (shareDir.trim() === '') { setNote('先选择或填写共享目录'); return }
        setBusy(true)
        setPlan(null)
        apiPost('/share', {
          action: 'plan',
          node: nodeId,
          dir: shareDir,
          access: access,
          confirm: 'yes',
        })
          .then(function (r) { setPlan(r || null); setNote('') })
          .catch(function (e) { setNote('生成失败：' + ((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      return h('div', null,
        h('div', { className: 'dra-hint' },
          '把副机的工作区用 SMB 共享出来，主机映射成盘符后用本地 IDE 直接打开。开启后插件 roots / denyPaths 边界失效，.env 与密钥对共享方可见，风险自负。',
        ),
        h('div', { className: 'dra-row', style: { marginTop: 7 } },
          h('div', { className: 'dra-field', style: { flex: '1 1 150px' } },
            h('label', { className: 'dra-label' }, '副机'),
            h('select', {
              className: 'dra-select',
              value: nodeId,
              onChange: function (e) {
                setNodeId(e.target.value)
                const rs = rootsOf(e.target.value)
                setShareDir(rs.length ? rs[0] : '')
                setPlan(null)
              },
            }, nodes.map(function (n) { return h('option', { key: n.nodeId, value: n.nodeId }, shortId(n.nodeId)) })),
          ),
          h('div', { className: 'dra-field', style: { flex: '1 1 170px' } },
            h('label', { className: 'dra-label' }, '共享目录'),
            nodeRoots.length > 0
              ? h('select', {
                className: 'dra-select dra-mono',
                value: shareDir,
                onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
              }, nodeRoots.map(function (r) { return h('option', { key: r, value: r }, r) }))
              : h('input', {
                className: 'dra-input dra-mono',
                value: shareDir,
                placeholder: '副机工作区绝对路径（如 D:\\work），需要先在副机配置 roots',
                onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
              }),
          ),
        ),
        nodeRoots.length === 0
          ? h('div', { className: 'dra-hint', style: { marginTop: 3 } },
            '这台副机没上报 roots —— 请先在副机配置工作区；共享只允许 roots 内的目录。')
          : h('div', { className: 'dra-hint', style: { marginTop: 3 } }, '只共享这一个目录，不要共享整个盘。'),
        h('div', { className: 'dra-row', style: { marginTop: 2 } },
          h('div', { className: 'dra-field', style: { flex: '0 0 110px' } },
            h('label', { className: 'dra-label' }, '权限'),
            h('select', {
              className: 'dra-select',
              value: access,
              onChange: function (e) { setAccess(e.target.value); setPlan(null) },
            },
              h('option', { value: 'read' }, '只读'),
              h('option', { value: 'write' }, '读写'),
            ),
            access === 'write' ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 3 } }, '读写模式下主机可以修改副机文件（默认只读，最小权限）') : null,
          ),
          h('label', { className: 'dra-check', style: { marginTop: 14 } },
            h('input', { type: 'checkbox', checked: ack, onChange: function (e) { setAck(e.target.checked) } }),
            h('span', null, '我已知情：共享会绕过 roots / denyPaths 边界'),
          ),
        ),
        h('div', { className: 'dra-row', style: { marginTop: 6 } },
          h('button', {
            className: 'dra-btn sm primary',
            disabled: busy || !ack || nodeId === '' || shareDir.trim() === '',
            onClick: doPlan,
          }, busy ? '生成中…' : '生成共享命令'),
        ),
        note ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 5 } }, note) : null,
        plan ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 7 } }, '在副机（管理员 PowerShell）执行'),
          h('div', { className: 'dra-pre' }, (plan.followUp || []).join('\n') || plan.message || JSON.stringify(plan, null, 2)),
        ) : null,
      )
    }

    /* ───────────────────────────── 任务详情 ───────────────────────────── */
    function finalPathsOf(handoff) {
      const m = handoff && Array.isArray(handoff.manifest) ? handoff.manifest : []
      return m.filter(function (e) { return e && e.role === 'final' }).map(function (e) { return e.path })
    }

    function TaskDetail(props) {
      const d = props.detail || null
      const t = d && d.task ? d.task : null
      const handoff = d && d.handoff ? d.handoff : null
      if (props.loading === true) {
        return h('div', { className: 'dra-detail dra-hint' }, '读取任务详情…')
      }
      if (!t) return null
      const finals = finalPathsOf(handoff)
      return h('div', { className: 'dra-detail' },
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('div', { className: 'dra-row' },
            h('span', { className: 'dra-card-title' }, '任务详情'),
            h(Badge, { tone: t.status === 'done' ? 'ok' : (t.status === 'failed' ? 'bad' : 'acc') }, STATUS_LABEL[t.status] || t.status),
          ),
          h('button', { className: 'dra-btn sm', onClick: props.onClose }, '收起'),
        ),
        h('dl', { className: 'dra-kv' },
          h('dt', null, 'taskId'), h('dd', { className: 'dra-mono' }, t.taskId),
          h('dt', null, '节点'), h('dd', { className: 'dra-mono' }, t.nodeId),
          h('dt', null, '模式'), h('dd', null, (t.mode || '—') + (t.approval === 'manual' ? ' · 需审批' : '')),
          h('dt', null, '创建'), h('dd', null, fmtTime(t.createdAt)),
          h('dt', null, '结束'), h('dd', null, fmtTime(t.endedAt)),
          h('dt', null, '耗时'), h('dd', null, fmtDur(t.durationMs || (t.endedAt && t.startedAt ? t.endedAt - t.startedAt : 0))),
          t.exit ? h('dt', null, '退出码') : null,
          t.exit ? h('dd', { className: 'dra-mono ' + (t.exit.code === 0 ? 'dra-ok' : 'dra-danger') },
            String(t.exit.code) + (t.exit.timedOut ? ' · 超时' : '') + (t.exit.aborted ? ' · 中止' : '')) : null,
          t.error ? h('dt', null, '错误') : null,
          t.error ? h('dd', { className: 'dra-danger dra-wrap' }, (t.error.code || '') + ' ' + (t.error.message || '')) : null,
        ),
        t.summaryText ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '摘要'),
          h('div', { className: 'dra-pre' }, t.summaryText),
        ) : null,
        (t.changed && t.changed.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '改动（' + t.changedCount + '）'),
          h('div', { className: 'dra-pre' }, t.changed.join('\n')),
        ) : null,
        finals.length ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '成品（' + finals.length + '）'),
          finals.map(function (p) {
            return h('div', { key: p, className: 'dra-row', style: { justifyContent: 'space-between', marginTop: 3 } },
              h('span', { className: 'dra-mono dra-wrap', style: { flex: 1 } }, p),
              h('button', {
                className: 'dra-btn sm',
                onClick: function () { props.onAction(t.taskId, 'pull', p) },
              }, '拉取'),
            )
          }),
        ) : (handoff ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '该任务没有 role=final 的成品可拉。') : null),
        (t.progressTail && t.progressTail.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '进度'),
          h('div', { className: 'dra-pre' }, t.progressTail.map(function (p, i) {
            return (i + 1) + '. ' + (typeof p === 'string' ? p : (p.detail || p.message || JSON.stringify(p)))
          }).join('\n')),
        ) : null,
        (t.logTail && t.logTail.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '日志（尾）'),
          h('div', { className: 'dra-pre' }, t.logTail.join('\n')),
        ) : null,
      )
    }

    /* ───────────────────────────── 首次配置 ───────────────────────────── */
    function SetupView(props) {
      const setup = props.setup || {}
      const cur = setup.current || {}
      const switching = props.switching === true
      const [step, setStep] = React.useState('choose')
      const [role, setRole] = React.useState(switching ? (cur.role || 'hub') : '')
      const [hubUrl, setHubUrl] = React.useState(cur.hubUrl || '')
      const [relayUrl, setRelayUrl] = React.useState(cur.relayUrl || '')
      const [nodeId, setNodeId] = React.useState(cur.nodeId || '')
      const [roots, setRoots] = React.useState(Array.isArray(cur.roots) && cur.roots.length ? cur.roots.join('\n') : defaultRootsHint())
      const [pairCode, setPairCode] = React.useState('')
      // 节点 ID 默认取主机名，折叠为高级选项（少一个必读字段）。
      const [showAdv, setShowAdv] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [conflict, setConflict] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [done, setDone] = React.useState(null)

      function defaultRootsHint() {
        // 面板拿不到服务端 os.homedir()，用 userAgent 判平台足够（这是预填提示，不是安全判定）。
        // 必须是具体子目录：roots 是安全边界，不能是整盘或整个家目录。
        try {
          const ua = (navigator && navigator.userAgent) || ''
          if (/Windows/i.test(ua)) return 'D:\\work'
          return '~/work'
        } catch (e) {
          return ''
        }
      }

      /* 配对码：dshra1://<base64(JSON)>，粘贴即填（副机不用手抄地址）。 */
      function parsePair(text) {
        const s = String(text || '').trim()
        if (!/^(dshra1:\/\/)/.test(s)) return null
        try {
          const raw = window.atob(s.slice('dshra1://'.length))
          const d = JSON.parse(raw)
          const n = {}
          n.hubUrl = d.hubUrl
          n.nodeId = d.nodeId
          n.roots = d.roots
          n.relayUrl = d.relayUrl
          return n
        } catch (e) {
          return null
        }
      }

      function applyPair() {
        const d = parsePair(pairCode)
        if (!d) { setErr('配对码格式不对：应以 dshra1:// 开头'); return }
        if (d.hubUrl) setHubUrl(d.hubUrl)
        if (d.relayUrl) setRelayUrl(d.relayUrl)
        if (d.nodeId) setNodeId(d.nodeId)
        if (Array.isArray(d.roots) && d.roots.length) setRoots(d.roots.join('\n'))
        setErr('')
        setNote('已从配对码填入地址，确认后提交')
      }

      function submit(kind, opts) {
        const use = kind || role || 'hub'
        const body = { role: use }
        if (opts && opts.force === true) body.force = true
        if (use !== 'worker' && hubUrl.trim()) body.hubUrl = hubUrl.trim()
        if (use !== 'hub' && relayUrl.trim()) body.relayUrl = relayUrl.trim()
        if (nodeId.trim()) body.nodeId = nodeId.trim()
        const rs = String(roots || '').split(/[\n,]+/).map(function (x) { return x.trim() }).filter(Boolean)
        if (rs.length) body.roots = rs
        setBusy(true)
        setErr('')
        setNote('')
        setConflict('')
        fetch(SETUP_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (b) {
              return { ok: r.ok, status: r.status, body: b || {} }
            })
          })
          .then(function (res) {
            if (!res.ok) {
              const code = String(res.body.code || res.body.error || '')
              if (res.status === 409 || /conflict|exists/i.test(code)) setConflict(res.body.message || '检测到已有配置')
              setErr(res.body.message || res.body.error || ('HTTP ' + res.status))
              return
            }
            setDone(res.body)
            setStep('result')
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      const submitHub = function () { submit('hub', { force: true }) }
      const submitWorker = function () { submit('worker', { force: true }) }
      const submitChoice = function () { submit(role || 'hub', { force: true }) }

      if (step === 'result') {
        return h(Card, { title: '写入完成', sub: '重启后生效' },
          h('div', { className: 'dra-hint' },
            '已写入 ' + (done && (done.patchFile || done.file) ? (done.patchFile || done.file) : '配置文件') + '。',
          ),
          h('div', { className: 'dra-hint dra-ok', style: { marginTop: 6 } }, '重启 DSH 生效：配置改动不会热加载。'),
          h('button', { className: 'dra-btn primary', style: { marginTop: 8 }, onClick: props.onDone || props.onCancel }, '知道了'),
        )
      }

      if (step === 'choose') {
        return h(Card, { title: switching ? '切换配置' : '首次配置', sub: '先选这台机器的角色' },
          h('div', { className: 'dra-err' }, err || note || ''),
          conflict ? h('div', { className: 'dra-warn' },
            h('span', null, conflict),
            h('button', { className: 'dra-btn sm', onClick: submitChoice }, '替换手写配置'),
          ) : null,
          h('div', { className: 'dra-hint' }, '你现在用的这台是主机还是副机？选错会让一半装机场景是错的。'),
          h('div', { className: 'dra-choices' },
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('hub'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '我是主机'), h('span', null, 'Hub：管副机、派任务')),
            ),
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('worker'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '我是副机'), h('span', null, 'Worker：等任务、回报')),
            ),
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('both'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '同机自测'), h('span', null, 'both：一台机器跑两端')),
            ),
          ),
          switching ? h('button', { className: 'dra-btn', style: { marginTop: 8 }, onClick: props.onCancel }, '取消') : null,
        )
      }

      if (role === 'worker') {
        return h(Card, { title: switching ? '切换为副机' : '副机（Worker）配置', sub: '填中继地址或粘贴配对码' },
          h('div', { className: 'dra-err' }, err || note || ''),
          conflict ? h('div', { className: 'dra-warn' },
            h('span', null, conflict),
            h('button', { className: 'dra-btn sm', onClick: submitWorker }, '替换手写配置'),
          ) : null,
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '配对码（dshra1://…，可整段粘贴）'),
            h('div', { className: 'dra-row' },
              h('input', {
                className: 'dra-input dra-mono',
                value: pairCode,
                placeholder: 'dshra1://eyJ...',
                onChange: function (e) { setPairCode(e.target.value) },
              }),
              h('button', { className: 'dra-btn sm', onClick: applyPair }, '解析填入'),
            ),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '中继地址（relayUrl）'),
            h('input', {
              className: 'dra-input dra-mono',
              value: relayUrl,
              placeholder: 'ws://192.168.1.10:8890/relay',
              onChange: function (e) { setRelayUrl(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '工作区 roots（每行一个）'),
            h('textarea', {
              className: 'dra-textarea dra-mono',
              value: roots,
              placeholder: defaultRootsHint(),
              onChange: function (e) { setRoots(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' },
              h('span', null, '本机标识'),
              h('span', {
                className: 'dra-hint',
                style: { marginLeft: 8, cursor: 'pointer', textDecoration: 'underline' },
                onClick: function () { setShowAdv(!showAdv) },
              }, showAdv ? '收起' : '默认用主机名（点此自定义）'),
            ),
            showAdv
              ? h('input', {
                className: 'dra-input dra-mono',
                value: nodeId,
                placeholder: '留空 = 自动用本机主机名',
                onChange: function (e) { setNodeId(e.target.value) },
              })
              : null,
          ),
          h('div', { className: 'dra-row', style: { marginTop: 4 } },
            h('button', { className: 'dra-btn primary', disabled: busy, onClick: function () { submit('worker') } }, busy ? '写入中…' : '确认，写入配置'),
            h('button', { className: 'dra-btn', onClick: function () { setStep('choose') } }, '返回'),
            switching ? h('button', { className: 'dra-btn', onClick: props.onCancel }, '取消') : null,
          ),
          h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '写盘会先备份并校验；重启 DSH 后生效。'),
        )
      }

      return h(Card, { title: switching ? '切换为' + (role === 'both' ? '同机自测' : '主机') : '主机（Hub）配置', sub: '写 profile 的 cordis.patch.yml' },
        h('div', { className: 'dra-err' }, err || note || ''),
        conflict ? h('div', { className: 'dra-warn' },
          h('span', null, conflict),
          h('button', { className: 'dra-btn sm', onClick: submitHub }, '替换手写配置'),
        ) : null,
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '中继地址（relayUrl，ws://IP:8890/relay）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: relayUrl,
            placeholder: 'ws://192.168.1.10:8890/relay',
            onChange: function (e) { setRelayUrl(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '本机对外地址（hubUrl，可留空自动推断）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: hubUrl,
            placeholder: 'http://192.168.1.10:19387',
            onChange: function (e) { setHubUrl(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' },
            h('span', null, '本机标识'),
            h('span', {
              className: 'dra-hint',
              style: { marginLeft: 8, cursor: 'pointer', textDecoration: 'underline' },
              onClick: function () { setShowAdv(!showAdv) },
            }, showAdv ? '收起' : '默认用主机名（点此自定义）'),
          ),
          showAdv
            ? h('input', {
              className: 'dra-input dra-mono',
              value: nodeId,
              placeholder: '留空 = 自动用本机主机名',
              onChange: function (e) { setNodeId(e.target.value) },
            })
            : null,
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '工作区 roots（每行一个）'),
          h('textarea', {
            className: 'dra-textarea dra-mono',
            value: roots,
            placeholder: defaultRootsHint(),
            onChange: function (e) { setRoots(e.target.value) },
          }),
          h('div', { className: 'dra-hint' }, defaultRootsHint()),
        ),
        h('div', { className: 'dra-row', style: { marginTop: 4 } },
          h('button', { className: 'dra-btn primary', disabled: busy, onClick: function () { submit('hub') } }, busy ? '写入中…' : '确认，写入配置'),
          h('button', { className: 'dra-btn', onClick: function () { setStep('choose') } }, '返回'),
          switching ? h('button', { className: 'dra-btn', onClick: props.onCancel }, '取消') : null,
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '写盘会先备份并校验；重启 DSH 后生效。'),
      )
    }

    /* ───────────────────────────── 面板主体 ───────────────────────────── */
    function Panel() {
      /* 全部状态集中在顶部 —— 任何条件 return 之前（fork.14 白板根因）。 */
      const [state, setState] = React.useState({
        loading: true, error: '', mode: '', nodes: [], tasks: [],
        counts: null, caps: null, connection: null, worker: null, setup: null,
      })
      const [tick, setTick] = React.useState(0)
      const [selected, setSelected] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const [form, setForm] = React.useState({
        goal: '', node: '', mode: 'agent', workspace: '', model: '',
        outputs: '', timeoutMs: '', needApproval: false, templateId: '',
      })
      const [modelCustom, setModelCustom] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [autoRefresh, setAutoRefresh] = React.useState(true)
      const [theme, setTheme] = React.useState('dark')
      const [cfg, setCfg] = React.useState(null)
      const [cfgEdit, setCfgEdit] = React.useState({})
      const [envCheck, setEnvCheck] = React.useState(null)
      const [envBusy, setEnvBusy] = React.useState(false)
      const [fixPlan, setFixPlan] = React.useState(null)
      const [fixBusy, setFixBusy] = React.useState(false)
      const [fixMsg, setFixMsg] = React.useState('')
      const [tools, setTools] = React.useState(null)
      const [toolsBusy, setToolsBusy] = React.useState(false)
      const [taskFilter, setTaskFilter] = React.useState('all')
      const [purgeBusy, setPurgeBusy] = React.useState(false)
      const [switchRole, setSwitchRole] = React.useState(false)
      const [enroll, setEnroll] = React.useState({ loading: false, data: null, error: '' })
      /* 模板库：只在自己的 effect 里拉，不进 4 秒轮询（否则正在编辑的下拉框会被重建）。 */
      const [tpl, setTpl] = React.useState({ loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' })
      const [tplMsg, setTplMsg] = React.useState('')
      const [pair, setPair] = React.useState(null)
      const [pairNote, setPairNote] = React.useState('')
      const autoChecked = React.useRef(false)
      const autoRef = React.useRef(true)
      const kickRef = React.useRef(true)
      const inflight = React.useRef(false)

      const setF = function (patch) {
        setForm(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          Object.keys(patch).forEach(function (k) { next[k] = patch[k] })
          return next
        })
      }

      function computeCounts(tasks, ov) {
        const list = tasks || []
        const nodes = state.nodes || []
        const done = list.filter(function (t) { return t.status === 'done' }).length
        const failed = list.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' }).length
        const active = list.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 }).length
        const online = ov && ov.online != null
          ? ov.online
          : nodes.filter(function (n) { return n.online === true }).length
        return {
          nodes: ov && ov.nodes != null ? ov.nodes : nodes.length,
          online: online,
          tasks: list.length,
          running: ov && ov.running != null ? ov.running : active,
          active: active,
          done: done,
          failed: failed,
        }
      }

      function loadPair() {
        const port = (window.location && window.location.port) || ''
        apiGet('/pair-info?port=' + encodeURIComponent(port))
          .then(function (d) {
            setPair(d || null)
            setPairNote(d && d.ok === false ? (d.message || d.code || '配对码读取失败') : '')
          })
          .catch(function (e) { setPairNote('配对码读取失败：' + ((e && e.message) || e)) })
      }

      function runEnvCheck() {
        setEnvBusy(true)
        apiGet('/env-check')
          .then(function (d) { setEnvCheck(d || null) })
          .catch(function (e) { setEnvCheck({ ok: false, items: [], failed: 1, error: String((e && e.message) || e) }) })
          .then(function () { setEnvBusy(false) })
      }

      function afterHub(ov, tk) {
        const tasks = tk && Array.isArray(tk.tasks) ? tk.tasks : []
        setState(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          next.loading = false
          next.error = ''
          next.mode = 'hub'
          next.nodes = ov && Array.isArray(ov.nodes) ? ov.nodes : []
          next.tasks = tasks
          next.counts = computeCounts(tasks, ov && ov.counts ? ov.counts : null)
          next.caps = ov && ov.capabilities ? ov.capabilities : null
          next.connection = ov && ov.connection ? ov.connection : null
          next.worker = null
          next.setup = null
          return next
        })
        apiGet('/config').then(function (d) { setCfg(d && d.config ? d.config : null) }).catch(function () {})
        loadPair()
        if (!autoChecked.current) {
          autoChecked.current = true
          runEnvCheck()
        }
      }

      function loadHub() {
        return apiGet('/overview')
          .then(function (ov) {
            return apiGet('/tasks').then(function (tk) {
              afterHub(ov, tk)
              setState(function (prev) { return Object.assign({}, prev, { mode: 'hub' }) })
            })
          })
          .catch(function () {
            return apiGetPath(STATUS_PATH)
              .then(function (d) {
                setState(function (prev) {
                  return Object.assign({}, prev, { loading: false, error: '', mode: 'worker', worker: d || null })
                })
              })
              .catch(function () {
                return apiGetPath(SETUP_STATE_PATH)
                  .then(function (d) {
                    setState(function (prev) {
                      return Object.assign({}, prev, { loading: false, error: '', mode: 'setup', setup: d || null })
                    })
                  })
                  .catch(function (err) {
                    setState(function (prev) {
                      return Object.assign({}, prev, { loading: false, error: String((err && err.message) || err) })
                    })
                  })
              })
          })
      }

      function load() {
        if (!autoRef.current && !kickRef.current) return
        kickRef.current = false
        if (inflight.current) return
        inflight.current = true
        const done = function () { inflight.current = false }
        if (state.mode === 'worker') {
          apiGetPath(STATUS_PATH)
            .then(function (d) {
              setState(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
                next.loading = false
                next.error = ''
                next.worker = d || null
                return next
              })
            })
            .catch(function (e) {
              setState(function (prev) {
                return Object.assign({}, prev, { loading: false, error: String((e && e.message) || e) })
              })
            })
            .then(done)
          return
        }
        if (state.mode === 'setup') {
          apiGetPath(SETUP_STATE_PATH)
            .then(function (d) {
              setState(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
                next.loading = false
                next.error = ''
                next.setup = d || null
                return next
              })
            })
            .catch(function (e) {
              setState(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
                next.loading = false
                next.error = String((e && e.message) || e)
                return next
              })
            })
            .then(done)
          return
        }
        if (state.mode === 'hub') {
          loadHub()
            .catch(function (e) {
              setState(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
                next.loading = false
                next.error = String((e && e.message) || e)
                return next
              })
            })
            .then(done)
          return
        }
        loadHub().then(done)
      }

      React.useEffect(function () {
        let disposed = false
        load()
        const timer = setInterval(load, 4000)
        return function () {
          disposed = true
          clearInterval(timer)
        }
      }, [setState, state.mode, tick])

      React.useEffect(function () {
        if (!selected) {
          setDetail(null)
          return undefined
        }
        let gone = false
        setDetailLoading(true)
        apiGet('/task?taskId=' + encodeURIComponent(selected))
          .then(function (d) { if (!gone) setDetail(d || null) })
          .catch(function (e) { if (!gone) setDetail({ error: { message: String((e && e.message) || e) } }) })
          .then(function () { if (!gone) setDetailLoading(false) })
        return function () { gone = true }
      }, [selected, tick])

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

      function applyTemplate(id) {
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        setTplMsg('')
        if (!t) {
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

      function saveTemplate() {
        if (!form.goal.trim()) { setTplMsg('先填任务目标，再存为模板'); return }
        const suggested = form.goal.trim().split('\n')[0].slice(0, 30)
        const name = window.prompt('模板名（之后在下拉框里选它）', suggested)
        if (name === null) return
        const trimmed = String(name).trim()
        if (trimmed === '') { setTplMsg('模板名不能为空'); return }
        const outputs = String(form.outputs || '').split(/[, \n]+/).map(function (s) { return s.trim() }).filter(Boolean)
        const body = { name: trimmed, goal: form.goal.trim(), mode: form.mode === 'exec' ? 'exec' : 'agent' }
        if (form.workspace.trim()) body.workspace = form.workspace.trim()
        if (form.model.trim()) body.model = form.model.trim()
        if (outputs.length) body.outputs = outputs
        const tmo = Number(form.timeoutMs)
        if (String(form.timeoutMs || '').trim() !== '' && Number.isFinite(tmo)) body.timeoutMs = tmo
        if (form.templateId) body.id = form.templateId
        setTplMsg('保存中…')
        apiPost('/templates/save', body)
          .then(function (r) {
            const t = (r && r.template) || {}
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = t.id || ''; return n })
            setTplMsg(r && r.updated ? ('已更新模板「' + (t.name || '') + '」') : ('已保存模板「' + (t.name || '') + '」'))
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('保存失败：' + ((err && err.message) || err)) })
      }

      function deleteTemplate() {
        const id = form.templateId
        if (!id) { setTplMsg('先在下拉框里选中一条模板'); return }
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        if (!window.confirm('删除模板「' + ((t && t.name) || id) + '」？只删这条预设，不影响已派出的任务。')) return
        setTplMsg('删除中…')
        apiPost('/templates/delete', { id: id })
          .then(function () {
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = ''; return n })
            setTplMsg('已删除模板')
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('删除失败：' + ((err && err.message) || err)) })
      }

      /* mode 切换后让轮询立即重跑。 */
      function switchMode(m) {
        kickRef.current = true
        setState(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          next.mode = m
          next.error = ''
          next.loading = true
          return next
        })
        setTick(function (t) { return t + 1 })
      }

      function refresh() {
        kickRef.current = true
        setTick(function (t) { return t + 1 })
      }

      function dispatch() {
        const fv = form
        if (!fv.goal.trim()) { setNote('先填写任务目标'); return }
        const outputs = String(fv.outputs || '').split(/[, \n]+/).map(function (s) { return s.trim() }).filter(Boolean)
        // 超时：空 / 非数字一律不传，让服务端用 defaults.timeoutMs。
        const tmo = Number(fv.timeoutMs)
        const timeoutMs = fv.timeoutMs.trim() !== '' && Number.isFinite(tmo) && tmo > 0 ? tmo : undefined
        const body = {
          goal: fv.goal.trim(),
          node: fv.node || undefined,
          mode: fv.mode || 'agent',
          workspace: fv.workspace.trim() || undefined,
          model: fv.model || undefined,
          outputs: outputs.length ? outputs : undefined,
          timeoutMs: timeoutMs,
          approval: fv.needApproval ? 'manual' : undefined,
        }
        setBusy(true)
        setNote('')
        apiPost('/dispatch', body)
          .then(function (d) {
            setNote('已派发给 ' + shortId(d && d.nodeId) + '（' + shortId(d && d.taskId) + '）')
            setF({ goal: '' })
            refresh()
          })
          .catch(function (e) { setNote('派发失败：' + ((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      function clearTasks() {
        const label = '清理'
        if (!window.confirm(label + '已结束的历史任务？运行中的任务会保留。')) return
        setPurgeBusy(true)
        apiPost('/purge', { includeActive: false })
          .then(function (d) { setNote('已清理 ' + (d && d.removed != null ? d.removed : '') + ' 条历史任务（运行中的保留）'); refresh() })
          .catch(function (e) { setNote('清理失败：' + ((e && e.message) || e)) })
          .then(function () { setPurgeBusy(false) })
      }

      function mintEnroll() {
        setEnroll({ loading: true, data: null, error: '' })
        apiPost('/relay-enroll', {})
          .then(function (d) {
            if (!d || !d.enrollToken) throw new Error((d && (d.message || d.error)) || '没有返回 enrollToken')
            setEnroll({ loading: false, data: d, error: '' })
          })
          .catch(function (e) { setEnroll({ loading: false, data: null, error: '铸造失败：' + ((e && e.message) || e) }) })
      }

      function previewFix() {
        setFixBusy(true)
        setFixMsg('')
        apiPost('/fix', { action: 'plan' })
          .then(function (d) { setFixPlan(d || null); if (!d || d.ok === false) setFixMsg((d && (d.message || d.error)) || '读取修复计划失败') })
          .catch(function (e) { setFixMsg('读取修复计划失败：' + ((e && e.message) || e)) })
          .then(function () { setFixBusy(false) })
      }

      function applyFix() {
        setFixBusy(true)
        apiPost('/fix', { action: 'apply', confirm: 'yes' })
          .then(function (d) {
            setFixMsg(d && d.ok === false ? ((d.message || d.error) || '修复失败') : '已应用修复，重启 DSH 生效')
            runEnvCheck()
          })
          .catch(function (e) { setFixMsg('修复失败：' + ((e && e.message) || e)) })
          .then(function () { setFixBusy(false) })
      }

      function probeTools() {
        setToolsBusy(true)
        apiGet('/tools')
          .then(function (d) { setTools(d || null) })
          .catch(function (e) { setTools({ tools: [], missing: [], error: String((e && e.message) || e) }) })
          .then(function () { setToolsBusy(false) })
      }

      function taskAction(taskId, action, path) {
        if (action === 'detail') { setSelected(taskId); return }
        if (action === 'cancel') {
          apiPost('/cancel', { taskId: taskId }).then(function () { refresh() }).catch(function (e) { setNote('取消失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'approve') {
          apiPost('/approve', { taskId: taskId }).then(function () { refresh() }).catch(function (e) { setNote('批准失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'reject') {
          apiPost('/reject', { taskId: taskId }).then(function () { refresh() }).catch(function (e) { setNote('拒绝失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'pull') {
          const paths = path ? [path] : finalPathsOf(detail && detail.handoff)
          if (!paths.length) { setNote('该任务没有可拉的 final 产物'); return }
          const dest = window.prompt('拉到本机 uiPullRoot 下的哪个相对子目录？（留空 = 直接放 uiPullRoot）', '')
          apiPost('/pull', { taskId: taskId, paths: paths, dest: dest && dest.trim() ? dest.trim() : undefined })
            .then(function (d) {
              const ok = (d && Array.isArray(d.results) ? d.results : []).filter(function (r) { return r.ok })
              setNote('已拉取 ' + ok.length + '/' + paths.length + ' 个文件到 ' + ((d && d.dest) || '目标目录'))
            })
            .catch(function (e) { setNote('拉取失败：' + ((e && e.message) || e)) })
        }
      }

      function nodeAction(nodeId, action) {
        if (action === 'copy') { copyText(nodeId); setNote('已复制节点 ID'); return }
        if (action === 'purge') {
          apiPost('/purge', { node: nodeId, includeActive: false })
            .then(function (d) { setNote('已清理 ' + shortId(nodeId) + ' 的 ' + ((d && d.removed) || 0) + ' 条历史'); refresh() })
            .catch(function (e) { setNote('清理失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'detail') { setSelected(''); setNote('节点 ' + nodeId + '：' + ((state.nodes.filter(function (n) { return n.nodeId === nodeId })[0] || {}).roots || []).join(' · ')) }
      }

      /* ── 派生值 ── */
      const tasks = state.tasks || []
      const nodes = state.nodes || []
      const counts = state.counts || { nodes: 0, online: 0, tasks: 0, running: 0, active: 0, done: 0, failed: 0 }
      const activeTasks = tasks.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 })
      const themeClass = theme === 'light' ? ' dra-light' : ''
      const connection = state.connection || null
      const everConnected = connection ? connection.everConnected === true : false
      const connDiag = connection && connection.reachability ? (connection.reachability.hint || '') : ''
      const filteredTasks = taskFilter === 'all'
        ? tasks
        : taskFilter === 'running'
          ? activeTasks
          : taskFilter === 'done'
            ? tasks.filter(function (t) { return t.status === 'done' })
            : tasks.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' })

      function openSwitch() {
        setSwitchRole(true)
        apiGetPath(SETUP_STATE_PATH).then(function (d) {
          setState(function (prev) { return Object.assign({}, prev, { setup: d || null }) })
        }).catch(function () {})
      }

      /* 已配置后改角色：复用 SetupView（写盘只有一份实现）。 */
      if (switchRole) {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          h(SetupView, {
            switching: true,
            setup: state.setup,
            onDone: function () { setSwitchRole(false); switchMode('hub') },
            onCancel: function () { setSwitchRole(false) },
          }),
        )
      }

      /* ── Worker 视图（副机）：只看本机，不显示 hub 专属操作 ── */
      if (state.mode === 'worker') {
        const w = state.worker || {}
        const wt = w.tasks || {}
        const weak = state.error !== ''
        const workerHint = '任务在主机的「主机面板」上看，本机只负责执行。'
        const workerInfo = [
          ['角色', '副机 Worker'],
          ['节点 ID', w.nodeId || '—'],
          ['连接', w.online === true ? ('在线（' + (w.transportMode || 'relay') + '）') : '离线'],
          ['主机地址', w.url || '—'],
          ['执行后端', w.runner || w.agentMode ? (w.runner || 'agent') : '—'],
          ['工作区', Array.isArray(w.roots) && w.roots.length ? w.roots.join('\n') : '—'],
          ['能力', Array.isArray(w.caps) && w.caps.length ? w.caps.join(' · ') : '—'],
          ['任务状态分布', '总数 ' + (wt.total || 0) + ' · 运行 ' + (wt.running || 0) + ' · 排队 ' + (wt.queued || 0) + ' · 活动 ' + (wt.active || 0)],
        ]
        const workerCards = h('div', { className: 'dra-statbar' },
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, w.online ? '在线' : '离线'), h('div', { className: 'dra-stat-label' }, '连接状态')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.running || 0)), h('div', { className: 'dra-stat-label' }, '运行中')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.queued || 0)), h('div', { className: 'dra-stat-label' }, '排队中')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.total || 0)), h('div', { className: 'dra-stat-label' }, '任务总数')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, w.dshVersion || '—'), h('div', { className: 'dra-stat-label' }, 'DSH 版本')),
        )
        /* Worker 也要能改接入配置：relayUrl + enrollToken 可编辑，切换角色复用同一份写盘实现。 */
        const workerCfg = h('div', { className: 'dra-col' },
          h(ConfigPanel, {
            mode: 'worker', cfg: cfg, edit: cfgEdit,
            onEdit: function (k, v) {
              const patch = {}
              patch[k] = v
              setCfgEdit(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (kk) { next[kk] = prev[kk] })
                Object.keys(patch).forEach(function (kk) { next[kk] = patch[kk] })
                return next
              })
            },
          }),
          h('div', { className: 'dra-row', style: { marginTop: 6 } },
            h('button', { className: 'dra-btn sm', onClick: function () { setSwitchRole(true); openSwitch() } }, '切换角色'),
            h('span', { className: 'dra-hint' }, '改角色或地址复用同一份写盘逻辑'),
          ),
        )
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          h(Toolbar, {
            mode: 'worker', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
            onSwitchMode: switchMode,
            onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
            onToggleTheme: function () { setTheme(theme === 'dark' ? 'light' : 'dark') },
            onRefresh: refresh,
          }),
          weak ? h('div', { className: 'dra-banner err' },
            h('div', { className: 'dra-banner-title' }, '读不到副机状态'),
            h('div', { className: 'dra-mono dra-wrap' }, state.error),
          ) : null,
          workerCards,
          workerCfg,
          h('div', { className: 'dra-main-grid' },
            h('div', { className: 'dra-col' },
              h(Card, { title: '本机状态', sub: 'Worker 视图' },
                h('dl', { className: 'dra-kv' },
                  workerInfo.map(function (row) {
                    return [h('dt', { key: 'k' + row[0] }, row[0]), h('dd', { key: 'v' + row[0], className: 'dra-wrap' }, row[1])]
                  }),
                ),
                w.lastError ? h('div', { className: 'dra-hint dra-danger', style: { marginTop: 8 } }, '最近错误：' + w.lastError + (w.lastErrorDetail ? ' · ' + w.lastErrorDetail : '')) : null,
              ),
            ),
            h('div', { className: 'dra-col' },
              h(Card, { title: '任务在主机的面板上' },
                h('div', { className: 'dra-hint' }, workerHint + '本机只显示连接与队列计数。'),
                h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '接入地址：' + (w.url || '未连接') + '　工作目录：' + (w.stateDir || '—')),
              ),
            ),
          ),
        )
      }

      /* ── Setup 视图（尚未配置） ── */
      if (state.mode === 'setup') {
        return h('div', { className: 'dra-root' + themeClass },
          h(StyleTag),
          h(Toolbar, {
            mode: '', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
            onSwitchMode: switchMode,
            onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
            onToggleTheme: function () { setTheme(theme === 'dark' ? 'light' : 'dark') },
            onRefresh: () => setTick(function (t) { return t + 1 }),
          }),
          h('div', { className: 'dra-banner' },
            h('div', { className: 'dra-banner-title' }, '本机还没有配置 remote-agent'),
            h('div', null, '填一次下面的信息即可；写入后重启 DSH 生效。'),
          ),
          h(SetupView, {
            setup: state.setup,
            onDone: function () { switchMode('hub') },
            onCancel: function () { switchMode('hub') },
          }),
        )
      }

      /* ── Hub 视图（主机） ── */
      const cfgSection = h('div', null,
        h(ConfigPanel, {
          mode: 'hub', cfg: cfg, edit: cfgEdit,
          onEdit: function (k, v) { const patch = {}; patch[k] = v; setCfgEdit(function (prev) { const next = {}; Object.keys(prev).forEach(function (kk) { next[kk] = prev[kk] }); Object.keys(patch).forEach(function (kk) { next[kk] = patch[kk] }); return next }) },
        }),
        h('div', { className: 'dra-row', style: { marginTop: 6 } },
          h('button', { className: 'dra-btn sm', onClick: function () { setSwitchRole(true); openSwitch() } }, '切换角色'),
          h('span', { className: 'dra-hint' }, '已配置后改角色或地址，复用同一份写盘逻辑'),
        ),
      )
      const dispatchForm = h('div', null,
        h('div', { className: 'dra-tplrow' },
          h('select', {
            className: 'dra-select dra-mono',
            value: form.templateId || '',
            title: tpl.error ? ('模板库不可读：' + tpl.error) : (tpl.file ? ('模板存于 ' + tpl.file) : ''),
            onChange: function (e) { applyTemplate(e.target.value) },
          },
            h('option', { value: '' }, tpl.loading
              ? '模板：读取中…'
              : ((tpl.list || []).length === 0 ? '模板：（还没有，可把当前表单存下来）' : '模板：选一个一键填充')),
            (tpl.list || []).map(function (t) {
              return h('option', { key: t.id, value: t.id },
                t.name + (t.mode === 'exec' ? '（exec）' : '') + (t.workspace ? ' · ' + t.workspace : ''))
            }),
          ),
          h('button', {
            className: 'dra-btn sm',
            disabled: busy || !form.goal.trim() || !!tpl.error,
            title: tpl.error ? '模板库不可读' : '把当前表单内容存成模板',
            onClick: saveTemplate,
          }, form.templateId ? '更新模板' : '存为模板'),
          h('button', {
            className: 'dra-btn sm',
            disabled: busy || !form.templateId,
            title: form.templateId ? '删除当前选中的模板' : '先在下拉框里选一条模板',
            onClick: deleteTemplate,
          }, '删除模板'),
          (tpl.max && (tpl.list || []).length >= tpl.max)
            ? h('span', { className: 'dra-hint' }, '模板已达上限 ' + tpl.max + ' 条') : null,
          tpl.degraded
            ? h('span', { className: 'dra-hint dra-warn' }, '模板文件读不出来（' + (tpl.reason || 'unknown') + '）') : null,
          tpl.error
            ? h('span', { className: 'dra-hint dra-warn' }, '模板库不可用：' + tpl.error) : null,
          tplMsg ? h('span', { className: 'dra-hint' }, tplMsg) : null,
        ),
        h(DispatchForm, {
          nodes: nodes, form: form, busy: busy, modelCustom: modelCustom,
          onFormChange: setF,
          setModelCustom: setModelCustom,
          onSubmit: dispatch,
        }),
      )
      const pairSection = h('div', null,
        h(PairPanel, { pair: pair, pairNote: pairNote, onLoadPair: loadPair }),
        h(EnrollPanel, { enroll: enroll, onEnroll: mintEnroll }),
        h(StepGuide),
      )
      const hubLeft = h('div', { className: 'dra-col' },
        h(NodeCardGrid, {
          nodes: nodes, onlineCount: counts.online, onAction: nodeAction,
          actions: h('button', { className: 'dra-btn sm', onClick: refresh }, '刷新'),
        }),
        h(TopologyMap, { nodes: nodes, tasks: tasks }),
        h(TaskList, {
          tasks: filteredTasks, filter: taskFilter, purgeBusy: purgeBusy,
          onFilter: function (f) { setTaskFilter(f) },
          onAction: taskAction, onClear: clearTasks,
        }),
        selected ? h(TaskDetail, {
          detail: detail, loading: detailLoading,
          onClose: function () { setSelected('') },
          onAction: taskAction,
        }) : null,
      )
      const hubRight = h('div', { className: 'dra-col' },
        cfgSection,
        dispatchForm,
        h(Fold, { title: '副机接入', badge: nodes.length === 0 ? '先接一台' : (nodes.length + ' 台'), open: state.nodes.length === 0 },
          pairSection,
        ),
      )

      return h('div', { className: 'dra-root' + themeClass },
        h(StyleTag),
        h(Toolbar, {
          mode: 'hub', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
          onSwitchMode: switchMode,
          onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
          onToggleTheme: function () { setTheme(theme === 'dark' ? 'light' : 'dark') },
          onRefresh: refresh,
        }),
        state.error ? h('div', { className: 'dra-banner err' },
          h('div', { className: 'dra-banner-title' }, '连接异常'),
          h('div', { className: 'dra-mono dra-wrap' }, state.error),
          h('div', { className: 'dra-row', style: { marginTop: 6 } },
            h('button', { className: 'dra-btn sm', onClick: refresh }, '重试'),
            h('button', { className: 'dra-btn sm', onClick: function () { switchMode('setup') } }, '首次配置'),
            h('button', { className: 'dra-btn sm', onClick: function () { switchMode('worker') } }, '我是副机'),
          ),
        ) : null,
        !everConnected && nodes.length > 0 ? h('div', { className: 'dra-banner' },
          h('div', { className: 'dra-banner-title' }, '还没有连上过'),
          h('div', null, '有 ' + nodes.length + ' 个节点登记过，但当前都不在线。检查独立监听、relay 地址与口令；地址不能是 0.0.0.0。' + (connDiag ? ' 诊断：' + connDiag : '')),
        ) : null,
        h(StatBar, { counts: counts }),
        note ? h('div', { className: 'dra-banner ok' },
          h('div', { className: 'dra-banner-title' }, note),
        ) : null,
        h('div', { className: 'dra-main-grid' }, hubLeft, hubRight),
        h('div', { className: 'dra-col', style: { marginTop: 4 } },
          h(Fold, { title: '环境体检', badge: envCheck ? (envCheck.failed > 0 ? envCheck.failed + ' 项待处理' : '通过') : '未体检', open: Boolean(envCheck && envCheck.failed > 0) },
            h(EnvPanel, {
              envCheck: envCheck, envBusy: envBusy, fixPlan: fixPlan, fixBusy: fixBusy, fixMsg: fixMsg,
              onRun: runEnvCheck, onPreviewFix: previewFix, onApplyFix: applyFix,
            }),
          ),
          h(Fold, { title: '检测工具', badge: tools ? ((tools.missing || []).length + ' 项缺失') : '未检测' },
            h(ToolPanel, { tools: tools, busy: toolsBusy, onRefresh: probeTools }),
          ),
          h(Fold, { title: '工作区共享（SMB）', badge: '高级' },
            h(SharePanel, { nodes: nodes }),
          ),
        ),
      )
    }

    /* ───────────────────────────── 侧栏图标 ───────────────────────────── */
    function PanelIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 12, cy: 5, r: 2.4 }),
        h('circle', { cx: 5, cy: 18, r: 2.4 }),
        h('circle', { cx: 19, cy: 18, r: 2.4 }),
        h('path', { d: 'M12 7.4v4.2M12 11.6 6.4 15.8M12 11.6l5.6 4.2' }),
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        const disposers = []
        const stylesSvc = ctx.get ? ctx.get('styles') : null
        if (stylesSvc && typeof stylesSvc.insert === 'function') disposers.push(stylesSvc.insert(CSS))
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 30,
            label: function () { return '远程同事' },
          }, PanelIcon)
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel)
        })
        return function () {
          for (let i = 0; i < disposers.length; i += 1) {
            try { disposers[i]() } catch (e) { /* 卸载阶段尽力而为 */ }
          }
        }
      },
    }
  },
})
