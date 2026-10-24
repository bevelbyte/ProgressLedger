import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * W1 item 6 (ledger G11) — the pane trail chevrons, on the REAL surface.
 *
 * The workspace model has recorded a per-pane trail since W1, but for a while
 * nothing READ it: it was write-only. The Space Bunny reference shows
 * back/forward chevrons between the pane number and the tab strip, so the trail
 * now has exactly one consumer — those chevrons — and this spec drives them.
 *
 * The contract under test is back/forward, not undo:
 *   - a back step moves the pointer and leaves the entries AHEAD of the user
 *     alone, so Forward still leads somewhere. Recording the step as a
 *     navigation appended a duplicate at the end and truncated everything ahead
 *     of the pointer, which is precisely the defect this spec pins;
 *   - an entry whose tab was since closed is skipped, so a step can never
 *     strand the pane on a destination that is open nowhere (the Lab's v2.13
 *     fix, and the reason a "walk back to the start" must never end on an empty
 *     pane);
 *   - the trail is per pane: a freshly split pane starts with one entry, so its
 *     own chevrons are disabled while the pane it was split from still has
 *     history to step through.
 *
 * jsdom cannot stand in for this: it renders no layout, has no second pane to
 * confuse, and cannot observe the real buttons' disabled state or the app's own
 * routing.
 */

async function launch() {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cf-trail-"))}`],
    env: { ...process.env, CAREERFLOW_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.setViewportSize({ width: 1600, height: 1000 });
  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
  return { app, win };
}

/**
 * What the shell says about itself right now: the focused identity, the active
 * context, and per pane its tabs and trail readout. `backDisabled` is read off
 * the real button, so it is the same answer a person gets by looking at it.
 */
function readState(win) {
  return win.evaluate(() => {
    const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    return {
      identity: document.querySelector("main.active-view")?.getAttribute("data-subject") ?? null,
      context: norm(document.querySelector(".ctx-chip-wrap.active .ctx-chip")),
      panes: [...document.querySelectorAll("[data-pane-id]")].map((p) => {
        const back = p.querySelector('.pane-trail button[aria-label="Back"]');
        const forward = p.querySelector('.pane-trail button[aria-label="Forward"]');
        return {
          id: p.getAttribute("data-pane-id"),
          focused: p.classList.contains("focused"),
          tabs: [...p.querySelectorAll(".tab-label")].map((t) => t.textContent.trim()),
          activeTab: norm(p.querySelector(".tab-wrap.active .tab-label")),
          backDisabled: back ? back.disabled : null,
          forwardDisabled: forward ? forward.disabled : null,
        };
      }),
    };
  });
}

const backButton = (win, paneId = null) =>
  win.locator(
    `${paneId ? `[data-pane-id='${paneId}'] ` : "[data-pane-id] "}.pane-trail button[aria-label="Back"]`,
  ).first();

const forwardButton = (win) =>
  win.locator('[data-pane-id] .pane-trail button[aria-label="Forward"]').first();

test("the pane trail chevrons step one pane's history and keep forward alive", async () => {
  const { app, win } = await launch();
  try {
    // Subjects and Labs sit on registry planes the SAME context (Study) owns, so
    // both land in one pane — a cross-context pair would exercise routing, not
    // the trail.
    await win.locator('button.nav-item:has-text("Subjects")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("tree");
    await win.locator('button.nav-item:has-text("Labs")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("labs");

    const before = await readState(win);
    expect(before.panes.length).toBe(1);
    expect(before.panes[0].activeTab).toBe("Labs");
    expect(before.panes[0].backDisabled, "there is history to go back to").toBe(false);
    expect(before.panes[0].forwardDisabled, "nothing ahead yet").toBe(true);

    await backButton(win).click();
    await expect.poll(async () => (await readState(win)).identity).toBe("tree");
    const stepped = await readState(win);
    expect(stepped.panes[0].activeTab).toBe("Subjects");
    expect(
      stepped.panes[0].forwardDisabled,
      "a back step must not spend the forward history",
    ).toBe(false);

    await forwardButton(win).click();
    await expect.poll(async () => (await readState(win)).identity).toBe("labs");
  } finally {
    await app.close();
  }
});

test("walking back to the start of the trail never strands the pane", async () => {
  const { app, win } = await launch();
  try {
    await win.locator('button.nav-item:has-text("Subjects")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("tree");
    await win.locator('button.nav-item:has-text("Labs")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("labs");

    // The Study pane is seeded with every destination that context owns, so the
    // walk is bounded by the trail cap, not by the number of destinations.
    let steps = 0;
    for (let i = 0; i < 12; i += 1) {
      if ((await readState(win)).panes[0].backDisabled) break;
      await backButton(win).click();
      await win.waitForTimeout(200);
      steps += 1;

      const after = await readState(win);
      // Every step lands on a destination that is really open: never an empty
      // pane, never a tab that is not in the strip.
      expect(after.identity, `step ${i} stranded the pane`).toBeTruthy();
      expect(after.panes[0].activeTab).toBeTruthy();
      expect(after.panes[0].tabs).toContain(after.panes[0].activeTab);
    }

    const start = await readState(win);
    expect(steps, "the walk must actually step back").toBeGreaterThan(0);
    expect(start.panes[0].backDisabled, "the walk reaches the start of the trail").toBe(true);
    // Subjects is the first destination the Study context seeds.
    expect(start.identity).toBe("tree");
    expect(start.panes[0].activeTab).toBe("Subjects");
  } finally {
    await app.close();
  }
});

test("the trail is per pane: a fresh split has no history of its own", async () => {
  const { app, win } = await launch();
  try {
    await win.locator('button.nav-item:has-text("Subjects")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("tree");
    await win.locator('button.nav-item:has-text("Labs")').first().click();
    await expect.poll(async () => (await readState(win)).identity).toBe("labs");

    await win.locator('button.tool[title^="Split the focused pane"]').first().click();
    await expect.poll(async () => (await readState(win)).panes.length).toBe(2);

    const split = await readState(win);
    const withHistory = split.panes.filter((p) => p.backDisabled === false);
    const fresh = split.panes.filter((p) => p.backDisabled === true);
    expect(
      withHistory.length,
      `exactly one pane carries the history: ${JSON.stringify(split.panes)}`,
    ).toBe(1);
    expect(fresh.length).toBe(1);
    expect(fresh[0].forwardDisabled).toBe(true);
    // The pane the split came from keeps its trail, and its tab list is the one
    // the user built.
    expect(withHistory[0].tabs).toContain("Subjects");
    expect(withHistory[0].tabs).toContain("Labs");

    // Stepping the history-bearing pane touches only that pane.
    await backButton(win, withHistory[0].id).click();
    await win.waitForTimeout(300);
    const after = await readState(win);
    const untouched = after.panes.find((p) => p.id === fresh[0].id);
    expect(untouched.backDisabled).toBe(true);
    expect(untouched.forwardDisabled).toBe(true);
    expect(untouched.tabs).toEqual(fresh[0].tabs);
  } finally {
    await app.close();
  }
});
