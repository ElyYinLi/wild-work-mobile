# 维护手册

给后续接手的人（或 AI）看的。目标是：**上游 wild-work 改版时，能在不重读整个上游代码库的前提下完成同步。**

---

## 0. 先理解边界，别走错路

| 想法 | 为什么不行 |
|------|-----------|
| 「把 Go 代码交叉编译成 Android 二进制，塞进 APK」 | 上游依赖 `energye/systray`（桌面托盘）和 GTK/X11 绑定，Android 上跑不起来；而且这样等于 fork 上游，之后每次上游更新都要重放补丁 |
| 「让 wild-work 开后端 CORS，前端跨源调 API」 | 鉴权是 HttpOnly Cookie + `SameSite`，跨源必失败；且要改上游代码 |
| 「WebView 直接加载 `http://电脑IP:7863`」 | 加载的是上游原面板，不是本项目的 UI；要做 UI 就失去意义 |
| 「把 UI 塞进 wild-work 的 `cmd/wild-work/web/`」 | 那是 `//go:embed`，必须重编译上游；每次上游更新都要重新合并 |

**唯一正确的形态**：壳内 **本地反向代理 + 内嵌 UI**，两者同源在 `127.0.0.1:17863`。上游二进制完全不动。

> 这条是架构红线。改动前先确认没有破坏「同源 + 零上游改动」这两个不变量。

---

## 1. 数据流

```
mobile-ui/app.js
   │  fetch('/api/state' | '/api/account/*' | ...)      ← 相对路径，同源
   ▼
127.0.0.1:17863  (壳内代理)
   ├─ path 不以 /api/ 开头 → 从内嵌资源返回静态文件（index.html / app.js / style.css）
   └─ path 以 /api/ 开头   → 转发到 用户配置的上游，并重写响应头
                              - Set-Cookie: 删除 Domain=（否则 Cookie 落在 127.0.0.1 上失败）
                              - Location: 上游绝对地址改写为 127.0.0.1
```

各文件职责：

| 文件 | 职责 | 改动频率 |
|------|------|---------|
| `mobile-ui/index.html` | DOM 骨架 | 低 |
| `mobile-ui/style.css` | 设计系统（CSS 变量 + 组件） | 中 |
| `mobile-ui/app.js` | 所有业务逻辑与字段映射 | **高**（上游改版的唯一主要战场） |
| `android/.../ProxyServer.java` | HTTP 代理 + 静态托管 | 低 |
| `android/.../MainActivity.java` | WebView + 服务器地址存储 + JS 桥 | 低 |
| `ios/.../LocalProxy.swift` | 同 ProxyServer | 低 |
| `ios/.../ContentView.swift` | 连接页 + 桥消息处理 | 低 |
| `ios/.../WebView.swift` | WKWebView + `window.WWNative` 注入 | 低 |

**业务逻辑只写在 `app.js` 里。** 两端原生壳保持「哑终端」，只提供：服务器地址读写、代理、打开外链、toast。这样上游改版时通常只需要改一个文件。

---

## 2. 上游 API 契约

以下基于 wild-work `v2.11.7`（commit `574c0a7`）核对。

### 鉴权

- `GET /api/auth/state`：探针。已登录时直接返回完整 state；未登录只回 `{auth_enabled, auth_session, auth_required, version}`
- `POST /api/auth/login` `{password}` → 下发 HttpOnly Cookie（7 天，使用中续期）
- `POST /api/auth/logout`

### 数据

`GET /api/state` 关键字段：

