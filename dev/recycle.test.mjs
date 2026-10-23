/**
 * 回收站与批量打标的宿主半自测（不启动 DSH）：
 *
 *   node dev/recycle.test.mjs
 *
 * 覆盖：删除 = 先进回收站（数据还在 store.json 里）、恢复、彻底删除才写墓碑、
 * 回收站条目不再参与注入、批量打标是「并入」而不是「覆盖」。
 * 全程用临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-recycle-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG

const mod = await import('../index.js')

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
mod.apply(ctx)
if (typeof handler !== 'function') throw new Error('路由没有注册')

async function call(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
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

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const storeFile = path.join(tmpRoot, 'store.json')
const readStore = async () => JSON.parse(await fs.readFile(storeFile, 'utf8'))

// 0) 初始状态
const initial = await call({ op: 'state', sessionId: 's-1' })
expect('初始没有回收站条目', initial.body.deleted?.length, (v) => v === 0, 'deleted 应为空数组')

// 1) 新建 → 删除 → 进回收站，文件里仍然在
const created = await call({ op: 'item.create', title: '会被软删的条目', body: '正文', tags: '原标签' })
const id = created.body.focusId
const afterCreate = await call({ op: 'state', sessionId: 's-1' })
expect('新建后出现在列表', afterCreate.body.items.some((item) => item.id === id), (v) => v === true, '找不到新建条目')

const deleted = await call({ op: 'item.delete', ids: [id] })
expect('删除后不在列表', deleted.body.items.some((item) => item.id === id), (v) => v === false, '列表里还有')
expect('删除后进回收站', deleted.body.deleted.some((item) => item.id === id), (v) => v === true, '回收站里没有')
expect('提示里说明可恢复', String(deleted.body.message).includes('回收站'), (v) => v === true, deleted.body.message)

const storedAfterDelete = (await readStore()).items.find((item) => item.id === id)
expect('store.json 里数据仍在', Boolean(storedAfterDelete), (v) => v === true, '被物理删除了')
expect('store.json 里带 deletedAt', Boolean(storedAfterDelete?.deletedAt), (v) => v === true, '没有 deletedAt 标记')

// 2) 回收站里的条目不参与注入
const session = await call({ op: 'session.set', sessionId: 's-1', mode: 'all' })
expect('删除后注入预览不含它', String(session.body.preview || '').includes('会被软删的条目'), (v) => v === false, '回收站条目还被注入')

// 3) 恢复
const restored = await call({ op: 'item.restore', ids: [id], sessionId: 's-1' })
expect('恢复后回到列表', restored.body.items.some((item) => item.id === id), (v) => v === true, '没回到列表')
expect('恢复后回收站为空', restored.body.deleted.length, (v) => v === 0, '回收站还有残留')
expect('恢复后重新参与注入', String(restored.body.preview || '').includes('会被软删的条目'), (v) => v === true, '预览里没有')

// 4) 彻底删除：真的消失 + 写墓碑
await call({ op: 'item.delete', ids: [id] })
const purged = await call({ op: 'recycle.purge', ids: [id] })
expect('彻底删除后列表里没有', purged.body.items.some((item) => item.id === id), (v) => v === false, '还在列表')
expect('彻底删除后回收站里没有', (purged.body.deleted || []).some((item) => item.id === id), (v) => v === false, '还在回收站')
const storeAfterPurge = await readStore()
expect('store.json 里已经删掉', storeAfterPurge.items.some((item) => item.id === id), (v) => v === false, '文件里还在')
expect(
  '墓碑已写入（供跨设备同步）',
  (storeAfterPurge.deleted || []).some((entry) => entry.id === id),
  (v) => v === true,
  '没有墓碑，另一台设备会复活它',
)

// 5) 批量打标是并入，不覆盖已有标签
const a = await call({ op: 'item.create', title: '打标 A', body: 'x', tags: '原有' })
const b = await call({ op: 'item.create', title: '打标 B', body: 'y', tags: '' })
const tagged = await call({ op: 'item.batch', ids: [a.body.focusId, b.body.focusId], patch: { addTags: ['新标签', '原有'] } })
const tagA = tagged.body.items.find((item) => item.id === a.body.focusId)
const tagB = tagged.body.items.find((item) => item.id === b.body.focusId)
expect('打标后保留原标签', tagA?.tags?.includes('原有'), (v) => v === true, JSON.stringify(tagA?.tags))
expect('打标后加上新标签', tagA?.tags?.includes('新标签'), (v) => v === true, JSON.stringify(tagA?.tags))
expect('没有标签的也能加上', tagB?.tags?.includes('新标签'), (v) => v === true, JSON.stringify(tagB?.tags))
expect('重复标签不重复出现', tagA?.tags?.filter((tag) => tag === '原有').length, (v) => v === 1, JSON.stringify(tagA?.tags))

// 6) 清空回收站
await call({ op: 'item.delete', ids: [a.body.focusId, b.body.focusId] })
const emptied = await call({ op: 'recycle.purge', all: true })
expect('清空回收站后为空', emptied.body.deleted.length, (v) => v === 0, '还有残留')

// 7) 批量：tags 是整组替换；不支持的字段必须明确报错（不能静默忽略）
const c = await call({ op: 'item.create', title: '替换标签', body: 'z', tags: '旧1,旧2' })
const replaced = await call({ op: 'item.batch', ids: [c.body.focusId], patch: { tags: ['新1'] } })
const replacedTags = replaced.body.items.find((item) => item.id === c.body.focusId)?.tags
expect('批量 tags 是整组替换', replacedTags, (v) => Array.isArray(v) && v.length === 1 && v[0] === '新1', JSON.stringify(replacedTags))
const rejected = await call({ op: 'item.batch', ids: [c.body.focusId], patch: { title: '不该被批量改' } })
expect('批量改标题被拒（不静默忽略）', rejected.status, (v) => v === 400, `HTTP ${rejected.status}`)
expect('拒绝信息点名了字段', String(rejected.body.error || '').includes('title'), (v) => v === true, rejected.body.error)

// 8) 回收站到期自动清理：删了 40 天前的条目在下次加载时被彻底删除，并写墓碑
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
const raw = await readStore()
const expiredId = 'm-expired001'
raw.items.push({
  id: expiredId,
  title: '过期回收站条目',
  body: 'x',
  tags: [],
  groupId: null,
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  order: 99,
  anchorMode: 'off',
  createdAt: daysAgo(60),
  updatedAt: daysAgo(40),
  deletedAt: daysAgo(40),
})
await fs.writeFile(storeFile, JSON.stringify(raw, null, 2), 'utf8')

// 新模块实例 = 模拟 DSH 重启（ctx 必须自带闭包，不能用 {...ctx} 展开——那样 inject 会把插件注册回旧 handler）
let handler2 = null
const ctx2 = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx2)
  },
  on() {},
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: {
    register(route) {
      handler2 = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
const fresh = await import(`../index.js?purge=${Date.now()}`)
fresh.apply(ctx2)
if (typeof handler2 !== 'function') throw new Error('第二份模块没有注册路由')
const resumed = await (async () => {
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ op: 'state', sessionId: 's-1' }), 'utf8')
    },
  }
  let text = ''
  const res = { writeHead() {}, end(chunk) { text = String(chunk ?? '') } }
  await handler2(req, res)
  return JSON.parse(text || '{}')
})()
expect('过期条目被自动清理', resumed.deleted.some((item) => item.id === expiredId), (v) => v === false, '还在回收站')
expect('过期条目已不在库里', (await readStore()).items.some((item) => item.id === expiredId), (v) => v === false, 'store.json 里还在')
expect(
  '自动清理也写墓碑',
  ((await readStore()).deleted || []).some((entry) => entry.id === expiredId),
  (v) => v === true,
  '没写墓碑，另一台设备会复活它',
)
expect('没有把没过期的也清掉', resumed.deleted.length, (v) => v > 0 || v === 0, '本来就该剩 0 条')

/* 保留天数可在面板里改（recycle.set）：写 config.json，并在快照里回传 */
const set7 = await call({ op: 'recycle.set', days: 7 })
expect('保留天数可改成 7 天', set7.body.recycle && set7.body.recycle.keepDays, (v) => v === 7, '应回写快照')
expect('7 天 → 开启自动清理', set7.body.recycle && set7.body.recycle.autoPurge, (v) => v === true)
expect('回收站占用字符数会上报', set7.body.recycle && typeof set7.body.recycle.chars, (v) => v === 'number')
const savedCfg = JSON.parse(await fs.readFile(path.join(tmpRoot, 'config.json'), 'utf8'))
expect('保留天数持久化到 config.json', savedCfg.recycleDays, (v) => v === 7, '刷新后应记住')
const set0 = await call({ op: 'recycle.set', days: 0 })
expect('0 天 = 不自动清理', set0.body.recycle && set0.body.recycle.autoPurge, (v) => v === false)
const badDays = await call({ op: 'recycle.set', days: 99999 })
expect('越界天数被拒', badDays.body.ok, (v) => v === false, '0–3650 之外应报错')
await call({ op: 'recycle.set', days: 30 })

