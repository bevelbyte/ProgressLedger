// Strict Content-Security-Policy for the main BrowserWindow session.
//
// Kept in its own module so tests can lint the policy string without
// importing shell/src/main.js (which transitively requires the Electron
// runtime and crashes under bare Node).
//
// Goals:
//   - block remote script/style/font/image sources
//   - forbid inline scripts; 'unsafe-inline' is permitted on style-src
//     only because Vite/Svelte inline style attributes (e.g.
//     `style="display:none"`) cannot carry a nonce without a build change
//   - forbid object/embed, frame ancestors, and form-action POSTs
//   - data: images are permitted for small base64 icons only

export const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");