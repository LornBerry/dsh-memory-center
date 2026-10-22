/**
 * Git 后端的端到端测试（不需要网络、不需要账号）。
 *
 * 用一个本地裸仓库扮演远端，模拟两台设备：
 *   A 写入 → 同步；B 空的 → 同步后应拿到 A 的全部记忆；
 *   B 再写入 → 同步；A 离线新增 → 同步后两边应合并；
 *   A 删除一条 → 同步；B 同步后该条应消失（墓碑生效）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyMergeToStore, syncNow } from '../lib/sync.js'

const failures = []
const ok = (label, pass, detail = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` = ${detail}` : ''}`)
  if (!pass) failures.push(label)
}

const GIT = 'E:\\Git\\cmd\\git.exe'
const run = (args, cwd) =>
  new Promise((resolve) => {
    execFile(GIT, args, { cwd, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
  })

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dmc-git-'))
const bare = path.join(root, 'remote.git')
const deviceA = path.join(root, 'A')
const deviceB = path.join(root, 'B')

const readStore = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8'))
const item = (id, title, updatedAt) => ({
  id,
  title,
  body: `${title} 正文`,
  tags: [],
  groupId: null,
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  order: 0,
  createdAt: updatedAt,
  updatedAt,
})
const writeStore = async (dir, state) => {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'store.json'), JSON.stringify({ version: 1, ...state }, null, 2), 'utf8')
}

const sync = (dir) =>
  syncNow({
    dir,
    sync: { mode: 'git', remote: bare, branch: 'main', autoPull: true, autoPush: true },
    files: ['store.json'],
    merge: (remoteStore) => applyMergeToStore(path.join(dir, 'store.json'), remoteStore),
  })

try {
  await fs.mkdir(bare, { recursive: true })
  const init = await run(['init', '--bare', '-b', 'main'], bare)
  ok('初始化裸仓库', init.code === 0, init.stderr.trim())

  // A：先写一条并同步
  await writeStore(deviceA, { items: [item('m-a1', 'A 的规则', '2026-10-22T10:00:00.000Z')], groups: [] })
  const a1 = await sync(deviceA)
  ok('A 首次同步', a1.status === 'ok', a1.message)

  // B：空目录同步，应拿到 A 的记忆
  await writeStore(deviceB, { items: [], groups: [] })
  const b1 = await sync(deviceB)
  const bState = await readStore(deviceB)
  ok('B 首次同步', b1.status === 'ok', b1.message)
  ok('B 拿到了 A 的记忆', bState.items.some((entry) => entry.id === 'm-a1'), bState.items.map((i) => i.id).join(','))

  // B 新增一条并同步；A 离线新增另一条后同步 → 两边应都有两条
  await writeStore(deviceB, { items: [...bState.items, item('m-b1', 'B 的规则', '2026-10-22T11:00:00.000Z')], groups: [] })
  const b2 = await sync(deviceB)
  ok('B 推送新条目', b2.status === 'ok', b2.message)

  const aState = await readStore(deviceA)
  await writeStore(deviceA, { items: [...aState.items, item('m-a2', 'A 的新规则', '2026-10-22T11:30:00.000Z')], groups: [] })
  const a2 = await sync(deviceA)
  ok('A 合并远端', a2.status === 'ok', a2.message)

  const afterA = await readStore(deviceA)
  ok('A 有 b1', afterA.items.some((entry) => entry.id === 'm-b1'), afterA.items.map((i) => i.id).join(','))

  const b3 = await sync(deviceB)
  const afterB = await readStore(deviceB)
  ok('B 拉回 a2', b3.status === 'ok' && afterB.items.some((entry) => entry.id === 'm-a2'), b3.message)

  // A 删除 m-a1（带墓碑），同步；B 同步后应消失
  const delState = await readStore(deviceA)
  const now = '2026-10-22T12:00:00.000Z'
  await writeStore(deviceA, {
    items: delState.items.filter((entry) => entry.id !== 'm-a1'),
    groups: [],
    deleted: [...(delState.deleted ?? []), { id: 'm-a1', at: now }],
  })
  const a3 = await sync(deviceA)
  ok('A 同步删除', a3.status === 'ok', a3.message)

  await sync(deviceB)
  const finalB = await readStore(deviceB)
  ok('B 也删掉了 m-a1', !finalB.items.some((entry) => entry.id === 'm-a1'), finalB.items.map((i) => i.id).join(','))

  // 同一条被两边改：新的赢
  await writeStore(deviceB, {
    items: [...finalB.items.filter((i) => i.id === 'm-b1'), { ...item('m-b1', 'B 改过', '2026-10-22T13:00:00.000Z') }],
    groups: [],
    deleted: finalB.deleted ?? [],
  })
  await sync(deviceB)
  const aBefore = await readStore(deviceA)
  await writeStore(deviceA, {
    items: [...aBefore.items.filter((i) => i.id !== 'm-b1'), { ...item('m-b1', 'A 也改过但更早', '2026-10-22T12:30:00.000Z') }],
    groups: aBefore.groups,
    deleted: aBefore.deleted ?? [],
  })
  const a4 = await sync(deviceA)
  const winner = (await readStore(deviceA)).items.find((entry) => entry.id === 'm-b1')
  ok('冲突取更新的一侧', a4.status === 'ok' && winner.title === 'B 改过', winner.title)

  ok('工作区里没有多余文件', (await fs.readdir(deviceA)).every((name) => ['store.json', '.git-sync'].includes(name)), (await fs.readdir(deviceA)).join(','))
} finally {
  if (!process.env.KEEP) await fs.rm(root, { recursive: true, force: true })
}

console.log(failures.length ? `\nGIT SYNC FAILED: ${failures.join(' | ')}` : '\nGIT SYNC OK')
process.exitCode = failures.length ? 1 : 0
