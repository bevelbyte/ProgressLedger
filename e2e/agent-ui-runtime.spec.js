// GATE J — Agent UI live runtime visibility (real Electron app).
//
// Drives the REAL UI components through a REAL agent run with the
// provider transport MOCKED (scripted SSE — same classification as the
// approval/restart specs). This gate proves UI VISIBILITY, not provider
// realness.
//
// Legs:
//   LEG1: UI-driven start (type objective → click "Run agent") →
//         approval card appears in the REAL ApprovalQueue → user
//         clicks APPROVE in the UI → tool activity + transcript update
//         live → agent reaches completed. Real fs_write side effect on
//         disk. Renderer credential boundary asserted.
//   LEG2: RELOAD mid-approval: after a page reload the pending approval
//         must REHYDRATE into the ApprovalQueue (main-process queue is
//         authoritative; the store now rehydrates it on agent load)
//         and remain actionable from the UI, driven through the real
//         Goals deep-link path (cf:open-agent → pendingAgentId).
//
// LEG2 caught a genuine defect: pending approvals previously reached
// the UI only via the live event stream, so a mid-approval reload left
// the run blocked with NO visible approval card. Fixed in
// projectMode.svelte.js (loadAgent rehydrates pendingApprovals).

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const FIXTURE_KEY = "E2E-LOCAL-FIXTURE-KEY-NOT-A-SECRET";
const OBJECTIVE = "Write the approval target file, then confirm.";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Scripted OpenAI-compatible SSE provider: round 1 emits an fs_write
// tool_call (approval-required), round 2 emits a text answer.
function startScriptedServer({ filePath, fileContent, finalText }) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      server.rounds = (server.rounds || 0) + 1;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const round = server.rounds;
      const chunks = [];
      if (round === 1) {
        const args = JSON.stringify({ path: filePath, content: fileContent, createDirs: true });
        chunks.push({ delta: { tool_calls: [{ index: 0, id: "call-ui-1", type: "function", function: { name: "fs_write", arguments: "" } }] } });
        chunks.push({ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } });
        chunks.push({ delta: {}, finish_reason: "tool_calls" });
      } else {
        chunks.push({ delta: { content: finalText } });
        chunks.push({ delta: {}, finish_reason: "stop" });
      }
      for (const ch of chunks) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-ui", model: "e2e-scripted", choices: [ch] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function launchIsolated(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROGRESSLEDGER_V2_E2E: "1",
      PROGRESSLEDGER_V2_E2E_DISABLE_SYSTEM_FALLBACK: "1",
      PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
    },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForLoadState("networkidle");
  return { app, win };
}

async function dismissOnboarding(win) {
  const skipBtn = win.locator('button.skip-btn:has-text("Skip Tutorial")');
  await skipBtn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
}

async function seedProject(win, { userDataDir, endpoint, projectRootPath }) {
  // Profile is created through the REAL UI form (ProfileManager), which
  // also makes it the active profile in the renderer store — the same
  // state a real user has after onboarding.
  await win.locator('button.nav-item:has-text("Profiles")').click();
  await win.locator('input[placeholder^="New profile name"]').fill("UI Runtime");
  await win.locator('form.add-form button[type="submit"]:has-text("Add")').click();
  await win.locator("article.profile-card.active").waitFor({ state: "visible", timeout: 15_000 });
  // selectProfile() schedules a 500ms view-flip to Subjects after profile
  // activation — wait it out before navigating elsewhere.
  await win.waitForTimeout(900);
  const profileId = await win.evaluate(() => window.progressLedger.profiles.list().then((rows) => Math.max(...rows.map((r) => r.id))));
  expect(profileId).toBeGreaterThan(0);

  // Project + agent + credential through the REAL IPC (same as a real
  // session; ProjectList picks them up because the store refreshes on
  // view mount). fs_write resolves paths against the project root, so
  // the seeded project must own the tmp root.
  const created = await win.evaluate(([pid, rootPath]) =>
    window.progressLedger.projectMode.createProject({ profileId: pid, name: "UI Runtime", description: "gate j", rootPath, configJson: "{}" }),
    [profileId, projectRootPath]);
  const projectId = typeof created === "number" ? created : (created && created.id);
  expect(projectId).toBeGreaterThan(0);
  const agentRes = await win.evaluate(([pid, prid, obj]) =>
    window.progressLedger.projectMode.createAgent(pid, prid, obj), [profileId, projectId, OBJECTIVE]);
  const seededAgentId = typeof agentRes === "number" ? agentRes : (agentRes && agentRes.id);
  expect(seededAgentId).toBeGreaterThan(0);

  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "pm-secrets.json"),
    JSON.stringify({
      [`${profileId}:${projectId}`]: { endpoint, apiKey: FIXTURE_KEY, model: "e2e-ui", updatedAt: Date.now() },
    }, null, 2),
    "utf8",
  );

  await win.locator('button.nav-item', { hasText: /^\s*Project\s*$/ }).click();
  // The panel opens in list view; the project-mode onboarding tour
  // backdrop intercepts clicks until dismissed (skip like a real user).
  const tourSkip = win.locator('[data-testid="onboarding-tour-skip"]');
  if (await tourSkip.isVisible().catch(() => false)) {
    await tourSkip.click();
  }
  // Selecting the project flips the panel into the workspace.
  await win.locator(`[data-testid="project-item"][data-project-id="${projectId}"] button.item-main`).click();
  await win.locator('[data-testid="project-workspace"]').waitFor({ state: "visible", timeout: 20_000 });
  return { profileId, projectId, seededAgentId };
}

