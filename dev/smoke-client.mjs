/**
 * Offline smoke test for dsh-memory-center/client.js.
 *
 * No browser and no react package on this machine, so this file ships a tiny
 * hook-aware renderer: it renders each registered slot component against a
 * stubbed Host fetch, runs effects once per dependency change, and applies
 * state updates until the tree settles. Goal: catch render-time crashes and
 * topology mistakes (wrong slot names / registration options) before reload.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const fail = []

/* ------------------------------------------------------------------ react */
function createElement(type, props, ...children) {
  const next = { ...(props || {}) }
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  if (flat !== undefined) next.children = next.children === undefined ? flat : [next.children, flat].flat(9)
  return { type, props: next }
}

const CREATE_OWN = {
  createElement,
  Fragment: 'fragment',
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

const React = {
  createElement,
  Fragment: 'fragment',
  useState,
  useEffect,
  useLayoutEffect: useEffect,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value === undefined ? null : value }),
  memo: (component) => component,
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
    const inst = getInstance(path, type.name || 'anon')
    const parent = current
    current = inst
    inst.hookIndex = 0
    inst.slots.__effects = []
    let out
    try {
      out = type(props)
    } catch (error) {
      fail.push(`${inst.name}: ${error.message}`)
      current = parent
      return ''
    }
    const effects = inst.slots.__effects
    delete inst.slots.__effects
    current = parent
    const html = renderHost(out, path)
    for (const effect of effects) {
      try {
        effect()
      } catch (error) {
        fail.push(`${inst.name} effect: ${error.message}`)
      }
    }
    return html
  }
  return renderHost(props.children, path)
}

async function waitForIdle() {
  for (let round = 0; round < 40; round += 1) {
    dirty = false
    renderHost(currentTree, 'root')
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) return
  }
  fail.push('renderer did not settle within 40 rounds')
}

let currentTree = null

/* ------------------------------------------------------------------ shell */
const snapshot = {
  ok: true,
  dataDir: 'E:\\dsh-data\\memory',
  groups: [
    { id: 'g-1', name: '项目约定', order: 0 },
    { id: 'g-2', name: '我的偏好', order: 1 },
  ],
  items: [
    {
      id: 'm-1',
      title: '记忆数据放在 E 盘',
      body: '只写 E:\\dsh-data\\memory\\',
      tags: ['约束'],
      groupId: 'g-1',
      enabled: true,
      pinned: true,
      status: 'active',
      source: 'manual',
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
    {
      id: 'm-2',
      title: '模型写入需确认',
      body: '先进待确认',
      tags: [],
      groupId: 'g-1',
      enabled: true,
      pinned: false,
      status: 'pending',
      source: 'auto',
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
  ],
  tags: ['约束'],
  stats: { groups: 2, items: 2, enabled: 2, pending: 1, pinned: 1, deleted: 1 },
  deleted: [
    {
      id: 'm-9',
      title: '被删掉的旧记忆',
      body: '误删之后应该能在回收站里捞回来',
      tags: [],
      groupId: null,
      status: 'active',
      anchorMode: 'off',
      source: 'manual',
      deletedAt: '2026-10-22T01:00:00.000Z',
    },
  ],
  session: { sessionId: 'smoke', decided: false, mode: 'none', groupIds: [], itemIds: [], count: 0, groupCount: 0 },
  preview: '## 用户长期记忆\n\n- 记忆数据放在 E 盘',
  sync: {
    mode: 'off',
    remote: '',
    branch: 'main',
    username: '',
    password: '',
    autoPush: true,
    autoPull: true,
    lastSyncAt: '',
    lastSyncStatus: '',
    lastSyncError: '',
  },
  gitAvailable: true,
  updatedAt: '2026-10-22T00:00:00.000Z',
}

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  const body = init && init.body ? JSON.parse(init.body) : { op: 'state' }
  const response = body && body.op && body.op !== 'state' ? { ...snapshot, message: 'smoke ok' } : snapshot
  return { ok: true, status: 200, json: async () => response }
}

const documentStub = {
  _nodes: new Map(),
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) {
    return documentStub._nodes.get(id) || null
  },
  createElement(tag) {
    const el = { tag, id: '', textContent: '', style: {}, setAttribute() {}, appendChild() {} }
    return el
  },
  head: {
    appendChild(el) {
      if (el.id) documentStub._nodes.set(el.id, el)
    },
  },
}

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
globalThis.document = documentStub

