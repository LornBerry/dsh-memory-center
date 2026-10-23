/**
 * 备份生命周期自测：`node dev/backups.test.mjs`
 *
 * 覆盖评审里的三条：
 *   1. 同类备份超过上限时只留最近的（默认 5 份），且留下的一定是最新的；
 *   2. 老版本散在数据目录根下的 store.json.corrupt-* 会被挪进 backups/；
 *   3. 清理只动 backups/ 里的三类文件，store.json 等数据文件一个都不碰。
 *
 * 全程在临时目录里跑（DSH_MEMORY_DIR 指过去），不碰真实记忆库。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-backup-'))
process.env.DSH_MEMORY_DIR = root
delete process.env.DSH_MEMORY_CONFIG

const fails = []
function ok(name, cond, actual = '') {
  if (cond) {
    console.log(`ok   ${name}${actual ? ` = ${actual}` : ''}`)
  } else {
    console.log(`FAIL ${name}${actual ? ` = ${actual}` : ''}`)
    fails.push(name)
  }
}

const backupDir = path.join(root, 'backups')
await fs.mkdir(backupDir, { recursive: true })

const base = Date.parse('2024-01-01T00:00:00Z')
const stamps = []
for (let index = 0; index < 6; index += 1) {
  const stamp = `2024-01-01T00-00-0${index}-000Z`
  stamps.push(stamp)
  const file = path.join(backupDir, `corrupt-${stamp}.json`)
  await fs.writeFile(file, '{"broken":true}', 'utf8')
  const when = new Date(base + index * 60_000)
  await fs.utimes(file, when, when)
}

// 老版本留在数据目录根下的备份，应该被 ensureLoaded 挪进 backups/
const legacyName = 'store.json.corrupt-2023-12-31T23-59-59-000Z.json'
await fs.writeFile(path.join(root, legacyName), '{"older":true}', 'utf8')

// 一个真实数据文件，清理时绝对不能动
await fs.writeFile(path.join(root, 'store.json'), JSON.stringify({ version: 1, groups: [], items: [] }), 'utf8')
await fs.writeFile(path.join(root, 'sessions.json'), '{}', 'utf8')

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

const listBackups = async () => {
  try {
    return (await fs.readdir(backupDir)).filter((name) => /^(corrupt|pre-switch|pre-purge)-/.test(name))
  } catch {
    return []
  }
}

/* ---------------------------------------------------------------- 1. 加载时 */

await call({ op: 'state' })

const rootLeft = (await fs.readdir(root)).filter((name) => name.startsWith('store.json.'))
ok('根目录残留的老备份被挪走', rootLeft.length === 0, rootLeft.join(',') || '(空)')

const afterLoad = await listBackups()
ok('加载后同类备份被裁到 5 份', afterLoad.length === 5, `${afterLoad.length} 份`)

const kept = afterLoad.filter((name) => name.startsWith('corrupt-')).sort()
const newest = `corrupt-${stamps[5]}.json`
ok('保留的是最新的那几份', kept.includes(newest), kept.join(','))
ok('最老的一份被删掉', !kept.includes(`corrupt-${stamps[0]}.json`), `最老=${stamps[0]}`)

/* ------------------------------------------------------------ 2. 手动裁剪 */

const pruned = await call({ op: 'backups.prune', keep: 2 })
const afterPrune = await listBackups()
ok('backups.prune 能按 keep 裁剪', afterPrune.length === 2, `${afterPrune.length} 份`)
ok('prune 返回的消息带数量', typeof pruned.message === 'string' && pruned.message.length > 0, pruned.message)

/* ------------------------------------------------------------ 3. 全量清理 */

const cleared = await call({ op: 'backups.clear' })
ok('backups.clear 清空三类备份', (await listBackups()).length === 0, `${(await listBackups()).length} 份`)
ok('clear 返回的消息带数量', typeof cleared.message === 'string', cleared.message)
ok('store.json 没有被清理碰到', await fs.stat(path.join(root, 'store.json')).then(() => true).catch(() => false))
ok('sessions.json 没有被清理碰到', await fs.stat(path.join(root, 'sessions.json')).then(() => true).catch(() => false))

/* ------------------------------------------------------- 4. 前缀可被识别 */

const info = await call({ op: 'config.get' })
ok('config.get 带备份概况', info.backups && info.backups.count === 0, JSON.stringify(info.backups))
ok('config.get 带保留份数', info.backupKeep === 5, String(info.backupKeep))

await fs.rm(root, { recursive: true, force: true })

if (fails.length) {
  console.error(`\nBACKUPS FAILED：${fails.length} 项\n`)
  process.exit(1)
}
console.log('\nBACKUPS OK\n')
