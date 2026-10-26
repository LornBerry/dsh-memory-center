// 对「正在跑的 DSH 实例」做一次只读体检：不动任何记忆数据，只发 state / sync.get 这类读请求。
// 用法：node dev/patrol.mjs --url http://127.0.0.1:<端口>
// 退出码 0 表示全绿，非 0 表示有 FAIL（便于脚本或面板调用）。
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const urlFlag = args.findIndex((a) => a === '--url')
const base = (urlFlag >= 0 ? args[urlFlag + 1] : args.find((a) => a.startsWith('--url='))?.slice(6)) || 'http://127.0.0.1:60446'

if (!/^https?:\/\//.test(base)) {
  console.error('用法：node dev/patrol.mjs --url http://127.0.0.1:<端口>')
  process.exit(2)
}

const lines = []
let failed = 0
function ok(label, detail = '') {
  lines.push(`ok   ${label}${detail ? ` = ${detail}` : ''}`)
}
function fail(label, detail = '') {
  failed += 1
  lines.push(`FAIL ${label}${detail ? ` = ${detail}` : ''}`)
}

async function call(op, payload = {}) {
  const res = await fetch(`${base}/dsh-memory/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, sessionId: '__patrol__', ...payload }),
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`)
  }
  return { status: res.status, data }
}

console.log(`== 运行时体检 == ${base}`)
console.log(`== 工作区版本 == ${JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version}`)

// 1. 接口可达 + 快照基本形状
let state = null
try {
  const { status, data } = await call('state')
  if (status === 200 && data && data.ok === true) {
    state = data
    ok('接口可达且 ok=true', `HTTP ${status}`)
  } else {
    fail('接口返回异常', JSON.stringify(data).slice(0, 160))
  }
} catch (error) {
  fail('接口不可达', error.message)
}

if (state) {
  // 2. 列表只传摘要：条目必须没有 body，必须有 excerpt / bodyChars
  const items = Array.isArray(state.items) ? state.items : []
  const withBody = items.filter((item) => item.body !== undefined).length
  const missingExcerpt = items.filter((item) => typeof item.excerpt !== 'string').length
  const missingChars = items.filter((item) => typeof item.bodyChars !== 'number').length
  if (withBody === 0) ok('快照条目都不带 body', `共 ${items.length} 条`)
  else fail('快照里存在 body 字段', `${withBody} 条`)
  if (missingExcerpt === 0) ok('快照条目都有 excerpt')
  else fail('有条目缺 excerpt', `${missingExcerpt} 条`)
  if (missingChars === 0) ok('快照条目都有 bodyChars')
  else fail('有条目缺 bodyChars', `${missingChars} 条`)

  // 3. 注入预算自洽
  const injection = state.injection || {}
  if (typeof injection.softLimit === 'number' && injection.softLimit > 0) {
    ok('注入预算已计算', `压缩线 ${injection.softLimit} / 上限 ${injection.limit ?? '?'}`)
    if (injection.softLimit <= (injection.limit ?? Infinity)) ok('压缩线不超过硬上限')
    else fail('压缩线超过硬上限', `${injection.softLimit} > ${injection.limit}`)
  } else {
    fail('注入预算缺失', JSON.stringify(injection).slice(0, 120))
  }

  // 4. 增量注入的可观测字段（本会话没注入过时是空，不算错）
  if ('lastInject' in state) {
    ok('快照带 lastInject 字段', state.lastInject ? `${state.lastInject.kind} · ${state.lastInject.chars} 字` : '本会话尚未注入')
  } else {
    fail('快照缺 lastInject 字段')
  }

  // 5. 数据目录存在且可写（只查文件系统，不写）
  if (typeof state.dataDir === 'string' && state.dataDir) {
    try {
      fs.accessSync(state.dataDir, fs.constants.W_OK)
      ok('数据目录可写', state.dataDir)
    } catch {
      fail('数据目录不可写', state.dataDir)
    }
    const storeFile = path.join(state.dataDir, 'store.json')
    if (fs.existsSync(storeFile)) ok('store.json 存在', `${(fs.statSync(storeFile).size / 1024).toFixed(1)} KB`)
    else fail('store.json 不存在', storeFile)
  } else {
    fail('快照没给 dataDir')
  }

  // 6. 会话选择字段（新会话默认「每次都问」时是 none，属正常）
  const mode = state.session && state.session.mode
  ok('会话选择已读出', String(mode))
  ok('条目统计', `共 ${state.stats?.items ?? items.length} 条 · 参与注入 ${state.stats?.enabled ?? '?'} 条`)
}

// 7. 同步配置不回传明文密码
try {
  const { data } = await call('sync.get')
  if (data && data.ok === true && data.sync) {
    if (data.sync.password === undefined) ok('sync.get 不回传明文密码')
    else fail('sync.get 泄漏明文密码')
    if (typeof data.sync.passwordSet === 'boolean') ok('sync.get 用 passwordSet 告知存过密码', String(data.sync.passwordSet))
    else fail('sync.get 缺 passwordSet')
  } else {
    fail('sync.get 返回异常', JSON.stringify(data).slice(0, 120))
  }
} catch (error) {
  fail('sync.get 调用失败', error.message)
}

console.log(lines.join('\n'))
console.log(failed ? `PATROL FAIL（${failed} 项）` : 'PATROL OK')
process.exit(failed ? 1 : 0)
