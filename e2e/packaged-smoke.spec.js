// PACKAGED APPLICATION SMOKE (A10) — proves the PACKAGED Windows app works.
//
// Launches the REAL packaged executable (release/win-unpacked/Progress Ledger.exe,
// built by `npm run dist:dir`) — NOT dev electron, NOT source mode. The only
// env used is the app's own established isolation mechanism
// (PROGRESSLEDGER_V2_E2E=1 + PROGRESSLEDGER_V2_E2E_USER_DATA) so the smoke never touches the
// user's real %APPDATA%\progressledger store; the executed code is the packaged
// asar + unpacked natives. Donut control plane uses the app's E2E stub
// (browser leg is init/read-only, per the A10 brief); the provider transport
// is the established scripted-SSE fixture with a fixture key planted through
// Progress Ledger's OWN pm-secrets.json credential mechanism.
//
// Proven here (A10 success criteria):
//   1. packaged exe boots; 2. packaged renderer loads (progressledger-v2:// protocol);
//   3. real native core module loads from app.asar.unpacked;
//   4/5. DB opens + a real write/read through core;
//   6. profile/project state initializes;
//   7/8. real Agent runtime runs one real approval-gated tool (fs_write) with
//        a real filesystem side effect; approval queue works;
//   10. browser workspace initializes and reports sanitized state;
//   11. clean exit + relaunch persists state on the packaged runtime.
// Boundary: no second CDP path, no WebSocket touched, Donut untouched.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const PACKAGED_EXE = join(projectRoot, "release", "win-unpacked", "Progress Ledger.exe");

const FIXTURE_KEY = "E2E-LOCAL-FIXTURE-KEY-NOT-A-SECRET";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Scripted OpenAI-compatible provider (one tool-call round, then a summary).
function startScriptedProvider() {
  const state = { rounds: [], callSeq: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!Array.isArray(state.rounds) || state.rounds.length === 0) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "script-queue-empty" }));
        return;
      }
      const round = state.rounds.length > 1 ? state.rounds.shift() : state.rounds[0];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const chunks = [];
      const calls = round.toolCalls || [];
      for (const [tcIdx, tc] of calls.entries()) {
        const args = JSON.stringify(tc.args);
        chunks.push({ delta: { tool_calls: [{ index: tcIdx, id: `call-${++state.callSeq}`, type: "function", function: { name: tc.name, arguments: "" } }] } });
        chunks.push({ delta: { tool_calls: [{ index: tcIdx, function: { arguments: args } }] } });
      }
      if (calls.length > 0) {
        chunks.push({ delta: {}, finish_reason: "tool_calls" });
      } else {
        chunks.push({ delta: { content: round.text || "done" } });
        chunks.push({ delta: {}, finish_reason: "stop" });
      }
      for (const ch of chunks) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-pkg", model: "pkg-smoke", choices: [ch] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.endpoint = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, state });
    });
  });
}