const source = readFileSync(CLIENT, 'utf8')
new Function('window', 'document', 'fetch', source)(globalThis.window, documentStub, globalThis.fetch)

if (!definition) {
  console.error('FAIL: client.js never called window.__ModuleLoader__.load')
  process.exit(1)
}
if (definition.id !== 'dsh-memory-center') {
  fail.push(`unexpected module id: ${definition.id}`)
}

const plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

if (!plugin || typeof plugin.apply !== 'function') {
  console.error('FAIL: factory did not return { apply }')
  process.exit(1)
}

const registrations = []
const fakeCtx = {
  get: () => undefined,
  effect: () => () => {},
  on: () => () => {},
  slots: {
    inject(key, callback) {
      if (typeof key !== 'string' || !key) fail.push('slots.inject called without a slot name')
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      if (!options || !options.name) fail.push('slots.register called without options.name')
      if (typeof component !== 'function') fail.push(`slot ${options && options.name}: component is not a function`)
      return () => {}
    },
  },
}

plugin.apply(fakeCtx)

console.log(`css injected: ${documentStub._nodes.has('dsh-memory-center-css')}`)
console.log(`registrations: ${registrations.map((r) => `${r.options.name}${r.options.id ? ':' + r.options.id : ''}${r.options.key ? ':' + r.options.key : ''}`).join(', ')}`)

const expected = [
  ['sidebar.panellist', 'id', 'memory'],
  ['main', 'key', 'memory'],
  ['conversation.input.dock', 'id', 'memory-load'],
  ['conversation.input.left', 'id', 'memory-chip'],
  ['settings.section', 'id', 'memory'],
]
for (const [slot, field, value] of expected) {
  const hit = registrations.find((r) => r.options.name === slot && r.options[field] === value)
  if (!hit) fail.push(`missing registration ${slot} ${field}=${value}`)
}

// sidebar.panellist 由侧栏 PanelRow 渲染两次（宽侧栏 size=16 / 收起 size=18），
// 两种状态都要覆盖：18 应输出「记忆」文字，16 应只留占位、不出文字。
const variants = [
  { sessionId: 'smoke-session', size: 20, active: false },
  { sessionId: 'smoke-session', size: 18, active: false },
  { sessionId: 'smoke-session', size: 16, active: true },
]

// 面板的交互态（批量条 / 右键菜单）只有点了才出现，用 debug 种子把它们渲染出来。
const panelStates = [
  { label: '', props: {} },
  { label: ' batch', props: { debugSelected: ['m-1', 'm-2'] } },
  { label: ' menu-item', props: { debugMenu: { kind: 'item', id: 'm-1', x: 40, y: 60 } } },
  { label: ' menu-folder', props: { debugMenu: { kind: 'folder', id: 'g-1', x: 40, y: 60 } } },
  { label: ' pending', props: { debugFilter: '__pending' } },
  { label: ' storage', props: { debugStorage: true } },
  { label: ' sync', props: { debugSync: true } },
  { label: ' list-view', props: { debugView: 'list' } },
  { label: ' sort-updated', props: { debugSort: 'updated' } },
  { label: ' recycle', props: { debugFilter: '__deleted' } },
  {
    label: ' bulk-confirm',
    props: { debugSelected: ['m-1', 'm-9'], debugConfirm: { title: '删除选中的 2 条记忆？', message: '会先进入回收站', confirmLabel: '移入回收站', danger: true } },
  },
]

const panelStatesFor = (name) => (name === 'main' || name === 'settings.section' ? panelStates : [{ label: '', props: {} }])

