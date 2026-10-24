// W1 — workspace model (contexts → panes → tabs).
//
// The model is pure on purpose: every transition takes state and returns new
// state, so the whole workspace can be exercised here in plain Node with no
// rendered component. Each block below also pins one of the Lab's recorded
// weaknesses (`CareerFlow-Frontend-Lab/LAB-CRITIQUE.md`) so a future wave cannot
// quietly reintroduce it.

import { describe, it, expect, beforeEach } from "vitest";

import {
  __resetIdSeq,
  uid,
  PANE_MODES,
  ARRANGEMENTS,
  ARRANGEMENT_LABELS,
  createTab,
  createPane,
  createContext,
  leafOrder,
  paneIds,
  focusedPane,
  activeTabOf,
  focusedView,
  contextCounts,
  subjectOf,
  tabKey,
  pushTrail,
  stepTrail,
  trailState,
  trailTabId,
  withoutTrailEntry,
  activateTrailEntry,
  moveTab,
  openInPane,
  openInFocused,
  openPageTab,
  openView,
  setTabEntity,
  paneWithView,
  activateTab,
  closeTab,
  closeFocusedTab,
  focusPane,
  splitPane,
  closePane,
  setSplitSizes,
  setPaneMode,
  focusDirection,
  applyArrangement,
  activeContext,
  updateContext,
  openContext,
  cycleContext,
  dissolveContext,
  renameContext,
  reopenClosed,
} from "../src/shell/workspace/model.js";
import { CONTEXT_SEEDS, CONTEXT_OWNER, defaultWorkspace } from "../src/shell/workspace/contexts.js";
import { VIEWS } from "../src/shell/view-registry.js";

/** A one-pane context with `views` open in it. */
function ctxWith(...views) {
  return createContext({
    name: "T",
    views: views.map((v) => ({ view: v, label: v })),
  });
}

function wsWith(...contexts) {
  return {
    contexts,
    activeContextId: contexts[0].id,
    lastClosed: null,
    immerse: false,
  };
}

beforeEach(() => {
  __resetIdSeq();
});

describe("ids", () => {
  it("mints deterministic, prefixed ids and resets for tests", () => {
    expect(uid("tab")).toBe("tab-1");
    expect(uid("tab")).toBe("tab-2");
    __resetIdSeq();
    expect(uid("tab")).toBe("tab-1");
  });
});

describe("createContext", () => {
  it("starts with exactly one empty content pane", () => {
    const ctx = createContext({ name: "Desk" });
    expect(paneIds(ctx)).toEqual([ctx.focusedPaneId]);
    expect(ctx.panes[ctx.focusedPaneId].tabs).toEqual([]);
    expect(ctx.panes[ctx.focusedPaneId].mode).toBe("content");
    expect(focusedView(ctx)).toBe(null);
    expect(activeTabOf(focusedPane(ctx))).toBe(null);
    expect(ctx.layout).toEqual({ kind: "pane", paneId: ctx.focusedPaneId });
  });

  it("opens its seed views in order and activates the named one", () => {
    const ctx = createContext({
      name: "Study",
      views: [
        { view: "tree", label: "Subjects" },
        { view: "cgpa", label: "Degree" },
        { view: "labs", label: "Labs" },
      ],
      activeView: "cgpa",
    });
    const pane = focusedPane(ctx);
    expect(pane.tabs.map((t) => t.view)).toEqual(["tree", "cgpa", "labs"]);
    expect(focusedView(ctx)).toBe("cgpa");
    expect(pane.tabs.map((t) => t.label)).toEqual(["Subjects", "Degree", "Labs"]);
  });

  it("keeps the domain (`seed`) separate from the display name", () => {
    const ctx = createContext({ name: "Study", seed: "Study" });
    expect(ctx.seed).toBe("Study");
    expect(renameContext(wsWith(ctx), ctx.id, "Term 2").contexts[0].seed).toBe("Study");
  });
});

