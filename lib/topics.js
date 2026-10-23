/**
 * 同主题识别：找出「讲同一件事」的多条记忆，标出哪条是最新的。
 *
 * 为什么要有：记忆是长期累积的，用户改主意、环境变化之后，库里很容易同时存在
 * 两条说法冲突的记录（「记忆放 C 盘」 vs 「记忆放 E 盘」）。模型读到旧的那条
 * 就会照错的执行。注入时标清「哪条更新、以谁为准」，比让模型自己猜可靠。
 *
 * 这里刻意不做语义向量：目标是「明显同主题」而不是「语义相近」，用标题/正文的
 * 词集合重叠度（Jaccard）判断，阈值偏保守——宁可漏判（当成两条独立记忆），
 * 也不要把两条不相干的记忆硬凑成一组，那会让模型以为旧结论被覆盖了。
 *
 * 性能（v0.9.3）：
 *   1) 每条记忆的分词只算一次（tokenSets），不再每对重算；
 *   2) 用倒排表只枚举「至少共享一个词」的候选对——共享 0 词的对按定义不可能同主题，
 *      跳过它们不改变任何判定结果；
 *   3) 文档频率过高的词（例如「记忆」「用户」这种几乎每条都有的词）不进倒排表，
 *      否则它会生成一个 n² 级别的桶。这类词仍保留在判定用的词集合里，
 *      所以「共享词里有 1 个低频词 + 5 个高频词」这种对照样能被选出来。
 *      只有当两条记忆的共享词**全部**是超高频词时才会漏选，而那种情况要同时满足
 *      「全文共享 ≥ 5」几乎不可能发生（真有 5 个词都出现在四成以上文档里，
 *      这几条记忆本身也就没有区分度了）。
 *
 * 容量上限（v0.9.4）：识别成本实质上是「候选词对数量」，1 万条实测 5.2 秒、峰值多占
 * 500MB，不能只靠「库不会那么大」兜底。超过 MAX_TOPIC_ITEMS 时只对最近更新的那部分
 * 做识别，其余条目不标注。这是有损的，但代价可接受：标注的价值集中在「最近还在改的
 * 主题」，而容量到几千条时注入本身已经在按预算裁剪，旧版提示属于锦上添花。
 */

import { tokenize } from './retrieval.js'

/** 参与同主题识别的条目上限（见文件头「容量上限」）。 */
const MAX_TOPIC_ITEMS = 3000

/** 词集合：去掉重复的检索词。 */
function tokenSet(text, tokenizeFn = tokenize) {
  return new Set(tokenizeFn(text))
}

/**
 * 一条记忆的两套词集合（只算一次，供同一条参与的所有比较复用）：
 *   title 只看标题；full 是「标题 + 正文」——与旧实现保持一致，
 *   标题里的词也算进全文集合，否则判定结果会变。
 */
export function tokenSets(item, tokenizeFn = tokenize) {
  return {
    title: tokenSet(item.title, tokenizeFn),
    full: tokenSet(`${item.title} ${item.body || ''}`, tokenizeFn),
  }
}

function sharedCount(a, b) {
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared
}

function jaccardSizes(shared, sizeA, sizeB) {
  const union = sizeA + sizeB - shared
  return union > 0 ? shared / union : 0
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  return jaccardSizes(sharedCount(a, b), a.size, b.size)
}

function overlaps(a, b) {
  return sharedCount(a, b)
}

/** 旧实现里的判定（保留导出给测试做逐字节对比，不要在这里改逻辑）。 */
export function looksSameTopicLegacy(a, b) {
  const titleA = tokenSet(a.title)
  const titleB = tokenSet(b.title)
  if (titleA.size >= 2 && titleB.size >= 2) {
    if (jaccard(titleA, titleB) >= 0.5) return true
  }
  const bodyA = tokenSet(`${a.title} ${a.body || ''}`)
  const bodyB = tokenSet(`${b.title} ${b.body || ''}`)
  const shared = overlaps(bodyA, bodyB)
  if (shared < 5) return false
  return jaccard(bodyA, bodyB) >= 0.4
}

/**
 * 两条记忆是否像在讲同一件事。
 * 标题短、区分度高，所以标题相似就能定；正文只有当重叠词足够多时才算。
 * sa / sb 是预先算好的 tokenSets（不传就现算，语义完全一样）。
 */
export function looksSameTopic(a, b, sa, sb) {
  const setsA = sa || tokenSets(a)
  const setsB = sb || tokenSets(b)

  if (setsA.title.size >= 2 && setsB.title.size >= 2) {
    const shared = sharedCount(setsA.title, setsB.title)
    if (shared && jaccardSizes(shared, setsA.title.size, setsB.title.size) >= 0.5) return true
  }

  const shared = sharedCount(setsA.full, setsB.full)
  if (shared < 5) return false
  return jaccardSizes(shared, setsA.full.size, setsB.full.size) >= 0.4
}

