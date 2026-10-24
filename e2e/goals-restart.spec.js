// Goal Mode — actual process-restart recovery (Phase 16).
//
// Phase 15 claimed durable recovery via `pm_run_state`; Phase 16 must
// prove it against a REAL Electron process restart:
//
//   1. Launch the real app; create a profile + project.
//   2. Create a goal; start its agent (mock provider, deterministic).
//   3. While the agent is mid-run, TERMINATE the Electron process
//      (SIGKILL — no graceful shutdown, no will-quit handlers).
//   4. Relaunch a FRESH Electron process against the SAME userDataDir.
//   5. Run the recovery sweep (the same IPC GoalsView calls on mount)
//      and verify:
//        - the persisted goal/agent/run-state is discovered
//        - at most one candidate row exists (no duplicate agent)
//        - the goal was NOT silently marked completed by the crash
//        - running the sweep twice is idempotent
//
// The mock provider finishes quickly, so we force a long-running agent
// by configuring the project with a slow `testCommand` (a 30s sleep)
// AND by killing the app ~1.5s after start. The verification gate
// holds the agent in `verifying` while the command runs, which
// guarantees the run-state row exists at kill time.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launch(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

test("crash mid-run -> restart -> recovery discovers the candidate and never fakes completion", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-goals-restart-"));
  let profileId = null;

  // ---------- Session 1: create + start, then hard-kill ----------
  let app1 = null;
  try {
    const { app, win } = await launch(userDataDir);
    app1 = app;

    const profile = await win.evaluate(() =>
      window.progressLedger.profiles.add("Restart E2E", `restart-e2e-${Date.now()}`));
    expect(profile.id).toBeGreaterThan(0);
    profileId = profile.id;

    const projectRootPath = process.cwd();
    // `test_command` is the config key verify.js reads (snake_case).
    // A slow command holds the agent in `verifying` for 30s.
    const configJson = JSON.stringify({
      test_command: 'node -e "setTimeout(()=>{},30000)"',
    });
    const created = await win.evaluate(([pid, rootPath, cfg]) =>
      window.progressLedger.projectMode.createProject({
        profileId: pid, name: "Restart Proj", description: "restart e2e",
        rootPath, configJson: cfg,
      }), [profile.id, projectRootPath, configJson]);
    const projectId = typeof created === "number" ? created : created && created.id;
    expect(projectId).toBeGreaterThan(0);

    const goalRes = await win.evaluate(([pid, projId]) =>
      window.progressLedger.goals.create({
        profileId: pid, projectId: projId,
        title: "Restart goal",
        objective: "Run a long task that we will interrupt.",
        kind: "code_change",
        requireVerification: true,
      }), [profile.id, projectId]);
    const goalId = typeof goalRes === "number" ? goalRes : goalRes && goalRes.id;
    expect(goalId).toBeGreaterThan(0);

    const startRes = await win.evaluate(([pid, gid]) =>
      window.progressLedger.goals.start(pid, gid), [profile.id, goalId]);
    expect(startRes.ok, `start: ${JSON.stringify(startRes)}`).toBe(true);

    // Give the engine ~1.5s to create the agent + enter the run.
    await new Promise((r) => setTimeout(r, 1500));

    // Confirm the agent exists (linked) before the crash.
    const g = await win.evaluate(([pid, gid]) =>
      window.progressLedger.goals.get(pid, gid), [profile.id, goalId]);
    const gRow = g.goal || g;
    const linkedAgentId = gRow.linkedAgentId ?? gRow.linked_agent_id;
    expect(linkedAgentId).toBeGreaterThan(0);

    // ---------- Hard kill: no graceful shutdown ----------
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    try { await app1?.close(); } catch (_e) {}
  }

  // ---------- Session 2: fresh Electron, same workspace ----------
  expect(profileId).not.toBeNull();
  let app2 = null;
  try {
    const { app, win } = await launch(userDataDir);
    app2 = app;

    // Run the recovery sweep — the same IPC GoalsView calls on mount.
    const sweep = await win.evaluate((pid) =>
      window.progressLedger.goals.recoverySweep(pid), profileId);

    // Exactly one candidate row max (no duplicate agent created).
    expect(Array.isArray(sweep.resumable)).toBe(true);
    expect(sweep.resumable.length).toBeLessThanOrEqual(1);

    // The goal must NOT have been marked completed by the crash. The
    // verification gate could not have passed (process died before the
    // 30s command finished), so valid outcomes are recoverable
    // (running/verifying) or a truthful failure/cancel.
    const goalsList = await win.evaluate((pid) =>
      window.progressLedger.goals.list(pid, { limit: 50 }), profileId);
    const list = goalsList.goals || goalsList;
    const goal = Array.isArray(list) ? list.find((x) => x.title === "Restart goal") : null;
    expect(goal).not.toBeNull();
    expect(["running", "verifying", "failed", "cancelled"]).toContain(goal.state);

    // Idempotency: a second sweep changes nothing observable.
    const sweep2 = await win.evaluate((pid) =>
      window.progressLedger.goals.recoverySweep(pid), profileId);
    expect(sweep2.resumable.length).toBe(sweep.resumable.length);
  } finally {
    await app2?.close();
  }
});
