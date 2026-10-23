/**
 * 条目字段持久化自测（不启动 DSH）：
 *
 *   node dev/fields.test.mjs
 *
 * 为什么有这个测试：normalizeState 以前用手写字段列表重建条目，v1.6 新增的
 * deletedAt / archivedAt / mergedInto 三个字段漏在列表外，结果「重启 / 切目录 /
 * 同步拉取」之后回收站和归档整体失效（删掉的记忆会回到列表、继续被注入）。
 *
 * 两道闸：
 *   1. 静态闸：扫 index.js 里所有 `item.<字段> =` 赋值，字段必须在 ITEM_FIELDS 里登记；
 *   2. 往返闸：把带全字段的条目写进 store.json，用新模块实例重新加载，逐字段断言没丢。
 *
 * 全程用临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(HERE, '..', 'index.js')

let failures = 0
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) {
    console.log(`ok   ${label} = ${JSON.stringify(actual)}`)
  } else {
    failures += 1
    console.log(`FAIL ${label} = ${JSON.stringify(actual)}${hint ? `  (${hint})` : ''}`)
  }
}

const mod = await import('../index.js')
const FIELDS = mod.ITEM_FIELDS || {}

/* ------------------------------------------------------- 1. 静态：赋值字段都登记 */

const source = await fs.readFile(INDEX, 'utf8')
const assigned = new Set()
for (const match of source.matchAll(/\bitem\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assigned.add(match[1])
const unregistered = [...assigned].filter((field) => !(field in FIELDS))
expect('赋值字段数量 > 8', assigned.size, (v) => v > 8, '正则可能没匹配到，检查写法')
expect('所有 item.xxx = 的字段都登记在 ITEM_FIELDS', unregistered, (v) => v.length === 0, '漏登记会在重载后被丢弃')
expect('ITEM_FIELDS 覆盖 deletedAt/archivedAt/mergedInto', ['deletedAt', 'archivedAt', 'mergedInto'].every((f) => f in FIELDS), true)

/* ------------------------------------------------------- 2. 往返：写盘 → 新实例读回 */

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-fields-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG

const stamp = '2026-10-23T05:00:00.000Z'
const store = {
  version: 1,
  updatedAt: stamp,
  groups: [{ id: 'g-a', name: '往返测试', order: 0, createdAt: stamp }],
  deleted: [{ id: 'm-gone', at: stamp }],
  items: [
    {
      id: 'm-live',
      title: '活跃条目',
      body: '正文 LIVE_TOKEN',
      tags: ['标签一', '标签二'],
      groupId: 'g-a',
      enabled: false,
      pinned: true,
      status: 'pending',
      source: 'merge',
      sessionId: 'session-fields',
      anchorMode: 'full',
      order: 7,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
      archivedAt: null,
      mergedInto: null,
    },
    {
      id: 'm-arch',
      title: '归档条目',
      body: '正文 ARCH_TOKEN',
      tags: [],
      groupId: null,
      enabled: true,
      pinned: false,
      status: 'active',
      source: 'manual',
      sessionId: null,
      anchorMode: 'weight',
      order: 8,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
      archivedAt: stamp,
      mergedInto: 'm-live',
    },
    {
      id: 'm-del',
      title: '回收站条目',
      body: '正文 DEL_TOKEN',
      tags: [],
      groupId: null,
      enabled: true,
      pinned: false,
      status: 'active',
      source: 'manual',
      sessionId: null,
      anchorMode: 'off',
      order: 9,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: stamp,
      archivedAt: null,
      mergedInto: null,
    },
  ],
}
await fs.writeFile(path.join(tmpRoot, 'store.json'), JSON.stringify(store, null, 2), 'utf8')

let handler = null
const makeCtx = () => {
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
  return ctx
}

const fresh = await import(`../index.js?fields=${Date.now()}`)
fresh.apply(makeCtx())
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

const state = await call({ op: 'state', sessionId: 'session-fields' })
const items = state.items || []
const archived = state.archived || []
const deleted = state.deleted || []

expect('活跃列表只有 m-live', items.map((i) => i.id), (v) => v.length === 1 && v[0] === 'm-live', '回收站/归档条目不该回到列表')
expect('归档列表有 m-arch', archived.map((i) => i.id), (v) => v.length === 1 && v[0] === 'm-arch')
expect('回收站有 m-del', deleted.map((i) => i.id), (v) => v.length === 1 && v[0] === 'm-del')
expect('注入预览不含已删/已归档正文', /DEL_TOKEN|ARCH_TOKEN/.test(state.preview || ''), false, '重载后已删条目不能再被注入')

const live = items[0] || {}
expect('活跃条目保留 pinned', live.pinned, true)
expect('活跃条目保留 enabled=false', live.enabled, false)
expect('活跃条目保留 status=pending', live.status, 'pending')
expect('活跃条目保留 source=merge', live.source, 'merge')
expect('活跃条目保留 sessionId', live.sessionId, 'session-fields')
expect('活跃条目保留 anchorMode=full', live.anchorMode, 'full')
expect('活跃条目保留 tags', live.tags, (v) => Array.isArray(v) && v.length === 2)
expect('活跃条目保留 groupId', live.groupId, 'g-a')
expect('活跃条目保留 order', live.order, 7)

const archItem = archived[0] || {}
expect('归档条目保留 archivedAt', archItem.archivedAt, stamp)
expect('归档条目保留 mergedInto', archItem.mergedInto, 'm-live')
expect('归档条目保留 anchorMode=weight', archItem.anchorMode, 'weight')

const delItem = deleted[0] || {}
expect('回收站条目保留 deletedAt', delItem.deletedAt, stamp)

expect('统计不含已删/已归档', state.stats && state.stats.items, 0, 'm-live 是待确认，不计入活跃数')
expect('待确认计数正确', state.stats && state.stats.pending, 1)

await fs.rm(tmpRoot, { recursive: true, force: true })

if (failures) {
  console.log(`\nFIELDS FAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nFIELDS OK')
