// Stylesheet for `self-starter ui`, sharing the editorial light/dark palette of site/index.html.

export const UI_STYLES = `:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #fbfcfd;
  --fg: #17202a;
  --muted: #5c6773;
  --line: #dde4eb;
  --soft: #edf1f5;
  --accent: #a34b08;
  --signal: #e8870e;
  --signal-soft: #fff2de;
  --green: #167959;
  --green-soft: #e6f6f0;
  --down: #c8514a;
  --down-soft: #fdeceb;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 18px rgba(16, 24, 40, 0.04);
  --font: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --display: "Schibsted Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f141a;
    --surface: #161d26;
    --surface-2: #1b2430;
    --fg: #ecf1f7;
    --muted: #9aa8b8;
    --line: #283341;
    --soft: #202a36;
    --accent: #f2ad65;
    --signal: #f0a244;
    --signal-soft: #332515;
    --green: #6ad3a8;
    --green-soft: #132c24;
    --down: #e5736b;
    --down-soft: #341b1b;
    --shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}

button, input, select, textarea {
  font: inherit;
  color: inherit;
}

code, pre, .mono {
  font-family: var(--mono);
}

.shell {
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 20px 64px;
}

/* Top Telemetry Header */
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 18px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--signal-soft);
  border: 1px solid color-mix(in srgb, var(--signal) 35%, transparent);
  display: grid;
  place-items: center;
  color: var(--accent);
  font-weight: 700;
  font-family: var(--mono);
}

.brand-title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.02em;
}

.brand-sub {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
}

.dot.offline { background: var(--down); }

.stats-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.stat-pill {
  padding: 6px 11px;
  border-radius: 8px;
  background: var(--soft);
  border: 1px solid var(--line);
  font-size: 12px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.stat-pill strong {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
}

.stat-pill .zero-tag {
  color: var(--green);
  font-family: var(--mono);
  font-weight: 500;
}

/* Navigation Tabs */
.nav-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 18px 0 16px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tab-btn {
  border: 1px solid transparent;
  background: transparent;
  padding: 7px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 13.5px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  transition: background 0.12s, color 0.12s;
}

.tab-btn:hover {
  background: var(--soft);
  color: var(--fg);
}

.tab-btn.active {
  background: var(--surface);
  color: var(--fg);
  border-color: var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.count-badge {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--muted);
}

.count-badge.urgent {
  background: var(--signal);
  color: #111;
  font-weight: 700;
}

/* Sub-toolbar & Buttons */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
}

.seg-group {
  display: inline-flex;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.seg-btn {
  border: 0;
  background: transparent;
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
}

.seg-btn.active {
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.btn {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg);
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn:hover:not(:disabled) {
  background: var(--soft);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--fg);
  color: var(--bg);
  border-color: var(--fg);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--fg);
}

.btn-signal {
  background: var(--signal-soft);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--signal) 45%, var(--line));
}

.btn-danger {
  color: var(--down);
  border-color: color-mix(in srgb, var(--down) 35%, var(--line));
}

.btn-danger:hover:not(:disabled) {
  background: var(--down-soft);
}

.btn-sm {
  padding: 4px 9px;
  font-size: 12px;
}

/* Cards */
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 15px 17px;
  box-shadow: var(--shadow);
}

.card.attention {
  border-left: 4px solid var(--signal);
}

.card.failed {
  border-left: 4px solid var(--down);
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.card-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.card-title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 15px;
  margin: 0;
}

.meta-line {
  font-size: 12px;
  color: var(--muted);
  margin-top: 3px;
}

.badge {
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--soft);
  color: var(--muted);
  border: 1px solid var(--line);
}

.badge.ok {
  background: var(--green-soft);
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 30%, transparent);
}

.badge.warn {
  background: var(--signal-soft);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--signal) 35%, transparent);
}

.badge.err {
  background: var(--down-soft);
  color: var(--down);
  border-color: color-mix(in srgb, var(--down) 35%, transparent);
}

.receipt-box {
  margin-top: 11px;
  padding: 11px 13px;
  border-radius: 8px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13.5px;
  line-height: 1.55;
}

.probe-line {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--muted);
}

.reopen-bar {
  margin-top: 11px;
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--soft);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.reopen-bar code {
  font-size: 12px;
  word-break: break-all;
}

.card-actions {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* Delivery Routing Pills on Watch Cards */
.routing-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pill-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.channel-pill {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
}

.channel-pill.selected {
  background: var(--signal-soft);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--signal) 50%, var(--line));
  font-weight: 500;
}

/* Forms & Grid */
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 11px;
}

.field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.input, .select {
  padding: 8px 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: 13px;
}

.input:focus, .select:focus {
  outline: 2px solid var(--signal);
  outline-offset: 1px;
}

.section-title {
  font-family: var(--display);
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 4px;
}

.section-desc {
  font-size: 12.5px;
  color: var(--muted);
  margin: 0 0 13px;
}

.list-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
}

.empty-state {
  text-align: center;
  padding: 36px 20px;
  background: var(--surface);
  border: 1px dashed var(--line);
  border-radius: 11px;
  color: var(--muted);
}

.empty-state h3 {
  font-family: var(--display);
  color: var(--fg);
  margin: 0 0 6px;
  font-size: 15px;
}

/* Drawer / Modal */
.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(10, 15, 22, 0.48);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}

.drawer {
  width: min(720px, 100vw);
  height: 100vh;
  background: var(--surface);
  border-left: 1px solid var(--line);
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.code-block {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
}

.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 14px;
  border-radius: 9px;
  background: var(--fg);
  color: var(--bg);
  font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  z-index: 80;
  max-width: 420px;
}

.toast.error {
  background: var(--down);
  color: #fff;
}

details.advanced {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

details.advanced summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--muted);
}

.inline-note {
  font-size: 12px;
  color: var(--muted);
}

[hidden] { display: none !important; }
`;
