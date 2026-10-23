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
import { inferAnchor } from './lib/anchor.js'
import { groupTopics } from './lib/topics.js'
import { SYNONYM_GROUPS, buildIndex, searchItems } from './lib/retrieval.js'
import { hasGit, mergeStates, normalizeSync, syncNow as runSync } from './lib/sync.js'

export const name = 'memory-center'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-memory'
const CONFIG_ENV = process.env.DSH_MEMORY_CONFIG || ''

/**
 * 注入上限（字符）：超过就截断，且「上限 × 压缩阈值」是开始压缩的那条线。
 * 优先级：环境变量 DSH_MEMORY_MAX_CHARS > 面板里调过的值（config.json 的 maxChars）> 12000。
 * 注意是字符不是 token：不同语种信息密度不同，面板里也标注了这一点。
 */
function parseMaxChars(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 1000 || rounded > 200000) return null
  return rounded
}

const DEFAULT_MAX_CHARS = 12000
const ENV_MAX_CHARS = parseMaxChars(process.env.DSH_MEMORY_MAX_CHARS)
let MAX_INJECT_CHARS = ENV_MAX_CHARS ?? DEFAULT_MAX_CHARS

/**
 * 压缩阈值：记忆总量超过「上限 × 该比例」时，注入开始压缩（超出部分只给标题）。
 * 默认 80%——留 20% 余量给统计行、索引清单和以后新增的记忆，避免一加就爆。
 * 优先级：环境变量 DSH_MEMORY_COMPRESS_RATIO > 面板里拖过的值（存在 config.json 的 injectRatio）> 0.8。
 */
const DEFAULT_COMPRESS_RATIO = 0.8

/** 0.1–1 之间返回两位小数，否则返回 null（调用方决定回退还是报错）。 */
function parseRatio(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0.1 || value > 1) return null
  return Math.round(value * 100) / 100
}

const ENV_COMPRESS_RATIO = parseRatio(process.env.DSH_MEMORY_COMPRESS_RATIO)
let COMPRESS_RATIO = ENV_COMPRESS_RATIO ?? DEFAULT_COMPRESS_RATIO
let SOFT_INJECT_CHARS = Math.max(1000, Math.floor(MAX_INJECT_CHARS * COMPRESS_RATIO))

function applyCompressRatio(ratio) {
  COMPRESS_RATIO = ratio
  SOFT_INJECT_CHARS = Math.max(1000, Math.floor(MAX_INJECT_CHARS * ratio))
}

function applyMaxChars(chars) {
  MAX_INJECT_CHARS = chars
  SOFT_INJECT_CHARS = Math.max(1000, Math.floor(MAX_INJECT_CHARS * COMPRESS_RATIO))
}

/**
 * 新会话的默认加载策略：用户不想每个会话都被问一次。
 * mode=ask 时保持原行为（弹卡片让你选）；none/all 直接生效；custom 用 groupIds 指定文件夹。
 * 存 config.json 的 sessionDefault（可以进 profile.json 同步，见 lib/sync.js）。
 */
const SESSION_DEFAULT_MODES = ['ask', 'none', 'all', 'custom']

function normalizeSessionDefault(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mode = SESSION_DEFAULT_MODES.includes(source.mode) ? source.mode : 'ask'
  const groupIds = Array.isArray(source.groupIds)
    ? source.groupIds.filter((id) => typeof id === 'string' && id)
    : []
  if (mode === 'custom' && !groupIds.length) return { mode: 'ask', groupIds: [] }
  return { mode, groupIds: mode === 'custom' ? groupIds : [] }
}

let SESSION_DEFAULT = { mode: 'ask', groupIds: [] }
/** 全局暂停注入：只影响「要不要把记忆塞进上下文」，不改库里的任何数据。 */
let INJECTION_PAUSED = false

/**
 * 回收站保留天数：超过这个天数的软删除条目在下次加载时自动彻底删除（并写墓碑）。
 * 设 DSH_MEMORY_RECYCLE_DAYS=0 表示永不自动清理。范围 0–3650，默认 30 天。
 */
function parseRecycleDays(raw) {
  if (raw === undefined || raw === null || raw === '') return 30
  const value = Number(raw)
  if (!Number.isFinite(value)) return 30
  return Math.min(3650, Math.max(0, Math.round(value)))
}

const ENV_RECYCLE_DAYS = process.env.DSH_MEMORY_RECYCLE_DAYS
  ? parseRecycleDays(process.env.DSH_MEMORY_RECYCLE_DAYS)
  : null
const DEFAULT_RECYCLE_DAYS = 30
// 可在面板里改（写 config.json 的 recycleDays），设了环境变量时以环境变量为准
let RECYCLE_KEEP_DAYS = ENV_RECYCLE_DAYS ?? DEFAULT_RECYCLE_DAYS
/**
 * 墓碑（deleted 数组）保留天数：墓碑是「这条被删过」的同步凭据，留太短会让
 * 另一台设备上的旧副本把条目推回来，留太长则文件只增不减。90 天是折中。
 */
const TOMBSTONE_KEEP_DAYS = 90

/**
 * 检索用的同义组：内置一组中文常见说法，用户可在面板里追加自己的说法（v0.9.5 起，
 * 之前只能手改 config.json 的 synonyms 并重启）。检索时按 0.5 权重扩展召回。
 */
let SYNONYMS = SYNONYM_GROUPS
/** 用户自建的同义词组（原始形态，面板要回显），与内置组合并后才是 SYNONYMS。 */
let CUSTOM_SYNONYMS = []

const SYNONYM_MAX_GROUPS = 80
const SYNONYM_MAX_WORDS = 8
const SYNONYM_MAX_LEN = 24

/** 清理用户提交的同义词组：去空、去重、每组至少 2 个词、限条数与词长。返回 null 表示整体非法。 */
function normalizeSynonymGroups(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out = []
  for (const entry of raw) {
    const words = (Array.isArray(entry) ? entry : [entry])
      .map((word) => String(word ?? '').trim().slice(0, SYNONYM_MAX_LEN))
      .filter(Boolean)
    const unique = [...new Set(words)]
    if (unique.length < 2) continue
    out.push(unique.slice(0, SYNONYM_MAX_WORDS))
    if (out.length >= SYNONYM_MAX_GROUPS) break
  }
  return out
}

