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
      {
        id: 'm-emoji',
        title: 'emoji 条目',
        body: `${'🧠'.repeat(130)}尾巴`,
        tags: [],
        groupId: null,
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'manual',
        order: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'm-archived',
        title: '归档条目',
        body: '归档的正文也应该只给摘要，否则归档区越长越占地方',
        tags: [],
        groupId: null,
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'manual',
        order: 2,
        createdAt: now,
        updatedAt: now,
        archivedAt: now,
      },
      {
        id: 'm-deleted',
        title: '回收站条目',
        body: '回收站里的正文也应该只给摘要，用户不会天天清',
        tags: [],
        groupId: null,
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'manual',
        order: 3,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
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
expect('快照里有三条', snapshot.items.length, (v) => v === 3, JSON.stringify(snapshot.items?.length))
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

// 按 UTF-16 码元切会把 emoji 劈成半个代理项，快照里就是乱码方块
const emoji = snapshot.items.find((item) => item.id === 'm-emoji')
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
expect(
  'emoji 摘要没有孤立代理项',
  loneSurrogate.test(emoji.excerpt),
  (v) => v === false,
  'excerpt 按码元切了：emoji 被劈成半个',
)
expect(
  'emoji 摘要按码点截到 120',
  Array.from(emoji.excerpt.replace(/…$/, '')).length,
  (v) => v === 120,
  String(Array.from(emoji.excerpt).length),
)

// 归档区与回收站同样是「只增不减」的部分，一样不能整段传正文
expect('归档视图有一条', snapshot.archived.length, (v) => v === 1, String(snapshot.archived.length))
expect(
  '归档视图也不带 body',
  snapshot.archived.every((item) => item.body === undefined),
  (v) => v === true,
  'archiveView 没接 slimItem：归档越多，快照越大',
)
expect(
  '归档条目仍有 excerpt',
  snapshot.archived[0] && typeof snapshot.archived[0].excerpt === 'string',
  (v) => v === true,
  '缺 excerpt',
)
expect(
  '归档条目 chars 仍按原文算',
  snapshot.archived[0] && snapshot.archived[0].chars,
  (v) => v === '归档条目'.length + '归档的正文也应该只给摘要，否则归档区越长越占地方'.length,
  '先 slim 再算 chars 会把长度算错',
)

expect('回收站视图有一条', snapshot.deleted.length, (v) => v === 1, String(snapshot.deleted.length))
expect(
  '回收站视图也不带 body',
  snapshot.deleted.every((item) => item.body === undefined),
  (v) => v === true,
  'recycleView 没接 slimItem：回收站是临时堆积，用户不会天天清',
)
expect(
  '回收站条目仍有 deletedAt',
  snapshot.deleted[0] && Boolean(snapshot.deleted[0].deletedAt),
  (v) => v === true,
  '回收站元信息丢了',
)

const archivedFull = await call({ op: 'item.get', id: 'm-archived' })
expect('归档条目仍能按需读全文', archivedFull.item && archivedFull.item.body, (v) => String(v).length > 0, '正文没回来')

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(failures.length ? `\nSNAPSHOT SHAPE FAILED: ${failures.join(', ')}\n` : '\nSNAPSHOT SHAPE OK\n')
process.exit(failures.length ? 1 : 0)
