import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// ---- Focus Session lifecycle: restart, profile isolation, deleted subjects, backup ----
//
// Documents the *no persisted active session* contract: an abandoned focus logs
// nothing, while a finished one survives restart, stays inside its own profile,
// cascades with its subject, and travels through backup/restore.
//
// The timer tests use a deterministic local-midnight clock. This avoids making
// acceptance depend on whether the machine happens to be within five minutes of
// midnight while still exercising the local-calendar boundary contract.

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

/** Graceful close with a race guard (an unguarded close hangs when mid-operation). */
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
      return { pid, subjectId, subjectName, slug: p.slug };
    },
    { slugPrefix, subjectName, profile: PROFILE, track: TRACK, semester: SEMESTER, milestone: MILESTONE }
  );
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
    const start = new Date(realNow());
    start.setHours(0, 0, 0, 0);
    const syntheticStart = start.getTime();
    window.__realNow = realNow;
    window.__focusTestClock = syntheticStart;
    Date.now = () => window.__focusTestClock;
  }, offset);
}

/** Advance the deterministic page clock by exactly five minutes. */
async function advanceClock(win, minutes = 5) {
  await win.evaluate((minutesToAdvance) => {
    if (typeof window.__realNow !== "function" || typeof window.__focusTestClock !== "number") {
      throw new Error("focus test clock is not installed");
    }
    window.__focusTestClock += minutesToAdvance * 60 * 1000;
  }, minutes);
}

async function restoreClock(win) {
  await win.evaluate(() => {
    if (typeof window.__realNow === "function") {
      Date.now = window.__realNow;
      delete window.__realNow;
      delete window.__focusTestClock;
    }
  });
}
/** Wait for the modal clock to land on the expected reading (1s interval). */
async function waitClock(win, pattern = /^00:05:0\d$/, timeout = 20000) {
  await expect
    .poll(
      async () => (await focusModal(win).locator(".clock").textContent())?.trim(),
      { timeout, intervals: [200, 500] }
    )
    .toMatch(pattern);
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

/** Start a real 5-minute focus from the Dashboard and finish it through the UI. */
async function runAndFinishFocus(win, objective = null) {
  await backdateClock(win);
  await openFocusFromDashboard(win);
  await chooseSubject(win);
  if (objective) {
    await focusModal(win).locator("#focus-objective").fill(objective);
  }
  await advanceClock(win);
  await waitClock(win);
  await focusModal(win).getByRole("button", { name: "Finish Session" }).click();
  await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });
}

const toast = (win, pattern) => win.locator(".toast-stack .toast").filter({ hasText: pattern });

