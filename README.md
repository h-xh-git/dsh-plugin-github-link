# dsh-plugin-github-link

把 GitHub 接进 **DSH（DeepSeek Harness）Web GUI**：设备码登录、浏览与克隆仓库、把本地代码**上传/更新**到 GitHub。

> **English** — A DSH plugin that links a GitHub account to the web GUI: OAuth Device Flow
> (or a PAT), browse/search repositories (private included), inspect branches and commits,
> `git clone` into a workspace, and **upload / update** local code. Pushes are
> **fast-forward only** — never a force push, never a deleted remote file.
> Open **设置 → GitHub 仓库** after installing. MIT licensed.

---

## 它做什么

- **登录**：OAuth 设备码（只要 Client ID），或粘贴 Personal Access Token；凭据只存在主机上
- **浏览**：仓库列表（含私有）、搜索、筛选、翻页；详情有分支与最近提交
- **克隆**：`git clone` 到 DSH 已注册的工作区，目标越界/已存在会被拒绝
- **上传**：把目录推成一个新仓库，或推给已有的空仓库
- **更新**：提交本地改动并推送，只做快进，远端有新提交就拒绝
- **上传到子目录**：把本地文件夹写进已有仓库的某个路径（如 `docs/site/`），不碰其他文件
- **拉取**：落后时「仅快进」；分叉时「叠加」（保留双方内容）
- **写操作有闸**：先 `① 预览` 看改了什么、体积多大、哪些像密钥，确认后再 `② 执行`

---

## 安装

需要：**DSH**（桌面版或 Web 版）、**Node ≥ 18**（证书自愈需 ≥ 24.8）、**git ≥ 2.31**。

**方式 A（推荐）**：在 DSH 的 **设置 → 插件** 里从 Git 地址或本地路径安装，然后启用。

**方式 B（开发用，改源码即生效）**：

```powershell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add link:D:\path\to\dsh-plugin-github-link
# 再把 "dsh-plugin-github-link" 加进该 profile package.json 的 dsh.profile.bundles
```

> 改代码何时生效：**客户端**（`lib/client.js`）刷新浏览器即可；**宿主**（`lib/*.js` 其余）只在 DSH 启动时加载，必须重启 DSH。

---

## 快速开始

1. 打开 <https://github.com/settings/applications/new>
2. Homepage URL 填 `http://127.0.0.1:19387`
3. **勾选 `Enable Device Flow`** ← 不勾选无法登录
4. 复制 **Client ID**，回到 **设置 → GitHub 仓库** 粘贴保存
5. 点「用 GitHub 设备码登录」，按提示在浏览器打开验证页、输入验证码

设备码 **15 分钟有效**，期间保持页面打开、不要重启 DSH。登录成功后头像与仓库列表会出现在同一页。

> 不想建 OAuth App：展开「改用 Personal Access Token」，粘贴带 `repo` scope 的 token 即可。
> Client ID 也可用环境变量 `DSH_GITHUB_CLIENT_ID` 或 `cordis.patch.yml` 的 `config.clientId` 预置。

---

## 使用

### 浏览与克隆

搜索/筛选/翻页找到仓库 → 点一行看详情（分支、最近提交）→ 选工作区和目录名 → 克隆。

本地已有该仓库的在列表里会标出来，详情页还会给「**去推送这个目录的改动**」按钮，直接跳到上传/更新。

### 上传与更新

先选模式，字段会自动预填（分支来自 checkout、新仓库名来自目录名）：

| 模式 | 做什么 |
|---|---|
| **推送更新** | 提交本地改动并推送到该工作区自己的 origin（只做快进） |
| **首次上传** | 把选中的目录推成一个仓库：新建（默认私有）或推到已有的**空**仓库 |
| **上传到仓库子目录** | 把本地文件夹写进已有仓库的某个路径，如 `docs/site/` |

「上传目录」可选工作区里的子文件夹（逐层进入、`⬆ 上一层` 退回）。点 `① 预览` 会报出：待提交文件数、目录大小、风险路径、阻塞原因。

### 落后或分叉时拉取

推送被拒绝时，卡片会自动出现拉取按钮：

| 按钮 | 何时用 | 结果 |
|---|---|---|
| ⬇ 拉取远端更新（仅快进） | 只是落后 | 严格快进，不满足就拒绝 |
| 叠加到远端最新（保留本地改动） | 本地远端都前进过 | 以远端最新为父提交建一个新提交，**两边文件都不丢** |

工作区有未提交改动时会先拒绝，并提供一键「**先提交这些改动，再叠加**」。

> 三种模式都**不写远端、不删本地文件**；被替换的旧提交仍在 `git reflog` 里。

---

## 网络与代理

**症状：浏览器能开 github.com，插件却报 `fetch failed`。**

- **HTTPS 中间人**（SteamTools、杀软、公司代理）：它们的根证书在 Windows 证书库里，浏览器信、Node 不信。插件检测到证书失败会**自动改用系统证书库并重试一次**，无需配置。Node < 24.8 请改用 `NODE_OPTIONS=--use-system-ca` 或 `NODE_EXTRA_CA_CERTS`。
- **确实需要代理**：Node 的 `fetch` 不读系统代理。在面板的 **网络代理** 里填 `http://127.0.0.1:7890`（Clash 的 HTTP 端口；v2rayN 通常是 `10809`），点「测试连接」→ 保存。之后 GitHub API 与 `git clone` 都走它；留空保存即恢复直连。

