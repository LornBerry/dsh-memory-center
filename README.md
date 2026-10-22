# dsh-memory-center（记忆中心）

DSH 的「长期记忆」面板插件：**你自己看得见、改得动、决定要不要给模型用**。

- 数据位置：**自动探测**——按「`DSH_MEMORY_DIR` 环境变量 → 面板里记住的选择 → 已有 `store.json` 的老目录 → 本机 DSH 数据根 `<DSH_HOME>/memory` → 各盘符 `\dsh-data\memory` → `~/.dsh/memory`」的顺序找，都不行才落临时目录兜底；面板「存储位置」里可以随时改。没有写死任何盘符。
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
| 主面板 →「存储位置」 | 存储设置 | 设置页顶部与主面板左栏底部的库路径都可点即复制，旁边「更改…」打开此弹窗；弹窗里路径输入框可直接编辑，旁边有「复制」和「选择…」；改完点「应用」才切换（默认把现有记忆复制过去），选择记在数据目录内的 `config.json` |
| 主面板 →「云端同步」 | 同步设置 | 三选一：不绑定 / Git 仓库 / WebDAV 网盘。默认「不绑定」，记忆只在本机 |

## 跨设备（可选，默认关闭）

记忆本体永远在本机的数据目录里，云端只是「多设备共用同一份」。三种选择：

| 选项 | 适合谁 | 代价 |
| --- | --- | --- |
| 不绑定（默认） | 只在一台机器用，或者接受手动导出导入 | 换设备看不到；一个字节都不外发 |
| **Git 仓库** | 有 GitHub / Gitee / 自建 git 的人 | 需要建一个私有仓库、配一次凭据。换来完整历史、可回滚、冲突按条目合并 |
| **WebDAV 网盘** | 坚果云 / Nextcloud / 群晖用户 | 没有历史版本，只有一个 `store.json`；撞车时后写的赢 |

- 开了之后：打开面板时自动拉取（可关），改动后 4 秒自动上传（可关），也可以随时点「立即同步」。
- 冲突规则：**按条目**合并——同一条记忆两边都改，`updatedAt` 新的赢；删除会记墓碑，不会在另一台设备上「复活」。
- 大小：一条记忆几百字节，一万条也就几 MB；Git 侧只存增量，不会越存越满。
- Git 侧的实现细节：数据目录下会多出 `.git-sync/repo`（影子仓库），`config.json` 和 `sessions.json` 不入库（前者含本机凭据，后者只对本机会话有意义）。
- WebDAV 的账号密码存在本机 `config.json` 里（明文）；`.gitignore` 已经把 `config.json` 排除在 Git 之外，但走 WebDAV 时它就在本机文件里。
- 新装第一次打开时，「待确认」里会有一条「跨设备记忆需要开同步」的提醒，说明去哪绑、不绑也能用；它不参与注入，删掉也不会补回，绑定入口一直在面板工具栏和设置页里。

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
- 判断顺序是「关键词为主、自判为辅」：用户明说「记一下」直接写；命中偏好/固定事实/拍板决策的关键词就写（只排除明显只对这一次有效的临时状态）；没命中关键词再四问自判是否跨会话有用。单次对话最多 3 条，标题写结论、正文带具体值与原因。

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
| `DSH_MEMORY_DIR` | 自动探测 | 显式指定数据目录（设了就最高优先，面板里锁为只读） |
| `DSH_MEMORY_CONFIG` | `<数据目录>/config.json` | 记录面板里选择的配置文件路径（默认就放在数据目录里，切换目录时新老两处都会更新） |
| `DSH_MEMORY_MAX_CHARS` | `12000` | 单次注入上限（超出截断） |

自动探测的顺序：`DSH_MEMORY_DIR` → 候选目录里已有的 `config.json`（记住的选择，不可写则跳过）→ 已经存了 `store.json` 的老目录 → 已存在的 `<盘符>:\dsh-data\memory`（本机 DSH 数据在这个盘上就跟它放一起）→ `<DSH_HOME>/memory` → 各盘符 `\dsh-data\memory` → `~/.dsh/memory` → 系统临时目录。`<DSH_HOME>` 取环境变量 `DSH_HOME`，其次从 `DSH_PROFILE_DIR` 上溯两级，最后退回 `~/.dsh`。
想先看看会选到哪，可以跑：`node dev/paths.test.mjs`；宿主半的读写/切换行为可以跑：`node dev/host-smoke.mjs`（用临时目录，不碰真实记忆库）。

## 卸载

`plugin_manager` → `remove_bundle` → `dsh-memory-center`；数据目录自行保留或删除。

## 开发与自测

- 本包以 `link:` 方式装进 profile，改 `client.js` / `index.js` 后刷新页面即可（host 半改动需重启 DSH 生效）。
- 离线自测（不需要浏览器、不需要 react，Node 22+ 即可）：

  ```bash
  node dev/smoke-client.mjs
  ```

  它内置一个微型 hook 渲染器，逐个渲染各插槽组件并检查注册拓扑与页面文案，输出 `SMOKE OK` 表示通过。
- 其余离线测试（都不联网、不碰真实记忆库）：

  ```bash
  node dev/paths.test.mjs    # 数据目录会探测到哪
  node dev/host-smoke.mjs    # 宿主半 API 与目录切换
  node dev/merge.test.mjs    # 两台设备的条目级合并规则
  node dev/sync.test.mjs     # WebDAV 后端（本地假服务器）
  node dev/sync-git.test.mjs # Git 后端（本地裸仓库扮远端，模拟两台设备）
  ```
- 接口自测（端口换成你当前 DSH Web GUI 的端口）：

  ```bash
  curl -X POST http://127.0.0.1:<port>/dsh-memory/api -H "content-type: application/json" -d '{"op":"state"}'
  ```

  可用 op 见 `index.js` 的 `switch (op)`：`state` / `group.*` / `item.*` / `session.*` / `import.preview` / `import.apply` / `export` / `search` / `config.get` / `config.set` / `sync.get` / `sync.set` / `sync.now`。
- 需求与验收标准：见 [SPEC.md](./SPEC.md)。
