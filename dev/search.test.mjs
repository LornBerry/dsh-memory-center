/**
 * 检索引擎自测（不联网、不依赖模型）。
 * 覆盖：中文二元组分词、同义词扩展召回、字段权重排序、拉丁词、空结果。
 */
import { cosine, searchItems, tokenize } from '../lib/retrieval.js'

let failed = 0
function ok(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected) ? true : actual === expected
  if (!pass) {
    failed += 1
    console.log(`FAIL ${label} = ${JSON.stringify(actual)}（期望 ${JSON.stringify(expected)}）`)
  } else {
    console.log(`ok   ${label} = ${JSON.stringify(actual)}`)
  }
}
function truthy(label, actual, hint = '') {
  if (!actual) {
    failed += 1
    console.log(`FAIL ${label}${hint ? '：' + hint : ''}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

/* ------------------------------------------------------------------ 分词 */

const tokens = tokenize('记忆数据放在 E 盘')
truthy('分词含标题二元组「记忆」', tokens.includes('记忆'), tokens.join(','))
truthy('分词含拉丁词 e', tokens.includes('e'), tokens.join(','))
truthy('分词不含空白', !tokens.some((t) => t.trim() !== t), tokens.join(','))

/* ------------------------------------------------------------------ 语料 */

const items = [
  {
    id: 'm-storage',
    title: '记忆库是本机文件夹，路径自动探测',
    body: '记忆只存在本机一个目录里（本机在 E:\\dsh-data\\memory），可在「存储位置」改。默认不联网、不上传。',
    tags: ['约束', '存储'],
  },
  {
    id: 'm-confirm',
    title: '记忆由用户最终确认',
    body: '模型写入的记忆先进入「待确认」，用户点「转正」后才进入正式库并参与注入。',
    tags: ['流程'],
  },
  {
    id: 'm-env',
    title: '环境变量 DSH_MEMORY_DIR',
    body: '设置后固定数据目录，面板里输入框变只读。',
    tags: ['配置'],
  },
  {
    id: 'm-sync',
    title: '跨设备同步要自己开',
    body: '默认关闭；可以绑定自己的 Git 仓库或 WebDAV 网盘，不经过任何中转服务器。',
    tags: ['同步'],
  },
]

/* ------------------------------------------------------------ 同义 / 召回 */

const byStorage = searchItems(items, '存哪', { limit: 5 })
truthy('「存哪」能召回存储那条', byStorage.some((hit) => hit.item.id === 'm-storage'), JSON.stringify(byStorage.map((h) => h.item.id)))
truthy('命中的是同一主题的条目', byStorage[0] && byStorage[0].item.id === 'm-storage', `首条=${byStorage[0] && byStorage[0].item.id}`)

const byDisk = searchItems(items, '盘符', { limit: 5 })
truthy('「盘符」能召回到路径相关条目', byDisk.some((hit) => hit.item.id === 'm-storage'), JSON.stringify(byDisk.map((h) => h.item.id)))

const byConfirm = searchItems(items, '审核', { limit: 5 })
truthy('「审核」能同义召回到待确认那条', byConfirm.some((hit) => hit.item.id === 'm-confirm'), JSON.stringify(byConfirm.map((h) => h.item.id)))

/* ------------------------------------------------------------------ 排序 */

const ranked = searchItems(items, '跨设备同步', { limit: 4 })
truthy('标题命中排在正文命中之前', ranked[0] && ranked[0].item.id === 'm-sync', `首条=${ranked[0] && ranked[0].item.id}`)
truthy('分数单调不增', ranked.every((hit, i) => i === 0 || ranked[i - 1].score >= hit.score))

/* --------------------------------------------------------------- 拉丁词 */

const latin = searchItems(items, 'DSH_MEMORY_DIR', { limit: 5 })
ok('拉丁词精确命中 1 条', latin.length, 1)
ok('命中的是环境变量那条', latin[0] && latin[0].item.id, 'm-env')

/* ------------------------------------------------------- 片段与空结果 */

truthy('命中带摘要片段', (latin[0] && latin[0].snippet.length > 0) === true)
ok('完全无关的词返回空', searchItems(items, 'zzzzqqqq', { limit: 5 }).length, 0)
ok('空查询返回前 N 条', searchItems(items, '', { limit: 2 }).length, 2)

/* ------------------------------------------------------------ 向量工具 */

ok('余弦：同向为 1', Math.round(cosine([1, 0], [1, 0]) * 1000) / 1000, 1)
ok('余弦：正交为 0', cosine([1, 0], [0, 1]), 0)
ok('余弦：长度不一致为 0', cosine([1, 0], [1, 0, 0]), 0)

console.log(failed ? `\nSEARCH FAILED：${failed} 项` : '\nSEARCH OK')
process.exit(failed ? 1 : 0)