```jsonc
{
  "accounts": [{
    "uid": "...", "group": "workbuddy|traework|qodercn|…",
    "nickname": "...", "credits": 1234,
    "expiring_credits": 0, "unusable_credits": 0,
    "credits_stale": false, "credits_na": false, "credits_unit": "" | "token",
    "cooling": false, "until": "01-02 15:04", "until_ts": 0, "reason": "",
    "disabled": false, "model_cooling": {},
    "err_count": 0,
    "last_checkin_ok": true, "last_checkin_at": "...", "last_checkin_msg": "...",
    "session_dead": false, "refresh_token_missing": false,
    "refresh_token_missing_reason": ""
  }],
  "api_key": "WildWorkAPI", "listen_host": "0.0.0.0", "listen_port": 7863,
  "lan_ip": "192.168.1.5",
  "auth_enabled": true, "auth_session": "…", "auth_required": true,
  "login_busy": false, "login_error": "",
  "next_checkin": "...", "version": "v2.11.7"
}
```

`GET /api/stats`：

```jsonc
{
  "token_usage": { "today": 0, "days7": 0, "days30": 0, "req_today": 0, "req_all": 0, "days": 0 },
  "platforms": [{ "group": "workbuddy", "accounts": 2, "credits": 0,
                  "credit_in": 0, "credit_used": 0, "credit_expired": 0,
                  "tokens": 0, "expire_today": 0, "expire_tomorrow": 0, "expire_7d": 0 }],
  "models": [{ "model": "...", "count": 0, "tokens": 0, "credit": 0,
               "tok_per_sec": 0, "avg_ttfb_ms": 0 }],
  "credit_in": 0, "credit_used": 0, "credit_expired": 0,
  "total_accounts": 0, "total_credits": 0, "milestone_count": 0
}
```

`GET /api/stats/logs?limit=15`：请求日志数组（字段以 `time/model/status` 为主，`app.js` 里做了多字段名容错）。

### 操作（全部 POST，JSON body）

| 端点 | 参数 | 用途 |
|------|------|------|
| `/api/account/checkin` | `{uid}` | 单账号签到 |
| `/api/account/checkin_all` | `{}` | 全部签到，返回 `{results:[{ok,retryable,...}]}` |
| `/api/account/refresh` | `{uid}` | 刷新单账号积分 |
| `/api/account/refresh_all` | `{}` | 全部刷新 |
| `/api/account/disable` | `{uid, disabled}` | 停用/启用 |
| `/api/account/remove` | `{uid}` | 删除账号 |
| `/api/login/start` | `{channel}` | 发起登录，返回 `{auth_url, needs_poll, manual_callback}` |
| `/api/login/callback` | `{url}` | 回环回调渠道的手工兜底（粘贴地址栏 URL） |
| `/api/fees` | — | 模型列表与费率 |

### 渠道标识（`channel` 参数）

`workbuddy` `workbuddyai` `traework` `qodercn` `qodercom` `qwenwork` `monkeycode`
`raccoon` `loomy` `glm` `cline` `comate` `lingxi` `officeace` `minimax`
`lobsterai` `zcode` `gemini` `codearts`

（另有 `oczen` 内置匿名通道、`custom` 自定义渠道，不需要「添加」流程。）

---

## 3. 上游改版后怎么同步

### 第 1 步：判断改了什么

先拉上游最新前端源码，和本项目的字段映射对照。**上游的 `app.js` 就是 API 契约的事实来源**——它怎么读字段，后端就是怎么给的。

```bash
UP=rockswang/wild-work
curl -sL "https://raw.githubusercontent.com/$UP/master/cmd/wild-work/web/app.js" -o /tmp/up-app.js
curl -sL "https://raw.githubusercontent.com/$UP/master/internal/app/app.go" -o /tmp/up-app.go

# 看 API 端点有没有增减
grep -oE "/api/[a-z0-9_/]+" /tmp/up-app.js | sort -u

# 看 State / AccountView 的字段
grep -n "type State struct" -A 60 /tmp/up-app.go
grep -n "type AccountView struct" -A 45 /tmp/up-app.go
```

### 第 2 步：改 `mobile-ui/app.js`

三种典型情况：

