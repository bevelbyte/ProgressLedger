import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * W1 item 5 — the subject/context identity contract, on the REAL surface.
 *
 * The shell's `subjectOf` has two branches: a plain surface (keyed by view) and
 * an ENTITY (keyed by the real record the tab is showing). Only the surface
 * branch was reachable, and the multi-pane deep link was a single shell-wide
 * `pendingSubjectId` that every Subjects pane consumed at once — never exercised
 * and impossible to exercise correctly with two panes.
 *
 * This spec drives the real Electron app through the things a person clicks:
 *   - a Today item on the Desk (the app's own `openSubject(subjectId)`, where
 *     the id comes from `academic.tree`, i.e. a real persisted row);
 *   - the rail, the Split control, the Arrange menu's margin shape;
 * and measures what the shell actually reports:
 *   - `main[data-subject]` (the `subjectOf` answer for the focused pane),
 *   - which context chip is active,
 *   - per pane: its tab list and the subject workspace it is rendering.
 *
 * The assertions that matter are the pane ones. With one shared request both
 * panes would have followed the same subject; the contract under test is that
 * each pane carries ITS OWN record, and that a deep link lands in the pane the
 * user is working in.
 *
 * Unit tests cannot stand in for this: jsdom renders no layout, has no second
 * pane to confuse, and cannot tell a real subject id from a string literal.
 */

const SUBJECT_A = "Design & Analysis of Algorithms";
const SUBJECT_B = "Machine Learning";
const DEADLINE_A = "DP problem set 4";
const DEADLINE_B = "ML lab 3";

async function launch() {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cf-subject-"))}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.setViewportSize({ width: 1600, height: 1000 });
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  return { app, win };
}

/**
 * Seed one profile with two real subjects and one deadline for each, through the
 * app's own preload bridge. Returns the subject ids `academic.tree` assigned.
 */
