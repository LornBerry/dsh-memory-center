# dsh-memory-center（记忆中心）

DSH 的「长期记忆」面板插件：**你自己看得见、改得动、决定要不要给模型用**。

- 数据位置：默认 `E:\dsh-data\memory\`（`store.json` + `sessions.json`），可在面板里改；不写 C 盘，也可用 `DSH_MEMORY_DIR` 覆盖。
- 代码位置：本目录（本地 bundle，通过 `plugin_manager install_bundle` 安装）。
- 依赖：无。不联网、不调外部 API、不需要 token；只有一个本地 JSON 存储。

## 安装

1. 克隆到本机任意目录：

   ```bash
   git clone https://github.com/LornBerry/dsh-memory-center.git
   ```

2. 用 DSH 的插件管理装它：`plugin_manager`，`action=install_bundle`，`target` 填上一步目录的绝对路径。
   装完 profile 的 `package.json` 里会多一条 `link:` 依赖，之后改代码刷新页面即可生效。

3. 刷新 Web GUI：侧栏出现「记忆」，设置里出现「记忆库」。

## 你会看到什么

| 位置 | 组件 | 作用 |
| --- | --- | --- |
| 左侧栏 | 「记忆」文字入口 | 打开「记忆中心」主面板（收起侧栏时这行只有一个「记忆」小牌子） |
| 设置 → 记忆库 | 设置内页 | 同一个记忆库的完整管理界面（嵌入版，隐藏「返回对话」） |
| 输入框左侧 | 「记忆」chip | 显示本会话加载了几条；点开弹层可一键切 不加载 / 全部 / 某个文件夹（直接整组带入） |
| 输入框上方 | 记忆卡片 | **新会话**（还没决定时）出现：「选文件夹…」弹层一下就整组加载，不用一条条勾 |
| 主面板 | 资源管理器式 | 左栏文件夹、右栏条目；拖拽卡片到文件夹即移动、勾选多选后批量移动/停用/删除、右键或悬停「…」出菜单、顶部面包屑回上级 |
| 主面板 →「存储位置」 | 存储设置 | 设置页顶部与主面板左栏底部的库路径都可点即复制，旁边「更改…」打开此弹窗；弹窗里路径输入框可直接编辑，旁边有「复制」和「选择…」；改完点「应用」才切换（默认把现有记忆复制过去），选择记在 E:\dsh-data\memory-center\config.json |

## 关键行为

1. **像 Windows 文件夹那样整理**：左栏点文件夹进入（面包屑可点回「记忆」）；把卡片拖到左栏文件夹 = 移动；勾选多条 = 批量条（移动到 / 停用 / 启用 / 置顶 / 转正 / 加入本会话 / 删除）；文件夹行悬停出「…」、右键也有菜单（带入本会话 / 重命名 / 上移 / 下移 / 删除）。
2. **每个新会话都问一次**：没有决定过的会话不会注入任何记忆，输入框上方会出现卡片让你选。选过之后不再问。
3. **按文件夹选**：多项目并行时不用一条条挑——新会话卡片「选文件夹…」、输入框「记忆」弹层里的文件夹按钮、面板文件夹行的「带入」，三处都是一下点中整个文件夹（下一轮生效）。
4. **中途导入**：chip 弹层「导入记忆…」或面板工具栏「导入」，都支持粘贴 JSON、合并预览、重复跳过。
5. **模型写入需你确认**：模型调用 `memory_write` 写入的条目固定落在「未归类」+「待确认」；点左栏「待确认」页签，顶部有「全部转正 / 存放到…并全部转正 / 全部删除」兜底，单条也可以右键「存放到文件夹」+「转正」。转正后才参与注入。
6. **注入内容可见**：每次注入以一条消息出现在对话里（就是你现在看到的这段），面板里也能「预览注入」查看全文。
7. **手动整理**：文件夹改名/上移下移/删除（条目移入未归类或一起删）、条目移动文件夹、置顶、停用、标签自由编辑、搜索、导出 JSON / Markdown。

## 模型侧工具

- `memory_search`：检索已启用的记忆（标题 / 正文 / 标签子串）。
- `memory_write`：写入候选记忆。**新记忆一律进「未归类」+「待确认」**，模型不能替你分类；你在面板里右键条目「存放到文件夹」即可。

## 数据格式（`store.json`）

```json
{
  "version": 1,
  "groups": [{ "id": "g-xxxx", "name": "项目约定", "order": 0, "createdAt": "..." }],
  "items": [{
    "id": "m-xxxx", "title": "...", "body": "...", "tags": ["约束"],
    "groupId": "g-xxxx", "enabled": true, "pinned": false,
    "status": "active", "source": "manual", "order": 0,
    "createdAt": "...", "updatedAt": "..."
  }]
}
```

`sessions.json` 记录每个会话的选择：`{ "<sessionId>": { "mode": "none|all|custom", "groupIds": [], "itemIds": [], "decidedAt": "..." } }`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MEMORY_DIR` | `E:\dsh-data\memory` | 数据目录（面板里可选，设了环境变量则以它为准，面板锁为只读） |
| `DSH_MEMORY_MAX_CHARS` | `12000` | 单次注入上限（超出截断） |

## 卸载

`plugin_manager` → `remove_bundle` → `dsh-memory-center`；数据目录自行保留或删除。

## 开发与自测

- 本包以 `link:` 方式装进 profile，改 `client.js` / `index.js` 后刷新页面即可（host 半改动需重启 DSH 生效）。
- 离线自测（不需要浏览器、不需要 react，Node 22+ 即可）：

  ```bash
  node dev/smoke-client.mjs
  ```

  它内置一个微型 hook 渲染器，逐个渲染各插槽组件并检查注册拓扑与页面文案，输出 `SMOKE OK` 表示通过。
- 接口自测（端口换成你当前 DSH Web GUI 的端口）：

  ```bash
  curl -X POST http://127.0.0.1:<port>/dsh-memory/api -H "content-type: application/json" -d '{"op":"state"}'
  ```

  可用 op 见 `index.js` 的 `switch (op)`：`state` / `group.*` / `item.*` / `session.*` / `import.preview` / `import.apply` / `export` / `search` / `config.get` / `config.set`。
- 需求与验收标准：见 [SPEC.md](./SPEC.md)。
