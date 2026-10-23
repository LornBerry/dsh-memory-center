/**
 * dsh-memory-center — Host half.
 *
 * Owns the memory library (groups / items / tags), the per-session injection
 * decision, the browser JSON API (`POST /dsh-memory/api`), the two model-facing
 * tools and the `agent/pre-step` injection.
 *
 * Storage: one JSON file per concern in the memory data directory (auto-detected
 * by ./lib/paths.js, overridable in the panel via 存储位置):
 *   store.json    — { version, groups[], items[] }
 *   sessions.json — { [sessionId]: { mode, groupIds, itemIds, decidedAt } }
 *
 * Nothing is written outside that directory.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { canWriteDir, candidateDataDirs, pickDataDir } from './lib/paths.js'
import { hasGit, mergeStates, normalizeSync, syncNow as runSync } from './lib/sync.js'

export const name = 'memory-center'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-memory'
const CONFIG_ENV = process.env.DSH_MEMORY_CONFIG || ''
const MAX_INJECT_CHARS = Number(process.env.DSH_MEMORY_MAX_CHARS || 12000)

/**
 * 压缩阈值：记忆总量超过「上限 × 该比例」时，注入开始压缩（超出部分只给标题）。
 * 默认 80%——留 20% 余量给统计行、索引清单和以后新增的记忆，避免一加就爆。
 * 可用 DSH_MEMORY_COMPRESS_RATIO 调整（0.1–1，非法值回退 0.8）。
 */
const COMPRESS_RATIO = (() => {
  const raw = Number(process.env.DSH_MEMORY_COMPRESS_RATIO)
  if (!Number.isFinite(raw) || raw < 0.1 || raw > 1) return 0.8
  return raw
})()
const SOFT_INJECT_CHARS = Math.max(1000, Math.floor(MAX_INJECT_CHARS * COMPRESS_RATIO))
const PLUGIN_ID = 'dsh-memory-center'

/**
 * 数据目录可以在面板里改，所以这些路径必须是变量而不是常量。
 * 优先级：环境变量 DSH_MEMORY_DIR > 数据目录里记住的选择 > 自动探测（见 lib/paths.js）。
 *
 * 配置文件放在数据目录内部（config.json），这样「记忆相关的文件」永远只在同一个
 * 文件夹里，不会因为默认目录在 C 盘就往 C 盘写配置。
 */
let DATA_DIR = ''
let STORE_FILE = ''
let SESSIONS_FILE = ''
let CONFIG_FILE = ''
let autoDir = ''
let sync = normalizeSync(null)
let gitOk = null
let pushTimer = null

function configFileFor(dir) {
  return path.join(dir, 'config.json')
}

function applyDataDir(dir) {
  DATA_DIR = dir
  STORE_FILE = path.join(dir, 'store.json')
  SESSIONS_FILE = path.join(dir, 'sessions.json')
}

async function readConfigDir(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    const dir = typeof parsed?.dataDir === 'string' ? parsed.dataDir.trim() : ''
    return dir && path.isAbsolute(dir) ? dir : ''
  } catch {
    return ''
  }
}

async function loadConfig() {
  await loadDataDir()
  sync = normalizeSync((await readConfigFile(CONFIG_FILE)).sync)
  if (gitOk === null) gitOk = await hasGit()
}

async function loadDataDir() {
  if (process.env.DSH_MEMORY_DIR) {
    applyDataDir(path.resolve(process.env.DSH_MEMORY_DIR))
    CONFIG_FILE = configFileFor(DATA_DIR)
    return
  }
  if (CONFIG_ENV) {
    // 显式指定的配置文件：即使它还不存在，后续选择也写回这里，不要改指向别处。
    const dir = await readConfigDir(CONFIG_ENV)
    applyDataDir(dir && (await canWriteDir(dir)) ? dir : await pickDataDir())
    CONFIG_FILE = CONFIG_ENV
    return
  }
  for (const file of candidateDataDirs().map(configFileFor)) {
    const dir = await readConfigDir(file)
    if (dir && (await canWriteDir(dir))) {
      applyDataDir(dir)
      CONFIG_FILE = file
      return
    }
  }
  applyDataDir(await pickDataDir())
  CONFIG_FILE = configFileFor(DATA_DIR)
}

async function defaultDataDir() {
  if (!autoDir) autoDir = await pickDataDir()
  return autoDir
}

async function readConfigFile(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记住用户的选择。同时写回「上一个位置」的 config.json：否则老目录还在、老目录
 * 又排在候选列表前面时，下次启动会被「已有 store.json」抢先把目录改回去。
 *
 * 除了 dataDir，这里还存同步设置（sync），所以必须读-改-写，不能整份覆盖。
 */
async function saveConfig(dir, patch = {}) {
  const targets = new Set([configFileFor(dir)])
  if (CONFIG_FILE) targets.add(CONFIG_FILE)
  for (const target of targets) {
    const current = await readConfigFile(target)
    const next = { ...current, ...patch, dataDir: dir }
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await fs.rename(temp, target)
  }
  CONFIG_FILE = configFileFor(dir)
}

/**
 * 写进系统提示的“何时该记”规则。
 *
 * 这份文本每轮都会进上下文，所以刻意压短：关键词快速路径在前（省 token、
 * 命中就写），自判四问只作为没命中关键词时的兜底，避免“看到我习惯就写”和
 * “全靠模型自由发挥”两个极端。
 */
const MEMORY_POLICY = [
  '## 长期记忆（memory-center）',
  '',
  '用户有一份长期记忆库，存在本机（「记忆」面板 →「存储位置」可改），由用户维护。工具：`memory_search` 检索、`memory_write` 写入候选。写入先落「待确认」；同一个会话累计到第 2 条起，插件会自动放进一个以会话标题命名的文件夹（仍待确认），由用户转正。',
  '',
  '**判断顺序：关键词为主，自判为辅。**',
  '1. **用户明说**——「记一下 / 记住 / 存一下」：直接写，按用户说的写具体。',
  '2. **命中关键词就写**（省 token 的快速路径）：',
  '   - 偏好/习惯/约定/禁止：「我习惯」「以后都」「每次」「一直」「禁止」「必须」「统一」「一律」，以及明确立规矩的「别…/不要…」（如「别用 X」）；',
  '   - 固定事实：路径、端口、数据目录、仓库、部署、技术选型；',
  '   - 拍板决策：「就用」「改成」「而不是」——连同为什么；',
  '   命中后只排除一种：明显只对这一次有效的临时状态（这次先这样、当前正在跑的任务）。',
  '3. **没命中关键词、但你觉得跨会话有用**：再过四问——下个会话不知道会不会误事？是长期还是这次？是用户明说还是我推测？库里是否已有（先 `memory_search`）？四问都过才写；拿不准就问一句，别用猜测填库。',
  '',
  '**写的时候：** 一条只讲一件事；标题写结论；正文写具体值 + 为什么 + 例外；决策带理由；一次对话最多 3 条；写完别说「已经记住了」——说「已放进待确认」。',
].join('\n')

/* ------------------------------------------------------------------ storage */

function nowIso() {
  return new Date().toISOString()
}

function emptyState() {
  return { version: 1, updatedAt: nowIso(), groups: [], items: [], deleted: [] }
}

let store = null
let sessions = {}
let loading = null
let writeChain = Promise.resolve()
/** 运行期缓存：会话 id → 会话标题（用于同一会话第 2 条记忆起的自动文件夹命名）。 */
const sessionTitles = new Map()

function normalizeTags(value) {
  // 面板传数组；命令行/工具/导入偶尔传「a, b」这样的字符串，这里一并接住。
  const list = typeof value === 'string' ? value.split(/[,，、]/) : value
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const tag = String(raw ?? '').trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const state = emptyState()
  state.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : nowIso()
  if (Array.isArray(source.deleted)) {
    for (const entry of source.deleted) {
      if (!entry || typeof entry.id !== 'string') continue
      state.deleted.push({ id: entry.id, at: typeof entry.at === 'string' ? entry.at : nowIso() })
    }
  }
  if (Array.isArray(source.groups)) {
    for (const group of source.groups) {
      if (!group || typeof group.id !== 'string') continue
      state.groups.push({
        id: group.id,
        name: String(group.name ?? '未命名文件夹').trim() || '未命名文件夹',
        order: Number.isFinite(group.order) ? Number(group.order) : state.groups.length,
        createdAt: typeof group.createdAt === 'string' ? group.createdAt : nowIso(),
      })
    }
  }
  if (Array.isArray(source.items)) {
    for (const item of source.items) {
      if (!item || typeof item.id !== 'string') continue
      state.items.push({
        id: item.id,
        title: String(item.title ?? '').trim() || '未命名记忆',
        body: String(item.body ?? ''),
        tags: normalizeTags(item.tags),
        groupId: typeof item.groupId === 'string' ? item.groupId : null,
        enabled: item.enabled !== false,
        pinned: item.pinned === true,
        status: item.status === 'pending' ? 'pending' : 'active',
        source: ['manual', 'auto', 'import'].includes(item.source) ? item.source : 'manual',
        sessionId: typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : null,
        anchorMode: ['full', 'weight'].includes(item.anchorMode) ? item.anchorMode : 'off',
        order: Number.isFinite(item.order) ? Number(item.order) : state.items.length,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
      })
    }
  }
  return state
}

function normalizeSessions(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!sessionId || !value || typeof value !== 'object') continue
    const mode = ['none', 'all', 'custom'].includes(value.mode) ? value.mode : 'none'
    out[sessionId] = {
      mode,
      groupIds: Array.isArray(value.groupIds) ? value.groupIds.filter((id) => typeof id === 'string') : [],
      itemIds: Array.isArray(value.itemIds) ? value.itemIds.filter((id) => typeof id === 'string') : [],
      decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : nowIso(),
    }
  }
  return out
}

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000

