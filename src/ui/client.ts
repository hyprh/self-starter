// Zero-build browser client for `self-starter ui` (served at /app.js under strict CSP: script-src 'self').

export const UI_CLIENT_JS = `(function () {
  "use strict";

  const PROVIDER_META = {
    feishu:   { label: "Feishu / Lark", sub: "Group Bot + HMAC", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/<your-hook>" },
    wecom:    { label: "WeCom", sub: "Group Webhook", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<your-key>" },
    dingtalk: { label: "DingTalk", sub: "Robot + HMAC", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=<your-token>" },
    telegram: { label: "Telegram Bot", sub: "Auto Chat ID", placeholder: "" },
    bark:     { label: "Bark (iOS)", sub: "Instant APNs", placeholder: "https://api.day.app/<device-key>/" },
    slack:    { label: "Slack", sub: "Incoming Hook", placeholder: "https://hooks.slack.com/services/..." },
    discord:  { label: "Discord", sub: "Channel Hook", placeholder: "https://discord.com/api/webhooks/..." },
    ntfy:     { label: "ntfy", sub: "Pub/Sub Topic", placeholder: "https://ntfy.sh/<your-topic>" },
    webhook:  { label: "Custom JSON", sub: "HTTP POST", placeholder: "https://example.com/hooks/self-starter" },
    email:    { label: "SMTP Email", sub: "App Password", placeholder: "you@gmail.com or you@fastmail.com" }
  };

  const HOST_LABELS = {
    "codex": "Codex",
    "claude-code": "Claude Code",
    "zcode": "ZCode",
    "opencode": "OpenCode"
  };

  const HOST_AVATARS = {
    "codex": "CX",
    "claude-code": "CC",
    "zcode": "ZC",
    "opencode": "OC"
  };

  // Minimal stroke SVG paths (16x16 viewBox, stroke=currentColor)
  const SVG_PATHS = {
    bolt: '<path d="M9 2L4 9.5h4.2L7 14l5-7.5H7.8L9 2z"/>',
    inbox: '<path d="M2.5 9.5L4.2 3.5h7.6l1.7 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3z"/><path d="M2.5 9.5h3.2l1 1.5h2.6l1-1.5h3.2"/>',
    watch: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3.2l2.2 1.3"/><path d="M6 1.8h4"/>',
    agents: '<rect x="2.5" y="3" width="11" height="8" rx="1.8"/><path d="M5.5 13.5h5"/><path d="M8 11v2.5"/><circle cx="6" cy="7" r="0.9"/><circle cx="10" cy="7" r="0.9"/>',
    channels: '<path d="M2.5 8a5.5 5.5 0 0 1 9.5-3.8"/><path d="M13.5 8a5.5 5.5 0 0 1-9.5 3.8"/><circle cx="8" cy="8" r="1.8"/>',
    secrets: '<rect x="3.2" y="7.2" width="9.6" height="6.5" rx="1.5"/><path d="M5.2 7.2V5a2.8 2.8 0 0 1 5.6 0v2.2"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/>',
    moon: '<path d="M12.8 9.8A5.2 5.2 0 0 1 6.2 3.2a5.3 5.3 0 1 0 6.6 6.6z"/>',
    auto: '<rect x="2.2" y="3" width="11.6" height="8" rx="1.4"/><path d="M5.5 13.5h5"/>',
    bell: '<path d="M4.2 6.8a3.8 3.8 0 0 1 7.6 0c0 3.2 1.4 4.2 1.4 4.2H2.8s1.4-1 1.4-4.2"/><path d="M6.6 13a1.6 1.6 0 0 0 2.8 0"/>',
    check: '<path d="M3.2 8.3l3.1 3.1 6.5-6.6"/>',
    play: '<polygon points="4.5,3 12.5,8 4.5,13"/>',
    code: '<polyline points="5.5,4.5 2,8 5.5,11.5"/><polyline points="10.5,4.5 14,8 10.5,11.5"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M3.5 10.5h-0.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v0.5"/>',
    refresh: '<path d="M13.2 6.2A5.5 5.5 0 0 0 3.4 4.8L2.5 6"/><path d="M2.5 3v3h3"/><path d="M2.8 9.8a5.5 5.5 0 0 0 9.8 1.4l0.9-1.2"/><path d="M13.5 13v-3h-3"/>'
  };

  function iconEl(name, extraClass) {
    const span = document.createElement("span");
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    const cls = extraClass ? "icon " + extraClass : "icon";
    span.innerHTML = '<svg class="' + cls + '" viewBox="0 0 16 16" aria-hidden="true">' + (SVG_PATHS[name] || "") + "</svg>";
    return span.firstChild;
  }

  const state = {
    tab: "inbox",            // "inbox" | "watches" | "agent-detail" | "agents" | "channels" | "secrets"
    userSwitchedTab: false,
    inboxSub: "attention",   // "attention" | "held" | "all"
    agentSub: "probes",      // "probes" | "inbox" | "config"
    agentFilter: "all",      // "all" | "codex" | "claude-code" | "zcode" | "opencode"
    searchQuery: "",
    channelKind: "feishu",   // active tile in Push Channels
    theme: localStorage.getItem("ss_theme") || "light",
    snapshot: null,
    connected: false,
    browserAlerts: localStorage.getItem("ss_browser_alerts") === "1",
    seenFireIds: new Set(),
    expandedFires: new Set(),
    firstSnapshotLoaded: false,
    doctorResult: null,
    doctorLoading: false
  };

  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem("ss_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }
  applyTheme(state.theme);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.className = String(v);
        else if (k === "dataset") {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
        } else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          node.setAttribute(k, "");
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function showToast(msg, isError) {
    const root = document.getElementById("toast-root");
    if (!root) return;
    root.hidden = false;
    root.replaceChildren(el("div", { class: isError ? "toast error" : "toast" }, msg));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { root.hidden = true; }, 3400);
  }

  async function api(path, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const headers = Object.assign({ "X-Self-Starter-UI": "1" }, opts.headers || {});
    let body;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { method, headers, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }

  function formatRelTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    if (diffSec >= 0 && diffSec < 45) return "just now";
    if (diffSec >= 45 && diffSec < 3600) return Math.floor(diffSec / 60) + "m ago";
    if (diffSec >= 3600 && diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
    if (diffSec >= 86400 && diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + "d ago";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatFullTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  function formatNextTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const aheadSec = Math.round((d.getTime() - Date.now()) / 1000);
    if (aheadSec <= 5) return "due now";
    if (aheadSec < 60) return "in " + aheadSec + "s";
    if (aheadSec < 3600) return "in " + Math.round(aheadSec / 60) + "m";
    if (aheadSec < 86400) return "in " + Math.round(aheadSec / 3600) + "h";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatInterval(iv) {
    if (!iv) return "";
    if (typeof iv === "string") return iv.includes("–") ? iv : ("every " + iv);
    if (typeof iv === "object") {
      if (iv.min && iv.max && iv.min !== iv.max) return iv.min + "–" + iv.max;
      const val = iv.default || iv.min || "";
      return val ? ("every " + val) : "";
    }
    return String(iv);
  }

  function detectProviderFromUrl(raw) {
    try {
      const u = new URL(raw.trim());
      const h = u.hostname.toLowerCase();
      if (h === "open.feishu.cn" || h === "open.larksuite.com" || h.endsWith(".feishu.cn") || h.endsWith(".larksuite.com")) return "feishu";
      if (h === "qyapi.weixin.qq.com") return "wecom";
      if (h === "oapi.dingtalk.com") return "dingtalk";
      if (h === "hooks.slack.com") return "slack";
      if ((h === "discord.com" || h === "discordapp.com") && u.pathname.startsWith("/api/webhooks/")) return "discord";
      if (h === "api.day.app") return "bark";
      if (h === "ntfy.sh" || h.endsWith(".ntfy.sh")) return "ntfy";
      if (h === "api.telegram.org") return "telegram";
      return "webhook";
    } catch {
      return null;
    }
  }

  function maybeFireBrowserAlerts(snap) {
    const fires = snap.fires || [];
    if (!state.firstSnapshotLoaded) {
      for (const f of fires) state.seenFireIds.add(f.fireId);
      state.firstSnapshotLoaded = true;
      const unreadTotal = ((snap.status && snap.status.attentionCount) || 0) + ((snap.deferred || []).length);
      if (!state.userSwitchedTab && unreadTotal === 0) {
        state.tab = "watches";
      }
      return;
    }
    for (const f of fires) {
      if (state.seenFireIds.has(f.fireId)) continue;
      state.seenFireIds.add(f.fireId);
      if (state.browserAlerts && f.needsAttention && "Notification" in window && Notification.permission === "granted") {
        const body = (f.receipt && f.receipt.summary) || f.error || f.summary || "New Self-Starter event";
        new Notification("Self-Starter · " + f.triggerName, { body: String(body).slice(0, 200) });
      }
    }
  }

  async function refresh() {
    try {
      const snap = await api("/api/snapshot");
      state.snapshot = snap;
      maybeFireBrowserAlerts(snap);
      render(true);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function hostBadgeEl(host) {
    const h = host || "codex";
    return el("span", { class: "host-badge" },
      el("span", { class: "host-dot " + h }),
      HOST_LABELS[h] || h
    );
  }

  function copyText(txt, label) {
    navigator.clipboard.writeText(txt).then(
      () => showToast(label || "Copied to clipboard"),
      () => showToast("Clipboard copy failed", true)
    );
  }

  function closeDrawer() {
    const root = document.getElementById("drawer-root");
    if (!root) return;
    root.hidden = true;
    root.replaceChildren();
  }

  function openDrawer(title, bodyNodes) {
    const root = document.getElementById("drawer-root");
    if (!root) return;
    root.hidden = false;
    const backdrop = el("div", {
      class: "drawer-backdrop",
      onClick: (e) => { if (e.target === backdrop) closeDrawer(); }
    },
      el("div", { class: "drawer" },
        el("div", { class: "card-head" },
          el("h2", { class: "section-title" }, title),
          el("button", { class: "btn btn-sm", onClick: closeDrawer }, "Close")
        ),
        ...bodyNodes
      )
    );
    root.replaceChildren(backdrop);
  }

  async function openInspectDrawer(kind, id) {
    try {
      const data = await api("/api/inspect?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(id));
      const nodes = [
        el("div", { class: "inline-note mono" }, data.codePath || ""),
        el("div", null,
          el("div", { class: "inline-note", style: "margin-bottom:4px;font-weight:600" }, "Probe Source (TypeScript / Deno)"),
          el("pre", { class: "code-block mono" }, data.probeCode || "// empty")
        ),
        el("div", null,
          el("div", { class: "inline-note", style: "margin-bottom:4px;font-weight:600" }, "Definition (trigger.yaml)"),
          el("pre", { class: "code-block mono" }, data.definitionYaml || "")
        )
      ];
      if (data.recentRuns && data.recentRuns.length > 0) {
        nodes.push(
          el("div", null,
            el("div", { class: "inline-note", style: "margin-bottom:4px;font-weight:600" }, "Recent 0-Token Probe Checks"),
            ...data.recentRuns.map((r) =>
              el("div", { class: "list-row" },
                el("span", { class: "mono inline-note" }, formatFullTime(r.ranAt)),
                el("span", { class: r.ok ? "badge ok" : "badge err" }, r.ok ? "ok (" + r.durationMs + "ms)" : "error"),
                el("span", { class: "inline-note" }, r.summary || r.error || "")
              )
            )
          )
        );
      }
      openDrawer(data.name + " (" + data.id + ")", nodes);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function openQuietHoursDrawer(trigger) {
    const cur = trigger.quietHours || {};
    const tzDefault = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    const fromIn = el("input", { class: "input mono", placeholder: "23:00", value: cur.from || "23:00" });
    const toIn = el("input", { class: "input mono", placeholder: "08:00", value: cur.to || "08:00" });
    const tzIn = el("input", { class: "input mono", placeholder: tzDefault, value: cur.tz || tzDefault });

    openDrawer("Quiet Hours · " + trigger.name, [
      el("p", { class: "section-desc" },
        "During quiet hours, agent runs still complete silently in the background, while outbound push notifications are held in the Attention Inbox until the window ends."
      ),
      el("div", { class: "field" }, el("label", null, "Start time (HH:MM)"), fromIn),
      el("div", { class: "field" }, el("label", null, "End time (HH:MM)"), toIn),
      el("div", { class: "field" }, el("label", null, "IANA Time Zone"), tzIn),
      el("div", { class: "btn-row" },
        el("button", {
          class: "btn btn-primary",
          onClick: async () => {
            try {
              await api("/api/triggers/" + encodeURIComponent(trigger.id) + "/update", {
                method: "POST",
                body: { changes: { policy: { quiet_hours: { from: fromIn.value.trim(), to: toIn.value.trim(), tz: tzIn.value.trim() } } } }
              });
              closeDrawer();
              showToast("Saved quiet hours");
              await refresh();
            } catch (err) { showToast(err.message, true); }
          }
        }, "Save Quiet Hours"),
        cur.from ? el("button", {
          class: "btn btn-danger",
          onClick: async () => {
            try {
              await api("/api/triggers/" + encodeURIComponent(trigger.id) + "/update", {
                method: "POST",
                body: { changes: { policy: { quiet_hours: null } } }
              });
              closeDrawer();
              showToast("Cleared quiet hours");
              await refresh();
            } catch (err) { showToast(err.message, true); }
          }
        }, "Disable Quiet Hours") : null
      )
    ]);
  }

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------

  function switchTab(tab) {
    state.tab = tab;
    state.userSwitchedTab = true;
    if (tab === "agents" && !state.doctorResult && !state.doctorLoading) {
      void runDoctor(true);
    }
    render(true);
  }

  function renderSidebar(snap) {
    const st = snap.status || {};
    const checks = st.checks || { total: 0, today: 0 };
    const heldCount = (snap.deferred || []).length;
    const attentionCount = (st.attentionCount || 0) + heldCount;
    const watchCount = (snap.triggers || []).length + (snap.drafts || []).length;
    const agents = snap.agents || [];
    const connectedAgents = agents.filter((a) => Boolean(a.detectedBin)).length;
    const channelCount = ((snap.channels && snap.channels.available) || ["desktop"]).length;
    const secretCount = (snap.secrets || []).length;

    return el("aside", { class: "sidebar" },
      // Brand
      el("div", { class: "sidebar-brand" },
        el("img", { class: "brand-logo", src: "/icon.svg", width: "30", height: "30", alt: "" }),
        el("div", null,
          el("div", { class: "brand-name" }, "Self-Starter"),
          el("div", { class: "brand-status" },
            el("span", { class: state.connected ? "status-dot" : "status-dot offline" }),
            el("span", null, (state.connected ? "Daemon Online" : "Reconnecting") + " · v" + (st.version || ""))
          )
        )
      ),

      // Workspace Group
      el("div", { class: "nav-section" },
        el("div", { class: "nav-section-title" }, "Workspace"),
        el("button", {
          class: state.tab === "watches" ? "nav-btn active" : "nav-btn",
          onClick: () => { state.agentFilter = "all"; switchTab("watches"); }
        },
          el("span", { class: "nav-btn-left" }, iconEl("watch"), "Probe Tasks"),
          el("span", { class: "nav-pill" }, String(watchCount))
        ),
        el("button", {
          class: state.tab === "inbox" ? "nav-btn active" : "nav-btn",
          onClick: () => { state.agentFilter = "all"; switchTab("inbox"); }
        },
          el("span", { class: "nav-btn-left" }, iconEl("inbox"), "Attention Inbox"),
          el("span", { class: attentionCount > 0 ? "nav-pill urgent" : "nav-pill" }, String(attentionCount))
        )
      ),

      // Agents Group
      el("div", { class: "nav-section" },
        el("div", { class: "nav-section-title" }, "Agents"),
        el("button", {
          class: state.tab === "agents" ? "nav-btn active" : "nav-btn",
          onClick: () => { state.agentFilter = "all"; switchTab("agents"); }
        },
          el("span", { class: "nav-btn-left" }, iconEl("agents"), "All Agents Overview"),
          el("span", { class: "nav-pill" }, connectedAgents + "/" + (agents.length || 4))
        ),
        el("div", { class: "agent-filter-list" },
          ...agents.map((a) =>
            el("button", {
              class: (state.tab === "agent-detail" && state.agentFilter === a.id) ? "agent-sub-btn selected" : "agent-sub-btn",
              title: a.detectedBin ? ("Connected: " + a.detectedBin) : "Not configured yet",
              onClick: () => {
                state.agentFilter = a.id;
                state.tab = "agent-detail";
                state.agentSub = "probes";
                render(true);
              }
            },
              el("span", { class: "nav-btn-left", style: "gap:7px" },
                el("span", { class: "host-dot " + a.id }),
                a.name
              ),
              el("span", { class: "mono", style: "font-size:11px;opacity:0.85" },
                a.watchCount + (a.watchCount === 1 ? " probe" : " probes")
              )
            )
          )
        )
      ),

      // Delivery & Security Group
      el("div", { class: "nav-section" },
        el("div", { class: "nav-section-title" }, "Delivery & Security"),
        el("button", {
          class: state.tab === "channels" ? "nav-btn active" : "nav-btn",
          onClick: () => switchTab("channels")
        },
          el("span", { class: "nav-btn-left" }, iconEl("channels"), "Push Channels"),
          el("span", { class: "nav-pill" }, String(channelCount))
        ),
        el("button", {
          class: state.tab === "secrets" ? "nav-btn active" : "nav-btn",
          onClick: () => switchTab("secrets")
        },
          el("span", { class: "nav-btn-left" }, iconEl("secrets"), "Secrets & Policy"),
          el("span", { class: "nav-pill" }, String(secretCount))
        )
      ),

      // Sidebar Footer: 0-Token Telemetry + Browser Alerts + Theme Switcher
      el("div", { class: "sidebar-footer" },
        el("div", { class: "telemetry-box" },
          el("div", { class: "telemetry-top" },
            el("span", { class: "telemetry-num" }, Number(checks.total || 0).toLocaleString() + " checks"),
            el("span", { class: "zero-chip" }, "0 tokens")
          ),
          el("div", { class: "telemetry-sub" },
            Number(checks.today || 0).toLocaleString() + " probe runs today · " + (st.agentRunsToday || 0) + " agent wakes"
          )
        ),

        el("button", {
          class: state.browserAlerts ? "sidebar-util-btn on" : "sidebar-util-btn",
          onClick: async () => {
            if (!("Notification" in window)) {
              showToast("Browser Notifications API not supported here", true);
              return;
            }
            if (!state.browserAlerts) {
              const perm = await Notification.requestPermission();
              if (perm !== "granted") {
                showToast("Notification permission denied by browser", true);
                return;
              }
              state.browserAlerts = true;
              localStorage.setItem("ss_browser_alerts", "1");
              showToast("Browser Alerts enabled");
            } else {
              state.browserAlerts = false;
              localStorage.setItem("ss_browser_alerts", "0");
              showToast("Browser Alerts muted");
            }
            render(true);
          }
        },
          el("span", { class: "nav-btn-left", style: "gap:7px" }, iconEl("bell", "icon-sm"), "Browser Alerts"),
          el("span", { class: "mono", style: "font-size:11px" }, state.browserAlerts ? "ON" : "OFF")
        ),

        el("div", { class: "theme-switcher", role: "group", "aria-label": "Color theme" },
          el("button", {
            class: state.theme === "light" ? "theme-opt active" : "theme-opt",
            title: "Warm celadon eye-care light theme",
            onClick: () => { applyTheme("light"); render(true); }
          }, iconEl("sun", "icon-sm"), "Light"),
          el("button", {
            class: state.theme === "dark" ? "theme-opt active" : "theme-opt",
            title: "Obsidian-sage dark theme",
            onClick: () => { applyTheme("dark"); render(true); }
          }, iconEl("moon", "icon-sm"), "Dark"),
          el("button", {
            class: state.theme === "auto" ? "theme-opt active" : "theme-opt",
            title: "Follow system color scheme",
            onClick: () => { applyTheme("auto"); render(true); }
          }, iconEl("auto", "icon-sm"), "Auto")
        )
      )
    );
  }

  function renderFilterBanner() {
    if (state.agentFilter === "all") return null;
    const label = HOST_LABELS[state.agentFilter] || state.agentFilter;
    return el("div", { class: "filter-banner" },
      el("span", { class: "nav-btn-left" },
        el("span", { class: "host-dot " + state.agentFilter }),
        "Filtered to agent: " + label
      ),
      el("button", {
        class: "btn btn-sm",
        onClick: () => { state.agentFilter = "all"; render(true); }
      }, "Show All Agents")
    );
  }

  // ---------------------------------------------------------------------------
  // View 1: Attention Inbox
  // ---------------------------------------------------------------------------

  function matchesSearch(fire, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    return (
      String(fire.triggerName || "").toLowerCase().includes(s) ||
      String(fire.triggerId || "").toLowerCase().includes(s) ||
      String((fire.receipt && fire.receipt.summary) || "").toLowerCase().includes(s) ||
      String(fire.summary || "").toLowerCase().includes(s) ||
      String(fire.error || "").toLowerCase().includes(s)
    );
  }

  function renderFireCard(f) {
    const isErr = f.status === "failed";
    const cardCls = isErr ? "card failed" : (f.needsAttention ? "card attention" : "card");

    const statusBadge = isErr
      ? el("span", { class: "badge err" }, "delivery failed")
      : (f.receipt && f.receipt.notify
          ? el("span", { class: "badge warn" }, "agent alert")
          : el("span", { class: "badge" }, f.status));

    const bodyText = (f.receipt && f.receipt.summary) || f.error || f.summary || "";
    const isLong = bodyText.length > 340 || bodyText.split("\\n").length > 5;
    const isExpanded = state.expandedFires.has(f.fireId);

    const reopenCmd = f.reopen && f.reopen.command;
    const reopenUrl = f.reopen && f.reopen.url;

    return el("div", { class: cardCls },
      el("div", { class: "card-head" },
        el("div", { class: "card-title-row" },
          el("h3", { class: "card-title" }, f.triggerName),
          hostBadgeEl(f.host),
          statusBadge
        ),
        el("span", { class: "time-label", title: formatFullTime(f.firedAt) + " · " + f.fireId },
          formatRelTime(f.firedAt)
        )
      ),

      bodyText ? el("div", null,
        el("div", { class: (isLong && !isExpanded) ? "receipt-body clamped" : "receipt-body" }, bodyText),
        isLong ? el("button", {
          class: "expand-link",
          onClick: () => {
            if (isExpanded) state.expandedFires.delete(f.fireId);
            else state.expandedFires.add(f.fireId);
            render(true);
          }
        }, isExpanded ? "Collapse report ▴" : "Show full report ▾") : null
      ) : null,

      el("div", { class: "card-foot" },
        el("div", { class: "probe-snippet", title: f.summary || "" },
          (f.receipt && f.summary && f.summary !== bodyText)
            ? ("Probe: " + f.summary)
            : ("Trigger: " + f.triggerId + " · #" + f.fireNumber)
        ),
        el("div", { class: "btn-row" },
          reopenUrl ? el("a", { class: "btn btn-sm", href: reopenUrl }, "Open in Codex") : null,
          reopenCmd ? el("button", {
            class: "btn btn-sm",
            title: reopenCmd,
            onClick: () => copyText(reopenCmd, "Copied: " + reopenCmd)
          }, iconEl("copy", "icon-sm"), "Resume Session") : null,
          f.needsAttention ? el("button", {
            class: "btn btn-sm btn-primary",
            onClick: async () => {
              await api("/api/fires/ack", { method: "POST", body: { fireIds: [f.fireId] } });
              await refresh();
            }
          }, iconEl("check", "icon-sm"), "Mark Read") : el("span", { class: "inline-note" }, "Read")
        )
      )
    );
  }

  function renderDeferredCard(d) {
    const heldLabel = d.quiet && d.quiet.to
      ? ("held until " + d.quiet.to + (d.quiet.tz ? " " + d.quiet.tz : ""))
      : (d.deliverAfterLabel ? ("held until " + d.deliverAfterLabel) : "held · quiet hours");
    return el("div", { class: "card attention" },
      el("div", { class: "card-head" },
        el("div", { class: "card-title-row" },
          el("h3", { class: "card-title" }, d.title),
          el("span", { class: "badge warn" }, heldLabel)
        ),
        el("span", { class: "time-label" }, formatRelTime(d.heldAt || d.queuedAt))
      ),
      el("div", { class: "receipt-body" }, d.body),
      el("div", { class: "card-foot" },
        el("span", { class: "probe-snippet" },
          "Target channels: " + (d.channels && d.channels.length ? d.channels.join(", ") : "default")
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm btn-primary",
            onClick: async () => {
              await api("/api/deferred/flush", { method: "POST", body: { id: d.id } });
              showToast("Sent notification immediately");
              await refresh();
            }
          }, "Send Now"),
          el("button", {
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              await api("/api/deferred/drop", { method: "POST", body: { id: d.id } });
              showToast("Discarded held notification");
              await refresh();
            }
          }, "Discard")
        )
      )
    );
  }

  function renderInboxView(snap) {
    const hostFilter = state.agentFilter;
    const allFires = (snap.fires || []).filter((f) => hostFilter === "all" || (f.host || "codex") === hostFilter);
    const deferred = snap.deferred || [];
    const unreadFires = allFires.filter((f) => f.needsAttention);

    const searchInput = el("input", {
      class: "search-input",
      placeholder: "Filter by watch or summary…",
      value: state.searchQuery,
      onInput: (e) => {
        state.searchQuery = e.target.value;
        const feedContainer = document.getElementById("inbox-feed-list");
        if (feedContainer) feedContainer.replaceChildren(...buildFeedItems());
      }
    });

    function buildFeedItems() {
      const q = state.searchQuery.trim();
      if (state.inboxSub === "held") {
        if (deferred.length === 0) {
          return [el("div", { class: "empty-state" },
            el("h3", null, "No held notifications"),
            el("p", null, "Notifications suppressed during quiet hours appear here so you can flush or discard them anytime.")
          )];
        }
        return deferred.map(renderDeferredCard);
      }
      if (state.inboxSub === "all") {
        const list = allFires.filter((f) => matchesSearch(f, q));
        if (list.length === 0) {
          return [el("div", { class: "empty-state" }, el("h3", null, "No matching fire events"))];
        }
        return list.map(renderFireCard);
      }
      // Needs Attention
      const list = unreadFires.filter((f) => matchesSearch(f, q));
      const nodes = [];
      if (!q) nodes.push(...deferred.map(renderDeferredCard));
      nodes.push(...list.map(renderFireCard));
      if (nodes.length === 0) {
        return [el("div", { class: "empty-state" },
          el("h3", null, "Inbox Zero — everything is quiet"),
          el("p", null, "Background probes continue running at 0 LLM tokens. Only actionable agent receipts and alerts surface here.")
        )];
      }
      return nodes;
    }

    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" }, "Attention Inbox"),
          el("p", { class: "page-subtitle" },
            "Actionable agent receipts, delivery failures, and quiet-hours queue across Codex, Claude Code, ZCode and OpenCode."
          )
        ),
        el("div", { class: "header-actions" },
          deferred.length > 0 ? el("button", {
            class: "btn btn-signal",
            onClick: async () => {
              const r = await api("/api/deferred/flush", { method: "POST", body: {} });
              showToast("Sent " + r.sent + " held notification(s)");
              await refresh();
            }
          }, "Flush Held (" + deferred.length + ")") : null,
          unreadFires.length > 0 ? el("button", {
            class: "btn btn-primary",
            onClick: async () => {
              const ids = unreadFires.map((f) => f.fireId);
              const r = await api("/api/fires/ack", { method: "POST", body: { fireIds: ids } });
              showToast("Marked " + r.acknowledged + " item(s) read");
              await refresh();
            }
          }, iconEl("check", "icon-sm"), "Mark All Read (" + unreadFires.length + ")") : null
        )
      ),

      renderFilterBanner(),

      el("div", { class: "toolbar" },
        el("div", { class: "seg-group" },
          el("button", {
            class: state.inboxSub === "attention" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.inboxSub = "attention"; render(true); }
          }, "Needs Attention (" + (unreadFires.length + deferred.length) + ")"),
          el("button", {
            class: state.inboxSub === "held" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.inboxSub = "held"; render(true); }
          }, "Held (" + deferred.length + ")"),
          el("button", {
            class: state.inboxSub === "all" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.inboxSub = "all"; render(true); }
          }, "All Recent (" + allFires.length + ")")
        ),
        searchInput
      ),

      el("div", { id: "inbox-feed-list", class: "stack" }, ...buildFeedItems())
    );
  }

  // ---------------------------------------------------------------------------
  // View 2: Watches & Drafts
  // ---------------------------------------------------------------------------

  function renderDraftCard(d) {
    const trial = d.trial;
    return el("div", { class: "card attention" },
      el("div", { class: "card-head" },
        el("div", { class: "card-title-row" },
          el("h3", { class: "card-title" }, d.name),
          hostBadgeEl(d.host),
          el("span", { class: "badge warn" }, "pending draft"),
          d.replaces ? el("span", { class: "badge" }, "replaces " + d.replaces) : null
        ),
        el("span", { class: "time-label" }, formatRelTime(d.createdAt))
      ),
      d.intent ? el("p", { class: "meta-line" }, d.intent) : null,
      trial ? el("div", { class: "receipt-body" },
        (trial.ok ? "Dry-run OK (" + trial.durationMs + "ms): " : "Dry-run failed: ") + (trial.summary || trial.error || "")
      ) : null,
      (d.warnings && d.warnings.length > 0) ? el("div", { class: "meta-line", style: "color:var(--signal);margin-top:6px" },
        "Warnings: " + d.warnings.join(" · ")
      ) : null,
      el("div", { class: "card-foot" },
        el("span", { class: "mono inline-note" }, d.draftId),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: () => openInspectDrawer("draft", d.draftId)
          }, iconEl("code", "icon-sm"), "Code & YAML"),
          el("button", {
            class: "btn btn-sm btn-primary",
            onClick: async () => {
              await api("/api/drafts/" + encodeURIComponent(d.draftId) + "/activate", { method: "POST" });
              showToast("Activated " + d.name);
              await refresh();
            }
          }, "Activate Watch"),
          el("button", {
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              await api("/api/drafts/" + encodeURIComponent(d.draftId), { method: "DELETE" });
              showToast("Discarded draft");
              await refresh();
            }
          }, "Discard")
        )
      )
    );
  }

  function renderWatchCard(t, snap) {
    const avail = (snap.channels && snap.channels.available) || ["desktop"];
    const defaultChs = (snap.channels && snap.channels.default) || ["desktop"];
    const curWhen = (t.notify && t.notify.when) || "receipt";
    const explicitChs = (t.notify && Array.isArray(t.notify.channels) && t.notify.channels.length > 0)
      ? t.notify.channels
      : null;

    const lifeBadgeCls = t.lifecycle === "active"
      ? (t.health === "degraded" ? "badge warn" : "badge ok")
      : (t.lifecycle === "paused" ? "badge" : "badge warn");

    const whenSelect = el("select", {
      class: "select",
      style: "padding:3px 8px;font-size:12px",
      onChange: async (e) => {
        try {
          await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
            method: "POST",
            body: { changes: { notify: { when: e.target.value } } }
          });
          showToast("Updated notify mode for " + t.name);
          await refresh();
        } catch (err) { showToast(err.message, true); }
      }
    },
      el("option", { value: "receipt", selected: curWhen === "receipt" }, "On agent alert (notify=true)"),
      el("option", { value: "always", selected: curWhen === "always" }, "Every fire"),
      el("option", { value: "never", selected: curWhen === "never" }, "Silent (history only)")
    );

    const pills = [
      el("button", {
        class: explicitChs === null ? "channel-pill selected" : "channel-pill",
        title: "Use global default channels (" + defaultChs.join(", ") + ")",
        onClick: async () => {
          await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
            method: "POST",
            body: { changes: { notify: { channels: null } } }
          });
          showToast(t.name + " now follows default channels");
          await refresh();
        }
      }, "Default (" + defaultChs.join("+") + ")"),
      ...avail.map((ch) => {
        const isSel = explicitChs !== null && explicitChs.includes(ch);
        return el("button", {
          class: isSel ? "channel-pill selected" : "channel-pill",
          onClick: async () => {
            const base = explicitChs ? explicitChs.slice() : [];
            const idx = base.indexOf(ch);
            if (idx >= 0) base.splice(idx, 1);
            else base.push(ch);
            await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
              method: "POST",
              body: { changes: { notify: { channels: base.length > 0 ? base : null } } }
            });
            await refresh();
          }
        }, ch);
      }),
      avail.length <= 1 ? el("button", {
        class: "channel-pill",
        style: "border-style:dashed",
        onClick: () => switchTab("channels")
      }, "+ Connect Push") : null
    ];

    const lastSummary = t.lastCheck
      ? (t.lastCheck.ok
          ? ("Last check " + formatRelTime(t.lastCheck.at) + (t.lastCheck.summary ? " · " + t.lastCheck.summary : ""))
          : ("Probe error " + formatRelTime(t.lastCheck.at) + " · " + (t.lastCheck.error || "failed")))
      : "No checks recorded yet";

    return el("div", { class: t.health === "degraded" ? "card failed" : "card" },
      el("div", { class: "card-head" },
        el("div", { class: "card-title-row" },
          el("h3", {
            class: "card-title",
            style: "cursor:pointer",
            title: "Click to inspect probe source code & check logs",
            onClick: () => openInspectDrawer("trigger", t.id)
          }, t.name),
          el("span", { class: "badge" }, t.id),
          hostBadgeEl(t.host),
          el("span", { class: lifeBadgeCls }, t.health === "degraded" ? (t.lifecycle + " · degraded") : t.lifecycle),
          el("span", { class: "badge" }, t.mode + (t.interval ? " · " + formatInterval(t.interval) : ""))
        ),
        el("div", { class: "card-title-row" },
          el("span", { class: "badge ok" }, Number(t.checks || 0).toLocaleString() + " checks"),
          el("span", { class: "badge" }, Number(t.fires || 0) + " fires")
        )
      ),

      t.intent ? el("p", { class: "meta-line", style: "margin-top:6px;font-size:13px;color:var(--fg)" }, t.intent) : null,
      el("div", { class: "meta-line", style: t.lastCheck && !t.lastCheck.ok ? "color:var(--down)" : "", title: t.nextCheck ? ("Next run: " + formatFullTime(t.nextCheck)) : "" },
        lastSummary + (t.nextCheck ? " · Next run " + formatNextTime(t.nextCheck) : "")
      ),

      // Outbound Routing Strip
      el("div", { class: "routing-box" },
        el("div", { class: "pill-list" },
          el("span", { class: "inline-note", style: "font-weight:600" }, "Push:"),
          whenSelect,
          ...pills
        ),
        el("button", {
          class: "btn btn-sm",
          onClick: () => openQuietHoursDrawer(t)
        }, t.quietHours ? ("Quiet " + t.quietHours.from + "–" + t.quietHours.to) : "Quiet hours: off")
      ),

      el("div", { class: "card-foot" },
        el("span", { class: "inline-note" },
          "Action: " + t.action + (t.action === "agent" ? (" (" + t.target + " " + (HOST_LABELS[t.host] || t.host) + ")") : "")
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                const res = await api("/api/triggers/" + encodeURIComponent(t.id) + "/test", { method: "POST" });
                showToast(res.ok ? ("Probe OK (" + res.durationMs + "ms): " + (res.summary || "done")) : ("Probe failed: " + res.error), !res.ok);
                await refresh();
              } catch (err) { showToast(err.message, true); }
              finally { btn.disabled = false; }
            }
          }, iconEl("play", "icon-sm"), "Run Probe"),
          el("button", {
            class: "btn btn-sm",
            onClick: () => openInspectDrawer("trigger", t.id)
          }, iconEl("code", "icon-sm"), "Probe Code & Logs"),
          t.lifecycle === "paused" ? el("button", {
            class: "btn btn-sm btn-primary",
            onClick: async () => {
              await api("/api/triggers/" + encodeURIComponent(t.id) + "/resume", { method: "POST" });
              showToast("Resumed " + t.name);
              await refresh();
            }
          }, "Resume") : el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              await api("/api/triggers/" + encodeURIComponent(t.id) + "/pause", { method: "POST" });
              showToast("Paused " + t.name);
              await refresh();
            }
          }, "Pause"),
          el("button", {
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              if (!confirm('Delete watch "' + t.name + '" (' + t.id + ')?')) return;
              await api("/api/triggers/" + encodeURIComponent(t.id), { method: "DELETE" });
              showToast("Deleted " + t.name);
              await refresh();
            }
          }, "Delete")
        )
      )
    );
  }

  function renderWatchesView(snap) {
    const hostFilter = state.agentFilter;
    const allTriggers = snap.triggers || [];
    const triggers = allTriggers.filter((t) => hostFilter === "all" || (t.host || "codex") === hostFilter);
    const drafts = (snap.drafts || []).filter((d) => hostFilter === "all" || (d.host || "codex") === hostFilter);

    const activeCount = triggers.filter((t) => t.lifecycle === "active").length;
    const pausedCount = triggers.length - activeCount;
    const sumChecks = triggers.reduce((acc, t) => acc + (t.checks || 0), 0);
    const sumFires = triggers.reduce((acc, t) => acc + (t.fires || 0), 0);

    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" }, "Probe Tasks"),
          el("p", { class: "page-subtitle" },
            "Create probe tasks in plain language inside your agent; inspect probe code, test runs, quiet hours, and per-task push routing here."
          )
        ),
        el("div", { class: "header-actions" },
          el("button", { class: "btn", onClick: () => switchTab("agents") }, iconEl("agents", "icon-sm"), "Agent Setup"),
          el("button", { class: "btn btn-primary", onClick: () => switchTab("channels") }, iconEl("channels", "icon-sm"), "Connect Push Channel")
        )
      ),

      renderFilterBanner(),

      el("div", { class: "kpi-grid" },
        el("div", { class: "kpi-card" },
          el("div", { class: "kpi-label" }, "Active Watches"),
          el("div", { class: "kpi-value" }, String(activeCount)),
          el("div", { class: "kpi-foot" }, drafts.length > 0 ? (drafts.length + " draft(s) awaiting activation") : "Running on local Deno schedule")
        ),
        el("div", { class: "kpi-card" },
          el("div", { class: "kpi-label" }, "Paused / Inactive"),
          el("div", { class: "kpi-value" }, String(pausedCount)),
          el("div", { class: "kpi-foot" }, "Preserved in ~/.self-starter/triggers")
        ),
        el("div", { class: "kpi-card" },
          el("div", { class: "kpi-label" }, "0-Token Probe Runs"),
          el("div", { class: "kpi-value" }, sumChecks.toLocaleString()),
          el("div", { class: "kpi-foot" }, "Zero LLM context spent polling")
        ),
        el("div", { class: "kpi-card" },
          el("div", { class: "kpi-label" }, "Triggered Fires"),
          el("div", { class: "kpi-value" }, sumFires.toLocaleString()),
          el("div", { class: "kpi-foot" }, "State transitions & deduplicated events")
        )
      ),

      drafts.length > 0 ? el("div", { class: "stack", style: "margin-bottom:18px" },
        ...drafts.map(renderDraftCard)
      ) : null,

      triggers.length > 0
        ? el("div", { class: "stack" }, ...triggers.map((t) => renderWatchCard(t, snap)))
        : el("div", { class: "empty-state" },
            el("h3", null, hostFilter === "all" ? "No watches configured yet" : ("No watches bound to " + (HOST_LABELS[hostFilter] || hostFilter))),
            el("p", null, 'Ask Codex, Claude Code, ZCode or OpenCode in plain words—e.g. "Watch NVDA and alert me when it breaks 150 on high volume."')
          )
    );
  }

  // ---------------------------------------------------------------------------
  // View 3: Multi-Agent Hub (Agents)
  // ---------------------------------------------------------------------------

  async function runDoctor(silent) {
    state.doctorLoading = true;
    render(true);
    try {
      const res = await api("/api/agents/doctor");
      state.doctorResult = res;
      if (!silent) showToast("Completed host diagnostics");
    } catch (err) {
      if (!silent) showToast(err.message, true);
    } finally {
      state.doctorLoading = false;
      render(true);
    }
  }

  function renderAgentCard(agent) {
    const connected = Boolean(agent.detectedBin);
    const binInput = el("input", {
      class: "input mono",
      placeholder: "Auto-detect on PATH (or enter /absolute/path/to/" + (agent.id === "claude-code" ? "claude" : agent.id) + ")",
      value: agent.configuredBin || ""
    });

    return el("div", { class: "agent-card" },
      el("div", { class: "agent-card-top" },
        el("div", { class: "card-title-row", style: "gap:11px" },
          el("div", { class: "agent-avatar", style: "border-color:color-mix(in srgb, var(--host-" + (agent.id === "claude-code" ? "claude" : agent.id) + ") 45%, var(--line))" },
            el("span", { class: "host-dot " + agent.id, style: "display:none" }),
            HOST_AVATARS[agent.id] || "AG"
          ),
          el("div", null,
            el("div", { class: "card-title-row" },
              el("h3", { class: "card-title" }, agent.name),
              el("span", { class: connected ? "badge ok" : "badge" }, connected ? "Detected" : "Not Found")
            ),
            el("div", { class: "meta-line" }, agent.vendor)
          )
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: () => {
              state.agentFilter = agent.id;
              state.tab = "agent-detail";
              state.agentSub = "probes";
              render(true);
            }
          }, agent.watchCount + (agent.watchCount === 1 ? " probe" : " probes")),
          agent.attentionCount > 0 ? el("button", {
            class: "btn btn-sm btn-signal",
            onClick: () => {
              state.agentFilter = agent.id;
              state.tab = "agent-detail";
              state.agentSub = "inbox";
              render(true);
            }
          }, agent.attentionCount + " unread") : null
        )
      ),

      el("div", { class: "cap-list" },
        ...(agent.capabilities || []).map((c) => el("span", { class: "cap-chip" }, c))
      ),

      el("div", { class: "inline-note mono" },
        agent.detectedBin ? ("Executable: " + agent.detectedBin) : "CLI binary not detected on daemon PATH"
      ),

      el("details", { class: "advanced" },
        el("summary", null, "Configure CLI Path & Plugin Install Command"),
        el("div", { style: "margin-top:10px" },
          el("div", { class: "field" },
            el("label", null, "Custom CLI executable path (" + agent.configKey + ")"),
            el("div", { class: "btn-row" },
              el("div", { style: "flex:1;min-width:200px" }, binInput),
              el("button", {
                class: "btn btn-primary",
                onClick: async () => {
                  try {
                    const body = {};
                    body[agent.configKey] = binInput.value.trim();
                    await api("/api/agents/config", { method: "POST", body });
                    showToast("Updated " + agent.name + " CLI path");
                    await refresh();
                  } catch (err) { showToast(err.message, true); }
                }
              }, "Save")
            )
          ),
          el("div", { class: "field", style: "margin-bottom:0" },
            el("label", null, "Plugin installation command"),
            el("div", { class: "routing-box", style: "margin-top:2px" },
              el("code", { style: "font-size:11.5px;word-break:break-all;flex:1" }, agent.installCmd),
              el("button", {
                class: "btn btn-sm",
                onClick: () => copyText(agent.installCmd, "Copied install command")
              }, iconEl("copy", "icon-sm"), "Copy")
            )
          )
        )
      )
    );
  }

  function renderAgentsView(snap) {
    const agents = snap.agents || [];
    const doc = state.doctorResult;

    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" }, "Agents"),
          el("p", { class: "page-subtitle" },
            "One shared 0-token background probe engine serving connected agents simultaneously."
          )
        ),
        el("div", { class: "header-actions" },
          el("button", {
            class: "btn btn-primary",
            disabled: state.doctorLoading,
            onClick: () => runDoctor(false)
          }, iconEl("refresh", "icon-sm"), state.doctorLoading ? "Checking Hosts…" : "Run Doctor Diagnostics")
        )
      ),

      el("div", { class: "agent-grid" },
        ...agents.map(renderAgentCard)
      ),

      el("div", { class: "card", style: "margin-top:16px" },
        el("div", { class: "card-head" },
          el("div", null,
            el("h2", { class: "section-title" }, "Live Environment & Plugin Diagnostics"),
            el("p", { class: "section-desc", style: "margin-bottom:0" },
              doc ? ("Checked at " + formatFullTime(doc.checkedAt)) : "Inspects Node, bundled Deno, systemd/launchd service, and each agent's plugin registration."
            )
          )
        ),
        doc && doc.checks ? el("div", { style: "margin-top:10px" },
          ...doc.checks.map((c) =>
            el("div", { class: "list-row" },
              el("div", { class: "card-title-row" },
                el("span", { class: c.ok ? "badge ok" : "badge err" }, c.ok ? "PASS" : "WARN"),
                el("strong", { class: "mono", style: "font-size:12.5px" }, c.label)
              ),
              el("span", { class: "inline-note", style: "word-break:break-word" }, c.detail)
            )
          )
        ) : el("div", { class: "inline-note", style: "margin-top:10px" },
          state.doctorLoading ? "Running self-starter doctor checks…" : "Click 'Run Doctor Diagnostics' above to inspect plugin registration."
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // View 4: Push Channels
  // ---------------------------------------------------------------------------

  function renderConfiguredChannelsCard(snap) {
    const ch = snap.channels || { default: ["desktop"], available: ["desktop"], webhooks: {}, email: null };
    const defaults = new Set(ch.default || ["desktop"]);
    const webhooks = ch.webhooks || {};

    async function toggleDefault(id) {
      const next = new Set(defaults);
      if (next.has(id)) {
        if (next.size === 1) {
          showToast("At least one default channel must stay enabled", true);
          return;
        }
        next.delete(id);
      } else {
        next.add(id);
      }
      await api("/api/channels/default", { method: "POST", body: { channels: Array.from(next) } });
      showToast("Default route: " + Array.from(next).join(", "));
      await refresh();
    }

    async function testChannel(id, btn) {
      btn.disabled = true;
      try {
        await api("/api/channels/" + encodeURIComponent(id) + "/test", { method: "POST" });
        showToast("Sent test push to " + id);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    const rows = [];
    rows.push(
      el("div", { class: "list-row" },
        el("div", null,
          el("div", { class: "card-title-row" },
            el("strong", { class: "mono" }, "desktop"),
            el("span", { class: "badge" }, "System Alert"),
            defaults.has("desktop") ? el("span", { class: "badge ok" }, "default route") : null
          ),
          el("div", { class: "inline-note" }, "macOS Notification Center / Linux notify-send")
        ),
        el("div", { class: "btn-row" },
          el("button", { class: "btn btn-sm", onClick: () => toggleDefault("desktop") },
            defaults.has("desktop") ? "Unset Default" : "Set Default"
          ),
          el("button", { class: "btn btn-sm", onClick: (e) => testChannel("desktop", e.currentTarget) }, "Send Test")
        )
      )
    );

    if (ch.email) {
      rows.push(
        el("div", { class: "list-row" },
          el("div", null,
            el("div", { class: "card-title-row" },
              el("strong", { class: "mono" }, "email"),
              el("span", { class: "badge" }, "SMTP"),
              defaults.has("email") ? el("span", { class: "badge ok" }, "default route") : null
            ),
            el("div", { class: "inline-note" }, ch.email.to + " via " + ch.email.host + ":" + ch.email.port)
          ),
          el("div", { class: "btn-row" },
            el("button", { class: "btn btn-sm", onClick: () => toggleDefault("email") },
              defaults.has("email") ? "Unset Default" : "Set Default"
            ),
            el("button", { class: "btn btn-sm", onClick: (e) => testChannel("email", e.currentTarget) }, "Send Test"),
            el("button", {
              class: "btn btn-sm btn-danger",
              onClick: async () => {
                await api("/api/channels/email", { method: "DELETE" });
                showToast("Removed email channel");
                await refresh();
              }
            }, "Remove")
          )
        )
      );
    }

    for (const [id, meta] of Object.entries(webhooks)) {
      const pInfo = PROVIDER_META[meta.provider] || { label: meta.provider };
      rows.push(
        el("div", { class: "list-row" },
          el("div", null,
            el("div", { class: "card-title-row" },
              el("strong", { class: "mono" }, id),
              el("span", { class: "badge" }, pInfo.label),
              meta.hasSigningSecret ? el("span", { class: "badge ok" }, "HMAC") : null,
              defaults.has(id) ? el("span", { class: "badge ok" }, "default route") : null
            ),
            el("div", { class: "inline-note" }, (meta.label ? meta.label + " · " : "") + meta.hint)
          ),
          el("div", { class: "btn-row" },
            el("button", { class: "btn btn-sm", onClick: () => toggleDefault(id) },
              defaults.has(id) ? "Unset Default" : "Set Default"
            ),
            el("button", { class: "btn btn-sm", onClick: (e) => testChannel(id, e.currentTarget) }, "Send Test"),
            el("button", {
              class: "btn btn-sm btn-danger",
              onClick: async () => {
                await api("/api/channels/" + encodeURIComponent(id), { method: "DELETE" });
                showToast("Removed channel " + id);
                await refresh();
              }
            }, "Remove")
          )
        )
      );
    }

    return el("div", { class: "card", style: "margin-bottom:16px" },
      el("h2", { class: "section-title" }, "Active Outbound Channels"),
      el("p", { class: "section-desc" },
        "Default channels receive alerts for watches that don't override notify.channels. Capability URLs & tokens stay in channel-secrets.json (0600) and are never exposed."
      ),
      el("div", null, ...rows)
    );
  }

  function renderConnectChannelCard() {
    const providerKeys = ["feishu", "wecom", "dingtalk", "telegram", "bark", "slack", "discord", "ntfy", "webhook", "email"];
    const selected = state.channelKind;

    const tiles = el("div", { class: "provider-grid" },
      ...providerKeys.map((key) => {
        const m = PROVIDER_META[key];
        return el("button", {
          class: selected === key ? "provider-tile active" : "provider-tile",
          onClick: () => {
            state.channelKind = key;
            render(true);
          }
        },
          el("span", { class: "provider-tile-name" }, m.label),
          el("span", { class: "provider-tile-sub" }, m.sub)
        );
      })
    );

    let formBody;
    if (selected === "telegram") {
      const tgTokenIn = el("input", { class: "input mono", type: "password", placeholder: "Bot token from @BotFather" });
      const tgChatIn = el("input", { class: "input mono", placeholder: "Chat ID (or click Detect Chats after messaging /start)" });
      const tgIdIn = el("input", { class: "input mono", value: "telegram" });
      const tgDefault = el("input", { type: "checkbox", checked: true });
      const tgChatList = el("div", { style: "margin-bottom:10px" });

      formBody = el("div", null,
        el("div", { class: "grid-2" },
          el("div", { class: "field" }, el("label", null, "Telegram Bot Token"), tgTokenIn),
          el("div", { class: "field" }, el("label", null, "Channel Name (ID)"), tgIdIn)
        ),
        el("div", { class: "field" },
          el("label", null, "Target Chat / Group ID"),
          el("div", { class: "btn-row" },
            el("div", { style: "flex:1;min-width:220px" }, tgChatIn),
            el("button", {
              class: "btn",
              onClick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  const r = await api("/api/channels/telegram/chats", {
                    method: "POST",
                    body: { botToken: tgTokenIn.value.trim() }
                  });
                  const chats = r.chats || [];
                  if (chats.length === 0) {
                    showToast("No recent messages found—send /start to your bot in Telegram first", true);
                  } else {
                    tgChatIn.value = chats[0].chatId;
                    tgChatList.replaceChildren(
                      ...chats.map((c) =>
                        el("button", {
                          class: "channel-pill selected",
                          style: "margin-right:6px",
                          onClick: () => { tgChatIn.value = c.chatId; }
                        }, c.title + " (" + c.chatId + ")")
                      )
                    );
                    showToast("Found " + chats.length + " Telegram chat(s)");
                  }
                } catch (err) { showToast(err.message, true); }
                finally { btn.disabled = false; }
              }
            }, "Detect Chats")
          )
        ),
        tgChatList,
        el("label", { style: "display:flex;align-items:center;gap:7px;font-size:12.5px;margin-bottom:12px" },
          tgDefault, "Add to global default channels"
        ),
        el("button", {
          class: "btn btn-primary",
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api("/api/channels/telegram", {
                method: "POST",
                body: { id: tgIdIn.value.trim() || "telegram", botToken: tgTokenIn.value.trim(), chatId: tgChatIn.value.trim(), makeDefault: tgDefault.checked, test: true }
              });
              tgTokenIn.value = "";
              showToast("Telegram connected & verified!");
              await refresh();
            } catch (err) { showToast(err.message, true); }
            finally { btn.disabled = false; }
          }
        }, "Save & Send Test Message")
      );
    } else if (selected === "email") {
      const emailAddr = el("input", { class: "input mono", placeholder: PROVIDER_META.email.placeholder });
      const emailPass = el("input", { class: "input mono", type: "password", placeholder: "App password / SMTP authorization code" });
      const emailHost = el("input", { class: "input mono", placeholder: "Auto-detected for Gmail, iCloud, QQ, 163, 126, Aliyun, Fastmail, Yahoo" });
      const emailDefault = el("input", { type: "checkbox", checked: false });

      formBody = el("div", null,
        el("div", { class: "grid-2" },
          el("div", { class: "field" }, el("label", null, "Email Address"), emailAddr),
          el("div", { class: "field" }, el("label", null, "App Password / Authorization Code"), emailPass)
        ),
        el("div", { class: "field" }, el("label", null, "Custom SMTP Host (optional override)"), emailHost),
        el("label", { style: "display:flex;align-items:center;gap:7px;font-size:12.5px;margin-bottom:12px" },
          emailDefault, "Add email to global default channels"
        ),
        el("button", {
          class: "btn btn-primary",
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api("/api/channels/email", {
                method: "POST",
                body: { address: emailAddr.value.trim(), password: emailPass.value, host: emailHost.value.trim() || undefined, makeDefault: emailDefault.checked, test: true }
              });
              emailPass.value = "";
              showToast("Email saved & test email sent");
              await refresh();
            } catch (err) { showToast(err.message, true); }
            finally { btn.disabled = false; }
          }
        }, "Save & Send Test Email")
      );
    } else {
      const meta = PROVIDER_META[selected] || PROVIDER_META.feishu;
      const detectedBadge = el("span", { class: "badge ok", hidden: true });
      const urlInput = el("input", { class: "input mono", placeholder: meta.placeholder });
      const idInput = el("input", { class: "input mono", value: selected });
      const labelInput = el("input", { class: "input", placeholder: "Optional label (e.g. Ops Group, Personal iPhone)" });
      const signInput = el("input", { class: "input mono", type: "password", placeholder: "Optional HMAC signing secret" });
      const headerInput = el("input", { class: "input mono", type: "password", placeholder: "Authorization: Bearer ..." });
      const makeDefaultCheck = el("input", { type: "checkbox", checked: true });

      const signField = el("div", { class: "field", hidden: !(selected === "feishu" || selected === "dingtalk") },
        el("label", null, "HMAC Signing Secret (optional, if signature verification is enabled on the bot)"),
        signInput
      );
      const headerField = el("div", { class: "field", hidden: !(selected === "webhook" || selected === "ntfy") },
        el("label", null, "Custom Header (optional, Name: Value)"),
        headerInput
      );

      let userEditedId = false;
      idInput.addEventListener("input", () => { userEditedId = idInput.value.trim() !== ""; });
      urlInput.addEventListener("input", () => {
        const det = detectProviderFromUrl(urlInput.value);
        const eff = (det && det !== "telegram") ? det : selected;
        signField.hidden = !(eff === "feishu" || eff === "dingtalk");
        headerField.hidden = !(eff === "webhook" || eff === "ntfy");
        if (det && det !== "telegram") {
          detectedBadge.textContent = "Auto-detected: " + (PROVIDER_META[det] ? PROVIDER_META[det].label : det);
          detectedBadge.hidden = false;
          if (!userEditedId) idInput.value = det;
        } else {
          detectedBadge.hidden = true;
        }
      });

      formBody = el("div", null,
        el("div", { class: "field" },
          el("div", { class: "card-head" },
            el("label", null, meta.label + " Webhook / Push URL"),
            detectedBadge
          ),
          urlInput
        ),
        el("div", { class: "grid-2" },
          el("div", { class: "field" }, el("label", null, "Channel Name (ID used in notify.channels)"), idInput),
          el("div", { class: "field" }, el("label", null, "Display Label"), labelInput)
        ),
        signField,
        headerField,
        el("label", { style: "display:flex;align-items:center;gap:7px;font-size:12.5px;margin-bottom:12px" },
          makeDefaultCheck, "Set as global default outbound channel"
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-primary",
            onClick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                const det = detectProviderFromUrl(urlInput.value) || selected;
                await api("/api/channels/webhook", {
                  method: "POST",
                  body: {
                    id: idInput.value.trim() || det,
                    provider: det,
                    url: urlInput.value.trim(),
                    label: labelInput.value.trim(),
                    signingSecret: signInput.value.trim(),
                    customHeader: headerInput.value.trim(),
                    makeDefault: makeDefaultCheck.checked,
                    test: true
                  }
                });
                urlInput.value = "";
                signInput.value = "";
                headerInput.value = "";
                showToast("Channel saved & test push delivered!");
                await refresh();
              } catch (err) { showToast(err.message, true); }
              finally { btn.disabled = false; }
            }
          }, "Save & Send Test Push"),
          el("button", {
            class: "btn",
            onClick: async () => {
              try {
                const det = detectProviderFromUrl(urlInput.value) || selected;
                await api("/api/channels/webhook", {
                  method: "POST",
                  body: {
                    id: idInput.value.trim() || det,
                    provider: det,
                    url: urlInput.value.trim(),
                    label: labelInput.value.trim(),
                    signingSecret: signInput.value.trim(),
                    customHeader: headerInput.value.trim(),
                    makeDefault: makeDefaultCheck.checked,
                    test: false
                  }
                });
                urlInput.value = "";
                showToast("Saved channel");
                await refresh();
              } catch (err) { showToast(err.message, true); }
            }
          }, "Save Without Test")
        )
      );
    }

    return el("div", { class: "card" },
      el("h2", { class: "section-title" }, "Connect Push Channel"),
      el("p", { class: "section-desc" },
        "Choose a push provider below—or paste any Feishu, WeCom, DingTalk, Bark, Slack, Discord or ntfy URL for instant recognition."
      ),
      tiles,
      formBody
    );
  }

  function renderChannelsView(snap) {
    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" }, "Push Channels"),
          el("p", { class: "page-subtitle" },
            "Route actionable agent findings to IM group bots, phone push apps, webhooks, or desktop notifications."
          )
        )
      ),
      renderConfiguredChannelsCard(snap),
      renderConnectChannelCard()
    );
  }

  // ---------------------------------------------------------------------------
  // View 5: Secrets & Policy
  // ---------------------------------------------------------------------------

  function renderSecretsView(snap) {
    const st = snap.status || {};
    const budget = st.budget || { maxAgentRunsPerDay: 50, maxConcurrentAgentRuns: 2 };
    const secrets = snap.secrets || [];

    const secName = el("input", { class: "input mono", placeholder: "FINNHUB_API_KEY" });
    const secVal = el("input", { class: "input mono", type: "password", placeholder: "Write-only secret value" });
    const secHosts = el("input", { class: "input mono", placeholder: "finnhub.io (or * for any host)" });

    const maxDayIn = el("input", { class: "input mono", type: "number", min: "1", value: String(budget.maxAgentRunsPerDay || 50) });
    const maxConcIn = el("input", { class: "input mono", type: "number", min: "1", value: String(budget.maxConcurrentAgentRuns || 2) });

    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" }, "Secrets & Policy"),
          el("p", { class: "page-subtitle" },
            "Manage host-sandboxed probe API keys and daily LLM execution guardrails."
          )
        )
      ),

      el("div", { class: "grid-2" },
        // Left: Write-only Probe Secrets
        el("div", { class: "card" },
          el("h2", { class: "section-title" }, "Probe API Secrets (Write-Only)"),
          el("p", { class: "section-desc" },
            "Stored in ~/.self-starter/secrets.json (0600). Injected only into probes that declare probe.permissions.env and match the allowed sandbox hosts—never visible to chat or UI."
          ),
          el("div", { class: "field" }, el("label", null, "Environment Variable Name"), secName),
          el("div", { class: "field" }, el("label", null, "Secret Value"), secVal),
          el("div", { class: "field" }, el("label", null, "Allowed Sandbox Hosts (comma-separated, or *)"), secHosts),
          el("button", {
            class: "btn btn-primary",
            onClick: async () => {
              try {
                await api("/api/secrets", {
                  method: "POST",
                  body: { name: secName.value.trim(), value: secVal.value, hosts: secHosts.value.trim() }
                });
                secName.value = "";
                secVal.value = "";
                secHosts.value = "";
                showToast("Saved probe secret");
                await refresh();
              } catch (err) { showToast(err.message, true); }
            }
          }, "Save Secret"),

          el("div", { style: "margin-top:16px" },
            secrets.length === 0
              ? el("div", { class: "inline-note" }, "No probe secrets stored yet.")
              : el("div", null, ...secrets.map((s) =>
                  el("div", { class: "list-row" },
                    el("div", null,
                      el("strong", { class: "mono" }, s.name),
                      el("div", { class: "inline-note" }, s.hosts === "*" ? "Allowed on any host" : ("Sandboxed to: " + s.hosts.join(", ")))
                    ),
                    el("button", {
                      class: "btn btn-sm btn-danger",
                      onClick: async () => {
                        await api("/api/secrets/" + encodeURIComponent(s.name), { method: "DELETE" });
                        showToast("Removed secret " + s.name);
                        await refresh();
                      }
                    }, "Remove")
                  )
                ))
          )
        ),

        // Right: Budget & Runtime Info
        el("div", { class: "card" },
          el("h2", { class: "section-title" }, "Agent Wake Budget & Runtime"),
          el("p", { class: "section-desc" },
            "Probes always run at 0 tokens. These limits cap how often fired watches can wake an agent session per day."
          ),
          el("div", { class: "field" }, el("label", null, "Max Agent Wakes Per Day"), maxDayIn),
          el("div", { class: "field" }, el("label", null, "Max Concurrent Agent Runs"), maxConcIn),
          el("button", {
            class: "btn btn-primary",
            onClick: async () => {
              try {
                await api("/api/agents/config", {
                  method: "POST",
                  body: {
                    budget: {
                      maxAgentRunsPerDay: Number(maxDayIn.value),
                      maxConcurrentAgentRuns: Number(maxConcIn.value)
                    }
                  }
                });
                showToast("Saved runtime budget");
                await refresh();
              } catch (err) { showToast(err.message, true); }
            }
          }, "Update Budget"),

          el("div", { style: "margin-top:18px" },
            el("div", { class: "list-row" },
              el("span", { class: "inline-note" }, "State Directory"),
              el("code", { style: "font-size:12px" }, st.home || "~/.self-starter")
            ),
            el("div", { class: "list-row" },
              el("span", { class: "inline-note" }, "Deno Sandbox Runtime"),
              el("code", { style: "font-size:12px;word-break:break-all" }, st.deno || "not found")
            ),
            el("div", { class: "list-row" },
              el("span", { class: "inline-note" }, "Daemon PID & Started"),
              el("span", { class: "mono inline-note" }, "PID " + (st.pid || "—") + " · " + formatRelTime(st.startedAt))
            )
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Root Render & Live SSE Connection
  // ---------------------------------------------------------------------------

  function renderAgentDetailView(snap) {
    const agentId = state.agentFilter === "all" ? "codex" : state.agentFilter;
    const agents = snap.agents || [];
    const agent = agents.find((a) => a.id === agentId) || { id: agentId, name: HOST_LABELS[agentId] || agentId, vendor: "", capabilities: [], installCmd: "" };
    const triggers = (snap.triggers || []).filter((t) => (t.host || "codex") === agentId);
    const drafts = (snap.drafts || []).filter((d) => (d.host || "codex") === agentId);
    const fires = (snap.fires || []).filter((f) => (f.host || "codex") === agentId);
    const unread = fires.filter((f) => f.needsAttention);

    let subBody;
    if (state.agentSub === "inbox") {
      subBody = fires.length > 0
        ? el("div", { class: "stack" }, ...fires.map(renderFireCard))
        : el("div", { class: "empty-state" }, el("h3", null, "No notifications for " + agent.name));
    } else if (state.agentSub === "config") {
      subBody = renderAgentCard(agent);
    } else {
      subBody = el("div", { class: "stack" },
        ...drafts.map(renderDraftCard),
        ...(triggers.length > 0
          ? triggers.map((t) => renderWatchCard(t, snap))
          : [el("div", { class: "empty-state" },
              el("h3", null, "No probe tasks bound to " + agent.name),
              el("p", null, "Ask " + agent.name + " in natural language to create a new probe task.")
            )])
      );
    }

    return el("div", null,
      el("div", { class: "page-header" },
        el("div", null,
          el("h1", { class: "page-title" },
            el("span", { class: "host-dot " + agentId, style: "width:10px;height:10px" }),
            agent.name
          ),
          el("p", { class: "page-subtitle" },
            (agent.detectedBin ? ("Connected (" + agent.detectedBin + ")") : "CLI not detected yet") +
            " · " + triggers.length + " probe task(s) · " + unread.length + " unread notification(s)"
          )
        ),
        el("div", { class: "header-actions" },
          unread.length > 0 && state.agentSub === "inbox" ? el("button", {
            class: "btn btn-primary",
            onClick: async () => {
              const r = await api("/api/fires/ack", { method: "POST", body: { fireIds: unread.map((f) => f.fireId) } });
              showToast("Marked " + r.acknowledged + " item(s) read");
              await refresh();
            }
          }, iconEl("check", "icon-sm"), "Mark All Read (" + unread.length + ")") : null
        )
      ),

      el("div", { class: "toolbar" },
        el("div", { class: "seg-group" },
          el("button", {
            class: state.agentSub === "probes" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.agentSub = "probes"; render(true); }
          }, "Probe Tasks (" + (triggers.length + drafts.length) + ")"),
          el("button", {
            class: state.agentSub === "inbox" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.agentSub = "inbox"; render(true); }
          }, "Notifications (" + fires.length + (unread.length > 0 ? " · " + unread.length + " unread" : "") + ")"),
          el("button", {
            class: state.agentSub === "config" ? "seg-btn active" : "seg-btn",
            onClick: () => { state.agentSub = "config"; render(true); }
          }, "Agent Settings")
        )
      ),

      subBody
    );
  }

  function renderMainContent(snap) {
    if (state.tab === "watches") return renderWatchesView(snap);
    if (state.tab === "agent-detail") return renderAgentDetailView(snap);
    if (state.tab === "agents") return renderAgentsView(snap);
    if (state.tab === "channels") return renderChannelsView(snap);
    if (state.tab === "secrets") return renderSecretsView(snap);
    return renderInboxView(snap);
  }

  function render(forceMain) {
    const app = document.getElementById("app");
    if (!app || !state.snapshot) return;
    const snap = state.snapshot;

    const existingWorkspace = app.querySelector(".workspace");
    const activeEl = document.activeElement;
    const mainHasFocus = !forceMain && existingWorkspace && activeEl &&
      (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.tagName === "SELECT") &&
      existingWorkspace.querySelector(".main-pane") &&
      existingWorkspace.querySelector(".main-pane").contains(activeEl);

    if (mainHasFocus) {
      // Refresh sidebar live badges without disturbing user typing in main pane
      const oldSidebar = existingWorkspace.querySelector(".sidebar");
      if (oldSidebar) oldSidebar.replaceWith(renderSidebar(snap));
      return;
    }

    app.replaceChildren(
      el("div", { class: "workspace" },
        renderSidebar(snap),
        el("main", { class: "main-pane" }, renderMainContent(snap))
      )
    );
  }

  function connectSse() {
    const es = new EventSource("/api/events");
    es.onopen = () => {
      state.connected = true;
      render(false);
    };
    es.addEventListener("snapshot", (ev) => {
      try {
        state.snapshot = JSON.parse(ev.data);
        state.connected = true;
        maybeFireBrowserAlerts(state.snapshot);
        render(false);
      } catch {
        // ignore malformed frame
      }
    });
    es.onerror = () => {
      state.connected = false;
      render(false);
    };
  }

  refresh().then(connectSse);
})();
`;
