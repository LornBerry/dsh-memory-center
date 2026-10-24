/**
 * 快照契约：state 只给摘要，不给整库正文。
 *
 *   node dev/snapshot-shape.test.mjs
 *
 * 这个文件是「函数写了但没接线」那类漏水的护栏：v0.10.0 加了 slimItem，
 * 但 snapshot 里忘了 .map(slimItem)，运行时快照照样传完整 body。行为测试
 * （能显示、能搜到）全绿，只有断言契约能抓住。全程用临时目录。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-snapshot-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG

const now = new Date().toISOString()
const longBody = `${'甲'.repeat(300)}结尾标记`
await fs.writeFile(
  path.join(tmpRoot, 'store.json'),
  JSON.stringify({
    version: 1,
    updatedAt: now,
    groups: [{ id: 'g-1', name: '约定', order: 0, createdAt: now }],
    items: [
      {
        id: 'm-long',
        title: '长条目',
        body: longBody,
        tags: ['标签'],
        groupId: 'g-1',
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'manual',
        order: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'm-short',
        title: '短条目',
        body: '很短',
        tags: [],
        groupId: null,
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'manual',
        order: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    deleted: [],
  }),
  'utf8',
)

const failures = []
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) console.log(`ok   ${label}`)
  else {
    failures.push(label)
    console.log(`FAIL ${label}${hint ? `  (${hint})` : ''}`)
  }
}

let handler = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx)
  },
  on() {},
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}

const mod = await import(`../index.js?snapshot=${Date.now()}`)
mod.apply(ctx)

async function call(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
  let out = ''
  const res = {
    writeHead() {},
    end(chunk) {
      out = String(chunk ?? '')
    },
  }
  await handler(req, res)
  return JSON.parse(out || '{}')
}

const snapshot = await call({ op: 'state' })
expect('快照里有两条', snapshot.items.length, (v) => v === 2, JSON.stringify(snapshot.items?.length))
expect(
  '快照条目都不带 body',
  snapshot.items.every((item) => item.body === undefined),
  (v) => v === true,
  'slimItem 没接上：state 仍在传完整正文',
)
expect(
  '快照条目都有 excerpt',
  snapshot.items.every((item) => typeof item.excerpt === 'string'),
  (v) => v === true,
  '缺 excerpt',
)
expect(
  '快照条目都有 bodyChars',
  snapshot.items.every((item) => Number.isFinite(item.bodyChars)),
  (v) => v === true,
  '缺 bodyChars',
)

const long = snapshot.items.find((item) => item.id === 'm-long')
expect('长条目 bodyChars 是真长度', long.bodyChars, (v) => v === longBody.length, String(long.bodyChars))
expect('长条目 excerpt 被截断', long.excerpt.length, (v) => v <= 121, String(long.excerpt.length))
expect(
  'excerpt 是正文前缀',
  longBody.startsWith(long.excerpt.replace(/…$/, '')),
  (v) => v === true,
  '摘要是从中间截的',
)

const full = await call({ op: 'item.get', id: 'm-long' })
expect('item.get 能拿到完整正文', full.item && full.item.body, (v) => v === longBody, '正文没回来')

const short = snapshot.items.find((item) => item.id === 'm-short')
expect('短条目 excerpt 就是原文', short.excerpt, (v) => v === '很短', String(short.excerpt))

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(failures.length ? `\nSNAPSHOT SHAPE FAILED: ${failures.join(', ')}\n` : '\nSNAPSHOT SHAPE OK\n')
process.exit(failures.length ? 1 : 0)