describe("context seeds", () => {
  it("only names real destinations", () => {
    const ids = new Set(VIEWS.map((v) => v.id));
    for (const seed of CONTEXT_SEEDS) {
      for (const v of seed.views) {
        expect(ids.has(v.view), `${seed.name} → ${v.view}`).toBe(true);
      }
    }
  });

  it("gives every view at most one owning domain, and no destination is invented", () => {
    const ids = new Set(VIEWS.map((v) => v.id));
    for (const [view, owner] of Object.entries(CONTEXT_OWNER)) {
      expect(ids.has(view), `${view} owner`).toBe(true);
      expect(CONTEXT_SEEDS.some((s) => s.name === owner), `${owner} seeded`).toBe(true);
    }
    // The launch route must be owned, or the boot context would have no tab.
    expect(CONTEXT_OWNER.profiles).toBeTruthy();
  });

  it("owns EVERY registry view exactly once — the taxonomy is derived, not hand-listed (G12)", () => {
    // The drift this pins: the first hand-grouping left Projects unowned and
    // put Goals/Career in Operator against their registry plane. Ownership now
    // derives from PLANE_TO_CONTEXT, so every view lands somewhere by
    // construction — and the reconciled mapping is asserted explicitly.
    for (const v of VIEWS) {
      expect(CONTEXT_OWNER[v.id], `${v.id} has an owning domain`).toBeTruthy();
    }
    expect(Object.keys(CONTEXT_OWNER).length).toBe(VIEWS.length);

    expect(CONTEXT_OWNER.tree).toBe("Study");
    expect(CONTEXT_OWNER.projects).toBe("Study");
    expect(CONTEXT_OWNER.deadlines).toBe("Study");
    expect(CONTEXT_OWNER.goals).toBe("Study"); // plane `plan`, not Operator
    expect(CONTEXT_OWNER.career).toBe("Study"); // plane `plan`, not Operator
    expect(CONTEXT_OWNER.project).toBe("Operator");
    expect(CONTEXT_OWNER.browser).toBe("Operator");
    // The embedded browser's page surface is OWNED but not SEEDED: it is a
    // destination belonging to the machine plane, and a bare "Page" tab at boot
    // would be a lie about what is open (see contexts.js).
    expect(CONTEXT_OWNER.page).toBe("Operator");
    expect(CONTEXT_OWNER.home).toBe("Desk");
    expect(CONTEXT_OWNER.flashcards).toBe("Library");
    expect(CONTEXT_OWNER.profiles).toBe("System");
  });

  it("owns hidden surfaces without seeding them as bare tabs (D2-D6 Phase 1)", () => {
    const hidden = VIEWS.filter((v) => v.hidden === true);
    expect(hidden.map((v) => v.id)).toEqual(["page"]);
    expect(VIEWS.find((v) => v.id === "research-ledger").seed).toBe(false);
    const seeded = new Set(CONTEXT_SEEDS.flatMap((s) => s.views.map((v) => v.view)));
    for (const v of hidden) {
      expect(CONTEXT_OWNER[v.id], `${v.id} is owned`).toBeTruthy();
      expect(seeded.has(v.id), `${v.id} is not seeded`).toBe(false);
    }
    // The boot workspace therefore has no page tab until one is opened.
    const ws = defaultWorkspace();
    const views = ws.contexts.flatMap((c) =>
      Object.values(c.panes).flatMap((p) => p.tabs.map((t) => t.view)),
    );
    expect(views.includes("page")).toBe(false);
  });

  it("boots on the context that owns `profiles`, with profiles active", () => {
    const ws = defaultWorkspace();
    const active = activeContext(ws);
    expect(CONTEXT_OWNER.profiles).toBe(active.seed);
    expect(focusedView(active)).toBe("profiles");
    expect(ws.immerse).toBe(false);
    expect(ws.lastClosed).toBe(null);
  });

  it("seeds every context with at least one open tab", () => {
    for (const ctx of defaultWorkspace().contexts) {
      expect(contextCounts(ctx).tabs, ctx.name).toBeGreaterThan(0);
      expect(contextCounts(ctx).panes).toBe(1);
    }
  });
});

describe("tabs", () => {
  it("dedupes by (view, entity): opening the same destination twice focuses it", () => {
    let ctx = ctxWith("home");
    ctx = openInPane(ctx, focusedPane(ctx).id, "home");
    expect(focusedPane(ctx).tabs.length).toBe(1);
  });

  it("appends and activates a new destination", () => {
    let ctx = ctxWith("home");
    ctx = openInFocused(ctx, "tree", "Subjects");
    expect(focusedPane(ctx).tabs.map((t) => t.view)).toEqual(["home", "tree"]);
    expect(focusedView(ctx)).toBe("tree");
  });

  it("activates an existing tab wherever it lives in the context", () => {
    let ctx = ctxWith("home");
    const first = ctx.focusedPaneId;
    ctx = splitPane(ctx, "row", { view: "tree", label: "Subjects" });
    const second = ctx.focusedPaneId;
    expect(second).not.toBe(first);

    // `tree` lives in pane 2; navigating to it must focus pane 2, not duplicate.
    ctx = openView(ctx, "tree");
    expect(ctx.focusedPaneId).toBe(second);
    expect(paneWithView(ctx, "tree")).toBe(second);
    const total = paneIds(ctx).reduce((n, id) => n + ctx.panes[id].tabs.length, 0);
    expect(total).toBe(2);
  });

  it("closes a tab and falls forward to the neighbour, then back", () => {
    let ctx = createContext({
      name: "T",
      views: [{ view: "a" }, { view: "b" }, { view: "c" }],
      activeView: "b",
    });
    const pane = focusedPane(ctx);
    const [a, b, c] = pane.tabs;

    ctx = closeTab(ctx, pane.id, b.id);
    expect(activeTabOf(focusedPane(ctx)).view).toBe("c"); // fell forward

    ctx = closeTab(ctx, ctx.focusedPaneId, c.id);
    expect(activeTabOf(focusedPane(ctx)).view).toBe("a"); // then back
  });

  it("collapses a split when closing empties a pane, and keeps the last pane", () => {
    let ctx = ctxWith("home");
    const first = ctx.focusedPaneId;
    ctx = splitPane(ctx, "row", { view: "tree" });
    const second = ctx.focusedPaneId;

    ctx = closeFocusedTab(ctx);
    expect(paneIds(ctx)).toEqual([first]);
    expect(ctx.layout.kind).toBe("pane");
    expect(ctx.focusedPaneId).toBe(first);

    // The last pane is kept even when empty: a context always has a stage.
    ctx = closeFocusedTab(ctx);
    expect(paneIds(ctx)).toEqual([first]);
    expect(focusedView(ctx)).toBe(null);
  });

});