test.describe("Focus Session — lifecycle", () => {
  test("F16 force-closing the app mid-session fabricates nothing (no persisted active session)", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const launch = () =>
      electron.launch({
        args: [projectRoot, `--user-data-dir=${userDataDir}`],
        env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
      });

    let app;
    let win;
    try {
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      const seed = await seedProfile(win, "foc-abandon");
      await activateProfile(win);

      // A genuinely running session: the clock has registered 5 minutes.
      await backdateClock(win);
      await openFocusFromDashboard(win);
      await chooseSubject(win);
      await advanceClock(win);
      await waitClock(win);
      await focusModal(win).locator("#focus-objective").fill("never finished");

      // Still running → nothing in the store yet.
      expect((await readSessions(win, seed.pid)).length).toBe(0);
      expect((await readStats(win, seed.pid)).totalSessions).toBe(0);

      // Force-close WITHOUT finishing. There is deliberately no persisted
      // "active session": an abandoned focus logs nothing.
      await closeApp(app);
      app = null;

      // ---- Relaunch with the same user-data-dir ----
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      const after = await win.evaluate(async (pid) => {
        const profiles = await window.progressLedger.profiles.list();
        const list = await window.progressLedger.sessions.list(pid, 500);
        const stats = await window.progressLedger.sessions.stats(pid);
        return { profileExists: profiles.some((p) => p.id === pid), list, stats };
      }, seed.pid);

      expect(after.profileExists).toBe(true); // the profile survived
      expect(after.list.length, "the abandoned session was not written").toBe(0);
      expect(after.stats.totalSessions).toBe(0);
      expect(after.stats.totalMinutes).toBe(0);
      expect(after.stats.minutesToday).toBe(0);
      expect(after.stats.activeDays).toBe(0);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F16b a finished session survives a restart with identical row and stats", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const launch = () =>
      electron.launch({
        args: [projectRoot, `--user-data-dir=${userDataDir}`],
        env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
      });

    let app;
    let win;
    try {
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      const seed = await seedProfile(win, "foc-persist");
      await activateProfile(win);

      const objective = "Finish the AVL rotation proofs";
      await runAndFinishFocus(win, objective);

      const rows = await readSessions(win, seed.pid);
      const before = { row: rows[0], stats: await readStats(win, seed.pid) };
      expect(rows.length).toBe(1);
      expect(before.row.durationMinutes).toBe(5);
      expect(before.row.notes).toBe(objective);
      expect(before.stats.totalSessions).toBe(1);

      await closeApp(app);
      app = null;

      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      const after = await win.evaluate(async (pid) => ({
        list: await window.progressLedger.sessions.list(pid, 500),
        stats: await window.progressLedger.sessions.stats(pid),
      }), seed.pid);

      expect(after.list.length).toBe(1);
      expect(after.list[0].id).toBe(before.row.id);
      expect(after.list[0].subjectId).toBe(before.row.subjectId);
      expect(after.list[0].subjectName).toBe(SUBJECT);
      expect(after.list[0].durationMinutes).toBe(5);
      expect(after.list[0].notes).toBe(objective);
      expect(after.list[0].startedAt).toBe(before.row.startedAt);
      expect(after.list[0].endedAt).toBe(before.row.endedAt);
      expect(after.stats).toEqual(before.stats);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F14 profile isolation: a finished session stays in its own profile", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const { app, win } = await launchApp(userDataDir);
    try {
      // Profile A owns one subject.
      const a = await seedProfile(win, "foc-iso-a", "Data Structures");
      // Profile B owns its own subject.
      const b = await win.evaluate(async ({ profile, track, semester, milestone }) => {
        const p = await window.progressLedger.profiles.add(`${profile} B`, `foc-iso-b-${Date.now()}`);
        const pid = p.id;
        const trackId = await window.progressLedger.academic.addTrack(pid, track);
        const semId = await window.progressLedger.academic.addSemester(pid, trackId, semester);
        const msId = await window.progressLedger.academic.addMilestone(pid, semId, milestone);
        const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Operating Systems", null);
        return { pid, subjectId, name: `${profile} B` };
      }, { profile: PROFILE, track: TRACK, semester: SEMESTER, milestone: MILESTONE });

      // B is empty before anything happens.
      expect((await readSessions(win, b.pid)).length).toBe(0);
      expect(await readStats(win, b.pid)).toEqual({
        totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0,
      });

      // Finish a real 5-minute focus under A.
      await activateProfile(win, PROFILE);
      await runAndFinishFocus(win, "isolation check");
      const aAfter = { rows: await readSessions(win, a.pid), stats: await readStats(win, a.pid) };
      expect(aAfter.rows.length).toBe(1);
      expect(aAfter.rows[0].subjectId).toBe(a.subjectId);
      expect(aAfter.stats.totalSessions).toBe(1);
      expect(aAfter.stats.totalMinutes).toBe(5);

      // B is still empty — the negative direction, asserted explicitly.
      expect((await readSessions(win, b.pid)).length, "B's list is empty").toBe(0);
      expect(await readStats(win, b.pid)).toEqual({
        totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0,
      });

      // With B active the Dashboard shows zero study minutes.
      await activateProfile(win, b.name);
      await expect(studyReadout(win)).toHaveText("0m");
      await expect(studyColumn(win).locator("button").filter({ hasText: "Start Focus" })).toBeVisible();
      await expect(studyColumn(win).locator("button").filter({ hasText: "Start another" })).toHaveCount(0);

      // Switching back to A, A's totals are unchanged by B's existence.
      await activateProfile(win, PROFILE);
      await expect(studyReadout(win)).toHaveText("5m");
      await expect(studyColumn(win).locator("button").filter({ hasText: "Start another" })).toBeVisible();
      const aAfterReturn = { rows: await readSessions(win, a.pid), stats: await readStats(win, a.pid) };
      expect(aAfterReturn.stats).toEqual(aAfter.stats);
      expect(aAfterReturn.rows.length).toBe(1);
      expect(aAfterReturn.rows[0].id).toBe(aAfter.rows[0].id);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F13 deleting a subject is handled safely, before and after finishing", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const { app, win } = await launchApp(userDataDir);
    try {
      // Two subjects: one to delete first, one that survives.
      const primary = await seedProfile(win, "foc-deleted", "Data Structures");
      const survivor = await win.evaluate(async ({ pid, track, semester, milestone }) => {
        const trackId = await window.progressLedger.academic.addTrack(pid, track);
        const semId = await window.progressLedger.academic.addSemester(pid, trackId, semester);
        const msId = await window.progressLedger.academic.addMilestone(pid, semId, milestone);
        const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Graph Theory", null);
        return { subjectId, name: "Graph Theory" };
      }, { pid: primary.pid, track: TRACK, semester: SEMESTER, milestone: MILESTONE });

      // ---- (a) Delete BEFORE starting ----
      await win.evaluate(async ({ pid, id }) => window.progressLedger.academic.deleteSubject(pid, id), { pid: primary.pid, id: primary.subjectId });

      // The chooser can no longer see the deleted subject.
      await activateProfile(win);
      await backdateClock(win);
      await openFocusFromDashboard(win);
      const select = focusModal(win).locator('select[aria-label="Study subject"]');
      await expect(select).toBeVisible({ timeout: 20000 });
      await expect(select.locator("option")).toHaveCount(1);
      await expect(select.locator("option")).toHaveText(`${PATH_LABEL} › ${survivor.name}`);
      const listed = await select.locator("option").evaluateAll((opts) => opts.map((o) => Number(o.value)));
      expect(listed).not.toContain(primary.subjectId);
      expect(listed).toEqual([survivor.subjectId]);

      await chooseSubject(win);
      await advanceClock(win);
      await waitClock(win);
      await focusModal(win).getByRole("button", { name: "Finish Session" }).click();
      await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });

      const rowsA = await readSessions(win, primary.pid);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0].subjectId).toBe(survivor.subjectId);
      expect(rowsA[0].subjectName).toBe(survivor.name);
      expect(rowsA[0].durationMinutes).toBe(5);

      // ---- (b) Delete AFTER finishing ----
      await win.evaluate(async ({ pid, id }) => window.progressLedger.academic.deleteSubject(pid, id), { pid: primary.pid, id: survivor.subjectId });

      const rowsB = await readSessions(win, primary.pid);
      const statsB = await readStats(win, primary.pid);
      expect(rowsB.length, "the session cascades away with its subject").toBe(0);
      expect(statsB).toEqual({
        totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0,
      });

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F13c the chooser can only name a real subject — no placeholder, no bogus id", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const { app, win } = await launchApp(userDataDir);
    try {
      const seed = await seedProfile(win, "foc-chooser-ids", "Data Structures");
      // Two more subjects so the picker is not trivially single-valued.
      const extra = await win.evaluate(async ({ pid, track, semester, milestone }) => {
        const trackId = await window.progressLedger.academic.addTrack(pid, track);
        const semId = await window.progressLedger.academic.addSemester(pid, trackId, semester);
        const msId = await window.progressLedger.academic.addMilestone(pid, semId, milestone);
        return [
          await window.progressLedger.academic.addSubject(pid, msId, "Graph Theory", null),
          await window.progressLedger.academic.addSubject(pid, msId, "Compiler Design", null),
        ];
      }, { pid: seed.pid, track: TRACK, semester: SEMESTER, milestone: MILESTONE });

      const treeIds = await win.evaluate(async (pid) => {
        const tree = await window.progressLedger.academic.tree(pid);
        const ids = [];
        for (const track of tree) {
          for (const sem of track.semesters || []) {
            for (const ms of sem.milestones || []) {
              for (const subj of ms.subjects || []) ids.push(Number(subj.id));
            }
          }
        }
        return ids;
      }, seed.pid);
      expect(treeIds).toContain(seed.subjectId);

      await activateProfile(win);
      await backdateClock(win);
      await openFocusFromDashboard(win);

      const select = focusModal(win).locator('select[aria-label="Study subject"]');
      await expect(select).toBeVisible({ timeout: 20000 });
      const options = await select.locator("option").evaluateAll((opts) =>
        opts.map((o) => ({ value: o.value, text: o.textContent }))
      );

      // One option per real subject in the academic tree.
      expect(options.length).toBe(treeIds.length);
      expect(options.length).toBe(3);
      for (const opt of options) {
        expect(Number.isFinite(Number(opt.value)), `value ${opt.value} parses as a number`).toBe(true);
        expect(treeIds, `option ${opt.value} exists in academic.tree`).toContain(Number(opt.value));
        // Every option labels a real subject with its placement path.
        expect(opt.text).toContain("›");
        expect(opt.text.length).toBeGreaterThan(0);
      }

      // No placeholder and no empty value to submit.
      expect(options.some((o) => o.value === "" || /^\s*$/.test(o.value))).toBe(false);
      expect(options.some((o) => /select a subject|choose a subject|—/i.test(o.text))).toBe(false);

      // The control itself has no blank <option> to submit. Svelte binds
      // subjectId=null and no <option> has value "", so selectedIndex is -1 and
      // el.value reads "" — but the browser still *renders* the first real option,
      // and the only way to start the clock is to change the selection to a real id.
      // selectedOptions is empty in that state, so judge the control by what it can
      // actually submit, not by the empty binding.
      const ctrl = await select.evaluate((el) => ({
        value: el.value,
        selectedIndex: el.selectedIndex,
        blankOptions: [...el.options].filter((o) => o.value === "").length,
        displayed: el.options[0] ? el.options[0].value : null,
      }));
      expect(ctrl.blankOptions, "no blank option exists").toBe(0);
      expect([ -1, 0, 1, 2 ], "selectedIndex is unbound or a real slot").toContain(ctrl.selectedIndex);
      if (ctrl.selectedIndex !== -1) {
        expect(treeIds, "any bound selection is a real subject id").toContain(Number(ctrl.value));
        expect(ctrl.value, "a bound selection is never blank").not.toBe("");
      }
      expect(treeIds, "the rendered option is a real subject id").toContain(Number(ctrl.displayed));

      // And finishing through that picker lands on a subject that still exists.
      await chooseSubject(win, 0);
      await advanceClock(win);
      await waitClock(win);
      await focusModal(win).getByRole("button", { name: "Finish Session" }).click();
      await expect(focusModal(win)).toHaveCount(0, { timeout: 20000 });
      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(treeIds).toContain(Number(rows[0].subjectId));
      expect(extra.concat(seed.subjectId)).toContain(Number(rows[0].subjectId));

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F15 sessions are stored with LOCAL calendar dates and a space separator", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const { app, win } = await launchApp(userDataDir);
    try {
      const seed = await seedProfile(win, "foc-local-date");
      await activateProfile(win);

      // The expected local date of the backdated start, computed in Node with the
      // local accessors — never Date#toISOString (UTC).
      const expectedStart = new Date();
      expectedStart.setHours(0, 0, 0, 0);
      const startedLocal = localDate(expectedStart);
      const startedUtc = expectedStart.toISOString().slice(0, 10);

      await runAndFinishFocus(win, "local date proof");

      const rows = await readSessions(win, seed.pid);
      const stats = await readStats(win, seed.pid);
      expect(rows.length).toBe(1);

      const row = rows[0];
      expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.startedAt.includes("T")).toBe(false);
      expect(row.startedAt.slice(0, 10)).toBe(startedLocal);
      // When the two differ (evenings in UTC+0530), the local date must win.
      if (startedLocal !== startedUtc) {
        expect(row.startedAt.slice(0, 10), "not the UTC date").toBe(startedLocal);
        expect(row.startedAt.slice(0, 10)).not.toBe(startedUtc);
      }

      // The "today" aggregates agree with the local calendar: the Rust stats query
      // compares date(started_at) against date('now','localtime'), so a UTC-stored
      // timestamp would drop out of minutesToday near midnight.
      expect(row.endedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.endedAt.includes("T")).toBe(false);
      expect(row.endedAt.slice(0, 10)).toBe(localDate());
      expect(stats.minutesToday).toBe(5);
      expect(stats.activeDays).toBe(1);
      expect(stats.totalSessions).toBe(1);

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });

  test("F28 a focus session (with its objective) survives backup → delete → restore → restart", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
    const backupDir = join(userDataDir, "vault");
    mkdirSync(backupDir, { recursive: true });

    const launch = () =>
      electron.launch({
        args: [projectRoot, `--user-data-dir=${userDataDir}`],
        env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
      });

    const objective = "Restore-proof reading: Ch. 4 on deadlock";
    let app;
    let win;
    try {
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      // Point the backup vault at our temp folder (same file the shell reads).
      const wsDir = await app.evaluate(({ app: a }) => a.getPath("userData"));
      const settingsPath = join(wsDir, "backup-settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          backupDir,
          lastBackups: {},
          automation: { enabled: false, intervalMinutes: 60, target: "local", retentionKeep: 5 },
        })
      );
      const readback = await win.evaluate(() => window.progressLedger.backups.get());
      if (!readback.backupDir) {
        throw new Error("backup settings not visible to shell; settingsPath=" + settingsPath);
      }

      // Seed small, then finish a REAL focus session through the UI.
      const seed = await seedProfile(win, "foc-backup", SUBJECT);
      await activateProfile(win);
      await runAndFinishFocus(win, objective);

      const rows = await readSessions(win, seed.pid);
      expect(rows.length).toBe(1);
      expect(rows[0].durationMinutes).toBe(5);
      expect(rows[0].notes).toBe(objective);

      // ---- BACKUP through the UI ----
      await win.locator(".nav-item", { hasText: "Profiles" }).click();
      await win.getByRole("button", { name: `Select ${PROFILE}`, exact: true }).click();
      await win.waitForTimeout(700);
      await win.locator(".nav-item", { hasText: "Settings" }).click();
      await win.locator("button.primary", { hasText: "Backup Active Profile" }).click();
      await win.waitForTimeout(1500);
      await expect(win.locator(".backup-row").first()).toBeVisible({ timeout: 15000 });

      // ---- DELETE the profile through the UI ----
      await win.locator(".nav-item", { hasText: "Profiles" }).click();
      const delCard = win.locator(".profile-card", { hasText: PROFILE }).first();
      await expect(delCard).toBeVisible({ timeout: 15000 });
      await delCard.getByRole("button", { name: "Delete" }).click();
      const delModal = win.locator(".cf-modal");
      await expect(delModal).toBeVisible({ timeout: 15000 });
      await delModal.locator("button.danger, button.primary").last().click();
      await win.waitForTimeout(600);

      const goneCheck = await win.evaluate(async (pid) => {
        const profiles = await window.progressLedger.profiles.list();
        return profiles.some((p) => p.id === pid);
      }, seed.pid);
      expect(goneCheck, "the profile was deleted").toBe(false);

      // ---- RESTORE from the vault through the UI ----
      // The vault list only renders when at least one profile exists.
      await win.evaluate(async () => {
        await window.progressLedger.profiles.add("Placeholder", `ph-${Date.now()}`);
      });
      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      await win.locator(".nav-item", { hasText: "Settings" }).click();
      await win.locator(".restore-btn").first().click();
      const rmodal = win.locator(".cf-modal");
      await expect(rmodal).toBeVisible({ timeout: 15000 });
      await rmodal.locator("button.danger, button.primary").last().click();
      await win.waitForTimeout(900);

      const restored = await win.evaluate(async (profileName) => {
        const profiles = await window.progressLedger.profiles.list();
        const mine = profiles.find((p) => p.name === profileName);
        return {
          found: !!mine,
          pid: mine?.id,
          profileNames: profiles.map((p) => p.name),
          slugs: profiles.map((p) => p.slug),
        };
      }, PROFILE);
      expect(restored.found, `profile restored (saw: ${JSON.stringify(restored.profileNames)})`).toBe(true);
      expect(restored.pid).not.toBe(seed.pid); // remapping happened

      // ---- RESTART and verify the session row and its notes ----
      await closeApp(app);
      app = null;
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 30000 });

      const after = await win.evaluate(async ({ subjectName, objective, profileName }) => {
        const profiles = await window.progressLedger.profiles.list();
        const me = profiles.find((p) => p.name === profileName);
        if (!me) return { found: false, profileNames: profiles.map((p) => p.name) };
        const sessions = await window.progressLedger.sessions.list(me.id, 500);
        const stats = await window.progressLedger.sessions.stats(me.id);
        const tree = await window.progressLedger.academic.tree(me.id);
        const subjects = [];
        for (const t of tree) for (const s of t.semesters || []) for (const ms of s.milestones || []) {
          for (const subj of ms.subjects || []) subjects.push(subj.id);
        }
        const row = sessions.find((s) => s.subjectName === subjectName);
        return {
          found: true,
          profileId: me.id,
          slug: me.slug,
          sessionCount: sessions.length,
          row: row
            ? {
                subjectId: row.subjectId,
                subjectName: row.subjectName,
                durationMinutes: row.durationMinutes,
                notes: row.notes,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
                subjectSurvives: subjects.includes(row.subjectId),
              }
            : null,
          stats,
        };
      }, { subjectName: SUBJECT, objective, profileName: PROFILE });

      expect(after.found, `restored profile present (saw: ${JSON.stringify(after.profileNames)})`).toBe(true);
      expect(after.sessionCount).toBe(1);
      expect(after.row, "the focus session row came back").not.toBeNull();
      expect(after.row.subjectName).toBe(SUBJECT);
      expect(after.row.durationMinutes).toBe(5);
      expect(after.row.notes).toBe(objective);
      expect(after.row.subjectSurvives).toBe(true);
      expect(after.row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(after.row.endedAt).not.toBeNull();
      expect(after.stats).toEqual({
        totalSessions: 1, totalMinutes: 5, minutesToday: 5, activeDays: 1,
      });

      await closeApp(app);
    } finally {
      await closeApp(app);
    }
  });
});
