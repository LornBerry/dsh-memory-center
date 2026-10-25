/**
 * 跨设备同步（可选）。
 *
 * 设计原则：
 * 1. 默认关闭。不配置的话，记忆只在本机，一个字节都不会外发。
 * 2. 后端是「用户自己的存储」——目前实现了 Git 远端（GitHub / Gitee / 自建都行），
 *    WebDAV 留了同样的接口位置（backends 里加一个即可）。
 * 3. 合并粒度是「单条记忆」：按 id + updatedAt 取新的，删除用墓碑（tombstones）记录，
 *    所以两台设备同时改不同条目不会互相覆盖，同一条被两边改则后改的赢。
 *
 * 这里不依赖任何第三方包：git 用子进程调，合并逻辑是纯函数（dev/merge.test.mjs 可直接测）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 影子仓库里永远不提交的文件：本机设置、会话级选择、临时文件、备份。
 * 备份从 v0.7.7 起统一放在 backups/ 子目录（corrupt- / pre-switch- / pre-purge- 三种），
 * 老版本写在根目录的 `store.json.<kind>-<时间>` 也一并排除，避免升级后被同步上去。
 */
export const GITIGNORE_LINES = [
  'config.json',
  'sessions.json',
  '*.tmp',
  '*.bak',
  'node_modules/',
  'backups/',
  'store.json.corrupt-*',
  'store.json.pre-switch-*',
  'store.json.pre-purge-*',
]

export function emptySync() {
  return {
    mode: 'off', // off | git | webdav
    remote: '',
    branch: 'main',
    username: '',
    password: '',
    autoPush: true,
    autoPull: true,
    lastSyncAt: '',
    lastSyncStatus: '',
    lastSyncError: '',
  }
}

export function normalizeSync(raw) {
  const sync = emptySync()
  if (!raw || typeof raw !== 'object') return sync
  sync.mode = raw.mode === 'git' || raw.mode === 'webdav' ? raw.mode : 'off'
  sync.remote = typeof raw.remote === 'string' ? raw.remote.trim() : ''
  sync.branch = typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : 'main'
  sync.username = typeof raw.username === 'string' ? raw.username : ''
  sync.password = typeof raw.password === 'string' ? raw.password : ''
  sync.autoPush = raw.autoPush !== false
  sync.autoPull = raw.autoPull !== false
  sync.lastSyncAt = typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : ''
  sync.lastSyncStatus = typeof raw.lastSyncStatus === 'string' ? raw.lastSyncStatus : ''
  sync.lastSyncError = typeof raw.lastSyncError === 'string' ? raw.lastSyncError : ''
  return sync
}

const newer = (a, b) => String(a ?? '') >= String(b ?? '')
const strictlyNewer = (a, b) => String(a ?? '') > String(b ?? '')

/**
 * 合并两份记忆库。
 * @param {{groups:Array,items:Array,deleted?:Array,updatedAt?:string}} local
 * @param {{groups:Array,items:Array,deleted?:Array,updatedAt?:string}|null} remote
 * @returns {{state:{groups:Array,items:Array,deleted:Array,updatedAt:string,version:number}, changed:boolean, added:number, updated:number, removed:number}}
 */
/** 条目「内容」指纹：只比用户能感知的字段，updatedAt / source / order 这些不算内容。 */
function contentKey(item) {
  if (!item || typeof item !== 'object') return ''
  const pick = (key) => (item[key] === undefined ? null : item[key])
  return JSON.stringify([
    pick('title'),
    pick('body'),
    Array.isArray(item.tags) ? item.tags.slice() : pick('tags'),
    pick('groupId'),
    pick('enabled'),
    pick('pinned'),
    pick('status'),
    pick('anchorMode'),
    pick('archivedAt'),
    pick('deletedAt'),
  ])
}

/**
 * 同一条记忆被两台设备都改过时，合并只能留下一边。
 * 这里不改变「取更新的那条」这个赢法，只把输掉的那版完整带回给调用方，
 * 由宿主写进 backups/conflict-<时间>.json，事后能手动捞回来。
 */
