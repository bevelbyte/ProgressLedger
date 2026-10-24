// Goal Mode E2E through the real Electron app (Phase 16).
//
// Drives the REAL Electron app, REAL main-process goal engine, REAL
// SQLite persistence, REAL IPC surface — with the built-in mock
// provider (no network, no credentials) so the run is deterministic.
//
// Validates the user-visible Goal Mode journey:
//   create profile -> create project -> create goal (Goals IPC)
//   -> start goal (engine creates the linked agent) -> poll persisted
//   goal state -> agent reaches completed -> goal reaches completed
//   -> goal result persists -> detail data available via IPC
//   -> cancel path: a second goal is started then cancelled
//
// Every state the renderer can see is read back from the same SQLite
// rows the engine wrote — no fake progress, no mocked IPC.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-goals-e2e-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CAREERFLOW_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

test("Goal Mode lifecycle through the real app: create -> start -> running -> completed", async () => {
  const { app, win } = await launch();
  test.setTimeout(180_000);
  try {
    // 1. Profile + project.
    const profile = await win.evaluate(() => window.careerflow.profiles.add("Goals E2E", `goals-e2e-${Date.now()}`));
    expect(profile.id).toBeGreaterThan(0);
    const projectRootPath = process.cwd();
    const created = await win.evaluate(([pid, rootPath]) =>
      window.careerflow.projectMode.createProject({ profileId: pid, name: "Goals E2E Project", description: "goals e2e", rootPath, configJson: "{}" }), [profile.id, projectRootPath]);
    const projectId = typeof created === "number" ? created : created && created.id;
    expect(projectId).toBeGreaterThan(0);

    // 2. Create a goal through the REAL goals IPC surface.
    const goalRes = await win.evaluate(([pid, projId]) =>
      window.careerflow.goals.create({
        profileId: pid,
        projectId: projId,
        title: "E2E: summarize the workspace",
        objective: "Inspect the workspace and produce a one-paragraph summary.",
        kind: "research",
        requireVerification: false,
      }), [profile.id, projectId]);
    const goalId = typeof goalRes === "number" ? goalRes : goalRes && goalRes.id;
    expect(goalId).toBeGreaterThan(0);

    // 3. Goal is persisted in state 'created'.
    let g = await win.evaluate(([pid, gid]) =>
      window.careerflow.goals.get(pid, gid), [profile.id, goalId]);
    const gRow = g.goal || g;
    expect(gRow.state).toBe("created");
    expect(gRow.linkedAgentId).toBeFalsy();

    // 4. Start the goal. The engine creates + links the agent.
    const startRes = await win.evaluate(([pid, gid]) =>
      window.careerflow.goals.start(pid, gid), [profile.id, goalId]);
    expect(startRes.ok, `goal start: ${JSON.stringify(startRes)}`).toBe(true);

    // 5. Poll the goal through the SAME IPC the renderer polls.
    let finalGoal = null;
    for (let i = 0; i < 120; i++) {
      const gg = await win.evaluate(([pid, gid]) =>
        window.careerflow.goals.get(pid, gid), [profile.id, goalId]);
      const row = gg.goal || gg;
      if (row && (row.state === "completed" || row.state === "failed" || row.state === "cancelled")) {
        finalGoal = row;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(finalGoal).not.toBeNull();
    expect(finalGoal.state).toBe("completed");

    // 6. The goal is linked to the agent that ran.
    const linkedAgentId = finalGoal.linkedAgentId ?? finalGoal.linked_agent_id;
    expect(linkedAgentId).toBeGreaterThan(0);
    const agent = await win.evaluate(([pid, aid]) =>
      window.careerflow.projectMode.getAgent(pid, aid), [profile.id, linkedAgentId]);
    const agentRow = agent.agent || agent;
    expect(agentRow.state).toBe("completed");

    // 7. Timeline events exist (created, agent_linked, state_changed...).
    const events = await win.evaluate(([pid, gid]) =>
      window.careerflow.goals.listEvents(pid, gid, 50), [profile.id, goalId]);
    const evts = events.events || events;
    expect(Array.isArray(evts) && evts.length > 0).toBe(true);
    const eventNames = evts.map((e) => e.event);
    expect(eventNames).toContain("created");
    expect(eventNames).toContain("agent_linked");

    // 8. Goal list via IPC returns the goal in 'completed'.
    const listRes = await win.evaluate((pid) =>
      window.careerflow.goals.list(pid, { state: "completed", limit: 50 }), profile.id);
    const list = listRes.goals || listRes;
    expect(Array.isArray(list) && list.some((x) => x.id === goalId)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Goal Mode cancel path: running goal -> cancel -> cancelled (no resurrection)", async () => {
  const { app, win } = await launch();
  test.setTimeout(120_000);
  try {
    const profile = await win.evaluate(() => window.careerflow.profiles.add("Goals Cancel E2E", `goals-cancel-${Date.now()}`));
    expect(profile.id).toBeGreaterThan(0);
    const projectRootPath = process.cwd();
    const created = await win.evaluate(([pid, rootPath]) =>
      window.careerflow.projectMode.createProject({ profileId: pid, name: "Goals Cancel", description: "cancel e2e", rootPath, configJson: "{}" }), [profile.id, projectRootPath]);
    const projectId = typeof created === "number" ? created : created && created.id;
    expect(projectId).toBeGreaterThan(0);

    const goalRes = await win.evaluate(([pid, projId]) =>
      window.careerflow.goals.create({
        profileId: pid,
        projectId: projId,
        title: "Cancel me",
        objective: "This goal should be cancelled before completion.",
        kind: "research",
        requireVerification: false,
      }), [profile.id, projectId]);
    const goalId = typeof goalRes === "number" ? goalRes : goalRes && goalRes.id;
    expect(goalId).toBeGreaterThan(0);

    const startRes = await win.evaluate(([pid, gid]) =>
      window.careerflow.goals.start(pid, gid), [profile.id, goalId]);
    expect(startRes.ok).toBe(true);

    // Cancel promptly (the mock agent may complete quickly, but the
    // engine is cooperative — cancel wins even mid-run).
    await new Promise((r) => setTimeout(r, 300));
    const cancelRes = await win.evaluate(([pid, gid]) =>
      window.careerflow.goals.cancel(pid, gid), [profile.id, goalId]);
    expect(cancelRes.ok).toBe(true);

    // Poll until terminal; must be 'cancelled', never 'completed'.
    let finalGoal = null;
    for (let i = 0; i < 60; i++) {
      const gg = await win.evaluate(([pid, gid]) =>
        window.careerflow.goals.get(pid, gid), [profile.id, goalId]);
      const row = gg.goal || gg;
      if (row && (row.state === "completed" || row.state === "failed" || row.state === "cancelled")) {
        finalGoal = row;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(finalGoal).not.toBeNull();
    expect(finalGoal.state).toBe("cancelled");
  } finally {
    await app.close();
  }
});
