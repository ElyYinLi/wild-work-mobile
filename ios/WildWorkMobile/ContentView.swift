import SwiftUI

enum AppColor {
    static let bg = Color(red: 0.039, green: 0.051, blue: 0.071)          // #0a0d12 深色
    // mobile-ui 有 @media (prefers-color-scheme: light)，浅色模式 --bg 是 #f5f7fb。
    // 容器必须跟随，否则浅色模式下状态栏区域露出深色底 = 顶部一条黑边。
    static let lightBg = Color(red: 0.961, green: 0.969, blue: 0.984)
    static let card = Color(red: 0.082, green: 0.106, blue: 0.141)
    static let accent = Color(red: 0.31, green: 0.55, blue: 0.99)
    static let dim = Color(red: 0.58, green: 0.64, blue: 0.72)
}

struct ContentView: View {
    @EnvironmentObject var store: ServerStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var showSetup = false
    @State private var draft = ""
    @State private var reloadToken = UUID()
    @State private var toastText: String?
    @State private var toastWork: DispatchWorkItem?

    var body: some View {
        ZStack {
            (colorScheme == .dark ? AppColor.bg : AppColor.lightBg).ignoresSafeArea()

            if store.isConfigured {
                WebView(
                    url: URL(string: "http://127.0.0.1:\(ServerStore.proxyPort)/")!,
                    serverHint: store.server,
                    reloadToken: reloadToken,
                    isDark: colorScheme == .dark,
                    onAction: handle
                )
                // mobile-ui 的 CSS 已用 --safe-top/--safe-bottom 处理安全区，
                // 这里必须铺满全屏，否则状态栏区域会露出容器底色形成一条黑边。
                .ignoresSafeArea(.all)
            } else {
                placeholder
            }

            if let text = toastText {
                VStack {
                    Spacer()
                    Text(text)
                        .font(.system(size: 13))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(Color(white: 0.17))
                        .cornerRadius(12)
                        .padding(.horizontal, 32)
                        .padding(.bottom, 96)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }
        }
        .sheet(isPresented: $showSetup) {
            setupSheet
        }
        .onAppear {
            if store.isConfigured {
                store.boot()
            } else {
                draft = ""
                showSetup = true
            }
        }
    }

    // MARK: - 未配置时的占位

    private var placeholder: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 20)
                    .fill(LinearGradient(colors: [AppColor.accent, Color(red: 0.49, green: 0.42, blue: 1.0)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 64, height: 64)
                Text("W").font(.system(size: 28, weight: .heavy)).foregroundColor(.white)
            }
            Text("WildWork").font(.system(size: 20, weight: .bold)).foregroundColor(.white)
            Text("尚未配置服务器").font(.system(size: 13)).foregroundColor(AppColor.dim)
            Button("设置服务器地址") {
                draft = store.server
                showSetup = true
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Capsule().fill(AppColor.accent))
            .foregroundColor(.white)
            .font(.system(size: 14, weight: .semibold))
        }
    }

    private var setupSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("连接 wild-work")
                .font(.system(size: 20, weight: .bold))
            Text("填写运行 wild-work 的电脑地址（含端口）。手机需与电脑在同一局域网。")
                .font(.system(size: 13))
                .foregroundColor(.secondary)

            TextField("192.168.1.5:7863", text: $draft)
                .keyboardType(.URL)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .padding(13)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.94)))

            Button {
                save()
            } label: {
                Text("保存并连接")
                    .font(.system(size: 15, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 13).fill(AppColor.accent))
                    .foregroundColor(.white)
            }

            if store.isConfigured {
                Button("取消") { showSetup = false }
                    .frame(maxWidth: .infinity)
                    .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }

    private func save() {
        store.update(server: draft)
        showSetup = false
        reloadToken = UUID()
        if !store.isConfigured {
            return
        }
        store.boot()
    }

    // MARK: - 来自网页的桥消息

    private func handle(_ action: [String: Any]) {
        let name = action["action"] as? String ?? ""
        switch name {
        case "setServer":
            draft = store.server
            showSetup = true
        case "open":
            if let s = action["url"] as? String, let u = URL(string: s) {
                UIApplication.shared.open(u)
            }
        case "toast":
            showToast(action["msg"] as? String ?? "")
        default:
            break
        }
    }

    private func showToast(_ text: String) {
        guard !text.isEmpty else { return }
        toastWork?.cancel()
        withAnimation(.easeOut(duration: 0.18)) { toastText = text }
        let work = DispatchWorkItem {
            withAnimation(.easeIn(duration: 0.2)) { toastText = nil }
        }
        toastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: work)
    }
}
