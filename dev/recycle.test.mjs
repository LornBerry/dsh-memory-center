/**
 * 回收站与批量打标的宿主半自测（不启动 DSH）：
 *
 *   node dev/recycle.test.mjs
 *
 * 覆盖：删除 = 先进回收站（数据还在 store.json 里）、恢复、彻底删除才写墓碑、
 * 回收站条目不再参与注入、批量打标是「并入」而不是「覆盖」。
 * 全程用临时目录，不碰真实记忆库。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-recycle-'))
process.env.DSH_MEMORY_DIR = tmpRoot
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

const storeFile = path.join(tmpRoot, 'store.json')
const readStore = async () => JSON.parse(await fs.readFile(storeFile, 'utf8'))

// 0) 初始状态
const initial = await call({ op: 'state', sessionId: 's-1' })
expect('初始没有回收站条目', initial.body.deleted?.length, (v) => v === 0, 'deleted 应为空数组')

// 1) 新建 → 删除 → 进回收站，文件里仍然在
const created = await call({ op: 'item.create', title: '会被软删的条目', body: '正文', tags: '原标签' })
const id = created.body.focusId
const afterCreate = await call({ op: 'state', sessionId: 's-1' })
expect('新建后出现在列表', afterCreate.body.items.some((item) => item.id === id), (v) => v === true, '找不到新建条目')

const deleted = await call({ op: 'item.delete', ids: [id] })
expect('删除后不在列表', deleted.body.items.some((item) => item.id === id), (v) => v === false, '列表里还有')
expect('删除后进回收站', deleted.body.deleted.some((item) => item.id === id), (v) => v === true, '回收站里没有')
expect('提示里说明可恢复', String(deleted.body.message).includes('回收站'), (v) => v === true, deleted.body.message)

const storedAfterDelete = (await readStore()).items.find((item) => item.id === id)
expect('store.json 里数据仍在', Boolean(storedAfterDelete), (v) => v === true, '被物理删除了')
expect('store.json 里带 deletedAt', Boolean(storedAfterDelete?.deletedAt), (v) => v === true, '没有 deletedAt 标记')

// 2) 回收站里的条目不参与注入
const session = await call({ op: 'session.set', sessionId: 's-1', mode: 'all' })
expect('删除后注入预览不含它', String(session.body.preview || '').includes('会被软删的条目'), (v) => v === false, '回收站条目还被注入')

// 3) 恢复
const restored = await call({ op: 'item.restore', ids: [id], sessionId: 's-1' })
expect('恢复后回到列表', restored.body.items.some((item) => item.id === id), (v) => v === true, '没回到列表')
expect('恢复后回收站为空', restored.body.deleted.length, (v) => v === 0, '回收站还有残留')
expect('恢复后重新参与注入', String(restored.body.preview || '').includes('会被软删的条目'), (v) => v === true, '预览里没有')

// 4) 彻底删除：真的消失 + 写墓碑
await call({ op: 'item.delete', ids: [id] })
const purged = await call({ op: 'recycle.purge', ids: [id] })
expect('彻底删除后列表里没有', purged.body.items.some((item) => item.id === id), (v) => v === false, '还在列表')
expect('彻底删除后回收站里没有', (purged.body.deleted || []).some((item) => item.id === id), (v) => v === false, '还在回收站')
const storeAfterPurge = await readStore()
expect('store.json 里已经删掉', storeAfterPurge.items.some((item) => item.id === id), (v) => v === false, '文件里还在')
expect(
  '墓碑已写入（供跨设备同步）',
  (storeAfterPurge.deleted || []).some((entry) => entry.id === id),
  (v) => v === true,
  '没有墓碑，另一台设备会复活它',
)

// 5) 批量打标是并入，不覆盖已有标签
const a = await call({ op: 'item.create', title: '打标 A', body: 'x', tags: '原有' })
const b = await call({ op: 'item.create', title: '打标 B', body: 'y', tags: '' })
const tagged = await call({ op: 'item.batch', ids: [a.body.focusId, b.body.focusId], patch: { addTags: ['新标签', '原有'] } })
const tagA = tagged.body.items.find((item) => item.id === a.body.focusId)
const tagB = tagged.body.items.find((item) => item.id === b.body.focusId)
expect('打标后保留原标签', tagA?.tags?.includes('原有'), (v) => v === true, JSON.stringify(tagA?.tags))
expect('打标后加上新标签', tagA?.tags?.includes('新标签'), (v) => v === true, JSON.stringify(tagA?.tags))
expect('没有标签的也能加上', tagB?.tags?.includes('新标签'), (v) => v === true, JSON.stringify(tagB?.tags))
expect('重复标签不重复出现', tagA?.tags?.filter((tag) => tag === '原有').length, (v) => v === 1, JSON.stringify(tagA?.tags))

// 6) 清空回收站
await call({ op: 'item.delete', ids: [a.body.focusId, b.body.focusId] })
const emptied = await call({ op: 'recycle.purge', all: true })
expect('清空回收站后为空', emptied.body.deleted.length, (v) => v === 0, '还有残留')

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log(failures.length ? `\nRECYCLE FAILED: ${failures.join(', ')}\n` : '\nRECYCLE OK\n')
process.exit(failures.length ? 1 : 0)