async function launchPackaged(userDataDir) {
  if (!existsSync(PACKAGED_EXE)) throw new Error(`packaged exe missing: ${PACKAGED_EXE} — run npm run dist:dir first`);
  const app = await electron.launch({
    executablePath: PACKAGED_EXE,
    args: [],
    env: {
      ...process.env,
      PROGRESSLEDGER_V2_E2E: "1",
      PROGRESSLEDGER_V2_E2E_DISABLE_SYSTEM_FALLBACK: "1",
      PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
      PROGRESSLEDGER_V2_E2E_DONUT_STUB: "1",
    },
    timeout: 90_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForLoadState("networkidle");
  return { app, win };
}

async function dismissOnboarding(win) {
  const overlay = win.locator(".onboarding-overlay");
  await overlay.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const skipBtn = win.locator('button.skip-btn:has-text("Skip Tutorial")');
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) await skipBtn.click();
  await overlay.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 200, what = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

test.describe("Packaged application smoke (A10)", () => {
  test("packaged exe: boot → native core → DB → agent tool + approval → browser init → restart", async () => {
    test.setTimeout(420_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-pkg-smoke-ud-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-pkg-smoke-proj-"));
    const provider = await startScriptedProvider();

    let app;
    try {
      // ---- Leg 1/2: packaged boot + packaged renderer ----
      const launched = await launchPackaged(userDataDir);
      app = launched.app;
      const win = launched.win;
      await dismissOnboarding(win);

      // The packaged UI is served through the production progressledger-v2:// branch
      // (isDev=false in the packaged app). The preload bridge must exist.
      const hasBridge = await win.evaluate(() => Boolean(window.progressLedger && window.progressLedger.profiles && window.progressLedger.projectMode));
      expect(hasBridge, "packaged preload bridge must be present").toBe(true);

      // ---- Leg 3/4/5/6: REAL native core load + real DB write/read ----
      // A core DB write can only succeed if progress_ledger_core loaded — and in
      // the packaged app its ONLY location is app.asar.unpacked/core/*.node
      // (patched nativePath loader). This is the native-load proof.
      const profile = await win.evaluate(() => window.progressLedger.profiles.add("PM Package Smoke", `pkg-smoke-${Date.now()}`));
      expect(profile && profile.id).toBeGreaterThan(0);
      const profiles = await win.evaluate(() => window.progressLedger.profiles.list());
      const listed = (Array.isArray(profiles) ? profiles : profiles.profiles || []).some((p) => p && p.id === profile.id);
      expect(listed, "created profile must be readable back through core").toBe(true);

      const created = await win.evaluate(([pid, rootPath]) =>
        window.progressLedger.projectMode.createProject({ profileId: pid, name: "Package Smoke", description: "A10", rootPath, configJson: "{}" }), [profile.id, projectRootPath]);
      const projectId = typeof created === "number" ? created : (created && created.id);
      expect(projectId).toBeGreaterThan(0);

      // Credential planted through Progress Ledger's OWN pm-secrets.json mechanism
      // (fixture value — never a copy of any real credential).
      writeFileSync(
        join(userDataDir, "pm-secrets.json"),
        JSON.stringify({ [`${profile.id}:${projectId}`]: { endpoint: provider.state.endpoint, apiKey: FIXTURE_KEY, model: "pkg-smoke", updatedAt: Date.now() } }, null, 2),
        "utf8",
      );

      // ---- Leg 7/8/9: real Agent runtime + one real approval-gated tool ----
      const objective = "Write the packaged smoke marker file.";
      const markerName = "packaged-smoke-marker.txt";
      const agentRes = await win.evaluate(([pid, projId, obj]) =>
        window.progressLedger.projectMode.createAgent(pid, projId, obj), [profile.id, projectId, objective]);
      const agentId = typeof agentRes === "number" ? agentRes : (agentRes && agentRes.id);
      expect(agentId).toBeGreaterThan(0);

      provider.state.rounds = [
        { toolCalls: [{ name: "fs_write", args: { path: markerName, content: "PACKAGED-SMOKE-OK" } }] },
        { text: "packaged smoke complete" },
      ];
      const startRes = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.startAgent(pid, aid), [profile.id, agentId]);
      expect(startRes.ok, `startAgent: ${JSON.stringify(startRes)}`).toBe(true);

      // Approval queue: the fs_write approval must appear and be approvable.
      const approvalRow = await waitFor(async () => {
        const r = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.listPendingApprovals(pid, aid), [profile.id, agentId]);
        if (r && r.ok && r.count >= 1) {
          const row = (r.approvals || []).find((a) => a.toolName === "fs_write");
          if (row) return row;
        }
        return null;
      }, { what: "fs_write approval in packaged app" });
      // Sanitization: the approval row must not carry the raw input.
      expect(approvalRow).not.toHaveProperty("input");
      const approveRes = await win.evaluate(([pid, aid, id]) => window.progressLedger.projectMode.approveCall(pid, aid, id), [profile.id, agentId, approvalRow.id]);
      expect(approveRes && approveRes.ok).toBe(true);

      // Real filesystem side effect inside the packaged app's project root.
      await waitFor(async () => existsSync(join(projectRootPath, markerName)), { what: "packaged fs_write side effect" });
      const markerContent = readFileSync(join(projectRootPath, markerName), "utf8");
      expect(markerContent).toBe("PACKAGED-SMOKE-OK");

      await waitFor(async () => {
        const a = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.getAgent(pid, aid), [profile.id, agentId]);
        const st = a && (a.agent || a);
        return st && (st.state === "completed" || st.state === "failed") ? st : null;
      }, { what: "packaged agent completion" });
      const stFinal = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.getAgent(pid, aid), [profile.id, agentId]);
      expect((stFinal.agent || stFinal).state, "packaged agent run must complete").toBe("completed");

      // ---- Leg 10: browser workspace initializes + reports (read-only) ----
      const ws = await win.evaluate(() => window.progressLedger.browserWorkspace.state());
      const wsJson = JSON.stringify(ws);
      expect(wsJson).not.toContain(FIXTURE_KEY);
      expect(typeof wsJson).toBe("string");
      // Read-only init must not break the packaged process: the app is alive.
      expect(await win.evaluate(() => document.readyState)).toBe("complete");

      // ---- Leg 11: clean exit + relaunch on the packaged runtime ----
      const proc = app.process();
      const exited = new Promise((resolve) => {
        if (!proc) return resolve();
        const t = setInterval(() => {
          try { if (proc.exitCode !== null || proc.killed) { clearInterval(t); resolve(); } } catch { clearInterval(t); resolve(); }
        }, 200);
        setTimeout(() => { clearInterval(t); resolve(); }, 30_000);
      });
      await app.close();
      await exited;
      app = null;

      const relaunch = await launchPackaged(userDataDir);
      app = relaunch.app;
      const win2 = relaunch.win;
      await dismissOnboarding(win2);
      const profiles2 = await win2.evaluate(() => window.progressLedger.profiles.list());
      const stillThere = (Array.isArray(profiles2) ? profiles2 : profiles2.profiles || []).some((p) => p && p.id === profile.id);
      expect(stillThere, "profile must persist across packaged restart").toBe(true);
      const ws2 = await win2.evaluate(() => window.progressLedger.browserWorkspace.state());
      expect(JSON.stringify(ws2)).not.toContain(FIXTURE_KEY);
    } finally {
      if (app) await app.close().catch(() => {});
      provider.server.close();
    }
  });
});
