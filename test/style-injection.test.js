/**
 * test/style-injection.test.js
 *
 * 验证 CSS 样式注入机制正确实现。
 *
 * 背景（fork.19 回归根因）：
 *   `styles` 是 dynamic lane 的 builtin，window.__ModuleLoader__ 静态 bundle 里
 *   ctx.get('styles') 返回 undefined → styles.insert 不执行 → 面板无样式。
 *   正确做法是 StyleTag 组件渲染 h('style', { key: 'dra-css' }, CSS)，随组件挂载。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('StyleTag 必须渲染 h(\'style\',...) 元素（不得返回 null）', () => {
  const code = stripComments(CLIENT_SRC)
  // function StyleTag 后 200 字符内必须有 h('style'
  const i = code.indexOf('function StyleTag()')
  assert.ok(i >= 0, '应有 StyleTag 函数')
  const seg = code.slice(i, i + 300)
  assert.match(seg, /h\('style'/, 'StyleTag 必须渲染 <style> 元素——static bundle 里 ctx.get("styles") 为 undefined，只靠 styles.insert CSS 永远不进 DOM')
  assert.does_not_match = undefined  // compatibility shim
  // 确保没有 return null
  assert.ok(!/return null/.test(seg), 'StyleTag 不得 return null（会导致无样式）')
})

test('StyleTag 渲染的 style 元素包含 --dra-accent 等 CSS token', () => {
  // CSS 数组应含 --dra-accent（核心 token）与 .dra-root（根容器）
  assert.match(CLIENT_SRC, /--dra-accent/, 'CSS 数组应包含 --dra-accent token')
  assert.match(CLIENT_SRC, /\.dra-root\{/, 'CSS 应包含 .dra-root 根规则')
})

test('StyleTag 被挂入每个顶层视图（switchRole / worker / setup / hub）', () => {
  const code = stripComments(CLIENT_SRC)
  // Panel 函数内，每个 return h('div', { className: 'dra-root' 之前都要有 h(StyleTag)
  // 用最简单的方法：全文 h(StyleTag) 出现次数 >= 4
  const matches = (code.match(/h\(StyleTag\)/g) || []).length
  assert.ok(matches >= 4, `h(StyleTag) 应出现至少 4 次（当前 ${matches} 次）——每个顶层视图都要挂一份`)
})

test('apply 里保留 styles.insert（动态 lane 兼容）', () => {
  assert.match(CLIENT_SRC, /stylesSvc\.insert\(CSS\)/, 'apply 里应保留 styles.insert(CSS)（动态 lane 仍用此路径）')
})
