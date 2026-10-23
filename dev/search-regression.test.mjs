/**
 * 检索回归集。
 *
 * 目的：改分词、BM25 权重、同义词时，能立刻看出「哪些原本搜得到的东西搜不到了」。
 * 单测（dev/search.test.mjs）验证机制，这个文件验证**效果**：用一批接近真实的记忆
 * 和一批用户真会敲的查询，断言目标条目出现在前 3 名。
 *
 * 判定口径：
 *   ok      目标就在第 1 名
 *   ok(非首位) 目标在前 3 名（允许排序波动，但必须搜得到）
 *   FAIL    目标掉出前 3，或本该无结果的查询返回了结果
 *
 * 跑法：node dev/search-regression.test.mjs
 */
import { searchItems } from '../lib/retrieval.js'

const memories = [
  { id: 'm1', title: '记忆库是本机文件夹，路径自动探测', body: '记忆只存在本机一个目录里，可在「存储位置」改。插件会按可写性自动挑目录，不写死盘符；默认不联网、不上传。', tags: ['存储'] },
  { id: 'm2', title: '跨设备同步可选 Git 或 WebDAV', body: '默认关闭。可以绑自己的 Git 私有仓库或坚果云这类 WebDAV，按条目合并，推送永远 fast-forward。', tags: ['同步'] },
  { id: 'm3', title: '注入预算默认压缩线 80%', body: '硬上限 12000 字符，超过压缩阈值就按锚点优先级装载，装不下的退化成标题索引，绝不把一条记忆从中间切开。', tags: ['注入'] },
  { id: 'm4', title: '回收站默认保留 30 天', body: '删除先进回收站，超期或手动清空才彻底删除；清理前会留一份 pre-purge 备份。', tags: ['回收站'] },
  { id: 'm5', title: '记忆锚点分完全锚点与权重锚点', body: '完全锚点表示必须照此执行、不得偏离；权重锚点只是偏好倾向。新记忆会按措辞自动初判。', tags: ['锚点'] },
  { id: 'm6', title: '思考过程用中文', body: '用户要求模型输出与思考过程使用中文，除非涉及特定术语或另有指定。', tags: ['偏好'] },
  { id: 'm7', title: '禁止用 PowerShell 往返 UTF-8 文件', body: 'Windows PowerShell 5.1 会写成 UTF-16 或带 BOM，中文变乱码，插件会直接消失；改文件只用 write/edit 工具或 Node 的 writeFileSync。', tags: ['编码'] },
  { id: 'm8', title: '每次改动都要提交并推送', body: '改完代码就 git add、commit、push，本仓库不允许留下未提交的改动。', tags: ['流程'] },
  { id: 'm9', title: '插件市场是提 PR 收录', body: 'awesome-dsh-plugin 仓库里一个插件一个 yml，提 PR 后等维护者批准；仓库要满一天才过年龄检查。', tags: ['市场'] },
  { id: 'm10', title: '备份统一放 backups 目录每种留 5 份', body: '损坏、切目录、清空回收站之前各留一份快照，只保留最近 5 份，永远不碰 store.json 本体。', tags: ['备份'] },
  { id: 'm11', title: '记忆用文件夹整理', body: '单层文件夹，可以把条目拖进去；删文件夹时可以选择把条目移到未归类。', tags: ['整理'] },
  { id: 'm12', title: '模型写入的记忆要先转正', body: 'memory_write 写入的条目落在待确认，用户点转正之后才参与注入。', tags: ['流程'] },
  { id: 'm13', title: '检索用 BM25 加同义词扩展', body: '没有向量检索；分词后按 BM25 打分，常见中文说法用同义词组扩展召回，结果带高亮片段。', tags: ['检索'] },
  { id: 'm14', title: '归档的条目不参与注入', body: '归档只是移出注入与常规列表，数据还在，可以随时还原。', tags: ['归档'] },
  { id: 'm15', title: '删除记录保留 90 天', body: '墓碑是跨设备同步用的凭据，保留 90 天；清理太早可能让另一台设备的旧副本把条目推回来。', tags: ['同步'] },
  { id: 'm16', title: '同步冲突会留一份副本', body: '两台设备都改过同一条时，取更新的那条，输掉的那一版写进 backups 的 conflict 文件，事后能捞。', tags: ['同步'] },
  { id: 'm17', title: '可以全局暂停注入', body: '临时不想让任何记忆进上下文时，打开暂停开关，所有会话都不带记忆，库里的数据不受影响。', tags: ['注入'] },
  { id: 'm18', title: '新会话默认加载策略可设', body: '可以设成每次问、默认不加载、默认全部加载，或默认加载某几个文件夹。', tags: ['会话'] },
  { id: 'm19', title: '支持导出 JSON 与 Markdown', body: '导出整库为 JSON 或 Markdown；导入时按标题加正文去重，先预览将新增与跳过的条数。', tags: ['导出'] },
  { id: 'm20', title: '面板在手机上也能用', body: '窄屏时左栏变成抽屉，卡片操作收进更多菜单，底部批量条贴底显示。', tags: ['界面'] },
]

