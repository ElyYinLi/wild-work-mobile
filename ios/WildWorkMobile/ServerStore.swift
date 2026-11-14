import Foundation
import Combine

/// 服务器地址的唯一真相来源：负责持久化、校验上游格式，并托管本地代理的生命周期。
final class ServerStore: ObservableObject {

    static let proxyPort: UInt16 = 17863
    private static let key = "ww.server"

    @Published private(set) var server: String

    private let proxy = LocalProxy(port: ServerStore.proxyPort)
    private var started = false

    init() {
        server = UserDefaults.standard.string(forKey: ServerStore.key) ?? ""
    }

    var isConfigured: Bool {
        !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// 规范化输入（补 scheme、去尾斜杠）后持久化，并重启代理指向新地址。
    func update(server raw: String) {
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return }
        if !v.lowercased().hasPrefix("http://") && !v.lowercased().hasPrefix("https://") {
            v = "http://" + v
        }
        while v.hasSuffix("/") {
            v.removeLast()
        }
        server = v
        UserDefaults.standard.set(v, forKey: ServerStore.key)
    }

    func boot() {
        guard isConfigured else { return }
        proxy.upstream = server
        guard !started else { return }
        do {
            try proxy.start()
            started = true
        } catch {
            NSLog("[WildWork] 代理启动失败: \(error.localizedDescription)")
        }
    }
}
