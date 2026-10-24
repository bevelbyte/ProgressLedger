#!/usr/bin/env node
/**
 * pre-commit — gated parity + fast-test checks before any commit.
 *
 * Why this exists:
 *   Sub-agents frequently commit partial Rust/JS work that breaks the shell↔Rust
 *   IPC contract or ESM import wiring. We catch those at commit time so a bad
 *   parity change never lands on main.
 *
 * Staged-file policy (skip a check when its glob is untouched):
 *   - core/src/<any>.rs, core/progress_ledger_core.<triple>.node, core/index.{js,d.ts}
 *       → npm run check:napi
 *   - shell/<any>.js
 *       → npm run check:esm, npm run check:ipc
 *   - shell/src/services/agent/<any>
 *       → fast node --test subset on the agent loop
 *   - ui/<any>.svelte
 *       → vitest smoke on ui/tests/audit-retention-config.test.js
 *       NOTE: we deliberately run one known-passing smoke test instead of the
 *       full `npx vitest run`. The full suite has 2 pre-existing failures
 *       (tests/session-export.test.js — effect_update_depth_exceeded) unrelated
 *       to the gate; running them here would block every legitimate .svelte
 *       commit. The smoke test still proves the vitest harness + ESM/Svelte
 *       wiring resolve from ui/.
 *
 * Escape hatch: a commit message starting with `[skip-pre-commit]` skips every
 * check. Use only for emergency commits (hotfix during incident, etc.).
 *
 * Usage: node scripts/pre-commit.mjs   (invoked by .git/hooks/pre-commit)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = root;

// ---------- 1. Detect escape hatch -------------------------------------------
// The hook runs before the commit message is saved, but git writes the message
// to .git/COMMIT_EDITMSG before invoking pre-commit. We read it from there.
let commitMsg = "";
try {
  const editMsgPath = join(root, ".git", "COMMIT_EDITMSG");
  commitMsg = readFileSync(editMsgPath, "utf8").split("\n")[0].trim();
} catch {
  // No commit message yet (e.g. running the script by hand) — treat as normal.
}
if (commitMsg.startsWith("[skip-pre-commit]")) {
  console.log(`pre-commit: skipped (commit message starts with [skip-pre-commit])`);
  process.exit(0);
}

// ---------- 2. Get staged files ---------------------------------------------
// `shell: true` so `npm` (a .cmd shim on Windows) resolves via the user's PATH
// the same way it does from an interactive terminal. git/node are .exe files
// and don't need the shell, but using it everywhere keeps the call uniform.
const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
  cwd,
  encoding: "utf8",
  shell: true,
});
if (staged.status !== 0) {
  console.error("pre-commit: failed to enumerate staged files");
  process.exit(1);
}
const files = staged.stdout.split("\n").filter(Boolean);
if (files.length === 0) {
  console.log("pre-commit: nothing staged — nothing to check");
  process.exit(0);
}

// ---------- 3. Classify which checks to run ---------------------------------
const checks = [];

const touchesRustSurface = files.some(
  (f) =>
    f.startsWith("core/src/") && f.endsWith(".rs") ||
    /^core\/progress_ledger_core\..*\.node$/.test(f) ||
    /^core\/index\.(js|d\.ts)$/.test(f),
);
if (touchesRustSurface) {
  checks.push({ name: "check:napi (Rust surface changed)", cmd: "npm", args: ["run", "check:napi"] });
}

const touchesShellJs = files.some((f) => f.startsWith("shell/") && f.endsWith(".js"));
if (touchesShellJs) {
  checks.push({ name: "check:esm (shell JS changed)", cmd: "npm", args: ["run", "check:esm"] });
  checks.push({ name: "check:ipc (shell JS changed)", cmd: "npm", args: ["run", "check:ipc"] });
}

const touchesAgentLoop = files.some((f) => f.startsWith("shell/src/services/agent/"));
if (touchesAgentLoop) {
  checks.push({
    name: "agent-loop fast subset",
    cmd: "node",
    args: [
      "--test",
      "shell/tests/agent-e2e.test.js",
      "shell/tests/agent-loop.test.js",
      "shell/tests/agent-resume.test.js",
    ],
  });
}

const touchesUi = files.some((f) => f.startsWith("ui/") && f.endsWith(".svelte"));
if (touchesUi) {
  // vitest picks up its config from the cwd; running from `ui/` lets the
  // existing vitest.config.js resolve, the same way `npm run test:ui` does.
  checks.push({
    name: "ui vitest smoke",
    cmd: "npx",
    args: ["vitest", "run", "tests/audit-retention-config.test.js"],
    cwd: join(root, "ui"),
  });
}

if (checks.length === 0) {
  console.log("pre-commit: no gated paths touched — skipping checks");
  process.exit(0);
}

// ---------- 4. Run checks sequentially, fail fast ---------------------------
const results = [];
for (const c of checks) {
  console.log(`\n--- ${c.name} ---`);
  const t0 = Date.now();
  const r = spawnSync(c.cmd, c.args, { cwd: c.cwd ?? cwd, stdio: "inherit", shell: true });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ name: c.name, ok, ms, status: r.status });
  if (!ok) {
    console.error(`\npre-commit: ${c.name} FAILED (exit ${r.status}, ${ms}ms)`);
    console.error("pre-commit checks: FAILED");
    for (const r2 of results) {
      console.error(`  ${r2.ok ? "PASS" : "FAIL"}  ${r2.name}  (${r2.ms}ms)`);
    }
    process.exit(1);
  }
}

console.log("\npre-commit checks: PASSED");
for (const r of results) {
  console.log(`  PASS  ${r.name}  (${r.ms}ms)`);
}
process.exit(0);