async function seed(win, { a, b, rowA, rowB }) {
  const seeded = await win.evaluate(
    async ({ aName, bName, dA, dB }) => {
      const cf = window.progressLedger;
      const created = await cf.profiles.add("Ada Lovelace", "ada-lovelace");
      const p = created?.profile || created;
      const pid = p?.id ?? p?.profileId;
      if (!pid) return { ok: false, why: "no-profile" };

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

      await cf.academic.addSubject(pid, ms.id, aName, "CS301");
      await cf.academic.addSubject(pid, ms.id, bName, "CS410");
      tree = await cf.academic.tree(pid);
      const subs = tree?.[0]?.semesters?.[0]?.milestones?.[0]?.subjects || [];
      const A = subs.find((s) => s.name === aName);
      const B = subs.find((s) => s.name === bName);
      if (!A || !B) return { ok: false, why: "no-subjects" };

      // Local calendar day strings, so "today" is today for the user too.
      const day = (offset) => {
        const d = new Date();
        const local = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
        return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(
          local.getDate(),
        ).padStart(2, "0")}`;
      };
      await cf.deadlines.add(pid, A.id, day(0), "assignment", dA, "90 min");
      await cf.deadlines.add(pid, B.id, day(0), "assignment", dB, "60 min");

      return { ok: true, pid, a: { id: A.id, name: A.name }, b: { id: B.id, name: B.name } };
    },
    { aName: a, bName: b, dA: rowA, dB: rowB },
  );
  expect(seeded.ok, `seed failed: ${JSON.stringify(seeded)}`).toBe(true);
  return seeded;
}

/** Select the seeded profile through the application's own profile card. */
async function openSeededProfile(win) {
  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  await win.waitForTimeout(900);
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  // `selectProfile` hands off to the user's work once the workspace is
  // addressable; wait for the hand-off rather than assuming its timing.
  await expect
    .poll(async () => (await readState(win)).context, { timeout: 15_000 })
    .toBe("Study");
}

/**
 * What the shell says about itself right now: the `subjectOf` identity for the
 * focused pane, the active context, and every pane's tabs and workspace.
 */
function readState(win) {
  return win.evaluate(() => {
    const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    return {
      identity: document.querySelector("main.active-view")?.getAttribute("data-subject") ?? null,
      context: norm(document.querySelector(".ctx-chip-wrap.active .ctx-chip")),
      panes: [...document.querySelectorAll("[data-pane-id]")].map((p) => ({
        id: p.getAttribute("data-pane-id"),
        focused: p.classList.contains("focused"),
        mode: p.getAttribute("data-pane-mode"),
        tabs: [...p.querySelectorAll(".tab-label")].map((t) => t.textContent.trim()),
        activeTab: norm(p.querySelector(".tab-wrap.active .tab-label")),
        // `.space-head h2` exists only when a subject WORKSPACE is rendered, so
        // this distinguishes "showing CS301" from "showing the Subjects index".
        workspace: norm(p.querySelector(".space-head h2")),
      })),
    };
  });
}

test("a Today item opens its subject in the owning context, identity on the tab", async () => {
  const { app, win } = await launch();
  try {
    const { a } = await seed(win, { a: SUBJECT_A, b: SUBJECT_B, rowA: DEADLINE_A, rowB: DEADLINE_B });

    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
    await openSeededProfile(win);

    // The Desk is a different working context; it has its own identity.
    await win.locator('button.nav-item:has-text("Home")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("home");
    await expect.poll(async () => (await readState(win)).context).toBe("Desk");

    // A real row in the Today agenda → the app's own `openSubject(id)`.
    const row = win.locator(`button.today-item:has-text("${DEADLINE_A}")`).first();
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.click();

    await expect.poll(async () => (await readState(win)).identity).toBe(`tree:${a.id}`);
    const afterOpen = await readState(win);
    // It landed in the context that OWNS Subjects, not in the Desk it was
    // clicked from.
    expect(afterOpen.context).toBe("Study");
    expect(afterOpen.panes.length).toBe(1);
    expect(afterOpen.panes[0].tabs).toContain("Subjects");
    expect(afterOpen.panes[0].workspace).toContain(a.name);

    // The identity is a property of the TAB, not of the navigation event: asking
    // the rail for the same destination again must not drop back to the index.
    await win.locator('button.nav-item:has-text("Subjects")').first().click();
    await win.waitForTimeout(500);
    const afterRail = await readState(win);
    expect(afterRail.identity).toBe(`tree:${a.id}`);
    expect(afterRail.panes[0].workspace).toContain(a.name);

    // …and the Desk is untouched: one pane, its own tab, its own identity.
    await win.locator('button.nav-item:has-text("Home")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("home");
    const desk = await readState(win);
    expect(desk.context).toBe("Desk");
    expect(desk.panes.length).toBe(1);
    expect(desk.panes[0].tabs).toEqual(["Home"]);
  } finally {
    await app.close();
  }
});

test("two panes hold two different subjects, and the deep link lands in the focused one", async () => {
  const { app, win } = await launch();
  try {
    const { a, b } = await seed(win, {
      a: SUBJECT_A,
      b: SUBJECT_B,
      rowA: DEADLINE_A,
      rowB: DEADLINE_B,
    });

    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
    await openSeededProfile(win);

    // 1. Open subject A from the Desk, exactly as in the previous spec.
    await win.locator('button.nav-item:has-text("Home")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("home");
    await win.locator(`button.today-item:has-text("${DEADLINE_A}")`).first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe(`tree:${a.id}`);

    // 2. Split it. The new pane must carry the SAME record — a split is "keep
    //    what you have, then change one side", not "start from the index".
    await win.locator('button.tool[title^="Split the focused pane"]').first().click();
    await expect.poll(async () => (await readState(win)).panes.length).toBe(2);
    const split = await readState(win);
    expect(split.identity).toBe(`tree:${a.id}`);
    expect(split.panes.filter((p) => p.workspace?.includes(a.name)).length).toBe(2);
    const [wasLeft, wasFocused] = split.panes;
    expect(wasFocused.focused).toBe(true);

    // 3. A second CONTEXT is now in play: the Desk, with its own single pane.
    await win.locator('button.nav-item:has-text("Home")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("home");
    const deskBefore = await readState(win);
    expect(deskBefore.context).toBe("Desk");
    expect(deskBefore.panes.length).toBe(1);

    // 4. Deep-link a DIFFERENT subject from the Desk. It must go to the Study
    //    context's FOCUSED pane (the split's new pane) and leave the sibling
    //    pane holding subject A — the case a single shared pendingSubjectId
    //    could not express, and the reason the old path was never exercised.
    await win.locator(`button.today-item:has-text("${DEADLINE_B}")`).first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe(`tree:${b.id}`);

    const deep = await readState(win);
    expect(deep.context).toBe("Study");
    expect(deep.panes.length).toBe(2);
    const showingA = deep.panes.filter((p) => p.workspace?.includes(a.name));
    const showingB = deep.panes.filter((p) => p.workspace?.includes(b.name));
    expect(showingB.length, `exactly one pane follows the deep link: ${JSON.stringify(deep.panes)}`).toBe(1);
    expect(showingA.length, `the sibling pane keeps its own record: ${JSON.stringify(deep.panes)}`).toBe(1);
    // The pane that CHANGED is the pane the user was working in — not merely
    // "whichever pane happened to hold a Subjects tab".
    expect(showingB[0].id).toBe(wasFocused.id);
    expect(showingA[0].id).toBe(wasLeft.id);
    expect(showingB[0].focused).toBe(true);
    // Both panes hold a tab for the SAME destination, with different records:
    // the deep link ADOPTED the split pane's bare seeded Subjects tab (one tab
    // per (view, entity), approved D2-5) and the sibling keeps its own seeded
    // Study destinations.
    expect(showingB[0].tabs.filter((t) => t === "Subjects").length).toBe(2);
    expect(showingA[0].tabs).toContain("Subjects");

    // 5. The Desk still has nothing but its own Home tab: a record-bearing
    //    navigation routes to the domain that owns the destination.
    await win.locator('button.nav-item:has-text("Home")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("home");
    const deskAfter = await readState(win);
    expect(deskAfter.context).toBe("Desk");
    expect(deskAfter.panes.length).toBe(1);
    expect(deskAfter.panes[0].tabs).toEqual(["Home"]);

    // 6. A context chip restores that context's own focus, so the user really is
    //    looking at subject B again (B lives in the split's pane, not in the
    //    first pane that happens to hold a Subjects tab).
    await win.locator('button.ctx-chip[data-ctx="study"]').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe(`tree:${b.id}`);

    // 7. …and identity survives a reshape. Arrange → Margin rebuilds the pane
    //    tree from the tabs already open. Under the approved (view, entity)
    //    fold key (D2-5) the two Subjects records are TWO destinations, so the
    //    reshape keeps BOTH tabs — and the user stays on the record they were
    //    reading rather than being moved to a copy of it.
    await win.locator('button:has-text("Arrange")').first().click();
    await win.locator('[role="menuitem"]:has-text("Margin")').first().click();
    await win.waitForTimeout(700);
    const reshaped = await readState(win);
    expect(reshaped.panes.length).toBe(2);
    expect(reshaped.identity, "a reshape must not move the user to another record").toBe(
      `tree:${b.id}`,
    );
    expect(reshaped.panes.filter((p) => p.workspace?.includes(b.name)).length).toBe(1);
    expect(reshaped.panes.filter((p) => p.workspace?.includes(a.name)).length).toBe(1);
  } finally {
    await app.close();
  }
});