describe("trail (route-level back/forward)", () => {
  it("records the TABS a pane has shown and moves a pointer", () => {
    // Entries are tab ids, not view names (design 2.3.1): a view name cannot
    // tell two records of one destination apart, which is exactly what two web
    // pages in one pane are.
    let pane = createPane();
    pane = pushTrail(pane, "tab-home");
    pane = pushTrail(pane, "tab-tree");
    pane = pushTrail(pane, "tab-labs");
    expect(pane.trail).toEqual(["tab-home", "tab-tree", "tab-labs"]);
    expect(trailState(pane)).toEqual({ canBack: true, canFwd: false });

    pane = stepTrail(pane, -1);
    expect(trailTabId(pane)).toBe("tab-tree");
    expect(trailState(pane)).toEqual({ canBack: true, canFwd: true });

    pane = stepTrail(pane, 1);
    expect(trailState(pane)).toEqual({ canBack: true, canFwd: false });
  });

  it("does not wrap at either end", () => {
    let pane = pushTrail(createPane(), "tab-home");
    expect(stepTrail(pane, -1)).toBe(pane);
    expect(stepTrail(pane, 1)).toBe(pane);
  });

  it("truncates the forward branch when a new tab is pushed", () => {
    // Lab weakness #9: a tab-activation history presented with browser arrows.
    // A real history drops the forward entries the moment you go somewhere new.
    let pane = createPane();
    for (const id of ["tab-home", "tab-tree", "tab-labs"]) pane = pushTrail(pane, id);
    pane = stepTrail(pane, -1); // pointer on tree
    pane = pushTrail(pane, "tab-cgpa");
    expect(pane.trail).toEqual(["tab-home", "tab-tree", "tab-cgpa"]);
    expect(trailState(pane).canFwd).toBe(false);
  });

  it("does not record the same tab twice in a row", () => {
    let pane = pushTrail(createPane(), "tab-home");
    pane = pushTrail(pane, "tab-home");
    expect(pane.trail).toEqual(["tab-home"]);
  });

  it("keys every entry by the tab itself, so two pages in one pane are two entries (design 2.3.1)", () => {
    let ctx = ctxWith("home");
    const paneId = ctx.focusedPaneId;
    ctx = openInPane(ctx, paneId, "page", "Web page", "bp-1");
    ctx = openInPane(ctx, paneId, "page", "Web page", "bp-2");

    const pane = ctx.panes[paneId];
    const pages = pane.tabs.filter((t) => t.view === "page");
    expect(pages.map((t) => t.entity)).toEqual(["bp-1", "bp-2"]);

    // The two entries are DIFFERENT ids even though both tabs share a view —
    // with view-named entries this list would read ["home", "page", "page"] and
    // a Back step had to guess which page it meant.
    expect(pane.trail).toEqual([pane.tabs[0].id, pages[0].id, pages[1].id]);
    expect(trailTabId(pane)).toBe(pages[1].id);

    const stepped = stepTrail(pane, -1);
    expect(trailTabId(stepped)).toBe(pages[0].id);
    const steppedCtx = activateTrailEntry(ctx, paneId, trailTabId(stepped), stepped.trailAt);
    expect(activeTabOf(steppedCtx.panes[paneId]).entity).toBe("bp-1");
  });

  it("moves the pointer without recording a navigation, so forward survives", () => {
    // The G11 defect this pins: a trail step used to run through `activateTab`,
    // which is a NAVIGATION. It appended the target view and truncated the
    // entries ahead of the pointer, so Forward could never move again and the
    // chevrons behaved as an undo button.
    let ctx = ctxWith("home", "settings", "labs");
    const paneId = ctx.focusedPaneId;
    const pane = ctx.panes[paneId];
    const ids = pane.tabs.map((t) => t.id);
    expect(pane.trail).toEqual(ids);

    const stepped = stepTrail(pane, -1); // pointer onto settings
    const settings = pane.tabs.find((t) => t.view === "settings");
    ctx = activateTrailEntry(ctx, paneId, settings.id, stepped.trailAt);

    const after = ctx.panes[paneId];
    expect(after.trail).toEqual(ids); // trail untouched
    expect(after.trailAt).toBe(1);
    expect(activeTabOf(after).view).toBe("settings");
    expect(trailState(after)).toEqual({ canBack: true, canFwd: true });

    // …and the forward entry is still reachable, naming labs' own tab.
    expect(trailTabId(stepTrail(after, 1))).toBe(ids[2]);
  });

  it("refuses a trail activation of a tab that is not in the pane", () => {
    const ctx = ctxWith("home");
    expect(activateTrailEntry(ctx, ctx.focusedPaneId, "tab-nope", 0)).toBe(ctx);
  });

  it("takes a closed tab's history with it, leaving the pointer on a live entry", () => {
    let ctx = ctxWith("home", "tree", "labs");
    const paneId = ctx.focusedPaneId;
    const pane = ctx.panes[paneId];
    const tree = pane.tabs.find((t) => t.view === "tree");

    ctx = closeTab(ctx, paneId, tree.id);
    const after = ctx.panes[paneId];
    expect(after.trail.includes(tree.id), "the closed tab's entry is gone").toBe(false);
    expect(after.trail).toEqual([after.tabs[0].id, after.tabs[1].id]);
    // The pointer sits on the tab the pane is actually showing, not on a gap.
    expect(trailTabId(after)).toBe(after.activeTabId);
    expect(trailState(after).canFwd).toBe(false);
  });

  it("withoutTrailEntry is a no-op for a tab the pane never recorded", () => {
    const pane = createPane();
    expect(withoutTrailEntry(pane, "tab-nope")).toBe(pane);
  });
});

