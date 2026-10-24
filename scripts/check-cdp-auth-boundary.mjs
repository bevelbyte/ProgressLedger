#!/usr/bin/env node
/**
 * Static regression guard for the browser-control transport boundary.
 *
 * ARCHITECTURE (R6/R7):
 *   Production CareerFlow must not control Donut pages through CDP/DevTools.
 *   Browser Manager uses the authenticated official Local API for profile run
 *   and open-url. CareerFlow's own WebContentsView is a separate surface.
 *
 *   The old adapter/session files remain as dormant historical test fixtures
 *   for now. Their internal transport checks are retained, AND the production
 *   import graph is independently checked below to ensure none is reachable.
 *   The upstream raw same-user DevTools WebSocket authentication issue remains
 *   BLOCKED; this checker does not claim to fix that upstream issue.
 *
 *   Boundary rules:
 *
 *  1. NO raw WebSocket construction anywhere in shell/src. The old single
 *     `new WebSocket(` site is gone with the raw transport; nothing may
 *     reintroduce raw DevTools sockets.
 *  2. NO DevTools endpoint discovery: `/json/version`, `/json/list`,
 *     `webSocketDebuggerUrl`, and `/devtools/{browser,page}/` URL construction
 *     must not appear in production code.
 *  3. The dormant legacy session fixture retains strict loopback-only numeric
 *     port validation; it is not reachable from the production entry point.
 *  4. NO fake REST tab endpoints: `/tabs` style fallbacks against the Donut
 *     API do not exist in the official contract and must not return.
 *  5. The renderer surface (preload.cjs) exposes no CDP/Playwright primitive,
 *     no endpoint, port, token, or WebSocket capability.
 *  6. Playwright is imported only in the dormant legacy session fixture; no
 *     production-reachable module may import or invoke it.
 *  7. The provider seam (services/browser-provider/) exposes no CDP or
 *     Playwright transport detail.
 *
 * Exit code 0 = boundary intact; any finding = non-zero with details.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellSrc = join(root, "shell", "src");
const SESSION = join(shellSrc, "services", "cdp-session.js");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js") || entry.endsWith(".cjs")) out.push(full);
  }
  return out;
}

const problems = [];
const shellFiles = walk(shellSrc);

// ---- Production module reachability. A file that exists but is not imported
// by main.js cannot serve as a production integration path. Keep this graph
// check separate from the legacy fixture checks above so the two claims cannot
// be conflated.
function localImports(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["'](\.{1,2}\/[^"']+)["']/gs,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

function resolveLocalImport(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier);
  const candidates = /\.(?:mjs|cjs|js)$/.test(base)
    ? [base]
    : [`${base}.js`, `${base}.cjs`, join(base, "index.js")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.startsWith(shellSrc)) return candidate;
  }
  return null;
}

const productionReachable = new Set();
const queue = [join(shellSrc, "main.js")];
while (queue.length) {
  const file = queue.pop();
  if (productionReachable.has(file) || !existsSync(file)) continue;
  productionReachable.add(file);
  for (const specifier of localImports(file)) {
    const target = resolveLocalImport(file, specifier);
    if (target && !productionReachable.has(target)) queue.push(target);
  }
}

const dormantLegacyPaths = [
  "ipc/cdp.js",
  "services/cdp-adapter.js",
  "services/cdp-session.js",
  "services/browser-workspace.js",
];
for (const rel of dormantLegacyPaths) {
  const full = join(shellSrc, rel);
  if (productionReachable.has(full)) {
    problems.push(`retired Donut/CDP module is production-reachable from main.js: shell/src/${rel}`);
  }
}

for (const rel of [
  "ipc/browser-workspace.js",
  "services/browser-workspace-tools.js",
  "ipc/browser-manager.js",
  "services/donut-manager.js",
  "services/browser/host.js",
]) {
  if (!productionReachable.has(join(shellSrc, rel))) {
    problems.push(`expected supported or fail-closed production module is not reachable from main.js: shell/src/${rel}`);
  }
}

const productionIpcIndex = readFileSync(join(shellSrc, "ipc", "index.js"), "utf8");
if (/from\s+["']\.\/cdp\.js["']/.test(productionIpcIndex) || /registerCdp/.test(productionIpcIndex)) {
  problems.push("ipc/index.js must not register the retired cdp:* IPC surface");
}
for (const file of productionReachable) {
  const src = readFileSync(file, "utf8");
  if (/connectOverCDP|sharedCdpSession|createCdpAdapter|createCdpSession/.test(src)) {
    problems.push(`production-reachable module references retired CDP transport: ${relative(root, file).split(sep).join("/")}`);
  }
  if (/\b(?:findWindowForProcess|findWindowsForProcess|inspectWindow|focusWindow|hostWindow|resizeHostedWindow|focusHostedWindow|unhostWindow|showHostedWindow)\b/.test(src)) {
    problems.push(`production-reachable module references native foreign-window control: ${relative(root, file).split(sep).join("/")}`);
  }
}

// The official Local API paths must remain in Browser Manager; fail the gate
// if a future edit removes the supported alternative while keeping refusals.
const browserManagerSrc = readFileSync(join(shellSrc, "ipc", "browser-manager.js"), "utf8");
for (const [pattern, label] of [
  [/\/v1\/profiles\/\$\{encodeURIComponent\(donutId\)\}\/run/, "official profile /run path"],
  [/\/v1\/profiles\/\$\{encodeURIComponent\(donutId\)\}\/open-url/, "official profile /open-url path"],
  [/Authorization:\s*`Bearer \$\{cred\.token\}`/, "bearer-authenticated Local API request"],
]) {
  if (!pattern.test(browserManagerSrc)) problems.push(`Browser Manager lost ${label}`);
}

// ---- 1. No raw WebSocket construction anywhere in shell/src.
for (const file of shellFiles) {
  const src = readFileSync(file, "utf8");
  if (/new\s+WebSocket\s*\(/.test(src)) {
    problems.push(
      `raw WebSocket construction in ${relative(root, file).split(sep).join("/")}: the Playwright transport owns all browser connections.`,
    );
  }
}

// ---- 2. No DevTools endpoint discovery or DevTools URL shapes.
const FORBIDDEN_TRANSPORT_PATTERNS = [
  [/"\/json\/version"/, "/json/version discovery call"],
  [/"\/json\/list"/, "/json/list discovery call"],
  [/webSocketDebuggerUrl/, "DevTools WebSocket URL metadata"],
  [/\/devtools\/(?:browser|page)\//, "hand-built DevTools endpoint path"],
  [/\/v1\/profiles\/[^"']*\/tabs/, "fake REST tab endpoint fallback"],
];
for (const file of shellFiles) {
  const src = readFileSync(file, "utf8");
  for (const [pattern, label] of FORBIDDEN_TRANSPORT_PATTERNS) {
    if (pattern.test(src)) {
      problems.push(
        `${label} in ${relative(root, file).split(sep).join("/")}`,
      );
    }
  }
}

// ---- 3. The Playwright session builds only loopback endpoints from a port.
const sessionSrc = readFileSync(SESSION, "utf8");
const REQUIRED_SESSION_PATTERNS = [
  [/validPort\(/, "numeric port validation before connect"],
  [/connect\(`http:\/\/127\.0\.0\.1:\$\{p\}`\)/, "loopback-only connectOverCDP endpoint construction"],
  [/connectOverCDP/, "official Playwright connectOverCDP mechanism"],
  [/record\.browser\.close\(\)/, "session close that clears contexts without killing the browser"],
];
for (const [pattern, label] of REQUIRED_SESSION_PATTERNS) {
  if (!pattern.test(sessionSrc)) {
    problems.push(`cdp-session.js lost required boundary control: ${label}`);
  }
}

// ---- 4. Playwright imports only in provider-internal session module.
for (const file of shellFiles) {
  if (file === SESSION) continue;
  const src = readFileSync(file, "utf8");
  if (/from\s+["']playwright(-core)?["']/.test(src) || /require\(["']playwright/.test(src) || /import\(["']playwright/.test(src)) {
    problems.push(
      `Playwright import outside cdp-session.js: ${relative(root, file).split(sep).join("/")}`,
    );
  }
}

// ---- 5. The preload surface must not expose CDP/Playwright primitives.
const preloadPath = join(shellSrc, "preload.cjs");
const preloadSrc = readFileSync(preloadPath, "utf8");
for (const [pattern, label] of [
  [/ipcRenderer\.invoke\(\s*["']cdp:/, "direct cdp:* IPC invocation"],
  [/^\s*cdp:\s*\{/m, "direct cdp renderer namespace"],
  [/new\s+WebSocket\s*\(/, "WebSocket construction"],
  [/webSocketDebuggerUrl/, "DevTools URL metadata"],
  [/playwright/i, "Playwright reference"],
  [/remote_debugging_port|remoteDebuggingPort/, "remote_debugging_port"],
  [/connectOverCDP/, "connectOverCDP"],
]) {
  if (pattern.test(preloadSrc)) {
    problems.push(`preload.cjs must not expose ${label} to the renderer.`);
  }
}

// ---- 6. The provider seam exposes no transport detail.
//
// The generic browser-provider/ engine seam was deliberately REMOVED from the
// architecture (CareerFlow's browser is its own embedded WebContentsView; Donut
// is a separate external application, not a swappable engine). That directory
// therefore normally does not exist.
//
// This rule is still enforced whenever the directory IS present, so the
// boundary cannot be silently reintroduced by dropping seam files back in
// without inspection. The `existsSync` guard only prevents this gate from
// crashing with ENOENT on a directory that was removed on purpose; it does NOT
// relax any of the five forbidden patterns below.
const seamDir = join(shellSrc, "services", "browser-provider");
const seamFiles = existsSync(seamDir) ? walk(seamDir) : [];
if (!existsSync(seamDir)) {
  console.log(
    "  rule 6: provider seam directory absent (removed by design) — rule vacuously satisfied",
  );
}
for (const file of seamFiles) {
  const src = readFileSync(file, "utf8");
  for (const [pattern, label] of [
    [/new\s+WebSocket\s*\(/, "raw WebSocket construction"],
    [/webSocketDebuggerUrl/, "DevTools WebSocket URL"],
    [/\/devtools\/(?:browser|page)\//, "DevTools endpoint path"],
    [/playwright/i, "Playwright transport reference"],
    [/connectOverCDP/, "connectOverCDP"],
  ]) {
    if (pattern.test(src)) {
      problems.push(
        `provider seam exposes ${label}: ${relative(root, file).split(sep).join("/")}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("CDP AUTH BOUNDARY CHECK FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`production import graph: ${productionReachable.size} shell modules; retired Donut/CDP modules unreachable`);
console.log("CDP-AUTH-BOUNDARY=OK");
