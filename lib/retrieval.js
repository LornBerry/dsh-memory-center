/**
 * 本地检索：不联网、不依赖模型。
 *
 * 记忆库是中文为主的短文本，纯子串匹配会漏掉同义说法（“存哪”“路径”“目录”“盘符”）。
 * 这里用一套轻量方案补上召回：
 *   1) 分词：拉丁词按空格/标点切；中文切字符二元组（bigram），短词（≤2 字）额外保留整词；
 *   2) BM25：标题权重 3、标签 2、正文 1，倒排统计文档频率；
 *   3) 同义词扩展：查询词命中某个同义组时，把组内其它说法按 0.5 权重一起检索；
 *   4) 子串加权：整句命中标题/正文再额外加分，保证“精确搜索词”仍然排在最前。
 *
 * 这一层是“词法 + 同义词”的确定性召回，不需要下载模型；真正的向量检索是可选的第二层，
 * 由调用方（宿主）配置自己的 embeddings 接口后叠加，见 index.js 里的 embeddings 部分。
 */

export const SYNONYM_GROUPS = [
  ['存储', '路径', '目录', '盘符', '存放', '存在哪', '存哪'],
  ['注入', '加载', '带上', '引用', '读取'],
  ['待确认', '转正', '确认', '候选', '审核'],
  ['锚点', '完全锚点', '权重锚点', '硬性', '强制'],
  ['回收站', '删除', '误删', '删掉'],
  ['同步', '云端', '备份', '多设备', '跨设备'],
  ['归档', '压缩', '合并', '精简'],
  ['文件夹', '分组', '目录'],
  ['搜索', '检索', '查找', '找'],
  ['记忆', '条目', '笔记', '记录'],
]

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WORD = /[a-z0-9_$.\-/]+/g

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
}

/** 把一段文本切成检索词：拉丁词 + 中文二元组（短词保留整词）。 */
export function tokenize(text) {
  const source = normalizeText(text)
  const tokens = []
  for (const match of source.match(WORD) || []) {
    tokens.push(match)
  }
  // 中文：先按非中文边界切成连续中文片段，再切二元组
  for (const run of source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    if (run.length === 2) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** 同义词：查询词出现在某个组里时，把组内其它说法也作为低权重词加入。 */
export function expandQuery(query, groups = SYNONYM_GROUPS) {
  const base = tokenize(query)
  const raw = normalizeText(query)
  const extra = new Map()
  for (const group of groups) {
    const hit = group.some((word) => {
      const w = normalizeText(word)
      return raw.includes(w) || w.includes(raw)
    })
    if (!hit) continue
    for (const word of group) {
      for (const token of tokenize(word)) {
        if (!base.includes(token)) extra.set(token, (extra.get(token) ?? 0) + 1)
      }
    }
  }
  return { base, extra: [...extra.keys()] }
}

function fieldTokens(item) {
  const map = new Map()
  const add = (text, weight) => {
    for (const token of tokenize(text)) {
      map.set(token, (map.get(token) ?? 0) + weight)
    }
  }
  add(item.title, 3)
  add((item.tags || []).join(' '), 2)
  add(item.body, 1)
  return map
}

function snippetOf(item, terms) {
  const body = String(item.body || '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const lower = body.toLowerCase()
  let at = -1
  for (const term of terms) {
    const idx = lower.indexOf(term)
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  if (at < 0) return body.slice(0, 80) + (body.length > 80 ? '…' : '')
  const start = Math.max(0, at - 30)
  const end = Math.min(body.length, at + 70)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

/**
 * 检索。
 * @param {Array} items 候选条目（调用方先按 deleted/archived/pending 过滤好）
 * @param {string} query
 * @param {{limit?: number, synonyms?: string[][]}} options
 * @returns {Array<{item: object, score: number, matched: string[], snippet: string}>}
 */
export function searchItems(items, query, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10))
  const raw = normalizeText(query).trim()
  if (!raw) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, matched: [], snippet: snippetOf(item, []) }))
  }
  const { base, extra } = expandQuery(raw, options.synonyms || SYNONYM_GROUPS)
  const weights = new Map()
  for (const token of base) weights.set(token, 1)
  for (const token of extra) if (!weights.has(token)) weights.set(token, 0.5)
  if (!weights.size) return []

  const docs = items.map((item) => ({ item, tf: fieldTokens(item) }))
  const df = new Map()
  for (const doc of docs) {
    for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const total = docs.length || 1
  const idf = (token) => {
    const n = df.get(token) ?? 0
    return Math.log(1 + (total - n + 0.5) / (n + 0.5))
  }
  const avgLength = docs.reduce((sum, doc) => sum + [...doc.tf.values()].reduce((a, b) => a + b, 0), 0) / total

  const scored = []
  for (const doc of docs) {
    const length = [...doc.tf.values()].reduce((a, b) => a + b, 0)
    let score = 0
    const matched = []
    for (const [token, weight] of weights) {
      const tf = doc.tf.get(token) ?? 0
      if (!tf) continue
      const norm = 1 - 0.75 + (0.75 * length) / (avgLength || 1)
      score += weight * idf(token) * ((tf * 1.2) / (tf + 1.2 * norm))
      matched.push(token)
    }
    // 整句命中：精确词必须靠前
    const title = normalizeText(doc.item.title)
    const body = normalizeText(doc.item.body)
    if (title.includes(raw)) score += 6
    if (body.includes(raw)) score += 2
    if (score > 0) scored.push({ item: doc.item, score, matched, snippet: snippetOf(doc.item, matched) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 余弦相似度（向量检索可选的第二层用）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