/** sessions.json 只增不删会一直变大：超过 180 天没动过的会话选择直接丢掉。 */
function pruneSessions(map) {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [sessionId, selection] of Object.entries(map)) {
    const at = Date.parse(selection?.decidedAt ?? '')
    if (!Number.isFinite(at) || at < cutoff) delete map[sessionId]
  }
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

function queueWrite(file, value) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
      await fs.rename(temp, file)
    })
  return writeChain
}

/**
 * 读 store.json：损坏时不再让插件永久卡死。
 *
 * 第一次解析失败先带着文件路径报错（用户可能马上改好重试，此时不动文件）；
 * 仍然失败才把坏文件改名备份成 `store.json.corrupt-<时间>`，回退空库并重建，
 * 保证面板不会因为一段坏 JSON 整个不可用。
 */
let storeReadFailed = false

async function readStoreFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    storeReadFailed = false
    return parsed
  } catch (error) {
    if (!storeReadFailed) {
      storeReadFailed = true
      throw new Error(
        `记忆库文件无法解析：${file}\n请修复这个 JSON 文件后重试；再次打开面板时如果仍然损坏，插件会把它备份成 ${file}.corrupt-<时间> 并重建空库。\n原始错误：${error.message}`,
      )
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.corrupt-${stamp}`
    await fs.rename(file, backup).catch(() => {})
    storeReadFailed = false
    return null
  }
}

async function ensureLoaded() {
  if (store) return store
  if (!loading) {
    loading = (async () => {
      await loadConfig()
      // 先同步再读盘：换一台设备第一次打开时，记忆就已经在库里了。
      if (syncEnabled() && sync.autoPull) {
        await runSyncNow({ quiet: true }).catch(() => {})
      }
      store = normalizeState(await readStoreFile(STORE_FILE))
      sessions = normalizeSessions(await readJson(SESSIONS_FILE, {}))
      pruneSessions(sessions)
      if (!store.groups.length && !store.items.length) {
        store = seedState()
        await persist()
      }
      return store
    })().catch((error) => {
      // 关键：失败的 promise 不能一直缓存。否则一次坏文件会让之后所有 op
      // 都返回同一个 rejected promise，修好文件也必须重启宿主才能恢复。
      loading = null
      throw error
    })
  }
  return loading
}

function seedState() {
  const state = emptyState()
  const groupId = `g-${randomUUID().slice(0, 8)}`
  state.groups.push({ id: groupId, name: '项目约定', order: 0, createdAt: nowIso() })
  state.items.push(
    {
      id: `m-${randomUUID().slice(0, 8)}`,
      title: '记忆库是一个本地文件夹',
      body: '记忆只存在本机的一个目录里，路径见「记忆」面板底部，可随时在「存储位置」里改到别处；不会写进项目代码目录。',
      tags: ['约束', '存储'],
      groupId,
      enabled: true,
      pinned: true,
      status: 'active',
      source: 'manual',
      order: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: `m-${randomUUID().slice(0, 8)}`,
      title: '记忆由用户最终确认',
      body: '模型写入的记忆先进入「待确认」，用户点「转正」后才进入正式库并参与注入。',
      tags: ['流程'],
      groupId,
      enabled: true,
      pinned: false,
      status: 'active',
      source: 'manual',
      order: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      // 新装首启的一次性引导：放「待确认」，不参与注入，用户看完随手删掉也不会
      // 丢掉绑定入口——「云端同步」按钮独立在面板工具栏和设置页里，不依赖这一条。
      id: `m-${randomUUID().slice(0, 8)}`,
      title: '跨设备记忆需要开同步',
      body: '想让多台设备共用同一份记忆，得先绑定云端同步：记忆面板（或 设置 → 记忆库）工具栏点「云端同步」，选 Git 仓库或 WebDAV 网盘保存即可。不绑定也完全能用，记忆只留在这台机器。这条只是首装提醒，转正或删除都随意——「云端同步」入口一直都在，删了它也能随时回去绑。',
      tags: ['同步'],
      groupId: null,
      enabled: true,
      pinned: false,
      status: 'pending',
      source: 'manual',
      order: 2,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  )
  return state
}

async function persist(options = {}) {
  store.updatedAt = nowIso()
  await queueWrite(STORE_FILE, store)
  if (!options.skipPush) schedulePush()
}

async function persistSessions() {
  await queueWrite(SESSIONS_FILE, sessions)
}

/* ------------------------------------------------------------------- sync */

const SYNC_FILES = ['store.json']

function syncEnabled() {
  return (sync.mode === 'git' || sync.mode === 'webdav') && Boolean(sync.remote)
}

function schedulePush() {
  if (!syncEnabled() || !sync.autoPush) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void runSyncNow({ quiet: true })
  }, 4000)
  if (typeof pushTimer.unref === 'function') pushTimer.unref()
}

/** 把远端 store 合并进本机，不触发再次推送（避免同步自己唤醒自己）。 */
async function mergeRemote(remoteStore) {
  const current = store ?? normalizeState(await readJson(STORE_FILE, null))
  const outcome = mergeStates(current, normalizeState(remoteStore))
  if (!outcome.changed) return { changed: false, summary: '' }
  store = normalizeState(outcome.state)
  await persist({ skipPush: true })
  const parts = []
  if (outcome.added) parts.push(`新增 ${outcome.added}`)
  if (outcome.updated) parts.push(`更新 ${outcome.updated}`)
  if (outcome.removed) parts.push(`删除 ${outcome.removed}`)
  return { changed: true, summary: `已合并远端（${parts.join('、') || '结构变化'}）` }
}

let syncing = null

async function runSyncNow({ quiet = false } = {}) {
  if (!syncEnabled()) {
    return { status: 'skipped', message: '同步未启用' }
  }
  if (syncing) return syncing
  syncing = (async () => {
    const result = await runSync({
      dir: DATA_DIR,
      sync,
      files: SYNC_FILES,
      merge: mergeRemote,
    })
    if (!quiet) {
      sync.lastSyncAt = result.syncedAt || nowIso()
      sync.lastSyncStatus = result.status
      sync.lastSyncError = result.status === 'error' ? result.message : ''
      await saveConfig(DATA_DIR, { sync }).catch(() => {})
    }
    return result
  })()
  try {
    return await syncing
  } finally {
    syncing = null
  }
}

/* -------------------------------------------------------------- projection */

function sortGroups(groups) {
  return groups.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
}

function sortItems(items) {
  return items
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.order ?? 0) - (b.order ?? 0))
}

function allTags(state) {
  const seen = new Map()
  for (const item of state.items) {
    for (const tag of item.tags) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

function groupNameOf(state, groupId) {
  if (!groupId) return '未归类'
  const group = state.groups.find((entry) => entry.id === groupId)
  return group ? group.name : '未归类'
}

function selectedItemIds(state, selection) {
  if (!selection || selection.mode === 'none') return []
  const groupIds = new Set(selection.groupIds ?? [])
  const itemIds = new Set(selection.itemIds ?? [])
  const chosen = []
  for (const item of state.items) {
    if (item.deletedAt || item.archivedAt || item.status !== 'active' || !item.enabled) continue
    if (selection.mode === 'all') {
      chosen.push(item)
      continue
    }
    if (groupIds.has(item.groupId) || itemIds.has(item.id)) chosen.push(item)
  }
  return chosen
}

function anchorRank(item) {
  if (item.anchorMode === 'full') return 0
  if (item.anchorMode === 'weight') return 1
  return item.pinned ? 2 : 3
}

function renderItemLines(item) {
  const tags = item.tags.length ? `  〔${item.tags.join(' / ')}〕` : ''
  const anchor = item.anchorMode === 'full' ? '〔完全锚点〕' : item.anchorMode === 'weight' ? '〔权重锚点〕' : ''
  const lines = [`- ${item.pinned ? '📌 ' : ''}${anchor}**${item.title}**${tags}`]
  const body = String(item.body ?? '').trim()
  if (body) for (const line of body.split('\n')) lines.push(line ? `  ${line}` : '')
  return lines
}

/**
 * 把「本次会话要带的记忆」组装成一段上下文。
 *
 * 条目一多，全量塞进去会挤掉对话本身，所以按预算装：
 *   完全锚点 → 权重锚点 → 置顶 → 其余（越新越先）
 * 装不下的条目不截半，直接退化成「索引」：只列标题，让模型需要时用 memory_search 取全文。
 * 这样既不会把一条记忆切成两半，也不会让模型误以为记忆只有这么点。
 */
function composeInjection(state, sessionId) {
  const selection = sessions[sessionId]
  const empty = {
    text: null,
    stats: {
      total: 0,
      kept: 0,
      dropped: 0,
      chars: 0,
      limit: MAX_INJECT_CHARS,
      softLimit: SOFT_INJECT_CHARS,
      ratio: COMPRESS_RATIO,
      totalChars: 0,
      compressed: false,
      indexMode: false,
      anchors: 0,
    },
  }
  if (!selection || selection.mode === 'none') return empty
  const selected = selectedItemIds(state, selection)
  if (!selected.length) return empty

  const priority = [...selected].sort((a, b) => {
    const d = anchorRank(a) - anchorRank(b)
    if (d) return d
    const ua = String(a.updatedAt ?? '')
    const ub = String(b.updatedAt ?? '')
    if (ua !== ub) return ub.localeCompare(ua)
    return (a.order ?? 0) - (b.order ?? 0)
  })

  const groupOrder = new Map(sortGroups(state.groups).map((group, index) => [group.id, index]))
  const ordered = [...selected].sort((a, b) => {
    const ga = a.groupId ? groupOrder.get(a.groupId) ?? 999 : 998
    const gb = b.groupId ? groupOrder.get(b.groupId) ?? 999 : 998
    return ga - gb || (a.order ?? 0) - (b.order ?? 0)
  })

  const head = [
    '## 用户长期记忆（来自「记忆」面板，由用户维护）',
    '',
    '',
    '',
    '锚点：标「〔完全锚点〕」的条目必须完全照此执行/表达，不得偏离；标「〔权重锚点〕」的条目只作为输出倾向的权重，影响措辞与优先级，可偏离。',
    '',
  ]
  // 给统计行、索引清单、省略提示留出的余量
  const RESERVE = 320
  // 压缩阈值就是这里的预算：超过 softLimit（默认 80%）就只给标题，不等撑满 100%。
  let budget = SOFT_INJECT_CHARS - head.join('\n').length - RESERVE
  const totalChars = priority.reduce((sum, item) => sum + renderItemLines(item).join('\n').length + 1, 0)
  const kept = new Set()
  for (const item of priority) {
    const cost = renderItemLines(item).join('\n').length + 1
    if (cost > budget) continue
    kept.add(item.id)
    budget -= cost
  }

  const keptItems = ordered.filter((item) => kept.has(item.id))
  const dropped = ordered.filter((item) => !kept.has(item.id))
  const groups = new Map()
  for (const item of keptItems) {
    const key = item.groupId ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const anchors = keptItems.filter((item) => item.anchorMode === 'full' || item.anchorMode === 'weight').length

  const blocks = []
  blocks.push('## 用户长期记忆（来自「记忆」面板，由用户维护）')
  blocks.push('')
  blocks.push(
    `本次加载 ${keptItems.length} 条 / ${groups.size} 个文件夹${
      dropped.length ? `（另有 ${dropped.length} 条只给了标题，需要时用 memory_search 取全文）` : ''
    }。记忆可能过时，与代码或工具输出冲突时以实际观察为准，并提示用户更新记忆。`,
  )
  blocks.push('')
  blocks.push(
    '锚点：标「〔完全锚点〕」的条目必须完全照此执行/表达，不得偏离；标「〔权重锚点〕」的条目只作为输出倾向的权重，影响措辞与优先级，可偏离。',
  )
  blocks.push('')
  for (const [groupId, groupItems] of groups) {
    blocks.push(`### ${groupId ? groupNameOf(state, groupId) : '未归类'}`)
    for (const item of groupItems) blocks.push(...renderItemLines(item))
    blocks.push('')
  }

  if (dropped.length) {
    blocks.push('### 未展开的记忆（只有标题）')
    const titles = dropped.slice(0, 40).map((item) => `- ${item.title}${item.tags.length ? `  〔${item.tags.join(' / ')}〕` : ''}`)
    blocks.push(...titles)
    if (dropped.length > titles.length) blocks.push(`- ……共 ${dropped.length} 条`)
    blocks.push('')
    blocks.push('需要上述任何一条的具体内容，调用 memory_search 检索，不要凭标题猜。')
    blocks.push('')
  }

  let text = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (text.length > MAX_INJECT_CHARS) {
    // 兜底：索引清单本身也可能超长，按码点截断，别把 emoji / 代理对劈成半个字符。
    const runes = Array.from(text)
    text = `${runes.slice(0, MAX_INJECT_CHARS).join('')}\n\n（记忆内容过长，已截断，如需完整内容请在「记忆」面板查看）`
  }
  return {
    text,
    stats: {
      total: selected.length,
      kept: keptItems.length,
      dropped: dropped.length,
      chars: text.length,
      limit: MAX_INJECT_CHARS,
      softLimit: SOFT_INJECT_CHARS,
      ratio: COMPRESS_RATIO,
      totalChars,
      over: totalChars > SOFT_INJECT_CHARS,
      compressed: dropped.length > 0,
      indexMode: dropped.length > 0,
      anchors,
    },
  }
}

