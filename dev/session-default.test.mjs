/**
 * 新会话默认加载策略 + 注入上限自测（不启动 DSH）：
 *
 *   node dev/session-default.test.mjs
 *
 * 为什么有这个测试：用户抱怨「每次开新会话都要被问一次」和「注入上限不能调」。
 * 加了 session.default 与 budget.set{maxChars} 之后，这两处都属于「改错了会静默失效」
 * 的类型（默认值写错 = 新会话永远不带记忆；上限没生效 = 压缩线算错），所以用真实
 * HTTP 处理函数跑一遍。
 *
 * 全程用临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) {
    console.log(`ok   ${label} = ${JSON.stringify(actual)}`)
  } else {
    failures += 1
    console.log(`FAIL ${label} = ${JSON.stringify(actual)}${hint ? `  (${hint})` : ''}`)
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-session-'))
process.env.DSH_MEMORY_DIR = tmpRoot
delete process.env.DSH_MEMORY_CONFIG
delete process.env.DSH_MEMORY_MAX_CHARS
delete process.env.DSH_MEMORY_COMPRESS_RATIO

const stamp = '2026-10-23T06:00:00.000Z'
const store = {
  version: 1,
  updatedAt: stamp,
  groups: [
    { id: 'g-a', name: '约定', order: 0, createdAt: stamp },
    { id: 'g-b', name: '习惯', order: 1, createdAt: stamp },
  ],
  deleted: [],
  items: [
    {
      id: 'm-a1', title: 'A 文件夹的第一条', body: '正文 A_ONE', tags: [], groupId: 'g-a',
      enabled: true, pinned: false, status: 'active', source: 'manual', sessionId: null,
      anchorMode: 'off', order: 0, createdAt: stamp, updatedAt: stamp,
      deletedAt: null, archivedAt: null, mergedInto: null,
    },
    {
      id: 'm-b1', title: 'B 文件夹的第一条', body: '正文 B_ONE', tags: [], groupId: 'g-b',
      enabled: true, pinned: false, status: 'active', source: 'manual', sessionId: null,
      anchorMode: 'off', order: 1, createdAt: stamp, updatedAt: stamp,
      deletedAt: null, archivedAt: null, mergedInto: null,
    },
    {
      id: 'm-free', title: '未归类的一条', body: '正文 FREE_ONE', tags: [], groupId: null,
      enabled: true, pinned: false, status: 'active', source: 'manual', sessionId: null,
      anchorMode: 'off', order: 2, createdAt: stamp, updatedAt: stamp,
      deletedAt: null, archivedAt: null, mergedInto: null,
    },
  ],
}
await fs.writeFile(path.join(tmpRoot, 'store.json'), JSON.stringify(store, null, 2), 'utf8')

let handler = null
const makeCtx = () => {
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
  return ctx
}

const fresh = await import(`../index.js?sessionDefault=${Date.now()}`)
fresh.apply(makeCtx())
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

const sid = 'session-default-test'

/* --------------------------------------------- 1. 默认「每次都问」：不注入、要问 */
const ask = await call({ op: 'state', sessionId: sid })
expect('默认 sessionDefault.mode = ask', ask.sessionDefault && ask.sessionDefault.mode, 'ask')
expect('默认下 session.decided = false（会弹卡片）', ask.session && ask.session.decided, false)
expect('默认下不注入任何记忆', /A_ONE|B_ONE|FREE_ONE/.test(ask.preview || ''), false)

/* ------------------------------------------------- 2. 默认「全部加载」：自动生效 */
const setAll = await call({ op: 'session.default', mode: 'all', sessionId: sid })
expect('session.default all 成功', setAll.ok, true)
const all = await call({ op: 'state', sessionId: sid })
expect('默认 all 后 decision 生效', all.session && all.session.decided, true)
expect('默认 all 后 inherited = true', all.session && all.session.inherited, true)
expect(
  '默认 all 后注入三条的正文',
  ['A_ONE', 'B_ONE', 'FREE_ONE'].every((word) => (all.preview || '').includes(word)),
  true,
)
expect('快照里 sessionDefault.mode = all', all.sessionDefault.mode, 'all')

/* ------------------------------------------------ 3. 默认「不加载」：一条都不带 */
await call({ op: 'session.default', mode: 'none', sessionId: sid })
const none = await call({ op: 'state', sessionId: sid })
expect('默认 none 时 decided = true', none.session && none.session.decided, true)
expect('默认 none 时不注入', /A_ONE|B_ONE|FREE_ONE/.test(none.preview || ''), false)

