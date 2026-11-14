package com.wildwork.mobile;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地反向代理。
 *
 * 存在的唯一理由：WebView 里加载的页面源是 http://127.0.0.1:PORT，
 * 而 wild-work 面板部署在 http://192.168.x.x:7863。
 * 跨源 + HttpOnly Cookie 的 Domain 绑定，会让直接 fetch 全部失败。
 * 于是页面始终只与 127.0.0.1 同源通信，由本类把请求转发到真实服务器。
 *
 * 约定：
 *   - 只监听 127.0.0.1，不对局域网暴露；
 *   - 上游响应一律去掉 Domain 属性，使 Cookie 落在 127.0.0.1 上；
 *   - 强制 identity 编码，自己算 Content-Length，避免 chunked/gzip 的复杂度。
 */
public class ProxyServer {

    private static final int CONNECT_TIMEOUT_MS = 12000;
    private static final int READ_TIMEOUT_MS = 60000;

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "trailers", "transfer-encoding", "upgrade", "content-length"
    ));

    private final int port;
    private volatile String upstreamBase = "";
    private volatile ServerSocket serverSocket;
    private volatile boolean running;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public ProxyServer(int port) {
        this.port = port;
    }

    public int getPort() {
        return port;
    }

    public String getUpstream() {
        return upstreamBase;
    }

    /** 接受 "192.168.1.5:7863"、"http://192.168.1.5:7863/" 等写法，统一成不带尾斜杠的根地址。 */
    public synchronized void setUpstream(String raw) {
        String b = raw == null ? "" : raw.trim();
        if (b.isEmpty()) {
            upstreamBase = "";
            return;
        }
        if (!b.startsWith("http://") && !b.startsWith("https://")) {
            b = "http://" + b;
        }
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        upstreamBase = b;
    }

    public synchronized void start() throws IOException {
        if (running) {
            return;
        }
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 64);
        serverSocket = ss;
        running = true;
        Thread t = new Thread(this::acceptLoop, "ww-proxy-accept");
        t.setDaemon(true);
        t.start();
    }

    public synchronized void stop() {
        running = false;
        ServerSocket ss = serverSocket;
        serverSocket = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {
            }
        }
    }

    public boolean isRunning() {
        return running;
    }

    private void acceptLoop() {
        while (running) {
            ServerSocket ss = serverSocket;
            if (ss == null) {
                return;
            }
            try {
                Socket client = ss.accept();
                try {
                    pool.execute(() -> handle(client));
                } catch (RuntimeException rejected) {
                    try {
                        client.close();
                    } catch (IOException ignored) {
                    }
                }
            } catch (IOException e) {
                if (running) {
                    try {
                        Thread.sleep(50);
                    } catch (InterruptedException ignored) {
                    }
                }
            }
        }
    }

    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(READ_TIMEOUT_MS);
            InputStream in = new BufferedInputStream(c.getInputStream());
            OutputStream out = new BufferedOutputStream(c.getOutputStream());

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                return;
            }
            String method = parts[0];
            String rawPath = parts[1];

            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0) {
                    headers.put(line.substring(0, idx).trim().toLowerCase(Locale.ROOT), line.substring(idx + 1).trim());
                }
            }

            byte[] body = new byte[0];
            int contentLength = parseInt(headers.get("content-length"), 0);
            if (contentLength > 0) {
                body = readExactly(in, contentLength);
            }

            // 健康探针：壳层用它判断代理是否真的活着，也让 UI 能显示当前上游
            if ("/__ww_health".equals(rawPath)) {
                writeJson(out, 200, "{\"ok\":true,\"upstream\":" + quote(upstreamBase) + "}");
                return;
            }

            if (upstreamBase.isEmpty()) {
                writeJson(out, 503, "{\"error\":" + quote("尚未配置服务器地址") + "}");
                return;
            }

            forward(out, method, rawPath, headers, body);
        } catch (Exception ignored) {
            // 单连接失败不影响其它请求
        }
    }

    private void forward(OutputStream out, String method, String rawPath,
                         Map<String, String> headers, byte[] body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(upstreamBase + rawPath).openConnection();
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);

            for (Map.Entry<String, String> e : headers.entrySet()) {
                String key = e.getKey();
                if ("host".equals(key) || HOP_BY_HOP.contains(key)) {
                    continue;
                }
                conn.setRequestProperty(key, e.getValue());
            }
            // 不让上游压缩：自己写 Content-Length 比处理 gzip/chunked 更稳
            conn.setRequestProperty("Accept-Encoding", "identity");

            if (body.length > 0 && !"GET".equals(method) && !"HEAD".equals(method)) {
                conn.setDoOutput(true);
                OutputStream os = conn.getOutputStream();
                os.write(body);
                os.flush();
                os.close();
            }

            int status = conn.getResponseCode();
            InputStream respIn = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] respBody = respIn == null ? new byte[0] : readAll(respIn);
            if (respIn != null) {
                try {
                    respIn.close();
                } catch (IOException ignored) {
                }
            }

            StringBuilder sb = new StringBuilder(512);
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reasonPhrase(status)).append("\r\n");

            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                String name = e.getKey();
                if (name == null) {
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                if (HOP_BY_HOP.contains(lower)) {
                    continue;
                }
                List<String> values = e.getValue();
                if (values == null) {
                    continue;
                }
                for (String v : values) {
                    if (v == null) {
                        continue;
                    }
                    if ("set-cookie".equals(lower)) {
                        // 去掉 Domain，让 Cookie 归属 127.0.0.1；Path 原样保留
                        v = stripCookieDomain(v);
                    } else if ("location".equals(lower)) {
                        v = rewriteLocation(v);
                    }
                    sb.append(name).append(": ").append(v).append("\r\n");
                }
            }
            sb.append("Content-Length: ").append(respBody.length).append("\r\n");
            sb.append("Connection: close\r\n\r\n");

            out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (!"HEAD".equals(method)) {
                out.write(respBody);
            }
            out.flush();
        } catch (Exception ex) {
            String msg = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            try {
                writeJson(out, 502, "{\"error\":" + quote("无法连接服务器: " + msg) + "}");
            } catch (IOException ignored) {
            }
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /** 去掉 Set-Cookie 里的 Domain=...，其余属性（HttpOnly/SameSite/Max-Age/Path）保留。 */
    private String stripCookieDomain(String cookie) {
        StringBuilder sb = new StringBuilder(cookie.length());
        String[] segs = cookie.split(";");
        for (int i = 0; i < segs.length; i++) {
            String seg = segs[i].trim();
            if (seg.isEmpty()) {
                continue;
            }
            if (seg.regionMatches(true, 0, "domain=", 0, 7)) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append("; ");
            }
            sb.append(seg);
        }
        return sb.toString();
    }

    /** 上游绝对跳转改写到本地代理，否则浏览器会跑到局域网地址上去（跨源丢 cookie）。 */
    private String rewriteLocation(String location) {
        if (!upstreamBase.isEmpty() && location.startsWith(upstreamBase)) {
            return "http://127.0.0.1:" + port + location.substring(upstreamBase.length());
        }
        return location;
    }

    private void writeJson(OutputStream out, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + reasonPhrase(status) + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    private static String reasonPhrase(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            case 504: return "Gateway Timeout";
            default: return "OK";
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        boolean got = false;
        while ((c = in.read()) != -1) {
            got = true;
            if (c == '\n') {
                break;
            }
            if (c != '\r') {
                buf.write(c);
            }
        }
        if (!got) {
            return null;
        }
        return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static byte[] readExactly(InputStream in, int length) throws IOException {
        byte[] buf = new byte[length];
        int off = 0;
        while (off < length) {
            int n = in.read(buf, off, length - off);
            if (n < 0) {
                break;
            }
            off += n;
        }
        return off == length ? buf : Arrays.copyOf(buf, off);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) {
            out.write(chunk, 0, n);
        }
        return out.toByteArray();
    }

    private static int parseInt(String s, int def) {
        if (s == null) {
            return def;
        }
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static String quote(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        return sb.append('"').toString();
    }
}
