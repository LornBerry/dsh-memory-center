#!/usr/bin/env node
/**
 * 自检清单：一次把「插件到底装好没有」的各个环节都查一遍。
 * 只读，不改任何文件；任何一项 FAIL 都以退出码 1 结束。
 *
 * 用法：
 *   node dev/doctor.mjs
 *   node dev/doctor.mjs --url http://127.0.0.1:60867
 *
 * 覆盖的故障（都真实发生过）：
 *   1. 工作区被清空 / 被移动 → 已安装副本没了或指向空目录
 *   2. profile 里是 link 而不是固定副本 → 下次启动套着工作区一起消失
 *   3. 改了代码但没重新打包安装 → 线上还是旧版
 *   4. 数据目录不可写 / store.json 坏了
 *   5. 装了但宿主没加载 → 接口 404
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { candidateDataDirs } from '../lib/paths.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop')
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-memory-center')

const args = process.argv.slice(2)
const urlArg = args.indexOf('--url')
const BASE = (urlArg >= 0 ? args[urlArg + 1] : process.env.DSH_WEB_URL || '').replace(/\/$/, '')

let failed = 0
function ok(label, detail) {
  console.log(`ok   ${label}${detail ? ` = ${detail}` : ''}`)
}
function bad(label, detail, hint) {
  failed += 1
  console.log(`FAIL ${label}${detail ? ` = ${detail}` : ''}`)
  if (hint) console.log(`     → ${hint}`)
}
function warn(label, detail, hint) {
  console.log(`warn ${label}${detail ? ` = ${detail}` : ''}`)
  if (hint) console.log(`     → ${hint}`)
}
function check(label, value, predicate, hint) {
  if (predicate(value)) ok(label, value)
  else bad(label, value, hint)
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

/* ------------------------------------------------------------- 1. 工作区 */

console.log('== 工作区 ==')
const pkgFile = path.join(ROOT, 'package.json')
check('package.json 可解析', pkgFile, (f) => existsSync(f) && !!readJson(f))
const pkg = readJson(pkgFile)
ok('工作区版本', pkg.version)
const bom = readFileSync(pkgFile)
check('package.json 无 BOM', bom[0] !== 0xef, (v) => v === true, '去掉 BOM：writeFileSync 时不要带 \\uFEFF')

/* ---------------------------------------------------------------- 2. git */

console.log('\n== 仓库 ==')
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const hasGit = existsSync(path.join(ROOT, '.git'))
check('.git 存在', path.join(ROOT, '.git'), (p) => hasGit, '工作区丢了 .git 时：git init + fetch + reset origin/main 可恢复（对象仍在）')
if (hasGit) {
  try {
    const head = git('rev-parse', '--short', 'HEAD')
    ok('HEAD', head)
    const dirty = git('status', '--porcelain')
    check('工作区干净', dirty ? `${dirty.split('\n').length} 项未提交` : 'clean', (v) => v === 'clean', 'AGENTS.md 要求每次改动都提交并推送')
    try {
      const remote = git('remote', 'get-url', 'origin')
      ok('origin', remote)
      const behind = git('rev-list', '--left-right', '--count', 'HEAD...origin/main').split(/\s+/)
      check('与 origin/main 同步', `本地领先 ${behind[0]} / 落后 ${behind[1]}`, () => behind[0] === '0' && behind[1] === '0', '先 git push')
    } catch {
      bad('origin 未配置', '', 'git remote add origin https://github.com/LornBerry/dsh-memory-center.git')
    }
    try {
      git('rev-parse', '--verify', '--quiet', `refs/tags/v${pkg.version}`)
      ok('版本 tag 存在', `v${pkg.version}`)
    } catch {
      warn('版本 tag 缺失', `v${pkg.version}`, `git tag v${pkg.version} && git push origin --tags`)
    }
  } catch (error) {
    bad('git 元数据损坏', String(error.message).split('\n')[0], 'git init && git remote add origin ... && git fetch && git reset origin/main')
  }
}

/* ------------------------------------------------------------- 3. 已安装副本 */

