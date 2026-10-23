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
 */

import { tokenize } from './retrieval.js'

/** 词集合：去掉重复的检索词。 */
function tokenSet(text) {
  return new Set(tokenize(text))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  if (!shared) return 0
  return shared / (a.size + b.size - shared)
}

function overlaps(a, b) {
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared
}

/**
 * 两条记忆是否像在讲同一件事。
 * 标题短、区分度高，所以标题相似就能定；正文只有当重叠词足够多时才算。
 */
export function looksSameTopic(a, b) {
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

function timeOf(item) {
  const at = Date.parse(item.updatedAt || item.createdAt || '') || 0
  return at
}

/**
 * 把条目按主题分组。
 *
 * @returns {{groups: Array<{id: string, itemIds: string[], latestId: string, latestTitle: string, latestAt: string}>,
 *            byId: Map<string, {groupId: string, isLatest: boolean, latestId: string, latestTitle: string, latestAt: string, total: number}>}}
 *   byId 里只有「所属组至少 2 条、并且时间确实不同」的条目才会出现；
 *   时间完全相同的两条不标注新旧（同一批写入，没有哪个更权威）。
 */
export function groupTopics(items, options = {}) {
  const thresholdMs = Number.isFinite(options.minGapMs) ? options.minGapMs : 60 * 1000
  const list = items.filter((item) => item && item.id)

  // 并查集：相似就并到一组
  const parent = new Map(list.map((item) => [item.id, item.id]))
  const find = (id) => {
    let cur = id
    while (parent.get(cur) !== cur) cur = parent.get(cur)
    return cur
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (looksSameTopic(list[i], list[j])) union(list[i].id, list[j].id)
    }
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