export function mergeStates(local, remote, options = {}) {
  const since = typeof options.since === 'string' ? options.since : ''
  const base = { version: 1, updatedAt: local?.updatedAt ?? '', groups: local?.groups ?? [], items: local?.items ?? [], deleted: local?.deleted ?? [] }
  if (!remote) return { state: base, changed: false, added: 0, updated: 0, removed: 0, conflicts: [] }
  const conflicts = []

  const tombstones = new Map()
  for (const entry of [...(local?.deleted ?? []), ...(remote?.deleted ?? [])]) {
    if (!entry || typeof entry.id !== 'string') continue
    const at = String(entry.at ?? '')
    const previous = tombstones.get(entry.id)
    if (!previous || newer(at, previous)) tombstones.set(entry.id, at)
  }

  const localItems = new Map((local?.items ?? []).map((item) => [item.id, item]))
  const remoteItems = new Map((remote?.items ?? []).map((item) => [item.id, item]))
  const items = []
  let added = 0
  let updated = 0
  let removed = 0

  for (const id of new Set([...localItems.keys(), ...remoteItems.keys()])) {
    const localItem = localItems.get(id)
    const remoteItem = remoteItems.get(id)
    let winner = localItem
    if (remoteItem && (!localItem || strictlyNewer(remoteItem.updatedAt, localItem.updatedAt))) winner = remoteItem
    if (!winner) continue
    const deadAt = tombstones.get(id)
    if (deadAt && newer(deadAt, winner.updatedAt)) {
      removed += 1
      continue
    }
    if (!localItem) added += 1
    else if (winner !== localItem) updated += 1
    // 两边都有这条、内容却不一样：说明至少有一边改过。
    // 传了 since（上次同步时间）时，只有两边都在那之后改过才算真冲突；
    // 没传就保守记一份 —— 多留一个备份文件，比悄悄丢一版安全。
    if (localItem && remoteItem && contentKey(localItem) !== contentKey(remoteItem)) {
      const bothTouched =
        !since || (newer(localItem.updatedAt, since) && newer(remoteItem.updatedAt, since))
      if (bothTouched) {
        const loser = winner === remoteItem ? localItem : remoteItem
        conflicts.push({
          id,
          title: winner.title,
          winner: winner === remoteItem ? 'remote' : 'local',
          winnerUpdatedAt: winner.updatedAt ?? '',
          loserUpdatedAt: loser.updatedAt ?? '',
          loser: {
            title: loser.title,
            body: loser.body,
            tags: Array.isArray(loser.tags) ? loser.tags : [],
            groupId: loser.groupId ?? null,
            anchorMode: loser.anchorMode ?? 'off',
            updatedAt: loser.updatedAt ?? '',
          },
        })
      }
    }
    items.push(winner)
  }

  const localGroups = new Map((local?.groups ?? []).map((group) => [group.id, group]))
  const remoteGroups = new Map((remote?.groups ?? []).map((group) => [group.id, group]))
  const groups = []
  for (const id of new Set([...localGroups.keys(), ...remoteGroups.keys()])) {
    // 文件夹保留两边的并集；同名/顺序冲突时以本机为准（文件夹只是容器，丢了会把条目
    // 变成未归类，代价比「复活一个空文件夹」大）。
    const winner = localGroups.get(id) ?? remoteGroups.get(id)
    if (winner) groups.push(winner)
  }

  const knownGroups = new Set(groups.map((group) => group.id))
  // 不要就地改 items：那些对象是调用方（内存里的 store）传进来的，
  // mergeStates 必须是纯函数，否则合并一次就把本机条目改了。
  const normalizedItems = items.map((item) =>
    item.groupId && !knownGroups.has(item.groupId) ? { ...item, groupId: null } : item,
  )

  const deleted = [...tombstones.entries()].map(([id, at]) => ({ id, at }))
  const state = {
    version: 1,
    updatedAt: newer(remote?.updatedAt ?? '', local?.updatedAt ?? '') ? remote.updatedAt : local?.updatedAt || new Date().toISOString(),
    groups,
    items: normalizedItems,
    deleted,
  }
  const changed = added > 0 || updated > 0 || removed > 0 || (remote?.groups?.length ?? 0) !== (local?.groups?.length ?? 0)
  return { state, changed, added, updated, removed, conflicts }
}

/* -------------------------------------------------------------------- git */

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, file)
}

/**
 * 把远端拉到的 store 合并进本地 store 文件（宿主与测试共用同一份实现）。
 * @returns {{changed:boolean, summary:string, state:object}}
 */
export async function applyMergeToStore(storeFile, remoteStore, options = {}) {
  const current = await readJsonSafe(storeFile)
  const { state, changed, added, updated, removed, conflicts } = mergeStates(current ?? { groups: [], items: [], deleted: [] }, remoteStore, options)
  if (changed) await writeJsonAtomic(storeFile, state)
  const parts = []
  if (added) parts.push(`新增 ${added}`)
  if (updated) parts.push(`更新 ${updated}`)
  if (removed) parts.push(`删除 ${removed}`)
  if (conflicts?.length) parts.push(`冲突 ${conflicts.length}`)
  return { changed, summary: parts.join('，'), state, conflicts: conflicts ?? [] }
}

const GIT_CANDIDATES = [
  process.env.DSH_MEMORY_GIT,
  'git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'E:\\Git\\cmd\\git.exe',
]

function run(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // GUI 里没有终端：缺凭据时必须直接失败，不能让 git 卡在那里等输入。
        timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      },
    )
  })
}

