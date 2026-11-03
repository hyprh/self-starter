// Browser client for `self-starter ui`. Pure DOM construction (no innerHTML for
// untrusted probe or receipt strings) and SSE live updates.

export const UI_CLIENT_JS = `(() => {
  "use strict";

  const PROVIDER_LABELS = {
    feishu: "Feishu / Lark",
    wecom: "WeCom (企业微信)",
    dingtalk: "DingTalk (钉钉)",
    slack: "Slack",
    discord: "Discord",
    telegram: "Telegram Bot",
    bark: "Bark (iOS)",
    ntfy: "ntfy",
    webhook: "Custom Webhook"
  };

  const state = {
    tab: "inbox",
    inboxFilter: "attention",
    data: null,
    online: false,
    browserAlerts: localStorage.getItem("ss_browser_alerts") === "1",
    seenAttention: null,
    trialResults: {},
    quietEditors: {},
    channelMode: "url"
  };

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "hidden") node.hidden = Boolean(v);
        else if (k === "disabled") node.disabled = Boolean(v);
        else if (k === "checked") node.checked = Boolean(v);
        else if (k === "value") node.value = String(v);
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
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

  let toastTimer = null;
  function showToast(msg, isError = false) {
    const root = document.getElementById("toast-root");
    if (!root) return;
    root.replaceChildren(el("div", { class: isError ? "toast error" : "toast" }, msg));
    root.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { root.hidden = true; }, 4200);
  }

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = { "X-Self-Starter-UI": "1", ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body, credentials: "same-origin" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
    return json;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return sameDay ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  }

  function detectProviderFromUrl(raw) {
    try {
      const u = new URL(raw.trim());
      const h = u.hostname.toLowerCase();
      if (h === "open.feishu.cn" || h === "open.larksuite.com" || ((h.endsWith(".feishu.cn") || h.endsWith(".larksuite.com")) && u.pathname.includes("/bot/v2/hook/"))) return "feishu";
      if (h === "qyapi.weixin.qq.com") return "wecom";
      if (h === "oapi.dingtalk.com" || h === "api.dingtalk.com") return "dingtalk";
      if (h === "hooks.slack.com") return "slack";
      if ((h === "discord.com" || h === "discordapp.com" || h.endsWith(".discord.com")) && u.pathname.includes("/api/webhooks/")) return "discord";
      if (h === "api.day.app") return "bark";
      if (h === "ntfy.sh") return "ntfy";
      return "webhook";
    } catch {
      return null;
    }
  }

  function notifyBrowserIfNew(snapshot) {
    const currentIds = new Set((snapshot.fires || []).filter((f) => f.needsAttention).map((f) => f.fireId));
    if (state.seenAttention === null) {
      state.seenAttention = currentIds;
      return;
    }
    if (state.browserAlerts && "Notification" in window && Notification.permission === "granted") {
      for (const fire of snapshot.fires || []) {
        if (fire.needsAttention && !state.seenAttention.has(fire.fireId)) {
          try {
            new Notification("[Self-Starter] " + fire.triggerName, {
              body: (fire.receipt && fire.receipt.summary) ? fire.receipt.summary : fire.summary
            });
          } catch {}
        }
      }
    }
    for (const id of currentIds) state.seenAttention.add(id);
  }

  async function refresh() {
    try {
      const snap = await api("/api/snapshot");
      state.data = snap;
      state.online = true;
      notifyBrowserIfNew(snap);
      render(false);
    } catch (err) {
      state.online = false;
      showToast(err.message, true);
    }
  }

  async function toggleBrowserAlerts() {
    if (!("Notification" in window)) {
      showToast("This browser does not support desktop notifications.", true);
      return;
    }
    if (!state.browserAlerts) {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm !== "granted") {
        showToast("Browser notification permission was not granted.", true);
        return;
      }
      state.browserAlerts = true;
      localStorage.setItem("ss_browser_alerts", "1");
      showToast("Browser desktop alerts enabled for this tab.");
    } else {
      state.browserAlerts = false;
      localStorage.setItem("ss_browser_alerts", "0");
      showToast("Browser desktop alerts paused.");
    }
    render(true);
  }

  function renderHeader(snap) {
    const st = snap.status;
    const agents = [
      st.claude ? "Claude Code" : null,
      st.codex ? "Codex" : null,
      st.opencode ? "OpenCode" : null,
      st.zcode ? "ZCode" : null
    ].filter(Boolean);

    const browserEnabled = state.browserAlerts && ("Notification" in window) && Notification.permission === "granted";

    return el("header", { class: "topbar" },
      el("div", { class: "brand" },
        el("div", { class: "brand-mark" }, "⚡"),
        el("div", null,
          el("div", { class: "brand-title" }, "Self-Starter Console"),
          el("div", { class: "brand-sub" },
            el("span", { class: state.online ? "dot" : "dot offline" }),
            state.online ? ("Daemon v" + st.version + " · pid " + st.pid) : "Reconnecting…",
            agents.length ? (" · " + agents.join(", ")) : ""
          )
        )
      ),
      el("div", { class: "stats-strip" },
        el("div", { class: "stat-pill", title: "Local Deno probe runs use zero LLM tokens" },
          "Checks: ",
          el("strong", null, String(st.checks.today)),
          " today / ",
          el("strong", null, String(st.checks.total)),
          " total ",
          el("span", { class: "zero-tag" }, "(0 tokens)")
        ),
        el("div", { class: "stat-pill" },
          "Watches: ",
          el("strong", null, String(st.triggers.active || 0)),
          " active / ",
          String(st.triggers.total || 0)
        ),
        el("div", { class: "stat-pill" },
          "Agent runs today: ",
          el("strong", null, st.agentRunsToday + " / " + st.budget.maxAgentRunsPerDay)
        ),
        el("button", {
          class: browserEnabled ? "btn btn-signal btn-sm" : "btn btn-sm",
          onClick: toggleBrowserAlerts,
          title: "Pop up OS notifications via your browser (ideal over SSH)"
        }, browserEnabled ? "🔔 Browser Alerts: ON" : "🔕 Browser Alerts: OFF")
      )
    );
  }

  function renderNav(snap) {
    const attentionCount = (snap.fires || []).filter((f) => f.needsAttention).length + (snap.deferred || []).length;
    const watchesCount = (snap.triggers || []).length + (snap.drafts || []).length;
    const channelsCount = (snap.channels.available || []).length;

    const tabButton = (id, label, count, urgent = false) =>
      el("button", {
        class: state.tab === id ? "tab-btn active" : "tab-btn",
        onClick: () => { state.tab = id; render(false); }
      },
        label,
        el("span", { class: urgent && count > 0 ? "count-badge urgent" : "count-badge" }, String(count))
      );

    return el("nav", { class: "nav-row" },
      el("div", { class: "tabs" },
        tabButton("inbox", "Attention Inbox", attentionCount, true),
        tabButton("watches", "Watches & Drafts", watchesCount, (snap.drafts || []).length > 0),
        tabButton("channels", "Channels & Secrets", channelsCount, false)
      ),
      el("div", { class: "inline-note mono" },
        "Default delivery: " + (snap.channels.default || ["desktop"]).join(", ")
      )
    );
  }

  /* -------------------- TAB 1: INBOX -------------------- */
  function renderDeferredCard(item) {
    const q = item.quiet ? (item.quiet.from + "–" + item.quiet.to + " " + item.quiet.tz) : "quiet hours";
    return el("div", { class: "card attention" },
      el("div", { class: "card-head" },
        el("div", null,
          el("div", { class: "card-title-row" },
            el("h3", { class: "card-title" }, item.title),
            el("span", { class: "badge warn" }, "held (" + q + ")")
          ),
          el("div", { class: "meta-line" }, "Held at " + fmtTime(item.heldAt))
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-primary btn-sm",
            onClick: async () => {
              await api("/api/deferred/flush", { method: "POST", body: { id: item.id } });
              showToast("Sent held notification now.");
              await refresh();
            }
          }, "Send Now"),
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              await api("/api/deferred/drop", { method: "POST", body: { id: item.id } });
              showToast("Discarded held notification.");
              await refresh();
            }
          }, "Discard")
        )
      ),
      el("div", { class: "receipt-box" }, item.body)
    );
  }

  function renderFireCard(fire) {
    const badgeClass = fire.status === "failed" ? "badge err" : fire.needsAttention ? "badge warn" : "badge ok";
    const badgeLabel = fire.needsAttention ? "needs attention" : fire.status;
    const cardClass = fire.status === "failed" ? "card failed" : fire.needsAttention ? "card attention" : "card";

    const mainText = fire.receipt ? fire.receipt.summary : fire.error ? ("Error: " + fire.error) : fire.skippedBecause ? ("Skipped: " + fire.skippedBecause) : fire.summary;

    return el("div", { class: cardClass },
      el("div", { class: "card-head" },
        el("div", null,
          el("div", { class: "card-title-row" },
            el("h3", { class: "card-title" }, fire.triggerName || fire.triggerId),
            el("span", { class: "badge mono" }, "#" + fire.fireNumber),
            el("span", { class: badgeClass }, badgeLabel),
            fire.notifiedAt ? el("span", { class: "badge" }, "pushed " + fmtTime(fire.notifiedAt)) : null
          ),
          el("div", { class: "meta-line" },
            "Fired " + fmtTime(fire.firedAt) + " · trigger: " + fire.triggerId +
            (fire.merged > 0 ? (" · +" + fire.merged + " coalesced") : "")
          )
        ),
        fire.needsAttention ? el("button", {
          class: "btn btn-primary btn-sm",
          onClick: async () => {
            await api("/api/fires/ack", { method: "POST", body: { fireIds: [fire.fireId] } });
            await refresh();
          }
        }, "✓ Mark Read") : null
      ),
      el("div", { class: "receipt-box" }, mainText),
      fire.receipt && fire.summary && fire.receipt.summary !== fire.summary
        ? el("div", { class: "probe-line" }, "Probe signal: " + fire.summary)
        : null,
      fire.reopen ? el("div", { class: "reopen-bar" },
        el("code", null, fire.reopen.command),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(fire.reopen.command);
                showToast("Copied command: " + fire.reopen.command);
              } catch {
                showToast(fire.reopen.command);
              }
            }
          }, "Copy Command"),
          fire.reopen.url ? el("a", { class: "btn btn-signal btn-sm", href: fire.reopen.url }, "Open in Codex") : null
        )
      ) : null,
      el("div", { class: "card-actions" },
        el("span", { class: "inline-note" }, fire.acknowledgedAt ? ("Read at " + fmtTime(fire.acknowledgedAt)) : "Quick noise control:"),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await api("/api/triggers/" + encodeURIComponent(fire.triggerId) + "/tune", {
                  method: "POST",
                  body: { cooldown: "1h", reason: "Set 1h cooldown from Attention Inbox" }
                });
                showToast("Set cooldown to 1h for " + fire.triggerId);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Cooldown 1h"),
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await api("/api/triggers/" + encodeURIComponent(fire.triggerId) + "/pause", { method: "POST" });
                showToast("Paused " + fire.triggerId);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Pause Watch")
        )
      )
    );
  }

  function renderInbox(snap) {
    const allFires = snap.fires || [];
    const attentionFires = allFires.filter((f) => f.needsAttention);
    const deferred = snap.deferred || [];

    const seg = el("div", { class: "seg-group" },
      el("button", {
        class: state.inboxFilter === "attention" ? "seg-btn active" : "seg-btn",
        onClick: () => { state.inboxFilter = "attention"; render(true); }
      }, "Needs Attention (" + attentionFires.length + ")"),
      el("button", {
        class: state.inboxFilter === "held" ? "seg-btn active" : "seg-btn",
        onClick: () => { state.inboxFilter = "held"; render(true); }
      }, "Held in Quiet Hours (" + deferred.length + ")"),
      el("button", {
        class: state.inboxFilter === "all" ? "seg-btn active" : "seg-btn",
        onClick: () => { state.inboxFilter = "all"; render(true); }
      }, "All Recent Fires (" + allFires.length + ")")
    );

    const actions = el("div", { class: "btn-row" },
      deferred.length > 0 ? el("button", {
        class: "btn btn-signal btn-sm",
        onClick: async () => {
          await api("/api/deferred/flush", { method: "POST", body: {} });
          showToast("Flushed all held notifications.");
          await refresh();
        }
      }, "Send All Held (" + deferred.length + ")") : null,
      attentionFires.length > 0 ? el("button", {
        class: "btn btn-sm",
        onClick: async () => {
          await api("/api/fires/ack", { method: "POST", body: { all: true } });
          showToast("Marked all attention items as read.");
          await refresh();
        }
      }, "Mark All Read") : null
    );

    const list = el("div", { class: "stack" });

    if (state.inboxFilter === "held") {
      if (deferred.length === 0) {
        list.appendChild(el("div", { class: "empty-state" },
          el("h3", null, "No notifications held by quiet hours"),
          el("p", null, "Notifications deferred during a watch's quiet_hours window appear here so you can release or discard them anytime.")
        ));
      } else {
        for (const item of deferred) list.appendChild(renderDeferredCard(item));
      }
    } else if (state.inboxFilter === "attention") {
      for (const item of deferred) list.appendChild(renderDeferredCard(item));
      if (attentionFires.length === 0 && deferred.length === 0) {
        list.appendChild(el("div", { class: "empty-state" },
          el("h3", null, "Inbox zero — nothing needs your attention right now"),
          el("p", null, "Probes keep running locally at 0 tokens. When an agent turn reports notify=true (or a delivery fails), it lands here and pushes to your outbound channels.")
        ));
      } else {
        for (const f of attentionFires) list.appendChild(renderFireCard(f));
      }
    } else {
      if (allFires.length === 0) {
        list.appendChild(el("div", { class: "empty-state" },
          el("h3", null, "No trigger fires yet"),
          el("p", null, "Ask Claude Code, Codex, OpenCode or ZCode to watch something for you.")
        ));
      } else {
        for (const f of allFires) list.appendChild(renderFireCard(f));
      }
    }

    return el("section", null, el("div", { class: "toolbar" }, seg, actions), list);
  }

  /* -------------------- INSPECT DRAWER -------------------- */
  async function openInspect(kind, id) {
    try {
      const detail = await api("/api/inspect?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(id));
      const root = document.getElementById("drawer-root");
      const close = () => { root.hidden = true; root.replaceChildren(); };

      const runsBlock = detail.recentRuns && detail.recentRuns.length > 0
        ? el("div", null,
            el("h4", { class: "section-title" }, "Recent Checks (0 tokens)"),
            el("pre", { class: "code-block" },
              detail.recentRuns.map((r) =>
                fmtTime(r.ranAt) + " · " + r.durationMs + "ms · " + (r.ok ? ("ok: " + (r.summary || "")) : ("ERR: " + (r.error || "")))
              ).join("\\n")
            )
          )
        : null;

      const drawer = el("div", { class: "drawer-backdrop", onClick: (e) => { if (e.target === e.currentTarget) close(); } },
        el("div", { class: "drawer" },
          el("div", { class: "card-head" },
            el("div", null,
              el("h3", { class: "card-title" }, detail.name + " (" + detail.id + ")"),
              el("div", { class: "meta-line mono" }, detail.codePath || "")
            ),
            el("button", { class: "btn btn-sm", onClick: close }, "Close ✕")
          ),
          runsBlock,
          el("div", null,
            el("h4", { class: "section-title" }, "Probe Source (TypeScript / Deno)"),
            el("pre", { class: "code-block" }, detail.probeCode || "")
          ),
          el("div", null,
            el("h4", { class: "section-title" }, "Trigger Definition (YAML)"),
            el("pre", { class: "code-block" }, detail.definitionYaml || "")
          )
        )
      );
      root.replaceChildren(drawer);
      root.hidden = false;
    } catch (err) {
      showToast(err.message, true);
    }
  }

  /* -------------------- TAB 2: WATCHES & DRAFTS -------------------- */
  function renderDraftCard(d) {
    const trialBadge = !d.trial ? el("span", { class: "badge" }, "not tested")
      : d.trial.ok ? el("span", { class: "badge ok" }, "trial ok (" + d.trial.durationMs + "ms)")
      : el("span", { class: "badge err" }, "trial failed");

    return el("div", { class: "card attention" },
      el("div", { class: "card-head" },
        el("div", null,
          el("div", { class: "card-title-row" },
            el("span", { class: "badge warn" }, "draft"),
            el("h3", { class: "card-title" }, d.name || d.triggerId),
            el("span", { class: "badge mono" }, d.draftId),
            trialBadge
          ),
          el("div", { class: "meta-line" }, d.description || d.intent || "")
        ),
        el("div", { class: "btn-row" },
          el("button", { class: "btn btn-sm", onClick: () => openInspect("draft", d.draftId) }, "Inspect Code"),
          el("button", {
            class: "btn btn-primary btn-sm",
            onClick: async () => {
              try {
                await api("/api/drafts/" + encodeURIComponent(d.draftId) + "/activate", { method: "POST" });
                showToast("Activated watch " + d.triggerId);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Activate"),
          el("button", {
            class: "btn btn-danger btn-sm",
            onClick: async () => {
              await api("/api/drafts/" + encodeURIComponent(d.draftId), { method: "DELETE" });
              showToast("Discarded draft " + d.draftId);
              await refresh();
            }
          }, "Discard")
        )
      ),
      d.warnings && d.warnings.length > 0
        ? el("div", { class: "receipt-box" }, d.warnings.map((w) => "• " + w).join("\\n"))
        : null
    );
  }

  function renderWatchCard(t, availableChannels, defaultChannels) {
    const healthClass = t.health === "degraded" ? "badge err" : t.lifecycle === "active" ? "badge ok" : "badge";
    const chosen = t.notify && Array.isArray(t.notify.channels) ? t.notify.channels : null;
    const whenVal = (t.notify && t.notify.when) || "receipt";

    const updateNotify = async (nextNotify) => {
      try {
        await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
          method: "POST",
          body: { changes: { notify: nextNotify } }
        });
        showToast("Updated delivery routing for " + t.id);
        await refresh();
      } catch (e) { showToast(e.message, true); }
    };

    const pills = el("div", { class: "pill-list" },
      el("span", { class: "inline-note" }, "Route to:"),
      el("button", {
        class: chosen === null ? "channel-pill selected" : "channel-pill",
        title: "Use global default (" + defaultChannels.join(", ") + ")",
        onClick: () => { if (chosen !== null) updateNotify({ when: whenVal, channels: null }); }
      }, "default (" + defaultChannels.join(",") + ")")
    );

    const allKnown = [...new Set([...availableChannels, ...(chosen || [])])];
    for (const ch of allKnown) {
      const isSelected = chosen !== null && chosen.includes(ch);
      pills.appendChild(el("button", {
        class: isSelected ? "channel-pill selected" : "channel-pill",
        onClick: () => {
          const base = chosen ? [...chosen] : [];
          const next = base.includes(ch) ? base.filter((x) => x !== ch) : [...base, ch];
          updateNotify({ when: whenVal, channels: next.length > 0 ? next : null });
        }
      }, (isSelected ? "✓ " : "") + ch));
    }

    const whenSelect = el("select", {
      class: "select",
      onChange: (e) => updateNotify({ when: e.target.value, ...(chosen ? { channels: chosen } : {}) })
    },
      el("option", { value: "receipt", selected: whenVal === "receipt" ? "selected" : null }, "Notify: when agent says it matters"),
      el("option", { value: "always", selected: whenVal === "always" ? "selected" : null }, "Notify: every fire"),
      el("option", { value: "never", selected: whenVal === "never" ? "selected" : null }, "Notify: silent (never)")
    );
    whenSelect.value = whenVal;

    const trial = state.trialResults[t.id];
    const quietOpen = Boolean(state.quietEditors[t.id]);
    const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    let quietEditor = null;
    if (quietOpen) {
      const fromInput = el("input", { class: "input mono", style: "width:84px", value: t.quietHours ? t.quietHours.from : "23:00", placeholder: "23:00" });
      const toInput = el("input", { class: "input mono", style: "width:84px", value: t.quietHours ? t.quietHours.to : "08:00", placeholder: "08:00" });
      const tzInput = el("input", { class: "input mono", style: "width:170px", value: t.quietHours ? t.quietHours.tz : defaultTz, placeholder: "Asia/Shanghai" });
      quietEditor = el("div", { class: "reopen-bar" },
        el("div", { class: "btn-row" },
          el("span", { class: "inline-note" }, "Quiet window:"),
          fromInput,
          "to",
          toInput,
          tzInput
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-primary btn-sm",
            onClick: async () => {
              try {
                await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
                  method: "POST",
                  body: { changes: { policy: { quiet_hours: { from: fromInput.value.trim(), to: toInput.value.trim(), tz: tzInput.value.trim() } } } }
                });
                state.quietEditors[t.id] = false;
                showToast("Saved quiet hours for " + t.id);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Save"),
          t.quietHours ? el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await api("/api/triggers/" + encodeURIComponent(t.id) + "/update", {
                  method: "POST",
                  body: { changes: { policy: { quiet_hours: null } } }
                });
                state.quietEditors[t.id] = false;
                showToast("Cleared quiet hours for " + t.id);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Clear") : null,
          el("button", { class: "btn btn-sm", onClick: () => { state.quietEditors[t.id] = false; render(true); } }, "Cancel")
        )
      );
    }

    return el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("div", null,
          el("div", { class: "card-title-row" },
            el("h3", { class: "card-title" }, t.name),
            el("span", { class: "badge mono" }, t.id),
            el("span", { class: healthClass }, t.state),
            el("span", { class: "badge" }, t.action === "notify" ? "notify only" : ("agent: " + t.host)),
            t.recipe ? el("span", { class: "badge mono" }, "recipe:" + t.recipe) : null
          ),
          t.intent ? el("div", { class: "meta-line" }, t.intent) : null,
          el("div", { class: "meta-line mono" },
            "Checks: " + t.checks + " (0 tokens) · Fires: " + t.fires +
            (t.interval ? (" · every " + t.interval.default) : "") +
            " · next: " + fmtTime(t.nextCheck)
          ),
          t.lastCheck ? el("div", { class: "probe-line" },
            "Last check " + fmtTime(t.lastCheck.at) + ": " +
            (t.lastCheck.ok ? (t.lastCheck.summary || "ok") : ("FAILED — " + (t.lastCheck.error || "error")))
          ) : null
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              btn.textContent = "Running…";
              try {
                const res = await api("/api/triggers/" + encodeURIComponent(t.id) + "/test", { method: "POST" });
                state.trialResults[t.id] = res;
                render(true);
              } catch (e) {
                showToast(e.message, true);
              } finally {
                btn.disabled = false;
                btn.textContent = "Run Check Now";
              }
            }
          }, "Run Check Now"),
          el("button", { class: "btn btn-sm", onClick: () => openInspect("trigger", t.id) }, "Code & Runs"),
          t.lifecycle === "paused"
            ? el("button", {
                class: "btn btn-primary btn-sm",
                onClick: async () => {
                  try {
                    await api("/api/triggers/" + encodeURIComponent(t.id) + "/resume", { method: "POST" });
                    showToast("Resumed " + t.id);
                    await refresh();
                  } catch (e) { showToast(e.message, true); }
                }
              }, "Resume")
            : el("button", {
                class: "btn btn-sm",
                onClick: async () => {
                  try {
                    await api("/api/triggers/" + encodeURIComponent(t.id) + "/pause", { method: "POST" });
                    showToast("Paused " + t.id);
                    await refresh();
                  } catch (e) { showToast(e.message, true); }
                }
              }, "Pause"),
          el("button", {
            class: "btn btn-danger btn-sm",
            onClick: async () => {
              if (!confirm("Delete watch \\"" + t.name + "\\" (" + t.id + ")?")) return;
              try {
                await api("/api/triggers/" + encodeURIComponent(t.id), { method: "DELETE" });
                showToast("Deleted " + t.id);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Delete")
        )
      ),
      trial ? el("div", { class: "reopen-bar" },
        el("span", { class: "mono" },
          "Test result (" + trial.durationMs + "ms): " +
          (trial.ok ? ((trial.summary || "ok") + (trial.fire !== undefined ? (" · fire=" + trial.fire) : "")) : ("ERR: " + trial.error))
        ),
        el("button", { class: "btn btn-sm", onClick: () => { delete state.trialResults[t.id]; render(true); } }, "Dismiss")
      ) : null,
      el("div", { class: "routing-box" },
        pills,
        el("div", { class: "btn-row" },
          whenSelect,
          el("button", {
            class: t.quietHours ? "btn btn-signal btn-sm" : "btn btn-sm",
            onClick: () => { state.quietEditors[t.id] = !state.quietEditors[t.id]; render(true); }
          }, t.quietHours ? ("🌙 " + t.quietHours.from + "–" + t.quietHours.to) : "+ Quiet hours")
        )
      ),
      quietEditor
    );
  }

  function renderWatches(snap) {
    const drafts = snap.drafts || [];
    const triggers = snap.triggers || [];
    const available = snap.channels.available || ["desktop"];
    const defaults = snap.channels.default || ["desktop"];

    const container = el("div", { class: "stack" });

    if (drafts.length > 0) {
      container.appendChild(el("h3", { class: "section-title" }, "Pending Drafts (" + drafts.length + ")"));
      for (const d of drafts) container.appendChild(renderDraftCard(d));
    }

    if (triggers.length === 0 && drafts.length === 0) {
      container.appendChild(el("div", { class: "empty-state" },
        el("h3", null, "No active watches yet"),
        el("p", null, "Ask Claude Code, Codex, OpenCode or ZCode in plain language — for example: \\"Watch CI on this PR and investigate if it fails\\" or \\"Tell me when NVDA crosses 145\\".")
      ));
    } else if (triggers.length > 0) {
      if (drafts.length > 0) container.appendChild(el("h3", { class: "section-title", style: "margin-top:8px" }, "Active Watches (" + triggers.length + ")"));
      for (const t of triggers) container.appendChild(renderWatchCard(t, available, defaults));
    }
    return container;
  }

  /* -------------------- TAB 3: CHANNELS & SECRETS -------------------- */
  function renderChannelsConfiguredList(snap) {
    const ch = snap.channels;
    const defaults = new Set(ch.default || ["desktop"]);
    const available = ch.available || ["desktop"];

    const toggleDefault = async (name) => {
      const next = defaults.has(name) ? [...defaults].filter((x) => x !== name) : [...defaults, name];
      if (next.length === 0) {
        showToast("At least one default channel is required.", true);
        return;
      }
      try {
        await api("/api/channels/default", { method: "POST", body: { channels: next } });
        showToast("Default channels: " + next.join(", "));
        await refresh();
      } catch (e) { showToast(e.message, true); }
    };

    const defaultRow = el("div", { style: "margin-bottom:14px" },
      el("div", { class: "inline-note", style: "margin-bottom:6px" }, "Global default channels (used when a watch does not choose its own):"),
      el("div", { class: "pill-list" },
        ...available.map((name) => el("button", {
          class: defaults.has(name) ? "channel-pill selected" : "channel-pill",
          onClick: () => toggleDefault(name)
        }, (defaults.has(name) ? "✓ " : "") + name))
      )
    );

    const rows = el("div", null);

    // Desktop row
    rows.appendChild(el("div", { class: "list-row" },
      el("div", null,
        el("strong", { class: "mono" }, "desktop"),
        " · System notification banner",
        defaults.has("desktop") ? el("span", { class: "badge warn", style: "margin-left:8px" }, "default") : null
      ),
      el("button", {
        class: "btn btn-sm",
        onClick: async () => {
          try {
            await api("/api/channels/desktop/test", { method: "POST" });
            showToast("Sent desktop test notification.");
          } catch (e) { showToast(e.message, true); }
        }
      }, "Send Test")
    ));

    // Webhook rows
    for (const [id, meta] of Object.entries(ch.webhooks || {})) {
      rows.appendChild(el("div", { class: "list-row" },
        el("div", null,
          el("strong", { class: "mono" }, id),
          " · " + (PROVIDER_LABELS[meta.provider] || meta.provider),
          meta.label ? (" (" + meta.label + ")") : "",
          el("span", { class: "inline-note mono", style: "margin-left:8px" }, "→ " + meta.hint),
          defaults.has(id) ? el("span", { class: "badge warn", style: "margin-left:8px" }, "default") : null
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await api("/api/channels/" + encodeURIComponent(id) + "/test", { method: "POST" });
                showToast("Sent test push to " + id + "!");
              } catch (e) { showToast(e.message, true); }
            }
          }, "Send Test"),
          el("button", {
            class: "btn btn-danger btn-sm",
            onClick: async () => {
              await api("/api/channels/" + encodeURIComponent(id), { method: "DELETE" });
              showToast("Removed channel " + id);
              await refresh();
            }
          }, "Remove")
        )
      ));
    }

    // Email row if configured
    if (ch.email) {
      rows.appendChild(el("div", { class: "list-row" },
        el("div", null,
          el("strong", { class: "mono" }, "email"),
          " · SMTP → " + ch.email.to + " (" + ch.email.host + ":" + ch.email.port + ")",
          defaults.has("email") ? el("span", { class: "badge warn", style: "margin-left:8px" }, "default") : null
        ),
        el("div", { class: "btn-row" },
          el("button", {
            class: "btn btn-sm",
            onClick: async () => {
              try {
                await api("/api/channels/email/test", { method: "POST" });
                showToast("Sent test email to " + ch.email.to);
              } catch (e) { showToast(e.message, true); }
            }
          }, "Send Test"),
          el("button", {
            class: "btn btn-danger btn-sm",
            onClick: async () => {
              await api("/api/channels/email", { method: "DELETE" });
              showToast("Removed email channel.");
              await refresh();
            }
          }, "Remove")
        )
      ));
    }

    return el("div", null, defaultRow, rows);
  }

  function renderSecretsConfiguredList(snap) {
    const secrets = snap.secrets || [];
    if (secrets.length === 0) {
      return el("div", { class: "inline-note" }, "No probe API secrets stored yet.");
    }
    return el("div", null, ...secrets.map((s) =>
      el("div", { class: "list-row" },
        el("div", null,
          el("strong", { class: "mono" }, s.name),
          el("span", { class: "inline-note", style: "margin-left:8px" },
            s.hosts === "*" ? "any host" : ("sandboxed hosts: " + s.hosts.join(", "))
          )
        ),
        el("button", {
          class: "btn btn-danger btn-sm",
          onClick: async () => {
            await api("/api/secrets/" + encodeURIComponent(s.name), { method: "DELETE" });
            showToast("Removed secret " + s.name);
            await refresh();
          }
        }, "Remove")
      )
    ));
  }

  function renderChannelsTab(snap) {
    const detectedBadge = el("span", { class: "badge ok", hidden: true });
    const urlInput = el("input", {
      class: "input mono",
      placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/... or Bark / Slack / WeCom / DingTalk / Discord / ntfy URL"
    });
    const providerSelect = el("select", { class: "select" },
      ...["feishu", "wecom", "dingtalk", "slack", "discord", "bark", "ntfy", "webhook"].map((p) =>
        el("option", { value: p }, PROVIDER_LABELS[p])
      )
    );
    providerSelect.value = "feishu";
    const idInput = el("input", { class: "input mono", placeholder: "e.g. feishu or bark-iphone", value: "feishu" });
    const labelInput = el("input", { class: "input", placeholder: "Optional display label (e.g. Team Ops)" });
    const signField = el("div", { class: "field" },
      el("label", null, "Signing secret (optional, when Feishu / DingTalk HMAC verification is enabled)"),
      el("input", { class: "input mono", type: "password", placeholder: "Optional HMAC secret" })
    );
    const headerField = el("div", { class: "field", hidden: true },
      el("label", null, "Authorization / custom header (optional, Name: Value)"),
      el("input", { class: "input mono", type: "password", placeholder: "Authorization: Bearer ..." })
    );
    const makeDefaultCheck = el("input", { type: "checkbox", checked: true });

    let userEditedId = false;
    idInput.addEventListener("input", () => { userEditedId = idInput.value.trim() !== ""; });

    const syncProviderVisibility = () => {
      const p = providerSelect.value;
      signField.hidden = !(p === "feishu" || p === "dingtalk");
      headerField.hidden = !(p === "webhook" || p === "ntfy");
    };
    providerSelect.addEventListener("change", () => {
      syncProviderVisibility();
      if (!userEditedId) idInput.value = providerSelect.value;
    });
    urlInput.addEventListener("input", () => {
      const det = detectProviderFromUrl(urlInput.value);
      if (det) {
        providerSelect.value = det;
        detectedBadge.textContent = "Detected: " + PROVIDER_LABELS[det];
        detectedBadge.hidden = false;
        if (!userEditedId) idInput.value = det;
        syncProviderVisibility();
      } else {
        detectedBadge.hidden = true;
      }
    });
    syncProviderVisibility();

    // Telegram form elements
    const tgTokenInput = el("input", { class: "input mono", type: "password", placeholder: "Bot token from @BotFather" });
    const tgChatInput = el("input", { class: "input mono", placeholder: "Chat ID (or click Detect after messaging your bot)" });
    const tgIdInput = el("input", { class: "input mono", value: "telegram" });
    const tgDefaultCheck = el("input", { type: "checkbox", checked: true });
    const tgCandidatesBox = el("div", { class: "pill-list", style: "margin-bottom:10px" });

    const urlForm = el("div", { hidden: state.channelMode !== "url" },
      el("div", { class: "field" },
        el("div", { class: "card-title-row" }, el("label", null, "Webhook or Push URL"), detectedBadge),
        urlInput
      ),
      el("div", { class: "grid-2" },
        el("div", { class: "field" }, el("label", null, "Platform"), providerSelect),
        el("div", { class: "field" }, el("label", null, "Channel ID (used in notify.channels)"), idInput)
      ),
      el("div", { class: "field" }, el("label", null, "Label (optional)"), labelInput),
      signField,
      headerField,
      el("label", { class: "inline-note", style: "display:flex;align-items:center;gap:6px;margin-bottom:12px" },
        makeDefaultCheck, "Include in global default channels"
      ),
      el("div", { class: "btn-row" },
        el("button", {
          class: "btn btn-primary",
          onClick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const headers = {};
              const rawHeader = headerField.querySelector("input").value.trim();
              if (!headerField.hidden && rawHeader) {
                const idx = rawHeader.indexOf(":");
                if (idx <= 0) throw new Error("Custom header must use Name: Value format");
                headers[rawHeader.slice(0, idx).trim()] = rawHeader.slice(idx + 1).trim();
              }
              await api("/api/channels/webhook", {
                method: "POST",
                body: {
                  id: idInput.value.trim(),
                  provider: providerSelect.value,
                  url: urlInput.value.trim(),
                  label: labelInput.value.trim(),
                  signingSecret: signField.hidden ? undefined : signField.querySelector("input").value.trim(),
                  headers: Object.keys(headers).length ? headers : undefined,
                  makeDefault: makeDefaultCheck.checked,
                  test: true
                }
              });
              urlInput.value = "";
              signField.querySelector("input").value = "";
              headerField.querySelector("input").value = "";
              detectedBadge.hidden = true;
              showToast("Saved & verified channel " + idInput.value.trim() + "!");
              await refresh();
            } catch (e) { showToast(e.message, true); }
            finally { btn.disabled = false; }
          }
        }, "Save & Send Test Push"),
        el("button", {
          class: "btn",
          onClick: async () => {
            try {
              await api("/api/channels/webhook", {
                method: "POST",
                body: {
                  id: idInput.value.trim(),
                  provider: providerSelect.value,
                  url: urlInput.value.trim(),
                  label: labelInput.value.trim(),
                  signingSecret: signField.hidden ? undefined : signField.querySelector("input").value.trim(),
                  makeDefault: makeDefaultCheck.checked,
                  test: false
                }
              });
              urlInput.value = "";
              showToast("Saved channel " + idInput.value.trim());
              await refresh();
            } catch (e) { showToast(e.message, true); }
          }
        }, "Save Without Test")
      )
    );

    const tgForm = el("div", { hidden: state.channelMode !== "telegram" },
      el("div", { class: "field" },
        el("label", null, "1. Bot Token (from @BotFather — stored in 0600 channel-secrets.json)"),
        tgTokenInput
      ),
      el("div", { class: "field" },
        el("label", null, "2. Send /start to your bot in Telegram, then detect or enter Chat ID"),
        el("div", { class: "btn-row" },
          tgChatInput,
          el("button", {
            class: "btn btn-signal",
            onClick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              try {
                const res = await api("/api/channels/telegram/chats", {
                  method: "POST",
                  body: { botToken: tgTokenInput.value.trim() }
                });
                tgCandidatesBox.replaceChildren();
                if (!res.chats || res.chats.length === 0) {
                  showToast("No recent messages found — send /start to your bot in Telegram first.", true);
                } else {
                  tgChatInput.value = res.chats[0].chatId;
                  for (const c of res.chats) {
                    tgCandidatesBox.appendChild(el("button", {
                      class: "channel-pill selected",
                      onClick: () => { tgChatInput.value = c.chatId; }
                    }, c.title + " (" + c.chatId + ")"));
                  }
                  showToast("Detected " + res.chats.length + " chat(s).");
                }
              } catch (e) { showToast(e.message, true); }
              finally { btn.disabled = false; }
            }
          }, "Detect Chat ID")
        )
      ),
      tgCandidatesBox,
      el("div", { class: "field" }, el("label", null, "Channel ID"), tgIdInput),
      el("label", { class: "inline-note", style: "display:flex;align-items:center;gap:6px;margin-bottom:12px" },
        tgDefaultCheck, "Include in global default channels"
      ),
      el("button", {
        class: "btn btn-primary",
        onClick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            await api("/api/channels/webhook", {
              method: "POST",
              body: {
                id: tgIdInput.value.trim(),
                provider: "telegram",
                botToken: tgTokenInput.value.trim(),
                chatId: tgChatInput.value.trim(),
                makeDefault: tgDefaultCheck.checked,
                test: true
              }
            });
            tgTokenInput.value = "";
            showToast("Saved & verified Telegram channel!");
            await refresh();
          } catch (e) { showToast(e.message, true); }
          finally { btn.disabled = false; }
        }
      }, "Save & Send Test Message")
    );

    // Collapsible Email Setup
    const emailAddr = el("input", { class: "input mono", placeholder: "you@gmail.com / @qq.com / @163.com / @icloud.com" });
    const emailPass = el("input", { class: "input mono", type: "password", placeholder: "SMTP App Password" });
    const emailHost = el("input", { class: "input mono", placeholder: "Optional custom SMTP host" });
    const emailPort = el("input", { class: "input mono", placeholder: "Port (465 or 587)" });

    const emailDetails = el("details", { class: "advanced" },
      el("summary", null, "Advanced: Email (SMTP) Archive Channel"),
      el("div", { style: "margin-top:12px" },
        el("p", { class: "section-desc" }, "Built-in presets for Gmail, iCloud, QQ, 163/126, Fastmail, Yahoo and Aliyun (requires an SMTP App Password)."),
        el("div", { class: "grid-2" },
          el("div", { class: "field" }, el("label", null, "Email Address"), emailAddr),
          el("div", { class: "field" }, el("label", null, "App Password"), emailPass)
        ),
        el("div", { class: "grid-2" },
          el("div", { class: "field" }, el("label", null, "Custom SMTP Host (leave blank for preset)"), emailHost),
          el("div", { class: "field" }, el("label", null, "Custom Port (optional)"), emailPort)
        ),
        el("button", {
          class: "btn btn-sm",
          onClick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              await api("/api/channels/email", {
                method: "POST",
                body: {
                  address: emailAddr.value.trim(),
                  password: emailPass.value,
                  host: emailHost.value.trim() || undefined,
                  port: emailPort.value.trim() ? Number(emailPort.value.trim()) : undefined,
                  test: true
                }
              });
              emailPass.value = "";
              showToast("Saved & verified Email channel!");
              await refresh();
            } catch (e) { showToast(e.message, true); }
            finally { btn.disabled = false; }
          }
        }, "Save & Test Email")
      )
    );

    // Probe Secrets card
    const secName = el("input", { class: "input mono", placeholder: "FUTU_API_KEY or GITHUB_TOKEN" });
    const secVal = el("input", { class: "input mono", type: "password", placeholder: "Secret value (write-only, never echoed back)" });
    const secHosts = el("input", { class: "input mono", placeholder: "Optional sandboxed host allowlist, e.g. api.github.com" });

    return el("div", { class: "stack" },
      el("div", { class: "card" },
        el("h3", { class: "section-title" }, "Active Delivery Channels"),
        el("p", { class: "section-desc" }, "Capability URLs and tokens stay in ~/.self-starter/channel-secrets.json (0600) — never exposed to probes or chat context."),
        el("div", { id: "configured-channels-slot" }, renderChannelsConfiguredList(snap))
      ),
      el("div", { class: "grid-2" },
        el("div", { class: "card" },
          el("div", { class: "card-head", style: "margin-bottom:12px" },
            el("div", null,
              el("h3", { class: "section-title" }, "Add Outbound Push Channel"),
              el("p", { class: "section-desc", style: "margin-bottom:0" }, "Paste one webhook URL or connect a Telegram bot in seconds.")
            ),
            el("div", { class: "seg-group" },
              el("button", {
                class: state.channelMode === "url" ? "seg-btn active" : "seg-btn",
                onClick: () => { state.channelMode = "url"; urlForm.hidden = false; tgForm.hidden = true; render(true); }
              }, "Webhook / Push URL"),
              el("button", {
                class: state.channelMode === "telegram" ? "seg-btn active" : "seg-btn",
                onClick: () => { state.channelMode = "telegram"; urlForm.hidden = true; tgForm.hidden = false; render(true); }
              }, "Telegram Bot")
            )
          ),
          urlForm,
          tgForm,
          emailDetails
        ),
        el("div", { class: "card" },
          el("h3", { class: "section-title" }, "Probe API Secrets"),
          el("p", { class: "section-desc" }, "Environment variables for probes that declare probe.permissions.env (stored in ~/.self-starter/secrets.json, 0600)."),
          el("div", { class: "field" }, el("label", null, "Secret Name (UPPER_SNAKE_CASE)"), secName),
          el("div", { class: "field" }, el("label", null, "Secret Value"), secVal),
          el("div", { class: "field" }, el("label", null, "Allowed Hosts for Sandboxed Probes (leave blank for *)"), secHosts),
          el("button", {
            class: "btn btn-primary",
            onClick: async () => {
              try {
                await api("/api/secrets", {
                  method: "POST",
                  body: {
                    name: secName.value.trim(),
                    value: secVal.value,
                    hosts: secHosts.value.trim()
                  }
                });
                const saved = secName.value.trim();
                secName.value = "";
                secVal.value = "";
                secHosts.value = "";
                showToast("Saved probe secret " + saved);
                await refresh();
              } catch (e) { showToast(e.message, true); }
            }
          }, "Save Probe Secret"),
          el("div", { id: "configured-secrets-slot", style: "margin-top:14px" }, renderSecretsConfiguredList(snap))
        )
      )
    );
  }

  function render(preserveForms = false) {
    const app = document.getElementById("app");
    if (!app || !state.data) return;

    // When already on Channels & Secrets tab and typing into inputs, update header/nav and list slots in place!
    if (preserveForms && state.tab === "channels" && document.getElementById("configured-channels-slot")) {
      const oldHeader = app.querySelector("header.topbar");
      const oldNav = app.querySelector("nav.nav-row");
      if (oldHeader) oldHeader.replaceWith(renderHeader(state.data));
      if (oldNav) oldNav.replaceWith(renderNav(state.data));
      document.getElementById("configured-channels-slot").replaceChildren(renderChannelsConfiguredList(state.data));
      document.getElementById("configured-secrets-slot").replaceChildren(renderSecretsConfiguredList(state.data));
      return;
    }

    const body = state.tab === "inbox" ? renderInbox(state.data)
      : state.tab === "watches" ? renderWatches(state.data)
      : renderChannelsTab(state.data);

    app.replaceChildren(renderHeader(state.data), renderNav(state.data), body);
  }

  function connectEvents() {
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        state.data = snap;
        state.online = true;
        notifyBrowserIfNew(snap);
        render(true);
      } catch {}
    });
    es.onerror = () => {
      state.online = false;
      render(true);
    };
  }

  refresh().then(connectEvents);
})();
`;
