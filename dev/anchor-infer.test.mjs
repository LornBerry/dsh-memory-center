/**
 * 锚点初判（lib/anchor.js）的规则自测，不需要 DSH、不联网、不调模型。
 *
 *   node dev/anchor-infer.test.mjs
 *
 * 这些规则决定「新记忆一进来是硬性约束还是软偏好」，
 * 判错了要么该守的没守住（硬性被当普通事实），要么满屏都是权重锚点失去区分度。
 */

import { inferAnchor, ANCHOR_CUES } from '../lib/anchor.js'

let failures = 0
function expect(label, actual, check, hint) {
  const ok = typeof check === 'function' ? check(actual) : actual === check
  if (ok) console.log(`ok   ${label} = ${JSON.stringify(actual)}`)
  else {
    failures += 1
    console.log(`FAIL ${label} = ${JSON.stringify(actual)}${hint ? `  (${hint})` : ''}`)
  }
}

const mode = (title, body, tags) => inferAnchor({ title, body, tags }).mode

/* ----------------------------------------------------------------- 硬性约束 */

for (const [title, body] of [
  ['提交前必须跑测试', '所有改动提交前必须跑一遍自测。'],
  ['禁止直接推 main', '禁止把未验证的提交推到 main。'],
  ['路径只写 E 盘', '记忆只写在 E 盘，不要落到 C 盘。'],
  ['不要用 PowerShell 往返 UTF-8', '禁止用 Set-Content 写中文文件。'],
  ['一律用 pnpm', '安装依赖一律用 pnpm，不混用 npm。'],
]) {
  expect(`硬性：${title}`, mode(title, body), 'full', '应判为完全锚点')
}

/* ----------------------------------------------------------------- 权重偏好 */

for (const [title, body] of [
  ['回复风格偏好', '尽量用中文回答，必要时再夹英文术语。'],
  ['命名习惯', '变量名尽量用小驼峰，通常避免缩写。'],
  ['测试策略建议', '建议先写冒烟测试，再补边界用例。'],
  ['一般习惯', '通常先看日志再改代码。'],
]) {
  expect(`软性：${title}`, mode(title, body), 'weight', '应判为权重锚点')
}

/* ----------------------------------------------------------------- 普通事实 */

for (const [title, body] of [
  ['项目用 Node 22', '当前项目运行在 Node 22 上。'],
  ['仓库地址', '代码在 github.com/LornBerry/dsh-memory-center。'],
  ['空内容', ''],
]) {
  expect(`普通：${title}`, mode(title, body), 'off', '没有强弱措辞应判不设锚点')
}

/* ------------------------------------------------- 描述性否定不算硬性约束 */

// 这些是「描述事实/故障」，不是「对我下命令」。判成 full 会让模型把事实当命令，
// 比漏判更危险（2026-10-23 评审第一轮的真实反例）。
for (const [title, body] of [
  ['路径长度限制', 'Windows 路径不能超过 260 字符。'],
  ['故障现象', '插件装上后不能正常启动。'],
  ['夸张说法', '这种不要脸的写法别再出现在这里。'],
  ['权限说明', '这个命令不需要管理员权限。'],
]) {
  expect(`描述：${title}`, mode(title, body), (v) => v !== 'full', '描述性否定不能被判成完全锚点')
}

expect(
  '弱否定 + 立规矩信号 → 硬性',
  mode('以后的提交', '以后每次提交都不要用 npm，统一走 pnpm。'),
  'full',
  '「不要」+「以后/每次/统一」才算真下命令',
)
expect(
  '否定式偏好不反着解释',
  inferAnchor({ title: '回话风格', body: '不喜欢长篇解释，倾向直接给结论。' }),
  (v) => v.mode === 'weight' && v.why.includes('否定式'),
  '「不喜欢」不能被解释成「命中偏好措辞：喜欢」',
)

/* ------------------------------------------------------- 优先级与边界 */

expect(
  '硬性压过软性',
  inferAnchor({ title: '建议但必须', body: '建议这样，但上线前必须确认。' }).mode,
  'full',
  '同时出现时硬性优先',
)
expect(
  '安全语境里的否定也算硬性',
  inferAnchor({ title: '凭据处理', body: '不要把密码写进代码或日志。' }).mode,
  'full',
  '密码 + 不要 应判 full',
)
expect(
  '英文安全词 + 否定也算硬性',
  inferAnchor({ title: '凭据处理', body: '不要把 API key 写进仓库。' }).mode,
  'full',
  'api key / secret / password 必须能命中，且大小写不敏感',
)
expect(
  '英文否定式也认',
  inferAnchor({ title: 'credentials', body: 'never commit the secret to git' }).mode,
  'full',
  'never / do not 与中文否定同权',
)
expect(
  '技术描述里的「默认」不算立规矩',
  inferAnchor({
    title: 'Windows 路径不能超过 260 字符',
    body: 'NTFS 默认限制，长路径要开 LongPathsEnabled。',
  }).mode,
  (v) => v !== 'full',
  '「默认 / 一般 / 通常」是技术常用词，不能当作立规矩信号',
)
expect(
  '裸 key 不误命中',
  inferAnchor({ title: '键盘布局', body: 'keyboard layout 差异' }).mode,
  'off',
  '词表里不放裸 key，避免「关键 / keyboard」误判',
)
expect(
  '理由里点名命中措辞',
  inferAnchor({ title: '必须跑测试', body: '' }).why,
  (v) => typeof v === 'string' && v.includes('必须'),
  '理由要可解释',
)
expect(
  '标签也参与判断',
  inferAnchor({ title: '某条记忆', body: '普通内容', tags: ['禁止'] }).mode,
  'full',
  '标签里的硬性词也算',
)
expect(
  '返回结构稳定',
  Object.keys(inferAnchor({ title: 'x', body: 'y' })).sort().join(','),
  'hard,mode,soft,why',
  '调用方依赖这组字段',
)
expect(
  '线索表非空',
  ANCHOR_CUES.hard.length > 0 && ANCHOR_CUES.soft.length > 0,
  true,
  '导出供文档/配置使用',
)

if (failures) {
  console.log(`\nANCHOR INFER FAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nANCHOR INFER OK')
