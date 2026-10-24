// AGENT/AI RUNTIME VERIFICATION — Milestone E: real approval lifecycle.
//
// Drives the REAL Electron app, REAL main-process agent loop, REAL IPC
// approval queue, REAL fs_write tool execution — with the provider
// network leg replaced by a local scripted SSE server (OpenAI
// wire-compatible). The credential is planted through CareerFlow's OWN
// pm-secrets.json mechanism (fixture value, not a secret), so the
// production provider path (createOpenAiProvider) is what runs.
//
// Classification: ELECTRON runtime; provider transport MOCKED
// (scripted SSE). Never reported as REAL-PROVIDER.
//
// Covered:
//   1. APPROVE:  REQUEST -> PENDING -> (ownership/unknown-id rejections)
//                -> duplicate-start refusal -> APPROVE -> REAL tool
//                execution -> tool result -> agent continuation -> COMPLETED.
//   2. DENY:     REQUEST -> PENDING -> DENY -> tool NEVER executes
//                -> user-rejected tool result -> agent continues -> COMPLETED.
//   Renderer boundary: collected renderer events and the pending
//   approval entry must never contain credential material.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const FIXTURE_KEY = "E2E-LOCAL-FIXTURE-KEY-NOT-A-SECRET";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Scripted OpenAI-compatible SSE server. Round 1 emits an fs_write
// tool_call for the given file; round 2 emits a text answer. The
// provider's SSE accumulator handles fragment reassembly + flush.
function startScriptedServer({ toolName = "fs_write", filePath, fileContent, finalText }) {
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
        chunks.push({ delta: { tool_calls: [{ index: 0, id: "call-e2e-1", type: "function", function: { name: toolName, arguments: "" } }] } });
        chunks.push({ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } });
        chunks.push({ delta: {}, finish_reason: "tool_calls" });
      } else {
        chunks.push({ delta: { content: finalText } });
        chunks.push({ delta: {}, finish_reason: "stop" });
      }
      for (const ch of chunks) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", model: "e2e-scripted", choices: [ch] })}\n\n`);
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
      CAREERFLOW_E2E: "1",
      CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK: "1",
      CAREERFLOW_E2E_USER_DATA: userDataDir,
    },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForLoadState("networkidle");
  return { app, win };
}

async function dismissOnboarding(win) {
  const overlay = win.locator(".onboarding-overlay");
  await overlay.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const skipBtn = win.locator("button.skip-btn:has-text(\"Skip Tutorial\")");
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipBtn.click();
  }
  await overlay.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

// Plant a credential through CareerFlow's OWN store format, then build
// profile + project + agent and start the loop. Returns identifiers.
async function setupAgent(win, { userDataDir, endpoint, objective, projectName, projectRootPath }) {
  const profile = await win.evaluate(() => window.careerflow.profiles.add("PM Approvals", `pm-approval-${Date.now()}`));
  expect(profile.id).toBeGreaterThan(0);
  // projectRootPath must be provided by the test: fs_write's security
  // boundary (assertInsideProjectRoot) resolves every write against the
  // project root registered at loop start, so approval-targeted files
  // MUST live under the registered root.
  const rootPath = projectRootPath || process.cwd();
  const created = await win.evaluate(([pid, rootPath, name]) =>
    window.careerflow.projectMode.createProject({ profileId: pid, name, description: "approval e2e", rootPath, configJson: "{}" }),
    [profile.id, rootPath, projectName]);
  const projectId = typeof created === "number" ? created : (created && created.id);
  expect(projectId).toBeGreaterThan(0);

  const agentRes = await win.evaluate(([pid, projId, obj]) =>
    window.careerflow.projectMode.createAgent(pid, projId, obj), [profile.id, projectId, objective]);
  const agentId = typeof agentRes === "number" ? agentRes : (agentRes && agentRes.id);
  expect(agentId).toBeGreaterThan(0);

  // Credential planted via the real store format (main process reads it
  // fresh on every startAgent — no restart needed). This is the exact
  // mechanism project:set-provider-config writes through.
  writeFileSync(
    join(userDataDir, "pm-secrets.json"),
    JSON.stringify({
      [`${profile.id}:${projectId}`]: {
        endpoint,
        apiKey: FIXTURE_KEY,
        model: "e2e-approval",
        updatedAt: Date.now(),
      },
    }, null, 2),
    "utf8",
  );
  return { profileId: profile.id, projectId, agentId };
}

async function startAgentRun(win, profileId, agentId, events) {
  // Subscribe to the sanitized renderer event stream (Milestone I leg).
  await win.evaluate(() => {
    window.__agentEvents = [];
    window.careerflow.projectMode.onEvent((e) => window.__agentEvents.push(e));
  });
  const startRes = await win.evaluate(([pid, aid]) =>
    window.careerflow.projectMode.startAgent(pid, aid), [profileId, agentId]);
  expect(startRes.ok, `startAgent: ${JSON.stringify(startRes)}`).toBe(true);
  return startRes;
}

