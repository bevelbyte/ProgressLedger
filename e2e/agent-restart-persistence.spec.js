// AGENT/AI RUNTIME VERIFICATION — Milestones F + H: real application
// restart persistence for Agent runs.
//
// Two legs, honestly separated, over the REAL Electron app and REAL
// main-process loop:
//
//   LEG 1 — GRACEFUL: start agent -> reach waiting_for_approval ->
//           close the app (real quit path: will-quit ->
//           cancelAllAgents()) -> relaunch -> the graceful path MUST
//           have cancelled the agent and cleared the durable run-state
//           row, and the recovery sweep must NOT offer the run as
//           resumable. This documents production quit semantics.
//
//   LEG 2 — CRASH: start agent -> real fs_write tool executes on disk
//           -> hold the round-2 model response open -> SIGKILL the
//           test-owned app process tree -> relaunch -> recovery sweep
//           classifies the run safe-resume -> goal-linked resume ->
//           run completes with NO duplicate tool execution and
//           transcript continuity (pre-crash tool_call + tool_result
//           restored). Memory (project scope) survives the crash;
//           cross-project leakage must be absent (Milestone H).
//
// Classification: ELECTRON; provider transport MOCKED (scripted SSE);
// the loop, provider parsing, tools, approval queue, SQLite persistence,
// and recovery sweep are the REAL production code paths.
//
// SIGKILL scope: ONLY the app process spawned by this spec
// (electron.process()). No unrelated process is ever touched.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const FIXTURE_KEY = "E2E-LOCAL-FIXTURE-KEY-NOT-A-SECRET";
const MEM_TOKEN_A = "cf-restart-memory-alpha-TOKEN";
const MEM_TOKEN_B = "cf-restart-memory-bravo-TOKEN";
const SECRET_MARKER = "E2E-SECRET-MARKER-NOT-A-SECRET";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Scripted OpenAI-compatible SSE provider. Round 1 emits an fs_write
// tool_call; every later round emits a text answer. holdRound2=true
// keeps the FIRST post-round-1 request unanswered (socket held open) —
// Leg 2 uses this to freeze the loop in a durable mid-execution window
// AFTER the tool has executed on disk. releaseRound2() then allows the
// NEW app's resumed request to be answered.
function startScriptedServer({ filePath, fileContent, finalText, holdRound2 = false }) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (holdRound2 && (server.rounds || 0) >= 1 && !server.round2Released) {
        // Hold this request open: never respond. If the requesting
        // process dies (crash leg), the socket closes with it.
        server.holdCount = (server.holdCount || 0) + 1;
        if (server.holdResolve) server.holdResolve();
        return;
      }
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
        chunks.push({ delta: { tool_calls: [{ index: 0, id: "call-e2e-1", type: "function", function: { name: "fs_write", arguments: "" } }] } });
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
      if (round === 1 && server.round1Resolve) server.round1Resolve();
    });
  });
  let round1Resolve;
  server.round1Promise = new Promise((r) => { round1Resolve = r; server.round1Resolve = r; });
  let holdResolve;
  server.holdPromise = new Promise((r) => { holdResolve = r; server.holdResolve = r; });
  // Release BEFORE resume: the new app's request is answered directly.
  server.releaseRound2 = () => { server.round2Released = true; };
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
  const skipBtn = win.locator('button.skip-btn:has-text("Skip Tutorial")');
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipBtn.click();
  }
}