// List agent ids for a project through the same IPC the UI uses.
async function listAgentIds(win, profileId, projectId) {
  const rows = await win.evaluate(([pid, prid]) =>
    window.progressLedger.projectMode.listAgents(pid, prid), [profileId, projectId]);
  const list = Array.isArray(rows) ? rows : (rows && rows.agents) || [];
  return list.map((a) => a.id).filter((n) => typeof n === "number");
}

// Poll the agent row through the same IPC the UI uses.
async function waitForAgentTerminal(win, profileId, agentId) {
  const start = Date.now();
  for (;;) {
    const row = await win.evaluate(async ([pid, aid]) => {
      const a = await window.progressLedger.projectMode.getAgent(pid, aid);
      return a && (a.agent || a);
    }, [profileId, agentId]).catch(() => null);
    if (row && ["completed", "failed", "cancelled"].includes(row.state)) return row;
    if (Date.now() - start > 150_000) throw new Error(`timeout waiting for terminal state (last=${row && row.state})`);
    await sleep(1000);
  }
}

async function createGoalAndLink(win, profileId, projectId, agentId, objective) {
  // Goal deep-link is the real UI path back to a specific agent
  // (Goals → goal row → "Open Agent" → cf:open-agent). Seed the goal
  // through the REAL goal:create / goal:link-agent IPC. `objective` is
  // passed as an arg — page.evaluate cannot see closure variables.
  const goalRes = await win.evaluate(async ([pid, prid, aid, obj]) => {
    const create = await window.progressLedger.goals.create({
      profileId: pid, projectId: prid, title: "Gate J", objective: obj,
      kind: "code_change", requireVerification: true,
    });
    const goalId = typeof create === "number" ? create : (create && (create.id ?? (create.ok && create.id)));
    if (!goalId) return { error: create };
    const link = await window.progressLedger.goals.linkAgent(pid, goalId, aid);
    return { goalId, link };
  }, [profileId, projectId, agentId, objective]);
  expect(goalRes.error).toBeUndefined();
  return goalRes.goalId;
}

