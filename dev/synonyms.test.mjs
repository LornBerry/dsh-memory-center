/**
 * 同义词自定义的宿主半自测（不启动 DSH）：
 *
 *   node dev/synonyms.test.mjs
 *
 * 覆盖：保存后立即参与检索（不用重启）、非法输入被拒、能清空、
 * config.json 记住、重载后仍生效。全程临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-synonyms-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG
delete process.env.DSH_MEMORY_CONFIG

const mod = await import('../index.js')

let handler = null
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
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) {
    console.log(`ok   ${label} = ${JSON.stringify(actual)}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label} = ${JSON.stringify(actual)}  ${hint ? `(${hint})` : ''}`)
  }
}

// 先放一条正常记忆，用来验证检索
await call({
  op: 'item.create',
  title: '记忆库的路径怎么改',
  body: '在面板的「存储位置」里可以改数据目录。',
  tags: '存储',
})

// 1) 默认没有自定义同义词
const before = await call({ op: 'config.get' })
console.log(`[debug] config.get = ${JSON.stringify(before).slice(0, 600)}`)
expect('初始自定义同义词为空', (before.synonyms || []).length, 0)
expect('内置同义词组可用', Array.isArray(before.builtinSynonyms) && before.builtinSynonyms.length > 0, true)

// 2) 没配之前，用自定义词查不到
const missBefore = await call({ op: 'search', query: '坚果云' })
expect('未配置时「坚果云」查不到', missBefore.hits.length, 0)

// 3) 保存一组自定义同义词，立即生效
const saved = await call({
  op: 'synonyms.set',
  groups: [['坚果云', '存储位置'], ['存哪里', '存储位置']],
})
expect('保存返回 ok', saved.ok, true)
expect('保存后回显 2 组', (saved.synonyms || []).length, 2)
const hitAfter = await call({ op: 'search', query: '坚果云' })
expect(
  '保存后「坚果云」能命中存储位置那条',
  (hitAfter.hits || []).some((hit) => hit.title.includes('路径')),
  true,
  JSON.stringify(hitAfter.hits),
)

// 4) 落盘到 config.json
const cfg = JSON.parse(await fs.readFile(path.join(tmpRoot, 'config.json'), 'utf8'))
expect('config.json 记住两组', (cfg.synonyms || []).length, 2)

// 5) 非法输入被拒（字符串、只有单个词的组过滤后为空）
const bad = await call({ op: 'synonyms.set', groups: '坚果云 存储位置' })
expect('字符串入参被拒', bad.ok, false)
const afterBad = await call({ op: 'config.get' })
expect('非法输入不覆盖已有配置', (afterBad.synonyms || []).length, 2)

// 6) 单词组会被丢掉，不报错
const partial = await call({ op: 'synonyms.set', groups: [['只有一个词'], ['甲', '乙']] })
expect('单词组被丢弃', (partial.synonyms || []).length, 1)

// 7) 清空
const cleared = await call({ op: 'synonyms.set', groups: [] })
expect('可以清空', (cleared.synonyms || []).length, 0)
const missAgain = await call({ op: 'search', query: '坚果云' })
expect('清空后「坚果云」又查不到', missAgain.hits.length, 0)

// 8) 重载后仍生效
await call({ op: 'synonyms.set', groups: [['坚果云', '存储位置']] })
const fresh = await import(`../index.js?syn=${Date.now()}`)
let handler2 = null
const ctx2 = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_names, cb) {
    cb(ctx2)
  },
  on() {},
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: {
    register(route) {
      handler2 = route.handler
      return () => {}
    },
  },
  tools: { register() {} },
  systemPrompt: { section() {} },
}
fresh.apply(ctx2)
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
const reloaded = await call2({ op: 'search', query: '坚果云' })
expect(
  '重载后同义词仍生效',
  (reloaded.hits || []).some((hit) => hit.title.includes('路径')),
  true,
  JSON.stringify(reloaded.hits),
)

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(failures.length ? `\nSYNONYMS FAILED: ${failures.join(', ')}\n` : '\nSYNONYMS OK\n')
process.exit(failures.length ? 1 : 0)
