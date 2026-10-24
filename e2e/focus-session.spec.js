import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// ---- Focus Session UI-driven lifecycle --------------------------------------
//
// The Focus overlay is a *surface*: it runs a timer against a real subject and
// logs exactly one row through sessions.add(). This spec never touches UI
// source — locators assert UI state, window.progressLedger.* asserts persistence.
//
// The 5-minute recipe: FocusSession.svelte reads Date.now() on start
// (beginTimer) and on finish, and refreshes `nowMs` from a 1s interval. Patching
// Date.now() to 5 minutes in the past BEFORE the session starts yields
// durationMinutes === 5 with ~0 seconds of real waiting. Date.now() is patched
// only — `new Date()` is untouched, so `started_at` is genuinely 5 minutes ago
// on the real local date.
//
// Every Dashboard text assertion is scoped inside .today: the "This Week"
// section renders the same study numbers.

const OFFSET_MS = 5 * 60 * 1000;
const PROFILE = "Focus Student";
const TRACK = "B.Tech";
const SEMESTER = "Semester 1"; // CgpaPlanner's activeSemesterNum defaults to 1
const MILESTONE = "Core";
const SUBJECT = "Data Structures";
const PATH_LABEL = `${TRACK} › ${SEMESTER} › ${MILESTONE}`;

/** "YYYY-MM-DD" in LOCAL time — never toISOString() (UTC is flaky on UTC+0530). */
function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDateShifted(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDate(d);
}

async function launchApp(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // Onboarding bypass BEFORE any locator work — the overlay intercepts clicks.
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });
  return { app, win };
}

/** Unguarded close hangs when the app is mid-operation (phase9 helper). */
async function closeApp(app) {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("close-timeout")), 6000)),
    ]);
  } catch {
    /* swallow */
  }
}

async function seedProfile(win, slugPrefix, subjectName = SUBJECT) {
  return win.evaluate(
    async ({ slugPrefix, subjectName, profile, track, semester, milestone }) => {
      const p = await window.progressLedger.profiles.add(profile, `${slugPrefix}-${Date.now()}`);
      const pid = p.id;
      const trackId = await window.progressLedger.academic.addTrack(pid, track);
      const semId = await window.progressLedger.academic.addSemester(pid, trackId, semester);
      const msId = await window.progressLedger.academic.addMilestone(pid, semId, milestone);
      const subjectId = await window.progressLedger.academic.addSubject(pid, msId, subjectName, null);
      return { pid, subjectId, subjectName };
    },
    { slugPrefix, subjectName, profile: PROFILE, track: TRACK, semester: SEMESTER, milestone: MILESTONE }
  );
}

async function seedBareProfile(win, slugPrefix) {
  return win.evaluate(async ({ slugPrefix, profile }) => {
    const p = await window.progressLedger.profiles.add(profile, `${slugPrefix}-${Date.now()}`);
    return { pid: p.id };
  }, { slugPrefix, profile: PROFILE });
}

/** Reload so the UI profile list picks up the IPC-created profile, activate it, land on the Dashboard. */
async function activateProfile(win, name = PROFILE) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  // aria-label="Select <name>" is exact, unlike a hasText filter (which would also
  // match a longer name sharing the same prefix).
  const card = win.getByRole("button", { name: `Select ${name}`, exact: true });
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.click();
  await win.waitForTimeout(900); // App.selectProfile flips to Subjects after 500ms

  await win.locator(".nav-item", { hasText: "Home" }).click();
  await expect(win.locator(".today")).toBeVisible({ timeout: 20000 });
  return win.locator(".today");
}

const focusModal = (win) => win.locator(".focus-modal");

/** Dashboard "Today" → the Study column. */
const studyColumn = (win) => win.locator(".today .today-col").filter({ hasText: /Study/ });

/** The Study column's "N studied today" read-out (unambiguous CSS path). */
const studyReadout = (win) => win.locator(".today .today-study > div > strong");

async function openFocusFromDashboard(win) {
  await studyColumn(win)
    .locator("button")
    .filter({ hasText: /Start Focus|Start another/ })
    .click();
  await expect(focusModal(win)).toBeVisible({ timeout: 15000 });
  await expect(focusModal(win).getByRole("heading", { level: 2, name: "Focus Session" })).toBeVisible();
}

