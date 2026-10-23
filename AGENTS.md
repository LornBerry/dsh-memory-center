# AGENTS.md

给在本仓库工作的编码 Agent 的约定。

## 用户要求（长期有效）

1. **每次改动都要提交并推送**：改完代码 → `git add -A && git commit -m "..." && git push`。
   用户明确要求：“每次改动都得推送哦”，本仓库不允许留下未提交/未推送的改动。
2. **推送之后再看插件市场要不要动**：市场条目是 `awesome-dsh-plugin/awesome-dsh-plugin`
   仓库里的 `data/plugins/LornBerry__dsh-memory-center.yml`，只有这些内容会进市场：
   `url` / `name` / `category` / `description.en` / `description.zh`。
   - 只改代码/文档 → 市场不用动（市场只存元数据，不存代码）。
   - 改了**包名、仓库地址、分类、一句话简介**（或功能范围变化到描述已不准确）→ 必须同步市场：
     fork 里改那一个 yml → 提一个只改该文件的 PR（README 由市场仓库脚本生成，不要手改）。
   - 描述必须如实，不允许加“最好用”之类的宣传语。
3. 用户是中文交流，回复用中文；专业性优先，不要堆砌客套。

## 本目录就是源码真值

- 本目录是**源码**；profile 里的 `node_modules\dsh-memory-center` 是 `node dev/release.mjs` 打出的 tgz 的**固定副本**。
- 也就是说：改完本目录 ≠ 线上生效，必须重新 `release.mjs` + `install_bundle`（见下一节）。
- `client.js` / `index.js` 改完并重新安装 → 用户刷新 Web GUI 页面即生效；`index.js`（host 半）改动需**重启 DSH**。
- 没有构建步骤：`index.js` 是 Node ESM（Host 半），`client.js` 是浏览器 bundle（`window.__ModuleLoader__.load`）。

## 安装方式：固定副本（tgz），不是 link

- profile 里 `node_modules\dsh-memory-center` **必须是一份真实目录副本**（从 tgz 解出来），不是指向本目录的 junction。
- 为什么改（2026-10-23 事故）：早期用 `link:` 安装，工作区被清空/移动后 DSH 下次启动找不到插件，面板整块消失，市场里也显示 missing。
  改成 tgz 固定副本后，工作区怎么动都不影响已装好的版本；代价是**改完必须重新打包安装**才会生效。
- 发版/更新一条命令：`node dev/release.mjs`（自测 → 改版本 → 打包到 `E:\dsh-data\memory-center-dist` → 打印安装命令），
  然后 `plugin_manager action=install_bundle target=<打印出来的 tgz>`。
- 装完 `node dev/doctor.mjs --url <当前 Web 地址>` 复核：目录是真实副本、版本一致、四个核心文件哈希一致、接口 200、数据可写。
- 本地开发时可以直接改本目录再跑 `release.mjs`；不要改 profile 里那份副本（会被下次安装覆盖）。
- 宿主升级后先跑「自测」+ `doctor.mjs`，再打开面板看有没有渲染/接口报错；client 半依赖宿主 web API，宿主大版本升级时按报错适配。
- 如果发现安装目录又变成 junction（有人手工重装成 link），删掉该目录后按 tgz 重装：
  删除 junction 必须用 `[System.IO.Directory]::Delete($path, $false)`，**不要** `Remove-Item -Recurse`（会顺着链接把工作区删掉）。
- 发 npm 包（可选）：去掉 `"private": true` → `npm version patch` → `npm publish`；市场按 npm latest 展示，与本地 tgz 安装互不影响。
- 每次可见改动打 tag（`v0.4.0` 这样）作为回滚点，tag 与提交一并推送。

## Git 元数据丢失时的恢复（2026-10-23 遇到过一次）

- 症状：`git status` 报 `fatal: not a git repository`，但 `.git\objects` / `.git\refs` 里的对象还在（缺 `HEAD`/`config`/`index`）。
- 恢复（不会改动工作区文件）：

  ```powershell
  git init
  git remote add origin https://github.com/LornBerry/dsh-memory-center.git
  git config http.curloptResolve github.com:443:140.82.112.3
  git fetch origin main:refs/remotes/origin/main --tags
  git reset origin/main      # 混合重置：索引对齐远端，文件不动
  git status                 # 此时列出的就是你相对远端真正改过的东西
  ```

- 内存里有记忆库文件、但工作区是唯一代码副本：**先恢复 git 再决定提交什么**，不要 `git checkout -- .` 把未推送的改动冲掉。


## 本机网络注意（否则 push 一定失败）

- 本机 DNS 把 `github.com` 解析到 `20.205.243.166`，该 IP 在本网络**不可达**（`api.github.com` 正常）。
- 因此仓库本地 git 配置里有：

  ```
  http.curloptResolve = github.com:443:140.82.121.3
  http.version = HTTP/1.1
  ```

- **`http.version = HTTP/1.1` 是必须的**：这套网络里 git 默认走 HTTP/2，握手后会被连接重置（`Recv failure: Connection was reset`、
  `schannel: server closed abruptly (missing close_notify)`、`Failed to connect ... after 21034 ms`）。
  同样的 IP 用 `curl.exe --resolve github.com:443:<ip> https://github.com/` 能拿到 200，用 HTTP/1.1 推就能成功——所以报错先看这条配置在不在。