async function resolveGit() {
  for (const candidate of GIT_CANDIDATES) {
    if (!candidate) continue
    const result = await run(candidate, ['--version'])
    if (result.code === 0 && /git version/i.test(result.stdout)) return candidate
  }
  return null
}

export async function hasGit() {
  return Boolean(await resolveGit())
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function ensureRepoSync(dir, remote, branch) {
  const git = await resolveGit()
  if (!git) return { ok: false, message: '没找到 git，可设置环境变量 DSH_MEMORY_GIT 指向 git.exe' }

  const repoDir = path.join(dir, '.git-sync')
  const repo = path.join(repoDir, 'repo')
  if (!(await exists(path.join(repo, '.git')))) {
    await fs.mkdir(repoDir, { recursive: true })
    // 先尝试克隆远端：这样本地历史与远端同源，后面 rebase/推送才不会因为
    // 「unrelated histories」被拒（两台设备各自 init 就会出现这种局面）。
    const clone = await run(git, ['clone', '--branch', branch, remote, repo], repoDir)
    if (clone.code !== 0) {
      await fs.rm(repo, { recursive: true, force: true })
      await fs.mkdir(repo, { recursive: true })
      const init = await run(git, ['init', '-b', branch], repo)
      if (init.code !== 0) {
        const fallback = await run(git, ['init'], repo)
        if (fallback.code !== 0) return { ok: false, message: `git init 失败：${init.stderr || fallback.stderr}` }
        await run(git, ['checkout', '-b', branch], repo)
      }
    }
    await run(git, ['config', 'user.name', 'memory-center'], repo)
    await run(git, ['config', 'user.email', 'memory-center@localhost'], repo)
    await run(git, ['config', 'core.autocrlf', 'false'], repo)
  }

  const current = await run(git, ['remote', 'get-url', 'origin'], repo)
  if (current.code !== 0 || current.stdout.trim() !== remote) {
    if (current.code === 0) await run(git, ['remote', 'set-url', 'origin', remote], repo)
    else await run(git, ['remote', 'add', 'origin', remote], repo)
  }

  await fs.writeFile(path.join(repo, '.gitignore'), `${GITIGNORE_LINES.join('\n')}\n`, 'utf8')
  return { ok: true, git, repo, branch }
}

async function copyInto(repo, dir, files) {
  for (const file of files) {
    const source = path.join(dir, file)
    const target = path.join(repo, file)
    if (await exists(source)) await fs.copyFile(source, target)
  }
}

async function copyOut(repo, dir, files) {
  for (const file of files) {
    const source = path.join(repo, file)
    const target = path.join(dir, file)
    if (await exists(source)) await fs.copyFile(source, target)
  }
}

async function commitIfNeeded(git, repo, message) {
  await run(git, ['add', '-A'], repo)
  const status = await run(git, ['status', '--porcelain'], repo)
  if (!status.stdout.trim()) return false
  const commit = await run(git, ['commit', '-m', message], repo)
  return commit.code === 0
}

/**
 * 执行一次同步：本地 → 提交 → 拉远端 → 合并 → 推送。
 * @param {{dir:string, sync:object, files:string[], merge:(remoteStore:object)=>Promise<{changed:boolean, summary:string}>}} options
 */
export async function syncNow(options) {
  const { sync } = options
  if (sync.mode === 'webdav') return syncWebdav(options)
  if (sync.mode !== 'git' || !sync.remote) {
    return { status: 'skipped', message: '未启用同步' }
  }
  return syncGit(options)
}

async function hasRef(git, repo, ref) {
  const result = await run(git, ['rev-parse', '--verify', '--quiet', ref], repo)
  return result.code === 0
}

async function syncGit({ dir, sync, files, merge }) {
  const prepared = await ensureRepoSync(dir, sync.remote, sync.branch)
  if (!prepared.ok) return { status: 'error', message: prepared.message }
  const { git, repo, branch } = prepared
  const remoteRef = `origin/${branch}`

  const attempt = async () => {
    let summary = ''
    // 1) 先把远端内容取下来，用我们自己的合并规则写回本地文件：
    //    不让 git 做文本级 merge，store.json 的冲突只会在条目层面被解决。
    const fetched = await run(git, ['fetch', 'origin', branch], repo)
    if (fetched.code === 0) {
      let show = await run(git, ['show', `${remoteRef}:store.json`], repo)
      if (show.code !== 0) show = await run(git, ['show', 'FETCH_HEAD:store.json'], repo)
      if (show.code === 0 && show.stdout.trim()) {
        let remoteStore = null
        try {
          remoteStore = JSON.parse(show.stdout)
        } catch {
          remoteStore = null
        }
        if (remoteStore) {
          const outcome = await merge(remoteStore)
          summary = outcome.summary || ''
        }
      }
    }

    // 2) 把合并结果放进影子仓库，并把 HEAD 对齐到远端 tip —— 这样产生的提交
    //    一定是远端最新提交的后代，推送永远是 fast-forward。
    await copyInto(repo, dir, files)
    if (await hasRef(git, repo, remoteRef)) {
      const reset = await run(git, ['reset', '--soft', remoteRef], repo)
      if (reset.code !== 0) {
        return { status: 'error', message: reset.stderr.trim() || '对齐远端历史失败' }
      }
    }
    const committed = await commitIfNeeded(git, repo, 'memory: sync')
    const pushed = await run(git, ['push', '-u', 'origin', branch], repo)
    if (pushed.code === 0) {
      return {
        status: 'ok',
        message: summary || (committed ? '已上传' : '已是最新'),
        syncedAt: new Date().toISOString(),
      }
    }
    return { status: 'error', message: pushed.stderr.trim() || '推送失败', retry: true }
  }

  try {
    const first = await attempt()
    if (!first.retry) return first
    // 远端在我们提交的瞬间又前进了：重来一次（这次会基于新的远端 tip）。
    const second = await attempt()
    return second.retry ? { status: 'error', message: second.message } : second
  } catch (error) {
    return { status: 'error', message: error?.message ?? String(error) }
  }
}

/**
 * WebDAV 后端：坚果云、Nextcloud、群晖、InfiniCLOUD 之类都能用。
 * 只有 store.json 一个文件，读 → 合并 → 写，所以没有历史版本（要历史就用 Git 后端）。
 */
async function syncWebdav({ dir, sync, merge }) {
  if (!sync.remote) return { status: 'skipped', message: '未填写 WebDAV 地址' }
  const base = sync.remote.replace(/\/+$/, '')
  const headers = { 'user-agent': 'dsh-memory-center' }
  if (sync.username || sync.password) {
    headers.authorization = `Basic ${Buffer.from(`${sync.username}:${sync.password}`).toString('base64')}`
  }
  const fileUrl = `${base}/store.json`
  const localFile = path.join(dir, 'store.json')

  // 目录不存在先建（有的服务端 PUT 到不存在的目录会 409）
  await fetch(base, { method: 'MKCOL', headers, redirect: 'manual' }).catch(() => null)

  const attempt = async () => {
    let remoteStore = null
    let remoteText = ''
    let etag = ''
    const got = await fetch(fileUrl, {
      method: 'GET',
      headers: { ...headers, accept: 'application/json' },
      redirect: 'follow',
    })
    if (got.status === 404) {
      remoteStore = null
    } else if (!got.ok) {
      return { status: 'error', message: `读取远端失败：HTTP ${got.status}（检查地址、账号或应用密码）` }
    } else {
      etag = got.headers.get('etag') || ''
      remoteText = await got.text()
      if (remoteText.trim()) {
        try {
          remoteStore = JSON.parse(remoteText)
        } catch {
          return { status: 'error', message: '远端 store.json 不是合法 JSON，已中止以免覆盖' }
        }
      }
    }

    let summary = ''
    if (remoteStore) {
      const outcome = await merge(remoteStore)
      summary = outcome.summary || ''
    }

    const body = await fs.readFile(localFile, 'utf8')
    // 本地与远端逐字节一致就不必整份上传：坚果云这类服务按流量/次数限流，
    // 每次打开面板或编辑都无脑 PUT 一遍纯属自找麻烦。合并改过本地就一定不同，不会漏传。
    if (remoteStore && remoteText === body) {
      return { status: 'ok', message: '已是最新', syncedAt: new Date().toISOString() }
    }
    // If-Match：WebDAV 是整文件覆盖，没有条件请求的话，两台设备同时同步就是 last-write-wins，
    // 后到的 PUT 会把先到那台刚合并进来的条目静默抹掉（用户只会觉得「另一台写的东西没了」）。
    // 带上 ETag，远端在我们合并期间变了就 412，重来一次（这次基于新的远端内容重新合并）。
    const put = await fetch(fileUrl, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        ...(etag ? { 'if-match': etag } : {}),
      },
      body,
    })
    if (put.status === 412) {
      return {
        status: 'error',
        message: '远端在你合并期间被改过，已中止以免覆盖，请再同步一次',
        retry: true,
      }
    }
    if (!put.ok && put.status !== 201 && put.status !== 204) {
      return { status: 'error', message: `上传失败：HTTP ${put.status}` }
    }
    return { status: 'ok', message: summary || '已上传', syncedAt: new Date().toISOString() }
  }

  try {
    const first = await attempt()
    if (!first.retry) return first
    const second = await attempt()
    return second.retry ? { status: 'error', message: second.message } : second
  } catch (error) {
    return { status: 'error', message: error?.message ?? String(error) }
  }
}

export { copyOut }
