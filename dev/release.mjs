#!/usr/bin/env node
/**
 * 一键发版：自测 → 改版本号 → 打包成 tgz → 打印安装命令。
 *
 * 为什么是 tgz 而不是 link：
 *   插件是装进 DSH profile 的 bundle，`link:` 安装会让“工作区被改动”直接等于“线上被改动”，
 *   工作区一旦被清空/移动，DSH 下次启动就会找不到插件（2026-10-23 出过一次）。
 *   tgz 安装会给 profile 一份**固定副本**，工作区怎么动都不影响已装好的版本；
 *   要更新时再显式跑一遍本脚本 + 安装命令。
 *
 * 用法：
 *   node dev/release.mjs              # patch 位 +1
 *   node dev/release.mjs minor        # 0.4.1 → 0.5.0
 *   node dev/release.mjs 1.2.3        # 指定版本
 *   node dev/release.mjs patch --skip-tests
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = process.env.DSH_MEMORY_DIST || 'E:\\dsh-data\\memory-center-dist'

const args = process.argv.slice(2)
const skipTests = args.includes('--skip-tests')
const target = args.find((a) => !a.startsWith('--')) || 'patch'

const PKG_FILE = path.join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8').replace(/^\uFEFF/, ''))

function bump(version, target) {
  if (/^\d+\.\d+\.\d+$/.test(target)) return target
  const [major, minor, patch] = version.split('.').map(Number)
  if (target === 'major') return `${major + 1}.0.0`
  if (target === 'minor') return `${major}.${minor + 1}.0`
  if (target === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`无法识别的版本参数：${target}（可用 patch / minor / major / x.y.z）`)
}

function run(cmd, cmdArgs, opts = {}) {
  process.stdout.write(`\n$ ${cmd} ${cmdArgs.join(' ')}\n`)
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts })
}

/* ------------------------------------------------------------------ 1. 自测 */

if (!skipTests) {
  run(process.execPath, ['--check', 'index.js'])
  run(process.execPath, ['--check', 'client.js'])
  for (const file of ['lib/paths.js', 'lib/sync.js']) {
    if (existsSync(path.join(ROOT, file))) run(process.execPath, ['--check', file])
  }
  const tests = [
    'dev/smoke-client.mjs',
    'dev/host-smoke.mjs',
    'dev/paths.test.mjs',
    'dev/merge.test.mjs',
    'dev/sync.test.mjs',
    'dev/sync-git.test.mjs',
    'dev/anchor.test.mjs',
    'dev/encoding.test.mjs',
    'dev/memory-write.test.mjs',
    'dev/resilience.test.mjs',
    'dev/recycle.test.mjs',
  ]
  for (const test of tests) {
    if (existsSync(path.join(ROOT, test))) run(process.execPath, [test])
  }
}

/* -------------------------------------------------------------- 2. 改版本号 */

const next = bump(pkg.version, target)
pkg.version = next
// 写回时不要 BOM：DSH / pnpm / 一些 JSON 读取器对 BOM 敏感
writeFileSync(PKG_FILE, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`\n版本：${next}`)

/* ---------------------------------------------------------------- 3. 打包 */

const staging = mkdtempSync(path.join(tmpdir(), 'dmc-pack-'))
const packageDir = path.join(staging, 'package')
mkdirSync(packageDir, { recursive: true })
for (const file of [...(pkg.files || []), 'package.json']) {
  const from = path.join(ROOT, file)
  if (!existsSync(from)) {
    console.warn(`跳过不存在的条目：${file}`)
    continue
  }
  cpSync(from, path.join(packageDir, file), { recursive: true })
}
mkdirSync(DIST, { recursive: true })
const tgz = path.join(DIST, `dsh-memory-center-${next}.tgz`)
run('tar', ['-czf', tgz, '-C', staging, 'package'])
rmSync(staging, { recursive: true, force: true })

/* ---------------------------------------------------------------- 4. 收尾 */

const steps = [
  `1) 安装/更新到 DSH（profile 会得到一份固定副本）：`,
  `   plugin_manager  action=install_bundle`,
  `   target=${tgz}`,
  ``,
  `2) 刷新 Web 页面（client 半即时生效）；index.js 有改动时重启 DSH。`,
  `3) 提交并打 tag：`,
  `   git add -A && git commit -m "release: v${next}" && git tag v${next} && git push origin main --tags`,
]
console.log(`\n打包完成：${tgz}\n\n${steps.join('\n')}\n`)
