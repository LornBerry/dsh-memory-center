/**
 * 锚点（可选词条）自测：完全锚点 vs 仅权重。
 *
 *   node dev/anchor.test.mjs
 *
 * 期望：
 *   1. item.create / item.update 接受 anchorMode: 'full' | 'weight' | 'off'，其它值归 'off'。
 *   2. 注入文本里「完全锚点」与「权重锚点」各自带标记，且顶部有锚点规则说明。
 *   3. 把锚点改回 'off' 后，下一次注入不再带标记。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-anchor-'))
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

let handler = null
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
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}

const mod = await import(`../index.js?w=${Date.now()}`)
mod.apply(ctx)
if (typeof handler !== 'function') throw new Error('路由没有注册')

async function call(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, op: payload.op }), 'utf8')
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      text = String(chunk ?? '')
    },
  }
  await handler(req, res)
  return { status, body: JSON.parse(text || '{}') }
}

async function injectOnce(sessionId) {
  const decision = await hooks.get('agent/pre-step')(
    { agent: { session: { header: { id: sessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [{ id: 'u-1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }],
    }),
  )
  const last = decision.messages[decision.messages.length - 1]
  return last.content.map((part) => part.text ?? '').join('')
}

const full = await call({ op: 'item.create', title: '完全规矩', body: '必须用中文回答', anchorMode: 'full' })
expect('create full 成功', full.status, (v) => v === 200, '应 200')
const weight = await call({ op: 'item.create', title: '语气偏好', body: '偏好简短回答', anchorMode: 'weight' })
expect('create weight 成功', weight.status, (v) => v === 200, '应 200')

const s = await call({ op: 'state' })
const items = s.body.items
expect(
  '快照里带 anchorMode',
  items.map((item) => `${item.title}:${item.anchorMode}`),
  (v) => v.includes('完全规矩:full') && v.includes('语气偏好:weight'),
  '应原样返回',
)

const fullItem = items.find((item) => item.title === '完全规矩')
const weightItem = items.find((item) => item.title === '语气偏好')
const ids = [fullItem.id, weightItem.id]
await call({ op: 'item.confirm', ids })
await call({ op: 'session.set', sessionId: 's1', mode: 'all', groupIds: [] })

const text = await injectOnce('s1')
expect('注入带锚点规则说明', text, (v) => v.includes('锚点：') && v.includes('可偏离'), '顶部应有说明')
expect('完全锚点标记', text, (v) => v.includes('〔完全锚点〕**完全规矩**'), '应带完全标记')
expect('权重锚点标记', text, (v) => v.includes('〔权重锚点〕**语气偏好**'), '应带权重标记')

const off = await call({ op: 'item.update', id: weightItem.id, patch: { anchorMode: 'off' } })
expect('update off 成功', off.status, (v) => v === 200, '应 200')
/* 让 lastInjected 失效：换一条不同的注入输入，确保重新注入 */
const text2 = await injectOnce('s1')
expect('off 后不再带权重标记', text2, (v) => !v.includes('〔权重锚点〕**语气偏好**'), '不应再出现权重标记')
expect('完全锚点仍在', text2, (v) => v.includes('〔完全锚点〕**完全规矩**'), '完全锚点不应被误删')

const bad = await call({ op: 'item.update', id: fullItem.id, patch: { anchorMode: 'bogus' } })
expect('非法值归 off', bad.status, (v) => v === 200, '应 200')
const s2 = await call({ op: 'state' })
expect(
  '非法值落库为 off',
  s2.body.items.find((item) => item.id === fullItem.id)?.anchorMode,
  (v) => v === 'off',
  "应归一为 'off'",
)

await fs.rm(tmpRoot, { recursive: true, force: true })
console.log(failures.length ? `\nANCHOR FAILED: ${failures.join(', ')}` : '\nANCHOR OK')
process.exit(failures.length ? 1 : 0)
