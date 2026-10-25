// 增量注入的契约测试：全量 → 增量 → 无变化 → 压缩后回退全量。
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-recall-'))
const dataDir = path.join(tmpRoot, 'memory')
const pointer = path.join(tmpRoot, 'pointer.json')
process.env.DSH_MEMORY_DIR = dataDir
process.env.DSH_MEMORY_MAX_CHARS = '12000'
process.env.DSH_MEMORY_CONFIG = pointer

const SESSION = 'recall-session'
const big = (len, ch) => ch.repeat(len)
const store = {
  version: 3,
  updatedAt: new Date().toISOString(),
  groups: [{ id: 'g-1', name: '回放', order: 0 }],
  items: [
    {
      id: 'm-anchor',
      title: '锚点条目',
      body: big(300, '锚'),
      status: 'active',
      enabled: true,
      pinned: false,
      anchorMode: 'full',
      groupId: 'g-1',
      tags: [],
      order: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'm-normal',
      title: '普通条目',
      body: big(300, '普'),
      status: 'active',
      enabled: true,
      pinned: false,
      anchorMode: 'auto',
      groupId: 'g-1',
      tags: [],
      order: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  deleted: [],
}
await fs.mkdir(dataDir, { recursive: true })
await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify(store, null, 2), 'utf8')
await fs.writeFile(pointer, JSON.stringify({ dataDir }), 'utf8')

let handler = null
let preStep = null
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(fakeCtx)
  },
  tool() {},
  effect(fn) {
    return fn()
  },
  on(event, fn) {
    if (event === 'agent/pre-step') preStep = fn
  },
  get() {},
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}

const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply(fakeCtx)
if (!handler || !preStep) {
  console.error('FAIL 插件没有注册 /dsh-memory/api 或 agent/pre-step')
  process.exit(1)
}

async function call(payload) {
  const bodyText = JSON.stringify({ sessionId: SESSION, ...payload })
  let ended = null
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: Buffer.from(bodyText, 'utf8') }
        },
      }
    },
  }
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code
    },
    end(text) {
      ended = text
    },
  }
  await handler(req, res)
  return JSON.parse(ended)
}

const failures = []
function expect(label, actual, check, hint = '') {
  const ok = Boolean(check)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${hint ? ` = ${hint}` : ''}`)
  if (!ok) failures.push(label)
}

await call({ op: 'session.set', sessionId: SESSION, mode: 'all' })

let messages = []
async function round(sessionId = SESSION, text = '继续') {
  messages.push({ id: `u-${SESSION}-${messages.length}`, role: 'user', content: [{ type: 'text', text }] })
  const out = await preStep(
    { agent: { session: { header: { id: sessionId } } }, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages }),
  )
  const last = out && Array.isArray(out.messages) ? out.messages[out.messages.length - 1] : null
  const injected = last && last.source && last.source.form === 'recall' ? last : null
  if (injected) messages.push(injected)
  return injected ? injected.content?.[0]?.text ?? '' : ''
}

// 1. 首次注入是快照
const first = await round()
expect('首次注入是快照', first.includes('〔记忆快照 #1〕'), true)

// 2. 什么都没改，不再回注入
const quiet = await round()
expect('无变化时不重复注入', quiet === '', true)

// 3. 改普通条目的正文 → 增量，且受 400 字上限约束
await call({ op: 'item.update', id: 'm-normal', patch: { body: big(800, '新') } })
const normalDelta = await round()
expect('改正文发增量标记', normalDelta.includes('〔记忆更新 #2〕'), true)
expect('增量里不含全量快照标记', !normalDelta.includes('〔记忆快照'), true)
expect('普通条目正文按 400 字截断', normalDelta.includes('新'.repeat(400)) && !normalDelta.includes('新'.repeat(401)), true)
expect('截断时有「没展开」提示', normalDelta.includes('没展开'), true)

// 4. 改锚点正文 → 增量，不受 400 字限制（≤ 4000 给全文）
await call({ op: 'item.update', id: 'm-anchor', patch: { body: big(800, '锚') } })
const anchorDelta = await round()
expect('锚点正文不受普通上限约束', anchorDelta.includes('锚'.repeat(800)), true)

// 5. 锚点超过 4000 字 → 带 ANCHOR_FULL_MAX 截断并明确警告
await call({ op: 'item.update', id: 'm-anchor', patch: { body: big(6000, '锚') } })
const hugeAnchor = await round()
expect('锚点超长截到 4000 字', hugeAnchor.includes('锚'.repeat(4000)) && !hugeAnchor.includes('锚'.repeat(4001)), true)
expect('锚点截断给出「先 memory_search」警告', hugeAnchor.includes('没读到全文之前不要照它执行'), true)

// 6. 宿主压缩把老注入都删掉 → 版本链断，下一轮回退全量
messages = messages.slice(-1)
const recovered = await round()
expect('压缩后回退全量', recovered.includes('〔记忆快照 #'), true)

// 7. 新会话从头给快照
messages = []
const otherSession = await round('别的会话', '你好')
expect('新会话首轮给快照', otherSession.includes('〔记忆快照 #1〕'), true)

// 8. snapshot 带 lastInject
const state = await call({ op: 'state', sessionId: SESSION })
expect('state 快照带 lastInject', Boolean(state.lastInject && typeof state.lastInject.chars === 'number'), true)

await fs.rm(tmpRoot, { recursive: true, force: true })
if (failures.length) {
  console.error(`RECALL FAIL：${failures.length} 项未通过`)
  process.exit(1)
}
console.log('RECALL OK')
