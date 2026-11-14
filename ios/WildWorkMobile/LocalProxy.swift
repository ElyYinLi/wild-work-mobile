import Foundation
import Network

/// 本地反向代理（iOS 侧）。
///
/// 与 Android 的实现一一对应：WKWebView 只与 `http://127.0.0.1:17863` 同源通信，
/// 由这里转发到真实服务器，顺带抹掉 Cookie 的 Domain 属性。
/// 这样 UI 一份代码两端跑，也不需要在 wild-work 侧开 CORS。
final class LocalProxy {

    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private let port: UInt16
    private let queue = DispatchQueue(label: "com.wildwork.localproxy")
    private var listener: NWListener?

    /// 上游根地址，形如 `http://192.168.1.5:7863`，不带尾斜杠
    var upstream: String = ""

    /// UI 资源目录（App bundle 内的 www）
    private lazy var staticRoot: String? = Bundle.main.resourcePath.map { $0 + "/www" }

    private let hopByHop: Set<String> = [
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "trailers", "transfer-encoding", "upgrade", "content-length",
    ]

    init(port: UInt16) {
        self.port = port
    }

    func start() throws {
        stop()
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "LocalProxy", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "端口非法"])
        }
        let l = try NWListener(using: params, on: nwPort)
        l.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        l.stateUpdateHandler = { state in
            if case .failed(let err) = state {
                NSLog("[WildWork] listener failed: \(err)")
            }
        }
        l.start(queue: queue)
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - 连接处理

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                conn.cancel()
                return
            }
            var buf = buffer
            if let d = data { buf.append(d) }

            if let req = self.parse(buf) {
                self.forward(req, over: conn)
                return
            }
            if isComplete || error != nil || buf.count > 4_000_000 {
                conn.cancel()
                return
            }
            self.receive(conn, buffer: buf)
        }
    }

    /// 返回 nil 表示报文还不完整，需要继续读。浏览器发的是普通 HTTP/1.1，够用。
    private func parse(_ buf: Data) -> Request? {
        guard let sep = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headData = buf.subdata(in: 0..<sep.lowerBound)
        guard let head = String(data: headData, encoding: .isoLatin1) else { return nil }

        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines {
            guard let idx = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<idx].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
            if !key.isEmpty { headers[key] = value }
        }

        let bodyStart = sep.upperBound
        let bodyLen = Int(headers["content-length"] ?? "0") ?? 0
        let available = buf.count - bodyStart
        if available < bodyLen { return nil }

        let body: Data
        if bodyLen > 0 {
            body = buf.subdata(in: bodyStart..<(bodyStart + bodyLen))
        } else {
            body = Data()
        }
        return Request(method: String(first[0]), path: String(first[1]), headers: headers, body: body)
    }

    private func forward(_ req: Request, over conn: NWConnection) {
        if req.path == "/__ww_health" {
            respond(conn, status: 200, headers: ["Content-Type": "application/json"],
                    body: Data("{\"ok\":true}".utf8))
            return
        }

        // 静态资源由本地提供，只有 /api/ 转发上游 —— 保证页面与接口同源
        if !req.path.hasPrefix("/api/"), serveStatic(req.path, over: conn) {
            return
        }

        guard !upstream.isEmpty, let url = URL(string: upstream + req.path) else {
            respond(conn, status: 503, headers: ["Content-Type": "application/json"],
                    body: Data("{\"error\":\"尚未配置服务器地址\"}".utf8))
            return
        }

        var urlReq = URLRequest(url: url)
        urlReq.httpMethod = req.method
        urlReq.timeoutInterval = 60
        for (k, v) in req.headers where !hopByHop.contains(k) && k != "host" {
            urlReq.setValue(v, forHTTPHeaderField: k)
        }
        urlReq.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if !req.body.isEmpty && req.method != "GET" && req.method != "HEAD" {
            urlReq.httpBody = req.body
        }

        URLSession.shared.dataTask(with: urlReq) { [weak self] data, resp, err in
            guard let self = self else { return }
            if let err = err {
                self.respond(conn, status: 502, headers: ["Content-Type": "application/json"],
                             body: Data("{\"error\":\"无法连接服务器: \(err.localizedDescription)\"}".utf8))
                return
            }
            guard let http = resp as? HTTPURLResponse else {
                self.respond(conn, status: 502, headers: [:], body: Data())
                return
            }

            var out: [String: String] = [:]
            for (rawKey, rawValue) in http.allHeaderFields {
                let key = String(describing: rawKey)
                let lower = key.lowercased()
                if self.hopByHop.contains(lower) || lower == "content-encoding" { continue }
                var value = String(describing: rawValue)
                if lower == "set-cookie" {
                    value = self.stripCookieDomain(value)
                } else if lower == "location" {
                    value = self.rewriteLocation(value)
                }
                out[key] = value
            }
            self.respond(conn, status: http.statusCode, headers: out, body: data ?? Data())
        }.resume()
    }

    private func respond(_ conn: NWConnection, status: Int, headers: [String: String], body: Data) {
        var head = "HTTP/1.1 \(status) \(reason(status))\r\n"
        for (k, v) in headers {
            head += "\(k): \(v)\r\n"
        }
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"

        var packet = Data(head.utf8)
        packet.append(body)
        conn.send(content: packet, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - 静态资源

    private func serveStatic(_ path: String, over conn: NWConnection) -> Bool {
        guard let root = staticRoot else { return false }
        var p = path
        if let q = p.firstIndex(of: "?") {
            p = String(p[..<q])
        }
        if p.isEmpty || p == "/" {
            p = "/index.html"
        }
        if p.contains("..") {
            return false
        }
        guard let data = FileManager.default.contents(atPath: root + p) else { return false }
        respond(conn, status: 200,
                headers: ["Content-Type": mimeOf(p), "Cache-Control": "no-cache"],
                body: data)
        return true
    }

    private func mimeOf(_ path: String) -> String {
        let p = path.lowercased()
        if p.hasSuffix(".html") || p.hasSuffix(".htm") { return "text/html; charset=utf-8" }
        if p.hasSuffix(".js") { return "application/javascript; charset=utf-8" }
        if p.hasSuffix(".css") { return "text/css; charset=utf-8" }
        if p.hasSuffix(".json") { return "application/json; charset=utf-8" }
        if p.hasSuffix(".png") { return "image/png" }
        if p.hasSuffix(".svg") { return "image/svg+xml" }
        if p.hasSuffix(".ico") { return "image/x-icon" }
        if p.hasSuffix(".woff2") { return "font/woff2" }
        return "application/octet-stream"
    }

    // MARK: - 头重写

    private func stripCookieDomain(_ cookie: String) -> String {
        let segs = cookie.split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.lowercased().hasPrefix("domain=") }
        return segs.joined(separator: "; ")
    }

    private func rewriteLocation(_ location: String) -> String {
        guard !upstream.isEmpty, location.hasPrefix(upstream) else { return location }
        return "http://127.0.0.1:\(port)" + location.dropFirst(upstream.count)
    }

    private func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 201: return "Created"
        case 204: return "No Content"
        case 301: return "Moved Permanently"
        case 302: return "Found"
        case 304: return "Not Modified"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 409: return "Conflict"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        case 504: return "Gateway Timeout"
        default: return "OK"
        }
    }
}
