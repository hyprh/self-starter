// Minimal zero-inline-script HTML shell for `self-starter ui` (CSP: default-src 'self').

export const UI_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="88" fill="#142724"/>
  <path d="M297.83 140.08A134 134 0 1 0 373.45 209.37" fill="none" stroke="#b6efd4" stroke-width="50" stroke-linecap="round"/>
  <circle cx="396" cy="119" r="32" fill="#b6efd4"/>
</svg>`;

export const UI_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Self-Starter Console</title>
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app" class="app-root">
    <div class="boot-screen">Loading Self-Starter Console…</div>
  </div>
  <div id="drawer-root" hidden></div>
  <div id="toast-root" hidden></div>
  <script src="/app.js"></script>
</body>
</html>
`;