for (const { options, component } of registrations) {
  const states = options.name === 'sidebar.panellist' ? variants.map((props) => ({ label: ` size=${props.size}`, props })) : panelStatesFor(options.name)
  for (const state of states) {
    const baseProps = Object.assign({ sessionId: 'smoke-session' }, state.props)
    instances = new Map()
    dirty = false
    currentTree = createElement(component, baseProps)
    const tag = state.label
    try {
      renderHost(currentTree, 'root')
      await waitForIdle()
      const html = renderHost(currentTree, 'root')
      const markers = ['记忆数据放在 E 盘', '项目约定', '待确认'].filter((m) => html.includes(m))
      console.log(`rendered ${options.name}${tag}: ok (${html.length} chars${markers.length ? '; saw ' + markers.join('/') : ''})`)
      if (process.env.DUMP === options.name) console.log(`--- ${options.name} html ---\n${html}\n--- end ---`)
      if (process.env.DUMP_TAG && tag.trim() === process.env.DUMP_TAG) console.log(`--- ${options.name}${tag} ---\n${html}\n--- end ---`)
      if (options.name === 'sidebar.panellist') {
        const hasText = html.includes('记忆')
        if (baseProps.size === 18 && !hasText) fail.push('sidebar.panellist size=18 应渲染「记忆」文字，但渲染结果为空')
        if (baseProps.size === 16 && hasText) fail.push('sidebar.panellist size=16 不应再渲染「记忆」文字（宽侧栏行内已有 label），但出现了')
      }
      if (options.name === 'main' && tag === ' batch') {
        if (!html.includes('已选 2 条')) fail.push('批量条没渲染出「已选 2 条」')
        if (!html.includes('移动到…')) fail.push('批量条缺少「移动到…」下拉')
      }
      if (options.name === 'main' && tag === ' menu-item') {
        if (!html.includes('存放到文件夹')) fail.push('条目右键菜单缺少「存放到文件夹」分组')
        if (!html.includes('停用（不再注入）')) fail.push('条目右键菜单缺少停用项')
      }
      if (options.name === 'main' && tag === ' storage') {
        if (!html.includes('记忆库存储位置')) fail.push('存储位置弹窗没渲染')
        if (!html.includes('选择')) fail.push('存储位置弹窗缺少选择目录按钮')
        if (!html.includes('复制')) fail.push('存储位置弹窗缺少复制路径按钮')
        if (!html.includes('当前生效')) fail.push('存储位置弹窗缺少「当前生效」提示')
        if (!html.includes('恢复默认')) fail.push('存储位置弹窗缺少「恢复默认」')
      }
      if (options.name === 'settings.section' && !tag.trim()) {
        if (!html.includes('同一个库')) fail.push('设置页缺少库说明行')
        if (!html.includes('更改')) fail.push('设置页缺少「更改…」按钮')
        if (!html.includes('复制')) fail.push('设置页缺少「复制」按钮')
        if (!html.includes('E:\\dsh-data\\memory') && !html.includes('E:\\')) fail.push('设置页没有显示库路径')
      }
      if (options.name === 'main' && tag === ' pending') {
        if (!html.includes('全部转正')) fail.push('待确认页签缺少「全部转正」')
        if (!html.includes('存放到…并全部转正')) fail.push('待确认页签缺少批量存放下拉')
      }
      if (options.name === 'main' && tag === ' menu-folder') {
        if (!html.includes('重命名')) fail.push('文件夹菜单缺少「重命名」')
        if (!html.includes('删除文件夹')) fail.push('文件夹菜单缺少「删除文件夹」')
      }
    } catch (error) {
      fail.push(`${options.name}${tag} render threw: ${error.message}`)
    }
  }
}

console.log(`host calls: ${calls.length}${calls.length ? ' -> ' + calls[0].url + ' ' + (calls[0].init && calls[0].init.method) : ''}`)

if (fail.length) {
  console.error('\nFAILURES:')
  for (const line of fail) console.error(' - ' + line)
  process.exit(1)
}
console.log('\nSMOKE OK')
