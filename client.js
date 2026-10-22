/**
 * dsh-memory-center — Client half.
 *
 * Registers: a sidebar panel icon + the `memory` main panel, a first-turn
 * ask card above the composer, and a compact chip on the composer tool row.
 * All data goes to the Host half through `POST /dsh-memory/api`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-center',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const PANEL_ID = 'memory'
    const API = '/dsh-memory/api'

    /* ---------------------------------------------------------------- css */

    /** 复制文本到剪贴板：优先 Clipboard API，退回 textarea 方案。返回是否成功。 */
    async function copyText(text) {
      const value = String(text || '')
      if (!value) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
        if (typeof document !== 'undefined' && document.body) {
          const area = document.createElement('textarea')
          area.value = value
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          return true
        }
      } catch {
        return false
      }
      return false
    }

    if (!document.getElementById('dsh-memory-center-css')) {
      const style = document.createElement('style')
      style.id = 'dsh-memory-center-css'
      style.textContent = `
        .dmc-root, .dmc-chip, .dmc-card, .dmc-modal, .dmc-pop { color: inherit; font-size: 13px; }
        .dmc-panel { display: flex; height: 100%; min-height: 0; overflow: hidden; }
        .dmc-panel.is-embedded { height: calc(100vh - 180px); min-height: 640px; max-height: 1200px; border: 1px solid rgba(127,127,127,.22); border-radius: 12px; }
        .dmc-nav { width: 216px; flex: 0 0 216px; border-right: 1px solid rgba(127,127,127,.22); display: flex; flex-direction: column; min-height: 0; }
        .dmc-nav-head { padding: 12px 12px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .dmc-title { font-weight: 600; font-size: 14px; }
        .dmc-nav-list { overflow: auto; padding: 4px 8px 12px; flex: 1 1 auto; min-height: 0; }
        .dmc-nav-foot { padding: 8px 12px; border-top: 1px solid rgba(127,127,127,.18); font-size: 11px; opacity: .62; line-height: 1.5; word-break: break-all; }
        .dmc-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
        .dmc-row:hover { background: rgba(127,127,127,.12); }
        .dmc-row.is-active { background: rgba(90,140,255,.16); }
        .dmc-row-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dmc-count { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
        .dmc-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
        .dmc-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(127,127,127,.18); flex-wrap: wrap; }
        .dmc-search { flex: 1 1 180px; min-width: 120px; padding: 5px 9px; border-radius: 8px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; font-size: 13px; }
        .dmc-btn { padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; cursor: pointer; font-size: 12px; line-height: 1.5; white-space: nowrap; }
        .dmc-btn:hover { background: rgba(127,127,127,.14); }
        .dmc-btn.primary { background: rgba(90,140,255,.9); border-color: transparent; color: #fff; }
        .dmc-btn.danger { color: #e5534b; border-color: rgba(229,83,75,.5); }
        .dmc-list { flex: 1 1 auto; overflow: auto; padding: 10px 14px 24px; min-height: 0; }
        .dmc-item { border: 1px solid rgba(127,127,127,.22); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
        .dmc-item.is-off { opacity: .55; }
        .dmc-item.is-pending { border-color: rgba(240,180,60,.6); }
        .dmc-item-head { display: flex; align-items: center; gap: 8px; }
        .dmc-item-title { font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dmc-item-body { margin-top: 6px; opacity: .82; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; max-height: 120px; overflow: hidden; }
        .dmc-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
        .dmc-tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.16); }
.dmc-tag.dmc-anchor-full { background: rgba(210,140,40,.22); }
.dmc-tag.dmc-anchor-weight { background: rgba(90,140,220,.20); }
        .dmc-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        .dmc-empty { opacity: .6; padding: 24px; text-align: center; }
        .dmc-error { color: #e5534b; padding: 8px 14px; font-size: 12px; }
        .dmc-ok { color: #2ea043; padding: 8px 14px; font-size: 12px; }
        .dmc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,.32); background: transparent; cursor: pointer; font-size: 12px; line-height: 1.5; }
        .dmc-chip:hover { background: rgba(127,127,127,.14); }
        .dmc-chip.on { border-color: rgba(90,140,255,.7); }
        .dmc-card { border: 1px solid rgba(90,140,255,.45); border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px; }
        .dmc-card-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .dmc-card-hint { font-size: 12px; opacity: .72; }
        .dmc-lead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px; line-height: 1.6; opacity: .92; }
        .dmc-lead-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 2px 7px; border-radius: 6px; border: 1px solid rgba(127,127,127,.3); background: rgba(127,127,127,.1); cursor: copy; user-select: all; }
        .dmc-lead-path:hover { background: rgba(127,127,127,.2); }
        .dmc-btn.is-sm { padding: 2px 8px; font-size: 11.5px; }
        .dmc-pop { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 500; width: 300px; max-height: 60vh; overflow: auto; border-radius: 12px; border: 1px solid rgba(127,127,127,.3); background: var(--dsh-popover-bg, #1f2126); color: var(--dsh-popover-fg, #e6e6e6); box-shadow: 0 12px 32px rgba(0,0,0,.32); padding: 10px; }
        .dmc-pop-wrap { position: relative; display: inline-flex; }
        .dmc-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.42); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .dmc-modal { width: min(680px, 100%); max-height: 84vh; display: flex; flex-direction: column; border-radius: 14px; background: var(--dsh-popover-bg, #1f2126); color: var(--dsh-popover-fg, #e6e6e6); border: 1px solid rgba(127,127,127,.3); box-shadow: 0 24px 60px rgba(0,0,0,.4); overflow: hidden; }
        .dmc-modal-head { padding: 12px 14px; font-weight: 600; border-bottom: 1px solid rgba(127,127,127,.2); }
        .dmc-modal-body { padding: 12px 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
        .dmc-modal-foot { padding: 10px 14px; border-top: 1px solid rgba(127,127,127,.2); display: flex; justify-content: flex-end; gap: 8px; }
        .dmc-field { display: flex; flex-direction: column; gap: 4px; }
        .dmc-field > label { font-size: 11px; opacity: .7; }
        .dmc-sync-options { display: flex; flex-direction: column; gap: 8px; }
        .dmc-sync-option {
          display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
          border: 1px solid rgba(127,127,127,.28); border-radius: 10px; padding: 10px 12px;
        }
        .dmc-sync-option:hover { border-color: rgba(127,127,127,.5); }
        .dmc-sync-option.is-active { border-color: #3b82f6; background: rgba(59,130,246,.08); }
        .dmc-sync-option input { margin-top: 3px; }
        .dmc-sync-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
        .dmc-input, .dmc-textarea, .dmc-select { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 8px; border: 1px solid rgba(127,127,127,.3); background: rgba(127,127,127,.08); color: inherit; font-size: 13px; font-family: inherit; }
        .dmc-textarea { min-height: 120px; resize: vertical; line-height: 1.6; }
        .dmc-textarea.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
        .dmc-preview { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; max-height: 46vh; overflow: auto; padding: 8px; border-radius: 8px; background: rgba(127,127,127,.1); }
        .dmc-suggest { display: flex; gap: 4px; flex-wrap: wrap; }
        .dmc-suggest .dmc-tag { cursor: pointer; }
        /* 侧栏入口：收起态用「记忆」两个字代替图标（见 SidebarGlyph 注释） */
        .dmc-glyph { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; font-size: 12px; font-weight: 600; letter-spacing: 0; line-height: 1; white-space: nowrap; color: inherit; }
        .dmc-glyph.is-active { color: inherit; }
        .dmc-glyph-spacer { display: inline-block; width: 16px; height: 16px; }
        /* 资源管理器式：面包屑 / 批量条 / 多选 / 拖放 / 右键菜单 */
        .dmc-crumbs { display: flex; align-items: center; gap: 6px; padding: 4px 2px 6px; font-size: 12px; }
        .dmc-crumb { background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; opacity: .7; }
        .dmc-crumb:hover { opacity: 1; text-decoration: underline; }
        .dmc-crumb.is-current { opacity: .95; font-weight: 600; cursor: default; }
        .dmc-crumb-sep { opacity: .4; }
        .dmc-batch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; margin: 4px 0; border-radius: 8px; background: rgba(93,140,255,.12); border: 1px solid rgba(93,140,255,.35); }
        .dmc-check { flex: 0 0 auto; margin: 0; }
        .dmc-item { position: relative; }
        .dmc-item.is-selected { border-color: rgba(93,140,255,.75); box-shadow: 0 0 0 1px rgba(93,140,255,.45) inset; }
        .dmc-item-head { align-items: center; }
        .dmc-item-head .dmc-check { margin-right: 2px; }
        .dmc-row.is-drop { outline: 2px dashed rgba(93,140,255,.8); outline-offset: -2px; background: rgba(93,140,255,.16); }
        .dmc-row-more { margin-left: auto; opacity: 0; }
        .dmc-row:hover .dmc-row-more, .dmc-row-more:focus { opacity: 1; }
        .dmc-menu { position: fixed; min-width: 176px; padding: 4px; border-radius: 10px; border: 1px solid rgba(127,127,127,.32); background: var(--dsh-popover-bg, #1f2126); color: var(--dsh-popover-fg, #e6e6e6); box-shadow: 0 14px 36px rgba(0,0,0,.36); z-index: 600; }
        .dmc-menu-item { display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; padding: 6px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
        .dmc-menu-item:hover { background: rgba(127,127,127,.18); }
        .dmc-menu-item.danger { color: #ff7a7a; }
        .dmc-menu-head { padding: 6px 8px 2px; font-size: 11px; opacity: .55; }
        .dmc-menu-sep { height: 1px; margin: 4px 6px; background: rgba(127,127,127,.25); }
        .dmc-menu .dmc-menu-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 6px 6px; }
      `
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- api */

    async function api(op, extra) {
      const payload = Object.assign({ op }, extra || {})
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        throw new Error(`记忆服务返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!data || data.ok === false) throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`)
      return data
    }

    const store = {
      data: null,
      error: null,
      message: null,
      busy: false,
      listeners: new Set(),
    }

    function emit() {
      for (const listener of [...store.listeners]) listener()
    }

    function setError(error) {
      store.error = error ? String(error.message || error) : null
      store.busy = false
      emit()
    }

    function apply(snapshot, message) {
      if (snapshot && snapshot.ok !== false && Array.isArray(snapshot.items)) {
        store.data = snapshot
      }
      store.error = null
      store.busy = false
      store.message = message || null
      emit()
    }

    async function run(op, extra, options) {
      store.busy = true
      store.error = null
      store.message = null
      emit()
      try {
        const data = await api(op, extra)
        apply(data, options && options.quiet ? null : data.message)
        return data
      } catch (error) {
        setError(error)
        return null
      }
    }

    async function refresh(sessionId) {
      try {
        const data = await api('state', { sessionId: sessionId || null })
        apply(data)
      } catch (error) {
        setError(error)
      }
    }

    function useStore() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [])
      return store
    }

    /** Session id last seen inside a conversation; the panel has no session. */
    let activeSessionId = null

    /* ------------------------------------------------------------ helpers */

    const h2 = (tag, props) => (children) => h(tag, props, children)

    function groupName(data, groupId) {
      if (!groupId) return '未归类'
      const found = data.groups.find((group) => group.id === groupId)
      return found ? found.name : '未归类'
    }

    function Modal({ title, children, footer, onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        { className: 'dmc-overlay', onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dmc-modal' },
          h('div', { className: 'dmc-modal-head' }, title),
          h('div', { className: 'dmc-modal-body' }, children),
          footer ? h('div', { className: 'dmc-modal-foot' }, footer) : null,
        ),
      )
    }

    function ItemEditor({ data, item, onClose }) {
      const [title, setTitle] = useState(item ? item.title : '')
      const [body, setBody] = useState(item ? item.body : '')
      const [tagText, setTagText] = useState(item ? item.tags.join(', ') : '')
      const [groupId, setGroupId] = useState(item ? item.groupId || '' : '')
      const [pinned, setPinned] = useState(item ? item.pinned : false)
      const [enabled, setEnabled] = useState(item ? item.enabled : true)
      const [anchorMode, setAnchorMode] = useState(item ? item.anchorMode || 'off' : 'off')

      const save = async () => {
        const tags = tagText
          .split(/[,，、]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
        const patch = { title, body, tags, groupId: groupId || null, pinned, enabled, anchorMode }
        const done = item
          ? await run('item.update', { id: item.id, patch })
          : await run('item.create', patch)
        if (done) onClose()
      }

      return h(
        Modal,
        {
          title: item ? '编辑记忆' : '新建记忆',
          onClose,
          footer: [
            h('button', { key: 'cancel', className: 'dmc-btn', onClick: onClose }, '取消'),
            h('button', { key: 'save', className: 'dmc-btn primary', onClick: save }, '保存'),
          ],
        },
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '标题'),
          h('input', { className: 'dmc-input', value: title, onChange: (event) => setTitle(event.target.value) }),
        ),
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '内容（支持换行，尽量写清楚为什么）'),
          h('textarea', { className: 'dmc-textarea', value: body, onChange: (event) => setBody(event.target.value) }),
        ),
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '标签（逗号分隔，可自定义）'),
          h('input', { className: 'dmc-input', value: tagText, onChange: (event) => setTagText(event.target.value) }),
          data.tags.length
            ? h(
                'div',
                { className: 'dmc-suggest' },
                data.tags.slice(0, 14).map((tag) =>
                  h(
                    'span',
                    {
                      key: tag,
                      className: 'dmc-tag',
                      onClick: () =>
                        setTagText((current) => {
                          const list = current
                            .split(/[,，、]/)
                            .map((entry) => entry.trim())
                            .filter(Boolean)
                          if (!list.some((entry) => entry.toLowerCase() === tag.toLowerCase())) list.push(tag)
                          return list.join(', ')
                        }),
                    },
                    tag,
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '文件夹'),
          h(
            'select',
            { className: 'dmc-select', value: groupId, onChange: (event) => setGroupId(event.target.value) },
            h('option', { value: '' }, '未归类'),
            data.groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
          ),
        ),
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '锚点（可选）'),
          h(
            'select',
            { className: 'dmc-select', value: anchorMode, onChange: (event) => setAnchorMode(event.target.value) },
            h('option', { value: 'off' }, '不启用'),
            h('option', { value: 'full' }, '完全锚点：必须完全照此执行/表达'),
            h('option', { value: 'weight' }, '仅权重：只影响措辞与优先级，可偏离'),
          ),
          h('div', { className: 'dmc-card-hint' }, '「完全」适合必须遵守的规矩；「仅权重」适合语气、偏好这类倾向。'),
        ),
        h(
          'div',
          { className: 'dmc-card-row' },
          h('label', { className: 'dmc-card-hint' }, h('input', { type: 'checkbox', checked: pinned, onChange: (event) => setPinned(event.target.checked) }), ' 置顶'),
          h('label', { className: 'dmc-card-hint' }, h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }), ' 参与注入'),
        ),
      )
    }

    function ImportDialog({ onClose }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const fileRef = useRef(null)

      const loadFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setText(await file.text())
        setPreview(null)
      }

      const doPreview = async () => {
        store.busy = true
        emit()
        try {
          const data = await api('import.preview', { payload: text })
          store.busy = false
          emit()
          setPreview(data)
        } catch (error) {
          setError(error)
        }
      }

      const doApply = async () => {
        const done = await run('import.apply', { payload: text })
        if (done) onClose()
      }

      return h(
        Modal,
        {
          title: '导入记忆',
          onClose,
          footer: [
            h('button', { key: 'cancel', className: 'dmc-btn', onClick: onClose }, '取消'),
            h('button', { key: 'preview', className: 'dmc-btn', onClick: doPreview }, '预览'),
            h('button', { key: 'apply', className: 'dmc-btn primary', disabled: !text.trim(), onClick: doApply }, '确认导入'),
          ],
        },
        h(
          'div',
          { className: 'dmc-card-hint' },
          '支持本插件导出的 JSON，也支持 { "items": [ { "title": "...", "body": "...", "tags": [], "group": "文件夹名" } ] }。按标题+内容去重。',
        ),
        h(
          'div',
          { className: 'dmc-card-row' },
          h('button', { className: 'dmc-btn', onClick: () => fileRef.current && fileRef.current.click() }, '选择文件…'),
          h('input', { ref: fileRef, type: 'file', accept: '.json,.md,.txt', style: { display: 'none' }, onChange: loadFile }),
        ),
        h('textarea', {
          className: 'dmc-textarea mono',
          placeholder: '在此粘贴 JSON…',
          value: text,
          onChange: (event) => {
            setText(event.target.value)
            setPreview(null)
          },
        }),
        preview
          ? h(
              'div',
              { className: 'dmc-preview' },
              `将新增 ${preview.willAdd} 条，跳过重复 ${preview.willSkip} 条。\n` +
                preview.sample.map((entry) => `· ${entry.title}`).join('\n'),
            )
          : null,
      )
    }

    function ExportDialog({ data, onClose }) {
      const [mode, setMode] = useState('markdown')
      const [text, setText] = useState('')
      const [loading, setLoading] = useState(true)

      useEffect(() => {
        let alive = true
        api('export', {})
          .then((result) => {
            if (!alive) return
            setText(mode === 'markdown' ? result.markdown : result.json)
            setLoading(false)
          })
          .catch((error) => alive && setError(error))
        return () => {
          alive = false
        }
      }, [mode])

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(text)
          store.message = '已复制到剪贴板'
          emit()
        } catch {
          store.error = '复制失败，请手动选择文本'
          emit()
        }
      }

      const download = () => {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = mode === 'markdown' ? 'memory-center.md' : 'memory-center.json'
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }

      return h(
        Modal,
        {
          title: '导出记忆',
          onClose,
          footer: [
            h('button', { key: 'copy', className: 'dmc-btn', onClick: copy }, '复制'),
            h('button', { key: 'dl', className: 'dmc-btn', onClick: download }, '下载'),
            h('button', { key: 'close', className: 'dmc-btn primary', onClick: onClose }, '关闭'),
          ],
        },
        h(
          'div',
          { className: 'dmc-card-row' },
          h('button', { className: mode === 'markdown' ? 'dmc-btn primary' : 'dmc-btn', onClick: () => setMode('markdown') }, 'Markdown'),
          h('button', { className: mode === 'json' ? 'dmc-btn primary' : 'dmc-btn', onClick: () => setMode('json') }, 'JSON'),
        ),
        h('div', { className: 'dmc-preview' }, loading ? '生成中…' : text),
      )
    }

    function PreviewDialog({ text, onClose }) {
      return h(
        Modal,
        { title: '本次会话将要注入的记忆', onClose, footer: [h('button', { key: 'ok', className: 'dmc-btn primary', onClick: onClose }, '关闭')] },
        text
          ? h('div', { className: 'dmc-preview' }, text)
          : h('div', { className: 'dmc-empty' }, '本次会话当前不注入任何记忆。'),
      )
    }

    function GroupDialog({ group, onClose }) {
      const [name, setName] = useState(group ? group.name : '')
      const save = async () => {
        const done = group ? await run('group.update', { id: group.id, name }) : await run('group.create', { name })
        if (done) onClose()
      }
      return h(
        Modal,
        {
          title: group ? '重命名文件夹' : '新建文件夹',
          onClose,
          footer: [
            h('button', { key: 'cancel', className: 'dmc-btn', onClick: onClose }, '取消'),
            h('button', { key: 'save', className: 'dmc-btn primary', disabled: !name.trim(), onClick: save }, '保存'),
          ],
        },
        h('input', {
          className: 'dmc-input',
          autoFocus: true,
          value: name,
          placeholder: '例如：项目约定 / 个人偏好 / 常用命令',
          onChange: (event) => setName(event.target.value),
        }),
      )
    }

    /* ------------------------------------------------------------ session */

    function SessionPicker({ data, sessionId, compact }) {
      const session = data.session || {}
      const [picking, setPicking] = useState(false)
      const [groupIds, setGroupIds] = useState(session.groupIds || [])

      useEffect(() => {
        setGroupIds(session.groupIds || [])
      }, [session.groupIds && session.groupIds.join(','), sessionId])

      const choose = (mode) => run('session.set', { sessionId, mode, groupIds })

      const status = !session.decided
        ? '未选择'
        : session.mode === 'none'
          ? '不加载'
          : `已加载 ${session.count} 条`

      // 面板/设置容器都是 overflow:hidden，弹层改成 fixed 才不会被裁掉半截。
      const [anchor, setAnchor] = useState(null)
      const wrapRef = useRef(null)

      useEffect(() => {
        if (!picking) return undefined
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setPicking(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [picking])

      const toggle = () => {
        if (!picking) {
          const node = wrapRef.current
          const rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
          if (rect && window.innerWidth) {
            const width = Math.min(320, Math.max(240, window.innerWidth - 16))
            setAnchor({
              left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
              top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 260)),
              width,
            })
          } else {
            setAnchor(null)
          }
        }
        setPicking((value) => !value)
      }
      const popStyle = anchor
        ? {
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            bottom: 'auto',
            width: anchor.width,
            maxHeight: 'min(60vh, 420px)',
            zIndex: 500,
          }
        : { bottom: 'auto', top: '100%', maxHeight: 'min(60vh, 420px)' }

      return h(
        'div',
        { className: 'dmc-card-row' },
        h(
          'div',
          { className: 'dmc-pop-wrap', ref: wrapRef },
          h(
            'button',
            { className: session.mode && session.decided ? 'dmc-chip on' : 'dmc-chip', onClick: toggle },
            `记忆 · ${status}`,
          ),
          picking
            ? h(
                'div',
                { className: 'dmc-pop', style: popStyle },
                h('div', { className: 'dmc-card-row' }, '本会话记忆'),
                h(
                  'div',
                  { className: 'dmc-actions' },
                  h('button', { className: 'dmc-btn', onClick: () => choose('none') }, '不加载'),
                  h('button', { className: 'dmc-btn', onClick: () => choose('all') }, '全部加载'),
                ),
                h('div', { className: 'dmc-field', style: { marginTop: '8px' } }, h('label', null, '按文件夹加载')),
                ...data.groups.map((group) =>
                  h(
                    'label',
                    { key: group.id, className: 'dmc-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: groupIds.includes(group.id),
                      onChange: (event) => {
                        const next = event.target.checked
                          ? [...groupIds, group.id]
                          : groupIds.filter((id) => id !== group.id)
                        setGroupIds(next)
                      },
                    }),
                    h('span', { className: 'dmc-row-name' }, group.name),
                    h('span', { className: 'dmc-count' }, String(data.items.filter((item) => item.groupId === group.id && item.status === 'active').length)),
                  ),
                ),
                h(
                  'div',
                  { className: 'dmc-actions' },
                  h('button', { className: 'dmc-btn primary', onClick: () => run('session.set', { sessionId, mode: 'custom', groupIds }) }, '应用'),
                ),
              )
            : null,
        ),
        compact
          ? null
          : h(
              'span',
              { className: 'dmc-card-hint' },
              session.decided ? `已选 ${session.groupCount} 个文件夹` : '选择本会话是否加载记忆',
            ),
      )
    }

    /* -------------------------------------------------------------- slots */

    /**
     * 侧栏「记忆」入口。
     *
     * 侧栏每个面板行由 SidebarRoot 的 PanelRow 渲染（见 dsh-client-ui-sidebar）：
     *   renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })
     * 宽侧栏时该行自己会画出 label 文字（「记忆」），所以这里只保留一个 16px 占位，
     * 避免出现「记忆 记忆」；收起成竖栏时行内没有文字，就用「记忆」两个字当图标。
     */
    function SidebarIcon(props) {
      const active = props && props.active
      const wide = (props && props.size) === 16
      if (wide) return h('span', { className: 'dmc-glyph-spacer', 'aria-hidden': 'true' })
      return h(
        'span',
        { className: active ? 'dmc-glyph is-active' : 'dmc-glyph', 'aria-hidden': 'true' },
        '记忆',
      )
    }

    /** 存储位置：给用户自己选记忆库放哪（支持系统目录选择器）。 */
    function StorageDialog({ dataDir, onClose, onDone }) {
      const [dir, setDir] = useState(dataDir || '')
      const [move, setMove] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [info, setInfo] = useState(null)
      const [copied, setCopied] = useState(false)

      useEffect(() => {
        let alive = true
        api('config.get')
          .then((result) => {
            if (!alive || !result) return
            setInfo(result)
            if (result.dataDir) setDir(result.dataDir)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      const pick = async () => {
        const workspace = panelCtx && panelCtx.uiWorkspace
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setError('当前环境没有目录选择器，请手动填写绝对路径')
          return
        }
        try {
          const picked = await workspace.pickDirectory()
          if (picked) setDir(picked)
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        }
      }

      const apply = async () => {
        setBusy(true)
        setError(null)
        try {
          await api('config.set', { dir: dir.trim(), move })
          setBusy(false)
          if (onDone) onDone()
          onClose()
        } catch (cause) {
          setBusy(false)
          setError(cause && cause.message ? cause.message : String(cause))
        }
      }

      const copy = async () => {
        const text = String(dir || (info && info.dataDir) || '').trim()
        if (!text) return
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
          } else if (typeof document !== 'undefined' && document.body) {
            const area = document.createElement('textarea')
            area.value = text
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
          } else {
            throw new Error('当前环境不支持剪贴板')
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch (cause) {
          setError(`复制失败：${cause && cause.message ? cause.message : String(cause)}`)
        }
      }

      return h(
        'div',
        {
          className: 'dmc-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'dmc-modal', style: { width: 'min(560px, 100%)' } },
          h('div', { className: 'dmc-modal-head' }, '记忆库存储位置'),
          h(
            'div',
            { className: 'dmc-modal-body' },
            info && info.envLocked
              ? h('div', { className: 'dmc-card-hint' }, '注意：数据目录已被环境变量 DSH_MEMORY_DIR 固定，面板里改不了。')
              : null,
            h(
              'div',
              { className: 'dmc-field' },
              h('label', null, '路径（可直接编辑，改完点「应用」生效）'),
              h(
                'div',
                { className: 'dmc-card-row', style: { gap: '6px', flexWrap: 'nowrap' } },
                h('input', {
                  className: 'dmc-input',
                  value: dir,
                  spellCheck: false,
                  readOnly: !!(info && info.envLocked),
                  placeholder: '例如 E:\\my-memory',
                  style: { flex: '1 1 auto', minWidth: '0' },
                  onChange: (event) => setDir(event.target.value),
                  onDoubleClick: (event) => {
                    if (event.target && event.target.select) event.target.select()
                  },
                }),
                h('button', { className: 'dmc-btn', onClick: copy, title: '复制这个路径' }, copied ? '已复制' : '复制'),
                h(
                  'button',
                  { className: 'dmc-btn', onClick: pick, title: '用系统对话框选一个文件夹', disabled: !!(info && info.envLocked) },
                  '选择…',
                ),
              ),
              h(
                'div',
                { className: 'dmc-actions' },
                h(
                  'button',
                  {
                    className: 'dmc-btn',
                    title: info && info.defaultDir ? `默认目录：${info.defaultDir}` : '默认目录暂不可用',
                    onClick: () => {
                      if (info && info.defaultDir) setDir(info.defaultDir)
                    },
                  },
                  '恢复默认',
                ),
                h('span', { className: 'dmc-card-hint' }, '双击输入框可全选，方便复制。'),
              ),
              h(
                'div',
                { className: 'dmc-card-hint', style: { lineHeight: '1.7' } },
                `当前生效：${(info && info.dataDir) || dataDir || '未知'}`,
              ),
            ),
            h(
              'div',
              { className: 'dmc-actions' },
              h(
                'label',
                { className: 'dmc-card-row', style: { gap: '6px' } },
                h('input', { type: 'checkbox', checked: move, onChange: (event) => setMove(event.target.checked) }),
                h('span', { className: 'dmc-card-hint' }, '把现有记忆复制到新目录'),
              ),
            ),
            error ? h('div', { className: 'dmc-error', style: { padding: '0' } }, error) : null,
            h(
              'div',
              { className: 'dmc-card-hint', style: { lineHeight: '1.7' } },
              '切换后立即生效并记住；原目录里的文件不会自动删除，需要的话你自己清理。',
            ),
          ),
          h(
            'div',
            { className: 'dmc-modal-foot' },
            h('button', { className: 'dmc-btn', onClick: onClose }, '取消'),
            h('button', { className: 'dmc-btn primary', onClick: apply, disabled: busy }, busy ? '切换中…' : '应用'),
          ),
        ),
      )
    }

    function SyncDialog({ syncInfo, dataDir, gitAvailable, onClose, onDone }) {
      const info = syncInfo || {}
      const [mode, setMode] = useState(info.mode || 'off')
      const [remote, setRemote] = useState(info.remote || '')
      const [branch, setBranch] = useState(info.branch || 'main')
      const [username, setUsername] = useState(info.username || '')
      const [password, setPassword] = useState(info.password || '')
      const [autoPull, setAutoPull] = useState(info.autoPull !== false)
      const [autoPush, setAutoPush] = useState(info.autoPush !== false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)

      const options = [
        {
          key: 'off',
          title: '不绑定云端',
          hint: '记忆只在这台机器上。换设备看不到，但也不会有任何数据外发。',
        },
        {
          key: 'git',
          title: 'Git 仓库',
          hint: '推到你自己的私有仓库（GitHub / Gitee / 自建）。有完整历史，可回滚，换设备 pull 一次就全回来。',
        },
        {
          key: 'webdav',
          title: 'WebDAV 网盘',
          hint: '坚果云 / Nextcloud / 群晖都行。只有一个 store.json，没有历史版本，但最省事。',
        },
      ]

      const run = async (action, payload) => {
        setBusy(true)
        setError(null)
        try {
          const outcome = await action(payload)
          setBusy(false)
          setResult((outcome && outcome.message) || '完成')
          if (onDone) onDone()
        } catch (cause) {
          setBusy(false)
          setError(cause && cause.message ? cause.message : String(cause))
        }
      }

      const save = () =>
        run((payload) => api('sync.set', payload), {
          patch: { mode, remote: remote.trim(), branch: branch.trim() || 'main', username, password, autoPull, autoPush },
        })

      const syncNow = () => run(() => api('sync.now'))

      return h(
        'div',
        {
          className: 'dmc-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'dmc-modal', style: { width: 'min(620px, 100%)' } },
          h('div', { className: 'dmc-modal-head' }, '云端同步（可选）'),
          h(
            'div',
            { className: 'dmc-modal-body' },
            h(
              'div',
              { className: 'dmc-card-hint', style: { lineHeight: '1.7' } },
              `记忆本体永远在这台机器上（${(dataDir || info.dataDir || '本机目录')}）。云端只是「多设备共用同一份」，不绑定也完全能用。`,
            ),
            h(
              'div',
              { className: 'dmc-sync-options' },
              options.map((option) =>
                h(
                  'label',
                  {
                    key: option.key,
                    className: `dmc-sync-option${mode === option.key ? ' is-active' : ''}`,
                  },
                  h('input', {
                    type: 'radio',
                    name: 'dmc-sync-mode',
                    checked: mode === option.key,
                    onChange: () => setMode(option.key),
                  }),
                  h(
                    'div',
                    null,
                    h('div', { className: 'dmc-sync-title' }, option.title),
                    h('div', { className: 'dmc-card-hint' }, option.hint),
                  ),
                ),
              ),
            ),
            mode === 'git'
              ? h(
                  'div',
                  { className: 'dmc-field' },
                  h('label', null, '仓库地址（可以是你自己的私有仓库）'),
                  h('input', {
                    className: 'dmc-input',
                    value: remote,
                    spellCheck: false,
                    placeholder: 'https://github.com/你的账号/memory.git',
                    onChange: (event) => setRemote(event.target.value),
                  }),
                  h('label', null, '分支'),
                  h('input', {
                    className: 'dmc-input',
                    value: branch,
                    spellCheck: false,
                    placeholder: 'main',
                    onChange: (event) => setBranch(event.target.value),
                  }),
                  gitAvailable === false
                    ? h('div', { className: 'dmc-error', style: { padding: '0' } }, '这台机器上没有找到 git，先装 Git 再选这个。')
                    : h('div', { className: 'dmc-card-hint' }, '推送用系统里已登录的 Git 凭据（GitHub 可以用「个人访问令牌」当密码）。'),
                )
              : null,
            mode === 'webdav'
              ? h(
                  'div',
                  { className: 'dmc-field' },
                  h('label', null, 'WebDAV 目录地址（末尾不要带 store.json）'),
                  h('input', {
                    className: 'dmc-input',
                    value: remote,
                    spellCheck: false,
                    placeholder: 'https://dav.jianguoyun.com/dav/记忆',
                    onChange: (event) => setRemote(event.target.value),
                  }),
                  h('label', null, '账号'),
                  h('input', {
                    className: 'dmc-input',
                    value: username,
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: (event) => setUsername(event.target.value),
                  }),
                  h('label', null, '密码 / 应用密码'),
                  h('input', {
                    className: 'dmc-input',
                    type: 'password',
                    value: password,
                    autoComplete: 'new-password',
                    onChange: (event) => setPassword(event.target.value),
                  }),
                  h('div', { className: 'dmc-card-hint' }, '账号密码会存在本机 config.json 里（明文）。坚果云要去「安全选项」生成应用密码。'),
                )
              : null,
            mode !== 'off'
              ? h(
                  'div',
                  { className: 'dmc-actions' },
                  h(
                    'label',
                    { className: 'dmc-card-row', style: { gap: '6px' } },
                    h('input', { type: 'checkbox', checked: autoPull, onChange: (event) => setAutoPull(event.target.checked) }),
                    h('span', { className: 'dmc-card-hint' }, '打开面板时自动拉取'),
                  ),
                  h(
                    'label',
                    { className: 'dmc-card-row', style: { gap: '6px' } },
                    h('input', { type: 'checkbox', checked: autoPush, onChange: (event) => setAutoPush(event.target.checked) }),
                    h('span', { className: 'dmc-card-hint' }, '改动后自动上传' ),
                  ),
                )
              : null,
            error ? h('div', { className: 'dmc-error', style: { padding: '0' } }, error) : null,
            result ? h('div', { className: 'dmc-ok', style: { padding: '0' } }, result) : null,
            info.lastSyncAt
              ? h(
                  'div',
                  { className: 'dmc-card-hint' },
                  `上次同步：${new Date(info.lastSyncAt).toLocaleString('zh-CN')}${info.lastSyncStatus ? `（${info.lastSyncStatus}）` : ''}${
                    info.lastSyncError ? ` 错误：${info.lastSyncError}` : ''
                  }`,
                )
              : null,
          ),
          h(
            'div',
            { className: 'dmc-modal-foot' },
            h('button', { className: 'dmc-btn', onClick: onClose }, '关闭'),
            mode !== 'off' ? h('button', { className: 'dmc-btn', onClick: syncNow, disabled: busy }, busy ? '同步中…' : '立即同步') : null,
            h('button', { className: 'dmc-btn primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    function MemoryPanel(props) {
      const state = useStore()
      const data = state.data
      const embedded = !!(props && props.embedded)
      const panelClass = embedded ? 'dmc-panel is-embedded' : 'dmc-panel'
      const [filter, setFilter] = useState((props && props.debugFilter) || '__all')
      const [query, setQuery] = useState('')
      const [editing, setEditing] = useState(null)
      const [creating, setCreating] = useState(false)
      const [importing, setImporting] = useState(false)
      const [exporting, setExporting] = useState(false)
      const [groupDialog, setGroupDialog] = useState(null)
      const [preview, setPreview] = useState(null)
      const [selected, setSelected] = useState((props && props.debugSelected) || [])
      const [menu, setMenu] = useState((props && props.debugMenu) || null)
      const [dragIds, setDragIds] = useState([])
      const [dropKey, setDropKey] = useState(null)
      const [storageOpen, setStorageOpen] = useState((props && props.debugStorage) || false)
      const [syncOpen, setSyncOpen] = useState((props && props.debugSync) || false)

      useEffect(() => {
        refresh(activeSessionId)
      }, [])

      if (!data) {
        return h(
          'div',
          { className: panelClass },
          h('div', { className: 'dmc-empty' }, state.error ? `加载失败：${state.error}` : '正在加载记忆…'),
        )
      }

      const pendingCount = data.stats.pending
      const filtered = data.items.filter((item) => {
        if (filter === '__pending' && item.status !== 'pending') return false
        if (filter === '__ungrouped' && item.groupId) return false
        if (filter !== '__all' && filter !== '__pending' && filter !== '__ungrouped' && item.groupId !== filter) return false
        if (query.trim()) {
          const haystack = `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase()
          if (!haystack.includes(query.trim().toLowerCase())) return false
        }
        return true
      })

      const pendingItems = data.items.filter((item) => item.status === 'pending')

      const currentName =
        filter === '__all'
          ? '全部记忆'
          : filter === '__pending'
            ? '待确认'
            : filter === '__ungrouped'
              ? '未归类'
              : (data.groups.find((group) => group.id === filter) || {}).name || '全部记忆'

      const toggleSelect = (id) =>
        setSelected((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]))
      const clearSelect = () => setSelected([])
      const moveTo = async (ids, groupId) => {
        if (!ids || !ids.length) return
        await run('item.move', { ids, groupId: groupId || null })
        clearSelect()
      }
      const batchPatch = async (ids, patch) => {
        await run('item.batch', { ids, patch })
        clearSelect()
      }
      const openMenu = (event, kind, id) => {
        if (event && event.preventDefault) event.preventDefault()
        if (event && event.stopPropagation) event.stopPropagation()
        const x = event && typeof event.clientX === 'number' ? event.clientX : 80
        const y = event && typeof event.clientY === 'number' ? event.clientY : 120
        setMenu({ kind, id, x, y })
      }
      const openMenuAtButton = (event, kind, id) => {
        if (event && event.stopPropagation) event.stopPropagation()
        if (event && event.preventDefault) event.preventDefault()
        const rect = event && event.currentTarget && event.currentTarget.getBoundingClientRect
          ? event.currentTarget.getBoundingClientRect()
          : null
        setMenu({ kind, id, x: rect ? rect.left : 80, y: rect ? rect.bottom + 4 : 120 })
      }

      const navRow = (key, label, count, dropGroupId, extra) =>
        h(
          'div',
          {
            key,
            className: `dmc-row${filter === key ? ' is-active' : ''}${dropKey === key ? ' is-drop' : ''}`,
            onClick: () => {
              setFilter(key)
              clearSelect()
            },
            onDragOver:
              dropGroupId === undefined
                ? undefined
                : (event) => {
                    event.preventDefault()
                    setDropKey(key)
                  },
            onDragLeave: dropGroupId === undefined ? undefined : () => setDropKey((value) => (value === key ? null : value)),
            onDrop:
              dropGroupId === undefined
                ? undefined
                : async (event) => {
                    event.preventDefault()
                    setDropKey(null)
                    await moveTo(dragIds, dropGroupId)
                  },
          },
          h('span', { className: 'dmc-row-name' }, label),
          typeof count === 'number' ? h('span', { className: 'dmc-count' }, String(count)) : null,
          extra || null,
        )

      // 资源管理器式的右键/「…」菜单：文件夹与条目的全部动作都收在这里，行上不再挤按钮。
      const menuNode = () => {
        if (!menu) return null
        const close = () => setMenu(null)
        const at = (x, y) => {
          const width = 208
          const height = menu.kind === 'item' ? 340 : 230
          const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
          const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
          return { left: Math.max(8, Math.min(x, vw - width - 8)), top: Math.max(8, Math.min(y, vh - height - 8)) }
        }
        const spot = at(menu.x, menu.y)
        const item = menu.kind === 'item' ? data.items.find((entry) => entry.id === menu.id) : null
        const group = menu.kind === 'folder' ? data.groups.find((entry) => entry.id === menu.id) : null
        if (!item && !group) return null
        const act = async (fn) => {
          close()
          await fn()
        }
        const row = (label, handler, danger) =>
          h(
            'button',
            { key: label, className: danger ? 'dmc-menu-item danger' : 'dmc-menu-item', onClick: () => act(handler) },
            label,
          )
        const body =
          menu.kind === 'folder'
            ? [
                h('div', { key: 'head', className: 'dmc-menu-head' }, group.name),
                activeSessionId
                  ? row('带入本会话（整组）', () => run('session.add', { sessionId: activeSessionId, groupIds: [group.id] }))
                  : null,
                row('重命名', () => setGroupDialog({ mode: 'rename', group })),
                row('上移', () => run('group.move', { id: group.id, delta: -1 })),
                row('下移', () => run('group.move', { id: group.id, delta: 1 })),
                h('div', { key: 'sep', className: 'dmc-menu-sep' }),
                row(
                  '删除文件夹',
                  async () => {
                    const deleteItems = window.confirm(
                      `删除文件夹「${group.name}」？\n\n确定 = 连同文件夹里的记忆一起删除\n取消 = 只删文件夹，记忆移到未归类`,
                    )
                    const done = await run('group.delete', { id: group.id, mode: deleteItems ? 'delete' : 'keep' })
                    if (done && filter === group.id) setFilter('__all')
                  },
                  true,
                ),
              ]
            : [
                h('div', { key: 'head', className: 'dmc-menu-head' }, item.title.slice(0, 24)),
                row('编辑', () => setEditing(item)),
                row(item.pinned ? '取消置顶' : '置顶', () => run('item.update', { id: item.id, patch: { pinned: !item.pinned } })),
                row(item.enabled ? '停用（不再注入）' : '启用', () => run('item.update', { id: item.id, patch: { enabled: !item.enabled } })),
                row('复制一份', () => run('item.duplicate', { id: item.id })),
                item.status === 'pending' ? row('转正', () => run('item.confirm', { ids: [item.id] })) : null,
                activeSessionId ? row('加入本会话', () => run('session.add', { sessionId: activeSessionId, itemIds: [item.id] })) : null,
                h('div', { key: 'move-head', className: 'dmc-menu-head' }, '存放到文件夹'),
                ...data.groups.map((target) =>
                  h(
                    'button',
                    {
                      key: `move-${target.id}`,
                      className: 'dmc-menu-item',
                      onClick: () => act(() => run('item.move', { ids: [item.id], groupId: target.id })),
                    },
                    `${item.groupId === target.id ? '✓ ' : ''}${target.name}`,
                  ),
                ),
                h(
                  'button',
                  {
                    key: 'move-none',
                    className: 'dmc-menu-item',
                    onClick: () => act(() => run('item.move', { ids: [item.id], groupId: null })),
                  },
                  `${item.groupId ? '' : '✓ '}未归类`,
                ),
                h('div', { key: 'sep', className: 'dmc-menu-sep' }),
                row(
                  '删除',
                  async () => {
                    if (window.confirm(`删除记忆「${item.title}」？`)) await run('item.delete', { ids: [item.id] })
                  },
                  true,
                ),
              ]
        return h(
          'div',
          {
            key: 'menu-backdrop',
            style: { position: 'fixed', inset: 0, zIndex: 599 },
            onClick: close,
            onContextMenu: (event) => {
              event.preventDefault()
              close()
            },
          },
          h(
            'div',
            { className: 'dmc-menu', style: { left: `${spot.left}px`, top: `${spot.top}px` }, onClick: (event) => event.stopPropagation() },
            ...body,
          ),
        )
      }

      return h(
        'div',
        { className: panelClass },
        h(
          'div',
          { className: 'dmc-nav' },
          h(
            'div',
            { className: 'dmc-nav-head' },
            h('span', { className: 'dmc-title' }, '记忆'),
            h('button', { className: 'dmc-btn', onClick: () => setGroupDialog({ mode: 'create' }) }, '+ 文件夹'),
          ),
          h(
            'div',
            { className: 'dmc-nav-list' },
            navRow('__all', '全部记忆', data.stats.items),
            navRow('__pending', '待确认', pendingCount),
            navRow('__ungrouped', '未归类', data.items.filter((item) => !item.groupId && item.status === 'active').length, null),
            h('div', { className: 'dmc-nav-head' }, h('span', { className: 'dmc-card-hint' }, '文件夹')),
            ...data.groups.map((group) =>
              h(
                'div',
                {
                  key: group.id,
                  className: `dmc-row${filter === group.id ? ' is-active' : ''}${dropKey === group.id ? ' is-drop' : ''}`,
                  onClick: () => {
                    setFilter(group.id)
                    clearSelect()
                  },
                  onDoubleClick: () => setFilter(group.id),
                  onContextMenu: (event) => openMenu(event, 'folder', group.id),
                  onDragOver: (event) => {
                    event.preventDefault()
                    setDropKey(group.id)
                  },
                  onDragLeave: () => setDropKey((value) => (value === group.id ? null : value)),
                  onDrop: async (event) => {
                    event.preventDefault()
                    setDropKey(null)
                    await moveTo(dragIds, group.id)
                  },
                },
                h('span', { className: 'dmc-row-name' }, group.name),
                h(
                  'span',
                  { className: 'dmc-count' },
                  String(data.items.filter((item) => item.groupId === group.id && item.status === 'active').length),
                ),
                h(
                  'button',
                  {
                    className: 'dmc-btn dmc-row-more',
                    title: '更多（带入本会话 / 重命名 / 排序 / 删除）',
                    onClick: (event) => openMenuAtButton(event, 'folder', group.id),
                  },
                  '…',
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dmc-nav-foot' },
            h('div', null, `共 ${data.stats.items} 条 · 参与注入 ${data.stats.enabled} 条 · 待确认 ${pendingCount} 条`),
          ),
        ),
        h(
          'div',
          { className: 'dmc-main' },
          h(
            'div',
            { className: 'dmc-toolbar' },
            h('input', {
              className: 'dmc-search',
              placeholder: '搜索标题 / 内容 / 标签…',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('button', { className: 'dmc-btn primary', onClick: () => setCreating(true) }, '+ 新建记忆'),
            h('button', { className: 'dmc-btn', onClick: () => setImporting(true) }, '导入'),
            h('button', { className: 'dmc-btn', onClick: () => setExporting(true) }, '导出'),
            h('button', { className: 'dmc-btn', onClick: () => setPreview(data.preview) }, '预览注入'),
            h('button', { className: 'dmc-btn', onClick: () => setStorageOpen(true) }, '存储位置'),
            h(
              'button',
              {
                className: 'dmc-btn',
                title: '可选：把记忆同步到你自己的 Git 仓库或网盘',
                onClick: () => setSyncOpen(true),
              },
              data.sync && data.sync.mode && data.sync.mode !== 'off' ? '云端同步 · 已开' : '云端同步',
            ),
            embedded
              ? null
              : h('button', { className: 'dmc-btn', onClick: () => openPanel(null) }, '返回对话'),
          ),
          state.error ? h('div', { className: 'dmc-error' }, state.error) : null,
          state.message ? h('div', { className: 'dmc-ok' }, state.message) : null,
          activeSessionId
            ? h(
                'div',
                { className: 'dmc-toolbar' },
                h('span', { className: 'dmc-card-hint' }, `当前会话 #${String(activeSessionId).replace(/^session-/, '').slice(0, 8)}：`),
                h(SessionPicker, { data, sessionId: activeSessionId, compact: false }),
              )
            : h('div', { className: 'dmc-toolbar' }, h('span', { className: 'dmc-card-hint' }, '先在对话里打开一个会话，才能决定本会话加载哪些记忆。')),
          h(
            'div',
            { className: 'dmc-crumbs' },
            h(
              'button',
              {
                className: 'dmc-crumb',
                onClick: () => {
                  setFilter('__all')
                  clearSelect()
                },
              },
              '记忆',
            ),
            h('span', { className: 'dmc-crumb-sep' }, '›'),
            h('span', { className: 'dmc-crumb is-current' }, currentName),
            h('span', { className: 'dmc-card-hint', style: { marginLeft: 'auto' } }, `${filtered.length} 条`),
          ),
          filter === '__pending' && pendingItems.length
            ? h(
                'div',
                { className: 'dmc-batch' },
                h('strong', null, `待确认 ${pendingItems.length} 条`),
                h('button', {
                  className: 'dmc-btn primary',
                  onClick: async () => {
                    await run('item.confirm', { ids: pendingItems.map((item) => item.id) })
                  },
                }, '全部转正'),
                h(
                  'select',
                  {
                    className: 'dmc-select',
                    style: { width: 'auto' },
                    value: '',
                    onChange: async (event) => {
                      const target = event.target.value
                      event.target.value = ''
                      if (!target) return
                      const ids = pendingItems.map((item) => item.id)
                      await run('item.move', { ids, groupId: target === '__none' ? null : target })
                      await run('item.confirm', { ids })
                    },
                  },
                  h('option', { value: '' }, '存放到…并全部转正'),
                  h('option', { value: '__none' }, '未归类'),
                  ...data.groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
                ),
                h('button', {
                  className: 'dmc-btn danger',
                  onClick: async () => {
                    if (!window.confirm(`删除全部 ${pendingItems.length} 条待确认记忆？`)) return
                    await run('item.delete', { ids: pendingItems.map((item) => item.id) })
                  },
                }, '全部删除'),
                h('span', { className: 'dmc-card-hint' }, '待确认的记忆不会参与注入，转正后才生效。'),
              )
            : null,
          selected.length
            ? h(
                'div',
                { className: 'dmc-batch' },
                h('strong', null, `已选 ${selected.length} 条`),
                h(
                  'select',
                  {
                    className: 'dmc-select',
                    style: { width: 'auto' },
                    value: '',
                    onChange: (event) => {
                      if (!event.target.value) return
                      moveTo(selected, event.target.value === '__none' ? null : event.target.value)
                      event.target.value = ''
                    },
                  },
                  h('option', { value: '' }, '移动到…'),
                  h('option', { value: '__none' }, '未归类'),
                  ...data.groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
                ),
                h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { enabled: false }) }, '停用'),
                h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { enabled: true }) }, '启用'),
                h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { pinned: true }) }, '置顶'),
                selected.some((id) => (data.items.find((item) => item.id === id) || {}).status === 'pending')
                  ? h(
                      'button',
                      {
                        className: 'dmc-btn primary',
                        onClick: async () => {
                          await run('item.confirm', { ids: selected })
                          clearSelect()
                        },
                      },
                      '转正',
                    )
                  : null,
                activeSessionId
                  ? h(
                      'button',
                      {
                        className: 'dmc-btn',
                        onClick: async () => {
                          await run('session.add', { sessionId: activeSessionId, itemIds: selected })
                          clearSelect()
                        },
                      },
                      '加入本会话',
                    )
                  : null,
                h(
                  'button',
                  {
                    className: 'dmc-btn danger',
                    onClick: async () => {
                      if (!window.confirm(`删除选中的 ${selected.length} 条记忆？`)) return
                      await run('item.delete', { ids: selected })
                      clearSelect()
                    },
                  },
                  '删除',
                ),
                h('button', { className: 'dmc-btn', onClick: clearSelect }, '取消'),
              )
            : null,
          h(
            'div',
            { className: 'dmc-list' },
            filtered.length
              ? h(
                  'div',
                  { className: 'dmc-card-row', style: { marginBottom: '6px' } },
                  h('input', {
                    type: 'checkbox',
                    className: 'dmc-check',
                    checked: selected.length > 0 && selected.length === filtered.length,
                    onChange: (event) => (event.target.checked ? setSelected(filtered.map((item) => item.id)) : clearSelect()),
                  }),
                  h('span', { className: 'dmc-card-hint' }, '全选'),
                  h('span', { className: 'dmc-card-hint' }, '（勾选后可批量移动 / 停用 / 删除，也可以直接把卡片拖到左侧文件夹）'),
                )
              : null,
            filtered.length
              ? filtered.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      className: `dmc-item${item.enabled ? '' : ' is-off'}${item.status === 'pending' ? ' is-pending' : ''}${selected.includes(item.id) ? ' is-selected' : ''}`,
                      draggable: true,
                      onDragStart: (event) => {
                        const ids = selected.includes(item.id) ? selected : [item.id]
                        setDragIds(ids)
                        if (event.dataTransfer) {
                          event.dataTransfer.setData('text/plain', ids.join(','))
                          event.dataTransfer.effectAllowed = 'move'
                        }
                      },
                      onDragEnd: () => setDragIds([]),
                      onContextMenu: (event) => openMenu(event, 'item', item.id),
                    },
                    h(
                      'div',
                      { className: 'dmc-item-head' },
                      h('input', {
                        type: 'checkbox',
                        className: 'dmc-check',
                        checked: selected.includes(item.id),
                        onChange: () => toggleSelect(item.id),
                      }),
                      h('span', { className: 'dmc-item-title' }, `${item.pinned ? '📌 ' : ''}${item.title}`),
                      h('span', { className: 'dmc-tag' }, groupName(data, item.groupId)),
                      item.status === 'pending' ? h('span', { className: 'dmc-tag' }, '待确认') : null,
                      item.anchorMode === 'full'
                        ? h('span', { className: 'dmc-tag dmc-anchor-full' }, '完全锚点')
                        : item.anchorMode === 'weight'
                          ? h('span', { className: 'dmc-tag dmc-anchor-weight' }, '权重锚点')
                          : null,
                      h('span', { className: 'dmc-tag' }, item.source === 'auto' ? '模型写入' : item.source === 'import' ? '导入' : '手动'),
                    ),
                    item.tags.length ? h('div', { className: 'dmc-tags' }, item.tags.map((tag) => h('span', { key: tag, className: 'dmc-tag' }, tag))) : null,
                    h('div', { className: 'dmc-item-body' }, item.body),
                    h(
                      'div',
                      { className: 'dmc-actions' },
                      item.status === 'pending'
                        ? h('button', { className: 'dmc-btn primary', onClick: () => run('item.confirm', { ids: [item.id] }) }, '转正')
                        : null,
                      h('button', { className: 'dmc-btn', onClick: () => setEditing(item) }, '编辑'),
                      h(
                        'button',
                        { className: 'dmc-btn', onClick: (event) => openMenuAtButton(event, 'item', item.id) },
                        '更多…',
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'dmc-empty' }, query ? '没有匹配的记忆' : '这里还是空的，点「+ 新建记忆」或「导入」。'),
          ),
        ),
        menu ? menuNode() : null,
        storageOpen
          ? h(StorageDialog, {
              dataDir: data.dataDir,
              onClose: () => setStorageOpen(false),
              onDone: () => refresh(activeSessionId),
            })
          : null,
        syncOpen
          ? h(SyncDialog, {
              syncInfo: data.sync,
              dataDir: data.dataDir,
              gitAvailable: data.gitAvailable,
              onClose: () => setSyncOpen(false),
              onDone: () => refresh(activeSessionId),
            })
          : null,
        creating ? h(ItemEditor, { data, item: null, onClose: () => setCreating(false) }) : null,
        editing ? h(ItemEditor, { data, item: editing, onClose: () => setEditing(null) }) : null,
        importing ? h(ImportDialog, { onClose: () => setImporting(false) }) : null,
        exporting ? h(ExportDialog, { data, onClose: () => setExporting(false) }) : null,
        preview !== null ? h(PreviewDialog, { text: preview, onClose: () => setPreview(null) }) : null,
        groupDialog
          ? h(GroupDialog, {
              group: groupDialog.group || null,
              onClose: () => setGroupDialog(null),
            })
          : null,
      )
    }

    /** 文件夹选择弹层：一下点中整个文件夹，不用一条条勾。 */
    function FolderPicker({ onClose }) {
      const state = useStore()
      const data = state.data
      const sessionId = activeSessionId
      const items = (data && data.items) || []
      const folders = (data && data.groups) || []
      const activeCount = (groupId) =>
        items.filter((item) => item.groupId === groupId && item.status === 'active' && item.enabled).length
      const load = async (groupId) => {
        if (!sessionId) return
        if (groupId === null) {
          const ids = items
            .filter((item) => !item.groupId && item.status === 'active' && item.enabled)
            .map((item) => item.id)
          await run('session.set', { sessionId, mode: ids.length ? 'custom' : 'none', groupIds: [], itemIds: ids })
        } else {
          await run('session.set', { sessionId, mode: 'custom', groupIds: [groupId], itemIds: [] })
        }
        onClose()
      }
      return h(
        'div',
        {
          className: 'dmc-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'dmc-modal', style: { width: 'min(520px, 100%)' } },
          h('div', { className: 'dmc-modal-head' }, '选一个文件夹加载'),
          h(
            'div',
            { className: 'dmc-modal-body' },
            h(
              'div',
              { className: 'dmc-card-hint' },
              '点一下 = 这个文件夹里的记忆全部加入本会话（下一轮生效）。之后还能在输入框的「记忆」里改。',
            ),
            h(
              'div',
              { className: 'dmc-actions', style: { flexDirection: 'column', alignItems: 'stretch' } },
              ...folders.map((folder) =>
                h(
                  'button',
                  { key: folder.id, className: 'dmc-btn', style: { textAlign: 'left' }, onClick: () => load(folder.id) },
                  `${folder.name} · ${activeCount(folder.id)} 条`,
                ),
              ),
              h(
                'button',
                { className: 'dmc-btn', style: { textAlign: 'left' }, onClick: () => load(null) },
                `未归类 · ${activeCount(null)} 条`,
              ),
            ),
          ),
          h('div', { className: 'dmc-modal-foot' }, h('button', { className: 'dmc-btn', onClick: onClose }, '取消')),
        ),
      )
    }

    function LoadCard(props) {
      const state = useStore()
      const sessionId = props.sessionId
      const data = state.data
      const [picking, setPicking] = useState(false)

      useEffect(() => {
        activeSessionId = sessionId || activeSessionId
        if (sessionId) refresh(sessionId)
      }, [sessionId])

      const session = data && data.session
      if (!sessionId || !data || !session || session.decided) return null

      const choose = (mode) => run('session.set', { sessionId, mode })

      return h(
        'div',
        { className: 'dmc-card' },
        h('div', { className: 'dmc-card-row' }, h('strong', null, '这次对话要不要带上长期记忆？')),
        h(
          'div',
          { className: 'dmc-card-hint' },
          `记忆库里现在有 ${data.stats.enabled} 条启用记忆、${data.stats.groups} 个文件夹。选一个文件夹就能整组带进来，不用一条条挑。`,
        ),
        h(
          'div',
          { className: 'dmc-card-row' },
          h('button', { className: 'dmc-btn primary', onClick: () => setPicking(true) }, '选文件夹…'),
          h('button', { className: 'dmc-btn', onClick: () => choose('all') }, '全部加载'),
          h('button', { className: 'dmc-btn', onClick: () => choose('none') }, '不加载'),
          h('button', { className: 'dmc-btn', onClick: () => openPanel(PANEL_ID) }, '打开记忆面板'),
        ),
        picking ? h(FolderPicker, { onClose: () => setPicking(false) }) : null,
      )
    }

    function Chip(props) {
      const state = useStore()
      const sessionId = props.sessionId
      const data = state.data
      const [open, setOpen] = useState(false)
      const [importing, setImporting] = useState(false)
      const [preview, setPreview] = useState(null)
      const [anchor, setAnchor] = useState(null)
      const wrapRef = useRef(null)

      useEffect(() => {
        activeSessionId = sessionId || activeSessionId
        if (sessionId) refresh(sessionId)
      }, [sessionId])

      useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      useEffect(() => {
        if (!data && sessionId) refresh(sessionId)
      }, [])

      const session = (data && data.session) || {}
      const label = !data
        ? '记忆 …'
        : !session.decided
          ? '记忆 · 未选择'
          : session.mode === 'none'
            ? '记忆 · 不加载'
            : `记忆 · ${session.count} 条`

      // 输入框所在的容器常有 overflow:hidden，弹层改成 fixed 定位才不会被裁掉。
      const anchorPopover = () => {
        const node = wrapRef.current
        const rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
        if (!rect || !window.innerWidth) {
          setAnchor(null)
          return
        }
        const width = Math.min(320, Math.max(240, window.innerWidth - 16))
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        setAnchor({ left, bottom: Math.max(8, window.innerHeight - rect.top + 6), width })
      }
      const popStyle = anchor
        ? {
            position: 'fixed',
            left: anchor.left,
            bottom: anchor.bottom,
            width: anchor.width,
            top: 'auto',
            maxHeight: 'min(60vh, 420px)',
            zIndex: 500,
          }
        : { maxHeight: 'min(60vh, 420px)' }

      const choose = async (mode) => {
        if (!sessionId) return
        await run('session.set', { sessionId, mode })
        setOpen(false)
      }

      return h(
        'div',
        { className: 'dmc-pop-wrap', ref: wrapRef },
        h(
          'button',
          {
            className: session.mode && session.mode !== 'none' ? 'dmc-chip on' : 'dmc-chip',
            title: '记忆：点击选择本会话加载哪些记忆',
            onClick: () => {
              setOpen((value) => {
                if (!value) anchorPopover()
                return !value
              })
            },
          },
          label,
        ),
        open && data
          ? h(
              'div',
              { className: 'dmc-pop', style: popStyle },
              h('div', { className: 'dmc-card-row' }, h('strong', null, '本会话记忆')),
              h(
                'div',
                { className: 'dmc-actions' },
                h('button', { className: 'dmc-btn', onClick: () => choose('none') }, '不加载'),
                h('button', { className: 'dmc-btn', onClick: () => choose('all') }, '全部加载'),
                h('button', { className: 'dmc-btn', onClick: () => openPanel(PANEL_ID) }, '面板…'),
              ),
              h('div', { className: 'dmc-card-hint', style: { marginTop: '8px' } }, '点文件夹名 = 整个文件夹加入本会话（下一轮生效）'),
              ...data.groups.map((group) => {
                const on = session.groupIds && session.groupIds.includes(group.id)
                const count = (data.items || []).filter(
                  (item) => item.groupId === group.id && item.status === 'active' && item.enabled,
                ).length
                return h(
                  'button',
                  {
                    key: group.id,
                    className: on ? 'dmc-btn primary' : 'dmc-btn',
                    style: { marginRight: '4px', marginBottom: '4px' },
                    onClick: async () => {
                      if (!sessionId) return
                      if (on) {
                        const next = session.groupIds.filter((id) => id !== group.id)
                        const rest = (session.itemIds || []).length
                        await run('session.set', {
                          sessionId,
                          mode: next.length || rest ? 'custom' : 'none',
                          groupIds: next,
                          itemIds: session.itemIds,
                        })
                      } else {
                        await run('session.add', { sessionId, groupIds: [group.id] })
                      }
                    },
                  },
                  `${group.name} · ${count}`,
                )
              }),
              h(
                'div',
                { className: 'dmc-actions', style: { marginTop: '8px' } },
                h('button', { className: 'dmc-btn', onClick: () => setImporting(true) }, '导入记忆…'),
                h('button', { className: 'dmc-btn', onClick: () => setPreview((data && data.preview) || '') }, '预览注入'),
                h('button', { className: 'dmc-btn', onClick: () => run('session.reset', { sessionId }) }, '清除本会话选择'),
              ),
            )
          : null,
        importing
          ? h(ImportDialog, {
              onClose: async () => {
                setImporting(false)
                if (sessionId) {
                  await refresh(sessionId)
                  setOpen(true)
                }
              },
            })
          : null,
        preview !== null ? h(PreviewDialog, { text: preview, onClose: () => setPreview(null) }) : null,
      )
    }

    function SettingsSection() {
      const state = useStore()
      const data = state.data
      const [copied, setCopied] = useState(false)
      const [storage, setStorage] = useState(false)
      const [syncOpen, setSyncOpen] = useState(false)

      useEffect(() => {
        if (!data) refresh()
      }, [])

      const dataDir = (data && data.dataDir) || ''

      const copy = async () => {
        if (!dataDir) return
        if (await copyText(dataDir)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dmc-lead' },
          h('span', null, '这里管理的就是侧栏「记忆」里的同一个库，路径'),
          h(
            'code',
            { className: 'dmc-lead-path', title: '点击复制这个路径', onClick: copy },
            dataDir || '读取中…',
          ),
          h('button', { className: 'dmc-btn is-sm', onClick: copy, disabled: !dataDir }, copied ? '已复制' : '复制'),
          h('button', { className: 'dmc-btn is-sm', onClick: () => setStorage(true), disabled: !dataDir }, '更改…'),
          h(
            'button',
            {
              className: 'dmc-btn is-sm',
              onClick: () => setSyncOpen(true),
              title: '可选：同步到你自己的 Git 仓库或 WebDAV 网盘',
            },
            data && data.sync && data.sync.mode && data.sync.mode !== 'off' ? '云端同步 · 已开' : '云端同步…',
          ),
          h('span', { className: 'dmc-card-hint' }, '改完立即落盘，两个入口同步。'),
        ),
        h(MemoryPanel, { embedded: true }),
        syncOpen
          ? h(SyncDialog, {
              syncInfo: data && data.sync,
              dataDir,
              gitAvailable: data && data.gitAvailable,
              onClose: () => setSyncOpen(false),
              onDone: () => refresh(),
            })
          : null,
        storage
          ? h(StorageDialog, {
              dataDir,
              onClose: () => setStorage(false),
              onDone: () => {
                setStorage(false)
                refresh()
              },
            })
          : null,
      )
    }

    let panelCtx = null

    /** 打开/切换主面板。layout 是客户端服务，必须 inject 才有。 */
    const openPanel = (id) => {
      const layout = panelCtx && panelCtx.layout
      if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(id)
      else if (typeof console !== 'undefined') console.warn('memory-center: layout.selectPanel 不可用')
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        panelCtx = ctx

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '记忆' },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPanel))

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'memory-load', order: 40, label: () => '记忆：本次是否加载' },
            LoadCard,
          ),
        )

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'memory-chip', order: 20, label: () => '记忆' },
            Chip,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'memory', order: 60, label: () => '记忆库' },
            SettingsSection,
          ),
        )
      },
    }
  },
})
