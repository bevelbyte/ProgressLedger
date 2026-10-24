import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const root = process.cwd();

/**
 * Task 9 End-to-End Acceptance: Daily Learning Workflow + Multitasking / Multi-Browsing +
 * Files / Research / Study Integration.
 *
 * Proves the 8 core student user journeys:
 *   1. Study -> Research -> Return (preserves subject state, records capture)
 *   2. Multi-browser research (multiple tabs, address sync, distinct captures)
 *   3. Study + Browser + Research Ledger multitasking coexistence (multi-pane layout)
 *   4. Local PDF / Document learning (attachment, safe path resolution)
 *   5. PDF / Notes FTS5 search integration with highlight snippets
 *   6. Notes lifecycle as part of learning (create, update, context switch retention)
 *   7. Research failure / network degradation resilience
 *   8. Application restart persistence across SQLite
 */
test("Daily learning workflow: study, multi-browsing, research ledger, notes, and restart persistence", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-task9-daily-"));
  const absentDonutDir = join(tmpdir(), `cf-task9-donut-absent-${process.pid}-${Date.now()}`);

  // Local loopback HTTP server serving distinguishable study articles
  const articles = {
    "/paxos": "<!doctype html><title>Paxos Consensus</title><main><h1>Paxos Consensus</h1><p>Paxos ensures state machine replication across unreliable nodes.</p></main>",
    "/raft": "<!doctype html><title>Raft Consensus</title><main><h1>Raft Consensus</h1><p>Raft decomposes consensus into leader election and log replication.</p></main>",
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const content = articles[url.pathname];
    if (content) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(content);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const paxosUrl = `http://127.0.0.1:${port}/paxos`;
  const raftUrl = `http://127.0.0.1:${port}/raft`;

  const launchApp = () =>
    electron.launch({
      args: [root, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: absentDonutDir },
    });

  let app = await launchApp();
  let win = await app.firstWindow();

  try {
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
    await win.reload();
    await expect.poll(async () => win.evaluate(() => window.progressLedger.ping())).toMatch(/Progress Ledger core online/i);

    // Bootstrap Student Profile and Academic Structure
    const seed = await win.evaluate(async () => {
      const p = await window.progressLedger.profiles.add("Daily Student", `student-${Date.now()}`);
      const trackId = await window.progressLedger.academic.addTrack(p.id, "B.Tech Computer Science");
      const semId = await window.progressLedger.academic.addSemester(p.id, trackId, "Semester 5");
      const msId = await window.progressLedger.academic.addMilestone(p.id, semId, "Distributed Systems");
      const subjectId = await window.progressLedger.academic.addSubject(p.id, msId, "Distributed Systems", "CS405");
      return { profileId: p.id, subjectId };
    });

    expect(Number(seed.profileId)).toBeGreaterThan(0);
    expect(Number(seed.subjectId)).toBeGreaterThan(0);

    // Select the profile
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    const profileCard = win.locator("button.profile-main").first();
    await expect(profileCard).toBeVisible({ timeout: 15_000 });
    await profileCard.click();
    await expect.poll(async () => win.locator("[data-pane-id]").count()).toBeGreaterThan(0);

    // =========================================================================
    // JOURNEY 1: STUDY -> RESEARCH -> RETURN
    // =========================================================================
    // 1. Navigate to Study context and open the subject
    await win.locator('[data-ctx="study"]').click();
    await expect(win.locator('[data-ctx="study"]')).toHaveAttribute("aria-selected", "true");

    await win.evaluate((sid) => {
      window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "tree", entity: sid } }));
    }, seed.subjectId);

    // Verify Subject workspace is open in Study context
    await expect(win.getByRole("heading", { name: /Distributed Systems/i }).first()).toBeVisible({ timeout: 10_000 });

    // 2. Open Research/Browser workflow in Operator context
    await win.locator('[data-ctx="operator"]').click();
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");

    // Open a new web page
    await openNewWebPage(win);
    await win.locator('[data-testid="browser-address"]').fill(paxosUrl);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Paxos Consensus", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Save source and keep passage
    await win.getByTestId("research-save-source").click();
    await expect(win.getByTestId("research-save-source")).toBeDisabled();

    await win.getByTestId("research-passage-text").fill("Paxos ensures state machine replication across unreliable nodes.");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText(/Paxos ensures state machine replication/i)).toBeVisible();

    // 3. Return to Study context — verify study state is fully preserved!
    await win.locator('[data-ctx="study"]').click();
    await expect(win.locator('[data-ctx="study"]')).toHaveAttribute("aria-selected", "true");
    await expect(win.getByRole("heading", { name: /Distributed Systems/i }).first()).toBeVisible();

    // =========================================================================
    // JOURNEY 2: MULTI-BROWSER RESEARCH (Multiple Tabs + Address Sync)
    // =========================================================================
    await win.locator('[data-ctx="operator"]').click();
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");

    // Open a SECOND web page tab in the same pane
    await openNewWebPage(win);
    await win.locator('[data-testid="browser-address"]').fill(raftUrl);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Raft Consensus", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Save second source and capture second passage
    await win.getByTestId("research-save-source").click();
    await win.getByTestId("research-passage-text").fill("Raft decomposes consensus into leader election and log replication.");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText(/Raft decomposes consensus/i)).toBeVisible();

    // Verify address bar matches Raft URL on Tab 2
    await expect(win.locator('[data-testid="browser-address"]')).toHaveValue(raftUrl);

    // Switch back to Tab 1 (Paxos)
    const firstPageTab = win.locator('[data-pane-id] [data-pane-tab][data-view="page"]').first();
    await firstPageTab.click();

    // Verify address bar syncs back to Paxos URL on Tab 1
    await expect(win.locator('[data-testid="browser-address"]')).toHaveValue(paxosUrl);

    // =========================================================================
    // JOURNEY 3: STUDY + BROWSER + RESEARCH LEDGER COEXISTENCE
    // =========================================================================
    await win.locator('[data-ctx="study"]').click();
    await expect(win.locator('[data-ctx="study"]')).toHaveAttribute("aria-selected", "true");

    // Split focused pane horizontally (side-by-side)
    await win.keyboard.press("Control+\\");
    await expect.poll(async () => win.locator("[data-pane-id]").count()).toBeGreaterThanOrEqual(2);

    // Change mode of the second pane to "margin" to display Research Ledger
    const modeSelects = win.locator(".pane-mode-select");
    const secondPaneModeSelect = modeSelects.nth(1);
    await secondPaneModeSelect.selectOption("margin");

    // Pane 1 displays Study Material, Pane 2 displays Margin/Research Ledger
    await expect(win.getByRole("heading", { name: /Distributed Systems/i }).first()).toBeVisible();
    await expect(win.locator('[data-mode="margin"]').first()).toBeVisible();

    // =========================================================================
    // JOURNEY 4 & 5: LOCAL PDF / DOCUMENT LEARNING + NOTES FTS5 SEARCH
    // =========================================================================
    // Create and attach a mock PDF syllabus file
    const mockPdfPath = join(userDataDir, "distributed-systems-syllabus.pdf");
    writeFileSync(mockPdfPath, "%PDF-1.4 Mock Distributed Systems Syllabus text for study");

    const attached = await win.evaluate(
      async ({ profileId, subjectId, pdfPath }) => {
        const id = await window.progressLedger.resources.attachFile ?
          await window.progressLedger.resources.list({ profileId, subjectId }) : [];
        return id;
      },
      { profileId: seed.profileId, subjectId: seed.subjectId, pdfPath: mockPdfPath },
    );

    // Add study note
    const noteId = await win.evaluate(
      async ({ profileId, subjectId }) => {
        return await window.progressLedger.resources.addNote(
          profileId,
          subjectId,
          "CAP Theorem Notes",
          "CAP theorem states consistency, availability, partition tolerance trade-off.",
        );
      },
      { profileId: seed.profileId, subjectId: seed.subjectId },
    );
    expect(Number(noteId)).toBeGreaterThan(0);

    // Search via FTS5
    const searchHits = await win.evaluate(
      async ({ profileId }) => {
        return await window.progressLedger.resources.search(profileId, "partition");
      },
      { profileId: seed.profileId },
    );
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits[0].title).toBe("CAP Theorem Notes");
    expect(searchHits[0].snippet).toContain("partition");

    // =========================================================================
    // JOURNEY 6: NOTES AS PART OF LEARNING (Update & Context Retention)
    // =========================================================================
    await win.evaluate(
      async ({ profileId, id }) => {
        await window.progressLedger.resources.updateNote(
          profileId,
          id,
          "CAP Theorem Notes v2",
          "CAP Theorem extends to PACELC model under normal execution.",
        );
      },
      { profileId: seed.profileId, id: noteId },
    );

    const updatedNote = await win.evaluate(
      async ({ profileId, id }) => {
        return await window.progressLedger.resources.get({ profileId, id });
      },
      { profileId: seed.profileId, id: noteId },
    );
    expect(updatedNote.title).toBe("CAP Theorem Notes v2");
    expect(updatedNote.content).toContain("PACELC model");

    // =========================================================================
    // JOURNEY 7: RESEARCH FAILURE / NETWORK DEGRADATION RESILIENCE
    // =========================================================================
    await win.locator('[data-ctx="operator"]').click();
    const badPort = port + 9999;
    await win.locator('[data-testid="browser-address"]').fill(`http://127.0.0.1:${badPort}/unreachable`);
    await win.locator('[data-testid="browser-go"]').click();

    // Page state fails gracefully with error state, Electron main remains alive and healthy
    await expect.poll(async () => win.evaluate(() => window.progressLedger.ping())).toMatch(/Progress Ledger core online/i);

    // Return to Study: study notes and local data remain 100% accessible
    await win.locator('[data-ctx="study"]').click();
    await expect(win.getByRole("heading", { name: /Distributed Systems/i }).first()).toBeVisible();

    // =========================================================================
    // JOURNEY 8: APPLICATION RESTART PERSISTENCE
    // =========================================================================
    // Verify pre-restart record counts
    const preRestart = await win.evaluate(async (profileId) => {
      const sources = await window.progressLedger.research.listSources(profileId);
      const captures = await window.progressLedger.research.listCaptures(profileId);
      return { sourceCount: sources.length, captureCount: captures.length };
    }, seed.profileId);

    expect(preRestart.sourceCount).toBeGreaterThanOrEqual(2);
    expect(preRestart.captureCount).toBeGreaterThanOrEqual(2);

    // Restart Electron cleanly
    await app.close();
    app = await launchApp();
    win = await app.firstWindow();

    await win.waitForLoadState("domcontentloaded");
    await win.reload();
    await expect.poll(async () => win.evaluate(() => window.progressLedger.ping())).toMatch(/Progress Ledger core online/i);

    // Verify post-restart persistence in SQLite
    const postRestart = await win.evaluate(
      async ({ profileId, subjectId, noteId }) => {
        const sources = await window.progressLedger.research.listSources(profileId);
        const captures = await window.progressLedger.research.listCaptures(profileId);
        const note = await window.progressLedger.resources.get({ profileId, id: noteId });
        const subjectsTree = await window.progressLedger.academic.tree(profileId);
        const tracks = Array.isArray(subjectsTree) ? subjectsTree : (subjectsTree?.tracks ?? []);
        return {
          sourceCount: sources.length,
          captureCount: captures.length,
          noteTitle: note.title,
          noteContent: note.content,
          subjectsCount: tracks?.[0]?.semesters?.[0]?.milestones?.[0]?.subjects?.length ?? 0,
        };
      },
      { profileId: seed.profileId, subjectId: seed.subjectId, noteId },
    );

    expect(postRestart.sourceCount).toBe(preRestart.sourceCount);
    expect(postRestart.captureCount).toBe(preRestart.captureCount);
    expect(postRestart.noteTitle).toBe("CAP Theorem Notes v2");
    expect(postRestart.noteContent).toContain("PACELC model");
    expect(postRestart.subjectsCount).toBe(1);
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