- 若 `git push` 报连接超时，按顺序排查：
  1. `git config --get http.version`（应为 `HTTP/1.1`）；
  2. `git config --get http.curloptResolve`（IP 会变，过几天可能失效）；
  3. 换 IP：`140.82.121.3` / `140.82.114.3` / `140.82.113.3` / `140.82.112.3` 逐个试
     `git -c http.curloptResolve=github.com:443:<ip> push origin main`，成功后就 `git config http.curloptResolve ...` 记下来。
- 需要直接访问 github.com 的 HTTP 接口时：`curl --resolve github.com:443:140.82.121.3 ...`。

## 自测

```bash
node --check index.js
node --check client.js
node dev/encoding.test.mjs   # 无 BOM / 无 U+FFFD，package.json 合法（务必先跑，见下）
node dev/smoke-client.mjs    # 期望输出 SMOKE OK
node dev/paths.test.mjs      # 打印数据目录探测链
node dev/host-smoke.mjs      # 宿主半 API 与目录切换（临时目录）
node dev/merge.test.mjs      # 两台设备的条目级合并规则
node dev/sync.test.mjs       # WebDAV 后端（本地假服务器）
node dev/sync-git.test.mjs   # Git 后端（本地裸仓库扮远端，模拟两台设备）
node dev/recycle.test.mjs    # 回收站：软删除 / 恢复 / 彻底删除写墓碑 / 批量打标 / 到期自动清理
node dev/fields.test.mjs     # 字段往返：读写一圈后字段不能丢（白名单重建曾丢过 deletedAt/archivedAt）
node dev/budget.test.mjs     # 注入预算与压缩线：默认 80%、整条不截断、阈值可调
node dev/search.test.mjs     # 检索：分词 / BM25 / 同义词扩展 / 片段 / 余弦工具
node dev/anchor.test.mjs     # 锚点影响注入：完全锚点必进、权重锚点靠前
node dev/anchor-infer.test.mjs # 锚点初判规则：硬性/偏好/普通事实、优先级、理由文案
node dev/backups.test.mjs    # 备份生命周期：同种只留 5 份、老位置自动迁入、清理不误伤数据文件
node dev/session-default.test.mjs # 新会话默认策略（ask/none/all/custom）与注入上限可调（budget.set maxChars）
node dev/topic.test.mjs      # 同主题新旧标注：分组、旧版提示、检索一致、归档/停用不参与
node dev/doctor.mjs --url http://127.0.0.1:<端口>   # 安装与运行状态自检
```

改完注入/压缩逻辑，至少跑 `budget.test.mjs` + `anchor.test.mjs`：前者守住"压缩线 80%、整条不切开"，后者守住"完全锚点必进正文"。

### 写文件的编码纪律（踩过的坑，必须守）

- **禁止**用 PowerShell 的 `>` / `>>` / `Set-Content` / `Out-File` / `Get-Content -Raw` 往返 UTF-8 文件：
  Windows PowerShell 5.1 会写成 UTF-16 或带 BOM，中文变乱码，插件会直接消失。
- 改文件只用 `write` / `edit` 工具，或用 Node 的 `fs.writeFileSync(path, text, 'utf8')`。
- 一旦 `package.json` 带上 UTF-8 BOM，DSH 的插件管理器会报
  `Unexpected token '\uFEFF' ... is not valid JSON`，插件从列表里变成 missing、面板整块消失。
  出现这个症状先跑 `node dev/encoding.test.mjs`，再 `plugin_manager` 重新 `set_bundle` 启用一次。
- 提交前跑一遍 `dev/encoding.test.mjs`，它是这类事故的唯一自动化防线。

`dev/smoke-client.mjs` 是一个不依赖浏览器/react 的微型渲染器，会渲染各插槽组件并断言注册拓扑与关键文案。
改完同步逻辑，至少跑 `merge.test.mjs` + `sync-git.test.mjs`：它们覆盖墓碑不复活、冲突取新、推送 fast-forward 三种易回归的情形。

## 数据位置

- 记忆数据：**自动探测**，不写死盘符。顺序见 `lib/paths.js`：
  `DSH_MEMORY_DIR` → 配置文件里的选择 → 已存在 `store.json` 的老目录 → 已存在的
  `<盘符>:\dsh-data\memory` → `<DSH_HOME>/memory` → 各盘符 `<盘符>:\dsh-data\memory` →
  `~/.dsh/memory` → 临时目录兜底。
  本机 DSH 数据根在 E 盘，所以探测结果是 `E:\dsh-data\memory`，但这不是硬编码。
- 插件自身配置：`<数据目录>/config.json`（记录选定的数据目录与 `sync` 同步设置；不随 Git 入库）。
- 不要把任何记忆数据写进仓库；也不要为了「能跑」给某台机器硬编码路径。
- 云端同步默认关闭；`lib/sync.js` 里 `.gitignore` 已排除 `config.json`/`sessions.json`，WebDAV 凭据只存本机。
