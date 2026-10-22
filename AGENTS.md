# AGENTS.md

给在本仓库工作的编码 Agent 的约定。

## 用户要求（长期有效）

1. **每次改动都要提交并推送**：改完代码 → `git add -A && git commit -m "..." && git push`。
   用户明确要求：“每次改动都得推送哦”，本仓库不允许留下未提交/未推送的改动。
2. 用户是中文交流，回复用中文；专业性优先，不要堆砌客套。

## 本目录就是真值

- `C:\Users\20408\.dsh\profiles\desktop` 的 `node_modules\dsh-memory-center` 是指向本目录的 **junction**，
  所以本目录的代码就是运行时加载的代码。
- `client.js` / `index.js` 改完 → 用户刷新 Web GUI 页面即生效；`index.js`（host 半）改动需**重启 DSH**。
- 没有构建步骤：`index.js` 是 Node ESM（Host 半），`client.js` 是浏览器 bundle（`window.__ModuleLoader__.load`）。

## 本机网络注意（否则 push 一定失败）

- 本机 DNS 把 `github.com` 解析到 `20.205.243.166`，该 IP 在本网络**不可达**（`api.github.com` 正常）。
- 因此仓库本地 git 配置里有：

  ```
  http.curloptResolve = github.com:443:140.82.112.3
  ```

  若 `git push` 报连接超时，先 `git config --get http.curloptResolve` 确认这条还在；没了就重新设。
- 需要直接访问 github.com 的 HTTP 接口时，用 `curl --resolve github.com:443:140.82.112.3 ...`。

## 自测

```bash
node --check index.js
node --check client.js
node dev/smoke-client.mjs   # 期望输出 SMOKE OK
```

`dev/smoke-client.mjs` 是一个不依赖浏览器/react 的微型渲染器，会渲染各插槽组件并断言注册拓扑与关键文案。

## 数据位置

- 记忆数据：默认 `E:\dsh-data\memory\`（`store.json` / `sessions.json`），可在面板「存储位置」里改。
- 插件自身配置：`E:\dsh-data\memory-center\config.json`（记录用户选定的数据目录）。
- 不要把任何记忆数据写进仓库或 C 盘。