console.log('\n== 已安装副本（DSH profile）==')
check('安装目录存在', INSTALLED, (p) => existsSync(p), '到插件市场/plugin_manager 重装，或跑 dev/release.mjs 后 install_bundle')
if (existsSync(INSTALLED)) {
  let linkType = ''
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${INSTALLED}' -Force).LinkType`], { encoding: 'utf8' }).trim()
    linkType = out
  } catch {}
  if (linkType) {
    bad(
      '安装方式是固定副本',
      `${linkType} → 指向 ${process.env.USERPROFILE}\\...\\${path.basename(ROOT)} 之外`,
      'link 安装会跟着工作区一起消失/改动；改用 dev/release.mjs 打包后 install_bundle',
    )
  } else {
    ok('安装方式是固定副本', '真实目录')
  }
  const instPkgFile = path.join(INSTALLED, 'package.json')
  if (existsSync(instPkgFile)) {
    const instPkg = readJson(instPkgFile)
    ok('已安装版本', instPkg.version)
    check(
      '已安装版本 = 工作区版本',
      `${instPkg.version} vs ${pkg.version}`,
      () => instPkg.version === pkg.version,
      '工作区改过代码但没重新打包安装：node dev/release.mjs 后再 install_bundle',
    )
  }
  for (const file of ['index.js', 'client.js', 'lib/sync.js', 'lib/paths.js']) {
    const a = path.join(ROOT, file)
    const b = path.join(INSTALLED, file)
    if (!existsSync(a)) continue
    if (!existsSync(b)) {
      bad(`副本缺少 ${file}`, '', '重新打包安装')
      continue
    }
    check(`${file} 与工作区一致`, sha(a) === sha(b) ? 'same' : `${sha(a)} vs ${sha(b)}`, (v) => v === 'same', '重新打包安装')
  }
}

/* ---------------------------------------------------------------- 4. 接口 */

console.log('\n== 运行时接口 ==')
let apiDataDir = null
if (!BASE) {
  warn('未提供 Web 地址', '', '加 --url http://127.0.0.1:<端口>，或设置环境变量 DSH_WEB_URL')
} else {
  const api = `${BASE}/dsh-memory/api`
  async function call(op) {
    const response = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op }),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  try {
    const cfg = await call('config.get')
    check(`${api} 可达`, `HTTP ${cfg.status}`, () => cfg.status === 200 && cfg.body && cfg.body.ok === true, '宿主没加载插件：重启 DSH，或检查 profile/cordis.patch.yml')
    if (cfg.body && cfg.body.ok) {
      ok('数据目录', cfg.body.dataDir)
      apiDataDir = cfg.body.dataDir
      ok('默认目录', cfg.body.defaultDir)
      const writable = cfg.body.writable
      if (writable === undefined) warn('writable 未上报', '', '')
      else check('数据目录可写', String(writable), (v) => v === 'true')
      const state = await call('state')
      if (state.body && state.body.ok) {
        ok('条目数', String(state.body.items.length))
        ok('文件夹数', String(state.body.groups.length))
        ok('已启用', String(state.body.stats.enabled))
      } else {
        bad('state 读取失败', JSON.stringify(state.body))
      }
    }
  } catch (error) {
    bad('接口请求失败', String(error.message), '确认 DSH 正在运行、端口正确，且宿主已加载本插件')
  }
}

/* ---------------------------------------------------------------- 5. 数据 */

console.log('\n== 本地数据 ==')
// 复用接口报回来的真实数据目录；接口不通时才退回本地探测。
// 这里必须只读：体检不该在用户磁盘上创建目录或写探针文件，
// 所以按候选顺序找第一个已经存在 store.json 的目录，找不到就如实报错。
const probeDir = candidateDataDirs().find((dir) => existsSync(path.join(dir, 'store.json')))
const dataDir = apiDataDir || process.env.DSH_MEMORY_DIR || probeDir
if (!dataDir) {
  bad('未找到数据目录', '候选路径里都没有 store.json', '确认插件已装好并至少打开过一次记忆面板；或用 --url 指向正在运行的 DSH')
}
const storeFile = dataDir ? path.join(dataDir, 'store.json') : ''
if (!storeFile) {
  // 上面已经报错，后面不再重复检查
} else if (!existsSync(storeFile)) {
  warn('store.json 不存在', storeFile, '首次打开面板时会自动创建；路径不同就查 config.get 的 dataDir')
} else {
  try {
    const store = JSON.parse(readFileSync(storeFile, 'utf8'))
    ok('store.json 可解析', `${store.items?.length ?? 0} 条 / ${store.groups?.length ?? 0} 组`)
    ok('最后修改', statSync(storeFile).mtime.toISOString())
  } catch (error) {
    bad('store.json 损坏', String(error.message), '插件会自动备份损坏文件并重建；也可从导出 JSON 恢复')
  }
}

console.log(failed === 0 ? '\nDOCTOR OK\n' : `\nDOCTOR FAILED：${failed} 项需要处理\n`)
process.exit(failed === 0 ? 0 : 1)
