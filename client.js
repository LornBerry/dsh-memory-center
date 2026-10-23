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
    const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React

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
        .dmc-budget { margin-top: 6px; opacity: 1; }
        .dmc-budget-bar { height: 4px; border-radius: 3px; background: rgba(127,127,127,.22); overflow: hidden; }
        .dmc-budget-bar > i { display: block; height: 100%; background: #2ea078; border-radius: 3px; transition: width .2s ease; }
.dmc-budget-bar > i.is-over { background: #d98324; }
        .dmc-budget-text { margin-top: 3px; letter-spacing: .2px; }
        .dmc-cap { font-size: 13px; }
        .dmc-cap-row { display: flex; align-items: baseline; gap: 10px; padding: 3px 0; border-bottom: 1px dashed rgba(127,127,127,.16); }
.dmc-ratio { margin: 12px 0 4px; padding: 10px; border: 1px solid rgba(127,127,127,.18); border-radius: 8px; }
.dmc-range { width: 100%; margin: 8px 0 10px; accent-color: #2ea078; }
.dmc-range:disabled { opacity: .5; }
.dmc-btn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .dmc-cap-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dmc-cap-num { flex: none; opacity: .62; font-variant-numeric: tabular-nums; }
        .dmc-cap-row .dmc-btn-mini { flex: none; padding: 2px 8px; font-size: 12px; }
        .dmc-btn-mini { padding: 2px 8px; font-size: 12px; }
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
  .dmc-select-mini { width: auto; padding: 3px 6px; font-size: 12px; }
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
        /* 锚点徽标：硬性规则一眼可见（橙红），软性倾向用蓝绿 */
        .dmc-tag.dmc-anchor-full { background: rgba(226,94,54,.22); color: inherit; box-shadow: inset 0 0 0 1px rgba(226,94,54,.55); font-weight: 600; }
        .dmc-tag.dmc-anchor-weight { background: rgba(46,160,120,.20); color: inherit; box-shadow: inset 0 0 0 1px rgba(46,160,120,.45); }
        .dmc-anchor-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
        .dmc-anchor-dot.full { background: #e25e36; }
        .dmc-anchor-dot.weight { background: #2ea078; }
        /* Markdown 渲染 */
        .dmc-md { font-size: 12px; line-height: 1.62; word-break: break-word; }
        .dmc-md > :first-child { margin-top: 0; }
        .dmc-md p { margin: 0 0 6px; }
        .dmc-md h1, .dmc-md h2, .dmc-md h3, .dmc-md h4 { margin: 10px 0 4px; font-size: 13px; font-weight: 600; }
        .dmc-md ul, .dmc-md ol { margin: 0 0 6px; padding-left: 18px; }
        .dmc-md li { margin: 1px 0; }
        .dmc-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 1px 4px; border-radius: 4px; background: rgba(127,127,127,.18); }
        .dmc-md pre { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.14); overflow: auto; }
        .dmc-md pre code { background: none; padding: 0; }
        .dmc-md blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid rgba(127,127,127,.4); opacity: .85; }
        .dmc-md a { color: #5d8cff; text-decoration: none; }
        .dmc-md a:hover { text-decoration: underline; }
        .dmc-md hr { border: 0; border-top: 1px solid rgba(127,127,127,.3); margin: 8px 0; }
        /* 底部批量操作栏（吸底） */
        .dmc-bottom-bar { position: sticky; bottom: 0; z-index: 30; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; margin: 0 14px 10px; border-radius: 10px; background: rgba(93,140,255,.16); border: 1px solid rgba(93,140,255,.45); backdrop-filter: blur(6px); box-shadow: 0 -6px 18px rgba(0,0,0,.12); }
        .dmc-bottom-bar strong { margin-right: 2px; }
        /* 视图切换 + 排序 */
        .dmc-toolbar-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
        .dmc-icon-group { display: inline-flex; border: 1px solid rgba(127,127,127,.3); border-radius: 8px; overflow: hidden; }
        .dmc-icon-btn { background: none; border: 0; padding: 4px 9px; font: inherit; font-size: 12px; color: inherit; cursor: pointer; opacity: .65; }
        .dmc-icon-btn.is-active { background: rgba(93,140,255,.22); opacity: 1; }
        .dmc-sort { font-size: 12px; padding: 4px 6px; border-radius: 8px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; }
        /* 列表视图 */
        .dmc-listview .dmc-item { padding: 5px 10px; margin-bottom: 3px; }
        .dmc-listview .dmc-item-body, .dmc-listview .dmc-tags { display: none; }
        .dmc-listview .dmc-actions { display: none; }
        .dmc-listview .dmc-item-head { gap: 8px; }
        .dmc-listview .dmc-item-title { flex: 0 1 auto; }
        .dmc-list-meta { font-size: 11px; opacity: .55; margin-left: auto; white-space: nowrap; }
        /* 空状态 */
        .dmc-empty-state { margin: 28px auto; max-width: 420px; text-align: center; }
        .dmc-empty-state .dmc-empty-art { font-size: 34px; opacity: .5; }
        .dmc-empty-state .dmc-empty-title { margin: 10px 0 4px; font-weight: 600; }
        .dmc-empty-state .dmc-empty-hint { opacity: .65; font-size: 12px; line-height: 1.7; }
        .dmc-empty-state .dmc-empty-actions { margin-top: 12px; display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
        /* 搜索命中高亮 */
        .dmc-hl { background: rgba(255,214,64,.35); border-radius: 3px; padding: 0 1px; }
        /* 回收站 */
        .dmc-item.is-deleted { opacity: .75; border-style: dashed; }
        .dmc-md-preview { border: 1px solid rgba(127,127,127,.25); border-radius: 8px; padding: 8px 10px; min-height: 96px; max-height: 260px; overflow: auto; background: rgba(127,127,127,.06); }
        .dmc-editor-tabs { display: flex; gap: 6px; margin-bottom: 6px; }
        .dmc-menu { position: fixed; min-width: 176px; max-width: min(320px, calc(100vw - 16px)); padding: 4px; border-radius: 10px; border: 1px solid rgba(127,127,127,.32); background: var(--dsh-popover-bg, #1f2126); color: var(--dsh-popover-fg, #e6e6e6); box-shadow: 0 14px 36px rgba(0,0,0,.36); z-index: 600; max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain; }
        .dmc-menu::-webkit-scrollbar { width: 8px; }
        .dmc-menu::-webkit-scrollbar-thumb { background: rgba(127,127,127,.42); border-radius: 4px; }
        .dmc-menu::-webkit-scrollbar-track { background: transparent; }
        .dmc-menu-item { display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; padding: 6px 8px; border-radius: 6px; cursor: pointer; white-space: normal; overflow-wrap: anywhere; }
        .dmc-menu-item:hover { background: rgba(127,127,127,.18); }
        .dmc-menu-item.danger { color: #ff7a7a; }
        .dmc-menu-head { padding: 6px 8px 2px; font-size: 11px; opacity: .55; }
        .dmc-menu-note { padding: 0 8px 4px; font-size: 11px; line-height: 1.5; opacity: .6; max-width: 240px; }
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

    /** 12345 → 12.3k，用于注入预算这种小数字。 */
    function formatK(value) {
      const n = Number(value) || 0
      return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
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

    /* ------------------------------------------------------- markdown / 高亮 */

    /**
     * 极简 Markdown 渲染：只支持记忆正文里真正会用到的那几种写法。
     * 全部用 React 元素拼出来，不碰 innerHTML，避免记忆内容里带 HTML 时被浏览器执行。
     */
    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-${index++}`
        if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)))
        else if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)))
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          nodes.push(
            h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1]),
          )
        } else nodes.push(h('em', { key }, token.slice(1, -1)))
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
      const source = String(text ?? '')
      if (!source.trim()) return [h('p', { key: 'empty', className: 'dmc-card-hint' }, '（空）')]
      const blocks = []
      const lines = source.split(/\r?\n/)
      let i = 0
      let key = 0
      const startOfBlock = (line) => /^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>|---|\*\*\*|___)/.test(line)
      while (i < lines.length) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
          const buffer = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            buffer.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(h('pre', { key: `pre-${key++}` }, h('code', null, buffer.join('\n'))))
          continue
        }
        if (!line.trim()) {
          i += 1
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push(h(`h${heading[1].length}`, { key: `h-${key++}` }, ...renderInline(heading[2], `hi-${key}`)))
          i += 1
          continue
        }
        if (/^\s*([-*+])\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
            items.push(h('li', { key: `li-${key++}` }, ...renderInline(lines[i].replace(/^\s*([-*+])\s+/, ''), `lii-${key}`)))
            i += 1
          }
          blocks.push(h('ul', { key: `ul-${key++}` }, ...items))
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(h('li', { key: `oli-${key++}` }, ...renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''), `olii-${key}`)))
            i += 1
          }
          blocks.push(h('ol', { key: `ol-${key++}` }, ...items))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buffer = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buffer.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: `bq-${key++}` }, ...renderInline(buffer.join('\n'), `bqi-${key}`)))
          continue
        }
        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
          blocks.push(h('hr', { key: `hr-${key++}` }))
          i += 1
          continue
        }
        const buffer = []
        while (i < lines.length && lines[i].trim() && !startOfBlock(lines[i])) {
          buffer.push(lines[i])
          i += 1
        }
        blocks.push(h('p', { key: `p-${key++}` }, ...renderInline(buffer.join('\n'), `pi-${key}`)))
      }
      return blocks
    }

    /** 搜索命中高亮：只包一层 <mark> 样式的 span，依然不碰 HTML。 */
    function highlightNodes(text, query) {
      const source = String(text ?? '')
      const needle = String(query ?? '').trim()
      if (!needle) return [source]
      const nodes = []
      const lower = source.toLowerCase()
      const target = needle.toLowerCase()
      let at = lower.indexOf(target)
      let last = 0
      let index = 0
      while (at >= 0) {
        if (at > last) nodes.push(source.slice(last, at))
        nodes.push(h('span', { key: `hl-${index++}`, className: 'dmc-hl' }, source.slice(at, at + needle.length)))
        last = at + needle.length
        at = lower.indexOf(target, last)
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    function ConfirmDialog({ title, message, detail, confirmLabel, danger, onConfirm, onClose }) {
      const [busy, setBusy] = useState(false)
      const go = async () => {
        setBusy(true)
        try {
          await onConfirm()
        } finally {
          setBusy(false)
          onClose()
        }
      }
      return h(
        Modal,
        {
          title: title || '请确认',
          onClose,
          footer: [
            h('button', { key: 'cancel', className: 'dmc-btn', onClick: onClose, disabled: busy }, '取消'),
            h(
              'button',
              {
                key: 'ok',
                className: danger ? 'dmc-btn danger' : 'dmc-btn primary',
                onClick: go,
                disabled: busy,
              },
              busy ? '处理中…' : confirmLabel || '确定',
            ),
          ],
        },
        h('div', { style: { fontSize: '13px', lineHeight: '1.7' } }, message),
        detail ? h('div', { className: 'dmc-card-hint', style: { marginTop: '8px' } }, detail) : null,
      )
    }

    function CapacityDialog({ capacity, injection, onClose, onArchiveFolder, onSetRatio, onFocusItem, onArchiveIds }) {
      const cap = capacity || {}
      const folders = (cap.folders || []).slice().sort((a, b) => b.chars - a.chars)
      const longest = cap.longest || []
      const softLimit = cap.softLimit || Math.floor((cap.limit || 0) * (cap.threshold || 0.8))
      const ratio = Math.min(100, Math.round((cap.ratio || 0) * 100))
      const savedThreshold = Math.round((cap.threshold || 0.8) * 100)
      const thresholdPct = savedThreshold
      const [draft, setDraft] = useState(savedThreshold)
      const draftLimit = Math.round(((cap.limit || 0) * draft) / 100)
      const ratioLocked = Boolean(cap.ratioLocked)
      const rows = [
        h(
          'div',
          { key: 'head', className: 'dmc-card-hint', style: { marginBottom: '8px' } },
          `注入上限 ${formatK(cap.limit || 0)} 字符，压缩线 ${formatK(softLimit)}（上限的 ${thresholdPct}%）。当前本会话要注入 ${injection ? injection.kept : 0} 条、${formatK(injection ? injection.chars : 0)} 字符。`,
        ),
        h(
          'div',
          { key: 'bar', className: 'dmc-budget-bar', style: { marginBottom: '4px' } },
          h('i', {
            style: {
              width: `${ratio}%`,
              background: ratio >= 100 ? '#d9534f' : cap.over ? '#d98324' : '#2ea078',
            },
          }),
        ),
        h(
          'div',
          { key: 'ratio', className: 'dmc-card-hint', style: { marginBottom: '10px' } },
          `全部启用记忆共 ${formatK(cap.chars || 0)} 字符（${cap.items || 0} 条），是压缩线的 ${ratio}%。`,
          cap.over ? ' 已超过压缩线：超出部分只给标题，需要在提问里用到就用 memory_search 取。' : '',
        ),
        h(
          'div',
          { key: 'slider', className: 'dmc-ratio' },
          h(
            'div',
            { className: 'dmc-card-hint' },
            ratioLocked
              ? '压缩阈值被环境变量 DSH_MEMORY_COMPRESS_RATIO 固定，面板里不能改。'
              : `压缩阈值：记忆用到上限的 ${draft}% 就开始压缩（约 ${formatK(draftLimit)} 字符）。往左更省、往右更全。`,
          ),
          h('input', {
            className: 'dmc-range',
            type: 'range',
            min: 10,
            max: 100,
            step: 5,
            value: draft,
            disabled: ratioLocked,
            'aria-label': '压缩阈值',
            onChange: (event) => setDraft(Number(event.target.value)),
          }),
          h(
            'div',
            { className: 'dmc-btn-row' },
            h(
              'button',
              {
                className: 'dmc-btn primary',
                type: 'button',
                disabled: ratioLocked || draft === savedThreshold,
                onClick: () => onSetRatio && onSetRatio(draft / 100),
              },
              draft === savedThreshold ? '已生效' : `应用 ${draft}%`,
            ),
            h(
              'button',
              {
                className: 'dmc-btn',
                type: 'button',
                disabled: ratioLocked || savedThreshold === 80,
                onClick: () => onSetRatio && onSetRatio(0.8),
              },
              '恢复 80%',
            ),
          ),
        ),
        h('div', { key: 'h1', style: { fontWeight: 600, margin: '6px 0' } }, '哪几个文件夹最占地方'),
        ...(folders.length
          ? folders.slice(0, 8).map((group, index) =>
              h(
                'div',
                { key: `f${index}`, className: 'dmc-cap-row' },
                h('span', { className: 'dmc-cap-name' }, group.name),
                h('span', { className: 'dmc-cap-num' }, `${group.count} 条 · ${formatK(group.chars)}`),
              ),
            )
          : [h('div', { key: 'nofolder', className: 'dmc-card-hint' }, '还没有记忆')]),
        h('div', { key: 'h2', style: { fontWeight: 600, margin: '12px 0 6px' } }, '最长的几条'),
        ...(longest.length
          ? longest.map((item, index) =>
              h(
                'div',
                { key: `l${index}`, className: 'dmc-cap-row' },
                h('span', { className: 'dmc-cap-name' }, item.title),
                h('span', { className: 'dmc-cap-num' }, formatK(item.chars)),
                onFocusItem
                  ? h(
                      'button',
                      {
                        className: 'dmc-btn dmc-btn-mini',
                        title: '在面板里定位这条记忆',
                        onClick: () => onFocusItem(item.id),
                      },
                      '定位',
                    )
                  : null,
                onArchiveIds
                  ? h(
                      'button',
                      {
                        className: 'dmc-btn dmc-btn-mini',
                        title: '归档这条（不再注入，可在「归档」里还原）',
                        onClick: () => onArchiveIds([item.id]),
                      },
                      '归档',
                    )
                  : null,
              ),
            )
          : [h('div', { key: 'nolong', className: 'dmc-card-hint' }, '—')]),
        h(
          'div',
          { key: 'tip', className: 'dmc-card-hint', style: { marginTop: '12px' } },
          '建议：把过时的条目「归档」，或选中几条意义相近的点「合并」压成一条；被挤掉的条目不会丢，模型会用 memory_search 去查。',
        ),
      ]
      return h(
        Modal,
        {
          title: '记忆容量',
          onClose,
          footer: [
            onArchiveFolder
              ? h(
                  'button',
                  { key: 'arch', className: 'dmc-btn', onClick: onArchiveFolder },
                  '去归档',
                )
              : null,
            h('button', { key: 'ok', className: 'dmc-btn primary', onClick: onClose }, '知道了'),
          ].filter(Boolean),
        },
        h('div', { className: 'dmc-cap' }, rows),
      )
    }

    function TagDialog({ count, suggestions, onSubmit, onClose }) {
      const [text, setText] = useState('')
      const tags = text
        .split(/[,，、]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
      return h(
        Modal,
        {
          title: `给 ${count} 条记忆打标`,
          onClose,
          footer: [
            h('button', { key: 'cancel', className: 'dmc-btn', onClick: onClose }, '取消'),
            h(
              'button',
              { key: 'ok', className: 'dmc-btn primary', disabled: !tags.length, onClick: () => onSubmit(tags) },
              '添加标签',
            ),
          ],
        },
        h(
          'div',
          { className: 'dmc-field' },
          h('label', null, '标签（逗号分隔；会并到每条已有标签上，不覆盖原来的）'),
          h('input', {
            className: 'dmc-input',
            value: text,
            onChange: (event) => setText(event.target.value),
            placeholder: '例如：项目约定, 数据库',
          }),
          suggestions && suggestions.length
            ? h(
                'div',
                { className: 'dmc-suggest' },
                suggestions.slice(0, 16).map((tag) =>
                  h(
                    'span',
                    {
                      key: tag,
                      className: 'dmc-tag',
                      onClick: () =>
                        setText((current) => {
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
      const [pane, setPane] = useState('edit')

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
          h(
            'div',
            { className: 'dmc-card-row' },
            h('label', { style: { margin: 0 } }, '内容（支持 Markdown：标题 / 列表 / 加粗 / 代码块 / 链接）'),
            h(
              'div',
              { className: 'dmc-editor-tabs', style: { marginLeft: 'auto', marginBottom: 0 } },
              h(
                'button',
                {
                  className: pane === 'edit' ? 'dmc-btn primary' : 'dmc-btn',
                  onClick: () => setPane('edit'),
                },
                '编辑',
              ),
              h(
                'button',
                {
                  className: pane === 'preview' ? 'dmc-btn primary' : 'dmc-btn',
                  onClick: () => setPane('preview'),
                },
                '预览',
              ),
            ),
          ),
          pane === 'edit'
            ? h('textarea', {
                className: 'dmc-textarea',
                value: body,
                onChange: (event) => setBody(event.target.value),
                placeholder: '写清楚具体内容与原因；支持 **加粗**、- 列表、`代码`、```代码块```',
              })
            : h('div', { className: 'dmc-md-preview dmc-md' }, ...renderMarkdown(body)),
          pane === 'edit'
            ? h('div', { className: 'dmc-card-hint' }, '切到「预览」可以看渲染效果；保存后条目卡片里也会按 Markdown 显示。')
            : null,
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
      const [query, setQuery] = useState((props && props.debugQuery) || '')
      // 服务端检索结果（同义词 + 相关度排序）：{ query, ids, snippets }
      const [hits, setHits] = useState((props && props.debugHits) || null)
      const [editing, setEditing] = useState(null)
      const [creating, setCreating] = useState(false)
      const [importing, setImporting] = useState(false)
      const [exporting, setExporting] = useState(false)
      const [groupDialog, setGroupDialog] = useState(null)
      const [preview, setPreview] = useState(null)
      const [selected, setSelected] = useState((props && props.debugSelected) || [])
      const [menu, setMenu] = useState((props && props.debugMenu) || null)
      const menuRef = useRef(null)
      const [menuSpot, setMenuSpot] = useState(null)
      const [dragIds, setDragIds] = useState([])
      const [dropKey, setDropKey] = useState(null)
      const [storageOpen, setStorageOpen] = useState((props && props.debugStorage) || false)
      const [syncOpen, setSyncOpen] = useState((props && props.debugSync) || false)
      // 排序用一个下拉表达（值形如 updated-desc）：内部仍保留方向后缀，
      // 但界面上只有四个选项（默认 / 首字母 / 修改时间 / 创建时间），方向固定为常用的那个。
      const [sort, setSort] = useState((props && props.debugSort) || 'manual')
      const sortKey = sort.split('-')[0]
      const sortDir = sort.split('-')[1] || 'desc'
      const [view, setView] = useState((props && props.debugView) || 'card')
      const [confirmAsk, setConfirmAsk] = useState((props && props.debugConfirm) || null)
      const [tagging, setTagging] = useState(null)
      const [capacityOpen, setCapacityOpen] = useState((props && props.debugCapacity) || false)

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
      const deletedItems = data.deleted || []
      const archivedItems = data.archived || []
      const recycleMode = filter === '__deleted'
      const archiveMode = filter === '__archived'
      const pool = recycleMode ? deletedItems : archiveMode ? archivedItems : data.items

      // 搜索走宿主检索（同义词扩展 + 相关度排序），输入停顿 180ms 再请求；
      // 请求回来之前先用本地子串兜底，避免输入时的空窗。
      useEffect(() => {
        const raw = query.trim()
        if (!raw) {
          setHits(null)
          return undefined
        }
        let cancelled = false
        const timer = setTimeout(() => {
          api('search', { query: raw, includeArchived: archiveMode })
            .then((result) => {
              if (cancelled) return
              const ids = []
              const snippets = {}
              for (const hit of result.hits || []) {
                ids.push(hit.id)
                if (hit.snippet) snippets[hit.id] = hit.snippet
              }
              setHits({ query: raw, ids, snippets })
            })
            .catch(() => {})
        }, 180)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [query, archiveMode])

      const activeHits = hits && hits.query === query.trim() ? hits : null

      const filtered = pool.filter((item) => {
        if (recycleMode || archiveMode) {
          // 回收站 / 归档只按关键词过滤，不再套文件夹/待确认条件。
        } else {
          if (filter === '__pending' && item.status !== 'pending') return false
          if (filter === '__ungrouped' && item.groupId) return false
          if (filter !== '__all' && filter !== '__pending' && filter !== '__ungrouped' && item.groupId !== filter) return false
        }
        if (query.trim()) {
          const raw = query.trim()
          if (activeHits) {
            if (!activeHits.ids.includes(item.id)) return false
          } else {
            const haystack = `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase()
            if (!haystack.includes(raw.toLowerCase())) return false
          }
        }
        return true
      })

      // 排序：默认按手动顺序（拖拽/顺序字段），也可以按时间找“刚加的那条”。
      // 置顶条目无论正序倒序都排在最前，所以方向只作用在同一置顶分组内部。
      const sorted = (() => {
        const list = [...filtered]
        // 搜索时按相关度排（宿主已经算好顺序），不再套文件夹/时间排序。
        if (activeHits) {
          const rank = new Map(activeHits.ids.map((id, index) => [id, index]))
          list.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
          return list
        }
        const factor = sortDir === 'desc' ? -1 : 1
        const byPinned = (a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1)
        if (sortKey === 'updated' || sortKey === 'created') {
          const field = sortKey === 'updated' ? 'updatedAt' : 'createdAt'
          list.sort(
            (a, b) => byPinned(a, b) || factor * String(a[field] || '').localeCompare(String(b[field] || '')),
          )
          return list
        }
        if (sortKey === 'title') {
          list.sort(
            (a, b) => byPinned(a, b) || factor * String(a.title).localeCompare(String(b.title), 'zh-CN'),
          )
          return list
        }
        return list
      })()

      const pendingItems = data.items.filter((item) => item.status === 'pending')

      const currentName =
        filter === '__all'
          ? '全部记忆'
          : filter === '__pending'
            ? '待确认'
            : filter === '__ungrouped'
              ? '未归类'
              : filter === '__deleted'
                ? '回收站'
                : filter === '__archived'
                  ? '归档'
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
        setMenuSpot(null)
        setMenu({ kind, id, x, y })
      }
      const openMenuAtButton = (event, kind, id) => {
        if (event && event.stopPropagation) event.stopPropagation()
        if (event && event.preventDefault) event.preventDefault()
        const rect = event && event.currentTarget && event.currentTarget.getBoundingClientRect
          ? event.currentTarget.getBoundingClientRect()
          : null
        setMenuSpot(null)
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

      // 菜单定位：先用粗略估算给出初值，渲染后按「实际渲染位置 + 实际尺寸」再纠一次。
      // 用 rect 差值而不是重新假设 left/top，是因为祖先若有 transform，position:fixed 的参照系
      // 不是视口，直接按视口算 left 会把菜单推到窗口外面去。
      const menuAnchor = (target) => {
        const width = 208
        const height = target.kind === 'item' ? 340 : 230
        const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
        const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
        return { left: Math.max(8, Math.min(target.x, vw - width - 8)), top: Math.max(8, Math.min(target.y, vh - height - 8)) }
      }

      useLayoutEffect(() => {
        if (!menu) return
        const el = menuRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const applied = menuSpot || menuAnchor(menu)
        // 目标：让菜单的四个边都落在视口内
        let targetLeft = rect.left
        let targetTop = rect.top
        if (targetLeft + rect.width > vw - 8) targetLeft = vw - 8 - rect.width
        if (targetLeft < 8) targetLeft = 8
        if (targetTop + rect.height > vh - 8) targetTop = vh - 8 - rect.height
        if (targetTop < 8) targetTop = 8
        const left = applied.left + (targetLeft - rect.left)
        const top = applied.top + (targetTop - rect.top)
        setMenuSpot((prev) =>
          prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5 ? prev : { left, top },
        )
      }, [menu])

      // 资源管理器式的右键/「…」菜单：文件夹与条目的全部动作都收在这里，行上不再挤按钮。
      const menuNode = () => {
        if (!menu) return null
        const close = () => setMenu(null)
        const spot = menuSpot || menuAnchor(menu)
        const item =
          menu.kind === 'item'
            ? (data.items || []).find((entry) => entry.id === menu.id) ||
              (data.archived || []).find((entry) => entry.id === menu.id) ||
              (data.deleted || []).find((entry) => entry.id === menu.id) ||
              null
            : null
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
                item.archivedAt
                  ? row('还原（回到活跃）', () => run('item.unarchive', { ids: [item.id] }))
                  : row('归档（不再注入，可还原）', () => run('item.archive', { ids: [item.id] })),
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
                h('div', { key: 'sep-anchor', className: 'dmc-menu-sep' }),
                h('div', { key: 'anchor-head', className: 'dmc-menu-head' }, '锚点（决定注入强度）'),
                h(
                  'div',
                  { key: 'anchor-why', className: 'dmc-menu-note' },
                  `${item.anchorSource === 'inferred' ? '当前由插件初判' : '当前为你手动设置'}${item.anchorWhy ? `：${item.anchorWhy}` : ''}`,
                ),
                ...[
                  ['full', '完全锚点：必须照此执行', '硬性要求，模型不得偏离'],
                  ['weight', '权重锚点：倾向性参考', '软性偏好，影响措辞与优先级，可偏离'],
                  ['off', '不启用锚点', '普通记忆，只作为事实参考'],
                ].map(([mode, label, hint]) =>
                  h(
                    'button',
                    {
                      key: `anchor-${mode}`,
                      className: 'dmc-menu-item',
                      title: hint,
                      onClick: () =>
                        act(() => run('item.update', { id: item.id, patch: { anchorMode: mode } })),
                    },
                    `${(item.anchorMode || 'off') === mode ? '✓ ' : ''}${label}`,
                  ),
                ),
                h(
                  'button',
                  {
                    key: 'anchor-reinfer',
                    className: 'dmc-menu-item',
                    title: '按标题/正文/标签里的措辞重新判断一次（会覆盖手动设置）',
                    onClick: () =>
                      act(() => run('anchor.reinfer', { ids: [item.id], force: true })),
                  },
                  '↻ 按内容重新判断',
                ),
                h('div', { key: 'sep', className: 'dmc-menu-sep' }),
                row(
                  '删除',
                  async () => {
                    setConfirmAsk({
                      title: '删除这条记忆？',
                      message: `「${item.title}」会先进入回收站，之后还能恢复。`,
                      confirmLabel: '移入回收站',
                      danger: true,
                      onConfirm: () => run('item.delete', { ids: [item.id] }),
                    })
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
            { className: 'dmc-menu', ref: menuRef, style: { left: `${spot.left}px`, top: `${spot.top}px` }, onClick: (event) => event.stopPropagation() },
            ...body,
          ),
        )
      }

      const anchorHint = (item) => {
        const source = item.anchorSource === 'inferred' ? '插件按内容初判' : '你手动设置'
        const why = item.anchorWhy ? `：${item.anchorWhy}` : ''
        return `${source}${why}。可在「更多… → 锚点」里改`
      }

      const anchorTag = (item) =>
        item.anchorMode === 'full'
          ? h('span', { className: 'dmc-tag dmc-anchor-full', title: anchorHint(item) }, '完全锚点')
          : item.anchorMode === 'weight'
            ? h('span', { className: 'dmc-tag dmc-anchor-weight', title: anchorHint(item) }, '权重锚点')
            : null

      const renderItem = (item) => {
        const listMode = view === 'list'
        const stamp = String(item.updatedAt || item.createdAt || '').replace('T', ' ').slice(0, 16)
        const isDeleted = Boolean(item.deletedAt) || recycleMode
        return h(
          'div',
          {
            key: item.id,
            className: `dmc-item${item.enabled ? '' : ' is-off'}${item.status === 'pending' ? ' is-pending' : ''}${
              selected.includes(item.id) ? ' is-selected' : ''
            }${isDeleted ? ' is-deleted' : ''}`,
            draggable: !isDeleted,
            onDragStart: (event) => {
              if (isDeleted) return
              const ids = selected.includes(item.id) ? selected : [item.id]
              setDragIds(ids)
              if (event.dataTransfer) {
                event.dataTransfer.setData('text/plain', ids.join(','))
                event.dataTransfer.effectAllowed = 'move'
              }
            },
            onDragEnd: () => setDragIds([]),
            onContextMenu: isDeleted ? undefined : (event) => openMenu(event, 'item', item.id),
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
            item.anchorMode === 'full' ? h('span', { className: 'dmc-anchor-dot full', title: '完全锚点（硬性）' }) : null,
            item.anchorMode === 'weight' ? h('span', { className: 'dmc-anchor-dot weight', title: '权重锚点（软性）' }) : null,
            h('span', { className: 'dmc-item-title' }, `${item.pinned ? '📌 ' : ''}`, ...highlightNodes(item.title, query)),
            !listMode ? h('span', { className: 'dmc-tag' }, groupName(data, item.groupId)) : null,
            item.status === 'pending' ? h('span', { className: 'dmc-tag' }, '待确认') : null,
            listMode ? h('span', { className: 'dmc-tag' }, groupName(data, item.groupId)) : null,
            listMode ? null : anchorTag(item),
            listMode
              ? h('span', { className: 'dmc-list-meta' }, `${item.enabled ? '' : '已停用 · '}${stamp}`)
              : h('span', { className: 'dmc-tag' }, item.source === 'auto' ? '模型写入' : item.source === 'import' ? '导入' : '手动'),
          ),
          !listMode && item.tags.length
            ? h('div', { className: 'dmc-tags' }, item.tags.map((tag) => h('span', { key: tag, className: 'dmc-tag' }, tag)))
            : null,
          listMode
            ? null
            : query.trim()
              ? h(
                  'div',
                  { className: 'dmc-item-body' },
                  ...highlightNodes(
                    ((activeHits && activeHits.snippets[item.id]) || (item.body || '').slice(0, 260)),
                    query,
                  ),
                )
              : h('div', { className: 'dmc-item-body dmc-md' }, ...renderMarkdown(item.body)),
          h(
            'div',
            { className: 'dmc-actions' },
            isDeleted
              ? h('button', { className: 'dmc-btn primary', onClick: () => run('item.restore', { ids: [item.id] }) }, '恢复')
              : [
                  item.status === 'pending'
                    ? h('button', { key: 'confirm', className: 'dmc-btn primary', onClick: () => run('item.confirm', { ids: [item.id] }) }, '转正')
                    : null,
                  h('button', { key: 'edit', className: 'dmc-btn', onClick: () => setEditing(item) }, '编辑'),
                  h(
                    'button',
                    { key: 'more', className: 'dmc-btn', onClick: (event) => openMenuAtButton(event, 'item', item.id) },
                    '更多…',
                  ),
                ],
            isDeleted
              ? h(
                  'button',
                  {
                    className: 'dmc-btn danger',
                    onClick: () =>
                      setConfirmAsk({
                        title: '彻底删除这条记忆？',
                        message: `「${item.title}」将被永久删除，回收站里也无法恢复。`,
                        confirmLabel: '彻底删除',
                        danger: true,
                        onConfirm: () => run('recycle.purge', { ids: [item.id] }),
                      }),
                  },
                  '彻底删除',
                )
              : null,
          ),
        )
      }

      const emptyState = () => {
        if (query.trim()) {
          return h(
            'div',
            { className: 'dmc-empty-state' },
            h('div', { className: 'dmc-empty-art' }, '🔍'),
            h('div', { className: 'dmc-empty-title' }, `没有匹配「${query.trim()}」的记忆`),
            h('div', { className: 'dmc-empty-hint' }, '换个关键词试试，或者清空搜索框看全部。'),
            h(
              'div',
              { className: 'dmc-empty-actions' },
              h('button', { className: 'dmc-btn', onClick: () => setQuery('') }, '清空搜索'),
            ),
          )
        }
        if (recycleMode) {
          return h(
            'div',
            { className: 'dmc-empty-state' },
            h('div', { className: 'dmc-empty-art' }, '🗑'),
            h('div', { className: 'dmc-empty-title' }, '回收站是空的'),
            h('div', { className: 'dmc-empty-hint' }, '删除记忆时它会先来这里待着，随时可以恢复。'),
          )
        }
        if (archiveMode) {
          return h(
            'div',
            { className: 'dmc-empty-state' },
            h('div', { className: 'dmc-empty-art' }, '🗄'),
            h('div', { className: 'dmc-empty-title' }, '归档里还没有记忆'),
            h(
              'div',
              { className: 'dmc-empty-hint' },
              '把长期不用、又舍不得删的记忆「归档」，它就不再占用注入额度，随时可以还原。',
            ),
          )
        }
        if (filter === '__pending') {
          return h(
            'div',
            { className: 'dmc-empty-state' },
            h('div', { className: 'dmc-empty-art' }, '✅'),
            h('div', { className: 'dmc-empty-title' }, '没有待确认的记忆'),
            h('div', { className: 'dmc-empty-hint' }, '模型写入的记忆会先落到这里，等你点「转正」才生效。'),
          )
        }
        const folderName = filter === '__all' || filter === '__ungrouped' ? '这里' : `「${currentName}」里`
        return h(
          'div',
          { className: 'dmc-empty-state' },
          h('div', { className: 'dmc-empty-art' }, '📂'),
          h('div', { className: 'dmc-empty-title' }, `${folderName}空空如也`),
          h(
            'div',
            { className: 'dmc-empty-hint' },
            '可以把别处的记忆卡片拖到这里，或者点右上角「+ 新建记忆」写一条。',
          ),
          h(
            'div',
            { className: 'dmc-empty-actions' },
            h('button', { className: 'dmc-btn primary', onClick: () => setCreating(true) }, '+ 新建记忆'),
            h('button', { className: 'dmc-btn', onClick: () => setImporting(true) }, '导入'),
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
            navRow('__deleted', '回收站', data.stats.deleted || 0, undefined),
            navRow('__archived', '归档', data.stats.archived || 0, undefined),
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
            data.injection
              ? h(
                  'div',
                  {
                    className: 'dmc-budget',
                    role: 'button',
                    tabIndex: 0,
                    style: { cursor: 'pointer' },
                    title: `本次会话注入 ${data.injection.kept} 条，占 ${data.injection.chars} / ${data.injection.softLimit} 字符（压缩线是上限的 ${Math.round((data.injection.ratio || 0.8) * 100)}%）；点开看容量画像`,
                    onClick: () => setCapacityOpen(true),
                  },
                  h(
                    'div',
                    { className: 'dmc-budget-bar' },
                    h('i', {
                      className: data.injection.indexMode ? 'is-over' : null,
                      style: {
                        width: `${Math.min(100, Math.round((data.injection.chars / Math.max(1, data.injection.softLimit)) * 100))}%`,
                      },
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dmc-budget-text' },
                    `${formatK(data.injection.chars)} / 压缩线 ${formatK(data.injection.softLimit)}`,
                    data.injection.indexMode
                      ? ` · ${data.injection.dropped} 条只给标题（已压缩）`
                      : data.injection.over
                        ? ' · 已超过压缩线，下一条起压缩'
                        : '',
                  ),
                )
              : null,
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
            h(
              'div',
              { className: 'dmc-toolbar-right' },
              h(
                'select',
                {
                  className: 'dmc-sort',
                  value: sort,
                  title: '排序方式',
                  onChange: (event) => setSort(event.target.value),
                },
                h('option', { value: 'manual' }, '默认顺序'),
                h('option', { value: 'title-asc' }, '按首字母顺序'),
                h('option', { value: 'updated-desc' }, '按修改时间顺序'),
                h('option', { value: 'created-desc' }, '按创建时间顺序'),
              ),
              h(
                'div',
                { className: 'dmc-icon-group', title: '视图：卡片看长文，列表看标题' },
                h(
                  'button',
                  { className: view === 'card' ? 'dmc-icon-btn is-active' : 'dmc-icon-btn', onClick: () => setView('card') },
                  '卡片',
                ),
                h(
                  'button',
                  { className: view === 'list' ? 'dmc-icon-btn is-active' : 'dmc-icon-btn', onClick: () => setView('list') },
                  '列表',
                ),
              ),
            ),
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
                  onClick: () =>
                    setConfirmAsk({
                      title: `删除全部 ${pendingItems.length} 条待确认记忆？`,
                      message: '它们会先进入回收站，之后还能恢复。',
                      confirmLabel: '全部移入回收站',
                      danger: true,
                      onConfirm: () => run('item.delete', { ids: pendingItems.map((item) => item.id) }),
                    }),
                }, '全部删除'),
                h('span', { className: 'dmc-card-hint' }, '待确认的记忆不会参与注入，转正后才生效。'),
              )
            : null,
          recycleMode && deletedItems.length
            ? h(
                'div',
                { className: 'dmc-bottom-bar' },
                h('strong', null, `回收站 ${deletedItems.length} 条`),
                h(
                  'span',
                  { className: 'dmc-card-hint' },
                  data.recycle && data.recycle.count
                    ? `占用约 ${formatK(data.recycle.chars || 0)} 字符`
                    : '空',
                ),
                (() => {
                  const info = data.recycle || {}
                  const current = Number(info.keepDays ?? 30)
                  const options = [0, 7, 30, 90, 180]
                  if (!options.includes(current)) options.push(current)
                  options.sort((a, b) => a - b)
                  return h(
                    'label',
                    { className: 'dmc-card-hint', title: info.locked ? '已被环境变量 DSH_MEMORY_RECYCLE_DAYS 固定' : '过期后自动彻底删除' },
                    '自动清理：',
                    h(
                      'select',
                      {
                        className: 'dmc-select dmc-select-mini',
                        value: String(current),
                        disabled: Boolean(info.locked),
                        onChange: async (event) => {
                          const days = Number(event.target.value)
                          // 改小天数会立刻永久删除过期条目：先 dryRun 问清楚，再让用户确认
                          let willPurge = 0
                          let titles = []
                          try {
                            const probe = await api('recycle.set', { days, dryRun: true })
                            willPurge = Number(probe.willPurge || 0)
                            titles = Array.isArray(probe.titles) ? probe.titles : []
                          } catch (error) {
                            setError(error)
                            return
                          }
                          if (!willPurge) {
                            await run('recycle.set', { days })
                            return
                          }
                          setConfirmAsk({
                            title: `保留 ${days} 天后会永久删除 ${willPurge} 条记忆，继续吗？`,
                            message: '这些条目已经超过新的保留天数，改完会立刻从回收站彻底删除，无法在面板里撤销。',
                            detail: titles.length ? `将被删除：${titles.join('、')}${willPurge > titles.length ? ' …' : ''}` : '',
                            confirmLabel: `永久删除 ${willPurge} 条`,
                            danger: true,
                            onConfirm: async () => {
                              await run('recycle.set', { days })
                            },
                          })
                        },
                      },
                      ...options.map((days) =>
                        h('option', { key: String(days), value: String(days) }, days === 0 ? '不自动清理' : `${days} 天`),
                      ),
                    ),
                  )
                })(),
                h(
                  'button',
                  {
                    className: 'dmc-btn',
                    disabled: !selected.length,
                    onClick: () =>
                      setConfirmAsk({
                        title: `恢复选中的 ${selected.length} 条记忆？`,
                        message: '恢复后会回到原来的文件夹；如果是启用状态，会重新参与注入。',
                        confirmLabel: '恢复',
                        onConfirm: async () => {
                          await run('item.restore', { ids: selected })
                          clearSelect()
                        },
                      }),
                  },
                  `恢复选中${selected.length ? `（${selected.length}）` : ''}`,
                ),
                h(
                  'button',
                  {
                    className: 'dmc-btn danger',
                    disabled: !selected.length,
                    onClick: () =>
                      setConfirmAsk({
                        title: `彻底删除选中的 ${selected.length} 条？`,
                        message: '这次会真的从 store.json 里删掉，回收站也找不回来。',
                        confirmLabel: '彻底删除',
                        danger: true,
                        onConfirm: async () => {
                          await run('recycle.purge', { ids: selected })
                          clearSelect()
                        },
                      }),
                  },
                  '彻底删除',
                ),
                h(
                  'button',
                  {
                    className: 'dmc-btn',
                    onClick: () =>
                      setConfirmAsk({
                        title: '清空回收站？',
                        message: `回收站里的 ${deletedItems.length} 条记忆会被永久删除，无法恢复。`,
                        confirmLabel: '清空回收站',
                        danger: true,
                        onConfirm: () => run('recycle.purge', { all: true }),
                      }),
                  },
                  '清空回收站',
                ),
                h('button', { className: 'dmc-btn', onClick: clearSelect }, '取消选择'),
              )
            : archiveMode && archivedItems.length
              ? h(
                  'div',
                  { className: 'dmc-bottom-bar' },
                  h('strong', null, `归档 ${archivedItems.length} 条`),
                  h(
                    'button',
                    {
                      className: 'dmc-btn',
                      disabled: !selected.length,
                      onClick: async () => {
                        await run('item.unarchive', { ids: selected })
                        clearSelect()
                      },
                    },
                    `还原选中${selected.length ? `（${selected.length}）` : ''}`,
                  ),
                  h('button', { className: 'dmc-btn', onClick: clearSelect }, '取消选择'),
                  h(
                    'span',
                    { className: 'dmc-card-hint' },
                    '归档的记忆不参与注入，也不会出现在 memory_search 结果里。',
                  ),
                )
            : selected.length
              ? h(
                  'div',
                  { className: 'dmc-bottom-bar' },
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
                  h('button', { className: 'dmc-btn', onClick: () => setTagging({ ids: selected }) }, '打标'),
                  h(
                    'button',
                    {
                      className: 'dmc-btn',
                      title: '按标题/正文/标签里的措辞重新判断锚点（会覆盖手动设置）',
                      onClick: () => run('anchor.reinfer', { ids: selected, force: true }),
                    },
                    '重判锚点',
                  ),
                  h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { enabled: false }) }, '停用'),
                  h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { enabled: true }) }, '启用'),
                  h('button', { className: 'dmc-btn', onClick: () => batchPatch(selected, { pinned: true }) }, '置顶'),
                  h(
                    'button',
                    {
                      className: 'dmc-btn',
                      onClick: () =>
                        setConfirmAsk({
                          title: `归档选中的 ${selected.length} 条？`,
                          message: '归档后它们不再占用注入额度，也不会出现在 memory_search 里，但内容完整保留。',
                          detail: '在左侧「归档」里可以随时还原。',
                          confirmLabel: '归档',
                          onConfirm: async () => {
                            await run('item.archive', { ids: selected })
                            clearSelect()
                          },
                        }),
                    },
                    '归档',
                  ),
                  selected.length >= 2
                    ? h(
                        'button',
                        {
                          className: 'dmc-btn',
                          onClick: () =>
                            setConfirmAsk({
                              title: `把选中的 ${selected.length} 条合并成一条？`,
                              message:
                                '会生成一条新的「精炼记忆」，正文按时间顺序拼接各条内容，标签取并集，原条目移入归档层可回溯。',
                              detail: '合并后可以继续编辑新条目的正文，把它改得更短更准。',
                              confirmLabel: '合并',
                              onConfirm: async () => {
                                await run('item.merge', { ids: selected })
                                clearSelect()
                              },
                            }),
                        },
                        '合并',
                      )
                    : null,
                  selected.some((id) => (data.items.find((item) => item.id === id) || {}).status === 'pending')
                    ? h(
                        'button',
                        {
                          className: 'dmc-btn primary',
                          onClick: () =>
                            setConfirmAsk({
                              title: `把这 ${selected.length} 条转为正式记忆？`,
                              message: '转正后它们会进入正式库，并按启用状态参与注入。',
                              confirmLabel: '全部转正',
                              onConfirm: async () => {
                                await run('item.confirm', { ids: selected })
                                clearSelect()
                              },
                            }),
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
                      onClick: () =>
                        setConfirmAsk({
                          title: `删除选中的 ${selected.length} 条记忆？`,
                          message: `这 ${selected.length} 条会先进入「回收站」，之后还能恢复。`,
                          detail: '确认后：从当前列表移除，但数据仍保存在 store.json 里。',
                          confirmLabel: '移入回收站',
                          danger: true,
                          onConfirm: async () => {
                            await run('item.delete', { ids: selected })
                            clearSelect()
                          },
                        }),
                    },
                    '删除',
                  ),
                  h('button', { className: 'dmc-btn', onClick: clearSelect }, '取消'),
                )
              : null,
          h(
            'div',
            { className: `dmc-list${view === 'list' ? ' dmc-listview' : ''}` },
            !recycleMode && sorted.length
              ? h(
                  'div',
                  { className: 'dmc-card-row', style: { marginBottom: '6px' } },
                  h('input', {
                    type: 'checkbox',
                    className: 'dmc-check',
                    checked: selected.length > 0 && selected.length === sorted.length,
                    onChange: (event) => (event.target.checked ? setSelected(sorted.map((item) => item.id)) : clearSelect()),
                  }),
                  h('span', { className: 'dmc-card-hint' }, '全选'),
                  h('span', { className: 'dmc-card-hint' }, '（勾选后底部会出现批量操作条；也可以直接把卡片拖到左侧文件夹）'),
                )
              : null,
            sorted.length ? sorted.map((item) => renderItem(item)) : emptyState(),
          ),
        ),
        menu ? menuNode() : null,
        capacityOpen
          ? h(CapacityDialog, {
              capacity: data.capacity,
              injection: data.injection,
              onClose: () => setCapacityOpen(false),
              onSetRatio: (value) => run('budget.set', { ratio: value }),
              onArchiveFolder: () => {
                setCapacityOpen(false)
                setFilter('__archived')
              },
              onFocusItem: (id) => {
                const target = (data.items || []).find((item) => item.id === id)
                if (!target) return
                setCapacityOpen(false)
                setFilter(target.groupId || '__ungrouped')
                setSelected([id])
              },
              onArchiveIds: async (ids) => {
                setCapacityOpen(false)
                await run('item.archive', { ids })
              },
            })
          : null,
        confirmAsk
          ? h(ConfirmDialog, {
              title: confirmAsk.title,
              message: confirmAsk.message,
              detail: confirmAsk.detail,
              confirmLabel: confirmAsk.confirmLabel,
              danger: confirmAsk.danger,
              onConfirm: confirmAsk.onConfirm,
              onClose: () => setConfirmAsk(null),
            })
          : null,
        tagging
          ? h(TagDialog, {
              count: tagging.ids.length,
              suggestions: data.tags,
              onClose: () => setTagging(null),
              onSubmit: async (tags) => {
                await run('item.batch', { ids: tagging.ids, patch: { addTags: tags } })
                clearSelect()
                setTagging(null)
              },
            })
          : null,
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