/** 每条：查询 → 期望命中的 id（前 3 名内即可） */
const cases = [
  ['记忆存哪', 'm1'],
  ['数据目录能改吗', 'm1'],
  ['怎么开同步', 'm2'],
  ['git 仓库同步', 'm2'],
  ['压缩阈值多少', 'm3'],
  ['回收站几天删掉', 'm4'],
  ['锚点 完全锚点', 'm5'],
  ['回复用中文', 'm6'],
  ['PowerShell 写文件乱码', 'm7'],
  ['commit 完要 push 吗', 'm8'],
  ['怎么上插件市场', 'm9'],
  ['备份留几份', 'm10'],
  ['怎么建文件夹', 'm11'],
  ['待确认怎么转正', 'm12'],
  ['搜索用的什么算法', 'm13'],
  ['归档以后还会注入吗', 'm14'],
  ['删除记录留着干嘛', 'm15'],
  ['两台设备改同一条怎么办', 'm16'],
  ['怎么暂停注入', 'm17'],
  ['新会话默认加载', 'm18'],
  ['导出成 markdown', 'm19'],
  ['手机上能用吗', 'm20'],
]

/**
 * 负例只放「整库确实没有的词」：纯噪声、无关领域。
 *
 * 已知局限（不列入断言）：中文按二元组切词，所以「不存在的词」这种否定式查询会靠
 * 通用词「存在」蹭到结果 —— 词法检索无法理解否定。要解决得上语义检索，收益不值当，
 * 这里只保证「搜的是库里真有/真没有的词」这两件事的召回质量。
 */
const negative = ['zzzzqqqq', 'qwertyuiop', '量子计算编译器', 'postgresql 连接池']

let passed = 0
let failed = 0
for (const [query, expected] of cases) {
  const hits = searchItems(memories, query, { limit: 10 })
  const top = hits.map((hit) => hit.item.id)
  const at = top.indexOf(expected)
  if (at === 0) {
    passed += 1
    console.log(`ok        ${query} → ${expected}（第 1 名，score ${hits[0].score.toFixed(2)}）`)
  } else if (at > 0 && at < 3) {
    passed += 1
    console.log(`ok(非首位) ${query} → ${expected}（第 ${at + 1} 名；首位是 ${top[0]} score ${hits[0].score.toFixed(2)}）`)
  } else {
    failed += 1
    console.error(`FAIL      ${query} → 期望 ${expected}，实际前 5：${top.slice(0, 5).join(',') || '空'}`)
  }
}

for (const query of negative) {
  const hits = searchItems(memories, query, { limit: 10 })
  if (hits.length === 0) {
    passed += 1
    console.log(`ok        无结果：${query}`)
  } else {
    failed += 1
    console.error(`FAIL      本应无结果：${query}，实际返回 ${hits.length} 条，首位 ${hits[0].item.id}`)
  }
}

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : ''}`)
if (failed) process.exitCode = 1
else console.log('SEARCH REGRESSION OK')