function buildInjection(state, sessionId) {
  return composeInjection(state, sessionId).text
}

function sessionView(state, sessionId) {
  const selection = sessionId ? sessions[sessionId] : undefined
  const decided = Boolean(selection)
  const mode = selection?.mode ?? 'none'
  const items = selection ? sortItems(selectedItemIds(state, selection)) : []
  return {
    sessionId: sessionId || null,
    decided,
    mode,
    groupIds: selection?.groupIds ?? [],
    itemIds: selection?.itemIds ?? [],
    decidedAt: selection?.decidedAt ?? null,
    count: items.length,
    groupCount: new Set(items.map((item) => item.groupId ?? '')).size,
  }
}

function visibleItems(state) {
  return state.items.filter((item) => !item.deletedAt && !item.archivedAt)
}

function archivedItems(state) {
  return state.items
    .filter((item) => item.archivedAt && !item.deletedAt)
    .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))
}

/** 归档层：不参与注入与默认检索，但内容完整保留，随时可还原。 */
function archiveView(state) {
  return archivedItems(state).map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    tags: item.tags,
    groupId: item.groupId,
    status: item.status,
    anchorMode: item.anchorMode,
    source: item.source,
    archivedAt: item.archivedAt,
    mergedInto: item.mergedInto ?? null,
    chars: item.title.length + String(item.body ?? '').length,
  }))
}

