/**
 * 用真实会话回放增量注入：统计全量 / 增量 / 无变化各多少次、注入了多少字符，
 * 以及「宿主压缩把注入消息裁掉」之后是否退回全量。不断言、只报数。
 *
 * 用法：
 *   node dev/bench-replay.mjs
 *   node dev/bench-replay.mjs --turns 795 --keep 6 --memories 60 --compact-every 159
 *   node dev/bench-replay.mjs --json E:/replay-real-session.json --compact
 *
 * 回放用的用户消息来自 json 的 turns（只取文本，不复制整个文件进仓库）。
 * 没有 json 时用合成消息，只验证行为不验证真实分布。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const TURNS = Number(argOf('turns', 795))
const KEEP_INJECTS = Number(argOf('keep', 6))
const MEMORIES = Number(argOf('memories', 60))
const COMPACT_EVERY = Number(argOf('compact-every', 159))
const JSON_PATH = argOf('json', '')
const SESSION_ID = 'replay-bench'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-replay-'))
const dataDir = path.join(tmpRoot, 'memory')
await fs.mkdir(dataDir, { recursive: true })
const pointer = path.join(tmpRoot, 'pointer.json')
await fs.writeFile(pointer, JSON.stringify({ dataDir }), 'utf8')
process.env.DSH_MEMORY_DIR = dataDir
process.env.DSH_MEMORY_CONFIG = pointer
process.env.DSH_MEMORY_MAX_CHARS = '12000'

// 60 条记忆：3 条完全锚点（长正文）、其余递增长度，模拟「有锚点也有普通条目」
const body = (n, len) => `${'第' + n + '条：'}${'这是回放用的记忆正文，'.repeat(Math.ceil(len / 12)).slice(0, len)}`
const store = {
  version: 3,
  updatedAt: new Date().toISOString(),
  groups: [{ id: 'g-bench', name: '回放', order: 0 }],
  items: Array.from({ length: MEMORIES }, (_, index) => ({
    id: `m-${index + 1}`,
    title: `记忆 ${index + 1}`,
    body: body(index + 1, index < 3 ? 5000 : 300 + (index % 5) * 120),
    status: 'active',
    enabled: true,
    pinned: false,
    anchorMode: index < 3 ? 'full' : 'auto',
    groupId: 'g-bench',
    tags: index % 4 === 0 ? ['回放'] : [],
    order: index,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  deleted: [],
}
await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify(store, null, 2), 'utf8')

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
  console.error(`FAIL 插件没有注册 /dsh-memory/api 或 agent/pre-step（handler=${Boolean(handler)} preStep=${Boolean(preStep)}）`)
  process.exit(1)
}

async function call(payload) {
  const bodyText = JSON.stringify({ sessionId: SESSION_ID, ...payload })
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

// 会话选择默认为空（不加载），回放要模拟“用户把记忆全开”的场景。
const setRes = await call({ op: 'session.set', sessionId: SESSION_ID, mode: 'all' })
console.log(`诊断：session.set = ${JSON.stringify(setRes).slice(0, 200)}`)
{
  const boot = await call({ op: 'state', sessionId: SESSION_ID })
  console.log(
    `诊断：items=${(boot.items || []).length} groups=${(boot.groups || []).length} selection=${JSON.stringify(boot.selection)}`,
  )
}

const decisionFor = (messages) => ({ kind: 'enter', messages })

const stats = { full: 0, delta: 0, unchanged: 0, fullChars: 0, deltaChars: 0, deltaSizes: [], compacts: 0, afterCompactFull: 0 }
const marks = { snapshots: new Set(), revs: new Set() }
let messages = []

const userTurns = []
if (JSON_PATH) {
  const raw = await fs.readFile(JSON_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  for (const turn of parsed.turns ?? []) {
    if (turn && turn.kind === 'msg' && turn.role === 'user' && typeof turn.text === 'string') {
      userTurns.push(turn.text.replace(/\s+/g, ' ').slice(0, 400))
    }
  }
}

for (let turn = 0; turn < TURNS; turn += 1) {
  if (turn % 10 === 0) {
    const target = store.items[turn % MEMORIES]
    await call({ op: 'item.update', id: target.id, patch: { body: `${target.body}（第 ${turn} 轮改动）` } })
  }
  if (turn % 25 === 0) {
    await call({ op: 'item.create', title: `回放新增 ${turn}`, body: `第 ${turn} 轮新增的记忆`, groupId: 'g-bench' })
  }
  const text = userTurns.length ? userTurns[turn % userTurns.length] : `第 ${turn} 轮：继续`
  messages.push({ id: `u-${turn}`, role: 'user', content: [{ type: 'text', text }] })

  if (COMPACT_EVERY > 0 && turn > 0 && turn % COMPACT_EVERY === 0) {
    // 宿主压缩：注入消息只保留最新 KEEP_INJECTS 条，普通消息只留最近 20 条
    const injects = messages.filter((message) => message?.source?.kind?.startsWith('plugin:'))
    const keepIds = new Set(injects.slice(-KEEP_INJECTS).map((message) => message.id))
    messages = messages.filter(
      (message) => !message?.source?.kind?.startsWith('plugin:') || keepIds.has(message.id),
    )
    const plain = messages.filter((message) => !message?.source?.kind?.startsWith('plugin:'))
    const plainKeep = new Set(plain.slice(-20).map((message) => message.id))
    messages = messages.filter(
      (message) => message?.source?.kind?.startsWith('plugin:') || plainKeep.has(message.id),
    )
    stats.compacts += 1
  }

  const out = await preStep(
    { agent: { session: { header: { id: SESSION_ID } } }, signal: { aborted: false } },
    async () => decisionFor(messages),
  )
  const injected = out && Array.isArray(out.messages) ? out.messages[out.messages.length - 1] : null
  const isNew = Boolean(injected && injected.source?.form === 'recall')
  if (isNew) {
    messages.push(injected)
    const text = injected.content?.[0]?.text ?? ''
    if (text.startsWith('〔记忆快照')) {
      stats.full += 1
      stats.fullChars += text.length
      if (stats.compacts > 0 && turn % COMPACT_EVERY === 0) stats.afterCompactFull += 1
    } else if (text.startsWith('〔记忆更新')) {
      stats.delta += 1
      stats.deltaChars += text.length
      stats.deltaSizes.push(text.length)
    }
  } else {
    stats.unchanged += 1
  }
}

const median = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const total = stats.fullChars + stats.deltaChars
console.log(`回放 ${TURNS} 轮（${MEMORIES} 条记忆，压缩 ${stats.compacts} 次，保留注入 ${KEEP_INJECTS} 条）`)
console.log(`  全量 ${stats.full} 次，共 ${stats.fullChars} 字符`)
console.log(`  增量 ${stats.delta} 次，共 ${stats.deltaChars} 字符（中位 ${median(stats.deltaSizes)} 字）`)
console.log(`  无变化 ${stats.unchanged} 次`)
console.log(`  注入总量 ${total} 字符，增量占比 ${total ? ((stats.deltaChars / total) * 100).toFixed(1) : 0}%`)
console.log(`  压缩后首轮退回全量 ${stats.afterCompactFull} 次 / 压缩 ${stats.compacts} 次`)
await fs.rm(tmpRoot, { recursive: true, force: true })