describe("moving a tab between panes (Space Bunny's ws.moveTab)", () => {
  function twoPanes(views = ["home", "tree"]) {
    const ctx = ctxWith(...views);
    const left = ctx.focusedPaneId;
    const split = splitPane(ctx, "row", { view: "settings" });
    const right = split.focusedPaneId;
    return { ctx: split, left, right };
  }

  it("moves the tab with its identity, activates it and focuses the target pane", () => {
    const { ctx, left, right } = twoPanes();
    const tree = ctx.panes[left].tabs.find((t) => t.view === "tree");

    const after = moveTab(ctx, left, tree.id, right);
    expect(after.panes[left].tabs.some((t) => t.id === tree.id)).toBe(false);
    const moved = after.panes[right].tabs.find((t) => t.id === tree.id);
    expect(moved, "the SAME tab id arrives — a move is not a re-open").toBeTruthy();
    expect(moved.entity).toBe(tree.entity);
    expect(after.panes[right].activeTabId).toBe(tree.id);
    expect(after.focusedPaneId).toBe(right);
    expect(trailTabId(after.panes[right])).toBe(tree.id);
  });

  it("carries a page tab's entity across, so the page is the same page", () => {
    let ctx = ctxWith("home");
    const left = ctx.focusedPaneId;
    ctx = openInPane(ctx, left, "page", "Web page", "bp-7");
    const split = splitPane(ctx, "row", { view: "settings" });
    const right = split.focusedPaneId;
    const page = ctx.panes[left].tabs.find((t) => t.view === "page");

    const after = moveTab(split, left, page.id, right);
    expect(after.panes[right].tabs.find((t) => t.id === page.id)?.entity).toBe("bp-7");
  });

  it("drops the moved tab's entries from the pane it left", () => {
    const { ctx, left, right } = twoPanes();
    const pane = ctx.panes[left];
    const tree = pane.tabs.find((t) => t.view === "tree");
    expect(pane.trail).toContain(tree.id);

    const after = moveTab(ctx, left, tree.id, right);
    expect(after.panes[left].trail.includes(tree.id)).toBe(false);
    expect(trailState(after.panes[left])).toEqual({ canBack: false, canFwd: false });
  });

  it("collapses a source pane the move emptied, exactly as closing its last tab does", () => {
    const { ctx, left, right } = twoPanes(["home"]);
    expect(ctx.panes[left].tabs.length).toBe(1);
    const home = ctx.panes[left].tabs[0];

    const after = moveTab(ctx, left, home.id, right);
    expect(paneIds(after)).toEqual([right]);
    expect(after.layout.kind).toBe("pane");
    expect(after.panes[right].tabs.some((t) => t.id === home.id)).toBe(true);
    expect(after.focusedPaneId).toBe(right);
  });

  it("refuses a move onto the same pane, an unknown tab or an unknown target", () => {
    const { ctx, left, right } = twoPanes();
    expect(moveTab(ctx, left, ctx.panes[left].tabs[0].id, left)).toBe(ctx);
    expect(moveTab(ctx, left, "tab-nope", right)).toBe(ctx);
    expect(moveTab(ctx, left, ctx.panes[left].tabs[0].id, "pane-nope")).toBe(ctx);
  });
});

describe("panes, splits and focus", () => {
  it("splits the focused pane in the given direction with an even split", () => {
    const ctx = splitPane(ctxWith("home"), "col", { view: "tree" });
    expect(ctx.layout.kind).toBe("split");
    expect(ctx.layout.dir).toBe("col");
    expect(ctx.layout.sizes).toEqual([0.5, 0.5]);
    expect(paneIds(ctx).length).toBe(2);
    expect(ctx.focusedPaneId).toBe(ctx.layout.children[1].paneId);
    expect(contextCounts(ctx).panes).toBe(2);
    expect(contextCounts(ctx).tabs).toBe(2);
  });

  it("rewrites split sizes", () => {
    let ctx = splitPane(ctxWith("home"), "row", { view: "tree" });
    ctx = setSplitSizes(ctx, ctx.layout.id, [0.7, 0.3]);
    expect(ctx.layout.sizes).toEqual([0.7, 0.3]);
  });

  it("drops a pane and collapses the split, never the last pane", () => {
    let ctx = splitPane(ctxWith("home"), "row", { view: "tree" });
    const [a, b] = paneIds(ctx);
    ctx = closePane(ctx, b);
    expect(paneIds(ctx)).toEqual([a]);
    expect(ctx.layout.kind).toBe("pane");
    expect(closePane(ctx, a)).toBe(ctx);
  });

  it("reports panes in visual order, not object-key order", () => {
    // Lab weakness #4: pane numbers came from key order, so a split could be
    // labelled out of order. `leafOrder` is the single source of that order.
    let ctx = splitPane(ctxWith("a"), "row", { view: "b" });
    const [first, second] = paneIds(ctx);
    ctx = splitPane(ctx, "col", { view: "c" });
    const order = leafOrder(ctx.layout, ctx.panes);
    expect(order[0]).toBe(first);
    expect(order).toContain(second);
    expect(order.length).toBe(3);
  });

  it("moves focus geometrically and does not wrap at the edge", () => {
    let ctx = splitPane(ctxWith("a"), "row", { view: "b" });
    const [left, right] = paneIds(ctx);
    expect(ctx.focusedPaneId).toBe(right);

    ctx = focusDirection(ctx, "left");
    expect(ctx.focusedPaneId).toBe(left);
    expect(focusDirection(ctx, "left")).toBe(ctx); // edge: no-op
  });

  it("climbs out of a nested split into the sibling pane", () => {
    let ctx = splitPane(ctxWith("a"), "row", { view: "b" }); // [a | b]
    const [left, right] = paneIds(ctx);
    ctx = focusPane(ctx, right);
    ctx = splitPane(ctx, "col", { view: "c" }); // [a | [b / c]]
    expect(paneIds(ctx)).toEqual([left, right, ctx.focusedPaneId]);

    // Down from the top-right pane lands on the bottom-right pane, not on `a`.
    const bottom = ctx.focusedPaneId;
    ctx = focusPane(ctx, right);
    ctx = focusDirection(ctx, "down");
    expect(ctx.focusedPaneId).toBe(bottom);

    // Left from the bottom-right pane crosses the outer split to `a`.
    ctx = focusDirection(ctx, "left");
    expect(ctx.focusedPaneId).toBe(left);
  });

  it("ignores focusing a pane that does not exist", () => {
    const ctx = ctxWith("a");
    expect(focusPane(ctx, "nope")).toBe(ctx);
  });

  it("makes a redundant focus a no-op that keeps the context object (Phase 2)", () => {
    // The shell's focus-from-native effect both READS the workspace and WRITES
    // it. A focus that changes nothing but still minted a new context would
    // dirty the effect's own dependency, so Svelte would abort the graph
    // (`effect_update_depth_exceeded`). No change, no new object.
    const ctx = ctxWith("a");
    expect(focusPane(ctx, ctx.focusedPaneId)).toBe(ctx);
  });
});

