/**
 * 首装样例的播种契约：固定 id、每台机器只播一次。
 *
 *   node dev/seed.test.mjs
 *
 * 为什么单独测：
 * - 种子 id 若随机，两台设备各自播种后合并没法按 id 对齐，样例会变成两份；
 * - 播种若只看「库是空的」，用户把库删干净以后重启又会长回来。
 * 这两条都不是 UI 行为，直接跑真 index.js 才能验。
 */

import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-seed-'))
const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
const pointer = path.join(tmpRoot, 'pointer.json')

// 子进程：用假 ctx 加载真实 index.js，取一次 state，把条目/文件夹 id 打出来。
const CHILD = `
const mod = await import(${JSON.stringify(pathToFileURL(indexPath).href)})
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) { cb(ctx) },
  on() {},
  effect(fn) { return fn() },
  get() { return undefined },
  webServer: {
    register(route) {
      ctx.handler = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
mod.apply(ctx)
const body = Buffer.from(JSON.stringify({ op: 'state', sessionId: 'seed-test' }), 'utf8')
const req = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() { yield body },
}
let text = ''
const res = { writeHead() {}, end(chunk) { text = String(chunk ?? '') } }
await ctx.handler(req, res)
const state = JSON.parse(text || '{}')
console.log(JSON.stringify({
  items: (state.items || []).map((item) => ({ id: item.id, title: item.title })),
  groups: (state.groups || []).map((group) => ({ id: group.id, name: group.name })),
}))
`

function runIn(dir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: dir,
    env: {
      ...process.env,
      DSH_MEMORY_DIR: dir,
      DSH_MEMORY_CONFIG: pointer,
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`子进程失败：${result.stderr || result.stdout}`)
  }
  const line = result.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const dirA = path.join(tmpRoot, 'a')
const dirB = path.join(tmpRoot, 'b')
await fs.mkdir(dirA, { recursive: true })
await fs.mkdir(dirB, { recursive: true })

const firstA = runIn(dirA)
expect('首装播 3 条样例', firstA.items.length, (v) => v === 3)
expect(
  '种子条目用固定 id',
  firstA.items.map((item) => item.id).join(','),
  (v) => v === 'm-seed-1,m-seed-2,m-seed-3',
  '随机 id 会让两台设备的样例合并后翻倍',
)
expect('种子文件夹用固定 id', firstA.groups[0] && firstA.groups[0].id, (v) => v === 'g-seed', '文件夹重复会让条目跑错容器')

const firstB = runIn(dirB)
expect(
  '另一台设备播出的条目 id 完全相同',
  firstB.items.map((item) => item.id).join(','),
  (v) => v === firstA.items.map((item) => item.id).join(','),
)
expect('另一台设备的文件夹 id 相同', firstB.groups[0] && firstB.groups[0].id, (v) => v === 'g-seed')

const configA = JSON.parse(await fs.readFile(path.join(dirA, 'config.json'), 'utf8'))
expect('config.json 记下 seeded=true', configA.seeded, (v) => v === true, '没记的话重启会再播一次')

// 模拟用户把库删干净（彻底删除，不是软删除）：清空 items / groups 后重启。
const storeA = JSON.parse(await fs.readFile(path.join(dirA, 'store.json'), 'utf8'))
storeA.items = []
storeA.groups = []
await fs.writeFile(path.join(dirA, 'store.json'), JSON.stringify(storeA, null, 2), 'utf8')
const afterPurge = runIn(dirA)
expect('库删干净后重启，不再自动播种', afterPurge.items.length, (v) => v === 0, '样例不该自己长回来')

await fs.rm(tmpRoot, { recursive: true, force: true })

if (failures.length) {
  console.error(`SEED FAIL: ${failures.join('、')}`)
  process.exit(1)
}
console.log('SEED OK')
