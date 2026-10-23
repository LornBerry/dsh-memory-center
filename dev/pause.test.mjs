/**
 * 暂停注入的两种粒度：
 *   - 全局：所有会话都不带记忆（injection.set { paused: true }）
 *   - 单会话：只暂停列出的会话，恢复时原样还原；原本「未决定」的会话恢复后回到未决定
 *
 *   node dev/pause.test.mjs
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-pause-'))
process.env.DSH_MEMORY_DIR = path.join(tmpRoot, 'data')
delete process.env.DSH_MEMORY_CONFIG

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

async function call(payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      yield body
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

let failed = 0
function expect(name, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) console.log(`ok   ${name} = ${JSON.stringify(actual)}`)
  else {
    failed += 1
    console.error(`FAIL ${name} = ${JSON.stringify(actual)}，期望 ${JSON.stringify(wanted)}`)
  }
}

// 初始：种子数据 + 预览非空（默认会话未决定，所以预览为空）
const init = await call({ op: 'state', sessionId: 's1' })
expect('种子条目数', init.body.stats.items >= 1, true)
expect('未决定会话不注入', init.body.preview || '', '')

// 全局暂停
const paused = await call({ op: 'injection.set', paused: true, sessionId: 's1' })
expect('全局暂停 paused', paused.body.paused, true)
expect('全局暂停后预览为空', paused.body.preview || '', '')
const resumed = await call({ op: 'injection.set', paused: false, sessionId: 's1' })
expect('恢复后 paused', resumed.body.paused, false)

// s1 选「全部加载」→ 有预览
const all = await call({ op: 'session.set', sessionId: 's1', mode: 'all' })
expect('s1 选全部后 mode', all.body.session.mode, 'all')
expect('s1 选全部后有预览', all.body.preview.length > 0, true)

// 只暂停 s1
const one = await call({ op: 'injection.set', paused: true, scope: 'sessions', sessionIds: ['s1'], sessionId: 's1' })
expect('s1 暂停后 paused', one.body.session.paused, true)
expect('s1 暂停后 mode', one.body.session.mode, 'none')
expect('s1 暂停后预览为空', one.body.preview || '', '')
expect('全局没被牵连', one.body.paused, false)
expect('pausedSessions 里有 s1', one.body.pausedSessions.map((entry) => entry.sessionId), ['s1'])

// 恢复 s1 → 回到 all
const back = await call({ op: 'injection.set', paused: false, scope: 'sessions', sessionIds: ['s1'], sessionId: 's1' })
expect('s1 恢复后 mode', back.body.session.mode, 'all')
expect('s1 恢复后 paused', back.body.session.paused, false)
expect('s1 恢复后有预览', back.body.preview.length > 0, true)

// 未决定的会话 s2：暂停 → 恢复 → 回到未决定
await call({ op: 'injection.set', paused: true, scope: 'sessions', sessionIds: ['s2'], sessionId: 's2' })
const s2paused = await call({ op: 'state', sessionId: 's2' })
expect('s2 暂停时 decided', s2paused.body.session.decided, true)
const s2back = await call({ op: 'injection.set', paused: false, scope: 'sessions', sessionIds: ['s2'], sessionId: 's2' })
expect('s2 恢复后 decided', s2back.body.session.decided, false)
expect('s2 恢复后 paused', s2back.body.session.paused, false)

// 不指定会话 → 400
const bad = await call({ op: 'injection.set', paused: true, scope: 'sessions' })
expect('缺会话时返回 400', bad.status, 400)

// 重启后暂停状态仍在（写进 sessions.json）
const rawSessions = JSON.parse(await fs.readFile(path.join(process.env.DSH_MEMORY_DIR, 'sessions.json'), 'utf8'))
expect('sessions.json 里没有残留的暂停', Object.values(rawSessions).some((s) => s.paused), false)

await fs.rm(tmpRoot, { recursive: true, force: true })
console.log(`\n${failed ? `${failed} 项失败` : 'PAUSE OK'}`)
if (failed) process.exitCode = 1