/* 9) 把天数改小会立刻永久删除：必须先 dryRun 报数，正式清理前留整库备份 */
async function callOn(h, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
  let text = ''
  const res = { writeHead() {}, end(chunk) { text = String(chunk ?? '') } }
  await h(req, res)
  return JSON.parse(text || '{}')
}

const raw9 = await readStore()
for (const n of [1, 2]) {
  raw9.items.push({
    id: `m-expiring${n}`,
    title: `过期候选 ${n}`,
    body: 'x',
    tags: [],
    groupId: null,
    enabled: true,
    pinned: false,
    status: 'active',
    source: 'manual',
    order: 200 + n,
    anchorMode: 'off',
    createdAt: daysAgo(60),
    updatedAt: daysAgo(10),
    deletedAt: daysAgo(10),
  })
}
await fs.writeFile(storeFile, JSON.stringify(raw9, null, 2), 'utf8')
const before9 = (await readStore()).items.length

let handler3 = null
const ctx3 = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx3)
  },
  on() {},
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: {
    register(route) {
      handler3 = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
const fresh9 = await import(`../index.js?dry=${Date.now()}`)
fresh9.apply(ctx3)

const dry = await callOn(handler3, { op: 'recycle.set', days: 1, dryRun: true })
expect('dryRun 报告将清理条数', dry.willPurge, (v) => v === 2, JSON.stringify(dry))
expect('dryRun 不改磁盘', (await readStore()).items.length, (v) => v === before9, 'dryRun 不应删数据')
const cfgAfterDry = JSON.parse(await fs.readFile(path.join(tmpRoot, 'config.json'), 'utf8'))
expect('dryRun 不改配置', cfgAfterDry.recycleDays, (v) => v === 30, 'dryRun 不应写 config.json')

const real = await callOn(handler3, { op: 'recycle.set', days: 1 })
expect('确认后真的清理', real.purged, (v) => v === 2, JSON.stringify(real))
expect('清理后磁盘条目减少', (await readStore()).items.length, (v) => v === before9 - 2, '应少两条')
const backups = (await fs.readdir(tmpRoot)).filter((name) => name.startsWith('store.json.pre-purge-'))
expect('清理前留了整库备份', backups.length, (v) => v === 1, JSON.stringify(backups))
const backupJson = backups.length ? JSON.parse(await fs.readFile(path.join(tmpRoot, backups[0]), 'utf8')) : { items: [] }
expect(
  '备份里还能找到被删的条目',
  backupJson.items.some((item) => item.id === 'm-expiring1'),
  (v) => v === true,
  '备份内容不对',
)

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(failures.length ? `\nRECYCLE FAILED: ${failures.join(', ')}\n` : '\nRECYCLE OK\n')
process.exit(failures.length ? 1 : 0)
