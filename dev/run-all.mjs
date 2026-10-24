/**
 * 一次跑完 dev/ 下所有 *.test.mjs。
 *
 *   node dev/run-all.mjs      # 或 npm test
 *
 * 为什么不用 `node --test dev/`：这些测试是自定义脚本（自己 console.log + process.exit），
 * 不是 node:test 格式，交给 --test 会报「0 tests」还看不出真失败。
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const tests = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

const failed = []
console.log(`跑 ${tests.length} 个测试文件\n`)

for (const name of tests) {
  process.stdout.write(`=== ${name} ===\n`)
  const result = spawnSync(process.execPath, [path.join(dir, name)], { stdio: 'inherit' })
  if (result.status !== 0) failed.push(name)
}

if (failed.length) {
  console.log(`\nFAILED (${failed.length}/${tests.length}): ${failed.join(', ')}\n`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TEST FILES OK\n`)
