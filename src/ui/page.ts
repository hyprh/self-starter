// Minimal zero-inline-script HTML shell for `self-starter ui` (CSP: default-src 'self').

export const UI_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#fff2de" stroke="#e8870e" stroke-width="2"/>
  <path d="M17.5 6L9 17.5h6.5L14.5 26 23 14.5h-6.5L17.5 6z" fill="#a34b08"/>
</svg>`;

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Self-Starter Console</title>
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app" class="shell">
    <div class="empty-state">Loading Self-Starter Console…</div>
  </div>
  <div id="drawer-root" hidden></div>
  <div id="toast-root" hidden></div>
  <script src="/app.js"></script>
</body>
</html>
`;