async function backdateClock(win, offset = OFFSET_MS) {
  await win.evaluate((offsetMs) => {
    const realNow = Date.now;
    window.__realNow = realNow;
    Date.now = () => realNow() - offsetMs;
  }, offset);
}

async function restoreClock(win) {
  await win.evaluate(() => {
    if (typeof window.__realNow === "function") {
      Date.now = window.__realNow;
      delete window.__realNow;
    }
  });
}

/**
 * Read the modal clock, tolerating the 1s interval that refreshes `nowMs`.
 *
 * NOTE on the recipe: a constant backdate of Date.now() cancels inside
 * formatClock(startMs, nowMs) because BOTH reads move together. The offset only
 * bites once `Date.now` is restored and the interval's next tick writes real
 * time into nowMs. Every helper below therefore restores first and then waits
 * for the clock to land on 00:05:0x — that single interval tick is what turns
 * a backdated start into a genuine 5-minute session.
 */
async function waitClock(win, pattern = /^00:05:0\d$/, timeout = 20000) {
  await expect
    .poll(
      async () => (await focusModal(win).locator(".clock").textContent())?.trim(),
      { timeout, intervals: [200, 500] }
    )
    .toMatch(pattern);
}

/** Assert the clock is still counting from a backdated start (offset not yet registered). */
async function assertBackdatedStart(win) {
  await expect(focusModal(win).locator(".clock")).toHaveText(/^00:00:\d\d$/);
}

/** Computed z-indexes of the three fixed overlays (documents the stacking order). */
function stackingOrder(win) {
  return win.evaluate(() => {
    const z = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).zIndex : null;
    };
    return { focusBackdrop: z(".focus-backdrop"), confirmBackdrop: z(".cf-backdrop"), toastStack: z(".toast-stack") };
  });
}

/**
 * Confirm the discard prompt. Only reachable at >= 1 minute elapsed.
 *
 * This uses a REAL click on purpose: the shared confirm dialog used to render at
 * z-index 1100, behind the focus backdrop's 1200, so a real click landed on the
 * backdrop, re-entered discard() and re-opened the prompt while the superseded
 * confirm resolved as "no" — the session could never be ended by a human. The
 * confirm is now above the focus backdrop, and a DOM-level dispatchEvent("click")
 * would bypass hit-testing and hide that class of regression again.
 */
async function dismissDiscardConfirm(win, expectEligible = true) {
  const confirm = win.locator(".cf-modal");
  await expect(confirm).toBeVisible({ timeout: 15000 });
  await expect(confirm.getByRole("heading", { level: 3 })).toHaveText("Discard this session?");
  if (expectEligible) {
    await expect(confirm.getByText(/5m was studied\. Nothing will be logged\./)).toBeVisible();
  }
  // Sample the stacking order while both overlays are in the tree.
  const stacking = await stackingOrder(win);
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(focusModal(win)).toHaveCount(0, { timeout: 15000 });
  return stacking;
}

/** Wait for the chooser's subject picker (renders only once the tree has loaded). */
async function chooseSubject(win, index = 0) {
  const select = focusModal(win).locator('select[aria-label="Study subject"]');
  await expect(select).toBeVisible({ timeout: 20000 });
  await select.selectOption({ index });
  await expect(focusModal(win).locator(".clock")).toBeVisible({ timeout: 15000 });
}

async function readSessions(win, pid) {
  return win.evaluate(async (id) => window.progressLedger.sessions.list(id, 500), pid);
}

async function readStats(win, pid) {
  return win.evaluate(async (id) => window.progressLedger.sessions.stats(id), pid);
}

async function finishSession(win) {
  await restoreClock(win);
  // Wait for the interval tick that turns the backdated start into real elapsed time.
  await waitClock(win);
  await focusModal(win).getByRole("button", { name: "Finish Session" }).click();
  await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });
}

const toast = (win, pattern) => win.locator(".toast-stack .toast").filter({ hasText: pattern });

