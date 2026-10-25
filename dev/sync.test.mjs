/**
 * WebDAV 后端的端到端测试：起一个内存版 WebDAV，模拟「两台设备」轮流同步。
 * 跑法：node dev/sync.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mergeStates, normalizeSync, syncNow } from '../lib/sync.js'

const files = new Map()
const etags = new Map()
let etagSeq = 0
let putCount = 0
let lastPutIfMatch = null
let rejectNextPut = false

const server = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
  if (req.method === 'MKCOL') {
    res.writeHead(files.has(`${key}/`) ? 405 : 201).end()
    return
  }
  if (req.method === 'GET') {
    if (!files.has(key)) {
      res.writeHead(404).end('not found')
      return
    }
    const etag = etags.get(key)
    res
      .writeHead(200, { 'content-type': 'application/json', ...(etag ? { etag } : {}) })
      .end(files.get(key))
    return
  }
  if (req.method === 'PUT') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      // 模拟「我们合并完到 PUT 之间，另一台设备抢先写了」：这次回 412，重试才会成功
      if (rejectNextPut) {
        rejectNextPut = false
        etags.set(key, `"v${++etagSeq}"`)
        res.writeHead(412).end('precondition failed')
        return
      }
      const existed = files.has(key)
      const current = etags.get(key)
      const ifMatch = req.headers['if-match']
      if (ifMatch && current && ifMatch !== current) {
        res.writeHead(412).end('precondition failed')
        return
      }
      putCount += 1
      lastPutIfMatch = ifMatch || null
      files.set(key, body)
      etags.set(key, `"v${++etagSeq}"`)
      res.writeHead(existed ? 204 : 201).end()
    })
    return
  }
  res.writeHead(405).end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const remote = `http://127.0.0.1:${port}/dav/memory`

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-sync-'))
const deviceA = path.join(root, 'a')
const deviceB = path.join(root, 'b')
for (const dir of [deviceA, deviceB]) await fs.mkdir(dir, { recursive: true })

const store = (items, deleted = []) => ({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', groups: [], items, deleted })
const item = (id, body, updatedAt) => ({
  id,
  title: id,
  body,
  tags: [],
  groupId: null,
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
})

async function writeLocal(dir, data) {
  await fs.writeFile(path.join(dir, 'store.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
async function readLocal(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8'))
}

function mergerFor(dir) {
  return async (remoteStore) => {
    const current = await readLocal(dir)
    const outcome = mergeStates(current, remoteStore)
    if (!outcome.changed) return { changed: false, summary: '' }
    await writeLocal(dir, outcome.state)
    return { changed: true, summary: 'merged' }
  }
}

const sync = normalizeSync({ mode: 'webdav', remote, username: 'u', password: 'p' })
const opts = (dir) => ({ dir, sync, files: ['store.json'], merge: mergerFor(dir) })

let passed = 0
async function it(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error.message)
    process.exitCode = 1
  }
}

await writeLocal(deviceA, store([item('m1', 'A 的记忆', '2026-01-02T00:00:00.000Z')]))

await it('设备 A 首次同步后，远端出现 store.json', async () => {
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  assert.ok(files.has('/dav/memory/store.json'), '远端应写入 store.json')
  const uploaded = JSON.parse(files.get('/dav/memory/store.json'))
  assert.equal(uploaded.items.length, 1)
})

await it('设备 B 首次同步会把远端的记忆拉下来', async () => {
  await writeLocal(deviceB, store([item('m2', 'B 的记忆', '2026-01-03T00:00:00.000Z')]))
  const result = await syncNow(opts(deviceB))
  assert.equal(result.status, 'ok', result.message)
  const localB = await readLocal(deviceB)
  const ids = localB.items.map((entry) => entry.id).sort()
  assert.deepEqual(ids, ['m1', 'm2'], `B 本地应有两条，实际 ${ids.join(',')}`)
  const uploaded = JSON.parse(files.get('/dav/memory/store.json'))
  assert.equal(uploaded.items.length, 2, '合并结果应回传远端')
})

await it('设备 A 再同步能拿到 B 新增的条目', async () => {
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  const localA = await readLocal(deviceA)
  assert.deepEqual(localA.items.map((entry) => entry.id).sort(), ['m1', 'm2'])
})

await it('A 删除一条后，墓碑会把 B 那边的同一条也删掉', async () => {
  const localA = await readLocal(deviceA)
  const deleted = localA.items.filter((entry) => entry.id === 'm1')
  await writeLocal(deviceA, {
    ...localA,
    items: localA.items.filter((entry) => entry.id !== 'm1'),
    deleted: [...(localA.deleted ?? []), { id: 'm1', at: '2026-02-01T00:00:00.000Z' }],
  })
  assert.equal(deleted.length, 1)
  let result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  result = await syncNow(opts(deviceB))
  assert.equal(result.status, 'ok', result.message)
  const localB = await readLocal(deviceB)
  assert.deepEqual(localB.items.map((entry) => entry.id), ['m2'], 'B 那边 m1 也应消失')
})

await it('本地没有变化时不再整份上传（省流量）', async () => {
  const before = putCount
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  assert.equal(result.message, '已是最新', `远端与本地一致时应跳过上传，实际：${result.message}`)
  assert.equal(putCount, before, `无变化不应 PUT，实际多传了 ${putCount - before} 次`)
})

await it('上传带 If-Match：远端有 ETag 时不会盲写覆盖', async () => {
  const localA = await readLocal(deviceA)
  await writeLocal(deviceA, {
    ...localA,
    items: [...localA.items, item('m3', 'A 新写', '2026-01-05T00:00:00.000Z')],
  })
  lastPutIfMatch = null
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  assert.ok(
    lastPutIfMatch,
    'PUT 应带 If-Match：否则两台设备并发同步时，后到的整份覆盖会静默抹掉对方刚写入的条目',
  )
})

await it('远端在合并期间被改：第一次 412，重试后成功', async () => {
  const localA = await readLocal(deviceA)
  await writeLocal(deviceA, {
    ...localA,
    items: [...localA.items, item('m4', 'A 又写', '2026-01-06T00:00:00.000Z')],
  })
  rejectNextPut = true
  const before = putCount
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  assert.equal(putCount, before + 1, '412 那次不算上传，重试那次才成功')
})

await it('弱 ETag 不放进 If-Match：否则 412 死循环，WebDAV 同步整个不可用', async () => {
  const localA = await readLocal(deviceA)
  await writeLocal(deviceA, {
    ...localA,
    items: [...localA.items, item('m5', 'A 再写', '2026-01-07T00:00:00.000Z')],
  })
  // 模拟 CDN / 反向代理 / 老版本 Nextcloud：只给弱 ETag。RFC 7232 的 If-Match 是强比较，
  // W/ 前缀永远不匹配，带上去就是 412 → 重试还是 412 → 报错，用户再点多少次都一样。
  etags.set('/dav/memory/store.json', 'W/"weak-1"')
  lastPutIfMatch = null
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'ok', result.message)
  assert.equal(lastPutIfMatch, null, '弱 ETag 不能用于 If-Match，应退回无条件 PUT')
})

await it('远端不是合法 JSON 时中止，不会覆盖本地', async () => {
  files.set('/dav/memory/store.json', '{ 坏掉的 json')
  const before = await readLocal(deviceA)
  const result = await syncNow(opts(deviceA))
  assert.equal(result.status, 'error')
  const after = await readLocal(deviceA)
  assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id))
})

await it('没填地址时直接跳过', async () => {
  const result = await syncNow({ dir: deviceA, sync: normalizeSync({ mode: 'webdav' }), files: ['store.json'], merge: mergerFor(deviceA) })
  assert.equal(result.status, 'skipped')
})

server.close()
await fs.rm(root, { recursive: true, force: true })
console.log(`\n${passed} 项通过`)