/** 容量画像：注入预算用了多少、文件夹各占多少、最长的几条是谁。 */
function capacityOf(state) {
  const charsOf = (item) => item.title.length + String(item.body ?? '').length
  const live = state.items.filter(
    (item) => !item.deletedAt && !item.archivedAt && item.status === 'active' && item.enabled,
  )
  const total = live.reduce((sum, item) => sum + charsOf(item), 0)
  const byFolder = new Map()
  for (const item of live) {
    const key = item.groupId ?? ''
    const entry = byFolder.get(key) ?? { id: item.groupId ?? null, count: 0, chars: 0 }
    entry.count += 1
    entry.chars += charsOf(item)
    byFolder.set(key, entry)
  }
  return {
    limit: MAX_INJECT_CHARS,
    softLimit: SOFT_INJECT_CHARS,
    threshold: COMPRESS_RATIO,
    chars: total,
    items: live.length,
    ratio: SOFT_INJECT_CHARS > 0 ? Math.min(1, total / SOFT_INJECT_CHARS) : 0,
    over: total > SOFT_INJECT_CHARS,
    folders: [...byFolder.values()]
      .map((entry) => ({ ...entry, name: entry.id ? groupNameOf(state, entry.id) : '未归类' }))
      .sort((a, b) => b.chars - a.chars),
    longest: [...live]
      .sort((a, b) => charsOf(b) - charsOf(a))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        title: item.title,
        chars: charsOf(item),
        group: item.groupId ? groupNameOf(state, item.groupId) : null,
      })),
  }
}

function recycledItems(state) {
  return state.items
    .filter((item) => item.deletedAt)
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
}

/** 回收站里只回必要字段：面板要能显示标题/内容片段，但不需要全部状态。 */
function recycleView(state) {
  return recycledItems(state).map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    tags: item.tags,
    groupId: item.groupId,
    status: item.status,
    anchorMode: item.anchorMode,
    source: item.source,
    deletedAt: item.deletedAt,
  }))
}

function snapshot(state, sessionId, extra) {
  const items = visibleItems(state)
  const pending = items.filter((item) => item.status === 'pending')
  const injection = composeInjection(state, sessionId)
  return {
    ok: true,
    dataDir: DATA_DIR,
    sync: { ...sync },
    gitAvailable: gitOk !== false,
    ...extra,
    groups: sortGroups(state.groups),
    items: sortItems(items),
    deleted: recycleView(state),
    archived: archiveView(state),
    capacity: capacityOf(state),
    tags: allTags(state),
    stats: {
      groups: state.groups.length,
      items: items.filter((item) => item.status === 'active').length,
      enabled: items.filter((item) => item.status === 'active' && item.enabled).length,
      pending: pending.length,
      pinned: items.filter((item) => item.pinned).length,
      deleted: recycledItems(state).length,
      archived: archivedItems(state).length,
    },
    session: sessionView(state, sessionId),
    preview: injection.text,
    injection: injection.stats,
    updatedAt: state.updatedAt,
  }
}

/* -------------------------------------------------------------------- ops */

function fail(message) {
  const error = new Error(message)
  error.memoryCenter = true
  return error
}

function requireItem(state, id) {
  const item = state.items.find((entry) => entry.id === id)
  if (!item) throw fail(`找不到记忆条目：${id}`)
  return item
}

function requireGroup(state, id) {
  const group = state.groups.find((entry) => entry.id === id)
  if (!group) throw fail(`找不到文件夹：${id}`)
  return group
}

/** 只接受真实存在的文件夹 id；外部传进来的过期/伪造 id 一律落回「未归类」。 */
function resolveGroupId(state, value) {
  return typeof value === 'string' && state.groups.some((group) => group.id === value) ? value : null
}

function nextOrder(list) {
  return list.reduce((max, entry) => Math.max(max, Number(entry.order) || 0), -1) + 1
}

/**
 * 删除要留墓碑，否则另一台设备同步上来会把删掉的条目「复活」。
 * 每次删除只记 id + 时间，本机不再需要这个 id 时才可清理（这里保留，量很小）。
 */
function markDeleted(state, ids) {
  if (!Array.isArray(state.deleted)) state.deleted = []
  const at = nowIso()
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const existing = state.deleted.find((entry) => entry.id === id)
    if (existing) existing.at = at
    else state.deleted.push({ id, at })
  }
}

function uniqueGroupName(state, name, exceptId) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw fail('文件夹名不能为空')
  const clash = state.groups.some(
    (group) => group.id !== exceptId && group.name.toLowerCase() === trimmed.toLowerCase(),
  )
  if (clash) throw fail(`文件夹「${trimmed}」已存在`)
  return trimmed
}

function dedupeKey(item) {
  return `${String(item.title ?? '').trim()}||${String(item.body ?? '').trim()}`
}

/**
 * 会话标题：优先用宿主给的 header.title，没有就用本轮第一条用户消息（与侧栏标题同源），
 * 再没有才退回会话 ID 前缀。标题只用于给「同一会话第 2 条起」的自动文件夹命名。
 */
function sessionTitleFrom(messages) {
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    if (message?.role !== 'user') continue
    // DSH 的用户消息带 source.kind === 'user'；插件注入、工具结果等不是用户说的，跳过。
    const kind = message?.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join(' ')
          : ''
    const clean = String(text).replace(/\s+/g, ' ').trim()
    if (clean) return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
  }
  return ''
}

function sessionOf(exec) {
  const session = exec?.session ?? exec?.agent?.session
  const id = session?.header?.id ?? session?.id ?? exec?.sessionId ?? null
  const headerTitle = session?.header?.title ?? session?.title ?? ''
  return { id: typeof id === 'string' && id ? id : null, headerTitle: typeof headerTitle === 'string' ? headerTitle.trim() : '' }
}

/** 同会话第 2 条起：确保有一个以会话标题命名的文件夹；已存在同名就复用。 */
function ensureGroupByName(state, name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return null
  const existing = state.groups.find((group) => group.name.toLowerCase() === trimmed.toLowerCase())
  if (existing) return existing
  const group = {
    id: `g-${randomUUID().slice(0, 8)}`,
    name: uniqueGroupName(state, trimmed),
    order: nextOrder(state.groups),
    createdAt: nowIso(),
  }
  state.groups.push(group)
  return group
}

function parseImportPayload(payload) {
  const raw = payload?.payload ?? payload?.data ?? payload
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw fail('导入内容不是合法的 JSON，请检查是否完整复制了导出文件')
    }
  }
  if (!parsed || typeof parsed !== 'object') throw fail('导入内容不是合法的 JSON 对象')
  const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : []
  const groups = Array.isArray(parsed.groups) ? parsed.groups : []
  return { groups, items }
}