代理优先级：`config.proxy` > 面板输入框 > 环境变量（`DSH_GITHUB_LINK_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`）> 直连；写 `none` 可显式关闭。只支持 HTTP/HTTPS 代理（SOCKS 会提示改用 HTTP 端口），`NO_PROXY` 生效，密码只以 `***` 出网。

没把握时点面板里的「**测试连接**」——它会真的请求一次 `api.github.com/meta`，不消耗任何凭据。

---

## 安全

- scope 是 `repo read:user`，`repo` 是读私有仓库的最小 scope
- token 只存在主机（`~/.dsh-github-link/credentials.json`，0600，原子写入），**浏览器拿不到**
- token 与提交身份都走子进程环境变量：不进 argv、不进 shell history、不进 `.git/config`
- **不强制覆盖**：没有 `--force`/`reset`/`clean`；「上传到子目录」也绝不删除远端文件
- 写操作前扫描 `.env`/`*.pem`/`id_rsa`/`node_modules` 等并要求确认；> 50 MB 警告，> 200 MB 拒绝
- POST 端点要求 JSON content-type（挡 CSRF）；克隆/发布路径限制在已注册工作区内
- **Host 必须是回环地址**（否则 403），挡 DNS rebinding 读取 `/state` 或驱动写操作；确实要经反向代理访问时用 `config.allowedHosts: ["你的主机名"]` 放行，`["*"]` 可关闭校验（不安全）
- ⚠️ 路由不带额外鉴权，请**不要把 DSH 暴露到局域网/公网**

---

## 故障排查

| 症状 | 处理 |
|---|---|
| `无法连接 GitHub：fetch failed` | 展开面板的「网络代理」，先点「测试连接」（证书问题会自动修好） |
| `验证码已过期` | 超过 15 分钟或中途重启了 DSH，重新登录即可 |
| `本地落后远端 N 个提交` | 点「⬇ 拉取远端更新（仅快进）」 |
| `无法快进` / `已分叉` | 点「叠加到远端最新（保留本地改动）」 |
| `工作区有未提交的改动` | 点「先提交这些改动，再叠加」 |
| `目标已存在：…`（409） | 克隆目标目录已存在，换名字或先移走 |
| `目录里有可能不该上传的路径` | 勾选确认，或先加 `.gitignore` |
| 面板空白 / 槽位没出现 | 看 DevTools 里 `[github-link]` 日志；重启 DSH 后刷新 |

---

## 限制

- 只有 **github.com**（不含 GitHub Enterprise Server）
- 代理只支持 **HTTP/HTTPS**（不支持 SOCKS）
- 系统证书库自愈需要 **Node ≥ 24.8**
- 克隆遇到已存在目录直接报错，不做 pull/合并；仓库列表是页码分页（每页 30）
- 「叠加」对同名文件以本地内容为准，**不做自动三方合并**（需要时用 `merge` 模式或手工处理）
- **没有给 Agent 暴露工具**，只有宿主路由 + Web 界面
- UI 文案硬编码简体中文，未接 `ctx.locale`
- 主要在 Windows 上验证；Linux/macOS 未实测

---

## 开发者

```powershell
npm run verify     # 宿主 76 项 + 客户端 42 项，全部不联网、不碰真实凭据
```

宿主套件用假 ctx/假 webServer/mock fetch 跑全部路由，并用**真实 git + 本地 bare 仓库**验证上传/推送/拉取的语义（含非快进拒绝、子目录上传只改目标路径、叠加保留双方文件）；客户端套件用 React 垫片做无头渲染。

```
lib/
  index.js     宿主入口（inject=['webServer']，apply 永不抛异常）
  routes.js    /github-link/* 路由与调度
  github.js    GitHub REST + Device Flow + 系统证书库回退
  proxy.js     代理解析 + 零依赖 CONNECT 隧道 fetch
  store.js     凭据存储与 publicState()
  clone.js     git clone、token→env、redact、路径边界
  publish.js   上传/更新/拉取（init·commit·ff-only push·read-tree 叠加·敏感路径扫描）
  client.js    手写客户端模块（window.__ModuleLoader__.load，无需构建）
```

运行时**零依赖**（只用 Node 内置模块）；客户端是 classic script，改完不用打包。

宿主端点都在 `/github-link` 下，**响应体从不包含 token**：

| 方法 | 路径 |
|---|---|
| GET | `/health`、`/state`、`/repos`、`/repo`、`/workspaces`、`/local`、`/local/dirs`、`/device/poll` |
| POST | `/config`、`/proxy`、`/proxy/test`、`/token`、`/logout`、`/device/start`、`/clone` |
| POST | `/publish/plan`、`/publish/apply`、`/publish/pull`（`ff` / `onto` / `merge`） |

运行中自检（PowerShell 里请用 `curl.exe`，`curl` 是 `Invoke-WebRequest` 的别名）：

```powershell
curl.exe http://127.0.0.1:19387/github-link/state
curl.exe -X POST http://127.0.0.1:19387/github-link/proxy/test -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:7890"}'
```

约定：宿主 `apply` 永不抛异常；浏览器永远拿不到 token/代理密码；git 只走环境变量注入；提交前跑 `npm run verify`，改 UI 请同步 `test/verify-client.mjs` 的 hook 下标表。

---

## 许可证

[MIT](LICENSE) © 2026 h-xh-git · 欢迎 issue / PR