**A. 新增了字段（最常见，向后兼容）**
在 `renderAccounts()` 里加一个展示项即可。旧字段不用动，`app.js` 对缺字段一律降级为 `—`，不会崩。

**B. 字段改名 / 语义变了**
改 `renderAccounts()` / `renderStats()` 里的取值路径。建议保留旧字段作为 fallback：

```js
const credits = a.credits ?? a.balance ?? 0;
```

**C. 新增了操作接口**
在 `CHANNELS` 同层加按钮 → `act()` 里加分支。注意 `api()` 已统一处理 401 与会话失效。

### 第 3 步：新增渠道

只在 `app.js` 的 `CHANNELS` 和 `ADDABLE` 两个常量里加一项，形如：

```js
newchannel: { name: "显示名", short: "徽章短名", desc: "接入方式" },
```

原生壳**不需要改**——渠道列表完全数据驱动。

### 第 4 步：提交并等 CI

```bash
git add -A && git commit -m "sync: 适配上游 vX.Y.Z 的 xxx 变更" && git push origin main
```

推 `main` 即触发两条流水线，产物自动刷新到 `android-latest` / `ios-latest` 两个 Release。无需手动打 tag。

### 第 5 步：回归清单

- [ ] 登录 → 账号列表有数据（不是空白/骨架屏卡住）
- [ ] 积分、状态、签到时间正常显示（不是一串 `—`）
- [ ] 单个签到 / 全部签到 有结果提示
- [ ] 统计页有模型和平台数据
- [ ] 添加账号能拉起授权页
- [ ] 断网/服务器关机时，提示「服务器无法连接」而不是白屏

---

## 4. 故障排查

| 现象 | 大概率原因 | 处理 |
|------|-----------|------|
| 打开 App 白屏 | 静态资源没打进包 | 检查 CI 里 `Sync shared UI` 步骤；`assets/www/index.html` 是否存在 |
| 一直停在骨架屏 | `/api/state` 返回非 200 或非 JSON | 用手机浏览器直连 `http://IP:7863/api/state` 看返回；确认监听是 `0.0.0.0` |
| 登录成功但立刻跳回登录页 | Cookie 没落到 `127.0.0.1` | 检查代理是否剥掉了 `Set-Cookie` 的 `Domain=` |
| 提示「服务器无法连接」 | 手机与电脑不同网段 / 防火墙 | 换同一 Wi-Fi 或开热点；放行 7863 |
| iOS 完全连不上局域网 | 未授权本地网络 | 设置 → 隐私 → 本地网络，允许 WildWork；或重装触发授权弹窗 |
| Android 装不上 | 已有同包名但签名不同的旧版 | 先卸载旧版 |
| iOS 装完打不开 | 未重签 / 证书过期 | 重新用 SideStore/Sideloadly 签名 |
| CI 里 iOS 构建失败 | Xcode 版本或工程定义 | 看 `xcodebuild -showsdks` 输出；必要时调整 `project.yml` |
| **iOS job 显示 cancelled 且 runner 为空、步骤数为 0** | 该 runner 标签不可用 | 不是代码问题，是 runner 不存在。本仓库踩过两次：① 私有仓库的 macOS runner 需要已验证的账单方式；② `macos-14` 标签已从公开池下线。诊断方法见下方「runner 探针」 |

### runner 探针（怀疑 runner 不可用时先跑这个）

```yaml
# .github/workflows/_probe.yml，用完即删
name: Runner Probe
on: { workflow_dispatch: }
jobs:
  probe:
    runs-on: macos-latest
    steps:
      - run: xcodebuild -version
```

- 探针成功、业务 job 失败 → 是代码/工程问题
- 探针也 cancelled 且 `runner_name` 为空 → 是 runner 标签或账号策略问题，改标签或改仓库可见性

**当前可用标签：`macos-latest`（不要再改回 `macos-14`）。**

---

