/**
 * 导出/导入往返：锚点与时间戳必须跟着走。
 *
 *   node dev/import-anchor.test.mjs
 *
 * 背景（第二轮审查 A 级）：export 曾经只导 title/body/tags/…，丢掉 anchorMode/anchorSource/anchorWhy；
 * planImport 又把 createdAt/updatedAt 全写成 nowIso()。结果换设备后「完全锚点」降级成普通记忆、
 * 时间线被抹平（进而影响「越新越先」的注入顺序）。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const ROOT = 'C:/Users/20408/Documents/deepseek-harness/default-workspace/dsh-memory-center'
const OLD_TIME = '2026-03-01T00:00:00.000Z'

function fixtureItem(over) {
  return Object.assign({
    id: 'm-fix1',
    title: '旧结论',
    body: '记忆放 C 盘。',
    tags: [],
    groupId: null,
    enabled: true,
    pinned: false,
    status: 'active',
    source: 'manual',
    anchorMode: 'off',
    anchorSource: 'inferred',
    anchorWhy: '没有强弱措辞，按普通事实处理',
    order: 0,
    createdAt: OLD_TIME,
    updatedAt: OLD_TIME,
  }, over)
}

async function boot(dir, tag) {
  process.env.DSH_MEMORY_DIR = dir
  delete process.env.DSH_MEMORY_CONFIG
  const mod = await import(`file:///${ROOT}/index.js?${tag}=${Date.now()}`)
  const state = { handler: null }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(_names, cb) { cb(ctx) },
    on() {},
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register(route) { state.handler = route.handler; return () => {} } },
    tools: { register() {} },
    systemPrompt: { section() {} },
  }
  mod.apply(ctx)
  async function call(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield body },
    }
    let text = ''
    const res = { writeHead() {}, end(chunk) { text = String(chunk ?? '') } }
    await state.handler(req, res)
    return JSON.parse(text || '{}')
  }
  return { call }
}

const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-exp-a-'))
const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-exp-b-'))
const dirC = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-exp-c-'))

const prevDir = process.env.DSH_MEMORY_DIR
const prevCfg = process.env.DSH_MEMORY_CONFIG
delete process.env.DSH_MEMORY_CONFIG

// A：直接铺一个「老库」，一条手动完全锚点、一条三个月前的旧结论
await fs.writeFile(
  path.join(dirA, 'store.json'),
  JSON.stringify({
    version: 1,
    updatedAt: '2026-06-01T00:00:00.000Z',
    groups: [],
    deleted: [],
    items: [
      fixtureItem({
        id: 'm-full1',
        title: '部署纪律',
        body: '必须先在本地跑完测试。',
        anchorMode: 'full',
        anchorSource: 'user',
        anchorWhy: '手动设置',
        order: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
      }),
      fixtureItem({ order: 1 }),
      fixtureItem({ id: 'm-del1', title: '已删除的旧记忆', order: 2, deletedAt: OLD_TIME, updatedAt: OLD_TIME }),
    ],
  }),
  'utf8',
)

const a = await boot(dirA, 'a')
const exported = await a.call({ op: 'export' })
const payload = exported.json
expect('导出里有锚点字段', payload.includes('"anchorMode"'), (v) => v === true, payload.slice(0, 80))
expect('导出里有旧时间戳', payload.includes(OLD_TIME), (v) => v === true, '时间应原样出现在导出里')

// B：空库导入
const b = await boot(dirB, 'b')
const applied = await b.call({ op: 'import.apply', payload })
expect('导入成功', applied.ok, (v) => v === true, JSON.stringify(applied).slice(0, 160))
const items = (applied.items || []).filter((item) => item.status === 'active')
const discipline = items.find((item) => item.title === '部署纪律')
const legacy = items.find((item) => item.title === '旧结论')
expect('锚点跟着搬过来（完全锚点）', discipline && discipline.anchorMode, (v) => v === 'full', JSON.stringify(discipline))
expect('手动锚点仍标记为用户设定', discipline && discipline.anchorSource, (v) => v === 'user', '不应降级成 inferred')
expect('更新时间没有被抹平', legacy && legacy.updatedAt, (v) => v === OLD_TIME, JSON.stringify(legacy && legacy.updatedAt))
expect('创建时间也没有被抹平', discipline && discipline.createdAt, (v) => v === '2026-05-01T00:00:00.000Z', JSON.stringify(discipline && discipline.createdAt))

// C：老导出文件（没有锚点字段）应当按内容重判，而不是硬编码 off
const c = await boot(dirC, 'c')
const applied2 = await c.call({
  op: 'import.apply',
  payload: JSON.stringify({ items: [{ title: '部署纪律', body: '必须先在本地跑完测试。', tags: [] }] }),
})
const guessed = (applied2.items || []).find((item) => item.title === '部署纪律')
expect('老导出文件按内容重判为完全锚点', guessed && guessed.anchorMode, (v) => v === 'full', JSON.stringify(guessed))
expect('老导出文件的来源是 inferred', guessed && guessed.anchorSource, (v) => v === 'inferred', '')

// D：待确认候选导入后仍是待确认，不能借导入绕过「用户点头」
const dirD = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-exp-d-'))
const d = await boot(dirD, 'd')
const appliedPending = await d.call({
  op: 'import.apply',
  payload: JSON.stringify({
    items: [
      { title: '候选甲', body: '模型写的，用户还没审。', status: 'pending' },
      { title: '正式乙', body: '用户已经确认过。', status: 'active' },
    ],
  }),
})
const pendingItem = (appliedPending.items || []).find((item) => item.title === '候选甲')
const activeItem = (appliedPending.items || []).find((item) => item.title === '正式乙')
expect('导入的待确认候选仍是 pending', pendingItem && pendingItem.status, (v) => v === 'pending', JSON.stringify(pendingItem))
expect('导入的正式记忆仍是 active', activeItem && activeItem.status, (v) => v === 'active', JSON.stringify(activeItem))

// E：Markdown 导出的「未归类」不能把已删除/归档的条目带出去
const md = await a.call({ op: 'export' })
expect('Markdown 导出不含已删除条目', md.markdown.includes('已删除的旧记忆'), (v) => v === false, '回收站里的条目漏进导出了')
expect('Markdown 导出仍含正常条目', md.markdown.includes('部署纪律'), (v) => v === true, '')

for (const dir of [dirA, dirB, dirC, dirD]) await fs.rm(dir, { recursive: true, force: true })

// F：格式版本护栏——来自更新格式的文件必须拒绝，不降级解析
const dirE = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-exp-e-'))
const e = await boot(dirE, 'e')
const future = await e.call({
  op: 'import.apply',
  payload: JSON.stringify({ version: 99, items: [{ title: '未来格式', body: 'x' }] }),
})
expect('格式版本高于当前支持值时被拒', future.ok, (v) => v === false, JSON.stringify(future).slice(0, 160))
expect('拒绝理由提到版本', (future.error || '').includes('v99'), (v) => v === true, future.error || '')
const v1 = await e.call({ op: 'import.apply', payload: JSON.stringify({ version: 1, items: [{ title: '正常格式', body: 'x' }] }) })
expect('version 1 的文件仍可导入', v1.ok, (v) => v === true, JSON.stringify(v1).slice(0, 120))
await fs.rm(dirE, { recursive: true, force: true })
if (prevDir === undefined) delete process.env.DSH_MEMORY_DIR
else process.env.DSH_MEMORY_DIR = prevDir
if (prevCfg !== undefined) process.env.DSH_MEMORY_CONFIG = prevCfg

console.log(failures.length ? `\nIMPORT ANCHOR FAILED: ${failures.join(', ')}\n` : '\nIMPORT ANCHOR OK\n')
process.exit(failures.length ? 1 : 0)
