/**
 * 打印数据目录的自动探测结果，用来确认「不写死盘符」这件事真的成立。
 *
 *   node dev/paths.test.mjs
 *   node dev/paths.test.mjs --no-store   # 假装没有任何老数据，看会新选到哪
 */

import { candidateDataDirs, dshHome, pickDataDir, pickDefaultDir } from '../lib/paths.js'

const env = {
  DSH_HOME: process.env.DSH_HOME ?? '(未设置)',
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR ?? '(未设置)',
  DSH_MEMORY_DIR: process.env.DSH_MEMORY_DIR ?? '(未设置)',
  homedir: process.env.USERPROFILE ?? process.env.HOME ?? '(未知)',
}

console.log('环境')
for (const [key, value] of Object.entries(env)) console.log(`  ${key} = ${value}`)
console.log(`\ndshHome() = ${dshHome()}`)
console.log('\n候选目录（按优先级）')
for (const [index, dir] of candidateDataDirs().entries()) console.log(`  ${index + 1}. ${dir}`)
console.log(`\n默认目录 pickDefaultDir() = ${await pickDefaultDir()}`)
console.log(`实际目录 pickDataDir()    = ${await pickDataDir()}`)