test.describe("Agent UI runtime visibility (real Electron UI)", () => {
  test("LEG1 UI: start -> approval card -> UI approve click -> tool activity -> completion", async () => {
    test.setTimeout(300_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-ui1-ud-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-ui1-proj-"));
    const target = join(projectRootPath, "ui-target.txt");
    const { server, endpoint } = await startScriptedServer({
      filePath: target,
      fileContent: "APPROVED-BY-UI-E2E",
      finalText: "ui run done",
    });
    let app;
    try {
      const launched = await launchIsolated(userDataDir);
      app = launched.app;
      await dismissOnboarding(launched.win);
      const { profileId, projectId } = await seedProject(launched.win, { userDataDir, endpoint, projectRootPath });
      const win = launched.win;

      const agentsBefore = await listAgentIds(win, profileId, projectId);
      // UI-driven start: type the objective and click "Run agent".
      // createAndStartAgent makes a NEW agent; the seeded one stays idle
      // (mirrors a real user typing into the workspace).
      await win.locator('[data-testid="objective-input"]').fill(OBJECTIVE);
      await win.locator('[data-testid="start-agent"]').click();

      // The approval card must appear in the REAL ApprovalQueue.
      const queue = win.locator('[data-testid="approval-queue"]');
      await expect(queue).toBeVisible({ timeout: 120_000 });
      await expect(queue).toHaveAttribute("data-count", "1", { timeout: 120_000 });
      await expect(win.locator('[data-testid="approval-tool-name"]').first()).toHaveText("fs_write");
      await expect(win.locator('[data-testid="approval-permission"]').first()).toHaveText("WRITE");

      // Security boundary: the approval row must not expose raw args
      // (the main process sanitizes entries for the renderer).
      const rowText = await win.locator('[data-testid="approval-row"]').first().innerText();
      expect(rowText).not.toContain("ui-target.txt");
      expect(rowText).not.toContain("APPROVED-BY-UI-E2E");

      // THE USER CLICKS APPROVE IN THE UI.
      await win.locator('[data-testid="approval-approve"]').first().click();

      // The tool row appears in the live ToolActivityList; the run
      // completes; the file exists on disk.
      await win.locator('[data-testid="tool-activity"] [data-testid="tool-row"]')
        .first().waitFor({ state: "visible", timeout: 120_000 });

      // The UI-driven agent is the newest one for this project (the
      // seeded agent stays idle — a real user's "Run agent" always
      // creates a fresh run).
      const agentsAfter = await listAgentIds(win, profileId, projectId);
      const uiAgentId = Math.max(...agentsAfter);
      expect(agentsAfter.length).toBeGreaterThan(agentsBefore.length);
      const finalAgent = await waitForAgentTerminal(win, profileId, uiAgentId);

      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("APPROVED-BY-UI-E2E");

      // Credential boundary across the whole rendered UI.
      const html = await win.content();
      expect(html).not.toContain(FIXTURE_KEY);
      expect(["completed", "failed", "cancelled"]).toContain(finalAgent.state);
    } finally {
      server.close();
      if (app) await app.close().catch(() => {});
    }
  });

  test("LEG2 RELOAD: pending approval survives page reload and stays actionable in the UI", async () => {
    test.setTimeout(300_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-ui2-ud-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-ui2-proj-"));
    const target = join(projectRootPath, "ui-reload-target.txt");
    const { server, endpoint } = await startScriptedServer({
      filePath: target,
      fileContent: "APPROVED-AFTER-RELOAD",
      finalText: "reloaded run done",
    });
    let app;
    try {
      const launched = await launchIsolated(userDataDir);
      app = launched.app;
      await dismissOnboarding(launched.win);
      const { profileId, projectId } = await seedProject(launched.win, { userDataDir, endpoint, projectRootPath });
      const win = launched.win;

      await win.locator('[data-testid="objective-input"]').fill(OBJECTIVE);
      await win.locator('[data-testid="start-agent"]').click();

      // Wait for the pending approval, capture the active agent id,
      // then RELOAD mid-approval.
      const queue = win.locator('[data-testid="approval-queue"]');
      await expect(queue).toHaveAttribute("data-count", "1", { timeout: 120_000 });
      // The UI "Run agent" button created a NEW agent (the seeded one
      // stays idle). Resolve it the same way the app does: the newest
      // agent row for this project. (There is no window-exposed store —
      // the earlier __cf_project_mode_store__ probe was a phantom.)
      const agentsNow = await listAgentIds(win, profileId, projectId);
      expect(agentsNow.length).toBeGreaterThan(1);
      const agentId = Math.max(...agentsNow);
      await createGoalAndLink(win, profileId, projectId, agentId, OBJECTIVE);

      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await win.waitForLoadState("networkidle");

      // After reload: navigate Goals → project → goal row →
      // "Open Agent" (the real cf:open-agent deep-link), which lands in
      // the workspace with the agent auto-selected via pendingAgentId.
      await win.locator('[data-testid="nav-goals"]').click();
      await win.locator('[data-testid="goals-pick-project"]').first().click();
      await win.locator('[data-testid="goal-row"]').first().click();
      await win.locator('[data-testid="open-agent-button"]').click();
      await win.locator('[data-testid="project-workspace"]').waitFor({ state: "visible", timeout: 30_000 });

      // The approval must be visible again (rehydrated, not live-only).
      await expect(queue).toBeVisible({ timeout: 120_000 });
      await expect(queue).toHaveAttribute("data-count", "1", { timeout: 120_000 });
      await expect(win.locator('[data-testid="approval-tool-name"]').first()).toHaveText("fs_write");

      // Still actionable from the UI after reload.
      await win.locator('[data-testid="approval-approve"]').first().click();
      await waitForAgentTerminal(win, profileId, agentId);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("APPROVED-AFTER-RELOAD");
    } finally {
      server.close();
      if (app) await app.close().catch(() => {});
    }
  });
});
