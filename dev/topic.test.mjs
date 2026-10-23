/**
 * 同主题识别与「旧版」标注自测（不启动 DSH）：
 *
 *   node dev/topic.test.mjs
 *
 * 场景：用户改过主意之后，库里同时存在「记忆放 C 盘」和「记忆放 E 盘」。
 * 这两条都启用着，注入时如果不标清楚哪条更新，模型会照旧结论执行。
 *
 * 这里守住四件事：
 *   1. 明显的同主题要认出来，不相干的两条不能被硬凑成一组；
 *   2. 组里最新那条不标注，其余标〔旧版〕并写清以谁为准；
 *   3. 同一分钟写入的视为同一批，不编造新旧；
 *   4. 归档 / 停用的条目不参与同主题判断（它们本来就不注入）。
 *
 * 全程用临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { groupTopics, looksSameTopic } from '../lib/topics.js'

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

/* ---------------------------------------------------- 1. 纯函数：像不像同主题 */

const newer = { id: 'm-new', title: '记忆库放在 E 盘', body: '记忆只存在 E:/dsh-data/memory，不写 C 盘' }
const older = { id: 'm-old', title: '记忆库放在 C 盘', body: '记忆存在 C:/Users/x/.dsh/memory' }
const other = { id: 'm-other', title: '回复尽量简短', body: '偏好短句，别写长篇解释' }

expect('同一主题（只差盘符）能认出', looksSameTopic(newer, older), true)
expect('不相干的两条不会被凑成一组', looksSameTopic(newer, other), false)

const sameMinute = groupTopics([
  { ...newer, updatedAt: '2026-10-23T10:00:00.000Z' },
  { ...older, updatedAt: '2026-10-23T10:00:20.000Z' },
])
expect('同一分钟内写入不标新旧', sameMinute.byId.size, 0, '两条同时写入时没有谁更权威')

/* --------------------------------------------- 2. 真链路：注入文本与快照 */

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-topic-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG

const stamp = '2026-10-23T10:00:00.000Z'
const base = {
  tags: ['存储'],
  groupId: 'g-a',
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  sessionId: null,
  anchorMode: 'off',
  createdAt: '2026-10-20T00:00:00.000Z',
  deletedAt: null,
  archivedAt: null,
  mergedInto: null,
}
const store = {
  version: 1,
  updatedAt: stamp,
  groups: [{ id: 'g-a', name: '项目约定', order: 0, createdAt: stamp }],
  deleted: [],
  items: [
    { ...base, id: 'm-new', title: '记忆库放在 E 盘', body: '记忆只存在 E:/dsh-data/memory，不写 C 盘', updatedAt: '2026-10-23T10:00:00.000Z', order: 0 },
    { ...base, id: 'm-old', title: '记忆库放在 C 盘', body: '记忆存在 C:/Users/x/.dsh/memory', updatedAt: '2026-10-22T08:00:00.000Z', order: 1 },
    { ...base, id: 'm-other', title: '回复尽量简短', body: '偏好短句，别写长篇解释', updatedAt: '2026-10-22T09:00:00.000Z', order: 2 },
    { ...base, id: 'm-arch', title: '记忆库放在 D 盘', body: '旧方案：记忆存在 D:/memory', updatedAt: '2026-10-21T08:00:00.000Z', order: 3, archivedAt: stamp },
    { ...base, id: 'm-off', title: '记忆库放在 F 盘', body: '已停用的方案：记忆存在 F:/memory', updatedAt: '2026-10-21T09:00:00.000Z', order: 4, enabled: false },
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

const fresh = await import(`../index.js?topic=${Date.now()}`)
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

const sid = 'session-topic-test'
await call({ op: 'session.set', sessionId: sid, mode: 'all' })
const state = await call({ op: 'state', sessionId: sid })

const groups = (state.topics && state.topics.groups) || []
expect('只认出 1 组同主题', groups.length, 1)
expect('组里有 2 条（旧版 + 新版）', (groups[0] && groups[0].itemIds.length) || 0, 2)
expect('组内最新是 E 盘那条', groups[0] && groups[0].latestId, 'm-new')
expect('归档条目不进同主题判断', groups[0] && groups[0].itemIds.includes('m-arch'), false)
expect('停用条目不进同主题判断', groups[0] && groups[0].itemIds.includes('m-off'), false)

const byId = (state.topics && state.topics.byId) || {}
expect('m-new 是最新，不标旧版', byId['m-new'] && byId['m-new'].isLatest, true)
expect('m-old 被判为旧版', byId['m-old'] && byId['m-old'].isLatest, false)
expect('旧版知道以谁为准', byId['m-old'] && byId['m-old'].latestTitle, '记忆库放在 E 盘')
expect('不相干的条目不参与分组', byId['m-other'], undefined)

const preview = state.preview || ''
expect('注入里标出〔旧版〕', preview.includes('〔旧版'), true)
expect('注入里写明以哪条为准', preview.includes('同主题以「记忆库放在 E 盘」为准'), true)
expect('注入头部有统一说明', preview.includes('同主题有多条'), true)
expect('最新那条没有被误标', /「记忆库放在 E 盘」[^\n]*\n(?!\s*〔旧版)/.test(preview), true)
expect('注入统计 stale = 1', state.injection && state.injection.stale, 1)
expect('注入统计 topics = 1', state.injection && state.injection.topics, 1)

/* ----------------------------------------------------- 3. 检索结果也要带标注 */

const found = await call({ op: 'search', query: '记忆库', includeArchived: false })
const hitOld = (found.hits || []).find((hit) => hit.id === 'm-old')
const hitNew = (found.hits || []).find((hit) => hit.id === 'm-new')
expect('检索能命中旧版那条', Boolean(hitOld), true)
expect('检索结果里旧版带 topic 标注', hitOld && hitOld.topic && hitOld.topic.isLatest, false)
expect('检索结果里旧版知道以谁为准', hitOld && hitOld.topic && hitOld.topic.latestTitle, '记忆库放在 E 盘')
expect('检索结果里最新那条 isLatest', hitNew && hitNew.topic && hitNew.topic.isLatest, true)

await fs.rm(tmpRoot, { recursive: true, force: true })

if (failures) {
  console.log(`\nTOPIC FAILED：${failures} 项`)
  process.exit(1)
}
console.log('\nTOPIC OK')
