/**
 * store.json 损坏时的恢复行为（P0-1 回归）。
 *
 *   node dev/resilience.test.mjs
 *
 * 期望：
 *   1. 第一次读到坏 JSON：500，错误里带文件路径（用户知道该改哪个文件），文件不动。
 *   2. 修好文件后再请求：200，直接读到修好的内容——不需要重启宿主。
 *   3. 如果第二次仍然坏：自动改名成 store.json.corrupt-<时间> 备份，回退空库并重建种子。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-resilience-'))
delete process.env.DSH_MEMORY_CONFIG

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

function fakeCtx(register) {
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
        register(route.handler)
        return () => {}
      },
    },
    tools: { register() {} },
    systemPrompt: { section() {} },
  }
  return ctx
}

async function callHandler(handler, method = 'GET', payload = null) {
  const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0)
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
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

/* 场景一：坏文件 → 500（带路径）→ 第二次自动备份并重建空库 */
const dirA = path.join(tmpRoot, 'a')
await fs.mkdir(dirA, { recursive: true })
process.env.DSH_MEMORY_DIR = dirA
await fs.writeFile(path.join(dirA, 'store.json'), '{"version":1,"items":[', 'utf8')

let handlerA = null
const modA = await import(`../index.js?a=${Date.now()}`)
modA.apply(fakeCtx((handler) => (handlerA = handler)))

const first = await callHandler(handlerA)
expect('坏文件第一次请求 = 500', first.status, (v) => v === 500, '应报错而不是静默清空')
expect('错误里带 store.json 路径', first.body.error, (v) => typeof v === 'string' && v.includes('store.json'), '用户要知道改哪个文件')

const second = await callHandler(handlerA)
expect('第二次请求自动恢复 = 200', second.status, (v) => v === 200, '不应永久卡死')
const backupA = (await fs.readdir(dirA)).filter((name) => name.startsWith('store.json.corrupt-'))
expect('坏文件被改名备份', backupA.length, (v) => v === 1, '应有 .corrupt- 备份')
expect('恢复后建了空库种子', second.body.items?.length, (v) => v >= 3, '应重建种子')

/* 场景二：第一次 500 之后把文件修好，下一次请求直接读到修好的内容（无需重启） */
const dirB = path.join(tmpRoot, 'b')
await fs.mkdir(dirB, { recursive: true })
process.env.DSH_MEMORY_DIR = dirB
await fs.writeFile(path.join(dirB, 'store.json'), 'not json', 'utf8')

let handlerB = null
const modB = await import(`../index.js?b=${Date.now()}`)
modB.apply(fakeCtx((handler) => (handlerB = handler)))

const brokenB = await callHandler(handlerB)
expect('修好前请求 = 500', brokenB.status, (v) => v === 500, '应报错')

const fixedAt = new Date().toISOString()
await fs.writeFile(
  path.join(dirB, 'store.json'),
  JSON.stringify({
    version: 1,
    updatedAt: fixedAt,
    groups: [],
    items: [
      { id: 'm-fixed', title: '修好了', body: '不用重启', tags: [], groupId: null, enabled: true, pinned: false, status: 'active', source: 'manual', order: 0, createdAt: fixedAt, updatedAt: fixedAt },
    ],
    deleted: [],
  }),
  'utf8',
)

const repaired = await callHandler(handlerB)
expect('修好文件后无需重启 = 200', repaired.status, (v) => v === 200, '应读到修好的内容')
expect('读到修好的条目', repaired.body.items?.[0]?.title, (v) => v === '修好了', '应读到修复后的库')
const backupB = (await fs.readdir(dirB)).filter((name) => name.startsWith('store.json.corrupt-'))
expect('文件修好后不再产生备份', backupB.length, (v) => v === 0, '应直接读成功')

await fs.rm(tmpRoot, { recursive: true, force: true })
console.log(failures.length ? `\nRESILIENCE FAILED: ${failures.join(', ')}` : '\nRESILIENCE OK')
process.exit(failures.length ? 1 : 0)