test.describe("Focus Session — UI-driven lifecycle", () => {
  test("F1/F3 Dashboard Study CTA opens the chooser and creates nothing until a subject is chosen", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-chooser");
      await activateProfile(win);

      const before = await readSessions(win, seed.pid);
      const beforeStats = await readStats(win, seed.pid);
      expect(before.length).toBe(0);
      expect(beforeStats.totalSessions).toBe(0);

      await openFocusFromDashboard(win);

      const m = focusModal(win);
      // Dialog contract.
      await expect(m).toHaveAttribute("role", "dialog");
      await expect(m).toHaveAttribute("aria-modal", "true");
      await expect(m).toHaveAttribute("aria-label", "Focus Session");
      await expect(win.locator(".focus-backdrop")).toBeVisible();

      // Chooser phase: lede + subject picker, and no session chrome.
      await expect(m.locator(".choose-lede")).toBeVisible();
      await expect(m.locator(".choose-lede")).toHaveText(
        "Pick what you're studying. The clock starts when you choose."
      );
      const select = m.locator('select[aria-label="Study subject"]');
      await expect(select).toBeVisible();
      await expect(select.locator("option")).toHaveCount(1);
      await expect(select.locator("option")).toHaveText(`${PATH_LABEL} › ${SUBJECT}`);
      await expect(m.locator(".clock")).toHaveCount(0);
      await expect(m.getByRole("button", { name: "Finish Session" })).toHaveCount(0);

      // Opening the overlay fabricates no session.
      const afterOpen = await readSessions(win, seed.pid);
      const afterStats = await readStats(win, seed.pid);
      expect(afterOpen.length).toBe(0);
      expect(afterStats.totalSessions).toBe(0);
      expect(afterStats.totalMinutes).toBe(0);
      expect(afterStats.minutesToday).toBe(0);
      expect(afterStats.activeDays).toBe(0);

      // The secondary ghost CTA still routes to the existing sessions view.
      await expect(
        studyColumn(win).locator("button").filter({ hasText: "Start a session" })
      ).toBeVisible();

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F1 empty profile: no subjects means Focus names the gap instead of opening a picker", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedBareProfile(win, "foc-empty");
      await activateProfile(win);

      await openFocusFromDashboard(win);
      const m = focusModal(win);
      await expect(m.locator("p.hint")).toBeVisible();
      await expect(m.locator("p.hint")).toHaveText(
        "This profile has no subjects yet. Focus needs a real subject — add one in the Degree Planner first."
      );
      await expect(m.locator('select[aria-label="Study subject"]')).toHaveCount(0);
      await expect(m.locator(".clock")).toHaveCount(0);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F5 the timer shows real elapsed time (00:05:00 after the 5-minute recipe)", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-timer");
      await activateProfile(win);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);

      // While Date.now is still backdated the offset cancels inside the diff.
      await assertBackdatedStart(win);
      // Restoring Date.now lets the next interval tick register the 5 minutes.
      await restoreClock(win);
      await waitClock(win);

      const clock = focusModal(win).locator(".clock");
      await expect(clock).toHaveAttribute("role", "timer");
      await expect(clock).toHaveAttribute("aria-label", "Elapsed time");
      await expect(focusModal(win).locator(".choose-lede")).toHaveCount(0);

      // Nothing is logged while the clock runs.
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      // Discarding >= 1 minute prompts. This also pins the overlay stacking
      // order: the focus backdrop is a feature overlay and must sit BELOW the
      // global confirm prompt and the toast stack, otherwise a session cannot be
      // ended and feedback fired while the overlay is open is invisible.
      const stacking = await stackingOrder(win);
      expect(stacking.focusBackdrop).toBe("1200");

      await focusModal(win).getByRole("button", { name: "Cancel" }).click();
      const confirmStacking = await dismissDiscardConfirm(win);
      // The confirm prompt outranks the focus backdrop, so the Discard button
      // received the real click above instead of the backdrop re-entering discard().
      expect(confirmStacking.confirmBackdrop).toBe("1300");
      expect(Number(confirmStacking.confirmBackdrop) > Number(confirmStacking.focusBackdrop)).toBe(true);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F6/F7 objective + finish writes exactly one record and updates every stat", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-finish");
      await activateProfile(win);

      const objective = "Implement quicksort with a randomized pivot";
      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);

      await expect(focusModal(win).getByLabel("Session objective")).toBeVisible();
      await focusModal(win).locator("#focus-objective").fill(objective);

      await finishSession(win);

      await expect(toast(win, /Logged 5m of focused study/)).toBeVisible();

      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.subjectId).toBe(seed.subjectId);
      expect(row.subjectName).toBe(SUBJECT);
      expect(row.durationMinutes).toBe(5);
      expect(row.notes).toBe(objective);
      // Local SQLite convention: space separator, never "T".
      expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.endedAt).not.toBeNull();
      expect(row.endedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.endedAt >= row.startedAt).toBe(true);
      // The timestamps agree with the logged duration (normal slack allowed).
      const spanMin = Math.round(
        (Date.parse(row.endedAt.replace(" ", "T")) - Date.parse(row.startedAt.replace(" ", "T"))) / 60000
      );
      expect(spanMin).toBeGreaterThanOrEqual(4);
      expect(spanMin).toBeLessThanOrEqual(8);
      // The row's date is the LOCAL date, not the UTC one.
      expect(row.startedAt.slice(0, 10)).toBe(localDate(new Date(Date.now() - OFFSET_MS)));

      const stats = await readStats(win, seed.pid);
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalMinutes).toBe(5);
      expect(stats.minutesToday).toBe(5);
      expect(stats.activeDays).toBe(1);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F2 Subject Workspace entry opens straight into the session phase for that subject", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-context");
      await activateProfile(win);

      // Subjects → open the workspace.
      await win.locator(".nav-item", { hasText: "Subjects" }).click();
      const subjectRow = win
        .locator(".subject-row, .subject-card, .subject-table-row")
        .filter({ hasText: SUBJECT });
      await expect(subjectRow.first()).toBeVisible({ timeout: 20000 });
      await subjectRow.first().click();

      const studyCard = win
        .locator(".summary-card")
        .filter({ has: win.locator(".sc-head", { hasText: "Study" }) });
      await expect(studyCard).toBeVisible();
      const focusBtn = studyCard.locator("button.sc-focus");
      await expect(focusBtn).toBeVisible();
      await expect(focusBtn).toHaveText(/Start Focus/);

      await backdateClock(win);
      await focusBtn.click();
      await expect(focusModal(win)).toBeVisible({ timeout: 15000 });

      const m = focusModal(win);
      // The tree loads a tick after the overlay mounts, so wait for the session phase.
      await expect
        .poll(async () => m.locator(".subject-name").count(), { timeout: 20000, intervals: [200, 500] })
        .toBe(1);
      await expect(m.locator(".subject-name")).toHaveText(SUBJECT);
      await expect(m.locator(".subject-path")).toHaveText(PATH_LABEL);
      // No chooser: the subject was pre-selected.
      await expect(m.locator(".choose-lede")).toHaveCount(0);
      await expect(m.locator('select[aria-label="Study subject"]')).toHaveCount(0);
      await expect(m.locator(".clock")).toBeVisible();
      await expect(m.getByRole("button", { name: "Finish Session" })).toBeVisible();

      await finishSession(win);

      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(rows[0].subjectId).toBe(seed.subjectId);
      expect(rows[0].subjectName).toBe(SUBJECT);
      expect(rows[0].durationMinutes).toBe(5);
      // Blank objective: the UI passes null, the Rust layer stores "" (unwrap_or_default).
      expect(rows[0].notes).toBe("");

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F11 Cancel discards without fabricating a session", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-cancel");
      await activateProfile(win);

      const before = await readStats(win, seed.pid);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await focusModal(win).locator("#focus-objective").fill("cancelled before finishing");

      // A running focus still logs nothing.
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await focusModal(win).getByRole("button", { name: "Cancel" }).click();
      await expect(focusModal(win)).toHaveCount(0);

      const rows = await readSessions(win, seed.pid);
      const stats = await readStats(win, seed.pid);
      expect(rows.length).toBe(0);
      expect(stats).toEqual(before);
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalMinutes).toBe(0);
      expect(stats.minutesToday).toBe(0);
      expect(stats.activeDays).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F12 a double Finish click never duplicates the row", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-dup");
      await activateProfile(win);

      const pageErrors = [];
      win.on("pageerror", (err) => pageErrors.push(err.message));

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await focusModal(win).locator("#focus-objective").fill("double-click proof");

      await restoreClock(win);
      await waitClock(win);
      // Two synchronous invocations of the same handler — the guard drops the second.
      await win.evaluate(() => {
        const btn = document.querySelector(".focus-modal .finish-btn");
        if (!btn) throw new Error("finish button not found");
        btn.click();
        btn.click();
      });

      await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });
      await expect(toast(win, /Logged 5m of focused study/)).toBeVisible();

      const rows = await readSessions(win, seed.pid);
      const stats = await readStats(win, seed.pid);
      expect(rows.length, "exactly one row despite two Finish invocations").toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalMinutes).toBe(5);
      expect(rows[0].notes).toBe("double-click proof");

      const focusErrors = pageErrors.filter((msg) => /focus|session|saving/i.test(msg));
      expect(focusErrors, "no unhandled rejection from the duplicate finish").toEqual([]);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F21 a sub-minute finish is honest: no row, no stats, and the user keeps their place", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-short");
      await activateProfile(win);

      // NO 5-minute recipe: a genuine fresh start.
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await focusModal(win).locator("#focus-objective").fill("only a glance");

      const m = focusModal(win);
      await expect(m.locator(".clock")).toHaveText(/^00:00:\d\d$/); // sub-minute

      await m.getByRole("button", { name: "Finish Session" }).click();

      // The toast lands in the DOM ...
      await expect(toast(win, /Sessions under a minute are not logged/)).toBeVisible();
      // ... and the user can actually see it. toBeVisible() cannot prove that:
      // the toast stack used to sit at z-index 1000, under the focus backdrop's
      // 1200, so this feedback was invisible while the overlay was open. Assert
      // both the stacking order and a real hit-test at the toast's centre.
      const stacking = await stackingOrder(win);
      expect(Number(stacking.toastStack) > Number(stacking.focusBackdrop)).toBe(true);
      const topmost = await toast(win, /Sessions under a minute are not logged/).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el.contains(hit) ? "toast" : hit ? hit.tagName : null;
      });
      expect(topmost).toBe("toast");

      const rows = await readSessions(win, seed.pid);
      const stats = await readStats(win, seed.pid);
      expect(rows.length).toBe(0);
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalMinutes).toBe(0);
      expect(stats.minutesToday).toBe(0);
      expect(stats.activeDays).toBe(0);

      // The overlay is still open — the user did not lose their place.
      await expect(m).toBeVisible();
      await expect(m.locator(".clock")).toBeVisible();
      await expect(m.locator("#focus-objective")).toHaveValue("only a glance");
      await expect(m.getByRole("button", { name: "Finish Session" })).toBeEnabled();

      // Discard to leave cleanly; still nothing logged.
      await m.getByRole("button", { name: "Cancel" }).click();
      await expect(m).toHaveCount(0);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F25 the context strip shows the deadline, due flashcards, and today's minutes", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-context-strip");

      // A deadline and a due flashcard on the first subject.
      await win.evaluate(async ({ pid, subjectId, dueDate }) => {
        await window.progressLedger.deadlines.add(pid, subjectId, dueDate, "assignment", "Lab Report", "");
        await window.progressLedger.cards.create(pid, subjectId, "What is a red-black tree?", "Self-balancing BST");
      }, { pid: seed.pid, subjectId: seed.subjectId, dueDate: localDateShifted(2) });

      // A second subject with no deadlines and no cards (the empty-context case).
      const bare = await win.evaluate(async ({ pid, track, semester, milestone }) => {
        const trackId = await window.progressLedger.academic.addTrack(pid, track);
        const semId = await window.progressLedger.academic.addSemester(pid, trackId, semester);
        const msId = await window.progressLedger.academic.addMilestone(pid, semId, milestone);
        const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Graph Theory", null);
        return { subjectId, name: "Graph Theory" };
      }, { pid: seed.pid, track: TRACK, semester: SEMESTER, milestone: MILESTONE });

      await activateProfile(win);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);

      const m = focusModal(win);
      await expect(m.locator(".context-head")).toBeVisible();
      await expect(m.locator(".context-head")).toHaveText("Current context");
      // Deadline row with its phrase tag.
      await expect(m.locator(".context .ctx-text").filter({ hasText: "Lab Report" }).first()).toBeVisible();
      await expect(m.locator(".context .ctx-tag").first()).toBeVisible();
      await expect(m.locator(".context .ctx-tag").first()).toHaveText("due in 2 days");
      // Flashcard row.
      await expect(m.locator(".context .ctx-text").filter({ hasText: "flashcard" }).first()).toBeVisible();
      await expect(m.locator(".context .ctx-text").filter({ hasText: "flashcard" }).first()).toHaveText(/1 flashcard due/);
      // Studied-today row (none yet).
      await expect(m.locator(".context .ctx-text").filter({ hasText: "studied today" }).first()).toBeVisible();
      await expect(m.locator(".context .ctx-text").filter({ hasText: "studied today" }).first()).toHaveText("0m studied today");

      // The clock keeps ticking while the context strip renders.
      await restoreClock(win);
      await waitClock(win);

      await finishSession(win);
      expect((await readSessions(win, seed.pid)).length).toBe(1);

      // ---- Empty context: a subject with no deadlines and no cards ----
      // Re-arm the backdate: restoreClock() already returned Date.now() to real time.
      await backdateClock(win);
      await openFocusFromDashboard(win);
      const select = m.locator('select[aria-label="Study subject"]');
      await expect(select).toBeVisible({ timeout: 20000 });
      await select.selectOption({ label: `${PATH_LABEL} › ${bare.name}` });
      await expect(m.locator(".subject-name")).toHaveText(bare.name);

      await expect(m.locator(".context-head")).toBeVisible();
      await expect(m.locator(".context .ctx-tag")).toHaveCount(0); // no deadline row
      await expect(m.locator(".context .ctx-text").filter({ hasText: "flashcard" })).toHaveCount(0);
      // A quiet subject names the gap instead of rendering "0m studied today".
      await expect(m.locator(".context .context-row.muted")).toHaveText("Nothing pending for this subject.");
      // The clock still ticks with an empty strip.
      await restoreClock(win);
      await waitClock(win);

      await m.getByRole("button", { name: "Cancel" }).click();
      await dismissDiscardConfirm(win);
      expect((await readSessions(win, seed.pid)).length).toBe(1);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F25 the empty-context string appears for a quiet subject, then yields to real data", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-emptyctx");
      await activateProfile(win);

      const m = focusModal(win);

      // ---- Quiet subject: no deadlines, no due cards, no time logged ----
      // A valid subject's overview returns 0 for both, never null, so the empty
      // state is decided by contextIsEmpty() treating zero as "nothing". Before
      // that fix this branch was unreachable and a greyed "0m studied today"
      // rendered instead.
      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);

      await expect(m.locator(".context-head")).toBeVisible();
      await expect(m.locator(".context .context-row.muted")).toHaveText("Nothing pending for this subject.");
      await expect(m.locator(".context .ctx-text")).toHaveCount(0);
      await expect(m.locator(".context .ctx-tag")).toHaveCount(0);
      // The clock still runs while the strip is empty.
      await assertBackdatedStart(win);

      // ---- Finish once, so the subject now has real data ----
      await finishSession(win);
      expect((await readSessions(win, seed.pid)).length).toBe(1);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);

      // The empty string yields to the actual context.
      await expect(m.locator(".context .context-row.muted")).toHaveCount(0);
      await expect(m.locator(".context .ctx-text").filter({ hasText: "studied today" })).toHaveText("5m studied today");
      // The clock runs from the backdated start again.
      await assertBackdatedStart(win);
      await restoreClock(win);
      await waitClock(win);

      // Discarding a >= 1 minute session prompts and still fabricates nothing.
      await m.getByRole("button", { name: "Cancel" }).click();
      await dismissDiscardConfirm(win);
      expect((await readSessions(win, seed.pid)).length).toBe(1);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F8/F9/F10 a finished session refreshes Dashboard, Subject Workspace, and Semester Progress", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-refresh");
      await activateProfile(win);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await finishSession(win);
      await expect.poll(async () => (await readStats(win, seed.pid)).minutesToday, { timeout: 10000 }).toBe(5);

      // ---- F8 Dashboard: Today → Study column shows the new minutes ----
      // (cf:data-changed already reloaded the Dashboard; re-entering Home is a no-op
      // but guarantees the component is mounted.)
      await win.locator(".nav-item", { hasText: "Home" }).click();
      await expect(win.locator(".today")).toBeVisible({ timeout: 20000 });
      await expect(studyColumn(win)).toBeVisible();
      await expect(studyReadout(win)).toHaveText("5m");
      await expect(win.locator(".today .today-study > div > span")).toHaveText("studied today");
      // The CTA flips from "Start Focus" to "Start another" once minutes exist.
      await expect(studyColumn(win).locator("button").filter({ hasText: "Start another" })).toBeVisible();
      await expect(studyColumn(win).locator("button").filter({ hasText: "Start Focus" })).toHaveCount(0);

      // ---- F9 Subject Workspace: the Study card updates ----
      await win.locator(".nav-item", { hasText: "Subjects" }).click();
      const subjectRow = win
        .locator(".subject-row, .subject-card, .subject-table-row")
        .filter({ hasText: SUBJECT });
      await expect(subjectRow.first()).toBeVisible({ timeout: 20000 });
      await subjectRow.first().click();
      const studyCard = win
        .locator(".summary-card")
        .filter({ has: win.locator(".sc-head", { hasText: "Study" }) });
      await expect(studyCard.locator(".sc-main")).toHaveText("5m today");
      await expect(studyCard.locator(".sc-sub")).toHaveText(/5m total · 1 sessions/);

      // ---- F10 Semester Progress: the semester Study card reflects the session ----
      await win.locator(".nav-item", { hasText: "Degree" }).click();
      await expect(win.locator(".section-tab-btn").filter({ hasText: "Progress" })).toBeVisible({ timeout: 20000 });
      await win.locator(".section-tab-btn").filter({ hasText: "Progress" }).click();
      const spStudyCard = win
        .locator(".semester-progress .card")
        .filter({ has: win.locator(".card-head", { hasText: "Study" }) });
      await expect(spStudyCard).toBeVisible({ timeout: 20000 });
      await expect(spStudyCard.locator(".card-main").first()).toHaveText("5m");
      await expect(spStudyCard.locator(".card-sub").first()).toHaveText(/5m in last 7 days · 1 sessions/);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F27 Ctrl+Enter finishes, Escape discards, and the footer hints are shown", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-keys");
      await activateProfile(win);

      // ---- Ctrl+Enter finishes a real session ----
      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      const m = focusModal(win);

      // Footer hint pills are present for a running session.
      await expect(m.locator(".hints .hint").filter({ hasText: "Ctrl+Enter to finish" })).toBeVisible();
      await expect(m.locator(".hints .hint").filter({ hasText: "Esc to discard" })).toBeVisible();

      // Focus the dialog body so the modal's keydown handler owns the shortcuts.
      await m.locator("#focus-objective").fill("keyboard finish");
      await restoreClock(win);
      await waitClock(win);
      await win.keyboard.press("Control+Enter");
      await expect(m).toHaveCount(0, { timeout: 20000 });

      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(rows[0].durationMinutes).toBe(5);
      expect(rows[0].notes).toBe("keyboard finish");

      // ---- Escape discards without logging (fresh sub-minute session: no confirm) ----
      await win.locator(".nav-item", { hasText: "Home" }).click();
      await expect(win.locator(".today")).toBeVisible({ timeout: 20000 });
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await focusModal(win).locator("#focus-objective").fill("escaped");
      await win.keyboard.press("Escape");
      await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });

      const after = await readSessions(win, seed.pid);
      const stats = await readStats(win, seed.pid);
      expect(after.length).toBe(1); // the discarded session logged nothing
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalMinutes).toBe(5);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F26 a quick note saves as a real subject-scoped resource and the session still finishes", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-note");
      await activateProfile(win);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      const m = focusModal(win);

      const noteText = "Pivot choice dominates tail recursion on skewed input.";
      await m.locator('input[aria-label="Quick note"]').fill(noteText);
      await expect(m.locator(".capture-btn")).toBeEnabled();
      await m.locator(".capture-btn").click();
      await expect(toast(win, /Note saved to subject/)).toBeVisible();
      await expect(m.locator('input[aria-label="Quick note"]')).toHaveValue("");

      // list() returns ResourceMeta (kind/title/subjectId); content lives on the
      // full Resource from get().
      const notes = await win.evaluate(async ({ pid, subjectId }) => window.progressLedger.resources.list({ profileId: pid, subjectId }), { pid: seed.pid, subjectId: seed.subjectId });
      expect(notes.length).toBe(1);
      expect(notes[0].kind).toBe("note");
      expect(notes[0].title).toBe(`Focus note — ${SUBJECT}`);
      expect(notes[0].subjectId).toBe(seed.subjectId);
      const saved = await win.evaluate(async ({ pid, id }) => window.progressLedger.resources.get({ profileId: pid, id }), { pid: seed.pid, id: notes[0].id });
      expect(saved.content).toBe(noteText);

      // The session still finishes cleanly afterwards.
      await finishSession(win);
      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(rows[0].durationMinutes).toBe(5);

      // The note survives the session.
      const after = await win.evaluate(async ({ pid, subjectId }) => window.progressLedger.resources.list({ profileId: pid, subjectId }), { pid: seed.pid, subjectId: seed.subjectId });
      expect(after.length).toBe(1);
      const afterFull = await win.evaluate(async ({ pid, id }) => window.progressLedger.resources.get({ profileId: pid, id }), { pid: seed.pid, id: after[0].id });
      expect(afterFull.content).toBe(noteText);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F29 re-triggering Start Focus on a running session does not reset the clock or bypass the discard confirm", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-retrig");
      await activateProfile(win);

      // Before the fix, the overlay's open effect re-ran whenever App handed it a
      // fresh tree array, so re-triggering Start Focus reset a running session to
      // 00:00:00 — a >= 1 minute session abandoned with no confirm prompt.
      //
      // The backdrop covers the trigger, so this is only reachable by keyboard:
      // the button that opened the overlay keeps keyboard focus, and Enter
      // re-activates it. The overlay now moves focus into the dialog, which
      // closes that path too; focusing the trigger here re-opens it to prove the
      // App-level guard, which is the fix that protects other callers.
      const startButton = studyColumn(win)
        .locator("button")
        .filter({ hasText: /Start Focus|Start another/ });

      const retrigger = async () => {
        await startButton.focus();
        await win.keyboard.press("Enter");
      };

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      const m = focusModal(win);
      // The discard prompt is rendered by the shared Toaster, not inside
      // .focus-modal, so it must be located on the page, not inside m.
      const confirm = win.locator(".cf-modal");

      await m.locator("#focus-objective").fill("still counting");
      await restoreClock(win);
      await waitClock(win);

      await retrigger();

      // Still the same session: the clock did not restart...
      await expect(m.locator(".clock")).toHaveText(/^00:05:\d\d$/);
      // ...the objective survived, and nothing was logged or silently discarded.
      await expect(m.locator("#focus-objective")).toHaveValue("still counting");
      await expect(confirm).toHaveCount(0);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      // A re-trigger while the prompt is up cannot resolve it either.
      await m.locator(".cancel-btn").click();
      await expect(confirm.getByRole("heading", { level: 3 })).toHaveText("Discard this session?");
      await retrigger();
      await expect(m).toHaveCount(1);
      await expect(confirm.getByRole("heading", { level: 3 })).toHaveText("Discard this session?");
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await dismissDiscardConfirm(win);
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F30 Enter in the objective field does not save a quick note or finish the session", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    let app;
    let win;
    try {
      ({ app, win } = await launchApp(userDataDir));
      const seed = await seedProfile(win, "foc-objkey");
      await activateProfile(win);

      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      const m = focusModal(win);

      const readNotes = () =>
        win.evaluate(async ({ pid, subjectId }) => window.progressLedger.resources.list({ profileId: pid, subjectId }), { pid: seed.pid, subjectId: seed.subjectId });

      // Enter in the objective field is a no-op. It used to save the quick note,
      // which meant either warning about an empty note the user never meant to
      // save, or writing one while they type an objective.
      await m.locator("#focus-objective").fill("read Chapter 3");
      await m.locator("#focus-objective").press("Enter");
      await expect(toast(win, /Write something to save as a note/)).toHaveCount(0);
      expect((await readNotes()).length).toBe(0);

      // The quick note keeps its own Enter-to-save path.
      await m.locator('input[aria-label="Quick note"]').press("Enter");
      await expect(toast(win, /Write something to save as a note/)).toBeVisible();
      expect((await readNotes()).length).toBe(0);

      // ...and the objective cannot trigger it with text in the note field.
      await m.locator('input[aria-label="Quick note"]').fill("note text left alone");
      await m.locator("#focus-objective").press("Enter");
      expect((await readNotes()).length).toBe(0);
      await expect(m.locator('input[aria-label="Quick note"]')).toHaveValue("note text left alone");

      // The session is still running and unlogged: only Ctrl+Enter finishes.
      await expect(m.locator(".clock")).toBeVisible();
      await expect(m.getByRole("button", { name: "Finish Session" })).toBeVisible();
      expect((await readSessions(win, seed.pid)).length).toBe(0);

      await restoreClock(win);
      await waitClock(win);
      await m.locator("#focus-objective").press("Control+Enter");
      await expect(m).toHaveCount(0, { timeout: 20000 });

      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(rows[0].durationMinutes).toBe(5);
      expect(rows[0].notes).toBe("read Chapter 3");

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });
});