describe("pane modes", () => {
  it("offers content as a first-class destination in both directions", () => {
    // Lab weakness #2: a pane could become a margin and never return.
    expect(PANE_MODES).toContain("content");
    let ctx = splitPane(ctxWith("a"), "row", { view: "b" });
    const target = ctx.focusedPaneId;

    ctx = setPaneMode(ctx, target, "margin");
    expect(ctx.panes[target].mode).toBe("margin");
    expect(ctx.panes[target].boundTo).toBe(paneIds(ctx)[0]);

    ctx = setPaneMode(ctx, target, "content");
    expect(ctx.panes[target].mode).toBe("content");
    expect(ctx.panes[target].boundTo).toBe(null);
  });

  it("refuses to make the only pane a margin — a margin of nothing", () => {
    const ctx = ctxWith("a");
    expect(setPaneMode(ctx, ctx.focusedPaneId, "margin")).toBe(ctx);
  });

  it("refuses an unknown mode", () => {
    const ctx = splitPane(ctxWith("a"), "row", { view: "b" });
    expect(setPaneMode(ctx, ctx.focusedPaneId, "pod")).toBe(ctx);
  });
});

describe("arrangements", () => {
  const four = () =>
    createContext({
      name: "T",
      views: [{ view: "a" }, { view: "b" }, { view: "c" }, { view: "d" }],
      activeView: "c",
    });

  it("declares all five arrangements with labels", () => {
    expect(ARRANGEMENTS).toEqual(["single", "split", "margin", "trio", "ledge"]);
    for (const arr of ARRANGEMENTS) expect(ARRANGEMENT_LABELS[arr]).toBeTruthy();
  });

  it("redistributes the tabs it already has and closes nothing", () => {
    const before = ctxWith("a", "b", "c");
    for (const arr of ARRANGEMENTS) {
      const after = applyArrangement(before, arr);
      const views = paneIds(after)
        .flatMap((id) => after.panes[id].tabs.map((t) => t.view))
        .sort();
      expect(views, arr).toEqual(["a", "b", "c"]);
    }
  });

  it("keeps the user where they were (the pane holding the active view)", () => {
    const after = applyArrangement(four(), "split");
    expect(focusedView(after)).toBe("c");
  });

  it("keeps BOTH records when one destination is open twice — the fold key is (view, entity) (D2-5)", () => {
    // Two panes, one destination, two different records. The approved D2-5 key
    // means a reshape keeps BOTH tabs instead of silently dropping the record
    // the user was not focused on — and the focused record stays focused.
    let ctx = splitPane(ctxWith("tree"), "row", { view: "tree", label: "tree", entity: 1 });
    const [left, right] = paneIds(ctx);
    ctx = setTabEntity(ctx, left, ctx.panes[left].tabs[0].id, 2);
    expect(focusedPane(ctx).id).toBe(right);
    expect(ctx.panes[right].tabs[0].entity).toBe(1);

    const after = applyArrangement(ctx, "margin");
    const survivors = paneIds(after)
      .flatMap((id) => after.panes[id].tabs)
      .filter((t) => t.view === "tree");
    expect(survivors.map((t) => t.entity).sort((a, b) => a - b)).toEqual([1, 2]);
    // …and the user is still on the record they were reading.
    expect(after.panes[after.focusedPaneId].tabs.some((t) => t.entity === 1)).toBe(true);
  });

  it("keeps a plain surface's absence of a record through a reshape", () => {
    // Nothing was open anywhere, so nothing may be invented.
    const after = applyArrangement(ctxWith("tree"), "split");
    const tab = paneIds(after)
      .flatMap((id) => after.panes[id].tabs)
      .find((t) => t.view === "tree");
    expect(tab.entity).toBe(null);
  });

  it("builds the shapes the reference shows", () => {
    const fourCtx = four();

    const single = applyArrangement(fourCtx, "single");
    expect(single.layout.kind).toBe("pane");
    expect(single.panes[single.layout.paneId].tabs.length).toBe(4);

    const split = applyArrangement(fourCtx, "split");
    expect(split.layout.kind).toBe("split");
    expect(split.layout.dir).toBe("row");
    expect(split.layout.children.length).toBe(2);

    const trio = applyArrangement(fourCtx, "trio");
    expect(trio.layout.children.length).toBe(3);

    const margin = applyArrangement(fourCtx, "margin");
    expect(margin.layout.children.length).toBe(2);
    const marginPanes = paneIds(margin).map((id) => margin.panes[id]);
    expect(marginPanes.map((p) => p.mode)).toEqual(["content", "margin"]);
    expect(marginPanes[1].boundTo).toBe(marginPanes[0].id);

    const ledge = applyArrangement(fourCtx, "ledge");
    expect(ledge.layout.dir).toBe("col");
    expect(paneIds(ledge).map((id) => ledge.panes[id].mode)).toEqual(["content", "ledge"]);
  });

  it("carries a surviving pane's mode forward instead of dropping it", () => {
    // Lab weakness #6: changing arrangement silently lost pane modes.
    let ctx = splitPane(ctxWith("a"), "row", { view: "b" });
    const target = ctx.focusedPaneId;
    ctx = setPaneMode(ctx, target, "content");
    ctx = { ...ctx, panes: { ...ctx.panes, [target]: { ...ctx.panes[target], mode: "ledge" } } };

    const after = applyArrangement(ctx, "split");
    // Recomposition mints fresh panes, so the honest guarantee is narrower: the
    // surviving content/ledge shape is rebuilt and the ledge mode reappears
    // rather than being silently discarded.
    expect(paneIds(after).length).toBe(2);
    expect(paneIds(after).some((id) => after.panes[id].mode === "ledge")).toBe(true);
  });

  it("degenerates to a single pane rather than inventing empty ones", () => {
    const two = applyArrangement(ctxWith("a", "b"), "trio");
    expect(two.layout.kind).toBe("pane");
    const one = applyArrangement(ctxWith("a"), "ledge");
    expect(one.layout.kind).toBe("pane");
  });

  it("ignores an unknown arrangement", () => {
    const ctx = four();
    expect(applyArrangement(ctx, "spiral")).toBe(ctx);
  });
});

