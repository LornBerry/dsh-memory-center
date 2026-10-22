/**
 * 编码守卫：这个仓库曾经因为 package.json 带了 UTF-8 BOM 被 DSH 判成
 * 「not valid JSON」，插件直接从插件列表里消失、面板也不见。
 *
 * 检查三件事：
 *  1. 任何文本文件都不以 BOM 开头（BOM 会让 JSON.parse 直接抛错）；
 *  2. package.json 能被 JSON.parse 解析，且关键字段齐全；
 *  3. 仓库里的文本文件没有 U+FFFD（出现过替换字符就说明某次写盘把中文写坏了）。
 *
 * 用法：node dev/encoding.test.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])
const TEXT_EXT = /\.(js|mjs|cjs|json|yml|yaml|md|txt|svg|css|html)$/
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const failures = []
const files = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.gitattributes') {
      if (entry.isDirectory()) continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full)
      continue
    }
    if (TEXT_EXT.test(entry.name)) files.push(full)
  }
}

walk(ROOT)

for (const file of files) {
  const buffer = readFileSync(file)
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (buffer.length >= 3 && buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2]) {
    failures.push(`${rel} 以 UTF-8 BOM 开头（JSON.parse 会失败）`)
  }
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) failures.push(`${rel} 含 U+FFFD 替换字符（中文可能被写坏）`)
}

const pkgRaw = readFileSync(join(ROOT, 'package.json'), 'utf8')
let pkg = null
try {
  pkg = JSON.parse(pkgRaw)
} catch (error) {
  failures.push(`package.json 不是合法 JSON：${error.message}`)
}

if (pkg) {
  for (const field of ['name', 'version', 'exports', 'files', 'dsh']) {
    if (!pkg[field]) failures.push(`package.json 缺少字段 ${field}`)
  }
  if (!pkg.dsh?.bundle?.patch) failures.push('package.json 缺少 dsh.bundle.patch')
  if (!pkg.dsh?.client?.platform) failures.push('package.json 缺少 dsh.client.platform')
  for (const entry of pkg.files ?? []) {
    try {
      statSync(join(ROOT, entry))
    } catch {
      failures.push(`package.json 的 files 列了不存在的文件：${entry}`)
    }
  }
}

if (failures.length) {
  console.error(`编码检查失败（${failures.length} 项）：`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}

console.log(`编码检查通过：${files.length} 个文本文件无 BOM、无替换字符；package.json 合法`)
