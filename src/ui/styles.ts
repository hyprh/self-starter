// Workspace stylesheet for `self-starter ui`:
// - Sidebar console layout with multi-agent host navigation & channel tiles
// - Eye-care warm yellow-green celadon light theme + obsidian-sage dark theme

const DARK_VARS = `
  --bg: #111512;
  --sidebar: #0c0f0d;
  --surface: #171c18;
  --surface-2: #1d231f;
  --fg: #e7ede6;
  --muted: #93a092;
  --faint: #6c796b;
  --line: #252e27;
  --line-strong: #334036;
  --soft: #202722;
  --brand: #63c493;
  --brand-fg: #0b1811;
  --brand-soft: #173024;
  --signal: #eba949;
  --signal-soft: #312513;
  --green: #5ec490;
  --green-soft: #152e22;
  --down: #e57169;
  --down-soft: #331b1a;
  --host-codex: #62b6cb;
  --host-claude: #e59866;
  --host-zcode: #a58df5;
  --host-opencode: #63c493;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.32);
  --shadow: 0 2px 8px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.22);
  color-scheme: dark;
`;

export const UI_STYLES = `:root,
[data-theme="light"] {
  /* Subtle warm yellow-green eye-care paper palette (Hue ~76deg, low saturation) */
  --bg: #f4f6ef;
  --sidebar: #ecefe5;
  --surface: #fafbf7;
  --surface-2: #eef1e8;
  --fg: #1c231b;
  --muted: #596455;
  --faint: #7c8777;
  --line: #dbe0d1;
  --line-strong: #c8d0bc;
  --soft: #e3e8db;
  --brand: #2b674c;
  --brand-fg: #fafbf7;
  --brand-soft: #deede4;
  --signal: #c47612;
  --signal-soft: #faefd9;
  --green: #237a52;
  --green-soft: #dff2e8;
  --down: #c24942;
  --down-soft: #fbeae8;
  --host-codex: #1f6f8b;
  --host-claude: #b85d28;
  --host-zcode: #6347b8;
  --host-opencode: #2b674c;
  --shadow-sm: 0 1px 2px rgba(28, 35, 27, 0.04);
  --shadow: 0 1px 3px rgba(28, 35, 27, 0.05), 0 8px 22px rgba(28, 35, 27, 0.035);
  --font: "Inter", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --display: "Inter", "Schibsted Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}

[data-theme="dark"] {
  ${DARK_VARS}
}

@media (prefers-color-scheme: dark) {
  [data-theme="auto"] {
    ${DARK_VARS}
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font: 13.5px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}

button, input, select, textarea {
  font: inherit;
  color: inherit;
}

code, pre, .mono {
  font-family: var(--mono);
}

svg.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.8;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

svg.icon-sm {
  width: 14px;
  height: 14px;
}

.boot-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 14px;
}

/* Workspace Grid Shell */
.workspace {
  display: grid;
  grid-template-columns: 256px minmax(0, 1fr);
  min-height: 100vh;
}

/* Left Sidebar */
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--sidebar);
  border-right: 1px solid var(--line);
  padding: 16px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 10px;
  border-bottom: 1px solid var(--line);
}

.brand-logo {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: block;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}

.brand-name {
  font-family: var(--display);
  font-weight: 700;
  font-size: 14.5px;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.brand-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 2px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--green) 22%, transparent);
}

.status-dot.offline {
  background: var(--down);
  box-shadow: none;
}

.nav-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-section-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
  padding: 0 10px 5px;
}

.nav-btn {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  padding: 7.5px 10px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.nav-btn-left {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.nav-btn:hover {
  background: var(--soft);
  color: var(--fg);
}

.nav-btn.active {
  background: var(--surface);
  color: var(--fg);
  font-weight: 600;
  border-color: var(--line);
  box-shadow: var(--shadow-sm);
}

.nav-btn.active svg.icon {
  color: var(--brand);
}

.nav-pill {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 6.5px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--muted);
  font-weight: 500;
}

.nav-pill.urgent {
  background: var(--signal);
  color: #fff;
  font-weight: 700;
}

[data-theme="dark"] .nav-pill.urgent {
  color: #16120b;
}

/* Indented Agent Quick-Filter List in Sidebar */
.agent-filter-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 3px;
  padding-left: 12px;
  border-left: 1px solid var(--line);
  margin-left: 17px;
}

.agent-sub-btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  transition: background 0.12s, color 0.12s;
}

.agent-sub-btn:hover {
  background: var(--soft);
  color: var(--fg);
}

.agent-sub-btn.selected {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.host-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.host-dot.codex { background: var(--host-codex); }
.host-dot.claude-code { background: var(--host-claude); }
.host-dot.zcode { background: var(--host-zcode); }
.host-dot.opencode { background: var(--host-opencode); }
.host-dot.all { background: var(--faint); }

/* Sidebar Footer */
.sidebar-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.telemetry-box {
  padding: 9px 11px;
  border-radius: 9px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-size: 11.5px;
}

.telemetry-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.telemetry-num {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 14px;
  color: var(--fg);
}

.zero-chip {
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--green);
  background: var(--green-soft);
  padding: 1px 6px;
  border-radius: 999px;
}

.telemetry-sub {
  color: var(--muted);
  margin-top: 2px;
  font-size: 11px;
}

.sidebar-util-btn {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-util-btn:hover {
  background: var(--soft);
  color: var(--fg);
}

.sidebar-util-btn.on {
  border-color: color-mix(in srgb, var(--brand) 45%, var(--line));
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.theme-switcher {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.theme-opt {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 5px 4px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.theme-opt:hover {
  color: var(--fg);
}

.theme-opt.active {
  background: var(--surface);
  color: var(--fg);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

/* Main Content Area */
.main-pane {
  min-width: 0;
  padding: 26px 34px 64px;
  max-width: 1140px;
  width: 100%;
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding-bottom: 18px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--line);
}

.page-title {
  font-family: var(--display);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-subtitle {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* Active Host Filter Banner */
.filter-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 13px;
  margin-bottom: 14px;
  border-radius: 9px;
  background: var(--brand-soft);
  border: 1px solid color-mix(in srgb, var(--brand) 28%, var(--line));
  color: var(--brand);
  font-size: 12.5px;
  font-weight: 500;
}

/* KPI Strip */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.kpi-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 13px 15px;
  box-shadow: var(--shadow-sm);
}

.kpi-label {
  font-size: 11.5px;
  color: var(--muted);
  font-weight: 500;
}

.kpi-value {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
  margin-top: 3px;
  letter-spacing: -0.02em;
}

.kpi-foot {
  font-size: 11.5px;
  color: var(--faint);
  margin-top: 2px;
}

/* Toolbars, Search & Segmented Controls */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
}

.toolbar-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.seg-btn:hover {
  color: var(--fg);
}

.seg-btn.active {
  background: var(--surface);
  color: var(--fg);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.search-input {
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12.5px;
  min-width: 210px;
}

.search-input:focus {
  outline: 2px solid color-mix(in srgb, var(--brand) 45%, transparent);
  border-color: var(--brand);
}

/* Buttons */
.btn {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background 0.12s, border-color 0.12s;
}

.btn:hover:not(:disabled) {
  background: var(--soft);
  border-color: var(--line-strong);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--brand);
  color: var(--brand-fg);
  border-color: var(--brand);
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.06);
  background: var(--brand);
  border-color: var(--brand);
}

.btn-signal {
  background: var(--signal-soft);
  color: var(--signal);
  border-color: color-mix(in srgb, var(--signal) 40%, var(--line));
  font-weight: 600;
}

.btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--muted);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--soft);
  color: var(--fg);
  border-color: transparent;
}

.btn-danger {
  color: var(--down);
  border-color: color-mix(in srgb, var(--down) 32%, var(--line));
}

.btn-danger:hover:not(:disabled) {
  background: var(--down-soft);
}

.btn-sm {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 7px;
}

/* Cards & Event Feed */
.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 15px 18px;
  box-shadow: var(--shadow-sm);
  transition: border-color 0.12s;
}

.card:hover {
  border-color: var(--line-strong);
}

.card.attention {
  border-left: 3.5px solid var(--signal);
}

.card.failed {
  border-left: 3.5px solid var(--down);
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
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
  font-weight: 650;
  font-size: 14.5px;
  margin: 0;
}

.time-label {
  font-size: 12px;
  color: var(--faint);
  font-family: var(--mono);
}

.meta-line {
  font-size: 12px;
  color: var(--muted);
  margin-top: 3px;
}

/* Badges & Agent Host Pills */
.badge {
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--soft);
  color: var(--muted);
  border: 1px solid var(--line);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.badge.ok {
  background: var(--green-soft);
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 28%, transparent);
}

.badge.warn {
  background: var(--signal-soft);
  color: var(--signal);
  border-color: color-mix(in srgb, var(--signal) 32%, transparent);
}

.badge.err {
  background: var(--down-soft);
  color: var(--down);
  border-color: color-mix(in srgb, var(--down) 32%, transparent);
}

.host-badge {
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.receipt-body {
  margin-top: 9px;
  padding: 10px 13px;
  border-radius: 9px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.58;
}

.receipt-body.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.expand-link {
  margin-top: 5px;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.card-foot {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}

.probe-snippet {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* Watch Routing Strip */
.routing-box {
  margin-top: 12px;
  padding: 10px 13px;
  border-radius: 9px;
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
  font-size: 11.5px;
  font-family: var(--mono);
  cursor: pointer;
  transition: all 0.12s;
}

.channel-pill:hover {
  border-color: var(--line-strong);
  color: var(--fg);
}

.channel-pill.selected {
  background: var(--brand-soft);
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 45%, var(--line));
  font-weight: 600;
}

/* Multi-Agent Cards Grid */
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 14px;
}

.agent-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.agent-avatar {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 13px;
}

.cap-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cap-chip {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--muted);
}

/* Provider Selector Tiles in Push Channels */
.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}

.provider-tile {
  border: 1px solid var(--line);
  background: var(--surface-2);
  border-radius: 9px;
  padding: 9px 11px;
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: all 0.12s;
}

.provider-tile:hover {
  background: var(--soft);
  border-color: var(--line-strong);
}

.provider-tile.active {
  background: var(--brand-soft);
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand);
}

.provider-tile-name {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--fg);
}

.provider-tile.active .provider-tile-name {
  color: var(--brand);
}

.provider-tile-sub {
  font-size: 11px;
  color: var(--muted);
}

/* Forms & Two-Column Panels */
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
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
  padding: 7.5px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: 13px;
}

.input:focus, .select:focus {
  outline: 2px solid color-mix(in srgb, var(--brand) 38%, transparent);
  border-color: var(--brand);
}

.section-title {
  font-family: var(--display);
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 3px;
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
  padding: 10px 0;
  border-top: 1px solid var(--line);
}

.list-row:first-child {
  border-top: 0;
  padding-top: 2px;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  background: var(--surface);
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
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
  background: rgba(12, 16, 13, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}

.drawer {
  width: min(740px, 100vw);
  height: 100vh;
  background: var(--surface);
  border-left: 1px solid var(--line);
  padding: 22px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.code-block {
  margin: 0;
  padding: 12px 14px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--line);
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.52;
}

.toast {
  position: fixed;
  bottom: 20px;
  right: 22px;
  padding: 10px 15px;
  border-radius: 9px;
  background: var(--fg);
  color: var(--bg);
  font-size: 13px;
  font-weight: 500;
  box-shadow: var(--shadow);
  z-index: 80;
  max-width: 420px;
}

.toast.error {
  background: var(--down);
  color: #fff;
}

details.advanced {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding-top: 9px;
}

details.advanced summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--muted);
}

.inline-note {
  font-size: 12px;
  color: var(--muted);
}

/* Responsive fallback for narrow viewports */
@media (max-width: 880px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: static;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .main-pane {
    padding: 18px 16px 48px;
  }
}

[hidden] { display: none !important; }
`;