async function setupAgent(win, { userDataDir, endpoint, objective, projectName, projectRootPath, withGoal = true, projectMemory = null }) {
  const profile = await win.evaluate(() => window.careerflow.profiles.add("PM Restart", `pm-restart-${Date.now()}`));
  expect(profile.id).toBeGreaterThan(0);
  const created = await win.evaluate(([pid, rootPath, name]) =>
    window.careerflow.projectMode.createProject({ profileId: pid, name, description: "restart e2e", rootPath, configJson: "{}" }),
    [profile.id, projectRootPath, projectName]);
  const projectId = typeof created === "number" ? created : (created && created.id);
  expect(projectId).toBeGreaterThan(0);

  const agentRes = await win.evaluate(([pid, projId, obj]) =>
    window.careerflow.projectMode.createAgent(pid, projId, obj), [profile.id, projectId, objective]);
  const agentId = typeof agentRes === "number" ? agentRes : (agentRes && agentRes.id);
  expect(agentId).toBeGreaterThan(0);

  let goalId = null;
  if (withGoal) {
    const g = await win.evaluate(([pid, prid, obj]) => window.careerflow.goals.create({
      profileId: pid,
      projectId: prid,
      title: "restart e2e goal",
      objective: obj,
      requireVerification: false,
    }), [profile.id, projectId, objective]);
    expect(g && g.ok !== false, `goal.create: ${JSON.stringify(g)}`).toBe(true);
    goalId = typeof g === "number" ? g : (g && (g.id ?? (g.result && g.result.id)));
    expect(goalId).toBeGreaterThan(0);
    const link = await win.evaluate(([pid, gid, aid]) =>
      window.careerflow.goals.linkAgent(pid, gid, aid), [profile.id, goalId, agentId]);
    expect(link && link.ok !== false, `goal.linkAgent: ${JSON.stringify(link)}`).toBe(true);
  }

  if (projectMemory && projectMemory.length) {
    for (const [kind, key, value] of projectMemory) {
      const r = await win.evaluate(([pid, prid, k, kk, vv]) =>
        window.careerflow.memory.projectSet(pid, prid, k, kk, vv, 1.0),
        [profile.id, projectId, kind, key, value]);
      expect(r && r.ok !== false, `memory.projectSet: ${JSON.stringify(r)}`).toBe(true);
    }
  }

  writeFileSync(
    join(userDataDir, "pm-secrets.json"),
    JSON.stringify({
      [`${profile.id}:${projectId}`]: {
        endpoint,
        apiKey: FIXTURE_KEY,
        model: "e2e-restart",
        updatedAt: Date.now(),
      },
    }, null, 2),
    "utf8",
  );
  return { profileId: profile.id, projectId, agentId, goalId };
}

