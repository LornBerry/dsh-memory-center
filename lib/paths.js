/**
 * 数据目录的自动探测。
 *
 * 这里不假设任何盘符：DSH 的数据根可能在 C/D/E 任意位置，别人机器上甚至只有
 * ~/.dsh。顺序是「先用用户显式指定的」，没有就「先找已经存了数据的老目录」，
 * 再「退到本机已有的 DSH 数据盘」，最后落到系统临时目录兜底——保证插件任何情况下都能起来。
 */

import os from 'node:os'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

/** 本机 DSH 数据根：环境变量 > profile 目录反推 > ~/.dsh。 */
export function dshHome() {
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return path.dirname(path.dirname(path.resolve(profileDir)))
  return path.join(os.homedir(), '.dsh')
}

/** Windows 上已经存在 `<盘符>:\dsh-data` 的盘，优先跟它在同一个位置放记忆。 */
function dshDataDrives() {
  const found = []
  if (process.platform !== 'win32') return found
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\dsh-data`
    if (existsSync(root)) found.push(path.join(root, 'memory'))
  }
  return found
}

/**
 * 候选目录，按优先级排列。
 *
 * 1. 环境变量 DSH_MEMORY_DIR（显式指定，最高优先）
 * 2. 已经存在的 <盘符>:\dsh-data\memory（DSH 数据在这个盘上，就跟它放一起）
 * 3. 本机 DSH 数据根下的 memory/
 * 4. 各盘符下的 <盘符>:\dsh-data\memory（还没建出来时也能作为落地位置）
 * 5. 用户主目录下的 .dsh/memory、.dsh-memory
 */
export function candidateDataDirs() {
  const list = []
  const push = (dir) => {
    if (!dir) return
    const abs = path.resolve(dir)
    if (!list.includes(abs)) list.push(abs)
  }
  push(process.env.DSH_MEMORY_DIR)
  for (const dir of dshDataDrives()) push(dir)
  push(path.join(dshHome(), 'memory'))
  if (process.platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') push(`${letter}:\\dsh-data\\memory`)
  }
  push(path.join(os.homedir(), '.dsh', 'memory'))
  push(path.join(os.homedir(), '.dsh-memory'))
  return list
}

export async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** 目录存在且能写（顺手建目录、写探针、删探针）。 */
export async function canWriteDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.unlink(probe)
    return true
  } catch {
    return false
  }
}

function fallbackDir() {
  return path.join(os.tmpdir(), 'dsh-memory-center')
}

/** 默认目录：第一个可写的候选（用于「恢复默认」）。 */
export async function pickDefaultDir() {
  for (const dir of candidateDataDirs()) {
    if (await canWriteDir(dir)) return dir
  }
  const fallback = fallbackDir()
  await canWriteDir(fallback)
  return fallback
}

/** 实际使用的目录：先认已经存了 store.json 的老目录，否则同 pickDefaultDir。 */
export async function pickDataDir() {
  for (const dir of candidateDataDirs()) {
    if (await isFile(path.join(dir, 'store.json'))) return dir
  }
  return pickDefaultDir()
}

export { fallbackDir }
