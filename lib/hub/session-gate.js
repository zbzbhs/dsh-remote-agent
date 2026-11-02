/**
 * 会话级远程能力门禁。
 *
 * 默认不启用（向后兼容）；配置 sessionGate:true 后，remote_* 工具在每个
 * 会话里默认关闭，用户输入 /remote-agent on 才打开。状态只保存在内存，
 * 会话结束或 DSH 重启后自然失效，不把授权散落到配置文件。
 */

const COMMAND_NAMES = Object.freeze(['remote-agent', 'remote-use'])

export function createSessionGate({ required = false } = {}) {
  const enabled = new Set()

  const idOf = (agent) => {
    const id = agent?.id
    return typeof id === 'string' && id !== '' ? id : ''
  }
  const isEnabled = (agent) => !required || enabled.has(idOf(agent))
  const set = (agent, value) => {
    const id = idOf(agent)
    if (!id) return false
    if (value) enabled.add(id)
    else enabled.delete(id)
    return true
  }

  return {
    required,
    isEnabled,
    enable: (agent) => set(agent, true),
    disable: (agent) => set(agent, false),
    /** tools.guard 契约：返回字符串即拒绝；不拦截非本插件工具。 */
    guard(execution) {
      const name = typeof execution?.name === 'string' ? execution.name : ''
      if (!name.startsWith('remote_') || isEnabled(execution?.agent)) return undefined
      return '远程能力在此会话默认关闭。请先输入 /remote-agent on，再重试；用 /remote-agent off 可关闭。'
    },
    /** commands.register 契约：同一处理器注册 remote-agent 与 remote-use 两个别名。 */
    commands() {
      if (!required) return []
      return COMMAND_NAMES.map((name) => ({
        name,
        description: '开关当前会话的远程副机工具（on / off / status）',
        input: { hint: 'on | off | status' },
        handler: ({ agent, rawInput }) => {
          const action = String(rawInput ?? '').trim().toLowerCase() || 'status'
          if (action === 'on') {
            if (!set(agent, true)) return { kind: 'error', text: '无法识别当前会话，远程能力仍保持关闭。' }
            return { kind: 'success', text: '已为当前会话开启 remote_* 工具。用 /remote-agent off 关闭。' }
          }
          if (action === 'off') {
            set(agent, false)
            return { kind: 'success', text: '已关闭当前会话的 remote_* 工具。' }
          }
          if (action === 'status') {
            return { kind: 'success', text: `当前会话远程能力：${isEnabled(agent) ? '已开启' : '已关闭'}。` }
          }
          return { kind: 'error', text: '用法：/remote-agent on、/remote-agent off 或 /remote-agent status。' }
        },
      }))
    },
  }
}
