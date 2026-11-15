import SwiftUI
import WebKit

/// WKWebView 容器 + 与网页的双向桥。
///
/// 网页侧通过 `window.WWNative` 访问原生能力（与 Android 的 @JavascriptInterface 同名同签名），
/// 所以 mobile-ui 一份代码两端无需分支。
struct WebView: UIViewRepresentable {

    let url: URL
    let serverHint: String
    let reloadToken: UUID
    /// 跟随系统深浅模式；mobile-ui 有 prefers-color-scheme 覆盖，容器底色必须同步
    let isDark: Bool
    let onAction: ([String: Any]) -> Void

    private var bg: UIColor {
        isDark
            ? UIColor(red: 0.039, green: 0.051, blue: 0.071, alpha: 1)
            : UIColor(red: 0.961, green: 0.969, blue: 0.984, alpha: 1)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onAction: onAction)
    }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "ww")
        controller.addUserScript(WKUserScript(source: bridgeJS(server: serverHint),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        cfg.userContentController = controller

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        // mobile-ui 是不透明深色主题；关掉透明合成能明显减轻滚动时的掉帧。
        wv.isOpaque = true
        wv.backgroundColor = bg
        wv.scrollView.backgroundColor = bg
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsBackForwardNavigationGestures = false
        // 下拉刷新需要弹性滚动；网页侧 overscroll-behavior-y:none 已阻止自身橡皮筋
        wv.scrollView.bounces = true

        let refresh = UIRefreshControl()
        refresh.tintColor = UIColor(red: 0.31, green: 0.55, blue: 0.99, alpha: 1)
        refresh.addTarget(context.coordinator,
                          action: #selector(Coordinator.doRefresh(_:)),
                          for: .valueChanged)
        wv.scrollView.refreshControl = refresh

        context.coordinator.webView = wv
        wv.load(URLRequest(url: url))

        context.coordinator.lastToken = reloadToken
        return wv
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // 系统切换深浅模式时 SwiftUI 会调 updateUIView；背景同步必须放在 guard 之前
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg

        guard context.coordinator.lastToken != reloadToken else { return }
        context.coordinator.lastToken = reloadToken

        // 服务器地址变了：桥里内联的是旧值，必须重新注入再重载
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: bridgeJS(server: serverHint),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        webView.load(URLRequest(url: url))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ww")
    }

    /// 注入到每个文档开头，保证 app.js 执行时 WWNative 已存在。
    private func bridgeJS(server: String) -> String {
        let literal: String
        if let data = try? JSONSerialization.data(withJSONObject: [server], options: []),
           let arr = String(data: data, encoding: .utf8) {
            literal = String(arr.dropFirst().dropLast()) // ["x"] -> "x"
        } else {
            literal = "\"\""
        }
        return """
        (function(){
          if (window.WWNative) { return; }
          window.WWNative = {
            getServer: function(){ return \(literal); },
            setServer: function(){ window.webkit.messageHandlers.ww.postMessage({action:'setServer'}); },
            openExternal: function(u){ window.webkit.messageHandlers.ww.postMessage({action:'open', url: String(u)}); },
            toastMsg: function(m){ window.webkit.messageHandlers.ww.postMessage({action:'toast', msg: String(m)}); },
            platform: function(){ return 'ios'; }
          };
        })();
        """
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private let onAction: ([String: Any]) -> Void
        var lastToken: UUID?
        weak var webView: WKWebView?

        init(onAction: @escaping ([String: Any]) -> Void) {
            self.onAction = onAction
        }

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            onAction(body)
        }

        @objc func doRefresh(_ sender: UIRefreshControl) {
            webView?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak sender] in
                if sender?.isRefreshing == true { sender?.endRefreshing() }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let r = webView.scrollView.refreshControl, r.isRefreshing {
                r.endRefreshing()
            }
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let scheme = (target.scheme ?? "").lowercased()
            if scheme == "http" || scheme == "https" {
                // 本地代理内的导航自己处理；其余（OAuth 授权页等）交给系统浏览器
                if target.host == "127.0.0.1" && target.port == Int(ServerStore.proxyPort) {
                    decisionHandler(.allow)
                } else {
                    UIApplication.shared.open(target)
                    decisionHandler(.cancel)
                }
                return
            }
            decisionHandler(.allow)
        }
    }
}