/**
 * 检索索引缓存：条目上千时每次搜索重建倒排索引会掉帧（面板搜索框是逐键触发）。
 * 键 = 库最后写入时间 + 候选池规模 + 池首尾 id，任一变化就重建。
 */
let searchCache = { key: '', index: null }

function searchWithCache(pool, query, limit, tag = '') {
  const key = `${tag}|${store && store.updatedAt}|${pool.length}|${pool[0] && pool[0].id}|${pool[pool.length - 1] && pool[pool.length - 1].id}`
  if (searchCache.key !== key || !searchCache.index || searchCache.index.size !== pool.length) {
    searchCache = { key, index: buildIndex(pool) }
  }
  return searchItems(pool, query, { limit, synonyms: SYNONYMS, index: searchCache.index })
}

function mergeSynonyms(custom) {
  const groups = SYNONYM_GROUPS.map((group) => [...group])
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      const words = (Array.isArray(entry) ? entry : [entry])
        .map((word) => String(word ?? '').trim())
        .filter(Boolean)
      if (words.length >= 2) groups.push(words)
    }
  }
  return groups
}

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
let BACKUP_DIR = ''
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
  BACKUP_DIR = path.join(dir, 'backups')
}

/* ------------------------------------------------------------- 备份生命周期 */

/**
 * 备份统一放 `<数据目录>/backups/`，而不是散在数据目录根下：
 *   corrupt-<时间>.json      库文件坏到修不好时，坏文件被挪进来
 *   pre-switch-<时间>.json   面板切数据目录、目标已有记忆时，切之前的备份
 *   pre-purge-<时间>.json    回收站到期清理前，清理之前的备份
 *   conflict-<时间>.json     同步时同一条被两台设备都改过，输掉的那一版
 * 每种只保留最近 BACKUP_KEEP_PER_KIND 份；清理只碰 backups/ 里的这几类文件，
 * 永远不碰 store.json / config.json / sessions.json。
 */
const BACKUP_KINDS = ['corrupt', 'pre-switch', 'pre-purge', 'conflict']
const BACKUP_KEEP_PER_KIND = 5
const LEGACY_BACKUP_PREFIX = 'store.json.'

function newStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backupPath(kind, stamp = newStamp(), dir = BACKUP_DIR) {
  return path.join(dir, `${kind}-${stamp}.json`)
}

/** 复制一份备份（源文件保留）。失败不阻断主流程。dir 默认当前数据目录的 backups/。 */
async function writeBackup(sourceFile, kind, dir = BACKUP_DIR) {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(sourceFile, backupPath(kind, newStamp(), dir))
    await pruneBackups(BACKUP_KEEP_PER_KIND, dir)
  } catch {
    /* 备份失败不影响主流程 */
  }
}

/** 把一段 JSON 直接写成备份（不是复制现有文件）。返回写出的文件名，失败返回空串。 */
async function writeJsonBackup(kind, value, dir = BACKUP_DIR) {
  try {
    await fs.mkdir(dir, { recursive: true })
    const file = backupPath(kind, newStamp(), dir)
    await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
    await pruneBackups(BACKUP_KEEP_PER_KIND, dir)
    return path.basename(file)
  } catch {
    return ''
  }
}

/** 把源文件挪成备份（源文件不该再留在原位时用，例如坏掉的 store.json）。 */
async function moveToBackup(sourceFile, kind, dir = BACKUP_DIR) {
  try {
    await fs.mkdir(dir, { recursive: true })
    const dest = backupPath(kind, newStamp(), dir)
    try {
      await fs.rename(sourceFile, dest)
    } catch {
      await fs.copyFile(sourceFile, dest)
      await fs.unlink(sourceFile).catch(() => {})
    }
    await pruneBackups(BACKUP_KEEP_PER_KIND, dir)
  } catch {
    /* 备份失败不影响主流程 */
  }
}

/** 每种备份只留最近 keep 份（按 mtime）。返回删掉几份。 */
async function pruneBackups(keep = BACKUP_KEEP_PER_KIND, dir = BACKUP_DIR) {
  let entries = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { removed: 0 }
  }
  const groups = new Map()
  for (const name of entries) {
    const kind = BACKUP_KINDS.find((candidate) => name.startsWith(`${candidate}-`))
    if (!kind) continue
    const full = path.join(dir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (!stat || !stat.isFile()) continue
    if (!groups.has(kind)) groups.set(kind, [])
    groups.get(kind).push({ full, mtime: stat.mtimeMs })
  }
  let removed = 0
  for (const list of groups.values()) {
    list.sort((a, b) => b.mtime - a.mtime)
    for (const entry of list.slice(keep)) {
      await fs.unlink(entry.full).then(() => { removed += 1 }).catch(() => {})
    }
  }
  return { removed }
}

/** 老版本把备份写在数据目录根下（store.json.corrupt-…），这里挪进 backups/。 */
async function migrateLegacyBackups() {
  let entries = []
  try {
    entries = await fs.readdir(DATA_DIR)
  } catch {
    return
  }
  const legacy = entries.filter((name) => name.startsWith(LEGACY_BACKUP_PREFIX))
  if (!legacy.length) return
  await fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {})
  for (const name of legacy) {
    const rest = name.slice(LEGACY_BACKUP_PREFIX.length)
    const kind = BACKUP_KINDS.find((candidate) => rest.startsWith(`${candidate}-`))
    if (!kind) continue
    const from = path.join(DATA_DIR, name)
    const to = path.join(BACKUP_DIR, `${kind}-${rest.slice(kind.length + 1)}`)
    try {
      if (await fs.stat(to).then(() => true).catch(() => false)) {
        await fs.unlink(from)
      } else {
        await fs.rename(from, to)
      }
    } catch {
      /* 挪不动就算了，不影响使用 */
    }
  }
  await pruneBackups()
}