/* --------------------------------------- 4. 默认「指定文件夹」：只带该文件夹的条目 */
const setCustom = await call({ op: 'session.default', mode: 'custom', groupIds: ['g-b'], sessionId: sid })
expect('session.default custom 成功', setCustom.ok, true)
const custom = await call({ op: 'state', sessionId: sid })
expect('默认 custom 只带 B 文件夹', /B_ONE/.test(custom.preview || ''), true)
expect('默认 custom 不带 A 文件夹', /A_ONE/.test(custom.preview || ''), false)
expect('默认 custom 不带未归类', /FREE_ONE/.test(custom.preview || ''), false)

/* --------------------------------------------- 5. 本会话自己的选择覆盖全局默认 */
await call({ op: 'session.set', sessionId: sid, mode: 'none' })
const own = await call({ op: 'state', sessionId: sid })
expect('本会话选择覆盖默认：不注入', /B_ONE/.test(own.preview || ''), false)
expect('本会话选择后 inherited = false', own.session && own.session.inherited, false)
await call({ op: 'session.reset', sessionId: sid })
const back = await call({ op: 'state', sessionId: sid })
expect('清除本会话选择后回到默认（又带 B）', /B_ONE/.test(back.preview || ''), true)

/* --------------------------------------------------------- 6. 非法参数必须被拒 */
const badCustom = await call({ op: 'session.default', mode: 'custom', groupIds: [], sessionId: sid })
expect('custom 但没选文件夹被拒', badCustom.ok, false, '否则等于静默不加载')
const badGroup = await call({ op: 'session.default', mode: 'custom', groupIds: ['g-missing'], sessionId: sid })
expect('未知文件夹被拒', badGroup.ok, false)
const badMode = await call({ op: 'session.default', mode: 'whatever', sessionId: sid })
expect('未知 mode 回落为 ask 而不是报错', badMode.sessionDefault && badMode.sessionDefault.mode, 'ask')
// 上一步会把默认改回 ask，这里恢复成 custom，后面的持久化断言才有意义
await call({ op: 'session.default', mode: 'custom', groupIds: ['g-b'], sessionId: sid })

/* ------------------------------------------------ 7. 注入上限：改得动、算得对 */
const setMax = await call({ op: 'budget.set', maxChars: 4000, sessionId: sid })
expect('budget.set maxChars 成功', setMax.ok, true)
expect('maxChars 生效为 4000', setMax.injection && setMax.injection.limit, 4000)
expect('压缩线按 80% 重算 = 3200', setMax.injection && setMax.injection.softLimit, 3200)

const setBoth = await call({ op: 'budget.set', ratio: 0.5, maxChars: 6000, sessionId: sid })
expect('同时改两个值成功', setBoth.ok, true)
expect(
  '上限 6000 / 压缩线 3000',
  [setBoth.injection.limit, setBoth.injection.softLimit].join(','),
  '6000,3000',
)

const badMax = await call({ op: 'budget.set', maxChars: 500, sessionId: sid })
expect('过小的上限被拒', badMax.ok, false)
const emptyPatch = await call({ op: 'budget.set', sessionId: sid })
expect('两个值都不给被拒', emptyPatch.ok, false)

/* --------------------------------------------------- 8. 落到 config.json，重启还在 */
const config = JSON.parse(await fs.readFile(path.join(tmpRoot, 'config.json'), 'utf8'))
expect('config.json 记住 maxChars', config.maxChars, 6000)
expect('config.json 记住 injectRatio', config.injectRatio, 0.5)
expect('config.json 记住 sessionDefault.mode', config.sessionDefault && config.sessionDefault.mode, 'custom')
expect(
  'config.json 记住 sessionDefault.groupIds',
  (config.sessionDefault && config.sessionDefault.groupIds || []).join(','),
  'g-b',
)

const reloaded = await import(`../index.js?sessionDefaultReload=${Date.now()}`)
let handler2 = null
const ctx2 = makeCtx()
const originalRegister = ctx2.webServer.register
ctx2.webServer.register = (route) => {
  handler2 = route.handler
  return originalRegister(route)
}
reloaded.apply(ctx2)
if (typeof handler2 !== 'function') throw new Error('重载后路由没有注册')
const oldHandler = handler
handler = handler2
const after = await call({ op: 'config.get' })
expect('重载后 maxChars 从 config.json 读回', after.maxChars, 6000)
expect('重载后 injectRatio 读回', after.injectRatio, 0.5)
const afterState = await call({ op: 'state', sessionId: sid })
expect('重载后 sessionDefault 仍是 custom', afterState.sessionDefault.mode, 'custom')
expect('重载后默认仍带 B 文件夹', /B_ONE/.test(afterState.preview || ''), true)
handler = oldHandler

await fs.rm(tmpRoot, { recursive: true, force: true })

if (failures) {
  console.log(`\nSESSION DEFAULT FAILED：${failures} 项`)
  process.exit(1)
}
console.log('\nSESSION DEFAULT OK')
