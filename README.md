# wild-work-mobile

给 [`rockswang/wild-work`](https://github.com/rockswang/wild-work) 做的移动端外壳：**Android APK + iOS IPA**，共用一套现代化移动 UI。

> wild-work 上游本体是 Go 编写的桌面/服务端程序（带系统托盘、浏览器管理面板），**从来没有也不会产出 APK/IPA**。本仓库不是移植，而是给它补一个真正的手机客户端。

---

## 它是什么形态

```
┌──────────────────────────────────────────────┐
│  手机 App（本仓库）                           │
│                                              │
│  ┌────────────────────────┐                  │
│  │ WebView                │  加载            │
│  │  内嵌 mobile-ui        │  http://127.0.0.1:17863/
│  └──────────┬─────────────┘                  │
│             │ 同源 fetch /api/*               │
│  ┌──────────▼─────────────┐                  │
│  │ 本地反向代理            │  转发            │
│  │ (Android: ProxyServer) │ ────────────┐    │
│  │ (iOS: LocalProxy)      │             │    │
│  └────────────────────────┘             │    │
└─────────────────────────────────────────┼────┘
                                          ▼
                              http://192.168.x.x:7863
                              wild-work 面板（电脑/NAS）
```

**关键设计**：App 内起一个本地 HTTP 代理，页面与接口都从 `127.0.0.1` 同源访问。

- 不需要给 wild-work 加 CORS —— 上游一行代码都不用改
- 不需要处理跨域 Cookie —— 代理会剥掉 `Set-Cookie` 的 `Domain` 属性
- 上游升级只需替换电脑上的 wild-work 二进制，手机端无需重新发版

代价是：**手机必须能连到那台跑 wild-work 的机器**（同一局域网，或 ZigBee/Tailscale 之类的虚拟内网）。

---

## 下载安装

在 [Releases](https://github.com/ElyYinLi/wild-work-mobile/releases) 取最新构建：

| 平台 | 文件 | 说明 |
|------|------|------|
| Android | `WildWorkMobile.apk` | 约 1–2 MB，debug 签名，直接安装需允许「未知来源」 |
| iOS | `WildWorkMobile.ipa` | **未签名**，必须自签后安装 |

### Android

1. 下载 APK 传到手机
2. 安装时允许「安装未知应用」
3. 打开后填服务器地址，如 `192.168.1.5:7863`

### iOS（未签名 IPA）

免费 Apple ID 自签方案，任选其一：

- **SideStore / AltStore**：把 IPA 导入后安装（推荐，可自动续签）
- **Sideloadly**（Windows/macOS）：拖入 IPA，填 Apple ID，签名并安装
- **Xcode**：Window → Devices → 拖入 IPA（需开发者账号）

免费账号签名 **7 天**过期，需重新签。付费开发者账号 1 年。

---

## 首次使用

1. **电脑上先跑起 wild-work**，并在面板 ⚙ 设置里把监听地址改成 `0.0.0.0`、**设置管理密码**
   （不改监听地址，手机连不上；不设密码，程序会拒绝保存）
2. 查电脑局域网 IP：Windows `ipconfig`、macOS/Linux `ifconfig | grep "inet "`
3. 手机 App 填入 `IP:7863`，保存
4. 输入管理密码登录

---

## 功能

| 模块 | 内容 |
|------|------|
| 账号 | 汇总卡（可用数 / 总积分 / 临期）、渠道徽章、冷却与失效状态、单个签到/刷新/停用/删除 |
| 批量 | 全部签到、刷新积分 |
| 添加 | 19 个渠道网格，浏览器登录类跳系统浏览器；回环回调渠道支持粘贴回调 URL 兜底 |
| 统计 | 今日请求/消耗、模型用量榜、平台汇总、最近请求 |
| 设置 | 服务器地址、API 地址与 Key 一键复制、下次签到、版本、退出登录 |

界面细节：暗色为主 + 跟随系统浅色、底部 Tab、安全区适配、骨架屏、iOS 16px 输入框防缩放。

---

## 构建

全部由 GitHub Actions 完成，**不需要本地装 Android SDK 或 Xcode**：

| 工作流 | Runner | 产物 |
|--------|--------|------|
| `.github/workflows/android.yml` | `ubuntu-latest`（自带 Android SDK） | APK，发布到 tag `android-latest` |
| `.github/workflows/ios.yml` | `macos-14`（自带 Xcode 15） | 未签名 IPA，发布到 tag `ios-latest` |

推送到 `main` 即自动构建并刷新对应 Release。

本地构建（需相应工具链）：

```bash
# Android
cp -r mobile-ui/. android/app/src/main/assets/www/
cd android && gradle assembleRelease

# iOS（需 macOS + Xcode + xcodegen）
cp -r mobile-ui/. ios/WildWorkMobile/www/
cd ios && xcodegen generate && xcodebuild -scheme WildWorkMobile -sdk iphoneos build
```

---

## 目录

```
mobile-ui/          三端共用的 UI（纯 HTML/CSS/JS，无构建步骤）
android/            Java 壳：WebView + ProxyServer（本地反向代理）
ios/                Swift 壳：WKWebView + LocalProxy
  project.yml       XcodeGen 工程定义（.xcodeproj 不入库，构建时生成）
.github/workflows/  APK / IPA 两条构建流水线
docs/MAINTENANCE.md 维护手册（上游改版怎么跟、AI 如何接手）
```

**维护前请先读 [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md)。**