async function waitFor(fn, { timeoutMs = 45_000, intervalMs = 200, what = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

// Failure diagnostics: dump the agent row + transcript tail so a
// timeout shows WHY the loop never reached the expected point.
async function dumpAgentDiagnostics(win, profileId, agentId) {
  try {
    const row = await getAgentState(win, profileId, agentId);
    const msgs = await getMessages(win, profileId, agentId);
    const tail = (msgs || []).slice(-6).map((m) => ({ role: m.role, name: m.name, content: String(m.content || "").slice(0, 160) }));
    const evs = await win.evaluate(() => (window.__agentEvents || []).map((e) => e && e.type));
    console.log(`[diag] agent state=${row && row.state} plan=${row && String(row.planJson || row.plan_json || "").slice(0, 200)}`);
    console.log(`[diag] transcript tail=${JSON.stringify(tail)}`);
    console.log(`[diag] renderer event types=${JSON.stringify(evs)}`);
  } catch (e) {
    console.log(`[diag] diagnostics unavailable: ${e && e.message}`);
  }
}

async function getAgentState(win, profileId, agentId) {
  const a = await win.evaluate(([pid, aid]) =>
    window.careerflow.projectMode.getAgent(pid, aid), [profileId, agentId]);
  return a && (a.agent || a);
}

async function getMessages(win, profileId, agentId) {
  const m = await win.evaluate(([pid, aid]) =>
    window.careerflow.projectMode.listMessages(pid, aid), [profileId, agentId]);
  return m && m.messages ? m.messages : m;
}

test.describe("Agent approval lifecycle (real Electron runtime)", () => {
  test("APPROVE: pending -> ownership rejections -> duplicate refused -> approve -> tool executes -> continuation", async ({ }, testInfo) => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-approve-e2e-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-approve-proj-"));
    const target = join(projectRootPath, "approval-target.txt");
    const { server, endpoint } = await startScriptedServer({
      filePath: target,
      fileContent: "APPROVED-BY-E2E",
      finalText: "approved run done",
    });
    let app;
    try {
      const launched = await launchIsolated(userDataDir);
      app = launched.app;
      await dismissOnboarding(launched.win);
      const { profileId, projectId, agentId } = await setupAgent(launched.win, {
        userDataDir, endpoint,
        objective: "Write the approval target file, then confirm.",
        projectName: "Approve E2E",
        projectRootPath,
      });
      await startAgentRun(launched.win, profileId, agentId);

      // REQUEST -> PENDING: the loop must reach waiting_for_approval and
      // the main-process approval queue must list exactly one entry.
      const pending = await waitFor(async () => {
        const r = await launched.win.evaluate(([pid, aid]) =>
          window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
        return r && r.ok && r.count === 1 ? r.approvals[0] : null;
      }, { what: "pending approval" }).catch(async (e) => {
        await dumpAgentDiagnostics(launched.win, profileId, agentId);
        throw e;
      });
      expect(pending.toolName).toBe("fs_write");
      expect(pending.permission).toBe("WRITE");
      // Security boundary: sanitizeApprovalEntry strips the raw tool
      // input (and the resolver function) from the renderer-visible
      // entry. The renderer learns WHICH tool requests approval — never
      // its raw arguments.
      expect(pending).not.toHaveProperty("input");
      const approvalId = pending.id;

      // Renderer-boundary scan: the pending entry (and everything the
      // renderer has received so far) must not carry credential material.
      const pendingJson = JSON.stringify(pending);
      expect(pendingJson).not.toContain(FIXTURE_KEY);
      expect(pendingJson).not.toContain("apiKey");

      const midState = await getAgentState(launched.win, profileId, agentId);
      expect(midState.state).toBe("waiting_for_approval");

      // ADVERSARIAL — layer 1: an EXISTING, owned, but wrong agent
      // passes assertAgentOwned and must then be rejected by the
      // approval-ownership binding (isApprovalOwned) with exactly
      // "approval-not-owned". This is the precise cross-agent attack.
      const agentB = await launched.win.evaluate(([pid, prid]) =>
        window.careerflow.projectMode.createAgent(pid, prid, "unrelated agent"), [profileId, projectId]);
      const agentBId = typeof agentB === "number" ? agentB : agentB.id;
      expect(agentBId).toBeGreaterThan(0);
      const crossAgent = await launched.win.evaluate(([pid, aidB, id]) =>
        window.careerflow.projectMode.approveCall(pid, aidB, id), [profileId, agentBId, approvalId]);
      expect(crossAgent && crossAgent.error).toBe("approval-not-owned");

      // ADVERSARIAL — layer 2: a NONEXISTENT agent id is rejected earlier
      // by the agent-ownership check (authorization precedence). The
      // security property is the same: the approval is NOT resolved.
      const nonAgent = await launched.win.evaluate(([pid, id]) =>
        window.careerflow.projectMode.approveCall(pid, 999999, id), [profileId, approvalId]);
      expect(nonAgent && nonAgent.ok).toBeFalsy();

      // ADVERSARIAL — unknown approval id under the RIGHT owner.
      const unknownId = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.approveCall(pid, aid, "bogus-approval-id"), [profileId, agentId]);
      expect(unknownId && unknownId.error).toBe("approval-not-found");

      // The queue must have survived every adversarial attempt intact.
      const stillPending = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
      expect(stillPending.count).toBe(1);

      // Duplicate-run refusal while an approval is pending.
      const dup = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.startAgent(pid, aid), [profileId, agentId]);
      expect(dup.ok).toBeFalsy();
      expect(dup.reason).toBe("already-running");

      // APPROVE.
      const ok = await launched.win.evaluate(([pid, aid, id]) =>
        window.careerflow.projectMode.approveCall(pid, aid, id), [profileId, agentId, approvalId]);
      expect(ok && ok.ok).toBe(true);

      // TOOL EXECUTES -> CONTINUATION -> COMPLETED.
      const finalAgent = await waitFor(async () => {
        const row = await getAgentState(launched.win, profileId, agentId);
        return row && ["completed", "failed", "cancelled"].includes(row.state) ? row : null;
      }, { what: "terminal state after approve" });
      expect(finalAgent.state).toBe("completed");

      // REAL tool execution evidence: the file exists on disk with the
      // scripted content, and the transcript has exactly one tool_result
      // with ok:true.
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("APPROVED-BY-E2E");
      const msgs = await getMessages(launched.win, profileId, agentId);
      const roles = msgs.map((m) => m.role);
      expect(roles).toContain("tool_call");
      const toolResults = msgs.filter((m) => m.role === "tool_result");
      expect(toolResults.length).toBe(1);
      const trContent = JSON.parse(toolResults[0].content);
      expect(trContent.ok).toBe(true);
      expect(trContent.result.bytes).toBeGreaterThan(0);
      expect(roles).toContain("assistant");
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("approved run done"))).toBe(true);

      // Milestone I leg: renderer received live sanitized events
      // including approval.required and the tool lifecycle.
      const evs = await launched.win.evaluate(() => window.__agentEvents);
      const types = evs.map((e) => e && e.type);
      expect(types).toContain("agent.approval.required");
      const evJson = JSON.stringify(evs);
      expect(evJson).not.toContain(FIXTURE_KEY);
      expect(evJson).not.toContain("apiKey");
      server.close();
    } finally {
      try { if (app) await app.close(); } catch { /* swallow */ }
      try { server.close(); } catch { /* swallow */ }
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* swallow */ }
      try { rmSync(projectRootPath, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });

  test("DENY: pending -> deny -> tool NEVER executes -> user-rejected result -> agent continues", async ({ }, testInfo) => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-deny-e2e-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-deny-proj-"));
    const target = join(projectRootPath, "deny-target.txt");
    const { server, endpoint } = await startScriptedServer({
      filePath: target,
      fileContent: "MUST-NOT-BE-WRITTEN",
      finalText: "denied run done",
    });
    let app;
    try {
      const launched = await launchIsolated(userDataDir);
      app = launched.app;
      await dismissOnboarding(launched.win);
      const { profileId, agentId } = await setupAgent(launched.win, {
        userDataDir, endpoint,
        objective: "Attempt to write the deny target file.",
        projectName: "Deny E2E",
        projectRootPath,
      });
      await startAgentRun(launched.win, profileId, agentId);

      const pending = await waitFor(async () => {
        const r = await launched.win.evaluate(([pid, aid]) =>
          window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
        return r && r.ok && r.count === 1 ? r.approvals[0] : null;
      }, { what: "pending approval (deny leg)" }).catch(async (e) => {
        await dumpAgentDiagnostics(launched.win, profileId, agentId);
        throw e;
      });

      // DENY.
      const ok = await launched.win.evaluate(([pid, aid, id]) =>
        window.careerflow.projectMode.denyCall(pid, aid, id), [profileId, agentId, pending.id]);
      expect(ok && ok.ok).toBe(true);

      const finalAgent = await waitFor(async () => {
        const row = await getAgentState(launched.win, profileId, agentId);
        return row && ["completed", "failed", "cancelled"].includes(row.state) ? row : null;
      }, { what: "terminal state after deny" });
      expect(finalAgent.state).toBe("completed");

      // The tool NEVER executed: no file on disk, exactly one tool
      // result, and it carries the user-rejected error envelope.
      expect(existsSync(target)).toBe(false);
      const msgs = await getMessages(launched.win, profileId, agentId);
      const toolResults = msgs.filter((m) => m.role === "tool_result");
      expect(toolResults.length).toBe(1);
      const trContent = JSON.parse(toolResults[0].content);
      expect(trContent.ok).toBe(false);
      expect(trContent.error && trContent.error.code).toBe("user-rejected");
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("denied run done"))).toBe(true);

      // Queue is empty after resolution.
      const after = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
      expect(after.count).toBe(0);
      server.close();
    } finally {
      try { if (app) await app.close(); } catch { /* swallow */ }
      try { server.close(); } catch { /* swallow */ }
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* swallow */ }
      try { rmSync(projectRootPath, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });
});