function planImport(state, parsed) {
  const existing = new Set(state.items.map(dedupeKey))
  const additions = []
  let skipped = 0
  for (const candidate of parsed.items) {
    if (!candidate || typeof candidate !== 'object') continue
    const title = String(candidate.title ?? '').trim()
    const body = String(candidate.body ?? '')
    if (!title && !body.trim()) {
      skipped += 1
      continue
    }
    const item = {
      id: `m-${randomUUID().slice(0, 8)}`,
      title: title || '未命名记忆',
      body,
      tags: normalizeTags(candidate.tags),
      groupId: null,
      enabled: candidate.enabled !== false,
      pinned: candidate.pinned === true,
      status: 'active',
      source: 'import',
      order: state.items.length + additions.length,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    if (existing.has(dedupeKey(item))) {
      skipped += 1
      continue
    }
    existing.add(dedupeKey(item))
    additions.push({ item, groupName: typeof candidate.group === 'string' ? candidate.group : null })
  }
  return { additions, skipped }
}

async function runOp(op, payload) {
  const state = await ensureLoaded()
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : null

  switch (op) {
    case 'state':
      return snapshot(state, sessionId)

    case 'config.get':
      return {
        ok: true,
        dataDir: DATA_DIR,
        defaultDir: await defaultDataDir(),
        configFile: CONFIG_FILE,
        envLocked: Boolean(process.env.DSH_MEMORY_DIR),
        writable: await canWriteDir(DATA_DIR),
      }

    case 'config.set': {
      if (process.env.DSH_MEMORY_DIR) {
        throw fail('数据目录已被环境变量 DSH_MEMORY_DIR 固定，请先去掉该变量再在面板里修改')
      }
      const target = String(payload.dir ?? '').trim()
      if (!target) throw fail('请填写新的数据目录')
      if (!path.isAbsolute(target)) throw fail('请填写绝对路径，例如 E:\\memory-center')
      if (path.resolve(target) === path.resolve(DATA_DIR)) {
        return snapshot(state, sessionId, { message: '数据目录没有变化' })
      }
      const probe = path.join(target, `.write-test-${process.pid}`)
      try {
        await fs.mkdir(target, { recursive: true })
        await fs.writeFile(probe, 'ok', 'utf8')
        await fs.unlink(probe)
      } catch (error) {
        throw fail(`这个目录不可写：${error.message}`)
      }
      let mergeNote = ''
      if (payload.move !== false) {
        const targetStore = path.join(target, 'store.json')
        let targetRaw = null
        try {
          targetRaw = await fs.readFile(targetStore, 'utf8')
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw fail(`读取目标目录里的记忆失败：${error.message}`)
        }
        if (targetRaw === null) {
          try {
            await fs.copyFile(STORE_FILE, targetStore)
          } catch (error) {
            if (error && error.code !== 'ENOENT') throw fail(`复制记忆数据失败：${error.message}`)
          }
        } else {
          let incoming
          try {
            incoming = normalizeState(JSON.parse(targetRaw))
          } catch (error) {
            throw fail(`目标目录里已有 store.json，但不是合法 JSON，未做任何修改：${error.message}`)
          }
          if (incoming.groups.length || incoming.items.length) {
            // 目标目录不是空库：直接覆盖等于悄悄吞掉那边的记忆。改为条目级合并，
            // 并把目标原文件留一份 .pre-switch-<时间> 备份，事后可以人工核对。
            const current = store ?? normalizeState(await readJson(STORE_FILE, null))
            const merged = mergeStates(current, incoming)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            await fs.copyFile(targetStore, `${targetStore}.pre-switch-${stamp}`).catch(() => {})
            await queueWrite(targetStore, merged.state)
            mergeNote = `，并与目标目录已有记忆合并（新增 ${merged.added}、更新 ${merged.updated}、删除 ${merged.removed}）`
          }
        }
        try {
          await fs.copyFile(SESSIONS_FILE, path.join(target, path.basename(SESSIONS_FILE)))
        } catch (error) {
          if (error && error.code !== 'ENOENT') throw fail(`复制记忆数据失败：${error.message}`)
        }
      }
      await saveConfig(target)
      applyDataDir(target)
      store = null
      sessions = {}
      loading = null
      storeReadFailed = false
      writeChain = Promise.resolve()
      const reloaded = await ensureLoaded()
      return snapshot(reloaded, sessionId, { message: `数据目录已改为 ${target}${mergeNote}` })
    }

    case 'sync.get': {
      return { ok: true, sync: { ...sync }, dataDir: DATA_DIR, gitAvailable: await hasGit() }
    }

    case 'sync.set': {
      const next = normalizeSync({ ...sync, ...(payload.patch && typeof payload.patch === 'object' ? payload.patch : {}) })
      if (next.mode === 'git') {
        if (!next.remote) throw fail('请填写 Git 远端地址，例如 https://github.com/你/记忆库.git')
        if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/i.test(next.remote)) {
          throw fail('远端地址看起来不对，支持 https:// 、git@ 或本地路径')
        }
        if (!(await hasGit())) throw fail('这台机器上没找到 git，装好 Git 或设置环境变量 DSH_MEMORY_GIT')
      }
      if (next.mode === 'webdav') {
        if (!next.remote) throw fail('请填写 WebDAV 地址，例如 https://dav.jianguoyun.com/dav/记忆')
        if (!/^https?:\/\//i.test(next.remote)) throw fail('WebDAV 地址必须以 http:// 或 https:// 开头')
      }
      sync = normalizeSync({ ...next, lastSyncStatus: '', lastSyncError: '' })
      await saveConfig(DATA_DIR, { sync })
      const result = syncEnabled() && sync.autoPull ? await runSyncNow() : { status: 'idle', message: '已保存' }
      return snapshot(state, sessionId, {
        message: syncEnabled() ? `同步已启用（${result.status === 'ok' ? '已连上远端' : result.message}）` : '同步已关闭',
      })
    }

    case 'sync.now': {
      if (!syncEnabled()) throw fail('还没启用同步：先填写 Git 远端地址')
      const result = await runSyncNow()
      if (result.status === 'error') throw fail(`同步失败：${result.message}`)
      return snapshot(state, sessionId, { message: result.message || '已同步' })
    }

    case 'group.create': {
      const groupName = uniqueGroupName(state, payload.name)
      state.groups.push({
        id: `g-${randomUUID().slice(0, 8)}`,
        name: groupName,
        order: nextOrder(state.groups),
        createdAt: nowIso(),
      })
      await persist()
      return snapshot(state, sessionId, { message: `已创建文件夹「${groupName}」` })
    }

    case 'group.update': {
      const group = requireGroup(state, payload.id)
      group.name = uniqueGroupName(state, payload.name, group.id)
      await persist()
      return snapshot(state, sessionId, { message: `文件夹已重命名为「${group.name}」` })
    }

    case 'group.delete': {
      const group = requireGroup(state, payload.id)
      const mode = payload.mode === 'delete' ? 'delete' : 'keep'
      if (mode === 'delete') {
        // 同样先送回收站，删文件夹不该等于永久丢数据。
        const stamp = nowIso()
        for (const item of state.items) {
          if (item.groupId !== group.id || item.deletedAt) continue
          item.deletedAt = stamp
          item.updatedAt = stamp
        }
      } else {
        for (const item of state.items) {
          if (item.groupId === group.id) {
            item.groupId = null
            item.updatedAt = nowIso()
          }
        }
      }
      state.groups = state.groups.filter((entry) => entry.id !== group.id)
      for (const selection of Object.values(sessions)) {
        selection.groupIds = selection.groupIds.filter((id) => id !== group.id)
      }
      await persist()
      await persistSessions()
      return snapshot(state, sessionId, {
        message: mode === 'delete' ? `已删除文件夹「${group.name}」及其条目` : `已删除文件夹「${group.name}」，条目已移入未归类`,
      })
    }

    case 'group.move': {
      const groups = sortGroups(state.groups)
      const index = groups.findIndex((group) => group.id === payload.id)
      if (index < 0) throw fail(`找不到文件夹：${payload.id}`)
      const delta = payload.delta === -1 || payload.delta === 1 ? payload.delta : 0
      const target = index + delta
      if (!delta || target < 0 || target >= groups.length) return snapshot(state, sessionId)
      const swapped = groups[target]
      const current = groups[index]
      const currentOrder = current.order
      current.order = swapped.order
      swapped.order = currentOrder
      await persist()
      return snapshot(state, sessionId)
    }

    case 'group.reorder': {
      const ids = Array.isArray(payload.ids) ? payload.ids : []
      let order = 0
      for (const id of ids) {
        const group = state.groups.find((entry) => entry.id === id)
        if (group) group.order = order++
      }
      await persist()
      return snapshot(state, sessionId)
    }

    case 'item.create': {
      const title = String(payload.title ?? '').trim()
      const body = String(payload.body ?? '')
      if (!title && !body.trim()) throw fail('标题和正文不能都为空')
      const item = {
        id: `m-${randomUUID().slice(0, 8)}`,
        title: title || '未命名记忆',
        body,
        tags: normalizeTags(payload.tags),
        groupId: resolveGroupId(state, payload.groupId),
        enabled: payload.enabled !== false,
        pinned: payload.pinned === true,
        status: 'active',
        source: 'manual',
        anchorMode: ['full', 'weight'].includes(payload.anchorMode) ? payload.anchorMode : 'off',
        order: nextOrder(state.items),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      state.items.push(item)
      await persist()
      return snapshot(state, sessionId, { message: `已新增记忆「${item.title}」`, focusId: item.id })
    }

    case 'item.update': {
      const item = requireItem(state, payload.id)
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      if ('title' in patch) {
        const title = String(patch.title ?? '').trim()
        if (!title) throw fail('标题不能为空')
        item.title = title
      }
      if ('body' in patch) item.body = String(patch.body ?? '')
      if ('tags' in patch) item.tags = normalizeTags(patch.tags)
      if ('groupId' in patch) item.groupId = resolveGroupId(state, patch.groupId)
      if ('enabled' in patch) item.enabled = patch.enabled !== false
      if ('pinned' in patch) item.pinned = patch.pinned === true
      if ('anchorMode' in patch) item.anchorMode = ['full', 'weight'].includes(patch.anchorMode) ? patch.anchorMode : 'off'
      if ('status' in patch) item.status = patch.status === 'pending' ? 'pending' : 'active'
      item.updatedAt = nowIso()
      await persist()
      return snapshot(state, sessionId, { message: `已更新「${item.title}」`, focusId: item.id })
    }

    case 'item.batch': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      let changed = 0
      for (const id of ids) {
        const item = state.items.find((entry) => entry.id === id && !entry.deletedAt)
        if (!item) continue
        if ('enabled' in patch) item.enabled = patch.enabled !== false
        if ('pinned' in patch) item.pinned = patch.pinned === true
        if ('status' in patch) item.status = patch.status === 'pending' ? 'pending' : 'active'
        if ('groupId' in patch) item.groupId = resolveGroupId(state, patch.groupId)
        if ('anchorMode' in patch) item.anchorMode = ['full', 'weight'].includes(patch.anchorMode) ? patch.anchorMode : 'off'
        // 批量打标：把标签并到每条已有标签上，不覆盖用户原来的分类。
        if (Array.isArray(patch.addTags)) {
          const merged = new Set(item.tags)
          for (const tag of normalizeTags(patch.addTags)) merged.add(tag)
          item.tags = [...merged]
        }
        if (Array.isArray(patch.removeTags)) {
          const drop = new Set(normalizeTags(patch.removeTags))
          item.tags = item.tags.filter((tag) => !drop.has(tag))
        }
        item.updatedAt = nowIso()
        changed += 1
      }
      await persist()
      return snapshot(state, sessionId, { message: `已更新 ${changed} 条记忆` })
    }

    case 'item.delete': {
      // 软删除：先移进回收站（保留全部字段），用户在回收站里还能捞回来。
      // 只有 recycle.purge 才真正从库里删掉，并在那里写墓碑用于跨设备同步。
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : [payload.id]
      const stamp = nowIso()
      let moved = 0
      for (const item of state.items) {
        if (!ids.includes(item.id) || item.deletedAt) continue
        item.deletedAt = stamp
        item.updatedAt = stamp
        moved += 1
      }
      for (const selection of Object.values(sessions)) {
        selection.itemIds = selection.itemIds.filter((id) => !ids.includes(id))
      }
      await persist()
      await persistSessions()
      return snapshot(state, sessionId, {
        message: moved ? `已移入回收站 ${moved} 条（在「回收站」里可以恢复）` : '这些记忆已经在回收站里了',
      })
    }

    case 'item.archive': {
      // 归档 = 从活跃层挪到归档层：不参与注入、不进默认检索，内容完整保留，随时可还原。
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : [payload.id]
      const stamp = nowIso()
      let moved = 0
      for (const item of state.items) {
        if (!ids.includes(item.id) || item.deletedAt || item.archivedAt) continue
        item.archivedAt = stamp
        item.updatedAt = stamp
        moved += 1
      }
      for (const selection of Object.values(sessions)) {
        selection.itemIds = selection.itemIds.filter((id) => !ids.includes(id))
      }
      await persist()
      await persistSessions()
      return snapshot(state, sessionId, {
        message: moved ? `已归档 ${moved} 条（不再注入，可在「归档」里还原）` : '这些记忆已经归档了',
      })
    }

    case 'item.unarchive': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : [payload.id]
      const stamp = nowIso()
      let moved = 0
      for (const item of state.items) {
        if (!ids.includes(item.id) || !item.archivedAt) continue
        delete item.archivedAt
        delete item.mergedInto
        item.updatedAt = stamp
        moved += 1
      }
      await persist()
      return snapshot(state, sessionId, { message: moved ? `已还原 ${moved} 条` : '这些记忆不在归档里' })
    }

    case 'item.merge': {
      // 压缩：把多条合并成一条精炼记忆，原条目进归档层（可回溯），不物理删除。
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
      const sources = ids
        .map((id) => state.items.find((entry) => entry.id === id))
        .filter((item) => item && !item.deletedAt && !item.archivedAt)
      if (sources.length < 2) throw fail('至少选择 2 条记忆才能合并')
      const title = String(payload.title ?? '').trim() || `${sources[0].title}（合并 ${sources.length} 条）`
      const body =
        String(payload.body ?? '').trim() ||
        sources
          .slice()
          .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
          .map((item) => {
            const stamp = String(item.updatedAt ?? item.createdAt ?? '').slice(0, 10)
            return `### ${item.title}${stamp ? `（${stamp}）` : ''}\n${String(item.body ?? '').trim()}`
          })
          .join('\n\n')
      const tags = [...new Set(sources.flatMap((item) => item.tags ?? []))]
      const groupId = sources.find((item) => item.groupId)?.groupId ?? null
      const anchorMode = sources.some((item) => item.anchorMode === 'full')
        ? 'full'
        : sources.some((item) => item.anchorMode === 'weight')
          ? 'weight'
          : 'off'
      const merged = {
        id: `m-${randomUUID().slice(0, 8)}`,
        title,
        body,
        tags,
        groupId,
        enabled: true,
        pinned: false,
        status: 'active',
        source: 'merge',
        anchorMode,
        order: nextOrder(state.items),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      state.items.push(merged)
      const stamp = nowIso()
      for (const item of sources) {
        item.archivedAt = stamp
        item.mergedInto = merged.id
        item.updatedAt = stamp
      }
      await persist()
      return snapshot(state, sessionId, {
        message: `已把 ${sources.length} 条合并成「${title}」，原条目已归档可回溯`,
        focusId: merged.id,
      })
    }

    case 'item.restore': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : [payload.id]
      let restored = 0
      for (const item of state.items) {
        if (!ids.includes(item.id) || !item.deletedAt) continue
        delete item.deletedAt
        item.updatedAt = nowIso()
        restored += 1
      }
      await persist()
      return snapshot(state, sessionId, { message: restored ? `已恢复 ${restored} 条记忆` : '没有可恢复的记忆' })
    }

    case 'recycle.purge': {
      // 真正删除：写墓碑，另一台设备同步后也会一起删掉。
      const all = payload.all === true
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : [payload.id]
      const targets = state.items.filter((item) => item.deletedAt && (all || ids.includes(item.id)))
      if (!targets.length) return snapshot(state, sessionId, { message: '回收站是空的' })
      markDeleted(
        state,
        targets.map((item) => item.id),
      )
      const targetIds = new Set(targets.map((item) => item.id))
      state.items = state.items.filter((item) => !targetIds.has(item.id))
      for (const selection of Object.values(sessions)) {
        selection.itemIds = selection.itemIds.filter((id) => !targetIds.has(id))
      }
      await persist()
      await persistSessions()
      return snapshot(state, sessionId, { message: `已彻底删除 ${targets.length} 条记忆（无法恢复）` })
    }

    case 'item.duplicate': {
      const item = requireItem(state, payload.id)
      const copy = {
        ...item,
        id: `m-${randomUUID().slice(0, 8)}`,
        title: `${item.title}（副本）`,
        order: nextOrder(state.items),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      state.items.push(copy)
      await persist()
      return snapshot(state, sessionId, { message: '已复制', focusId: copy.id })
    }

    case 'item.move': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
      const groupId = resolveGroupId(state, payload.groupId)
      for (const id of ids) {
        const item = state.items.find((entry) => entry.id === id)
        if (!item) continue
        item.groupId = groupId
        item.updatedAt = nowIso()
      }
      await persist()
      return snapshot(state, sessionId, { message: `已移动 ${ids.length} 条记忆` })
    }

    case 'item.confirm': {
      const ids = Array.isArray(payload.ids)
        ? payload.ids.filter((id) => typeof id === 'string')
        : typeof payload.id === 'string'
          ? [payload.id]
          : []
      for (const id of ids) {
        const item = state.items.find((entry) => entry.id === id)
        if (!item) continue
        item.status = 'active'
        item.updatedAt = nowIso()
      }
      await persist()
      return snapshot(state, sessionId, { message: `已转正 ${ids.length} 条记忆` })
    }

    case 'session.set': {
      if (!sessionId) throw fail('缺少会话 ID')
      const mode = ['none', 'all', 'custom'].includes(payload.mode) ? payload.mode : 'none'
      sessions[sessionId] = {
        mode,
        groupIds: Array.isArray(payload.groupIds) ? payload.groupIds.filter((id) => typeof id === 'string') : [],
        itemIds: Array.isArray(payload.itemIds) ? payload.itemIds.filter((id) => typeof id === 'string') : [],
        decidedAt: nowIso(),
      }
      await persistSessions()
      return snapshot(state, sessionId, {
        message:
          mode === 'none'
            ? '本会话不加载记忆'
            : mode === 'all'
              ? '本会话加载全部启用记忆'
              : '本会话记忆已更新',
      })
    }

    case 'session.add': {
      if (!sessionId) throw fail('缺少会话 ID')
      const current = sessions[sessionId] ?? { mode: 'custom', groupIds: [], itemIds: [], decidedAt: nowIso() }
      const groupIds = new Set(current.mode === 'all' ? [] : current.groupIds)
      const itemIds = new Set(current.mode === 'all' ? [] : current.itemIds)
      for (const id of Array.isArray(payload.groupIds) ? payload.groupIds : []) {
        if (typeof id === 'string') groupIds.add(id)
      }
      for (const id of Array.isArray(payload.itemIds) ? payload.itemIds : []) {
        if (typeof id === 'string') itemIds.add(id)
      }
      sessions[sessionId] = {
        mode: 'custom',
        groupIds: [...groupIds],
        itemIds: [...itemIds],
        decidedAt: nowIso(),
      }
      await persistSessions()
      return snapshot(state, sessionId, { message: '已追加到本会话，下一轮生效' })
    }

    case 'session.reset': {
      if (!sessionId) throw fail('缺少会话 ID')
      delete sessions[sessionId]
      await persistSessions()
      return snapshot(state, sessionId, { message: '已清除本会话的记忆选择' })
    }

    case 'import.preview': {
      const parsed = parseImportPayload(payload)
      const { additions, skipped } = planImport(state, parsed)
      return {
        ok: true,
        preview: true,
        willAdd: additions.length,
        willSkip: skipped,
        sample: additions.slice(0, 12).map(({ item }) => ({ title: item.title, tags: item.tags })),
        groups: parsed.groups.length,
      }
    }

    case 'import.apply': {
      const parsed = parseImportPayload(payload)
      const { additions, skipped } = planImport(state, parsed)
      const createdGroups = new Map()
      let itemOrder = nextOrder(state.items)
      for (const { item, groupName } of additions) {
        if (groupName) {
          const existing = state.groups.find((group) => group.name === groupName)
          if (existing) item.groupId = existing.id
          else {
            if (!createdGroups.has(groupName)) {
              const group = {
                id: `g-${randomUUID().slice(0, 8)}`,
                name: groupName,
                order: nextOrder(state.groups),
                createdAt: nowIso(),
              }
              state.groups.push(group)
              createdGroups.set(groupName, group)
            }
            item.groupId = createdGroups.get(groupName).id
          }
        }
        item.order = itemOrder++
        state.items.push(item)
      }
      await persist()
      return snapshot(state, sessionId, { message: `已导入 ${additions.length} 条，跳过 ${skipped} 条` })
    }

    case 'export': {
      const exportItems = visibleItems(state)
      const json = JSON.stringify(
        {
          version: 1,
          exportedAt: nowIso(),
          groups: sortGroups(state.groups).map((group) => ({ name: group.name, order: group.order })),
          items: sortItems(exportItems).map((item) => ({
            title: item.title,
            body: item.body,
            tags: item.tags,
            group: item.groupId ? groupNameOf(state, item.groupId) : null,
            enabled: item.enabled,
            pinned: item.pinned,
            status: item.status,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        },
        null,
        2,
      )
      const md = [
        '# 记忆库导出',
        '',
        `导出时间：${new Date().toLocaleString('zh-CN')}`,
        `条目数：${exportItems.length}`,
        '',
        ...sortGroups(state.groups).flatMap((group) => [
          `## ${group.name}`,
          '',
          ...sortItems(exportItems.filter((item) => item.groupId === group.id)).flatMap((item) => [
            `### ${item.pinned ? '📌 ' : ''}${item.title}${item.enabled ? '' : '（已停用）'}`,
            '',
            item.body,
            '',
            item.tags.length ? `标签：${item.tags.join('、')}` : '',
            '',
          ]),
        ]),
        '## 未归类',
        '',
        ...sortItems(state.items.filter((item) => !item.groupId)).flatMap((item) => [
          `### ${item.pinned ? '📌 ' : ''}${item.title}`,
          '',
          item.body,
          '',
        ]),
      ].join('\n')
      return { ok: true, json, markdown: md }
    }

    case 'search': {
      const query = String(payload.query ?? '').trim().toLowerCase()
      if (!query) throw fail('搜索词不能为空')
      const includeArchived = payload.includeArchived === true
      const hits = state.items
        .filter((item) => !item.deletedAt && item.status === 'active' && item.enabled)
        .filter((item) => includeArchived || !item.archivedAt)
        .filter((item) =>
          `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase().includes(query),
        )
        .slice(0, 50)
      return {
        ok: true,
        hits: hits.map((item) => ({
          id: item.id,
          title: item.title,
          group: groupNameOf(state, item.groupId),
          tags: item.tags,
          body: item.body,
          archived: Boolean(item.archivedAt),
        })),
      }
    }

    default:
      throw fail(`未知操作：${op}`)
  }
}

/* ------------------------------------------------------------------ http */

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw fail('导入内容过大（上限 8MB）')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * 面板是从同源页面发请求的：Origin 缺省或 'null'（file://、沙箱 iframe）之外，
 * 必须与 Host 同源；Sec-Fetch-Site 只接受 same-origin / none。
 * 这样即使别的网站用 text/plain 简单请求 POST 过来，也写不进记忆库。
 */
function requestFromPanel(req) {
  const host = req.headers?.host
  const origin = req.headers?.origin
  if (origin && origin !== 'null') {
    try {
      if (!host || new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const site = req.headers?.['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  return true
}

async function handleHttp(req, res) {
  try {
    if (!requestFromPanel(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return
    }
    if (req.method === 'GET') {
      const state = await ensureLoaded()
      sendJson(res, 200, snapshot(state, null))
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!type.startsWith('application/json')) {
      // 不带 JSON content-type 的跨站「简单请求」不需要预检，必须在入口拦掉。
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      return
    }
    const raw = await readBody(req)
    let payload = {}
    try {
      payload = JSON.parse(raw || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    const result = await runOp(payload.op, payload)
    sendJson(res, 200, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, error && error.memoryCenter ? 400 : 500, { ok: false, error: message })
  }
}

/* ------------------------------------------------------------------ tools */

function textResult(value) {
  return value
}

function registerTools(ctx) {
  ctx.tools.register({
    name: 'memory_search',
    description:
      '检索用户长期记忆库中已启用的记忆（标题、正文、标签子串匹配）。当需要确认用户的偏好、约定或此前记录的事实，且这些信息可能已在记忆库中时使用。返回条目标题、文件夹、标签与正文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词；为空时返回全部启用记忆的标题列表' },
        limit: { type: 'integer', description: '最多返回条数，默认 10，上限 50' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const state = await ensureLoaded()
      const query = String(args?.query ?? '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
      const includeArchived = args?.includeArchived === true
      const base = state.items.filter(
        (item) => !item.deletedAt && item.status === 'active' && item.enabled,
      )
      const pool = base.filter((item) => includeArchived || !item.archivedAt)
      const archivedCount = base.filter((item) => item.archivedAt).length
      const hits = (
        query
          ? pool.filter((item) =>
              `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase().includes(query),
            )
          : pool
      ).slice(0, limit)
      const archivedNote =
        archivedCount && !includeArchived ? `（另有 ${archivedCount} 条已归档，默认不参与检索）` : ''
      if (!hits.length) {
        return `记忆库中没有匹配「${args?.query ?? ''}」的启用记忆（共 ${pool.length} 条启用记忆）${archivedNote}。`
      }
      const lines = [
        `匹配 ${hits.length} 条（记忆库共 ${pool.length} 条启用记忆）${archivedNote}：`,
        '',
        ...hits.flatMap((item) => [
          `- ${item.pinned ? '📌 ' : ''}${item.title}  〔${groupNameOf(state, item.groupId)}${item.tags.length ? ' / ' + item.tags.join(' / ') : ''}〕${item.archivedAt ? ' 〔已归档〕' : ''}`,
          ...item.body
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(0, 8)
            .map((line) => `  ${line}`),
          '',
        ]),
      ]
      return lines.join('\n').trimEnd()
    },
  })

  ctx.tools.register({
    name: 'memory_write',
    description:
      '向用户长期记忆库写入一条候选记忆。判断顺序：用户明说「记一下/记住」直接写；命中偏好、固定事实、拍板决策的关键词就写（只排除明显只对这一次有效的临时状态）；没命中关键词再自判它跨会话是否有用，拿不准就先问。新记忆先落「待确认」；同一个会话累计到第 2 条起，会自动连同前面的候选一起放进一个以会话标题命名的文件夹（仍待确认），不需要你传文件夹。必须由用户在「记忆」面板点「转正」才会生效并参与后续注入。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话结论（不是分类名），便于用户扫读' },
        body: { type: 'string', description: '具体值、为什么、例外/边界；一条只讲一件事，可含 Markdown' },
        tags: { type: 'string', description: '可选：逗号分隔的标签（归类由用户自己拖进文件夹，无需填文件夹）' },
      },
      required: ['title', 'body'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = await ensureLoaded()
      const title = String(args?.title ?? '').trim()
      const body = String(args?.body ?? '')
      if (!title && !body.trim()) return '写入失败：标题与正文不能同时为空。'
      const tags = normalizeTags(String(args?.tags ?? '').split(','))
      const { id: sessionId, headerTitle } = sessionOf(exec)
      const item = {
        id: `m-${randomUUID().slice(0, 8)}`,
        title: title || '未命名记忆',
        body,
        tags,
        groupId: null,
        enabled: true,
        pinned: false,
        status: 'pending',
        source: 'auto',
        sessionId,
        order: nextOrder(state.items),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      state.items.push(item)

      // 同一会话累计到第 2 条记忆时，整组的候选记忆一起放进「以会话标题命名」的文件夹；
      // 状态仍是 pending，直到用户转正——这里只替用户省掉建文件夹和拖拽，不替他决定生效。
      let groupId = null
      if (sessionId) {
        const siblings = state.items.filter((entry) => entry.sessionId === sessionId)
        if (siblings.length >= 2) {
          const remembered = sessionTitles.get(sessionId) || headerTitle || `会话 ${sessionId.slice(0, 8)}`
          const group = ensureGroupByName(state, remembered)
          if (group) {
            for (const entry of siblings) {
              if (!entry.groupId) entry.groupId = group.id
            }
            groupId = group.id
          }
        }
      }
      await persist()
      const ordinal = sessionId ? state.items.filter((entry) => entry.sessionId === sessionId).length : 0
      const where = groupId ? `已连同本会话其它记忆放进文件夹「${groupNameOf(state, groupId)}」` : '放在「未归类」'
      return `已写入待确认记忆「${item.title}」（本会话第 ${ordinal} 条，${where}）。请在「记忆」面板的「待确认」里审核：转正后才生效并参与注入。`
    },
  })
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx) {
  const lastInjected = new Map()

  const logger = ctx.logger ?? ctx.getLogger?.('memory-center')
  const log = (level, message, meta) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, message, meta)
    } catch {
      /* logging must never break a turn */
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() =>
      scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleHttp }),
    )
  })

  ctx.inject(['tools'], (toolCtx) => {
    registerTools(toolCtx)
  })

  // 决定“要不要记”的规则必须写进系统提示：只靠工具描述，模型在长对话里常常一句都不写。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'memory-center:policy',
      order: 400,
      text: MEMORY_POLICY,
    })
  })

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'enter' || payload?.signal?.aborted) return decision
      const sessionId = payload?.agent?.session?.header?.id
      if (!sessionId) return decision
      // 记下会话标题：宿主 header 里通常没有 title，就取本轮第一条用户消息
      // （GUI 侧栏标题同源），供「同一会话第 2 条记忆」的自动文件夹命名。
      if (!sessionTitles.has(sessionId)) {
        const title = sessionTitleFrom(decision.messages) || String(payload?.agent?.session?.header?.title ?? '').trim()
        if (title) sessionTitles.set(sessionId, title)
      }
      const state = await ensureLoaded()
      const text = buildInjection(state, sessionId)
      if (!text) return decision
      // 只比文本不够：上下文压缩会把上一次的 recall 消息裁掉，这时即使文本没变
      // 也必须重新注入，否则这一轮之后模型就再也看不到记忆了。
      const recallInContext =
        Array.isArray(decision.messages) &&
        decision.messages.some((message) => message?.source?.kind === `plugin:${PLUGIN_ID}`)
      if (recallInContext && lastInjected.get(sessionId) === text) return decision
      lastInjected.set(sessionId, text)
      log('info', `注入记忆 ${text.length} 字符`, { session: sessionId })
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: `plugin:${PLUGIN_ID}`, form: 'recall' },
          },
        ],
      }
    },
    { prepend: true },
  )

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (sessionId) {
      lastInjected.delete(sessionId)
      sessionTitles.delete(sessionId)
    }
  })

  log('info', 'memory-center loaded', { dataDir: DATA_DIR })
}

export default { name, inject, apply }
