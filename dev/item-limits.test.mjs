/**
 * 面板写入的规模护栏（v0.10.12）：
 *   1. item.create / item.update 的单条正文与标题上限（与模型写入路径同一套规则）；
 *   2. item.merge 拼出来的正文同样受限，避免「合并 10 条 8000 字」得到 8 万字；
 *   3. 空 patch 的 item.update 不推进 updatedAt（否则合并时把没改过的那条判成最新）；
 *   4. 加载时自动清理超过 90 天的墓碑，文件不再只增不减。
 *
 *   node dev/item-limits.test.mjs
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-limits-'))
const dataDir = path.join(tmpRoot, 'data')
await fs.mkdir(dataDir, { recursive: true })
process.env.DSH_MEMORY_DIR = dataDir
process.env.DSH_MEMORY_CONFIG = path.join(tmpRoot, 'pointer.json')
delete process.env.DSH_MEMORY_MAX_CHARS

const now = new Date().toISOString()
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString()
const seedItem = (id, order, title, body) => ({
  id,
  title,
  body,
  tags: [],
  groupId: null,
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  order,
  createdAt: now,
  updatedAt: now,
})

await fs.writeFile(
  path.join(dataDir, 'store.json'),
  JSON.stringify(
    {
      version: 1,
      updatedAt: now,
      groups: [],
      items: [seedItem('m-a', 0, '条目 A', 'A'), seedItem('m-b', 1, '条目 B', 'B')],
      deleted: [
        { id: 'm-old', at: daysAgo(120) },
        { id: 'm-recent', at: daysAgo(10) },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

const mod = await import('../index.js')

let handler = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx)
  },
  on() {},
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
  let text = ''
  const res = {
    writeHead() {},
    end(chunk) {
      text = String(chunk ?? '')
    },
  }
  await handler(req, res)
  return JSON.parse(text || '{}')
}

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual).slice(0, 120)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const sessionId = 'session-limits-test'

// 首次加载会触发 ensureLoaded（并自动清墓碑），先用一次 state 把它跑起来。
const initial = await call({ op: 'state', sessionId })
expect('首次加载成功', initial.ok, (v) => v === true, 'state 应成功')

const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8'))
expect(
  '过期墓碑在加载时被自动清理',
  (onDisk.deleted ?? []).map((entry) => entry.id).join(','),
  (v) => v === 'm-recent',
  '120 天前的 m-old 应被清掉、10 天前的 m-recent 保留',
)

// ---- 单条正文上限 20000 ----
const tooLong = await call({ op: 'item.create', title: '超长', body: '字'.repeat(20001) })
expect(
  '面板创建 20001 字正文被拒',
  tooLong,
  (v) => v.ok === false && String(v.error).includes('超过单条上限 20000'),
  '应提示超过单条上限',
)

const atLimit = await call({ op: 'item.create', title: '刚好到限', body: '字'.repeat(20000) })
expect('面板创建 20000 字正文可以写', atLimit, (v) => v.ok === true, '正好到上限应通过')

const longTitle = await call({ op: 'item.create', title: '标'.repeat(201), body: '正文' })
expect(
  '面板创建 201 字标题被拒',
  longTitle,
  (v) => v.ok === false && String(v.error).includes('超过 200 字上限'),
  '标题上限应与模型路径一致',
)

const tooLongPatch = await call({ op: 'item.update', id: 'm-a', patch: { body: '字'.repeat(20001) } })
expect(
  '面板编辑超过上限被拒',
  tooLongPatch,
  (v) => v.ok === false && String(v.error).includes('超过单条上限 20000'),
  'update 与 create 共用同一道闸',
)

// ---- 空 patch 不推进 updatedAt ----
const before = await call({ op: 'item.get', id: 'm-a' })
await new Promise((resolve) => setTimeout(resolve, 15))
const emptyPatch = await call({ op: 'item.update', id: 'm-a', patch: {} })
const after = await call({ op: 'item.get', id: 'm-a' })
expect('空 patch 仍返回成功', emptyPatch.ok, (v) => v === true, '不应报错')
expect(
  '空 patch 不推进 updatedAt',
  `${before.item.updatedAt} -> ${after.item.updatedAt}`,
  (v) => v.split(' -> ')[0] === v.split(' -> ')[1],
  '什么都没改就不该顶时间戳',
)

// ---- merge 生成正文同样受限 ----
const bigOne = await call({ op: 'item.create', title: '大条目一', body: '甲'.repeat(12000) })
const bigTwo = await call({ op: 'item.create', title: '大条目二', body: '乙'.repeat(12000) })
expect('两条 1.2 万字条目创建成功', `${bigOne.ok}/${bigTwo.ok}`, (v) => v === 'true/true', '都应在单条上限内')
const merged = await call({ op: 'item.merge', ids: [bigOne.focusId, bigTwo.focusId] })
expect(
  '合并结果超上限被拒',
  merged,
  (v) => v.ok === false && String(v.error).includes('超过单条上限'),
  '两条 1.2 万字拼起来应被拦下',
)

const mergedOk = await call({ op: 'item.merge', ids: ['m-a', 'm-b'] })
expect('小条目合并仍可用', mergedOk, (v) => v.ok === true, '不超限时合并应成功')

// ---- 手动 prune 复用同一套过滤 ----
const pruned = await call({ op: 'deleted.prune', days: 5 })
expect(
  '手动 prune 仍按天数清理墓碑',
  pruned,
  (v) => v.ok === true && String(v.message).includes('1 条'),
  'm-recent（10 天前）应被 days=5 清掉',
)

await fs.rm(tmpRoot, { recursive: true, force: true })
if (failures.length) {
  console.error(`${failures.length} 项失败：${failures.join('、')}`)
  process.exit(1)
}
console.log('ITEM LIMITS OK')
process.exit(0)