describe("subject contract", () => {
  it("identifies a plain surface by view", () => {
    expect(subjectOf("tree", "Subjects")).toEqual({
      key: "tree",
      view: "tree",
      kind: "surface",
      label: "Subjects",
    });
  });

  it("identifies an entity and keys on it, so two subjects are two subjects", () => {
    const a = subjectOf("tree", "Subjects", "42");
    const b = subjectOf("tree", "Subjects", "43");
    expect(a.kind).toBe("entity");
    expect(a.key).toBe("tree:42");
    expect(a.label).toBe("42");
    expect(a.key).not.toBe(b.key);
  });

  // The contract is only real if a tab can actually CARRY a record. These four
  // transitions are what wire it to one (`App.openSubject` → `store.navigate`).
  it("opening a DIFFERENT record opens a second tab — one tab per (view, entity) (D2-5)", () => {
    let ctx = ctxWith("tree");
    const paneId = focusedPane(ctx).id;
    ctx = openInPane(ctx, paneId, "tree", "Subjects", 42);
    expect(contextCounts(ctx).tabs).toBe(1);
    expect(activeTabOf(focusedPane(ctx)).entity).toBe(42);

    // A different record of the same destination is its own tab now, exactly
    // like two browser pages in one pane.
    ctx = openInPane(ctx, paneId, "tree", "Subjects", 43);
    expect(contextCounts(ctx).tabs).toBe(2);
    expect(activeTabOf(focusedPane(ctx)).entity).toBe(43);
    // …and the shell's one answer to "what is on screen" follows the tab.
    const tab = activeTabOf(focusedPane(ctx));
    expect(subjectOf(tab.view, tab.label, tab.entity).key).toBe("tree:43");
  });

  it("a record-free open leaves the identity you were reading alone", () => {
    let ctx = ctxWith("tree");
    const paneId = focusedPane(ctx).id;
    ctx = openInPane(ctx, paneId, "tree", "Subjects", 42);
    // A rail click on Subjects must not silently drop back to the index.
    ctx = openInPane(ctx, paneId, "tree", "Subjects");
    expect(activeTabOf(focusedPane(ctx)).entity).toBe(42);
  });

  it("opening a bare destination focuses the record tab without inventing a third tab", () => {
    let ctx = ctxWith("home");
    const paneId = focusedPane(ctx).id;
    ctx = openInPane(ctx, paneId, "tree", "Subjects", 42);
    const before = activeTabOf(focusedPane(ctx));
    ctx = openInPane(ctx, paneId, "tree", "Subjects");
    expect(contextCounts(ctx).tabs).toBe(2); // home + the one tree tab
    const after = activeTabOf(focusedPane(ctx));
    expect(after.id).toBe(before.id);
    expect(after.entity).toBe(42);
  });

  it("two page tabs coexist — the D2-5 key is (view, entity), not view (D2-D6 Phase 2)", () => {
    let ctx = ctxWith("home");
    const paneId = focusedPane(ctx).id;
    // The placeholder flow: a bare "page" tab adopts the first page opened in it.
    ctx = openInPane(ctx, paneId, "page", "Web page");
    ctx = openInPane(ctx, paneId, "page", "Web page", "bp-1");
    expect(contextCounts(ctx).tabs).toBe(2); // home + the adopted page tab
    expect(activeTabOf(focusedPane(ctx)).entity).toBe("bp-1");
    // A second page is a SECOND tab, not a re-point of the first.
    ctx = openInPane(ctx, paneId, "page", "Web page", "bp-2");
    expect(contextCounts(ctx).tabs).toBe(3);
    const pages = focusedPane(ctx).tabs.filter((t) => t.view === "page");
    expect(pages.map((t) => t.entity)).toEqual(["bp-1", "bp-2"]);
  });

  it("the New web page control ALWAYS adds a page slot, never re-focuses one (D2-D6 Phase 2)", () => {
    let ctx = ctxWith("home");
    const paneId = focusedPane(ctx).id;
    // The rail rule would give this pane ONE page tab and then keep focusing
    // it; "New web page" must instead give the pane another slot each press.
    ctx = openPageTab(ctx, paneId, "Web page");
    ctx = openPageTab(ctx, paneId, "Web page");
    const bare = focusedPane(ctx).tabs.filter((t) => t.view === "page");
    expect(bare.length, "two presses, two page slots").toBe(2);
    expect(bare.every((t) => t.entity === null)).toBe(true);

    // …so two real pages can end up in ONE pane, each on its own tab.
    ctx = setTabEntity(ctx, paneId, bare[0].id, "bp-1");
    ctx = setTabEntity(ctx, paneId, bare[1].id, "bp-2");
    const pages = focusedPane(ctx).tabs.filter((t) => t.view === "page");
    expect(pages.map((t) => t.entity)).toEqual(["bp-1", "bp-2"]);
    expect(activeTabOf(focusedPane(ctx)).entity).toBe("bp-2");
  });

  it("tabKey separates a bare tab from its record-bearing siblings (D2-5)", () => {
    expect(tabKey({ view: "page", entity: null })).toBe("view:page");
    expect(tabKey({ view: "page", entity: "bp-1" })).toBe("view:page|entity:bp-1");
    expect(tabKey({ view: "tree", entity: 42 })).toBe("view:tree|entity:42");
    // String coercion: a numeric row id and its string form are ONE record.
    expect(tabKey({ view: "tree", entity: 42 })).toBe(tabKey({ view: "tree", entity: "42" }));
  });

  it("openView re-points a tab that lives in another pane", () => {
    let ctx = ctxWith("home", "tree");
    ctx = splitPane(ctx, "row", { view: "tree", label: "Subjects", entity: 7 });
    const [left, right] = paneIds(ctx);
    expect(ctx.panes[right].tabs[0].entity).toBe(7);

    // The plain-destination rule is unchanged: find the tab that already holds
    // the view, wherever it is, instead of opening a second one.
    ctx = openView(ctx, "tree", "Subjects", 9);
    expect(contextCounts(ctx).tabs).toBe(3);
    expect(ctx.panes[left].tabs.find((t) => t.view === "tree").entity).toBe(9);
    // …and the sibling pane keeps its own copy of that destination untouched.
    expect(ctx.panes[right].tabs[0].entity).toBe(7);
  });

  it("sets and clears a tab's record, and ignores a no-op", () => {
    let ctx = ctxWith("tree");
    const paneId = focusedPane(ctx).id;
    const tabId = ctx.panes[paneId].tabs[0].id;

    ctx = setTabEntity(ctx, paneId, tabId, 42);
    expect(ctx.panes[paneId].tabs[0].entity).toBe(42);
    // Assigning what is already there returns the same state (no rerender churn).
    expect(setTabEntity(ctx, paneId, tabId, 42)).toBe(ctx);

    ctx = setTabEntity(ctx, paneId, tabId, null);
    expect(ctx.panes[paneId].tabs[0].entity).toBe(null);
    expect(setTabEntity(ctx, paneId, tabId, null)).toBe(ctx);
    // An unknown pane or tab is a no-op, not a throw.
    expect(setTabEntity(ctx, "missing", tabId, 1)).toBe(ctx);
    expect(setTabEntity(ctx, paneId, "missing", 1)).toBe(ctx);
  });

  it("a split seeds the new pane with the record you were reading", () => {
    const ctx = splitPane(ctxWith("tree"), "col", {
      view: "tree",
      label: "Subjects",
      entity: 12,
    });
    const [left, right] = paneIds(ctx);
    expect(ctx.panes[left].tabs[0].entity).toBe(null);
    expect(ctx.panes[right].tabs[0].entity).toBe(12);
  });
});

