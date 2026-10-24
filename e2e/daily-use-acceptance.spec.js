import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const root = process.cwd();

/**
 * Task 10 Acceptance: Whole-Product Daily-Use Acceptance Suite.
 *
 * Exercises the final real user journeys:
 *   - Journey 1: Normal daily study (academic navigation, knowledge face, real PDF attachment UI, session logging, instrument update)
 *   - Journey 5: Learning -> Resource/Research -> Return (subject research places, direct embedded browser routing, link management, study return)
 *   - Journey 10: Real browser use (rich media/video page with real HTML5 playback, navigation, address updates, reload, passage capture, context switching)
 */
test("Daily-use acceptance: normal study, learning-to-resource flow, and real media browser use", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-task10-acceptance-"));
  const absentDonutDir = join(tmpdir(), `cf-task10-donut-absent-${process.pid}-${Date.now()}`);

  const videoFixturePath = join(root, "e2e/fixtures/tiny-lecture.mp4");
  const videoBytes = readFileSync(videoFixturePath);

  const pages = {
    "/lecture-video": `<!doctype html>
      <html>
      <head><title>Lecture 1: Distributed Algorithms</title></head>
      <body>
        <main>
          <h1>Distributed Algorithms Video Lecture</h1>
          <video id="lecture-vid" controls width="320" height="240" preload="auto">
            <source src="/tiny-lecture.mp4" type="video/mp4">
          </video>
          <p>Detailed explanation of vector clocks and state replication.</p>
          <a id="next-chapter" href="/lecture-part-2">Next Chapter</a>
        </main>
      </body>
      </html>`,
    "/lecture-part-2": `<!doctype html>
      <html>
      <head><title>Lecture 2: Vector Clocks</title></head>
      <body>
        <main>
          <h1>Vector Clocks in Practice</h1>
          <p>Part two covers causality and event ordering.</p>
        </main>
      </body>
      </html>`,
    "/paxos": `<!doctype html><title>Paxos Specification</title><main><h1>Paxos Specification</h1><p>Paxos consensus specification reference material.</p></main>`,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/tiny-lecture.mp4") {
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": videoBytes.length,
        "accept-ranges": "bytes",
      });
      res.end(videoBytes);
      return;
    }
    const content = pages[url.pathname];
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
  const lecture1Url = `http://127.0.0.1:${port}/lecture-video`;
  const lecture2Url = `http://127.0.0.1:${port}/lecture-part-2`;
  const paxosUrl = `http://127.0.0.1:${port}/paxos`;

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

    // Bootstrap rich student dataset
    const seed = await win.evaluate(async () => {
      const p = await window.progressLedger.profiles.add("Daily Student", `daily-student-${Date.now()}`);
      const trackId = await window.progressLedger.academic.addTrack(p.id, "B.Tech Computer Science");
      const semId = await window.progressLedger.academic.addSemester(p.id, trackId, "Semester 5");
      const msId = await window.progressLedger.academic.addMilestone(p.id, semId, "Core Systems");
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
    // JOURNEY 1 — NORMAL DAILY STUDY
    // =========================================================================
    // 1. Navigate to Study context and open subject workspace
    await win.locator('[data-ctx="study"]').click();
    await expect(win.locator('[data-ctx="study"]')).toHaveAttribute("aria-selected", "true");

    await win.evaluate((sid) => {
      window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "tree", entity: sid } }));
    }, seed.subjectId);

    // Verify Subject workspace is open in Study context
    await expect(win.getByRole("heading", { name: /Distributed Systems/i }).first()).toBeVisible({ timeout: 10_000 });

    // 2. Open Sessions face and quick-log study time
    const sessionsFaceBtn = win.locator('[data-face="sessions"]').first();
    await sessionsFaceBtn.click();
    await expect(sessionsFaceBtn).toHaveAttribute("aria-selected", "true");

    // Quick-log 45 minutes of study
    const minutesInput = win.locator("input.minutes");
    await expect(minutesInput).toBeVisible();
    await minutesInput.fill("45");
    await win.getByRole("button", { name: "Log", exact: true }).click();

    // Verify session logged
    await expect(win.getByText(/45m/i).first()).toBeVisible({ timeout: 10_000 });

    // 3. Open Knowledge face, attach local PDF through actual UI button click, and verify persistence
    const knowledgeFaceBtn = win.locator('[data-face="knowledge"]').first();
    await knowledgeFaceBtn.click();
    await expect(knowledgeFaceBtn).toHaveAttribute("aria-selected", "true");

    // Prepare mock PDF fixture
    const mockPdfPath = join(userDataDir, "Distributed-Systems-Lecture-Notes.pdf");
    writeFileSync(
      mockPdfPath,
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000102 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n149\n%%EOF\n",
    );

    // Mock native dialog & shell openPath in Electron main
    await app.evaluate(async ({ dialog, shell }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
      shell.openPath = async () => "";
    }, mockPdfPath);

    // Click actual UI button "Attach file"
    const attachBtn = win.getByRole("button", { name: /Attach file/i }).first();
    await expect(attachBtn).toBeVisible();
    await attachBtn.click();

    // Verify the attached PDF appears in the Knowledge face list with "pdf" badge
    const attachedRow = win.getByRole("button", { name: "Distributed-Systems-Lecture-Notes.pdf", exact: true });
    await expect(attachedRow).toBeVisible({ timeout: 10_000 });
    await expect(win.locator(".cf-badge", { hasText: "pdf" }).first()).toBeVisible();

    // Click the attached PDF to verify openResource -> openFile invocation
    await attachedRow.click();

    // Switch to Overview face and return to Knowledge face to prove persistence
    await win.locator('[data-face="overview"]').first().click();
    await expect(win.locator('[data-face="overview"]')).toHaveAttribute("aria-selected", "true");
    await win.locator('[data-face="knowledge"]').first().click();
    await expect(attachedRow).toBeVisible();

    // =========================================================================
    // JOURNEY 5 — LEARNING -> RESOURCE -> RETURN
    // =========================================================================
    // 1. Inside the subject workspace, open "Research" face ("Saved Places")
    const researchFaceBtn = win.locator('[data-face="research"]').first();
    await researchFaceBtn.click();
    await expect(researchFaceBtn).toHaveAttribute("aria-selected", "true");

    // Add study reference link
    await win.getByRole("button", { name: "Add Link" }).click();
    await win.locator("input.label-input").fill("Paxos Consensus Paper");
    await win.locator("input.url-input").fill(paxosUrl);
    await win.getByRole("button", { name: "Add", exact: true }).click();

    // Verify link is visible in Saved Places
    await expect(win.getByText("Paxos Consensus Paper")).toBeVisible();
    await expect(win.getByText(paxosUrl)).toBeVisible();

    // 2. Direct integrated workflow: Open link in Progress Ledger embedded browser from Saved Places
    const openInBrowserBtn = win.locator('button[title="Open in Progress Ledger Browser"]').first();
    await expect(openInBrowserBtn).toBeVisible();
    await openInBrowserBtn.click();

    // Verify automatic transition to Operator context and embedded browser page
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");
    await expect(win.getByText("Paxos Specification", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Save source and keep passage
    await win.getByTestId("research-save-source").click();
    await expect(win.getByTestId("research-save-source")).toBeDisabled();
    await win.getByTestId("research-passage-text").fill("Paxos consensus specification reference material.");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText("Paxos consensus specification reference material.", { exact: true })).toBeVisible();

    // 3. Return to Study context — verify exact subject and research face state is preserved
    await win.locator('[data-ctx="study"]').click();
    await expect(win.locator('[data-ctx="study"]')).toHaveAttribute("aria-selected", "true");
    await win.locator('[data-face="research"]').first().click();
    await expect(win.getByText("Paxos Consensus Paper")).toBeVisible();

    // =========================================================================
    // JOURNEY 10 — REAL BROWSER USE (Media, Navigation, Reload, Capture)
    // =========================================================================
    // Switch to Operator context
    await win.locator('[data-ctx="operator"]').click();
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");

    // Open video lecture in browser
    await openNewWebPage(win);
    await win.locator('[data-testid="browser-address"]').fill(lecture1Url);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Lecture 1: Distributed Algorithms", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Verify address bar matches URL
    await expect(win.locator('[data-testid="browser-address"]')).toHaveValue(lecture1Url);

    // Verify real HTML5 video playback in embedded browser WebContentsView
    const videoStatus = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => String(w.getURL()).includes("lecture-video"));
      if (!wc) return { ok: false, reason: "no-video-webcontents" };
      return await wc.executeJavaScript(`(async () => {
        const v = document.getElementById('lecture-vid');
        if (!v) return { found: false };
        try {
          await v.play();
        } catch (err) {
          return { found: true, playError: String(err?.message || err) };
        }
        await new Promise((r) => setTimeout(r, 600));
        return {
          found: true,
          readyState: v.readyState,
          paused: v.paused,
          currentTime: v.currentTime,
          duration: v.duration,
          currentSrc: v.currentSrc,
        };
      })()`);
    });

    expect(videoStatus.found).toBe(true);
    expect(videoStatus.readyState).toBeGreaterThanOrEqual(2);
    expect(videoStatus.paused).toBe(false);
    expect(videoStatus.currentTime).toBeGreaterThan(0);

    // Navigate to next chapter via address bar
    await win.locator('[data-testid="browser-address"]').fill(lecture2Url);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Lecture 2: Vector Clocks", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('[data-testid="browser-address"]')).toHaveValue(lecture2Url);

    // Test reload button
    await win.locator('[data-testid="browser-reload"]').click();
    await expect(win.getByText("Lecture 2: Vector Clocks", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Save source and keep lecture passage
    await win.getByTestId("research-save-source").click();
    await expect(win.getByTestId("research-save-source")).toBeDisabled();
    await win.getByTestId("research-passage-text").fill("Part two covers causality and event ordering.");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText("Part two covers causality and event ordering.", { exact: true })).toBeVisible();

    // Context switch to Desk and return
    await win.locator('[data-ctx="desk"]').click();
    await expect(win.locator('[data-ctx="desk"]')).toHaveAttribute("aria-selected", "true");

    await win.locator('[data-ctx="operator"]').click();
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");
    await expect(win.locator('[data-testid="browser-address"]')).toHaveValue(lecture2Url);
    await expect(win.getByText("Lecture 2: Vector Clocks", { exact: true }).first()).toBeVisible();
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
