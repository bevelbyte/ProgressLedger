// W1 visual capture — the workspace model (contexts → panes → tabs).
//
// Same discipline as `cf-visual-round.mjs`: launches the REAL Electron app,
// seeds REAL data through the app's own preload bridge, and drives the surfaces
// with the same inputs a person would use (rail clicks, the real keyboard
// chords, the real Arrange menu). Nothing is stubbed, so what lands in
// `shots/w1/` is what the application actually does.
//
// Writes shots/w1/*.png for comparison against the Space Bunny reference in
// Progress Ledger-FrontendLab/v1/shots.
import { _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "shots/w1";
mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  args: [process.cwd(), `--user-data-dir=${mkdtempSync(join(tmpdir(), "cf-w1-"))}`],
  env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
});
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForTimeout(3500);

const shot = async (name) => {
  await win.waitForTimeout(650);
  await win.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("shot:", name);
};

// 00 — the launch destination: a real profile chooser inside a real pane.
await shot("00-launch-profiles");

// ---- Seed real data so the Spine has real numbers ------------------------
const seeded = await win.evaluate(async () => {
  const cf = window.progressLedger;
  const created = await cf.profiles.add("Ada Lovelace", "ada-lovelace");
  const p = created?.profile || created;
  const pid = p?.id ?? p?.profileId;
  if (!pid) return { ok: false, why: "no-profile" };
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

    // A local-calendar day string, so overdue/today land on the user's day.
    const day = (offset) => {
      const d = new Date();
      const local = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
      return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(
        local.getDate(),
      ).padStart(2, "0")}`;
    };
    if (made[0]) {
      await cf.deadlines.add(pid, made[0], day(0), "assignment", "DP problem set 4", "90 min");
      await cf.deadlines.add(pid, made[0], day(6), "exam", "Midterm — graph algorithms", "");
      await cf.deadlines.add(pid, made[1], day(-2), "gate", "Re-derive the master theorem", "");
    }
    return { ok: true, pid, subjects: made.length };
  } catch (e) {
    return { ok: false, why: String(e && e.message) };
  }
});
console.log("seed:", JSON.stringify(seeded));

// The profile chooser loaded its (empty) list before the seed, so reload to make
// the seeded profile addressable — the same step `smoke.spec.js` takes.
await win.reload();
await win.waitForLoadState("domcontentloaded");
await win.waitForTimeout(2500);

// Select the seeded profile through the application's own action.
await win.locator('button.nav-item:has-text("Profiles")').first().click();
await win.waitForTimeout(1200);
const card = win.locator("button.profile-main").first();
if (await card.count()) {
  await card.click();
  await win.waitForTimeout(3000);
} else {
  console.log("WARN: no profile card rendered — the Spine will read unloaded");
}

// 01 — the Desk, in the context that owns it, with the Spine reading out.
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(1400);
await shot("01-desk-context-spine");

// 02 — a destination in the context that owns it (Deadlines lives in Study).
await win.locator('button.nav-item:has-text("Deadlines")').first().click();
await win.waitForTimeout(1400);
await shot("02-deadlines-context");

// 03 — the same context, on a different tab, without losing the strip.
await win.locator('button.nav-item:has-text("Subjects")').first().click();
await win.waitForTimeout(1400);
await shot("03-study-context");

// 04 — split the focused pane with Ctrl+\ (side by side).
await win.keyboard.press("Control+\\");
await win.waitForTimeout(1000);
await shot("04-split");

// 05 — a second split, stacked, so the layout is a real tree.
await win.keyboard.press("Control+Alt+\\");
await win.waitForTimeout(1000);
await shot("05-split-nested");

// 06 — process modes, and the way back to content.
await win.locator('select[aria-label="Pane mode"]').first().selectOption("ledge");
await win.waitForTimeout(900);
await shot("06-ledge");
await win.locator('select[aria-label="Pane mode"]').first().selectOption("margin");
await win.waitForTimeout(900);
await shot("07-margin");
await win.locator('select[aria-label="Pane mode"]').first().selectOption("content");
await win.waitForTimeout(700);

// 08 — arrangements, from the real menu, on a context with five open tabs.
await win.locator('button:has-text("Arrange")').first().click();
await win.waitForTimeout(400);
await shot("08-arrange-menu");
await win.locator('button[role="menuitem"]:has-text("Trio")').first().click();
await win.waitForTimeout(1300);
await shot("09-arrange-trio");
await win.locator('button:has-text("Arrange")').first().click();
await win.waitForTimeout(300);
await win.locator('button[role="menuitem"]:has-text("Margin")').first().click();
await win.waitForTimeout(1300);
await shot("10-arrange-margin");
await win.locator('button:has-text("Arrange")').first().click();
await win.waitForTimeout(300);
await win.locator('button[role="menuitem"]:has-text("Split")').first().click();
await win.waitForTimeout(1300);
await shot("10b-arrange-split");

// 11 — a new context, empty, saying what it is.
await win.locator("button.ctx-new").first().click();
await win.waitForTimeout(900);
await shot("11-new-context-empty");

// 12 — the numeric rail (Ctrl+B), the Space Bunny instrument readout.
await win.keyboard.press("Control+b");
await win.waitForTimeout(900);
await shot("12-rail-numeric");

// 13 — immerse: the work fills the window.
await win.keyboard.press("Control+Shift+e");
await win.waitForTimeout(900);
await shot("13-immerse");
await win.keyboard.press("Escape");
await win.waitForTimeout(600);

// 14 — the keyboard reference, including the workspace chords.
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(800);
await win.keyboard.press("Control+b"); // back to the labelled rail
await win.keyboard.press("?");
await win.waitForTimeout(900);
await shot("14-keyboard-reference");
await win.keyboard.press("Escape");

// 15 — dense: a narrower window, where pane density actually applies.
await win.setViewportSize({ width: 1180, height: 820 });
await win.locator('button.nav-item:has-text("Subjects")').first().click();
await win.waitForTimeout(1400);
await shot("15-dense-rail");
await win.locator('button:has-text("Arrange")').first().click();
await win.waitForTimeout(300);
await win.locator('button[role="menuitem"]:has-text("Trio")').first().click();
await win.waitForTimeout(1400);
await shot("16-dense-trio");

await app.close();
console.log("DONE ->", OUT);
