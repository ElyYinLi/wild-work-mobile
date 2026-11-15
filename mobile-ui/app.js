/* ============================================================
   WildWork Mobile — 前端逻辑
   ------------------------------------------------------------
   只依赖 wild-work 面板的公开管理 API（/api/*）。
   所有请求都走同源（原生壳里是同源本地代理，浏览器里是同源反代），
   因此不需要任何 CORS 配置。
   ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const bridge = window.WWNative || null; // 原生壳注入；浏览器里为 null

  // ---------- 渠道元数据（与 wild-work 的 provider 前缀一一对应） ----------
  const CHANNELS = {
    workbuddy:   { name: "WorkBuddyCN", short: "WB",     desc: "国内版" },
    workbuddyai: { name: "WorkBuddyAI", short: "WBAI",   desc: "国际版" },
    traework:    { name: "TraeWork",    short: "Trae",   desc: "浏览器登录" },
    traecode:    { name: "TraeCode",    short: "TraeC",  desc: "复用 Trae 账号" },
    qodercn:     { name: "QoderCN",     short: "QCN",    desc: "国内版" },
    qodercom:    { name: "QoderCOM",    short: "QCOM",   desc: "国际版" },
    qwenwork:    { name: "千问办公",     short: "Qwen",   desc: "浏览器登录" },
    monkeycode:  { name: "MonkeyCode",  short: "MC",     desc: "从客户端导入" },
    raccoon:     { name: "小浣熊",       short: "Raccoon",desc: "网页登录 / 导入" },
    loomy:       { name: "Loomy",       short: "Loomy",  desc: "讯飞 · 客户端导入" },
    glm:         { name: "智谱清言",     short: "GLM",    desc: "粘贴 Token" },
    cline:       { name: "Cline",       short: "Cline",  desc: "粘贴 API Key" },
    comate:      { name: "WPS Comate",  short: "Comate", desc: "扫码 / 粘贴" },
    lingxi:      { name: "灵犀",         short: "Lingxi", desc: "粘贴 SID" },
    officeace:   { name: "OfficeAce",   short: "Ace",    desc: "华为云果办" },
    minimax:     { name: "MiniMax",     short: "MM",     desc: "浏览器登录" },
    lobsterai:   { name: "LobsterAI",   short: "Lobster",desc: "浏览器登录" },
    zcode:       { name: "ZCode",       short: "ZCode",  desc: "浏览器登录" },
    gemini:      { name: "Gemini",      short: "Gemini", desc: "浏览器登录" },
    codearts:    { name: "CodeArts",    short: "CA",     desc: "需填账号标识" },
    oczen:       { name: "OpenCodeZen", short: "Zen",    desc: "匿名免费通道" },
    custom:      { name: "自定义渠道",   short: "自定义",  desc: "第三方 API" },
  };

  // 添加账号时展示的渠道（oczen 内置、custom 在设置里配，不在此列）
  const ADDABLE = [
    "workbuddy", "workbuddyai", "traework", "qodercn", "qodercom", "qwenwork",
    "monkeycode", "raccoon", "loomy", "glm", "cline", "comate",
    "lingxi", "officeace", "minimax", "lobsterai", "zcode", "gemini", "codearts",
  ];

  // 需要用户手动粘回调 URL 的判定交给后端（manual_callback），这里不做本地白名单

  let state = null;
  let statsData = null;
  let busy = false;

  // ---------------- 基础工具 ----------------
  function chanMeta(group) {
    const key = String(group || "").toLowerCase();
    if (CHANNELS[key]) return CHANNELS[key];
    // 上游 group 可能是 oczen / custom:xxx 等变体，做一次前缀匹配
    for (const k of Object.keys(CHANNELS)) {
      if (key.startsWith(k)) return CHANNELS[k];
    }
    if (key.includes("custom")) return CHANNELS.custom;
    return { name: group || "未知渠道", short: String(group || "?").slice(0, 6).toUpperCase(), desc: "" };
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿";
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + "万";
    return v.toLocaleString("zh-CN");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------------- 请求封装 ----------------
  async function api(path, body) {
    const init = {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {},
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(path, init);
    let data = {};
    try {
      data = await resp.json();
    } catch (e) {
      // 空体 / 非 JSON（例如网关 502 的 HTML 错误页）
    }
    if (!resp.ok) {
      if (resp.status === 401) showLogin(data.error || "");
      throw new Error(data.error || (resp.status === 502 ? "服务器无法连接" : "请求失败 " + resp.status));
    }
    return data;
  }

  // ---------------- 启动 ----------------
  async function boot() {
    try {
      const probe = await api("/api/auth/state");
      if (probe && probe.accounts) {
        state = probe;
        afterState(true);
        return;
      }
      if (probe && probe.auth_enabled && !probe.auth_session) {
        $("subtitle").textContent = "需要登录";
        hideSplash();
        showLogin();
        return;
      }
      await loadState(true);
    } catch (e) {
      failSplash(e.message);
    }
  }

  async function loadState(first) {
    if (first) skeleton();
    try {
      const s = await api("/api/state");
      state = s;
      afterState(first);
    } catch (e) {
      if (first) failSplash(e.message);
      else toast(e.message);
    }
  }

  function afterState(first) {
    hideSplash();
    $("app").classList.remove("hidden");
    renderAll();
    if (first) {
      // 首次进入如果还需要登录（无 cookie 但 auth_enabled），上面已处理；
      // 这里只负责把登录层收起来
      $("loginOverlay").classList.add("hidden");
    }
  }

  function skeleton() {
    $("accountList").innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  }

  function hideSplash() {
    const sp = $("splash");
    if (!sp || sp.classList.contains("fade")) return;
    sp.classList.add("fade");
    setTimeout(() => sp.remove(), 400);
  }

  function failSplash(msg) {
    const t = $("splashText");
    if (t) {
      t.innerHTML = "无法连接服务器<br><span style='color:#f87171'>" + esc(msg) + "</span><br><br>点击此处重试";
      t.style.lineHeight = "1.8";
      t.onclick = () => location.reload();
    }
    const bar = document.querySelector(".splash-bar");
    if (bar) bar.style.display = "none";
    if (bridge) {
      const btn = document.createElement("button");
      btn.textContent = "修改服务器地址";
      btn.style.cssText = "margin-top:18px;padding:11px 20px;border-radius:11px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#94a2b8;font-size:13px;font-weight:600";
      btn.onclick = (ev) => { ev.stopPropagation(); bridge.setServer(); };
      $("splash").appendChild(btn);
    }
  }

  // ---------------- 渲染：账号 ----------------
  function renderAll() {
    renderHeader();
    renderAccounts();
    renderSettings();
  }

  function renderHeader() {
    if (!state) return;
    const accs = state.accounts || [];
    const usable = accs.filter((a) => !a.disabled && !a.session_dead && !a.cooling).length;
    const list = String(state.listen_host || "") + ":" + String(state.listen_port || "");
    $("subtitle").textContent =
      "v" + (state.version || "?") + " · " + usable + "/" + accs.length + " 可用 · " + list;
  }

  function accountStatus(a) {
    if (a.disabled) return { cls: "off", text: "已停用" };
    if (a.session_dead) return { cls: "dead", text: "需重新登录" };
    if (a.refresh_token_missing) return { cls: "dead", text: "凭据缺失" };
    if (a.cooling) return { cls: "cooling", text: "冷却中" };
    return { cls: "", text: "正常" };
  }

  /** 签到时间：宽屏显示完整「MM-DD HH:MM」，窄屏只留「HH:MM」，避免被省略号吃掉。 */
  function fmtCheckin(raw) {
    const s = String(raw || "").trim();
    if (!s || s === "—") return "—";
    const wide = window.matchMedia("(min-width: 400px)").matches;
    if (wide) return s;
    const m = s.match(/(\d{1,2}:\d{2})\s*$/);
    return m ? m[1] : s;
  }

  function renderAccounts() {
    const accs = (state && state.accounts) || [];
    const list = $("accountList");
    $("accountCount").textContent = accs.length + " 个";

    // 汇总
    const usable = accs.filter((a) => !a.disabled && !a.session_dead && !a.cooling && !a.refresh_token_missing);
    $("statAccounts").textContent = String(usable.length);
    $("statAccountsSub").textContent = "共 " + accs.length + " 个账号";

    let total = 0;
    let expiring = 0;
    accs.forEach((a) => {
      if (a.credits_na) return;
      total += Number(a.credits) || 0;
      expiring += Number(a.expiring_credits) || 0;
    });
    $("statCredits").textContent = fmtNum(total);
    $("statCreditsSub").textContent = expiring > 0 ? "临期 " + fmtNum(expiring) : "无临期积分";

    if (!accs.length) {
      list.innerHTML = '<div class="empty"><strong>还没有账号</strong>点上方「添加」接入第一个渠道</div>';
      return;
    }

    // 渠道分组顺序：按名称聚合，避免同渠道账号被其它渠道插散
    list.innerHTML = accs.map((a) => {
      const meta = chanMeta(a.group);
      const st = accountStatus(a);
      // oczen / kilo 是免密免费池：上游各生成一个「虚拟账号」占位，后端硬拒删除/停用。
      // 手机没有 hover，把说明做成常驻行，避免用户以为这是删不掉的僵尸账号。
      const isBuiltin = ["oczen", "kilo"].some((k) =>
        String(a.group || "").toLowerCase().startsWith(k));
      const creditText = a.credits_na
        ? "不适用"
        : (a.credits_stale ? "待刷新" : fmtNum(a.credits));
      const creditUnit = a.credits_unit === "token" ? "Token" : "积分";

      // 状态列既要说清「为什么」，又不能在小屏上被截断：
      // 正常 → 短文案；冷却 / 失效 → 带时刻，字号已由 .v 的 ellipsis 兜底
      let statusText = st.text;
      let statusCls = st.cls;
      if (a.cooling && a.until && !a.disabled && !a.session_dead) {
        // "11-15 03:20" → "03:20 解冻"：小屏上省掉日期也不歧义（冷却通常只有几分钟到几小时）
        const clock = String(a.until).split(" ").pop();
        statusText = clock + " 解冻";
        statusCls = "cooling";
      }
      const statusColor = statusCls === "dead" ? "danger"
        : statusCls === "cooling" ? "warn"
        : statusCls === "off" ? ""
        : "ok";

      return `
      <article class="ac-card ${a.disabled ? "off" : ""} ${a.session_dead || a.refresh_token_missing ? "dead" : ""}" data-uid="${esc(a.uid)}">
        <div class="ac-top">
          <span class="badge">${esc(meta.short)}</span>
          <span class="ac-name">${esc(a.nickname || meta.name)}</span>
          <span class="dot ${st.cls}"></span>
        </div>
        <div class="ac-metrics">
          <div class="metric" style="flex:1.1">
            <span class="k">${creditUnit}</span>
            <span class="v">${esc(creditText)}</span>
          </div>
          <div class="metric" style="flex:1.4">
            <span class="k">状态</span>
            <span class="v ${statusColor}">${esc(statusText)}</span>
          </div>
          <div class="metric" style="flex:1">
            <span class="k">签到</span>
            <span class="v ${a.last_checkin_ok ? "ok" : ""}">${esc(fmtCheckin(a.last_checkin_at))}</span>
          </div>
        </div>
        ${isBuiltin
          ? '<div class="ac-internal">内置免费通道 · 系统自动管理，无需登录/删除</div>'
          : `<div class="ac-actions">
              <button class="act primary" data-act="checkin">签到</button>
              <button class="act" data-act="refresh">刷新</button>
              <button class="act icon-only" data-act="more">···</button>
            </div>`}
      </article>`;
    }).join("");
  }

  // ---------------- 渲染：设置 ----------------
  function renderSettings() {
    if (!state) return;
    const server = bridge ? bridge.getServer() : location.origin;
    $("settingServer").textContent = server || "—";
    $("rowServer").style.display = bridge ? "" : "none";

    const host = state.lan_ip || state.listen_host || "127.0.0.1";
    const port = state.listen_port || 7863;
    const apiAddr = "http://" + host + ":" + port + "/v1";
    $("settingApiAddr").textContent = apiAddr;
    $("settingApiAddr").dataset.value = apiAddr;

    $("settingApiKey").textContent = state.api_key || "—";
    $("settingApiKey").dataset.value = state.api_key || "";

    $("settingNextCheckin").textContent = state.next_checkin || "—";
    $("settingVersion").textContent = "v" + (state.version || "?");

    $("rowLogout").style.display = state.auth_enabled ? "" : "none";
  }

  // ---------------- 渲染：统计 ----------------
  async function loadStats() {
    try {
      const s = await api("/api/stats");
      statsData = s;
      renderStats(s);
    } catch (e) {
      $("modelList").innerHTML = '<div class="empty">统计接口不可用：' + esc(e.message) + "</div>";
      $("recentList").innerHTML = "";
    }
  }

  function renderStats(s) {
    const tu = s.token_usage || {};
    $("statReq").textContent = fmtNum(tu.req_today || s.req_today || 0);
    $("statReqSub").textContent = "累计 " + fmtNum(tu.req_all || 0) + " 次";

    const used = Number(s.credit_used) || 0;
    $("statSpend").textContent = fmtNum(used);
    $("statSpendSub").textContent = "今日收入 " + fmtNum(s.credit_in || 0);

    const models = (s.models || []).slice(0, 12);
    $("modelList").innerHTML = models.length
      ? models.map((m) => {
          const name = m.model || m.name || "?";
          const cnt = Number(m.count || m.calls || m.reqs || 0);
          const tok = Number(m.tokens || 0);
          const credit = Number(m.credit || 0);
          return `<div class="row-item">
            <span class="name">${esc(name)}</span>
            <span class="val">${fmtNum(cnt)} 次 · ${fmtNum(tok)} tok${credit > 0 ? " · " + fmtNum(credit) + " 分" : ""}</span>
          </div>`;
        }).join("")
      : '<div class="empty">今日暂无模型调用</div>';

    // 平台汇总（取 stats.platforms），比模型榜更能反映账户健康
    const plats = s.platforms || [];
    if (plats.length) {
      const platRows = plats.map((p) => {
        const meta = chanMeta(p.group);
        return `<div class="row-item">
          <span class="name">${esc(meta.name)} <span style="color:var(--text-faint)">${Number(p.accounts) || 0} 号</span></span>
          <span class="val">${fmtNum(p.credits)} 分 · 用 ${fmtNum(p.credit_used)}</span>
        </div>`;
      }).join("");
      $("modelList").insertAdjacentHTML("afterend",
        '<div id="platformBlock"><div class="section-head" style="margin-top:18px"><h2>平台</h2></div>' +
        '<div class="list">' + platRows + "</div></div>");
    }

    loadRecent();
  }

  async function loadRecent() {
    try {
      const logs = await api("/api/stats/logs?limit=15");
      const rows = Array.isArray(logs) ? logs : (logs.logs || logs.entries || []);
      $("recentList").innerHTML = rows.length
        ? rows.slice(0, 15).map((r) => {
            const t = r.time || r.at || r.ts || "";
            const model = r.model || "";
            const status = r.status || r.code || "";
            const ok = !String(status).match(/^(4|5)/) && !r.error;
            return `<div class="row-item">
              <span class="name" style="flex:1">${esc(model || r.path || "—")}</span>
              <span class="val" style="color:${ok ? "var(--ok)" : "var(--danger)"}">${esc(String(status || (ok ? "ok" : "err")))} ${esc(String(t).slice(11, 19) || "")}</span>
            </div>`;
          }).join("")
        : '<div class="empty">暂无请求记录</div>';
    } catch (e) {
      $("recentList").innerHTML = "";
    }
  }

  // ---------------- 登录 ----------------
  function showLogin(msg) {
    $("app").classList.add("hidden");
    const ov = $("loginOverlay");
    ov.classList.remove("hidden");
    $("loginErr").textContent = msg || "";
    setTimeout(() => $("loginPass").focus(), 220);
  }

  async function doLogin() {
    const pass = $("loginPass").value;
    if (!pass) return;
    const btn = $("btnLogin");
    btn.disabled = true;
    btn.textContent = "登录中…";
    try {
      await api("/api/auth/login", { password: pass });
      $("loginOverlay").classList.add("hidden");
      $("loginPass").value = "";
      await loadState(true);
      toast("已登录");
    } catch (e) {
      $("loginErr").textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "登录";
    }
  }

  // ---------------- 账号操作 ----------------
  async function act(uid, action, btn) {
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;
    try {
      if (action === "checkin") {
        const r = await api("/api/account/checkin", { uid });
        toast(r && r.message ? r.message : "签到已完成");
      } else if (action === "refresh") {
        const r = await api("/api/account/refresh", { uid });
        toast(r && r.message ? r.message : "积分已刷新");
      }
      await loadState(false);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function batch(path, label) {
    if (busy) return;
    busy = true;
    toast(label + "…");
    try {
      const r = await api(path, {});
      const results = r.results || [];
      const ok = results.filter((x) => x.ok).length;
      toast(results.length ? label + "完成：成功 " + ok + "/" + results.length : (r.message || label + "已提交"));
      await loadState(false);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
    }
  }

  // ---------------- 通用弹层 ----------------
  function openSheet(html) {
    $("sheetBody").innerHTML = '<div class="sheet-handle"></div>' + html;
    $("sheet").classList.remove("hidden");
  }
  function closeSheet() {
    $("sheet").classList.add("hidden");
  }

  function moreMenu(uid) {
    const a = (state.accounts || []).find((x) => x.uid === uid);
    if (!a) return;
    const meta = chanMeta(a.group);
    openSheet(`
      <h2>${esc(a.nickname || meta.name)}</h2>
      <p class="muted">${esc(meta.name)} · ${esc(a.uid)}</p>
      <button class="btn-block primary" data-more="toggle">${a.disabled ? "启用该账号" : "停用该账号"}</button>
      <button class="btn-block ghost" data-more="remove" style="color:var(--danger)">删除账号</button>
      <button class="btn-block ghost" data-more="close">取消</button>
    `);
    $("sheetBody").querySelectorAll("[data-more]").forEach((el) => {
      el.onclick = async () => {
        const m = el.dataset.more;
        if (m === "close") return closeSheet();
        closeSheet();
        try {
          if (m === "toggle") {
            await api("/api/account/disable", { uid, disabled: !a.disabled });
            toast(a.disabled ? "已启用" : "已停用");
          } else if (m === "remove") {
            if (!confirm("确定删除该账号？删除后需重新登录。")) return;
            await api("/api/account/remove", { uid });
            toast("账号已删除");
          }
          await loadState(false);
        } catch (e) {
          toast(e.message);
        }
      };
    });
  }

  // ---------------- 添加账号 ----------------
  function openAddChannel() {
    const grid = ADDABLE.map((k) => {
      const m = CHANNELS[k];
      return `<button class="channel-btn" data-channel="${k}"><b>${esc(m.name)}</b><span>${esc(m.desc)}</span></button>`;
    }).join("");
    openSheet(`
      <h2>添加账号</h2>
      <p class="muted">选择渠道。浏览器登录类会跳转到系统浏览器完成授权。</p>
      <div class="channel-grid">${grid}</div>
      <button class="btn-block ghost" data-close="1" style="margin-top:14px">取消</button>
    `);
    $("sheetBody").querySelectorAll("[data-channel]").forEach((el) => {
      el.onclick = () => startLogin(el.dataset.channel);
    });
    const c = $("sheetBody").querySelector("[data-close]");
    if (c) c.onclick = closeSheet;
  }

  async function startLogin(channel) {
    const meta = CHANNELS[channel] || { name: channel };
    openSheet('<h2>' + esc(meta.name) + '</h2><p class="muted">正在发起登录…</p>');
    let r;
    try {
      r = await api("/api/login/start", { channel });
    } catch (e) {
      openSheet(`
        <h2>${esc(meta.name)}</h2>
        <p class="muted">${esc(e.message)}</p>
        <button class="btn-block primary" data-close="1">知道了</button>
      `);
      const c = $("sheetBody").querySelector("[data-close]");
      if (c) c.onclick = closeSheet;
      return;
    }

    const url = r.auth_url || "";
    const needManual = !!r.manual_callback;

    // 打开授权页：优先系统浏览器（同机回环回调才可能成功）
    if (url) {
      if (bridge) bridge.openExternal(url);
      else window.open(url, "_blank");
    }

    let body = '<h2>' + esc(meta.name) + "</h2>";
    if (url) {
      body += `<p class="muted">已打开授权页面，完成登录后回到本应用点「已完成」。</p>`;
    } else {
      body += `<p class="muted">已发起登录，请按面板提示操作。</p>`;
    }

    if (needManual) {
      body += `
        <p class="muted" style="margin-top:4px">该渠道的回调地址写死在本机回环，手机上收不到。授权后浏览器若打不开页面，请把地址栏整条 URL 粘到下面：</p>
        <input id="cbUrl" type="url" placeholder="http://127.0.0.1:xxxxx/...?code=..." />
        <button class="btn-block primary" id="btnCb">提交回调地址</button>`;
    }

    body += `
      <button class="btn-block primary" id="btnLoginDone">已完成</button>
      <button class="btn-block ghost" data-close="1">关闭</button>`;

    openSheet(body);

    const done = $("btnLoginDone");
    if (done) {
      done.onclick = async () => {
        closeSheet();
        toast("正在同步账号…");
        await new Promise((r2) => setTimeout(r2, 1200));
        await loadState(false);
      };
    }
    const cbBtn = $("btnCb");
    if (cbBtn) {
      cbBtn.onclick = async () => {
        const v = ($("cbUrl") || {}).value || "";
        if (!v.trim()) return toast("请粘贴回调 URL");
        try {
          await api("/api/login/callback", { url: v.trim() });
          closeSheet();
          toast("回调已提交，正在同步…");
          await new Promise((r2) => setTimeout(r2, 1200));
          await loadState(false);
        } catch (e) {
          toast(e.message);
        }
      };
    }
    const close = $("sheetBody").querySelector("[data-close]");
    if (close) close.onclick = closeSheet;
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $("btnReload").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.classList.add("spin");
      await loadState(false);
      if (!$("view-stats").classList.contains("hidden")) await loadStats();
      btn.classList.remove("spin");
    };

    $("btnCheckinAll").onclick = () => batch("/api/account/checkin_all", "全部签到");
    $("btnRefreshAll").onclick = () => batch("/api/account/refresh_all", "刷新积分");
    $("btnAddAccount").onclick = openAddChannel;

    // 账号卡事件委托
    $("accountList").addEventListener("click", (e) => {
      const card = e.target.closest(".ac-card");
      if (!card) return;
      const uid = card.dataset.uid;
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const action = btn.dataset.act;
      if (action === "more") return moreMenu(uid);
      act(uid, action, btn);
    });

    // Tab
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const target = tab.dataset.view;
        ["accounts", "stats", "settings"].forEach((v) => {
          $("view-" + v).classList.toggle("hidden", v !== target);
        });
        if (target === "stats") loadStats();
        if (target === "settings") renderSettings();
      };
    });

    // 登录
    $("btnLogin").onclick = doLogin;
    $("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("btnLoginCancel").onclick = () => {
      $("loginOverlay").classList.add("hidden");
      if (bridge) { bridge.setServer(); return; }
      $("app").classList.remove("hidden");
    };

    // 设置
    $("btnSetServer").onclick = () => { if (bridge) bridge.setServer(); };
    document.querySelectorAll("[data-copy]").forEach((el) => {
      el.onclick = async () => {
        const which = el.dataset.copy;
        const node = which === "api" ? $("settingApiAddr") : $("settingApiKey");
        const text = node.dataset.value || node.textContent;
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          toast("已复制");
        } catch (e) {
          // WebView 里 clipboard API 可能不可用，退化为选中提示
          toast("复制失败，请长按文本手动复制");
        }
      };
    });
    $("btnLogout").onclick = async () => {
      try { await api("/api/auth/logout", {}); } catch (e) {}
      $("loginOverlay").classList.remove("hidden");
      $("app").classList.add("hidden");
    };

    // 遮罩点击关闭
    $("sheet").addEventListener("click", (e) => {
      if (e.target.id === "sheet") closeSheet();
    });
  }

  // ---------------- 启动 ----------------
  document.addEventListener("DOMContentLoaded", () => {
    bind();
    boot();

    // 旋屏 / 分屏切换时按新宽度重算时间格式（只在宽度档位变化时重绘，避免抖动）
    let lastWide = window.matchMedia("(min-width: 400px)").matches;
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const wide = window.matchMedia("(min-width: 400px)").matches;
        if (wide !== lastWide) {
          lastWide = wide;
          if (state) renderAccounts();
        }
      }, 180);
    });
  });
})();
