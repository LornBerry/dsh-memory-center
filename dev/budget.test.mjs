/**
 * 注入预算自测（不启动 DSH）：假 ctx + 假 req/res，直接调真实路由。
 *
 *   node dev/budget.test.mjs
 *
 * 覆盖「记忆太多怎么办」的核心约定：
 *   1. 预算内全量展开，不出现「未展开」段；
 *   2. 超预算时按 完全锚点 → 权重锚点 → 置顶 → 越新越先 的顺序装，装不下的退化成标题索引；
 *   3. 完全锚点即使很靠后也必须进正文（不能被普通条目挤掉）；
 *   4. 任何条目都不会被从中间截断（正文完整出现）；
 *   5. 注入文本本身不超过上限，且给出 memory_search 提示。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-budget-'))
const dataDir = path.join(tmpRoot, 'data')
await fs.mkdir(dataDir, { recursive: true })

process.env.DSH_MEMORY_DIR = dataDir
process.env.DSH_MEMORY_MAX_CHARS = '2500'
process.env.DSH_MEMORY_CONFIG = path.join(tmpRoot, 'pointer.json')

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

const failures = []
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(actual).slice(0, 120)}${ok ? '' : `  (${hint})`}`)
  if (!ok) failures.push(label)
}

const sessionId = 'session-budget-test'

// 清掉种子数据，只留自己造的条目
const seeded = await call({ op: 'state' })
for (const item of seeded.items) await call({ op: 'item.delete', ids: [item.id] })
for (const group of seeded.groups) await call({ op: 'group.delete', id: group.id, mode: 'keep' })

// 造 12 条：每条正文约 480 字符，合计远超 2500 上限
const big = (tag) => `${tag}：` + '这是一段用来占预算的记忆正文，里面写了一些具体约定与边界条件。'.repeat(12)
const created = []
for (let i = 0; i < 12; i += 1) {
  const res = await call({ op: 'item.create', title: `预算条目 ${i + 1}`, body: big(`BODY-${i + 1}`) })
  created.push({ id: res.focusId, title: `预算条目 ${i + 1}`, body: big(`BODY-${i + 1}`) })
}
await call({ op: 'session.set', sessionId, mode: 'all' })

const state = await call({ op: 'state', sessionId })
expect('injection 有统计', Boolean(state.injection), (v) => v === true, 'snapshot 应带 injection')
expect('总条数 12', state.injection.total, (v) => v === 12, '见 stats.total')
expect('进入索引模式', state.injection.indexMode, (v) => v === true, '超预算应有条目退化成标题')
expect('有条目未展开', state.injection.dropped, (v) => v > 0, '应丢弃部分条目')
expect('预览不超上限', state.preview.length <= 2500, (v) => v === true, `实际 ${state.preview.length}`)
expect('给出检索提示', state.preview.includes('memory_search'), (v) => v === true, '应提示用 memory_search 取全文')
expect('有未展开小节', state.preview.includes('未展开的记忆'), (v) => v === true, '应列出只有标题的条目')

// 压缩阈值：默认取上限的 80%，超过就压缩（不等撑满 100%）
expect('压缩线 = 上限 × 80%', state.injection.softLimit, (v) => v === 2000, '2500 × 0.8 应等于 2000')
expect('ratio 默认 0.8', state.injection.ratio, (v) => v === 0.8, '未设 DSH_MEMORY_COMPRESS_RATIO 时默认 0.8')
expect('软上限低于硬上限', state.injection.softLimit < state.injection.limit, (v) => v === true, '压缩线应留出 20% 余量')
expect('标记为已压缩', state.injection.compressed, (v) => v === true, '超过压缩线时应压缩')

// 被展开的条目正文必须完整（不允许半条）
const keptCount = state.injection.kept
const fullyPresent = created.filter((item) => state.preview.includes(item.body))
expect('展开的条数 = 完整出现的条数', fullyPresent.length, (v) => v === keptCount, `完整出现 ${fullyPresent.length} / kept ${keptCount}`)

// 完全锚点：把最靠后的一条升成完全锚点，它必须进正文
const last = created[created.length - 1]
await call({ op: 'item.update', id: last.id, patch: { anchorMode: 'full' } })
const withAnchor = await call({ op: 'state', sessionId })
expect('完全锚点进了正文', withAnchor.preview.includes(last.body), (v) => v === true, '完全锚点不应被预算挤掉')
expect('锚点计数 = 1', withAnchor.injection.anchors >= 1, (v) => v === true, 'anchors 应统计到')

// 面板拖条：budget.set 立即生效并写进 config.json
const beforeRatio = withAnchor.injection.softLimit
const tighter = await call({ op: 'budget.set', ratio: 0.5 })
expect('budget.set 成功', tighter.ok, (v) => v === true, '应返回快照')
expect('阈值改 0.5 后压缩线', tighter.injection.softLimit, (v) => v === 1250, '2500 × 0.5')
expect('压缩线确实变小', tighter.injection.softLimit < beforeRatio, (v) => v === true, '应比 0.8 时更小')
const savedConfig = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'))
expect('config.json 记住 injectRatio', savedConfig.injectRatio, (v) => v === 0.5, '应持久化到数据目录的 config.json')
const invalid = await call({ op: 'budget.set', ratio: 3 })
expect('非法阈值被拒', invalid.ok, (v) => v === false, '超出 0.1–1 应报错')
const restored = await call({ op: 'budget.set', ratio: 0.8 })
expect('改回 0.8', restored.injection.softLimit, (v) => v === 2000, '恢复默认压缩线')

// 预算放大后应全部展开（重新导入一份模块，环境变量在模块加载时读取）
process.env.DSH_MEMORY_MAX_CHARS = '100000'
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
const fresh = await import(`../index.js?big=${Date.now()}`)
fresh.apply(ctx2)
if (typeof handler2 !== 'function') throw new Error('第二份模块没有注册路由')

async function call2(payload) {
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
  await handler2(req, res)
  return JSON.parse(text || '{}')
}
const wide = await call2({ op: 'state', sessionId })
expect('预算放宽后不再索引', wide.injection.indexMode, (v) => v === false, '预算足够应全量展开')
expect('预算放宽后 kept = total', wide.injection.kept, (v) => v === wide.injection.total, '全部展开')
expect('预算放宽后未压缩', wide.injection.compressed, (v) => v === false, '没超过压缩线就不该压缩')
expect('放宽后压缩线同步放大', wide.injection.softLimit, (v) => v === 80000, '100000 × 0.8')

// 阈值可调：换成 50% 后压缩线应跟着变
process.env.DSH_MEMORY_COMPRESS_RATIO = '0.5'
let handler3 = null
const ctx3 = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx3)
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
      handler3 = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
const half = await import(`../index.js?ratio=${Date.now()}`)
half.apply(ctx3)
async function call3(payload) {
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
  await handler3(req, res)
  return JSON.parse(text || '{}')
}
const halfState = await call3({ op: 'state', sessionId })
expect('阈值 0.5 时的压缩线', halfState.injection.softLimit, (v) => v === 50000, '100000 × 0.5')
expect('阈值 0.5 时的 ratio', halfState.injection.ratio, (v) => v === 0.5, '应读到环境变量')
delete process.env.DSH_MEMORY_COMPRESS_RATIO

await fs.rm(tmpRoot, { recursive: true, force: true })

if (failures.length) {
  console.log(`\nBUDGET FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nBUDGET OK')