describe("contexts (workspace level)", () => {
  const two = () => wsWith(ctxWith("home"), ctxWith("profiles"));

  it("resolves the active context and falls back to the first", () => {
    const ws = two();
    expect(activeContext(ws).id).toBe(ws.contexts[0].id);
    expect(activeContext({ ...ws, activeContextId: "missing" }).id).toBe(ws.contexts[0].id);
  });

  it("switches only to a context that exists", () => {
    const ws = two();
    const target = ws.contexts[1].id;
    expect(openContext(ws, target).activeContextId).toBe(target);
    expect(openContext(ws, "missing")).toBe(ws);
  });

  it("cycles contexts and wraps, and does nothing with one context", () => {
    const ws = two();
    expect(cycleContext(ws, 1).activeContextId).toBe(ws.contexts[1].id);
    expect(cycleContext(ws, 1).activeContextId).not.toBe(ws.contexts[0].id);
    const wrapped = cycleContext({ ...ws, activeContextId: ws.contexts[1].id }, 1);
    expect(wrapped.activeContextId).toBe(ws.contexts[0].id);
    expect(cycleContext(wsWith(ctxWith("home")), 1).contexts.length).toBe(1);
  });

  it("dissolves a context but never the last one", () => {
    const ws = two();
    const gone = dissolveContext(ws, ws.contexts[1].id);
    expect(gone.contexts.length).toBe(1);
    expect(gone.activeContextId).toBe(gone.contexts[0].id);
    expect(dissolveContext(gone, gone.contexts[0].id)).toBe(gone);
  });

  it("updates a single context immutably", () => {
    const ws = two();
    const next = updateContext(ws, ws.contexts[1].id, (c) => ({ ...c, name: "Renamed" }));
    expect(next.contexts[1].name).toBe("Renamed");
    expect(next.contexts[0]).toBe(ws.contexts[0]);
    expect(ws.contexts[1].name).not.toBe("Renamed");
  });
});

