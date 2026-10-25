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
let putCount = 0

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
    res.writeHead(200, { 'content-type': 'application/json' }).end(files.get(key))
    return
  }
  if (req.method === 'PUT') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      putCount += 1
      const existed = files.has(key)
      files.set(key, body)
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
