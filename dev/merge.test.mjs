/**
 * 合并逻辑的单元测试（纯函数，不碰磁盘、不需要 git）。
 * 跑法：node dev/merge.test.mjs
 */
import assert from 'node:assert/strict'
import { mergeStates } from '../lib/sync.js'

let passed = 0
function it(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error.message)
    process.exitCode = 1
  }
}

const item = (id, updatedAt, extra = {}) => ({
  id,
  title: id,
  body: '',
  tags: [],
  groupId: null,
  enabled: true,
  pinned: false,
  status: 'active',
  source: 'manual',
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  ...extra,
})
const store = (items, extra = {}) => ({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', groups: [], items, deleted: [], ...extra })

it('远端更新的条目会覆盖本机旧版本', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z', { body: '旧' })])
  const remote = store([item('m1', '2026-01-03T00:00:00.000Z', { body: '新' })])
  const { state, updated } = mergeStates(local, remote)
  assert.equal(updated, 1)
  assert.equal(state.items[0].body, '新')
})

it('本机更新更晚时不被远端覆盖', () => {
  const local = store([item('m1', '2026-01-05T00:00:00.000Z', { body: '本机新' })])
  const remote = store([item('m1', '2026-01-03T00:00:00.000Z', { body: '远端旧' })])
  const { state, updated } = mergeStates(local, remote)
  assert.equal(updated, 0)
  assert.equal(state.items[0].body, '本机新')
})

it('远端新增条目会并进来', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const remote = store([item('m1', '2026-01-02T00:00:00.000Z'), item('m2', '2026-01-03T00:00:00.000Z')])
  const { state, added } = mergeStates(local, remote)
  assert.equal(added, 1)
  assert.equal(state.items.length, 2)
})

it('本机的删除墓碑会压过远端的旧版本', () => {
  const local = store([], { deleted: [{ id: 'm1', at: '2026-01-04T00:00:00.000Z' }] })
  const remote = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const { state, removed } = mergeStates(local, remote)
  assert.equal(removed, 1)
  assert.equal(state.items.length, 0)
  assert.equal(state.deleted.length, 1)
})

it('远端删除（墓碑）也会传到本机', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const remote = store([], { deleted: [{ id: 'm1', at: '2026-01-05T00:00:00.000Z' }] })
  const { state, removed } = mergeStates(local, remote)
  assert.equal(removed, 1)
  assert.equal(state.items.length, 0)
})

it('删除后另一端又编辑过，则该编辑胜出（后写为准）', () => {
  const local = store([], { deleted: [{ id: 'm1', at: '2026-01-04T00:00:00.000Z' }] })
  const remote = store([item('m1', '2026-01-06T00:00:00.000Z', { body: '删除后改过' })])
  const { state, added } = mergeStates(local, remote)
  assert.equal(added, 1)
  assert.equal(state.items[0].body, '删除后改过')
})

it('文件夹取并集，冲突时以本机为准', () => {
  const local = store([], { groups: [{ id: 'g1', name: '本机名', order: 0, createdAt: '2026-01-01T00:00:00.000Z' }] })
  const remote = store([], {
    groups: [
      { id: 'g1', name: '远端名', order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'g2', name: '只有远端有', order: 1, createdAt: '2026-01-02T00:00:00.000Z' },
    ],
  })
  const { state } = mergeStates(local, remote)
  assert.equal(state.groups.length, 2)
  assert.equal(state.groups.find((group) => group.id === 'g1').name, '本机名')
})

it('条目指向的文件夹在合并后不存在时，落回未归类', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z', { groupId: 'gone' })])
  const remote = store([])
  const { state } = mergeStates(local, remote)
  assert.equal(state.items[0].groupId, null)
})

it('两边完全一致时 changed 为 false（不会天天产生提交）', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const remote = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const { changed } = mergeStates(local, remote)
  assert.equal(changed, false)
})

it('远端为空（首次同步）时保持不变', () => {
  const local = store([item('m1', '2026-01-02T00:00:00.000Z')])
  const { state, changed } = mergeStates(local, null)
  assert.equal(changed, false)
  assert.equal(state.items.length, 1)
})

console.log(`\n${passed} 项通过`)
