// Visual iteration harness for the Space Bunny redesign (Phase 5 / Phase 8).
//
// Launches the REAL Electron application, seeds REAL data through the app''s own
// preload bridge, walks every rail destination, and writes screenshots to
// shots/redesign-<round>/ so they can be compared directly against
// Progress Ledger-Frontend-Lab/v1/shots.
//
// Nothing is stubbed: every row in every screenshot came out of SQLite through
// window.progressLedger.
import { _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUND = process.env.CF_ROUND || "r1";
const OUT = ""; // flat files directly in logs/


const app = await electron.launch({
  args: [process.cwd(), `--user-data-dir=${mkdtempSync(join(tmpdir(), "cf-redesign-"))}`],
  env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
});
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForTimeout(3500);

const shot = async (name) => {
  await win.waitForTimeout(700);
  await win.screenshot({ path: `logs/_shot-${ROUND}-${name}.png` });
  console.log("shot:", name);
};

await shot("00-profiles");

// ---- Seed REAL academic data through the app''s own preload bridge -------
// IDs are re-read from the tree after each write rather than trusted from the
// return value, because the IPC layer returns different shapes per call.
const seeded = await win.evaluate(async () => {
  const cf = window.progressLedger;
  const created = await cf.profiles.add("Ada Lovelace", "ada-lovelace");
  const p = created?.profile || created;
  const pid = p?.id ?? p?.profileId;
  if (!pid) return { ok: false, why: "no-profile", created: created ?? null };
  const made = [];
  try {
    await cf.academic.addTrack(pid, "BSc Computer Science");
    let tree = await cf.academic.tree(pid);
    const track = tree?.[0];
    if (!track) return { ok: false, why: "no-track" };

    await cf.academic.addSemester(pid, track.id, "Semester 5");
    tree = await cf.academic.tree(pid);
    const sem = tree?.[0]?.semesters?.[0];
    if (!sem) return { ok: false, why: "no-semester" };

    await cf.academic.addMilestone(pid, sem.id, "Core");
    tree = await cf.academic.tree(pid);
    const ms = tree?.[0]?.semesters?.[0]?.milestones?.[0];
    if (!ms) return { ok: false, why: "no-milestone" };

    for (const [name, code] of [
      ["Design & Analysis of Algorithms", "CS301"],
      ["Operating Systems", "CS305"],
      ["Machine Learning", "CS410"],
    ]) {
      await cf.academic.addSubject(pid, ms.id, name, code);
    }
    tree = await cf.academic.tree(pid);
    const subs = tree?.[0]?.semesters?.[0]?.milestones?.[0]?.subjects || [];
    made.push(...subs.map((s) => s.id));

    const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    if (made[0]) {
      await cf.deadlines.add(pid, made[0], d(1), "assignment", "DP problem set 4 - questions 3, 5, 8", "90 min");
      await cf.deadlines.add(pid, made[0], d(6), "exam", "Midterm - graph algorithms", "");
      await cf.deadlines.add(pid, made[1], d(-2), "gate", "Re-derive the master theorem cases from notes", "");
    }
    return { ok: true, pid, subjects: made.length };
  } catch (e) {
    return { ok: false, why: String(e && e.message) };
  }
});
console.log("seed:", JSON.stringify(seeded));

await win.waitForTimeout(3500);

// Select the seeded profile AFTER the reload: the chosen profile is in-memory state.
await win.locator('button.nav-item:has-text("Profiles")').first().click();
await win.waitForTimeout(1200);
const sel2 = win.locator('button.profile-main').first();
if (await sel2.count()) { await sel2.click(); await win.waitForTimeout(3000); }

// ---- Walk every rail destination by its real label --------------------
const labels = ["Home", "Subjects", "Projects", "Degree", "Labs", "Deadlines", "Goals", "Flashcards", "Project", "Browser", "Settings"];
for (const label of labels) {
  const item = win.locator(`button.nav-item:has-text("${label}")`).first();
  if (!(await item.count())) { console.log("MISSING rail item:", label); continue; }
  if (await item.isDisabled()) { console.log("GATED rail item:", label); continue; }
  await item.click();
  await win.waitForTimeout(1400);
  await shot(`nav-${label.toLowerCase()}`);
}

// ---- Narrow-window behaviour -----------------------------------------
await win.setViewportSize({ width: 900, height: 720 });
await win.locator('button.nav-item:has-text("Home")').first().click();
await shot("narrow-home");
await win.setViewportSize({ width: 1200, height: 820 });
await win.locator('button.nav-item:has-text("Deadlines")').first().click();
await shot("narrow-deadlines");

await app.close();
console.log("DONE ->", OUT);