/** 面板要显示的备份概况：数量、总大小、每种各有几份。 */
async function backupInfo() {
  const info = { dir: BACKUP_DIR, count: 0, bytes: 0, kinds: {} }
  let entries = []
  try {
    entries = await fs.readdir(BACKUP_DIR)
  } catch {
    return info
  }
  for (const name of entries) {
    const kind = BACKUP_KINDS.find((candidate) => name.startsWith(`${candidate}-`))
    if (!kind) continue
    const stat = await fs.stat(path.join(BACKUP_DIR, name)).catch(() => null)
    if (!stat || !stat.isFile()) continue
    info.count += 1
    info.bytes += stat.size
    info.kinds[kind] = (info.kinds[kind] || 0) + 1
  }
  return info
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
  const config = await readConfigFile(CONFIG_FILE)
  sync = normalizeSync(config.sync)
  // 面板里拖过的压缩阈值；环境变量优先，设了环境变量就不读盘上的值。
  const savedRatio = parseRatio(config.injectRatio)
  if (ENV_COMPRESS_RATIO === null && savedRatio !== null) applyCompressRatio(savedRatio)
  // 注入上限：环境变量优先，否则读面板里调过的值。
  const savedMax = parseMaxChars(config.maxChars)
  if (ENV_MAX_CHARS === null && savedMax !== null) applyMaxChars(savedMax)
  // 新会话默认加载策略（不想每个会话都被问一次时用）。
  SESSION_DEFAULT = normalizeSessionDefault(config.sessionDefault)
  // 全局暂停注入：临时不想让任何记忆进上下文时用，不影响库里的数据。
  INJECTION_PAUSED = config.paused === true
  // 回收站保留天数：面板选过就用面板的，环境变量优先。
  if (ENV_RECYCLE_DAYS === null && config.recycleDays !== undefined && config.recycleDays !== null) {
    RECYCLE_KEEP_DAYS = parseRecycleDays(config.recycleDays)
  }
  // 用户自建的同义词组（config.json 的 synonyms）。面板里改完会立即重算，不必重启。
  CUSTOM_SYNONYMS = normalizeSynonymGroups(config.synonyms) || []
  SYNONYMS = mergeSynonyms(CUSTOM_SYNONYMS)
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
  for (const raw of list) {
    const tag = String(raw ?? '').trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * 条目字段表：写入侧（各种 op）能落到条目上的每个字段都必须在这里登记，
 * 否则重新加载（重启 / 切目录 / 同步拉取）时会被 normalizeState 丢掉。
 * 新增字段只改这一处；dev/fields.test.mjs 会对照 index.js 里所有条目字段赋值检查遗漏。
 */
export const ITEM_FIELDS = {
  title: (value) => String(value ?? '').trim() || '未命名记忆',
  body: (value) => String(value ?? ''),
  tags: (value) => normalizeTags(value),
  groupId: (value) => (typeof value === 'string' ? value : null),
  enabled: (value) => value !== false,
  pinned: (value) => value === true,
  status: (value) => (value === 'pending' ? 'pending' : 'active'),
  source: (value) => (['manual', 'auto', 'import', 'merge'].includes(value) ? value : 'manual'),
  sessionId: (value) => (typeof value === 'string' && value ? value : null),
  anchorMode: (value) => (['full', 'weight'].includes(value) ? value : 'off'),
  anchorSource: (value) => (value === 'inferred' ? 'inferred' : 'user'),
  anchorWhy: (value) => (typeof value === 'string' ? value : ''),
  order: (value, index) => (Number.isFinite(value) ? Number(value) : index),
  createdAt: (value) => (typeof value === 'string' ? value : nowIso()),
  updatedAt: (value) => (typeof value === 'string' ? value : nowIso()),
  deletedAt: (value) => (typeof value === 'string' ? value : null),
  archivedAt: (value) => (typeof value === 'string' ? value : null),
  mergedInto: (value) => (typeof value === 'string' ? value : null),
}

function normalizeItem(item, index) {
  const out = { id: item.id }
  for (const [field, coerce] of Object.entries(ITEM_FIELDS)) out[field] = coerce(item[field], index)
  // 老数据没有 anchorSource：设过锚点的视为用户手设（不能被覆盖），全是 off 的交给插件重判
  if (item.anchorSource === undefined) {
    out.anchorSource = out.anchorMode === 'off' ? 'inferred' : 'user'
    if (out.anchorSource === 'inferred' && !out.anchorWhy) out.anchorWhy = '等待按内容重判'
  }
  return out
}

/**
 * 决定一条记忆的锚点：显式指定优先，否则按内容初判。
 * anchorSource 记住「是谁定的」：user 之后不再被正文改动覆盖，inferred 会在内容变了以后重判。
 */
function resolveAnchor(payload, title, body, tags) {
  const explicit = ['full', 'weight', 'off'].includes(payload && payload.anchorMode) ? payload.anchorMode : null
  if (explicit) return { anchorMode: explicit, anchorSource: 'user', anchorWhy: '手动设置' }
  const guessed = inferAnchor({ title, body, tags })
  return { anchorMode: guessed.mode, anchorSource: 'inferred', anchorWhy: guessed.why }
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
      state.items.push(normalizeItem(item, state.items.length))
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
      // 单会话暂停注入：记下暂停前的选择，恢复时原样还原
      paused: normalizePaused(value.paused),
    }
  }
  return out
}

/** 单会话暂停的记录：{ at, previous }。previous 为 null 表示原本就是「未决定」。 */
function normalizePaused(value) {
  if (!value || typeof value !== 'object') return null
  const at = typeof value.at === 'string' ? value.at : nowIso()
  const previous = value.previous && typeof value.previous === 'object'
    ? {
        mode: ['none', 'all', 'custom'].includes(value.previous.mode) ? value.previous.mode : 'none',
        groupIds: Array.isArray(value.previous.groupIds) ? value.previous.groupIds.filter((id) => typeof id === 'string') : [],
        itemIds: Array.isArray(value.previous.itemIds) ? value.previous.itemIds.filter((id) => typeof id === 'string') : [],
        decidedAt: typeof value.previous.decidedAt === 'string' ? value.previous.decidedAt : null,
      }
    : null
  return { at, previous }
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
 * 仍然失败才把坏文件挪进 `backups/corrupt-<时间>.json`，回退空库并重建，
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
        `记忆库文件无法解析：${file}\n请修复这个 JSON 文件后重试；再次打开面板时如果仍然损坏，插件会把它挪进 backups/corrupt-<时间>.json 并重建空库。\n原始错误：${error.message}`,
      )
    }
    await moveToBackup(file, 'corrupt')
    storeReadFailed = false
    return null
  }
}

