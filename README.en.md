# dsh-remote-agent

[![CI](https://github.com/zbzbhs/dsh-remote-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/zbzbhs/dsh-remote-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19%20%7C%7C%20%3E%3D24-green)
![dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

[简体中文](README.md) | **English**

Turn another computer into a **remote agent co-worker** for your DSH.

The worker machine runs its own DSH with an independent agent loop — tasks keep
running locally on it. Your main machine only receives the **handoff result
card** and the **artifact manifest**; final artifacts cross over only when you
explicitly pull them.

```
┌──────────── main machine (hub) ────────────┐
│  DSH · model · session logs · all credentials │
│  ┌─ dsh-remote-agent ─────────────────────┐ │
│  │ 24 remote_* tools + Web panel           │ │
│  └────────────────────────────────────────┘ │
└──────────────────▲──────────────────────────┘
                   │ node dials in (direct / relay)
┌──────────────────┴──────────────────────────┐
│  ┌─ worker machine ─────────────────────────┐ │
│  │  independent agent loop · own model ctx  │ │
│  │  D:\work\**  intermediates stay here     │ │
│  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

| | |
|---|---|
| **Status** | 0.10.1 —— task delegation, real self-check, two-way file transfer, desktop screenshots and background agent management; CI covers Windows / macOS / Linux |
| **DSH** | Desktop / CLI, verified on 0.2.0-rc.2 |
| **Platforms** | Windows (fully verified) · Linux / macOS (CI covered) |
| **Dependencies** | **Zero external npm dependencies** —— `node:` built-ins only |
| **Node** | `^22.19.0 \|\| >=24.0.0` |
| **Tests** | 987 (985 pass / 2 skip) · 123 doc-drift assertions · eslint strict |

**Web panel**（sidebar → "远程同事" / Remote co-worker）：node list with CPU /
memory badges, task dispatch, task states, result summaries, workspace changes,
change diffs (unified diffs of text-file edits), final artifacts, log tail,
**environment health-check**, **workspace sharing (SMB)**, model dropdown.

> **Works out of the box**: restart DSH after install and the bundled patch
> defaults `role: auto` (no `hubUrl` ⇒ hub), which takes effect automatically.
>
> **Workers connect to the plugin's own port — no DSH config to touch.**
> Since 0.9.3 the plugin runs its own listener (default **19387**) that workers
> dial directly; it does **not** go through `webserver`, so you never edit a
> `host` in `cordis.patch.yml`.
>
> The bind address is chosen automatically: `listenHost` (if set) > Tailscale
> IP > LAN IP > loopback. Set `listenHost: '100.x.x.x'` to pin it.
> **`0.0.0.0` is always rejected** (newer DSH refuses wildcard addresses —
> binding one crashes DSH on startup). See *Install* below.

<p align="center">
  <img src="docs/screenshots/panel-main.png" width="720" alt="Web panel: nodes, dispatch form, task list">
</p>

<p align="center">
  <img src="docs/screenshots/panel-task-detail.png" width="720" alt="Task detail: summary, workspace changes, final artifacts">
</p>

---

## Up and running in five minutes

Pick one route based on how comfortable you are with a terminal — **every route
leads to the same endpoint**:

| Route | Hub | Worker | For |
|---|---|---|---|
| **① Zero terminal**（Windows） | Double-click `bin/setup.cmd` → Enter → Web panel "副机接入" copies the pairing code | Double-click the same file → paste the pairing code → Enter writes config | Anyone who flinches at a black window |
| **② Wizard**（recommended） | Run the wizard in a terminal → Enter to confirm | Same, paste the pairing code | You can open a terminal |
| **③ Manual** | Hand-write config per the section below | Hand-write (`inject: []` is mandatory) | You want full control |

After any route: **restart DSH on both machines**, then ask the hub
"which nodes are online on the worker?" —— if it answers, you're connected.
When something breaks, run `--doctor`; every ✗ item ships with a fix.

```bash
node bin/dsh-remote-setup.js
```

> **Windows, no terminal?** In the plugin's `bin/` directory **double-click
> `setup.cmd`** —— then just keep pressing Enter in the window
> that opens.
> The plugin lives at `%USERPROFILE%\.dsh\dsh_orb\dsh-plugin\dsh-remote-agent\bin\`.

1. **Run on the hub**: choose "1 = hub" → the wizard auto-detects the LAN IP,
   generates a strong-random `nt_` `nodeToken`, and prints the **worker
   pairing code** (one line, `dshra1://…`) plus complete YAML for both machines
   (including the **firewall allow command**).
2. **Run on the worker**: choose "2 = worker" → **paste the pairing code the
   hub gave you** (or type the address and token by hand) → the wizard
   **probes the hub port first**, then writes the worker config. The
   error-prone `inject: []` is filled in for you (without it the worker stays
   silent forever and never comes online). The worker config may also be just
   one line `pair: '<pairing code>'`, expanded to address + token at runtime
   (explicit config wins; writing `hubUrl:` overrides it temporarily).
3. Restart DSH on both machines, ask the hub "**which nodes are online on the
   worker?**" —— an answer means you're connected.
4. **Terminal-free path (GUI)**: open the hub's Web panel → the "**副机接入**"
   (worker onboarding) button → generates and copies the pairing code in one
   click (firewall command included). When dispatching from the hub panel you
   can also set the model the worker should use in the "模型" (model) field
   (leave empty for the worker's default).
5. When in doubt, run the doctor (reads your config files, checks each item,
   every ✗ comes with a fix):

```bash
node bin/dsh-remote-setup.js --doctor your-config.yml
```

Not interactive? One command does it all: `--role worker --hub-url
192.168.1.10:19387 --token nt_xxx --roots D:\work --node-id slave-pc`.

---

## Features

### 1. Dispatch tasks to the worker

| Feature | What it does |
|---|---|
| **Two task modes** | `exec` runs a command directly (`npm run build`, `git pull`, bulk renames in `D:\work`); `agent` spins up an **independent agent session** on the worker that plans, calls tools and writes files itself |
| **Two-phase approval** | `exec` is held for confirmation by default (`approval: 'manual'`) — nothing runs until a human approves. Guards against an AI dispatching a destructive command |
| **Dry-run preview** | See which node it routes to, which model, which directory, what artifacts to expect — without dispatching |
| **Repo-aware routing** | Workers report git repos under their `roots`; `remote_task({repo: 'my-project'})` finds the worker that has it |
| **Load-aware routing** | Workers report CPU/memory/load every 30s; omitting `node` picks the least loaded |
| **Model selection** | Panel offers a dropdown of the worker's **self-reported model list** (no guessing provider/model names); headless backends that can't take a model are **rejected before dispatch** |
| **Per-mode timeouts** | `exec` defaults to 10 minutes (a runaway command shouldn't hold a machine for an hour); `agent` defaults to 1 hour |
| **Concurrency cap** | Worker `maxConcurrent` (default 4); excess tasks queue, `remote_status` shows queue depth and oldest wait |

### 2. Get results without moving the whole workspace

| Feature | What it does |
|---|---|
| **Handoff card** | A task returns one card: summary + workspace changes + artifact manifest + exit code. **Not** the whole directory |
| **Three-way artifact classification** | Files are `final` / `intermediate` / `other`; **only `final` can be pulled**. Logs, caches, `node_modules` stay on the worker |
| **Explicit pull** | Pull individual files with `remote_pull`, glob filters supported |
| **Resume on interruption** | A pull that drops mid-way doesn't restart: received bytes are kept and the retry continues from `startOffset` with `prefixSha256` verification |
| **Change diff view** | Compares the workspace before/after, showing exactly which files changed and by how many bytes |

### 3. Browse the worker's files directly (without touching the task queue)

Four **read-only** tools over a separate `fs/req`↔`fs/res` frame — **they bypass the
task queue and don't consume a concurrency slot**. Even when the worker is saturated
with a long task, these answer instantly:

| Tool | Purpose |
|---|---|
| `remote_ls` | List a directory (single level, paginated) |
| `remote_read` | Read a file (text by line range; binaries return metadata only) |
| `remote_grep` | Full-text search **locally** on the worker (pure JS, no process spawn) |
| `remote_tree` | Directory tree summary (scanning happens on the worker; only structure returns) |

Safety: paths must be inside the node's `roots`, `denyPaths` applies, symlinks are
listed but never dereferenced.

### Real self-checks, background agents and session opt-in

`remote_selfcheck` performs real write/read/delete probes in every workspace root,
checks runner capabilities, and actually captures the desktop for `purpose: "gui"`.
It returns structured `checks[]`, `verdict`, `blockingFailures`, and concrete fixes.
New workers are checked again immediately before `remote_task` / subagent dispatch;
a blocked check never enters the queue. Use `precheck: false` to skip explicitly.

`remote_agents` lists tasks, reads one task, or waits for its terminal handoff;
`remote_interrupt` cancels the same task (and in-flight pulls). Optional
`sessionGate: true` makes each chat opt in with `/remote-agent on` before any
`remote_*` tool or `remote-agent` subagent delegation can run; `off` revokes it and `status` reports it. Authorization is
session-scoped, in memory, and fail-closed when no session id is available.

### Large two-way files and desktop screenshots

`remote_file` combines `stat`, `send`, and `fetch`. Files up to **512MiB** move in
**256KiB** chunks with offset reconciliation, full SHA256 verification, `.part`
files and atomic commit. Worker paths remain confined by `roots` / `denyPaths`;
uploads require `confirm: "yes"`, and downloads never overwrite a local file.

`remote_screenshot` captures the full virtual desktop on Windows workers and
returns PNG metadata, a hub-side path and SHA256. Bytes travel over the existing
E2E channel; temporary screenshots have size/count/TTL limits.

### 4. Open the worker's files in your local IDE (SMB share)

The panel's *Workspace sharing* section publishes a worker directory over SMB; the
hub maps it with `net use X: \\worker\dsh-work-...` and you can open it in local VS Code.

> **⚠ This bypasses the plugin's security boundary** (`roots` / `denyPaths` stop
> applying, intermediates and secrets become visible to the hub, and a new
> credential surface appears). Requires **explicit second confirmation**; **read-only
> by default**. Full risk notes: [docs/workspace-share.md](docs/workspace-share.md).

### 5. Diagnose problems yourself

| Feature | What it does |
|---|---|
| **Environment health-check** | One click in the panel checks 8 items: role config, `inject` dependencies, **whether the web server is bound to a reachable address**, port, firewall, `roots` existence, Tailscale, workers online. **Every item comes with a concrete fix**; auto-fixable ones are flagged |
| **Reachability self-check** | At startup, verifies `webServer` isn't bound to loopback — if it is, workers can never connect while the hub side looks perfectly healthy. Logs a clear warning and shows a red banner |
| **Queue health snapshot** | Workers report `queued` / `running` / `maxConcurrent` / oldest wait with each resource frame; both the panel and `remote_nodes` warn when the queue is jammed |
| **"Running" grouping** | Running tasks are pinned on top with **elapsed time** (the only clue for "is it stuck?") |
| **Cancel really aborts** | `remote_cancel` actually terminates the agent loop (not just setting a flag and letting it finish) |
| **Audit log** | Dispatch / cancel / pull / approval all recorded (`~/.dsh-remote-agent/audit.jsonl`, rotated) |

### 6. Disconnects, NAT traversal, security

| Feature | What it does |
|---|---|
| **Disconnects don't kill tasks** | Relay down or hub restarted, the worker keeps running; `task/sync` reconciles on reconnect and **never re-runs completed work** |
| **Two transports** | `direct` (same LAN / Tailscale); `relay` (both behind NAT, needs a VPS) |
| **End-to-end encryption** | In relay mode, business frames use X25519 + AES-256-GCM; the relay only sees routing envelopes |
| **Hub authentication** | Workers verify the hub: persistent ed25519 identity + fingerprint carried in the pairing code, TOFU-pinned on first connect |
| **Credentials never leave the worker** | The protocol carries no model keys; the worker runs its own loop with its own model config |
| **Zero npm dependencies** | `node:` built-ins only, no build step, `lib/` is the artifact |

### Tool reference (24 tools)

| Category | Tools |
|---|---|
| **Nodes** | `remote_nodes` (list + load + queue + model list) |
| **Tasks** | `remote_task` (dispatch + fresh gate) · `remote_status` (progress) · `remote_cancel` / `remote_interrupt` (abort) |
| **Background / health** | `remote_agents` (list / status / wait) · `remote_selfcheck` (real worker probes) |
| **Approval** | `approval: 'manual'` holds the task → approve/reject from the panel or tools |
| **Results** | `remote_handoff` (result card) · `remote_manifest` (artifact list) · `remote_pull` (fetch finals) · `remote_purge` (cleanup) |
| **Read-only files** | `remote_ls` · `remote_read` · `remote_grep` · `remote_tree` |
| **Large files / desktop** | `remote_file` (stat / send / fetch) · `remote_screenshot` (Windows) |

---

## Core invariants

These are the design premises of this package — read them before changing it:

| Invariant | Meaning |
|---|---|
| **Credentials never leave the worker** | The protocol carries no model keys; the worker uses its own model config |
| **Disconnects don't kill tasks** | Tasks keep running locally on the worker; even a relay outage finishes, and reconciliation happens on reconnect |
| **The relay sees only ciphertext** | In relay mode, business frames are end-to-end encrypted (X25519 + AES-256-GCM, see [SECURITY.md](SECURITY.md)): the relay only sees the routing envelope (`t`/`id`/`to`/`from`); goals and artifact contents are all ciphertext |
| **Manifest before bytes** | On completion only the manifest + handoff come back; artifacts transfer only via `remote_pull` |
| **Only `role:final` crosses the wire** | Logs / caches / intermediate build files stay on the worker; only metadata is reported |
| **Resumable transfer** | If `remote_pull` drops mid-transfer, it does not restart from zero: received bytes are kept, retries resume from the offset, full sha256 verification still applies |

---

## Install

### From npm or GitHub

```bash
# via DSH's plugin installer (GitHub)
dsh plugin add github:zbzbhs/dsh-remote-agent

# or via npm
npm install -g dsh-remote-agent
```

Or type `github:zbzbhs/dsh-remote-agent` into DSH's plugin dialog.

After installing, make sure this stanza exists in `cordis.patch.yml` (the
in-package patch inserts it automatically):

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: ['webServer', 'tools', 'systemPrompt']
  config:
    role: hub
```

**No `webserver` tuning needed.** The plugin listens on its own port (default
`19387`) and workers dial that, so the DSH web server's bind address is
irrelevant. Optional overrides:

```yaml
  config:
    role: hub
    listenHost: '100.x.x.x'   # optional: blank = auto (Tailscale > LAN > loopback)
    listenPort: 19387         # optional: default 19387; 0 = disable the listener
```

> **Security policy: no token, no network exposure.** With an empty
> `nodeToken` the listener binds `127.0.0.1` only (same-machine `both` mode
> still works) and the panel shows a **yellow** banner pointing at
> “生成口令”. Generate one and restart DSH to get the reachable address back.
> To override deliberately, set a concrete non-loopback `listenHost`.

### Worker

**Same package, different config** —— the key point is that **`inject: []` is
mandatory**:

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: []                    # ← mandatory on the worker, or it never activates (see below)
  config:
    role: worker
    nodeId: slave-pc
    transportMode: direct
    hubUrl: 'ws://<hub-host>:19387/api/remote-agent/node'
    token: '<same as the hub's nodeToken, or leave empty>'
    roots: ['D:\work']          # ← change to a real directory on the worker
```

**Typing addresses is error-prone? Use the pairing code** —— the hub wizard
prints one line `dshra1://…` (address + token inside). On the worker, replace
the `transportMode/hubUrl/token` lines with a single line:

```yaml
  config:
    role: worker
    pair: 'dshra1://eyJ2IjoxLC…'   # ← the full line printed by the hub wizard
    roots: ['D:\work']
```

> **Two rules about the pairing code**
>
> 1. **It contains the token, so it IS a credential** —— hand it over in
>    person or via encrypted chat; never paste it into public channels.
> 2. **`roots` is not part of the pairing code** —— which directories the
>    worker may touch is the worker's own security boundary, always declared
>    by the worker config; nothing on the hub side can decide it.
>
> Explicit config wins: when `pair` and `hubUrl` both exist, `hubUrl` applies —
> handy for temporarily switching addresses while debugging. A broken pairing
> code never prevents the worker from starting —— it logs one warning and is
> treated as unconfigured (`--doctor` will flag it).

> **Hub identity verification (on by default)**: the worker verifies the hub
> too. On first start the hub generates a persistent identity (fingerprint
> `hubfp1-…`, stored at `~/.dsh-remote-agent/hub-identity.json`); the pairing
> code carries the fingerprint automatically —— pasting it pins the hub on
> first connect (TOFU, state in the worker's
> `~/.dsh-remote-agent/hub-pin.json`). Manual config can pin explicitly with
> `pinnedHubFingerprint: hubfp1-…`; from then on a fingerprint mismatch means
> the worker refuses to come online and stops reconnecting (if you deliberately
> swapped hubs, delete `hub-pin.json` and restart to re-pin).
> See [SECURITY.md](SECURITY.md) checklist item 7.

> **Why the worker needs `inject: []`**
>
> The in-package `cordis.patch.yml` declares
> `inject: ['webServer','tools','systemPrompt']` —— those are the services the
> **hub** needs. The worker profile doesn't have them, so without clearing the
> line it would sit in **PENDING** and **never activate**, and the worker would
> never dial in. The loader overrides by id, so writing `inject: []` overrides
> the in-package declaration.

**Connectivity paths**（both behind NAT / one side has a public IP / tunnels）
are covered in **[profiles/README.md](profiles/README.md)** —— it has config
snippets and verification commands for every path, plus a **fallback chain**:
direct when possible, otherwise fall back to a relay VPS or a cloudflared
tunnel; if the whole chain is down the worker keeps running locally and
reconciles on reconnect. The relay VPS deployment template (TLS-ready) lives in
[deploy/relay-vps/](deploy/relay-vps/). In relay mode business frames travel
**end-to-end encrypted** (the relay sees only ciphertext; plaintext goals and
artifacts never cross it; the handshake is initiated by the worker and falls
back to plaintext compatibility after a 5 s timeout with legacy relays).
Security boundaries and known limitations: [SECURITY.md](SECURITY.md).

---

## Usage

Once installed you **don't need to memorize commands** — just talk:

| You say | The agent calls |
|---|---|
| "Which nodes are online on the worker?" | `remote_nodes` |
| "Have the worker run the tests in D:\work" | `remote_task` |
| "How is that task going?" | `remote_status` |
| "Give me a summary" | `remote_handoff` |
| "What artifacts are there?" | `remote_manifest` |
| "Pull report.pdf over" | `remote_pull` |
| "Cancel that task" | `remote_cancel` |
| "List what's in D:\BigData on the worker" | `remote_ls` |
| "Read that config.json on the worker" | `remote_read` |
| "Search the worker's 50GB folder for this term" | `remote_grep` |
| "What does that folder on the worker look like?" | `remote_tree` |

There is also a Web panel (sidebar → "远程同事"): node list (with CPU / memory
/ load badges), task dispatch, task states, result summaries, workspace
changes, change diffs, final artifacts, log tail.

> **Queue starvation has an alarm** (defense added after a real incident on
> 2026-10-17): every 30s the worker reports queue health along with resource
> telemetry (queued / running / longest wait). When "tasks are queued AND all
> concurrency slots are busy AND the oldest has waited over 2 minutes",
> `remote_nodes` shows a ⚠ starvation warning on that node with the suggested
> next step (remote_status to inspect, remote_cancel to free a slot). The
> default concurrency is raised 2 → 4 and the default exec timeout tightened
> from 1 hour to 10 minutes — a single slow command can no longer easily lock
> up the whole worker.

### Tool reference

<details>
<summary><code>remote_task</code> parameters</summary>

| Parameter | Meaning |
|---|---|
| `goal` | Task brief. In `mode=agent` this is the task statement for the worker's agent; in `mode=exec` it is the command to run |
| `node` | Target node id. When omitted, auto-routed: with multiple nodes the least-loaded one wins (running tasks → CPU → memory; agent mode only considers agent-capable nodes) |
| `repo` | Route by repository: pass a repo name, remote-URL fragment, or local path fragment — the task goes to a node that holds that repo (load-aware when several do). When `workspace` is omitted, the repo's local path is used automatically. Workers scan git repos under their `roots` after connecting (zero subprocess, credentials stripped locally, refreshed every 10 minutes) |
| `approval` | Two-phase approval: `manual` = hub holds the task until approved in the panel (auto-rejected on timeout, fail-closed); `auto` = dispatch immediately. Defaults: **exec → manual, agent → auto** |
| `dryRun` | Preview only: returns which node/workspace/mode would be used, computed by the exact same routing + validation as a real dispatch |
| `precheck` | Refresh the worker self-check immediately before dispatch. Defaults on for nodes advertising `selfcheck`; set `false` to skip explicitly |
| `workspace` | Absolute path on the worker, must be inside the node's `roots`. Defaults when omitted |
| `mode` | `agent` (worker starts an independent agent session, default) / `exec` (run a command directly) |
| `model` | Optional. Model the worker should use (`mode=agent` only): `{model:"deepseek-chat"}` or `{provider:"openai",model:"gpt-4o"}`. Selection only, no credentials. **Not supported on headless backends** (rejected before dispatch; the worker then uses its default model). `dryRun` echoes the resolved model and its source; the worker's default model is shown by `remote_nodes` |
| `outputs` | Glob of expected outputs (relative to the workspace), used to filter the artifact manifest |
| `timeoutMs` | Worker-side timeout. Defaults by mode: **exec 10 minutes, agent 1 hour** (one slow exec should not pin the worker for an hour) |
| `denyPaths` | Extra absolute paths to deny |
| `artifactRules` | Override built-in artifact role classification, e.g. `{ intermediate: ["build/**"] }` |

**`exec` mode runs PowerShell on Windows workers** —— separate commands with
`;`, not `&` (rejected). For cmd syntax, use `cmd /c "..."` explicitly.

</details>

### Reading files on the worker (no network drive needed)

Four read-only file tools (`remote_ls` / `remote_read` / `remote_grep` /
`remote_tree`) work out of the box: the AI can list directories, read files,
run full-text search, and inspect folder structure — **no network share, no
mount, no SMB setup**. Scan-type operations (grep/tree) run locally on the
worker and only the results cross the wire — a 50GB folder never moves.

<details>
<summary>File tool parameters and boundaries</summary>

| Tool | Parameters | Meaning |
|---|---|---|
| `remote_ls` | `path` (required), `limit`, `offset` | List a directory (single level, paged, directories first) |
| `remote_read` | `path` (required), `offset`, `limit` | Text files ≤8MB are paged line by line (≤256KB per response); binaries return only sha256 + size + hex head preview |
| `remote_grep` | `path`, `pattern` (required), `glob`, `regex`, `ignoreCase`, `maxMatches` | Full-text search on the worker (pure JS, no external grep spawned); caps: 2000 files / 2MB per file / 200 matches / 10 s |
| `remote_tree` | `path` (required), `depth` | Directory-tree summary (depth 1-6, default 3; ≤2000 entries) |

**Boundaries (same bottom line as the task pipeline)**: read-only — the module
has no write verb; paths must be absolute and inside the node's `roots`,
anything else is rejected (`workspace-denied`); `denyPaths` applies too (denied
entries are not even reported by name); symbolic links are listed but never
followed. File operations travel on a dedicated `fs/req`↔`fs/res` channel —
**they never enter the task queue or occupy concurrency slots** — and under
relay mode they are **end-to-end encrypted** like task frames (the relay sees
ciphertext only).

**Combining with manual setups**: for "AI looks up / searches a file" use
these tools (zero config, works across NATs); for "browse huge media files
like a local drive" SMB/network drives remain the right tool — they
complement each other.

</details>

---

## Security

**This plugin lets the hub read/write files and execute commands on another
computer.** Read **[SECURITY.md](SECURITY.md)** before deploying — especially:

1. **`nodeToken` is not verified by default** —— it is **mandatory** for public
   deployments. Leaving it empty is only for fully trusted private networks
   (Tailscale / same machine / trusted LAN).
2. **Transport has no built-in TLS** —— public direct connections must sit
   behind a TLS reverse proxy and use `wss://`.
3. **`roots` is the real security boundary** —— grant only the directories the
   tasks need, never a whole drive or the user home.

---

## Layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Plugin entry (role dispatcher: `role: hub` / `worker` / `both`) |
| `lib/hub/**` | Hub side: node registry, **24 tools**, subagent provider, UI routes, environment health-check |
| `lib/hub/views.js` | **Shared projection layer** —— tools and the UI use the same field whitelist |
| `lib/node/**` | Worker side: dial-in, task engine, artifact service, exec/agent backends |
| `lib/client.js` | Browser half (Web panel) |
| `lib/protocol.js` | Wire protocol (frame types, error codes, `PROTOCOL_VERSION`) |
| `lib/e2e.js` | Relay-link end-to-end encryption (X25519 handshake + ed25519 authentication + AES-256-GCM frame sealing) |
| `lib/setup.js` + `bin/dsh-remote-setup.js` | Beginner wizard (config generation / doctor check / plain-language connect-error translation) |
| `lib/relay.js` + `bin/dsh-remote-relay.js` | Relay (rendezvous point for NAT scenarios) |
| `profiles/**` | Deployment profiles and config snippets |
| `scripts/**` | Relay provisioning (systemd / scheduled task) + quality check scripts |

---

## Development

```bash
npm install     # only to verify the lockfile; zero runtime dependencies
npm run check   # packaging self-consistency + doc drift + all tests
```

**There is no build step.** The `.js` files in `lib/**` are exactly what DSH
loads (pure ESM, no transpilation).

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** before changing code — it documents
several traps that **fail silently** (tool return values crossing the boundary,
cordis lifecycle, why `ctx.get()` is necessary).

> `node --test test/`（directory form）treats the directory as a module entry on
> Node 24 and always fails. Use `npm test`. PowerShell on Windows doesn't
> expand globs — don't pass `test/*.test.js` directly either.

### Quality gates

| Layer | Command | Content |
|---|---|---|
| Packaging | `npm run check:packaging` | every path referenced by `files`/`exports`/`bin`/`dsh.bundle.patch` must exist |
| Doc drift | `npm run check:docs` | 102 assertions pinning key doc ⇄ code conventions |
| Behavior tests | `npm test` | 652 tests |

---

## Known issues

See **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** —— it records things **deliberately
not done**, items **pending verification**, and the debugging methodology.
Highlights:

- The worker `agent` backend doesn't work yet (`exec` does) —— under investigation
- The Windows 8.3 short-name bypass vector is unverified
- POSIX branches lack hands-on platform coverage (CI only)

---

## Changelog

See **[CHANGELOG.md](CHANGELOG.md)** —— includes a **root-cause analysis** for
every fix. During 0.x, `lib/**` is the loaded artifact, so any change may be a
behavior change — read it before upgrading.

---

## License

MIT —— see [LICENSE](LICENSE).
