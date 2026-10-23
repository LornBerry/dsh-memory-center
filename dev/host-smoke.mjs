/**
 * 不启动 DSH 的宿主半自测：假 ctx + 假 req/res，直接调真实的路由处理函数。
 *
 *   node dev/host-smoke.mjs
 *
 * 覆盖：自动探测（无配置无环境变量）、config.get 字段、config.set 切目录、
 * 切换后 config.json 记住新位置、空目录会建种子数据。
 * 为了不碰真实记忆库，这里用 DSH_MEMORY_CONFIG 把「记住的选择」指到临时目录。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-host-'))
const pointer = path.join(tmpRoot, 'pointer.json')
const target = path.join(tmpRoot, 'moved')

process.env.DSH_MEMORY_CONFIG = pointer
delete process.env.DSH_MEMORY_DIR

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
if (typeof handler !== 'function') throw new Error('路由没有注册')

async function call(method, payload, headers = {}) {
  const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0)
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body
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

// 1) 自动探测：没有配置文件、没有环境变量
const auto = await call('POST', { op: 'config.get' })
expect('auto.dataDir 是绝对路径', auto.body.dataDir, (v) => typeof v === 'string' && path.isAbsolute(v), '应为绝对路径')
expect('auto.defaultDir = dataDir', auto.body.defaultDir, (v) => v === auto.body.dataDir, '恢复默认应回到同一处')
expect('auto.envLocked = false', auto.body.envLocked, (v) => v === false, '未设 DSH_MEMORY_DIR')
expect('auto.configFile = DSH_MEMORY_CONFIG', auto.body.configFile, (v) => v === pointer, '设了 DSH_MEMORY_CONFIG 就用它')

// 2) 切目录
const moved = await call('POST', { op: 'config.set', dir: target, move: false })
expect('config.set ok', moved.body.ok, (v) => v === true, moved.body.error || '切换失败')
expect('切换后 dataDir = 目标', moved.body.dataDir, (v) => path.resolve(v) === path.resolve(target), '未生效')
expect('切换后 items 有种子', moved.body.items?.length, (v) => v >= 2, '空目录应建种子')
const seeded = moved.body.items || []
const syncHint = seeded.find((item) => item.title === '跨设备记忆需要开同步')
expect('新库种子含「跨设备记忆需要开同步」', Boolean(syncHint), (v) => v === true, '首装应留一条跨设备提醒')
expect('跨设备提醒在待确认', syncHint && syncHint.status, (v) => v === 'pending', '应为 pending，不参与注入')
expect('跨设备提醒未归类', syncHint && syncHint.groupId, (v) => v === null, 'groupId 应为 null（未归类）')

// 3) 配置记住新位置（目标目录 + 旧指针各一份，指向同一个新路径）
for (const file of [path.join(target, 'config.json'), pointer]) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(`config.json 记住新路径 ${path.basename(path.dirname(file))}`, raw.dataDir, (v) => path.resolve(v) === path.resolve(target), file)
}

// 4) 再问一次 config.get：配置里记的目录应被采纳
const again = await call('POST', { op: 'config.get' })
expect('再次 config.get 的 dataDir', again.body.dataDir, (v) => path.resolve(v) === path.resolve(target), '没读回配置')

// 4b) HTTP 硬化：非 JSON / 跨站请求在入口就被拒绝
const plainText = await call('POST', { op: 'config.get' }, { 'content-type': 'text/plain' })
expect('text/plain 被拒', plainText.status, (v) => v === 415, '应返回 415')
const crossSite = await call('POST', { op: 'config.get' }, { origin: 'http://evil.example' })
expect('跨站 Origin 被拒', crossSite.status, (v) => v === 403, '应返回 403')
const crossFetch = await call('GET', null, { 'sec-fetch-site': 'cross-site' })
expect('跨站 Sec-Fetch-Site 被拒', crossFetch.status, (v) => v === 403, '应返回 403')
const sameOrigin = await call('POST', { op: 'config.get' }, { origin: 'http://127.0.0.1:1234', host: '127.0.0.1:1234' })
expect('同源 JSON 正常放行', sameOrigin.status, (v) => v === 200, '应返回 200')

// 4c) groupId 不存在时落回未归类
const created = await call('POST', { op: 'item.create', title: '测试条目', body: 'x', groupId: 'no-such-group' })
const createdItem = created.body.items?.find((entry) => entry.title === '测试条目')
expect('create 无效 groupId 落回未归类', createdItem?.groupId, (v) => v === null, '应为 null')
const updated = await call('POST', { op: 'item.update', id: createdItem?.id, patch: { groupId: 'no-such-group' } })
expect('update 无效 groupId 落回未归类', updated.body.items?.find((entry) => entry.id === createdItem?.id)?.groupId, (v) => v === null, '应为 null')

// 4d) item.batch 一次改多条
const second = await call('POST', { op: 'item.create', title: '批量B', body: 'y' })
const secondItem = second.body.items?.find((entry) => entry.title === '批量B')
const batch = await call('POST', { op: 'item.batch', ids: [createdItem?.id, secondItem?.id], patch: { enabled: false } })
const disabled = (batch.body.items ?? []).filter((entry) => [createdItem?.id, secondItem?.id].includes(entry.id) && entry.enabled === false)
expect('item.batch 一次停用两条', disabled.length, (v) => v === 2, '应 2 条停用')

// 4e) 切到已有记忆的目录：合并且保留目标原文件备份，不能直接覆盖
const occupied = path.join(tmpRoot, 'occupied')
await fs.mkdir(occupied, { recursive: true })
const stamp = new Date().toISOString()
await fs.writeFile(
  path.join(occupied, 'store.json'),
  JSON.stringify({
    version: 1,
    updatedAt: stamp,
    groups: [],
    items: [
      { id: 'old-1', title: '目标已有', body: '来自另一个库', tags: [], groupId: null, enabled: true, pinned: false, status: 'active', source: 'manual', order: 0, createdAt: stamp, updatedAt: stamp },
    ],
    deleted: [],
  }),
  'utf8',
)
const switched = await call('POST', { op: 'config.set', dir: occupied })
expect('切到已有记忆的目录会合并而非覆盖', switched.body.items?.some((entry) => entry.title === '目标已有'), (v) => v === true, '目标条目应存在')
expect('切换后原有条目仍在', switched.body.items?.length, (v) => v >= 3, '应有种子 + 合并条目')
const backups = (await fs.readdir(path.join(occupied, 'backups'))).filter((name) => name.startsWith('pre-switch-'))
expect('切换前备份了目标原文件', backups.length, (v) => v >= 1, '应有 backups/pre-switch- 备份')

// 5) 默认模式（没有 DSH_MEMORY_CONFIG）：配置文件应落在数据目录内部，不会另找地方
delete process.env.DSH_MEMORY_CONFIG
let handler2 = null
const ctx2 = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx2)
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
      handler2 = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
const fresh = await import(`../index.js?fresh=${Date.now()}`)
fresh.apply(ctx2)
async function call2(method, payload) {
  const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0)
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body
    },
  }
  let text = ''
  const res = {
    writeHead() {},
    end(chunk) {
      text = String(chunk ?? '')
    },
  }
  await handler2(req, res)
  return JSON.parse(text || '{}')
}
const plain = await call2('POST', { op: 'config.get' })
expect(
  '默认模式 configFile 在数据目录内',
  plain.configFile,
  (v) => v === path.join(plain.dataDir, 'config.json'),
  '配置文件应随数据目录，不落别处',
)

await fs.rm(tmpRoot, { recursive: true, force: true })
console.log(failures.length ? `\nHOST SMOKE FAILED: ${failures.join(', ')}` : '\nHOST SMOKE OK')
process.exit(failures.length ? 1 : 0)