async function ensureLoaded() {
  if (store) return store
  if (!loading) {
    loading = (async () => {
      await loadConfig()
      // 老的备份散在数据目录根下（store.json.corrupt-…），先归拢进 backups/ 再按数量裁剪
      await migrateLegacyBackups()
      await pruneBackups()
      // 先同步再读盘：换一台设备第一次打开时，记忆就已经在库里了。
      if (syncEnabled() && sync.autoPull) {
        await runSyncNow({ quiet: true }).catch(() => {})
      }
      store = normalizeState(await readStoreFile(STORE_FILE))
      sessions = normalizeSessions(await readJson(SESSIONS_FILE, {}))
      pruneSessions(sessions)
      // 回收站到期清理：软删除太久的条目在这里彻底删掉，顺便写墓碑防止同步复活。
      if (purgeExpiredDeleted(store).length) {
        await persist()
        await persistSessions()
      }
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
  // 种子条目同样走一次初判，新装的库里不会出现「全是无锚点」的情况
  for (const item of state.items) {
    const guessed = inferAnchor({ title: item.title, body: item.body, tags: item.tags })
    item.anchorMode = guessed.mode
    item.anchorSource = 'inferred'
    item.anchorWhy = guessed.why
  }
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

/** 最近一次同步里「两边都改过、留了一边」的条目（给面板提示用）。 */
let lastConflict = { at: '', count: 0, file: '' }

/** 把远端 store 合并进本机，不触发再次推送（避免同步自己唤醒自己）。 */
async function mergeRemote(remoteStore) {
  const current = store ?? normalizeState(await readJson(STORE_FILE, null))
  const outcome = mergeStates(current, normalizeState(remoteStore), { since: sync.lastSyncAt || '' })
  const conflicts = outcome.conflicts ?? []
  if (conflicts.length) {
    // 输掉的那一版先落盘，再继续合并：宁可多一个文件，也不让用户的修改无声消失。
    const file = await writeJsonBackup('conflict', {
      at: nowIso(),
      reason: '两台设备都改过同一条记忆；本文件保存未被采用的那一版',
      conflicts,
    })
    if (file) lastConflict = { at: nowIso(), count: conflicts.length, file }
  }
  if (!outcome.changed) return { changed: false, summary: '', conflicts }
  store = normalizeState(outcome.state)
  await persist({ skipPush: true })
  const parts = []
  if (outcome.added) parts.push(`新增 ${outcome.added}`)
  if (outcome.updated) parts.push(`更新 ${outcome.updated}`)
  if (outcome.removed) parts.push(`删除 ${outcome.removed}`)
  if (conflicts.length) parts.push(`${conflicts.length} 条冲突已留副本`)
  return { changed: true, summary: `已合并远端（${parts.join('、') || '结构变化'}）`, conflicts }
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

function renderItemLines(item, topic) {
  const tags = item.tags.length ? `  〔${item.tags.join(' / ')}〕` : ''
  const anchor = item.anchorMode === 'full' ? '〔完全锚点〕' : item.anchorMode === 'weight' ? '〔权重锚点〕' : ''
  const lines = [`- ${item.pinned ? '📌 ' : ''}${anchor}**${item.title}**${tags}`]
  // 同主题有多条、且这条不是最新的：明说是旧版，否则模型会把两套说法都当真。
  if (topic && !topic.isLatest) {
    const at = String(topic.latestAt || '').slice(0, 10)
    lines.push(`  〔旧版${at ? `，${at} 有过更新` : ''}；同主题以「${topic.latestTitle}」为准〕`)
  }
  const body = String(item.body ?? '').trim()
  if (body) for (const line of body.split('\n')) lines.push(line ? `  ${line}` : '')
  return lines
}

/** 一条记忆注入时的字符成本（渲染后的真实长度，含换行）。容量画像与预算共用这一处口径。 */
function costOf(item, topic) {
  return renderItemLines(item, topic).join('\n').length + 1
}

/** 同主题分组的缓存：快照一次请求里 capacityOf 与 composeInjection 会各要一次，别重复算。 */
let topicCache = { key: '', value: null }

function topicsOf(state) {
  const pool = state.items.filter(
    (item) => item.status === 'active' && item.enabled && !item.deletedAt && !item.archivedAt,
  )
  const key = `${state.updatedAt || ''}|${pool.length}|${pool.map((item) => item.updatedAt || '').join(',')}`
  if (topicCache.key === key && topicCache.value) return topicCache.value
  const value = groupTopics(pool)
  topicCache = { key, value }
  return value
}

/** 面板要的形状：分组列表 + id → 标注，前者画「同主题」入口，后者给每条打徽标。 */
function topicView(state) {
  const { groups, byId } = topicsOf(state)
  return {
    groups: groups.map((group) => ({
      id: group.id,
      itemIds: group.itemIds,
      latestId: group.latestId,
      latestTitle: group.latestTitle,
      latestAt: group.latestAt,
    })),
    byId: Object.fromEntries(byId),
  }
}

/** 注入头部：统计行要等装完才知道，所以先给一个「零值」版本用于估算预算。 */
function headerLines(summary) {
  return [
    '## 用户长期记忆（来自「记忆」面板，由用户维护）',
    '',
    summary,
    '',
    '锚点：标「〔完全锚点〕」的条目必须完全照此执行/表达，不得偏离；标「〔权重锚点〕」的条目只作为输出倾向的权重，影响措辞与优先级，可偏离。',
    '',
  ]
}

function summaryLine(stats) {
  return `本次加载 ${stats.kept} 条 / ${stats.folders} 个文件夹${
    stats.dropped ? `（另有 ${stats.dropped} 条只给了标题，需要时用 memory_search 取全文）` : ''
  }。记忆可能过时，与代码或工具输出冲突时以实际观察为准，并提示用户更新记忆。`
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
  const { selection } = effectiveSelection(sessionId)
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
      over: false,
      indexMode: false,
      anchors: 0,
      topics: 0,
      stale: 0,
    },
  }
  if (INJECTION_PAUSED) return { text: null, stats: { ...empty.stats, paused: true } }
  if (!selection || selection.mode === 'none') return empty
  const selected = selectedItemIds(state, selection)
  if (!selected.length) return empty

  const topics = topicsOf(state)
  const topicOfItem = (item) => topics.byId.get(item.id)

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

  const head = headerLines(summaryLine({ kept: 0, folders: 0, dropped: 0 }))
  // 给统计行、索引清单、省略提示留出的余量
  const RESERVE = 320
  // 压缩阈值就是这里的预算：超过 softLimit（默认 80%）就只给标题，不等撑满 100%。
  let budget = SOFT_INJECT_CHARS - head.join('\n').length - RESERVE
  const totalChars = priority.reduce((sum, item) => sum + costOf(item, topicOfItem(item)), 0)
  const kept = new Set()
  for (const item of priority) {
    const cost = costOf(item, topicOfItem(item))
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
  const stale = keptItems.filter((item) => {
    const topic = topicOfItem(item)
    return topic && !topic.isLatest
  }).length
  const topicCount = new Set(
    keptItems.map((item) => topicOfItem(item)).filter(Boolean).map((topic) => topic.groupId),
  ).size

  const blocks = []
  // 头部只生成这一遍：统计行用真实的 kept/folders/dropped，不再先算一遍占位再重拼一次
  blocks.push(...headerLines(summaryLine({ kept: keptItems.length, folders: groups.size, dropped: dropped.length })))
  if (stale) {
    blocks.push(
      `同主题有多条：标了〔旧版〕的以最新那条为准；如果旧版其实才是对的，去面板改一下，别让两套说法并存。`,
    )
    blocks.push('')
  }
  for (const [groupId, groupItems] of groups) {
    blocks.push(`### ${groupId ? groupNameOf(state, groupId) : '未归类'}`)
    for (const item of groupItems) blocks.push(...renderItemLines(item, topicOfItem(item)))
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
      // indexMode：本次有条目被降级成「只有标题」的索引清单
      indexMode: dropped.length > 0,
      anchors,
      // 同主题分组数，以及其中被判为「旧版」的条数
      topics: topicCount,
      stale,
    },
  }
}

function buildInjection(state, sessionId) {
  return composeInjection(state, sessionId).text
}

function effectiveSelection(sessionId) {
  const own = sessionId ? sessions[sessionId] : undefined
  if (own) return { selection: own, inherited: false }
  if (SESSION_DEFAULT.mode === 'ask') return { selection: undefined, inherited: false }
  return {
    selection: {
      mode: SESSION_DEFAULT.mode,
      groupIds: SESSION_DEFAULT.groupIds,
      itemIds: [],
      decidedAt: null,
    },
    inherited: true,
  }
}

function sessionView(state, sessionId) {
  const own = sessionId ? sessions[sessionId] : undefined
  const { selection, inherited } = effectiveSelection(sessionId)
  const decided = Boolean(own) || inherited
  const mode = selection?.mode ?? 'none'
  const items = selection ? sortItems(selectedItemIds(state, selection)) : []
  return {
    sessionId: sessionId || null,
    decided,
    inherited,
    mode,
    groupIds: selection?.groupIds ?? [],
    itemIds: selection?.itemIds ?? [],
    decidedAt: own?.decidedAt ?? null,
    paused: Boolean(own?.paused),
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
    anchorSource: item.anchorSource,
    anchorWhy: item.anchorWhy ?? '',
    source: item.source,
    archivedAt: item.archivedAt,
    mergedInto: item.mergedInto ?? null,
    chars: item.title.length + String(item.body ?? '').length,
  }))
}

/** 容量画像：注入预算用了多少、文件夹各占多少、最长的几条是谁。 */
function capacityOf(state) {
  // 与 composeInjection 共用 costOf：面板显示的占比必须就是注入时真正计入的字符数
  // （包括「旧版」提示那一行，否则面板会少算几十个字符）
  const topics = topicsOf(state)
  const charsOf = (item) => costOf(item, topics.byId.get(item.id))
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
    ratioLocked: ENV_COMPRESS_RATIO !== null,
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
    anchorSource: item.anchorSource,
    anchorWhy: item.anchorWhy ?? '',
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
    recycle: {
      keepDays: RECYCLE_KEEP_DAYS,
      autoPurge: RECYCLE_KEEP_DAYS > 0,
      locked: ENV_RECYCLE_DAYS !== null,
      defaultDays: DEFAULT_RECYCLE_DAYS,
      count: recycledItems(state).length,
      chars: recycledItems(state).reduce((sum, item) => sum + costOf(item), 0),
      tombstones: (state.deleted ?? []).length,
      tombstoneDays: TOMBSTONE_KEEP_DAYS,
    },
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
    sessionDefault: SESSION_DEFAULT,
    synonyms: CUSTOM_SYNONYMS,
    paused: INJECTION_PAUSED,
    pausedSessions: Object.entries(sessions)
      .filter(([, selection]) => selection && selection.paused)
      .map(([id, selection]) => ({ sessionId: id, at: selection.paused.at })),
    conflict: lastConflict,
    topics: topicView(state),
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

/**
 * 回收站的到期清理：软删除超过 keepDays 天的条目在加载时彻底删除（并写墓碑）。
 * 返回被清掉的 id 列表，调用方负责 persist；keepDays<=0 时只清 0 天（即不自动清）。
 */
/** 按保留天数算出「将要被清理」的条目（不改动 state，给 dryRun 与正式清理共用）。 */
function expiringDeleted(state, keepDays = RECYCLE_KEEP_DAYS) {
  if (!(keepDays > 0)) return []
  const cutoff = Date.now() - keepDays * 86400000
  return state.items.filter((item) => item.deletedAt && Date.parse(item.deletedAt) < cutoff)
}

function purgeExpiredDeleted(state, keepDays = RECYCLE_KEEP_DAYS) {
  const expired = expiringDeleted(state, keepDays)
  if (!expired.length) return []
  const ids = expired.map((item) => item.id)
  markDeleted(state, ids)
  const dead = new Set(ids)
  state.items = state.items.filter((item) => !dead.has(item.id))
  for (const selection of Object.values(sessions)) {
    if (!Array.isArray(selection.itemIds)) continue
    selection.itemIds = selection.itemIds.filter((id) => !dead.has(id))
  }
  return ids
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
        injectRatio: COMPRESS_RATIO,
        softLimit: SOFT_INJECT_CHARS,
        maxChars: MAX_INJECT_CHARS,
        ratioLocked: ENV_COMPRESS_RATIO !== null,
        maxCharsLocked: ENV_MAX_CHARS !== null,
        sessionDefault: SESSION_DEFAULT,
        synonyms: CUSTOM_SYNONYMS,
        builtinSynonyms: SYNONYM_GROUPS,
        backups: await backupInfo(),
        backupKeep: BACKUP_KEEP_PER_KIND,
      }

    case 'backups.prune': {
      // 手动整理：把每种备份裁到 keep 份（默认与自动清理一致）
      const keep = Math.max(1, Math.min(20, Number(payload.keep) || BACKUP_KEEP_PER_KIND))
      const result = await pruneBackups(keep)
      const info = await backupInfo()
      return {
        ok: true,
        message: result.removed
          ? `已清理 ${result.removed} 个旧备份，还剩 ${info.count} 个`
          : `没有可清理的备份（共 ${info.count} 个）`,
        backups: info,
      }
    }

    case 'backups.clear': {
      // 只删 backups/ 里这三类文件；store.json / config.json / sessions.json 一律不碰
      let entries = []
      try {
        entries = await fs.readdir(BACKUP_DIR)
      } catch {
        entries = []
      }
      let removed = 0
      for (const name of entries) {
        if (!BACKUP_KINDS.some((kind) => name.startsWith(`${kind}-`))) continue
        await fs.unlink(path.join(BACKUP_DIR, name)).then(() => { removed += 1 }).catch(() => {})
      }
      const info = await backupInfo()
      return {
        ok: true,
        message: removed ? `已删除 ${removed} 个备份` : '备份目录已经是空的',
        backups: info,
      }
    }

    case 'synonyms.set': {
      // 面板里改同义词：写盘 + 立即重算，不用重启。
      const next = normalizeSynonymGroups(payload.groups)
      if (next === null) throw fail('同义词要是「数组的数组」，每组至少两个词，例如 [["坚果云","WebDAV"]]')
      await saveConfig(DATA_DIR, { synonyms: next })
      CUSTOM_SYNONYMS = next
      SYNONYMS = mergeSynonyms(next)
      searchCache = { key: '', index: null }
      return snapshot(state, sessionId, {
        message: next.length
          ? `已保存 ${next.length} 组自定义同义词，下一次搜索就生效`
          : '已清空自定义同义词，只保留内置的几组',
      })
    }

    case 'budget.set': {
      const wantsRatio = payload.ratio !== undefined
      const wantsMax = payload.maxChars !== undefined
      if (!wantsRatio && !wantsMax) throw fail('要么给 ratio（0.1–1），要么给 maxChars（1000–200000）')
      const patch = {}
      let message = ''
      if (wantsRatio) {
        if (ENV_COMPRESS_RATIO !== null) {
          throw fail('压缩阈值已被环境变量 DSH_MEMORY_COMPRESS_RATIO 固定，请先去掉该变量再在面板里调')
        }
        const ratio = parseRatio(payload.ratio)
        if (ratio === null) throw fail('压缩阈值要在 0.1–1 之间，例如 0.8 表示“用到上限的 80% 就开始压缩”')
        applyCompressRatio(ratio)
        patch.injectRatio = ratio
        message = `压缩阈值已设为 ${Math.round(ratio * 100)}%（压缩线 ${SOFT_INJECT_CHARS} 字符）`
      }
      if (wantsMax) {
        if (ENV_MAX_CHARS !== null) {
          throw fail('注入上限已被环境变量 DSH_MEMORY_MAX_CHARS 固定，请先去掉该变量再在面板里调')
        }
        const chars = parseMaxChars(payload.maxChars)
        if (chars === null) throw fail('注入上限要在 1000–200000 字符之间')
        applyMaxChars(chars)
        patch.maxChars = chars
        message = `${message ? `${message}；` : ''}注入上限已设为 ${chars} 字符（压缩线 ${SOFT_INJECT_CHARS} 字符）`
      }
      await saveConfig(DATA_DIR, patch)
      return snapshot(state, sessionId, { message })
    }

    case 'session.default': {
      // 新会话默认加载策略：避免每开一个会话就被问一次
      const next = normalizeSessionDefault({ mode: payload.mode, groupIds: payload.groupIds })
      if (String(payload.mode || '') === 'custom' && !next.groupIds.length) {
        throw fail('默认「指定文件夹」时至少要选一个文件夹')
      }
      const unknown = next.groupIds.filter((id) => !state.groups.some((group) => group.id === id))
      if (unknown.length) throw fail(`文件夹不存在：${unknown.join('、')}`)
      SESSION_DEFAULT = next
      await saveConfig(DATA_DIR, { sessionDefault: next })
      const label =
        next.mode === 'ask'
          ? '每次新会话都问你'
          : next.mode === 'none'
            ? '新会话默认不加载'
            : next.mode === 'all'
              ? '新会话默认加载全部'
              : `新会话默认加载 ${next.groupIds.length} 个文件夹`
      return snapshot(state, sessionId, { message: `${label}（已保存，立即生效）` })
    }

    case 'injection.set': {
      // 暂停注入：只影响注入，不动库里的数据，随时可恢复。
      //   scope 缺省 / 'all'  → 全局：所有会话都不带记忆
      //   scope 'sessions'    → 只暂停列出的会话（把它们的选择存进 paused，恢复时原样还原）
      const scope = payload.scope === 'sessions' ? 'sessions' : 'all'
      const paused = payload.paused === true

      if (scope === 'sessions') {
        const ids = Array.isArray(payload.sessionIds)
          ? payload.sessionIds.filter((id) => typeof id === 'string' && id)
          : sessionId
            ? [sessionId]
            : []
        if (!ids.length) throw fail('请指定要暂停的会话')
        let changed = 0
        for (const id of ids) {
          if (paused) {
            const own = sessions[id]
            if (own && own.paused) continue
            const previous = own
              ? { mode: own.mode, groupIds: own.groupIds, itemIds: own.itemIds, decidedAt: own.decidedAt }
              : null
            sessions[id] = {
              mode: 'none',
              groupIds: [],
              itemIds: [],
              decidedAt: nowIso(),
              paused: { at: nowIso(), previous },
            }
            changed += 1
          } else {
            const own = sessions[id]
            if (!own || !own.paused) continue
            if (own.paused.previous) {
              sessions[id] = { ...own.paused.previous, paused: null }
            } else {
              // 原本就是「未决定」：删掉记录，回到会弹询问卡片的状态
              delete sessions[id]
            }
            changed += 1
          }
        }
        await persistSessions()
        const label = paused
          ? `已暂停注入：${ids.length} 个会话不再带记忆（新会话不受影响）`
          : `已恢复注入：${changed} 个会话回到原来的选择`
        return snapshot(state, sessionId, { message: changed ? label : '这些会话的状态没有变化' })
      }

      INJECTION_PAUSED = paused
      await saveConfig(DATA_DIR, { paused: INJECTION_PAUSED })
      return snapshot(state, sessionId, {
        message: INJECTION_PAUSED ? '已暂停注入：所有会话都不再带记忆' : '已恢复注入',
      })
    }

    case 'deleted.prune': {
      // 墓碑回收：默认只清「够老」的墓碑，避免另一台设备的旧副本把条目推回来。
      // all:true 是明确要求清空全部记录（面板里那个「清空删除记录」按钮），会一次清掉。
      const all = payload.all === true
      const days = Number.isFinite(Number(payload.days)) && Number(payload.days) > 0 ? Number(payload.days) : TOMBSTONE_KEEP_DAYS
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      const before = (state.deleted ?? []).length
      const kept = all
        ? []
        : (state.deleted ?? []).filter((entry) => {
            const at = Date.parse(String(entry?.at ?? ''))
            return Number.isNaN(at) || at >= cutoff
          })
      const removed = before - kept.length
      if (!removed) {
        return snapshot(state, sessionId, {
          message: all ? '删除记录本来就是空的' : `没有超过 ${days} 天的删除记录需要清理`,
        })
      }
      state.deleted = kept
      state.updatedAt = nowIso()
      await persist()
      return snapshot(state, sessionId, {
        message: all
          ? `已清空 ${removed} 条删除记录`
          : `已清理 ${removed} 条 ${days} 天前的删除记录（还剩 ${kept.length} 条）`,
      })
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
            // 并把目标原文件留一份 pre-switch 备份，事后可以人工核对。
            const current = store ?? normalizeState(await readJson(STORE_FILE, null))
            const merged = mergeStates(current, incoming)
            await writeBackup(targetStore, 'pre-switch', path.join(target, 'backups'))
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
      const tags = normalizeTags(payload.tags)
      const anchor = resolveAnchor(payload, title, body, tags)
      const item = {
        id: `m-${randomUUID().slice(0, 8)}`,
        title: title || '未命名记忆',
        body,
        tags,
        groupId: resolveGroupId(state, payload.groupId),
        enabled: payload.enabled !== false,
        pinned: payload.pinned === true,
        status: 'active',
        source: 'manual',
        ...anchor,
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
      const touchedContent = 'title' in patch || 'body' in patch || 'tags' in patch
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
      if ('anchorMode' in patch) {
        item.anchorMode = ['full', 'weight'].includes(patch.anchorMode) ? patch.anchorMode : 'off'
        item.anchorSource = 'user'
        item.anchorWhy = '手动设置'
      } else if (touchedContent && item.anchorSource === 'inferred') {
        // 正文变了就重判一次，但只动「插件自己判的」；用户手动设过的一律不改
        const guessed = inferAnchor({ title: item.title, body: item.body, tags: item.tags })
        item.anchorMode = guessed.mode
        item.anchorWhy = guessed.why
      }
      if ('status' in patch) item.status = patch.status === 'pending' ? 'pending' : 'active'
      item.updatedAt = nowIso()
      await persist()
      return snapshot(state, sessionId, { message: `已更新「${item.title}」`, focusId: item.id })
    }

    case 'item.batch': {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      // 只支持“可以安全地同时套到多条”的字段；标题/正文/锚点说明必须单条编辑，别让批量改正文成为事故入口。
      const supported = ['enabled', 'pinned', 'status', 'groupId', 'anchorMode', 'tags', 'addTags', 'removeTags']
      const unknown = Object.keys(patch).filter((key) => !supported.includes(key))
      if (unknown.length) {
        throw fail(`批量修改不支持这些字段：${unknown.join('、')}（标题、正文、锚点说明请单条编辑）`)
      }
      let changed = 0
      for (const id of ids) {
        const item = state.items.find((entry) => entry.id === id && !entry.deletedAt)
        if (!item) continue
        if ('enabled' in patch) item.enabled = patch.enabled !== false
        if ('pinned' in patch) item.pinned = patch.pinned === true
        if ('status' in patch) item.status = patch.status === 'pending' ? 'pending' : 'active'
        if ('groupId' in patch) item.groupId = resolveGroupId(state, patch.groupId)
        if ('anchorMode' in patch) {
          item.anchorMode = ['full', 'weight'].includes(patch.anchorMode) ? patch.anchorMode : 'off'
          item.anchorSource = 'user'
          item.anchorWhy = '手动设置'
        }
        // tags = 整组替换；addTags / removeTags = 在原有标签上增删，默认用后者以免误删分类。
        if (Array.isArray(patch.tags)) item.tags = normalizeTags(patch.tags)
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

    case 'anchor.reinfer': {
      // 按内容重判锚点：默认只动「插件自己判出来的」，force 时连用户手设的也覆盖。
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : null
      const force = payload.force === true
      const tally = { full: 0, weight: 0, off: 0 }
      let changed = 0
      let skipped = 0
      for (const item of state.items) {
        if (item.deletedAt || item.archivedAt) continue
        if (ids && !ids.includes(item.id)) continue
        if (!force && item.anchorSource !== 'inferred') {
          skipped += 1
          continue
        }
        const guessed = inferAnchor({ title: item.title, body: item.body, tags: item.tags })
        // 理由也要刷新：判出来是「不设锚点」时旧理由（例如迁移时的占位文案）会一直留着
        if (item.anchorMode !== guessed.mode || item.anchorSource !== 'inferred' || item.anchorWhy !== guessed.why) {
          item.anchorMode = guessed.mode
          item.anchorSource = 'inferred'
          item.anchorWhy = guessed.why
          item.updatedAt = nowIso()
          changed += 1
        }
        tally[guessed.mode] += 1
      }
      await persist()
      return snapshot(state, sessionId, {
        message: `已重判 ${changed} 条锚点（完全 ${tally.full} / 权重 ${tally.weight} / 不设 ${tally.off}${skipped ? `，跳过手设 ${skipped} 条` : ''}）`,
      })
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

    case 'recycle.set': {
      if (ENV_RECYCLE_DAYS !== null) throw fail('回收站保留天数已被环境变量 DSH_MEMORY_RECYCLE_DAYS 固定，请先去掉该变量')
      const raw = Number(payload.days)
      if (!Number.isFinite(raw) || raw < 0 || raw > 3650) throw fail('保留天数要在 0（不自动清理）到 3650 之间')
      const days = Math.round(raw)
      // 改小天数会立刻永久删除过期条目，所以先算清楚、由调用方确认（dryRun 不写盘、不改配置）
      const expiring = expiringDeleted(state, days)
      if (payload.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          days,
          currentDays: RECYCLE_KEEP_DAYS,
          willPurge: expiring.length,
          ids: expiring.map((item) => item.id),
          titles: expiring.slice(0, 10).map((item) => item.title),
        }
      }
      RECYCLE_KEEP_DAYS = days
      await saveConfig(DATA_DIR, { recycleDays: RECYCLE_KEEP_DAYS })
      if (expiring.length) {
        // 永久删除前先留一份整库快照，事后可以人工捞回
        await writeBackup(STORE_FILE, 'pre-purge')
        purgeExpiredDeleted(state, RECYCLE_KEEP_DAYS)
        await persist()
        return snapshot(state, sessionId, {
          message: `回收站改为保留 ${RECYCLE_KEEP_DAYS} 天，已清掉 ${expiring.length} 条过期记忆（清理前已备份）`,
          purged: expiring.length,
        })
      }
      return snapshot(state, sessionId, {
        message: RECYCLE_KEEP_DAYS > 0 ? `回收站改为保留 ${RECYCLE_KEEP_DAYS} 天` : '回收站改为不自动清理',
        purged: 0,
      })
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
      const query = String(payload.query ?? '').trim()
      if (!query) throw fail('搜索词不能为空')
      const includeArchived = payload.includeArchived === true
      const pool = state.items
        .filter((item) => !item.deletedAt && item.status === 'active' && item.enabled)
        .filter((item) => includeArchived || !item.archivedAt)
      const hits = searchWithCache(pool, query, 50)
      const topicIndex = topicsOf(state).byId
      return {
        ok: true,
        query,
        hits: hits.map(({ item, score, snippet }) => {
          const topic = topicIndex.get(item.id)
          return {
            id: item.id,
            title: item.title,
            group: groupNameOf(state, item.groupId),
            tags: item.tags,
            body: item.body,
            snippet,
            score: Math.round(score * 1000) / 1000,
            anchor: item.anchorMode || 'off',
            archived: Boolean(item.archivedAt),
            // 同主题里这条是不是旧版；旧版要给「以谁为准」，否则检索出来只会加深旧结论
            topic: topic
              ? { isLatest: topic.isLatest, latestTitle: topic.latestTitle, latestAt: topic.latestAt, total: topic.total }
              : null,
          }
        }),
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
      const query = String(args?.query ?? '').trim()
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
      const includeArchived = args?.includeArchived === true
      const base = state.items.filter(
        (item) => !item.deletedAt && item.status === 'active' && item.enabled,
      )
      const pool = base.filter((item) => includeArchived || !item.archivedAt)
      const archivedCount = base.filter((item) => item.archivedAt).length
      const hits = (
        query
          ? searchWithCache(pool, query, limit)
          : pool.slice(0, limit).map((item) => ({ item, score: 0, snippet: '' }))
      )
      const archivedNote =
        archivedCount && !includeArchived ? `（另有 ${archivedCount} 条已归档，默认不参与检索）` : ''
      if (!hits.length) {
        return `记忆库中没有匹配「${args?.query ?? ''}」的启用记忆（共 ${pool.length} 条启用记忆）${archivedNote}。换个说法（同义词、上位词）再试一次，或调用 memory_search 时不带关键词来列出全部标题。`
      }
      const lines = [
        `匹配 ${hits.length} 条（记忆库共 ${pool.length} 条启用记忆，按相关度排序）${archivedNote}：`,
        '',
        ...hits.flatMap(({ item }) => {
          const topic = topicsOf(state).byId.get(item.id)
          const stale =
            topic && !topic.isLatest ? ` 〔旧版，同主题以「${topic.latestTitle}」为准〕` : ''
          return [
            `- ${item.pinned ? '📌 ' : ''}${item.title}  〔${groupNameOf(state, item.groupId)}${item.tags.length ? ' / ' + item.tags.join(' / ') : ''}〕${item.archivedAt ? ' 〔已归档〕' : ''}${stale}`,
            ...item.body
              .trim()
              .split('\n')
              .filter(Boolean)
              .slice(0, 8)
              .map((line) => `  ${line}`),
            '',
          ]
        }),
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
        anchor: {
          type: 'string',
          enum: ['full', 'weight', 'off'],
          description:
            '可选：注入强度。full=完全锚点（必须照做的硬性约束），weight=权重锚点（偏好/惯例），off=不设锚点。一般不用传：插件会按内容自动初判（必须/禁止/只写…→完全；喜欢/尽量/统一…→权重），用户随时可在面板改。',
        },
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
        ...resolveAnchor({ anchorMode: args?.anchor }, title, body, tags),
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
      const anchorLabel =
        item.anchorMode === 'full' ? '完全锚点（硬性）' : item.anchorMode === 'weight' ? '权重锚点（偏好）' : '不设锚点'
      const anchorNote =
        item.anchorSource === 'inferred' ? `锚点初判为${anchorLabel}：${item.anchorWhy}` : `锚点按你的指定设为${anchorLabel}`
      return `已写入待确认记忆「${item.title}」（本会话第 ${ordinal} 条，${where}；${anchorNote}）。请在「记忆」面板的「待确认」里审核：转正后才生效并参与注入。`
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
