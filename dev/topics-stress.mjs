/**
 * 同主题识别的极限压力测试（手动跑，不进 release 清单）。
 *
 *   node dev/topics-stress.mjs            # 默认场景
 *   node dev/topics-stress.mjs --full     # 追加最坏情况（可能要几十秒）
 *
 * 目的：给「要不要继续优化 / 要不要加截断 / looksSameTopicLegacy 留不留」提供数据。
 * 测三类规模 × 三种标题分布 × 两种正文长度，并对比旧实现（逐对重算）的耗时倍数。
 */
import { groupTopics, looksSameTopicLegacy } from '../lib/topics.js'

const FULL = process.argv.includes('--full')
const HIGH_FREQ = ['记忆', '用户', '文件', '系统', '配置', '路径', '插件', '面板']

let clock = Date.parse('2026-01-01T00:00:00.000Z')
const stamp = (i) => new Date(clock + i * 60000).toISOString()

/** 生成一组记忆。titleKind: unique | templated | shared */
function build(n, { titleKind = 'unique', bodyWords = 40, prefix = 'x' } = {}) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    let title
    if (titleKind === 'unique') title = `${prefix} 条目 ${i} 主题 ${hashWord(i)}`
    else if (titleKind === 'templated') title = `${prefix} 项目约定 第 ${i % 100} 条`
    else title = `${prefix} 项目约定 说明`
    const filler = []
    for (let k = 0; k < bodyWords; k += 1) filler.push(HIGH_FREQ[(i + k) % HIGH_FREQ.length])
    const body = `${filler.join(' ')} 编号 ${i} ${titleKind}`
    const at = stamp(i)
    out.push({ id: `${prefix}-${i}`, title, body, updatedAt: at, createdAt: at })
  }
  return out
}

function hashWord(i) {
  const words = ['部署', '检索', '同步', '备份', '锚点', '预算', '回收站', '归档', '文件夹', '注入']
  return words[i % words.length] + (i % 13)
}

function measure(label, items) {
  if (global.gc) global.gc()
  const before = process.memoryUsage().heapUsed
  const t0 = process.hrtime.bigint()
  const result = groupTopics(items)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const after = process.memoryUsage().heapUsed
  const stale = [...result.byId.values()].filter((v) => !v.isLatest).length
  return { label, n: items.length, ms, mb: (after - before) / 1048576, groups: result.groups.length, stale }
}

/** 旧实现（逐对重算 + 两两比较），只在小规模下对比。 */
function legacyTime(items) {
  const list = items.filter((item) => item && item.id)
  const t0 = process.hrtime.bigint()
  let pairs = 0
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (looksSameTopicLegacy(list[i], list[j])) pairs += 1
    }
  }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, pairs }
}

function row(r) {
  // eslint-disable-next-line no-console
  console.log(
    `${r.label.padEnd(34)} n=${String(r.n).padStart(5)}  ${r.ms.toFixed(1).padStart(9)}ms  ${
      r.mb >= 0 ? '+' : ''
    }${r.mb.toFixed(1).padStart(7)}MB  组=${String(r.groups).padStart(4)} 旧版=${String(r.stale).padStart(4)}`,
  )
}

console.log('\n== 新实现（每条分词一次 + 倒排预筛）==')
const cases = [
  ['1000 条 · 标题唯一 · 正文 40 词', 1000, { titleKind: 'unique' }],
  ['2000 条 · 标题唯一 · 正文 40 词', 2000, { titleKind: 'unique' }],
  ['5000 条 · 标题唯一 · 正文 40 词', 5000, { titleKind: 'unique' }],
  ['2000 条 · 标题唯一 · 正文 200 词', 2000, { titleKind: 'unique', bodyWords: 200 }],
  ['2000 条 · 标题模板化（100 个模板）', 2000, { titleKind: 'templated' }],
  ['2000 条 · 标题全都相同', 2000, { titleKind: 'shared' }],
  ['5000 条 · 标题模板化（最坏）', 5000, { titleKind: 'templated' }],
]
const results = []
for (const [label, n, opts] of cases) {
  results.push(measure(label, build(n, opts)))
}
for (const r of results) row(r)

console.log('\n== 旧实现（逐对重算，只跑小组）==')
for (const n of [200, 500]) {
  const items = build(n, { titleKind: 'templated' })
  const legacy = legacyTime(items)
  const fresh = measure(`新实现 ${n} 条`, items)
  console.log(
    `旧实现 n=${n}: ${legacy.ms.toFixed(0)}ms（命中 ${legacy.pairs} 对） / 新实现 ${fresh.ms.toFixed(1)}ms → 快 ${(legacy.ms / fresh.ms).toFixed(1)}×`,
  )
}

if (FULL) {
  console.log('\n== 极端规模（--full）==')
  for (const [label, n, opts] of [
    ['10000 条 · 标题唯一', 10000, { titleKind: 'unique' }],
    ['10000 条 · 标题模板化', 10000, { titleKind: 'templated' }],
  ]) {
    const items = build(n, opts)
    row(measure(label, items))
  }
}

console.log('\n完成。\n')
