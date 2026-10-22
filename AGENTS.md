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

## 本目录就是真值

- `C:\Users\20408\.dsh\profiles\desktop` 的 `node_modules\dsh-memory-center` 是指向本目录的 **junction**，
  所以本目录的代码就是运行时加载的代码。
- `client.js` / `index.js` 改完 → 用户刷新 Web GUI 页面即生效；`index.js`（host 半）改动需**重启 DSH**。
- 没有构建步骤：`index.js` 是 Node ESM（Host 半），`client.js` 是浏览器 bundle（`window.__ModuleLoader__.load`）。

## 版本更替与恢复

- 安装方式是 `link:`：任何宿主升级、市场刷新都不会覆盖本目录代码；市场也不会给 link 安装推在线更新（非桌面宿主生成的 `link:` 一律视为开发工作区）。
- 宿主升级后先跑一遍「自测」，再打开面板看有没有渲染/接口报错；client 半依赖宿主 web API，宿主大版本升级时按报错适配。
- 如果发现 `node_modules\dsh-memory-center` 不再是 junction（被换成了 npm 版真实目录），说明安装方式被换掉了：删掉该目录，重新 `New-Item -ItemType Junction` 指向本仓库，或在市场里按本地目录重装。
- 发版：去掉 `package.json` 的 `"private": true` → `npm version patch` → `npm publish`；市场按 npm latest 展示。本地开发仍可继续用 link，两者互不影响。
- 每次可见改动建议打 tag（如 `v0.2.0`）作为回滚点，tag 与提交一并推送。

## 本机网络注意（否则 push 一定失败）

- 本机 DNS 把 `github.com` 解析到 `20.205.243.166`，该 IP 在本网络**不可达**（`api.github.com` 正常）。
- 因此仓库本地 git 配置里有：

  ```
  http.curloptResolve = github.com:443:140.82.112.3
  ```

  若 `git push` 报连接超时，先 `git config --get http.curloptResolve` 确认这条还在；没了就重新设。
  140.82.112.3 有时也不通，可临时换 `-c http.curloptResolve=github.com:443:140.82.113.3`（或 `.114.3`）逐个试。
- 需要直接访问 github.com 的 HTTP 接口时，用 `curl --resolve github.com:443:140.82.112.3 ...`。

## 自测

```bash
node --check index.js
node --check client.js
node dev/smoke-client.mjs    # 期望输出 SMOKE OK
node dev/paths.test.mjs      # 打印数据目录探测链
node dev/host-smoke.mjs      # 宿主半 API 与目录切换（临时目录）
node dev/merge.test.mjs      # 两台设备的条目级合并规则
node dev/sync.test.mjs       # WebDAV 后端（本地假服务器）
node dev/sync-git.test.mjs   # Git 后端（本地裸仓库扮远端，模拟两台设备）
```

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