## 5. 不要做的事
1. **不要在原生壳里写业务逻辑**。任何「这个字段怎么显示」的决策都属于 `app.js`，否则两端要改两遍。
2. **不要让 UI 直接请求上游地址**。必须走 `127.0.0.1:17863`，否则 CORS 与 Cookie 立刻出问题。
3. **不要给 UI 目录加构建步骤**（webpack/vite）。刻意保持「改完刷新即生效」，降低接手成本。
4. **不要提交 `android/app/src/main/assets/www/` 与 `ios/WildWorkMobile/www/`**。它们是 CI 从 `mobile-ui/` 复制出来的产物，已列入 `.gitignore`。
5. **不要提交 `.xcodeproj`**。由 `project.yml` 经 XcodeGen 生成，避免二进制工程文件冲突。
6. **不要改写 `Set-Cookie` 的 `Path`**。只删 `Domain`，Path 保留原值。

---

## 6. 关键实现细节备忘

**为什么代理自己算 `Content-Length`、并强制 `Accept-Encoding: identity`**
避免处理 chunked 与 gzip 解压。API 响应都很小，整体读入内存再回写最简单可靠。

**为什么不用 OkHttp / Alamofire**
零第三方依赖是刻意的：Gradle 不必解析复杂依赖树，CI 失败面最小，构建常在 1 分钟内完成。`HttpURLConnection` 与 `URLSession` 足够。

**iOS 的 `Set-Cookie` 限制**
`URLSession` 会把多个 `Set-Cookie` 合并成一条逗号分隔字符串。wild-work 只下发一个会话 Cookie，所以当前无影响。**若上游将来下发多个 Cookie，必须改用 `CFHTTPMessage` 或自建 socket 解析。**

**iOS 为什么不用本地静态服务器**
页面从 `file://` 加载会被视为 `null` origin，向 `127.0.0.1` 发 `fetch` 会被 CORS 拦。所以静态资源也走同一个本地 HTTP 代理，保证严格同源。

**端口固定 17863**
不是上游的 7863，避免与电脑端混淆。三处必须一致：`MainActivity.PROXY_PORT`、`ServerStore.proxyPort`、iOS `WebView` 里的端口判断。

**签名策略**
Android release 用 debug 签名（自用免配置 keystore）；iOS 出未签名 IPA（无法在 CI 里持有用户的开发者证书）。若要长期分发，替换为正式证书，并在 CI 注入 secrets。

**主题色与全屏（顶部黑边）**
`mobile-ui` 是**深色**主题（`--bg: #0a0d12`），容器/状态栏也必须深色 +
`UIStatusBarStyleLightContent`。UI 自带 `viewport-fit=cover` 与 `--safe-top/--safe-bottom`，
所以 WebView 侧必须 `.ignoresSafeArea(.all)`；只忽略 `.bottom` 会让状态栏区域露出容器底色，
看起来像一条黑边。注意这与 `wild-work-native` 仓库**相反**（那边上游面板是浅色）。

**下拉刷新与性能**
iOS 用 `WKWebView.scrollView.refreshControl`（`bounces` 必须为 `true`），Android 用自写
`PullToRefreshLayout`（零第三方依赖，没有 AndroidX 的 `SwipeRefreshLayout`）。
两端 WebView 都必须 `LOAD_DEFAULT` + `isOpaque = true`：`LOAD_NO_CACHE` 会每次重新解析
整套 UI 资源，透明合成会让滚动掉帧。

**账号卡片里的 oczen / kilo**
这两条是**免密免费渠道**，上游后端会为它们各生成一个虚拟账号占位，并硬拒
`remove` / `disable`（不是脏数据，别试图调 API 删）。`mobile-ui/app.js` 的 `renderAccounts()`
对它们渲染 `.ac-internal` 常驻说明、不渲染「签到/刷新」按钮——手机没有 hover，
上游放在 `title` 里的「固定账号，不可删除」用户根本看不到。改动时保持这个分支。
