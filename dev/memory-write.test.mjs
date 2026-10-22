/**
 * 同一会话第 2 条记忆自动归入「会话标题」文件夹（仍待确认）。
 *
 *   node dev/memory-write.test.mjs
 *
 * 期望：
 *   1. 会话第 1 条：留在「未归类」，返回里写「本会话第 1 条」。
 *   2. 会话第 2 条：两条一起放进「以会话标题命名」的文件夹，状态仍是 pending。
 *   3. 文件夹名来自会话第一条用户消息（截断到 24 字），不是宿主 header。
 *   4. 另一个会话各写一条：互不影响，都不建文件夹。
 *   5. 同名文件夹已存在时复用，不重复创建。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-write-'))
const dir = path.join(tmpRoot, 'store')
await fs.mkdir(dir, { recursive: true })
process.env.DSH_MEMORY_DIR = dir
delete process.env.DSH_MEMORY_CONFIG

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const tools = new Map()
const hooks = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx)
  },
  on(event, fn) {
    hooks.set(event, fn)
  },
  effect(fn) {
    return fn()
  },
  get() {
    return undefined
  },
  webServer: {
    register() {
      return () => {}
    },
  },
  tools: {
    register(def) {
      tools.set(def.name, def)
    },
  },
  systemPrompt: { section() {} },
}

const mod = await import(`../index.js?w=${Date.now()}`)
mod.apply(ctx)

const write = tools.get('memory_write')
if (!write) throw new Error('memory_write 未注册')

function preStep(sessionId, text) {
  return hooks.get('agent/pre-step')(
    { agent: { session: { header: { id: sessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        { id: 'sys-inject', role: 'user', content: [{ type: 'text', text: '注入的记忆文本' }], source: { kind: 'plugin:dsh-memory-center', form: 'recall' } },
        { id: 'u-1', role: 'user', content: [{ type: 'text', text: `  ${text}  ` }], source: { kind: 'user' } },
      ],
    }),
  )
}

function sessionExec(sessionId) {
  return { agent: { session: { header: { id: sessionId } } } }
}

const title = '帮我装 dsh-market 插件'

await preStep('s1', title)
const first = await write.execute({ title: '会话一第一条', body: '内容一' }, sessionExec('s1'))
expect('第 1 条不在文件夹', first, (v) => v.includes('未归类'), '第一条应留在未归类')
expect('第 1 条带序号', first, (v) => v.includes('本会话第 1 条'), '应提示本会话第几条')

const second = await write.execute({ title: '会话一第二条', body: '内容二' }, sessionExec('s1'))
expect('第 2 条进会话文件夹', second, (v) => v.includes(`文件夹「${title}」`), '应按会话标题建文件夹')
expect('第 2 条带序号', second, (v) => v.includes('本会话第 2 条'), '应提示本会话第几条')

await preStep('s2', '另一个会话')
const other1 = await write.execute({ title: '会话二第一条', body: '内容三' }, sessionExec('s2'))
expect('另一会话第 1 条仍不建文件夹', other1, (v) => v.includes('未归类'), '每个会话单独计数')

const store = JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8'))
const s1Items = store.items.filter((item) => item.sessionId === 's1')
expect('会话一两条都已归档', s1Items.length, (v) => v === 2, '应有两条')
expect(
  '两条同一文件夹且仍是待确认',
  s1Items.map((item) => `${item.groupId}|${item.status}`),
  (v) => v.length === 2 && v[0] === v[1] && v[0].endsWith('|pending') && v[0] !== 'null|pending',
  '应同组、status=pending',
)
const group = store.groups.find((entry) => entry.id === s1Items[0].groupId)
expect('文件夹名 = 会话标题', group?.name, (v) => v === title, '名字应来自第一条用户消息')
expect(
  '另一会话的条目未被牵连',
  store.items.filter((item) => item.sessionId === 's2').map((item) => item.groupId),
  (v) => v.length === 1 && v[0] === null,
  's2 不应进 s1 的文件夹',
)

/* 同名文件夹已存在时复用：第三、四条继续进同一个文件夹，不新建 */
await write.execute({ title: '会话一第三条', body: '内容四' }, sessionExec('s1'))
const after = JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8'))
expect('复用同名文件夹', after.groups.filter((entry) => entry.name === title).length, (v) => v === 1, '不应重复建组')
expect('第三条也进组', after.items.filter((item) => item.sessionId === 's1' && item.groupId === group.id).length, (v) => v === 3, '应连同前两条')

await fs.rm(tmpRoot, { recursive: true, force: true })
console.log(failures.length ? `\nMEMORY WRITE FAILED: ${failures.join(', ')}` : '\nMEMORY WRITE OK')
process.exit(failures.length ? 1 : 0)