describe("reopen last closed tab", () => {
  it("restores the tab (entity included) in the context it came from, and makes that context active", () => {
    // The store writes `lastClosed` when a tab closes; the model owns the
    // restore. Build that shape directly.
    let ctx = ctxWith("home", "tree");
    const pane = focusedPane(ctx);
    const tab = ctx.panes[pane.id].tabs[1];
    const ws = {
      // Two contexts, so "park the user elsewhere" is expressible at all.
      ...wsWith(ctx, ctxWith("home")),
      lastClosed: { tab, ctxId: ctx.id, paneId: pane.id },
    };
    // Park the user somewhere else: the reopen must bring them back.
    const elsewhere = { ...ws, activeContextId: ws.contexts[0].id === ctx.id ? ws.contexts[1].id : ws.contexts[0].id };

    const restored = reopenClosed(elsewhere);
    expect(activeContext(restored).id).toBe(ctx.id);
    expect(focusedView(activeContext(restored))).toBe("tree");
    expect(restored.lastClosed).toBe(null);
  });

  it("does nothing when there is nothing to reopen, or the context is gone", () => {
    const empty = wsWith(ctxWith("home"));
    expect(reopenClosed(empty)).toBe(empty);

    const ws = { ...wsWith(ctxWith("home", "tree")), lastClosed: { tab: { view: "tree", label: "tree" }, ctxId: "ctx-gone", paneId: "pane-gone" } };
    expect(reopenClosed(ws)).toBe(ws);
  });
});

describe("idempotence of the routing seam", () => {
  it("openView on a context that already shows the view changes only focus", () => {
    let ctx = ctxWith("home", "tree");
    ctx = activateTab(ctx, ctx.focusedPaneId, focusedPane(ctx).tabs[0].id);
    const again = openView(ctx, "tree");
    expect(focusedView(again)).toBe("tree");
    expect(contextCounts(again).tabs).toBe(2);
  });

  it("keeps a tab object stable across an activate (labels survive)", () => {
    const ctx = ctxWith("home", "tree");
    const tab = createTab({ view: "x", label: "X" });
    expect(tab.id).toBeTruthy();
    expect(tab.entity).toBe(null);
  });
});

describe("popup tabs (R3, approved decision D3-3)", () => {
  let ctx;
  let paneId;
  /** A context with ONE real tab in it, so "unfocused" has something to compare to. */
  function withSeedTab() {
    const fresh = createContext({
      id: "ctx-popup",
      name: "Popup",
      views: [{ view: "home", label: "Home" }],
    });
    return fresh;
  }
  beforeEach(() => {
    __resetIdSeq();
    ctx = withSeedTab();
    paneId = Object.keys(ctx.panes)[0];
  });

  it("a popup tab is born carrying the page id main already minted", () => {
    const paneId = Object.keys(ctx.panes)[0];
    ctx = openPageTab(ctx, paneId, "Web page", "bp-9");
    const tab = focusedPane(ctx).tabs.find((t) => t.view === "page");
    expect(tab.entity, "the tab does not wait to adopt a page it already has").toBe("bp-9");
  });

  it("a popup tab is UNFOCUSED: the pane's active tab and the context's focused pane are untouched", () => {
    const paneId = Object.keys(ctx.panes)[0];
    const before = activeTabOf(focusedPane(ctx));
    const paneBefore = ctx.focusedPaneId;

    ctx = openPageTab(ctx, paneId, "Web page", "bp-9", { activate: false });

    const after = focusedPane(ctx);
    expect(after.activeTabId, "the user's tab stays active").toBe(before.id);
    expect(ctx.focusedPaneId, "the user's pane stays focused").toBe(paneBefore);
    const popup = after.tabs.find((t) => t.entity === "bp-9");
    expect(popup, "the popup tab exists in the strip").toBeTruthy();
    expect(after.activeTabId, "and it is not the active one").not.toBe(popup.id);
  });

  it("a popup tab is not pushed onto the pane trail, so Back/Forward describe what the USER visited", () => {
    const paneId = Object.keys(ctx.panes)[0];
    const trailBefore = (focusedPane(ctx).trail ?? []).length;

    ctx = openPageTab(ctx, paneId, "Web page", "bp-9", { activate: false });

    const pane = focusedPane(ctx);
    expect((pane.trail ?? []).length, "a background popup is not history").toBe(trailBefore);
    // An ACTIVATED open still is, which is the existing "new web page" rule.
    ctx = openPageTab(ctx, paneId, "Web page");
    expect((focusedPane(ctx).trail ?? []).length).toBe(trailBefore + 1);
  });

  it("two popups land as two distinct tabs, so neither overwrites the other", () => {
    const paneId = Object.keys(ctx.panes)[0];
    ctx = openPageTab(ctx, paneId, "Web page", "bp-9", { activate: false });
    ctx = openPageTab(ctx, paneId, "Web page", "bp-10", { activate: false });
    const popups = focusedPane(ctx).tabs.filter((t) => t.view === "page");
    expect(popups.map((t) => t.entity)).toEqual(["bp-9", "bp-10"]);
  });

  it("the default is still an ACTIVATED bare tab, so existing callers are unchanged", () => {
    const paneId = Object.keys(ctx.panes)[0];
    const before = activeTabOf(focusedPane(ctx)).id;
    ctx = openPageTab(ctx, paneId, "Web page");
    const pane = focusedPane(ctx);
    const tab = pane.tabs.find((t) => t.id !== before);
    expect(pane.activeTabId).toBe(tab.id);
    expect(tab.entity).toBe(null);
  });
});