function timeOf(item) {
  const at = Date.parse(item.updatedAt || item.createdAt || '') || 0
  return at
}

/**
 * 把条目按主题分组。
 *
 * @param {Array<{id: string, title: string, body?: string, updatedAt?: string, createdAt?: string}>} items
 * @param {{minGapMs?: number, tokenize?: (text: string) => string[]}} options
 *   tokenize 仅供测试打桩（统计分词次数），生产不要传。
 * @returns {{groups: Array<{id: string, itemIds: string[], latestId: string, latestTitle: string, latestAt: string}>,
 *            byId: Map<string, {groupId: string, isLatest: boolean, latestId: string, latestTitle: string, latestAt: string, total: number}>}}
 *   byId 里只有「所属组至少 2 条、并且时间确实不同」的条目才会出现；
 *   时间完全相同的两条不标注新旧（同一批写入，没有哪个更权威）。
 */
export function groupTopics(items, options = {}) {
  const thresholdMs = Number.isFinite(options.minGapMs) ? options.minGapMs : 60 * 1000
  const tokenizeFn = typeof options.tokenize === 'function' ? options.tokenize : tokenize
  // 容量保护：识别复杂度实质上是「候选词对数量」，1 万条实测要 5.2 秒、峰值多占 500MB。
  // 超过上限时只对**最近更新的**那部分做识别，其余条目不标注——标注的价值本来就在
  // 「最近还在改的主题」，老得没人动的条目旧不旧已经不太重要。
  const cap = Number.isFinite(options.maxItems) && options.maxItems > 1 ? options.maxItems : MAX_TOPIC_ITEMS
  const filtered = items.filter((item) => item && item.id)
  const truncated = filtered.length > cap
  const list = truncated ? filtered.slice().sort((a, b) => timeOf(b) - timeOf(a)).slice(0, cap) : filtered
  const total = list.length

  // 1) 每条只分词一次
  const sets = list.map((item) => tokenSets(item, tokenizeFn))

  // 2) 倒排表：低频词才建索引（高频词会退化成 n² 的桶）
  const index = new Map()
  for (let i = 0; i < total; i += 1) {
    for (const token of sets[i].full) {
      const bucket = index.get(token)
      if (bucket) bucket.push(i)
      else index.set(token, [i])
    }
  }
  const maxDf = Math.max(50, Math.floor(total * 0.4))
  const sharedPairs = new Map()
  for (const bucket of index.values()) {
    if (bucket.length < 2 || bucket.length > maxDf) continue
    for (let x = 0; x < bucket.length; x += 1) {
      for (let y = x + 1; y < bucket.length; y += 1) {
        const key = bucket[x] * total + bucket[y]
        sharedPairs.set(key, (sharedPairs.get(key) || 0) + 1)
      }
    }
  }

  // 3) 并查集：只对「有共享词」的候选做完整判定
  //    find 带路径压缩、union 按大小合并——否则大量相似条目会连成一条长链，
  //    每次 find 都退化成 O(n)，5000 条时实测要 70 秒以上。
  const parent = new Map(list.map((item) => [item.id, item.id]))
  const size = new Map(list.map((item) => [item.id, 1]))
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    let cur = id
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const sa = size.get(ra) || 1
    const sb = size.get(rb) || 1
    if (sa < sb) {
      parent.set(ra, rb)
      size.set(rb, sa + sb)
    } else {
      parent.set(rb, ra)
      size.set(ra, sa + sb)
    }
  }
  for (const key of sharedPairs.keys()) {
    const i = Math.floor(key / total)
    const j = key % total
    if (looksSameTopic(list[i], list[j], sets[i], sets[j])) union(list[i].id, list[j].id)
  }

  const buckets = new Map()
  for (const item of list) {
    const root = find(item.id)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(item)
  }

  const groups = []
  const byId = new Map()
  for (const [root, bucket] of buckets) {
    if (bucket.length < 2) continue
    const sorted = bucket.slice().sort((a, b) => timeOf(b) - timeOf(a) || String(a.id).localeCompare(String(b.id)))
    const latest = sorted[0]
    const latestAt = timeOf(latest)
    const oldest = sorted[sorted.length - 1]
    // 全部在同一分钟内写入：视为同一批，不编造「谁更新」
    if (latestAt - timeOf(oldest) < thresholdMs) continue

    const group = {
      id: `t-${root}`,
      itemIds: sorted.map((item) => item.id),
      latestId: latest.id,
      latestTitle: latest.title,
      latestAt: latest.updatedAt || latest.createdAt || '',
    }
    groups.push(group)
    for (const item of sorted) {
      byId.set(item.id, {
        groupId: group.id,
        isLatest: item.id === latest.id,
        latestId: latest.id,
        latestTitle: latest.title,
        latestAt: group.latestAt,
        total: sorted.length,
      })
    }
  }

  groups.sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)))
  return { groups, byId }
}
