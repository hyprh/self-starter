// Minimal zero-inline-script HTML shell for `self-starter ui` (CSP: default-src 'self').

export const UI_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="ss-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3a261c"/>
      <stop offset="100%" stop-color="#211713"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#ss-bg)"/>
  <path d="M308 121.6A144 144 0 1 0 396 294.4" fill="none" stroke="#faf5ed" stroke-width="44" stroke-linecap="round"/>
  <circle cx="372" cy="156" r="68" fill="#f59e0b" fill-opacity="0.24"/>
  <circle cx="372" cy="156" r="46.4" fill="#fbbf24"/>
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
