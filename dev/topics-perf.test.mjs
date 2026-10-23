/**
 * 同主题识别的性能改造回归（v0.9.3，A+B 优化）。
 *
 *   node dev/topics-perf.test.mjs
 *
 * 三板斧：
 *   1) 一致性：新实现与旧实现（逐对重算 + 两两比较）在 200+ 条数据上结果必须完全一致；
 *   2) 不做无用功：分词次数必须是 O(n)（每条 2 次），而不是 O(n²)；
 *   3) 性能烟雾：800 条要在很宽松的时限内返回，防止将来悄悄退回平方级。
 *
 * 另外覆盖一个容易踩的坑：超高频词不进倒排表，但也不能因此漏判——
 * 「两条共享 4 个高频词 + 若干低频词」必须仍能被选出来。
 */
import { groupTopics, looksSameTopicLegacy, tokenSets } from '../lib/topics.js'
import { tokenize } from '../lib/retrieval.js'

const failures = []
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) console.log(`ok   ${label}`)
  else {
    failures.push(label)
    console.error(`FAIL ${label} = ${JSON.stringify(actual)}${hint ? `  (${hint})` : ''}`)
  }
}

/* ------------------------------------------------------------ 旧实现（对照组） */

/** 用旧的两两比较 + 旧判定复刻分组，用来证明新实现没有改变结果。 */
function legacyGroup(items, minGapMs = 60000) {
  const list = items.filter((item) => item && item.id)
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
      if (looksSameTopicLegacy(list[i], list[j])) union(list[i].id, list[j].id)
    }
  }
  const buckets = new Map()
  for (const item of list) {
    const root = find(item.id)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(item)
  }
  const timeOf = (item) => Date.parse(item.updatedAt || item.createdAt || '') || 0
  const groups = []
  const byId = new Map()
  for (const [root, bucket] of buckets) {
    if (bucket.length < 2) continue
    const sorted = bucket.slice().sort((a, b) => timeOf(b) - timeOf(a) || String(a.id).localeCompare(String(b.id)))
    const latest = sorted[0]
    if (timeOf(latest) - timeOf(sorted[sorted.length - 1]) < minGapMs) continue
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

/** 抹掉并查集根节点带来的组 id / 条目顺序差异，只比语义结果。 */
function normalize(result) {
  const groups = result.groups
    .map((group) => ({
      itemIds: [...group.itemIds].sort(),
      latestId: group.latestId,
      latestTitle: group.latestTitle,
      latestAt: group.latestAt,
    }))
    .sort((a, b) => `${a.latestTitle}|${a.latestAt}`.localeCompare(`${b.latestTitle}|${b.latestAt}`))
  const byId = [...result.byId.entries()]
    .map(([id, info]) => ({
      id,
      isLatest: info.isLatest,
      latestId: info.latestId,
      latestTitle: info.latestTitle,
      total: info.total,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify({ groups, byId })
}

/* ------------------------------------------------------------------ 构造数据 */

const HIGH_FREQ = ['记忆', '用户', '文件', '系统']
let clock = Date.parse('2026-01-01T00:00:00.000Z')

function makeItem(id, title, body, minutesLater) {
  const at = new Date(clock + minutesLater * 60000).toISOString()
  return { id, title, body, updatedAt: at, createdAt: at }
}

const corpus = []
// 200 条基线：正文都带 HIGH_FREQ，让这些词的文档频率超过 40%，触发「不进倒排表」的分支
for (let i = 0; i < 200; i += 1) {
  corpus.push(
    makeItem(
      `base-${i}`,
      `基线条目 ${i} 号 说明 ${i % 7}`,
      `${HIGH_FREQ.join(' ')} 编号 ${i} 的内容 ${i % 5}`,
      i * 3,
    ),
  )
}

// 一对真正同主题：标题共享 3 个词、正文共享 8 个词（其中 4 个是高频词）
corpus.push(
  makeItem(
    'topic-a',
    '数据库连接池配置 主库',
    `${HIGH_FREQ.join(' ')} 数据库 连接池 配置 主库 从库 超时 重试 上限`,
    700,
  ),
)
corpus.push(
  makeItem(
    'topic-b',
    '数据库连接池配置 备库',
    `${HIGH_FREQ.join(' ')} 数据库 连接池 配置 主库 从库 超时 重试 上限`,
    1400,
  ),
)

// 只共享高频词、正文各说各的：不该被凑成一组
corpus.push(makeItem('noise-a', '番茄炒蛋做法 火候', `${HIGH_FREQ.join(' ')} 番茄 鸡蛋 油温 翻炒`, 2100))
corpus.push(makeItem('noise-b', '汽车保养周期 机油', `${HIGH_FREQ.join(' ')} 汽车 机油 里程 更换 周期`, 2200))

// 时间完全相同的同主题两条：不标新旧
corpus.push(makeItem('same-a', '内存泄漏排查 堆快照', '内存 泄漏 排查 堆 快照 分析 工具 采样', 3000))
corpus.push(makeItem('same-b', '内存泄漏排查 堆快照', '内存 泄漏 排查 堆 快照 分析 工具 采样', 3000))

/* -------------------------------------------------------------------- 断言 */

const fresh = groupTopics(corpus)
const legacy = legacyGroup(corpus)
expect('新实现与旧实现结果完全一致', normalize(fresh), (v) => v === normalize(legacy), '优化改变了判定结果')

expect('数据库连接池那对被判同组', Boolean(fresh.byId.get('topic-a')), (v) => v === true, '漏判了')
expect('同组里非最新那条被标为旧版', fresh.byId.get('topic-a').isLatest, (v) => v === false)
expect('最新那条是 topic-b', fresh.byId.get('topic-b').isLatest, (v) => v === true)
expect('噪声对没有被凑成一组', Boolean(fresh.byId.get('noise-a')), (v) => v === false, '误判成同主题')
expect('同一时刻写入的不标新旧', Boolean(fresh.byId.get('same-a')), (v) => v === false, '不该编造谁更新')
// 基线之间共享「基线条目 / 号 / 说明」这类词，被判同主题是**旧实现同样会做**的事
// （上面的一致性断言已经覆盖「新旧一致」）；这里只确认它们没有跟目标对串组。
expect(
  '基线没有跟数据库连接池那对串组',
  fresh.groups.some((group) => group.itemIds.includes('topic-a') && group.itemIds.some((id) => id.startsWith('base-'))),
  (v) => v === false,
)

// 2) 分词次数：每题 2 次（title + full），总计不该超过 2n
let calls = 0
groupTopics(corpus, {
  tokenize: (text) => {
    calls += 1
    return tokenize(text)
  },
})
const budget = corpus.length * 2 + 8
expect(`分词次数 O(n)（${calls} <= ${budget}）`, calls, (v) => v <= budget, '退回了每对重算')

// tokenSets 单测：full 必须包含标题词（与旧实现一致）
const sets = tokenSets({ title: '部署 口令', body: '轮换 周期' })
expect('tokenSets.full 含标题词', [...sets.title].every((token) => sets.full.has(token)), (v) => v === true)
expect('tokenSets.title 不含正文词', sets.title.has('轮换'), (v) => v === false)

// 3) 性能烟雾：800 条要能秒回
const big = []
for (let i = 0; i < 800; i += 1) {
  big.push(makeItem(`big-${i}`, `批量条目 ${i} 号 主题 ${i % 11}`, `${HIGH_FREQ.join(' ')} 内容 ${i} 分组 ${i % 9}`, i))
}
const started = Date.now()
const bigResult = groupTopics(big)
const cost = Date.now() - started
expect(`800 条耗时 ${cost}ms < 5000ms`, cost, (v) => v < 5000, '退回平方级了')
expect('800 条能正常出结果', Array.isArray(bigResult.groups), (v) => v === true)

console.log(failures.length ? `\nTOPICS PERF FAILED: ${failures.join(', ')}\n` : '\nTOPICS PERF OK\n')
process.exit(failures.length ? 1 : 0)