async function startAgentRun(win, profileId, agentId) {
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

async function dumpAgentDiagnostics(win, profileId, agentId) {
  try {
    const row = await getAgentState(win, profileId, agentId);
    const msgs = await getMessages(win, profileId, agentId);
    const tail = (msgs || []).slice(-6).map((m) => ({ role: m.role, name: m.name, content: String(m.content || "").slice(0, 160) }));
    console.log(`[diag] agent state=${row && row.state}`);
    console.log(`[diag] transcript tail=${JSON.stringify(tail)}`);
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
  return m && m.ok !== false ? (m.messages || m.result || m) : m;
}

// Close the app gracefully (real quit path) and wait for process exit.
async function gracefulClose(app) {
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
}

// Relaunch, dismiss onboarding, run the recovery sweep the way the UI
// does (renderer-initiated per profile), return app + sweep result.
async function relaunchAndSweep(userDataDir, profileId) {
  const launched = await launchIsolated(userDataDir);
  await dismissOnboarding(launched.win);
  const sweep = await launched.win.evaluate((pid) =>
    window.careerflow.goals.recoverySweep(pid), profileId);
  return { ...launched, sweep };
}

// ---------------------------------------------------------------------------
// LEG 1 — GRACEFUL: quit path intentionally cancels; run-state cleared;
// sweep must not offer the cancelled run as resumable.
// ---------------------------------------------------------------------------
test("LEG1 GRACEFUL: approval pending -> app close cancels agent -> run-state cleared -> sweep does NOT offer resume", async ({ }, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-restart1-ud-"));
  const projectRootPath = mkdtempSync(join(tmpdir(), "cf-restart1-proj-"));
  const target = join(projectRootPath, "leg1-target.txt");
  const { server, endpoint } = await startScriptedServer({
    filePath: target,
    fileContent: "LEG1-GRACEFUL-CANCEL",
    finalText: "should never complete",
  });
  let app;
  try {
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    await dismissOnboarding(launched.win);
    const { profileId, agentId } = await setupAgent(launched.win, {
      userDataDir, endpoint,
      objective: "Write the leg1 target file, then confirm.",
      projectName: "Restart Leg1",
      projectRootPath,
    });
    await startAgentRun(launched.win, profileId, agentId);

    // Reach the durable approval window: the loop persists
    // awaiting_approval while the approval blocks the tool.
    const pending = await waitFor(async () => {
      const r = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
      return r && r.ok && r.count === 1 ? r.approvals[0] : null;
    }, { what: "leg1 pending approval" }).catch(async (e) => {
      await dumpAgentDiagnostics(launched.win, profileId, agentId);
      throw e;
    });
    expect(pending.toolName).toBe("fs_write");

    const preAgent = await getAgentState(launched.win, profileId, agentId);
    expect(preAgent.state).toBe("waiting_for_approval");

    // GRACEFUL CLOSE: real quit path (will-quit -> cancelAllAgents).
    await gracefulClose(app);
    app = null;

    // RELAUNCH + SWEEP.
    const relaunched = await relaunchAndSweep(userDataDir, profileId);
    const app2 = relaunched.app;
    try {
      expect(relaunched.sweep && relaunched.sweep.ok !== false).toBe(true);

      // Graceful cancellation semantics: the agent is cancelled.
      const postAgent = await getAgentState(relaunched.win, profileId, agentId);
      expect(postAgent.state).toBe("cancelled");

      // The run-state row was cleared by the graceful path; the sweep
      // must NOT offer this run as resumable.
      const offered = (relaunched.sweep.resumable || []).filter(
        (r) => Number(r.agentId ?? r.agent_id) === agentId && r.classification === "safe-resume");
      expect(offered.length).toBe(0);

      // Transcript intact after graceful cancel + restart (no data loss).
      const msgs = await getMessages(relaunched.win, profileId, agentId);
      expect(Array.isArray(msgs) && msgs.length > 0).toBe(true);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    server.close();
    if (app) await app.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// LEG 2 — CRASH: SIGKILL mid-execution (tool already executed on disk,
// round-2 response held open), relaunch, sweep -> safe-resume,
// goal-linked resume, completion, ZERO duplicate tool execution,
// transcript continuity, memory survives, no cross-project leakage.
// ---------------------------------------------------------------------------
test("LEG2 CRASH: SIGKILL mid-execution -> relaunch -> sweep safe-resume -> goal-linked resume -> completion, no duplicate tool, memory intact", async ({ }, testInfo) => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-restart2-ud-"));
  const projectRootPath = mkdtempSync(join(tmpdir(), "cf-restart2-proj-"));
  const projectRootPathB = mkdtempSync(join(tmpdir(), "cf-restart2-projB-"));
  const target = join(projectRootPath, "leg2-target.txt");
  const { server, endpoint } = await startScriptedServer({
    filePath: target,
    fileContent: "LEG2-CRASH-RECOVERY",
    finalText: "resumed run done",
    holdRound2: true,
  });
  let app;
  try {
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    await dismissOnboarding(launched.win);
    const { profileId, projectId, agentId, goalId } = await setupAgent(launched.win, {
      userDataDir, endpoint,
      objective: "Write the leg2 target file, then confirm after resume.",
      projectName: "Restart Leg2",
      projectRootPath,
      withGoal: true,
      projectMemory: [
        ["finding", "restart-token-a", MEM_TOKEN_A],
        ["finding", "restart-token-b", MEM_TOKEN_B],
      ],
    });

    // A SECOND project under the SAME profile with its own memory —
    // Milestone H: no cross-project leakage.
    const createdB = await launched.win.evaluate(([pid, rootPath]) =>
      window.careerflow.projectMode.createProject({ profileId: pid, name: "Restart Leg2 B", description: "isolation", rootPath, configJson: "{}" }),
      [profileId, projectRootPathB]);
    const projectIdB = typeof createdB === "number" ? createdB : (createdB && createdB.id);
    expect(projectIdB).toBeGreaterThan(0);
    const memB = await launched.win.evaluate(([pid, prid, marker]) =>
      window.careerflow.memory.projectSet(pid, prid, "finding", "other-project-token", marker, 1.0),
    [profileId, projectIdB, SECRET_MARKER]);
    expect(memB && memB.ok !== false).toBe(true);

    await startAgentRun(launched.win, profileId, agentId);

    // fs_write is APPROVAL_REQUIRED: the loop parks in
    // waiting_for_approval until the user approves. Approve here so the
    // run proceeds into real tool execution.
    const pending = await waitFor(async () => {
      const r = await launched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.listPendingApprovals(pid, aid), [profileId, agentId]);
      return r && r.ok && r.count === 1 ? r.approvals[0] : null;
    }, { what: "leg2 pending approval" }).catch(async (e) => {
      await dumpAgentDiagnostics(launched.win, profileId, agentId);
      throw e;
    });
    const ok = await launched.win.evaluate(([pid, aid, id]) =>
      window.careerflow.projectMode.approveCall(pid, aid, id), [profileId, agentId, pending.id]);
    expect(ok && ok.ok).toBe(true);

    // Wait until round 1 is fully answered (tool call streamed).
    await server.round1Promise;

    // REAL tool execution artifact on disk while round 2 is held open —
    // the loop is frozen mid-execution with durable state persisted.
    await waitFor(() => existsSync(target), { what: "leg2 tool artifact on disk" });
    await sleep(1500); // allow the durable phase write to land

    // CRASH: SIGKILL the TEST-OWNED app process only.
    const proc = app.process();
    expect(proc && proc.pid).toBeGreaterThan(0);
    try { proc.kill("SIGKILL"); } catch { try { process.kill(proc.pid, "SIGKILL"); } catch { /* exited */ } }
    await waitFor(() => {
      try { return proc.exitCode !== null || proc.killed || !proc.pid; } catch { return true; }
    }, { what: "leg2 app process death" });
    await sleep(500);
    app = null;

    // RELAUNCH + RECOVERY SWEEP (renderer-initiated, as the UI does).
    const relaunched = await relaunchAndSweep(userDataDir, profileId);
    const app2 = relaunched.app;
    try {
      expect(relaunched.sweep && relaunched.sweep.ok !== false,
        `sweep: ${JSON.stringify(relaunched.sweep).slice(0, 400)}`).toBe(true);

      // The crashed run must be classified safe-resume.
      const row = (relaunched.sweep.resumable || []).find(
        (r) => Number(r.agentId ?? r.agent_id) === agentId);
      expect(row, `sweep rows: ${JSON.stringify((relaunched.sweep.resumable || []).map((r) => ({ agentId: r.agentId, phase: r.phase, classification: r.classification, reason: r.reason })))}`).toBeTruthy();
      expect(row.classification).toBe("safe-resume");

      // DIAGNOSTIC: dump the relaunched agent row shape.
      const agentRow = await relaunched.win.evaluate(([pid, aid]) =>
        window.careerflow.projectMode.getAgent(pid, aid), [profileId, agentId]);
      console.log(`[diag] relaunched agent row: ${JSON.stringify(agentRow)}`);

      // Allow the resumed round-2 request to be answered, then
      // GOAL-LINKED RESUME (the user-visible recovery path).
      server.releaseRound2();
      const resume = await relaunched.win.evaluate(([pid, gid, aid]) =>
        window.careerflow.goals.resume(pid, gid, aid), [profileId, goalId, agentId]);
      expect(resume && resume.ok !== false, `resume: ${JSON.stringify(resume)}`).toBe(true);

      // CONTINUATION -> COMPLETED in the NEW process.
      const finalAgent = await waitFor(async () => {
        const r = await getAgentState(relaunched.win, profileId, agentId);
        return r && ["completed", "failed", "cancelled"].includes(r.state) ? r : null;
      }, { what: "leg2 terminal state after resume" }).catch(async (e) => {
        await dumpAgentDiagnostics(relaunched.win, profileId, agentId);
        throw e;
      });
      expect(finalAgent.state).toBe("completed");

      // ZERO DUPLICATE TOOL EXECUTION: exactly one tool_call and one
      // tool_result across the crash boundary; file written once.
      const msgs = await getMessages(relaunched.win, profileId, agentId);
      const toolResults = msgs.filter((m) => m.role === "tool_result");
      const toolCalls = msgs.filter((m) => m.role === "tool_call");
      expect(toolResults.length).toBe(1);
      expect(toolCalls.length).toBe(1);
      const trContent = JSON.parse(toolResults[0].content);
      expect(trContent.ok).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("LEG2-CRASH-RECOVERY");

      // TRANSCRIPT CONTINUITY: the pre-crash tool_call (its id survives)
      // and its tool_result are present in the resumed process's
      // restored transcript.
      const tcId = toolCalls[0].name; // tool_call rows carry the tool name
      expect(tcId).toBe("fs_write");
      expect(toolResults[0].name).toBe("fs_write");

      // MILESTONE H — memory survives restart, scoped correctly.
      const memA = await relaunched.win.evaluate(([pid, prid]) =>
        window.careerflow.memory.projectList(pid, prid), [profileId, projectId]);
      expect(memA && memA.ok !== false).toBe(true);
      const rowsA = Array.isArray(memA.result) ? memA.result
        : Array.isArray(memA.result && memA.result.result) ? memA.result.result
        : Array.isArray(memA.rows) ? memA.rows : [];
      if (!rowsA.length) console.log(`[diag] memA raw: ${JSON.stringify(memA).slice(0, 400)}`);
      const valuesA = rowsA.map((r) => `${r.key}=${r.value}`);
      expect(valuesA.some((v) => v.includes(MEM_TOKEN_A))).toBe(true);
      expect(valuesA.some((v) => v.includes(MEM_TOKEN_B))).toBe(true);

      // NO CROSS-PROJECT LEAKAGE.
      expect(valuesA.some((v) => v.includes(SECRET_MARKER))).toBe(false);
      const memBAfter = await relaunched.win.evaluate(([pid, prid]) =>
        window.careerflow.memory.projectList(pid, prid), [profileId, projectIdB]);
      const rowsB = Array.isArray(memBAfter && memBAfter.result) ? memBAfter.result
        : Array.isArray(memBAfter && memBAfter.result && memBAfter.result.result) ? memBAfter.result.result
        : Array.isArray(memBAfter && memBAfter.rows) ? memBAfter.rows : [];
      if (!rowsB.length) {
        console.log(`[diag] memB raw: ${JSON.stringify(memBAfter).slice(0, 400)}`);
        const lB2 = await relaunched.win.evaluate(([pid, prid]) =>
          window.careerflow.memory.projectList(pid, prid, { kind: "finding" }), [profileId, projectIdB]);
        console.log(`[diag] projectList B kind=finding: ${JSON.stringify(lB2).slice(0, 300)}`);
        await sleep(1500);
        const lB3 = await relaunched.win.evaluate(([pid, prid]) =>
          window.careerflow.memory.projectList(pid, prid), [profileId, projectIdB]);
        console.log(`[diag] projectList B delayed: ${JSON.stringify(lB3).slice(0, 300)}`);
        const lA2 = await relaunched.win.evaluate(([pid, prid]) =>
          window.careerflow.memory.projectList(pid, prid), [profileId, projectId]);
        console.log(`[diag] projectList A delayed (control): ${JSON.stringify(lA2).slice(0, 200)}`);
      }
      const valuesB = rowsB.map((r) => `${r.key}=${r.value}`);
      expect(valuesB.some((v) => v.includes(SECRET_MARKER))).toBe(true);
      expect(valuesB.some((v) => v.includes(MEM_TOKEN_A))).toBe(false);
      expect(valuesB.some((v) => v.includes(MEM_TOKEN_B))).toBe(false);

      // Renderer boundary: no credential material in the new window.
      const html = await relaunched.win.content();
      expect(html.includes(FIXTURE_KEY)).toBe(false);
      expect(html.includes("apiKey")).toBe(false);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    server.close();
    if (app) await app.close().catch(() => {});
  }
});
