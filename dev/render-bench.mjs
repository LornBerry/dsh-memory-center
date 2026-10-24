/**
 * 面板渲染基准（手动跑：`node dev/render-bench.mjs 2000`）。
 *
 * 目的：给出「N 条记忆时 MemoryPanel 单次渲染」的耗时数字，用来对比优化前后，
 * 也用来判断 React.memo 拆行之后还剩多少 O(N) 的重建。离线 mock 渲染器与
 * smoke-client 同源，数字比真实浏览器小得多，但相对趋势可信。
 *
 * 用法：node dev/render-bench.mjs [条数] [轮数]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const COUNT = Number(process.argv[2] || 2000)
const ROUNDS = Number(process.argv[3] || 5)

/* ------------------------------------------------------------------ react */
function createElement(type, props, ...children) {
  const next = { ...(props || {}) }
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  if (flat !== undefined) next.children = next.children === undefined ? flat : [next.children, flat].flat(9)
  return { type, props: next }
}

let instances = new Map()
let current = null
let dirty = false

function getInstance(path, name) {
  let inst = instances.get(path)
  if (!inst) {
    inst = { name, slots: [], hookIndex: 0, deps: [] }
    instances.set(path, inst)
  }
  return inst
}

function useState(init) {
  const inst = current
  const index = inst.hookIndex++
  if (!(index in inst.slots)) inst.slots[index] = typeof init === 'function' ? init() : init
  const setState = (value) => {
    const next = typeof value === 'function' ? value(inst.slots[index]) : value
    if (Object.is(next, inst.slots[index])) return
    inst.slots[index] = next
    dirty = true
  }
  return [inst.slots[index], setState]
}

function useEffect(fn, deps) {
  const inst = current
  const index = inst.hookIndex++
  const prev = inst.deps[index]
  const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]))
  inst.deps[index] = { deps: deps ? [...deps] : null, fn }
  if (changed && fn) inst.slots.__effects.push(fn)
}

const USE_MEMO = process.env.BENCH_MEMO !== '0'

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((key) => Object.is(a[key], b[key]))
}

// 模拟 React.memo：命中时直接复用上次的渲染结果，连组件函数都不再执行。
// BENCH_MEMO=0 关掉它，用来测「没有 memo」时的基线（等价于旧版闭包 renderItem）。
function memo(component) {
  const wrapped = function Memoized(props) {
    return component(props)
  }
  if (USE_MEMO) {
    wrapped.__memo = { component, lastProps: null, lastHtml: null }
    // 这个标记只用于 renderHost 判断，不参与真实 React 的语义。
  }
  return wrapped
}

const React = {
  createElement,
  Fragment: 'fragment',
  useState,
  useEffect,
  useLayoutEffect: useEffect,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value === undefined ? null : value }),
  memo,
  forwardRef: (fn) => fn,
}

/* ---------------------------------------------------------------- renderer */
function renderHost(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => renderHost(child, `${path}[${index}]`)).join('')
  const props = node.props || {}
  const type = node.type
  if (typeof type === 'function') {
    if (type.__memo && type.__memo.lastProps && shallowEqual(type.__memo.lastProps, props)) {
      return type.__memo.lastHtml
    }
    const inst = getInstance(path, type.name || 'anon')
    const parent = current
    current = inst
    inst.hookIndex = 0
    inst.slots.__effects = []
    let out
    try {
      out = type(props)
    } catch (error) {
      console.error(`render failed: ${inst.name}: ${error.message}`)
      process.exit(1)
    }
    const effects = inst.slots.__effects
    delete inst.slots.__effects
    current = parent
    const html = renderHost(out, path)
    for (const effect of effects) {
      try {
        effect()
      } catch (error) {
        console.error(`effect failed: ${inst.name}: ${error.message}`)
        process.exit(1)
      }
    }
    return html
  }
  return renderHost(props.children, path)
}

/* ------------------------------------------------------------------ data */
const now = Date.parse('2026-10-22T00:00:00.000Z')
const items = []
for (let i = 0; i < COUNT; i += 1) {
  items.push({
    id: `m-${i}`,
    title: `第 ${i} 条记忆：关于某个项目约定的说明`,
    body: `这是第 ${i} 条记忆的正文。\n第二行内容，用来触发 markdown 渲染路径。`,
    excerpt: `这是第 ${i} 条记忆的正文摘要，长度接近真实数据。`,
    tags: i % 3 === 0 ? ['约束', '测试'] : [],
    groupId: i % 2 === 0 ? 'g-1' : 'g-2',
    enabled: i % 7 !== 0,
    pinned: i % 11 === 0,
    status: i % 13 === 0 ? 'pending' : 'active',
    anchorMode: i % 17 === 0 ? 'full' : 'off',
    source: i % 5 === 0 ? 'auto' : 'manual',
    createdAt: new Date(now - i * 60000).toISOString(),
    updatedAt: new Date(now - i * 60000).toISOString(),
  })
}

const snapshot = {
  ok: true,
  dataDir: 'E:\\dsh-data\\memory',
  groups: [
    { id: 'g-1', name: '项目约定', order: 0 },
    { id: 'g-2', name: '我的偏好', order: 1 },
  ],
  items,
  tags: ['约束'],
  stats: { groups: 2, items: COUNT, enabled: COUNT, pending: 1, pinned: 1, deleted: 0 },
  deleted: [],
  archived: [],
  recycle: { keepDays: 30, autoPurge: false, count: 0 },
  topics: { groups: [], byId: {} },
  session: { sessionId: 'bench', decided: false, mode: 'none', groupIds: [], itemIds: [], count: 0, groupCount: 0 },
  preview: '',
  sync: { mode: 'off', remote: '', branch: 'main', lastSyncAt: '', lastSyncStatus: '' },
  injection: { total: COUNT, kept: 0, dropped: 0, chars: 0, limit: 12000, softLimit: 9600, ratio: 0.8, totalChars: 0, over: false, indexMode: true, anchors: 0, topics: 0, stale: 0 },
  sessionDefault: { mode: 'ask', groupIds: [] },
  updatedAt: '2026-10-22T00:00:00.000Z',
}

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot })
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById() {
    return null
  },
  createElement() {
    return { style: {}, setAttribute() {}, appendChild() {} }
  },
  head: { appendChild() {} },
}

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

const source = readFileSync(CLIENT, 'utf8')
new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)
if (!definition) {
  console.error('FAIL: client.js never called window.__ModuleLoader__.load')
  process.exit(1)
}
const plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

const registrations = []
plugin.apply({
  get: () => undefined,
  effect: () => () => {},
  on: () => () => {},
  slots: {
    inject(key, callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
})

const main = registrations.find((entry) => entry.options.name === 'main')
if (!main) {
  console.error('FAIL: no main registration')
  process.exit(1)
}

async function waitForIdle() {
  for (let round = 0; round < 40; round += 1) {
    dirty = false
    renderHost(currentTree, 'root')
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) return
  }
  console.error('renderer did not settle')
  process.exit(1)
}

let currentTree = null

instances = new Map()
currentTree = createElement(main.component, { sessionId: 'bench' })
await waitForIdle()

// 预热
for (let i = 0; i < 2; i += 1) renderHost(currentTree, 'root')

const started = performance.now()
let html = ''
for (let i = 0; i < ROUNDS; i += 1) html = renderHost(currentTree, 'root')
const perRound = (performance.now() - started) / ROUNDS
console.log(`${COUNT} 条记忆：单次渲染 ${perRound.toFixed(2)} ms（${ROUNDS} 轮平均），HTML ${html.length} 字符`)
