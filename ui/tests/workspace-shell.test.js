// W1 — workspace shell: the store's routing seam and the four new chrome
// surfaces (context strip, pane grid, pane view, spine), plus the whole-shell
// composition that proves they are actually wired together.
//
// The IPC stub is written out explicitly rather than through a permissive
// proxy: a proxy that answers every property with an async function silently
// satisfies code that should have failed, and would hide the very wiring bugs
// these tests exist to catch.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import App from "../src/App.svelte";
import {
  applyBrowserEvent,
  __resetBrowserForTests,
} from "../src/shared/stores/browser.svelte.js";
import ContextStrip from "../src/shell/ContextStrip.svelte";
import PaneGrid from "../src/shell/PaneGrid.svelte";
import PaneView from "../src/shell/PaneView.svelte";
import Spine from "../src/shell/Spine.svelte";
import NavRail from "../src/shell/NavRail.svelte";
import { VIEWS, railViews } from "../src/shell/view-registry.js";
import { __resetOperator, applyOperatorEvent } from "../src/shell/operator.svelte.js";
import * as ws from "../src/shell/workspace/store.svelte.js";
import {
  __resetIdSeq,
  createContext,
  createPane,
  focusedPane,
  leafOrder,
  splitPane,
} from "../src/shell/workspace/model.js";

const PING = "CareerFlow core online";

/** A context with `views` open in one pane, for the pane-grid tests. */
function ctxWith(...views) {
  return createContext({ name: "T", views: views.map((v) => ({ view: v, label: v })) });
}

/** Local YYYY-MM-DD, `offset` days from today. */
function isoDay(offset) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function makeCareerflow(overrides = {}) {
  const resolved = (value) => async () => value;
  const base = {
    ping: async () => PING,
    runtime: { isE2E: false },
    notes: { onQuickNoteShortcut: () => () => {} },
    profiles: {
      list: async () => [],
      add: resolved({ id: 1, name: "p", slug: "p" }),
      remove: resolved({ ok: true }),
      export: resolved({ ok: true }),
      import: resolved({ ok: true }),
    },
    academic: { tree: async () => [] },
    deadlines: { list: async () => [] },
    // The Subjects index reads these three together when a profile is present,
    // and `Promise.allSettled` would otherwise surface the stub gap as an
    // unhandled rejection rather than as a failing assertion.
    cards: { all: async () => [] },
    mistakes: { list: async () => [] },
    projectMode: { onEvent: () => () => {} },
    update: { check: resolved({ state: "idle" }), onStatus: () => () => {} },
  };
  window.careerflow = { ...base, ...overrides };
  return window.careerflow;
}

/** jsdom has no ResizeObserver; a page tab mounts BrowserSurface, which needs one. */
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  __resetIdSeq();
  __resetOperator();
  ws.__resetWorkspace();
  __resetBrowserForTests();
  globalThis.ResizeObserver = FakeResizeObserver;
  localStorage.setItem("careerflow_onboarding_complete", "true");
  makeCareerflow();
});

afterEach(() => {
  cleanup();
  delete window.careerflow;
});

// ---------------------------------------------------------------------------

describe("workspace store — the routing seam", () => {
  it("launches on the context that owns `profiles`", () => {
    expect(ws.currentView()).toBe("profiles");
    expect(ws.activeContext().seed).toBe("System");
    expect(ws.focusedView()).toBe("profiles");
  });

  it("navigates into the domain that owns the destination", () => {
    ws.navigate("deadlines", "Deadlines");
    expect(ws.currentView()).toBe("deadlines");
    expect(ws.activeContext().seed).toBe("Study");
    // The Study context's seeded tabs survive: a navigation activates, it does
    // not rebuild the context.
    expect(ws.focusedTabs().map((t) => t.view)).toContain("tree");
  });

  it("is idempotent: navigating twice does not duplicate a tab", () => {
    ws.navigate("deadlines", "Deadlines");
    const before = ws.contextSummary(ws.activeContext()).tabs;
    ws.navigate("deadlines", "Deadlines");
    expect(ws.contextSummary(ws.activeContext()).tabs).toBe(before);
    expect(ws.currentView()).toBe("deadlines");
  });

  it("falls back to the active context when the owning domain is gone", () => {
    // `career` is on the registry's `plan` plane, which G12 reconciled to Study.
    ws.navigate("career", "Career");
    const ownerCtx = ws.activeContext();
    expect(ownerCtx.seed).toBe("Study");

    ws.dissolveContext(ownerCtx.id);
    const fallback = ws.activeContext();

    ws.navigate("career", "Career");
    // No domain owns it any more, so it opens where the user already is.
    expect(ws.activeContext().id).toBe(fallback.id);
    expect(ws.currentView()).toBe("career");
  });

  it("reports the subject contract for the focused pane", () => {
    ws.navigate("settings", "Settings");
    expect(ws.currentSubject()).toEqual({
      key: "settings",
      view: "settings",
      kind: "surface",
      label: "Settings",
    });
  });

  // ---- the subject/context identity contract ----------------------------

  it("carries a real record on the tab, so the entity branch is reachable", () => {
    // 7 is a subject id — the shape `academic.tree` returns for a real row.
    ws.navigate("tree", "Subjects", 7);
    expect(ws.currentView()).toBe("tree");
    expect(ws.currentSubject()).toEqual({ key: "tree:7", view: "tree", kind: "entity", label: 7 });
    expect(ws.currentEntity()).toBe(7);

    // …and the identity is a property of the tab, not of a navigation event: it
    // survives everything that does not explicitly re-point it.
    ws.navigate("tree", "Subjects");
    expect(ws.currentSubject().key).toBe("tree:7");

    // Leaving the pane for another destination clears the ANSWER (the focused
    // tab is a different one) without touching the Subjects tab's record.
    ws.navigate("deadlines", "Deadlines");
    expect(ws.currentSubject().kind).toBe("surface");
    ws.activateTab(
      ws.focusedPane().id,
      ws.focusedPane().tabs.find((t) => t.view === "tree").id,
    );
    expect(ws.currentSubject().key).toBe("tree:7");

    // Going back to the index clears it for real.
    const pane = ws.focusedPane();
    const tab = pane.tabs.find((t) => t.view === "tree");
    ws.setTabEntity(pane.id, tab.id, null);
    expect(ws.currentSubject().kind).toBe("surface");
    expect(ws.currentEntity()).toBe(null);
  });

  it("lands a record-bearing navigation in the pane the user is in", () => {
    ws.navigate("tree", "Subjects");
    ws.splitFocused("row", { view: "deadlines", label: "Deadlines" });
    const ctx = ws.activeContext();
    const [left, right] = leafOrder(ctx.layout, ctx.panes);
    expect(right).toBe(ws.focusedPane().id);

    // The split seeded the new pane with the same record the old one held (null
    // here — nothing was open yet), and the destinations did not duplicate.
    expect(ctx.panes[right].tabs.map((t) => t.view)).toEqual(["deadlines"]);

    ws.focusPane(left);
    ws.navigate("tree", "Subjects", 7);
    expect(ws.focusedPane().id).toBe(left);
    expect(ws.currentSubject().key).toBe("tree:7");
    // The sibling pane is untouched: no tree tab appeared there.
    expect(ws.activeContext().panes[right].tabs.map((t) => t.view)).toEqual(["deadlines"]);

    // A second deep link, from the other pane, gives TWO panes two DIFFERENT
    // records — the case the old shell-wide pendingSubjectId could not express.
    ws.focusPane(right);
    ws.navigate("tree", "Subjects", 8);
    expect(ws.focusedPane().id).toBe(right);
    expect(ws.currentSubject().key).toBe("tree:8");
    const after = ws.activeContext();
    expect(after.panes[left].tabs.find((t) => t.view === "tree").entity).toBe(7);
    expect(after.panes[right].tabs.find((t) => t.view === "tree").entity).toBe(8);
  });

  it("focuses the pane holding a page when main reports focus from inside it (Phase 2)", () => {
    ws.navigate("tree", "Subjects");
    ws.splitFocused("row", { view: "deadlines", label: "Deadlines" });
    const ctx = ws.activeContext();
    const [left, right] = leafOrder(ctx.layout, ctx.panes);

    // A page lives in the LEFT pane, which is not the focused one.
    ws.openIn(left, "page", "Web page", "bp-1");
    ws.focusPane(right);
    expect(ws.focusedPane().id).toBe(right);

    // A click inside the OS-painted view cannot reach the DOM, so main reports
    // it: the shell answers by focusing the pane whose tab carries that page.
    ws.focusPaneOfPage("bp-1");
    expect(ws.focusedPane().id).toBe(left);

    // An id no tab carries changes nothing, and the readout is by page, not by
    // view: the sibling pane's deadlines tab must not capture the focus.
    ws.focusPane(right);
    ws.focusPaneOfPage("bp-404");
    expect(ws.focusedPane().id).toBe(right);
  });

  it("splits without losing the record you were reading", () => {
    ws.navigate("tree", "Subjects", 12);
    ws.splitFocused("col");
    const ctx = ws.activeContext();
    const [left, right] = leafOrder(ctx.layout, ctx.panes);
    expect(ctx.panes[left].tabs.find((t) => t.view === "tree").entity).toBe(12);
    expect(ctx.panes[right].tabs.find((t) => t.view === "tree").entity).toBe(12);
    expect(ws.currentEntity()).toBe(12);
  });

  it("splits, focuses, resizes and reclaims a pane mode", () => {
    ws.navigate("home", "Home");
    ws.splitFocused("row", { view: "tree" });
    expect(ws.contextSummary(ws.activeContext()).panes).toBe(2);

    const order = leafOrder(ws.activeContext().layout, ws.activeContext().panes);
    expect(ws.focusedPane().id).toBe(order[1]);
    ws.focusDirection("left");
    expect(ws.focusedPane().id).toBe(order[0]);

    const splitId = ws.activeContext().layout.id;
    ws.setPaneSizes(splitId, [0.7, 0.3]);
    expect(ws.activeContext().layout.sizes).toEqual([0.7, 0.3]);

    // Lab weakness #2: a margin you cannot leave. It must be reclaimable.
    ws.setPaneMode(order[1], "margin");
    expect(ws.activeContext().panes[order[1]].mode).toBe("margin");
    ws.setPaneMode(order[1], "content");
    expect(ws.activeContext().panes[order[1]].mode).toBe("content");
  });

  it("closes a pane down to one, never to none", () => {
    ws.navigate("home", "Home");
    ws.splitFocused("row", { view: "tree" });
    const order = leafOrder(ws.activeContext().layout, ws.activeContext().panes);
    ws.closePane(order[1]);
    expect(ws.contextSummary(ws.activeContext()).panes).toBe(1);
    ws.closePane(order[0]);
    expect(ws.contextSummary(ws.activeContext()).panes).toBe(1);
  });

  it("arranges the focused context from its open tabs", () => {
    ws.navigate("home", "Home");
    ws.arrange("trio");
    expect(ws.contextSummary(ws.activeContext()).panes).toBe(1); // one tab → one pane

    ws.splitFocused("row", { view: "tree" });
    ws.arrange("split");
    expect(ws.activeContext().layout.dir).toBe("row");
    expect(ws.activeContext().layout.children.length).toBe(2);
    expect(ws.contextSummary(ws.activeContext()).tabs).toBe(2);
  });

  it("creates, switches and dissolves contexts, never the last one", () => {
    const start = ws.workspace.contexts.length;
    ws.createContext("Scratch");
    expect(ws.workspace.contexts.length).toBe(start + 1);
    expect(ws.activeContext().name).toBe("Scratch");

    const from = ws.activeContext().id;
    ws.cycleContext(1);
    expect(ws.activeContext().id).not.toBe(from);
    ws.switchContext(from);
    expect(ws.activeContext().id).toBe(from);

    ws.dissolveContext(from);
    expect(ws.workspace.contexts.length).toBe(start);

    for (const ctx of [...ws.workspace.contexts]) ws.dissolveContext(ctx.id);
    expect(ws.workspace.contexts.length).toBe(1);
  });

  it("keeps the current context honest after a rename", () => {
    const id = ws.activeContext().id;
    ws.renameContext(id, "Admin");
    expect(ws.activeContext().name).toBe("Admin");
    // The domain survives the rename, so routing still finds it.
    ws.navigate("home", "Home");
    ws.navigate("settings", "Settings");
    expect(ws.activeContext().id).toBe(id);
  });

  it("reopens the last closed tab", () => {
    ws.navigate("settings", "Settings");
    ws.closeFocusedTab();
    expect(ws.currentView()).toBe("profiles");
    ws.reopenClosed();
    expect(ws.currentView()).toBe("settings");
  });

  it("steps the pane trail back and forward, keeping the forward history (G11)", () => {
    ws.createContext("Scratch");
    const paneId = ws.focusedPane().id;
    ws.openIn(paneId, "home", "Home");
    ws.openIn(paneId, "settings", "Settings");
    ws.openIn(paneId, "cgpa", "Degree");
    expect(ws.currentView()).toBe("cgpa");

    ws.trailStep(paneId, -1);
    expect(ws.currentView()).toBe("settings");
    ws.trailStep(paneId, -1);
    expect(ws.currentView()).toBe("home");
    ws.trailStep(paneId, -1);
    expect(ws.currentView()).toBe("home"); // the start of the trail: no move

    // A back step must not spend the forward entries: this is the difference
    // between back/forward and an undo button.
    ws.trailStep(paneId, 1);
    expect(ws.currentView()).toBe("settings");
    ws.trailStep(paneId, 1);
    expect(ws.currentView()).toBe("cgpa");
    ws.trailStep(paneId, 1);
    expect(ws.currentView()).toBe("cgpa");
  });

  it("takes a closed tab's trail entry with it, so Back never costs a step", () => {
    ws.createContext("Scratch");
    const paneId = ws.focusedPane().id;
    ws.openIn(paneId, "home", "Home");
    ws.openIn(paneId, "settings", "Settings");
    const settings = ws.focusedPane().tabs.find((t) => t.view === "settings");
    ws.closeTab(paneId, settings.id);

    // The entry left with the tab: a Back step goes STRAIGHT to the destination
    // the pane still holds, instead of silently skipping a dead entry (the Lab's
    // v2.13 bug: an entry for a closed tab left the pane showing nothing).
    const pane = ws.workspace.contexts.find((c) => c.panes[paneId]).panes[paneId];
    expect(pane.trail.includes(settings.id)).toBe(false);
    ws.trailStep(paneId, -1);
    expect(ws.currentView()).toBe("home");
    expect(ws.currentSubject()).toEqual({
      key: "home",
      view: "home",
      kind: "surface",
      label: "Home",
    });
  });

  it("still skips an entry that names no live tab (defence in depth)", () => {
    ws.createContext("Scratch");
    const paneId = ws.focusedPane().id;
    ws.openIn(paneId, "home", "Home");
    ws.openIn(paneId, "settings", "Settings");

    // Closing and moving a tab both drop their entries, so a stale entry can now
    // only be state written by an older build or a future caller that forgets to.
    // The step must still land on a tab the pane really holds rather than showing
    // nothing — that is what this injection pins.
    const ctx = ws.workspace.contexts.find((c) => c.panes[paneId]);
    ws.workspace.contexts = ws.workspace.contexts.map((c) =>
      c.id === ctx.id
        ? {
            ...c,
            panes: {
              ...c.panes,
              [paneId]: {
                ...c.panes[paneId],
                trail: [...c.panes[paneId].trail, "tab-vanished"],
                trailAt: c.panes[paneId].trail.length,
              },
            },
          }
        : c,
    );

    ws.trailStep(paneId, -1);
    expect(ws.currentView()).toBe("settings");
  });

  it("steps to the EXACT tab when two pages share one pane (design 2.3.1)", () => {
    ws.createContext("Scratch");
    const paneId = ws.focusedPane().id;
    ws.openIn(paneId, "home", "Home");
    ws.openIn(paneId, "page", "Web page", "bp-1");
    ws.openIn(paneId, "page", "Web page", "bp-2");
    const pages = ws.focusedPane().tabs.filter((t) => t.view === "page");
    expect(pages.map((t) => t.entity)).toEqual(["bp-1", "bp-2"]);

    // View-named entries could not tell these apart; the tab-id entry does.
    ws.trailStep(paneId, -1);
    expect(ws.currentEntity()).toBe("bp-1");
    ws.trailStep(paneId, 1);
    expect(ws.currentEntity()).toBe("bp-2");
  });

  it("moves the active tab to the next pane, identity intact", () => {
    ws.createContext("Scratch");
    const left = ws.focusedPane().id;
    ws.openIn(left, "home", "Home");
    // Split BEFORE the page exists: a split seeds the new pane with the focused
    // tab, and a seeded page would already be in the target pane — which would
    // make this assertion pass for the wrong reason.
    ws.splitFocused("row");
    const right = ws.focusedPane().id;
    expect(right).not.toBe(left);
    ws.openIn(left, "page", "Web page", "bp-9");

    const page = ws.workspace.contexts
      .find((c) => c.panes[left])
      .panes[left].tabs.find((t) => t.view === "page");
    ws.moveTab(left, page.id, right);

    const moved = ws.workspace.contexts
      .find((c) => c.panes[right])
      .panes[right].tabs.find((t) => t.id === page.id);
    expect(moved, "the same tab id arrives").toBeTruthy();
    expect(moved.entity).toBe("bp-9");
    expect(ws.currentEntity()).toBe("bp-9");
  });

  it("ignores a trail step for a pane that is not there", () => {
    ws.trailStep("pane-gone", -1);
    expect(ws.currentView()).toBe("profiles");
  });

  it("toggles immerse", () => {
    expect(ws.isImmerse()).toBe(false);
    ws.toggleImmerse();
    expect(ws.isImmerse()).toBe(true);
    ws.setImmerse(false);
    expect(ws.isImmerse()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("context strip", () => {
  const contexts = [
    { id: "c1", name: "Desk", seed: "Desk" },
    { id: "c2", name: "Study", seed: "Study" },
  ];
  const counts = (ctx) => ({ panes: ctx.id === "c2" ? 2 : 1, tabs: ctx.id === "c1" ? 3 : 0 });

  it("renders a tab per context and marks the active one", () => {
    render(ContextStrip, { props: { contexts, activeId: "c2", counts } });
    const chips = [...document.querySelectorAll(".ctx-chip")];
    expect(chips.map((c) => c.textContent.trim())).toEqual(["Desk", "Study"]);
    expect(chips[1].getAttribute("aria-selected")).toBe("true");
    expect(chips[0].getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the live count out of textContent so text matching stays exact", () => {
    render(ContextStrip, { props: { contexts, activeId: "c2", counts } });
    const chips = [...document.querySelectorAll(".ctx-chip")];
    // The count is painted from data-count by a pseudo-element, never as text.
    expect(chips[0].getAttribute("data-count")).toBe("3");
    expect(chips[0].textContent.trim()).toBe("Desk");
    // Zero is not annotated: "Desk 0" would be noise, not information.
    expect(chips[1].getAttribute("data-count")).toBeNull();
  });

  it("selects a context, and offers dissolve only for the active one", async () => {
    const onSelect = vi.fn();
    const onDissolve = vi.fn();
    render(ContextStrip, { props: { contexts, activeId: "c2", counts, onSelect, onDissolve } });

    await fireEvent.click(document.querySelectorAll(".ctx-chip")[0]);
    expect(onSelect).toHaveBeenCalledWith("c1");

    const dissolves = document.querySelectorAll(".ctx-dissolve");
    expect(dissolves.length).toBe(1);
    await fireEvent.click(dissolves[0]);
    expect(onDissolve).toHaveBeenCalledWith("c2");
  });

  it("creates a context from the + control", async () => {
    const onCreate = vi.fn();
    render(ContextStrip, { props: { contexts, activeId: "c1", counts, onCreate } });
    await fireEvent.click(document.querySelector(".ctx-new"));
    expect(onCreate).toHaveBeenCalled();
  });

  it("opens the arrange menu and calls back with the chosen arrangement", async () => {
    const onArrange = vi.fn();
    render(ContextStrip, { props: { contexts, activeId: "c1", counts, onArrange } });

    expect(document.querySelector(".menu")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Arrange" }));

    const items = [...document.querySelectorAll(".menu-item")].map((b) => b.textContent.trim());
    expect(items).toEqual(["Single", "Split", "Margin", "Trio", "Ledge"]);

    await fireEvent.click(screen.getByRole("menuitem", { name: "Trio" }));
    expect(onArrange).toHaveBeenCalledWith("trio");
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("splits and immerses from the strip", async () => {
    const onSplit = vi.fn();
    const onToggleImmerse = vi.fn();
    render(ContextStrip, { props: { contexts, activeId: "c1", counts, onSplit, onToggleImmerse } });

    await fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(onSplit).toHaveBeenCalledWith("row");

    await fireEvent.click(screen.getByRole("button", { name: "Immerse" }));
    expect(onToggleImmerse).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("pane grid", () => {
  it("renders one pane with the pane's tabs for a single-pane context", () => {
    const ctx = ctxWith("home", "tree");
    render(PaneGrid, { props: { ctx } });

    const panes = document.querySelectorAll(".pane");
    expect(panes.length).toBe(1);
    expect(panes[0].getAttribute("data-pane-id")).toBe(ctx.focusedPaneId);
    expect(panes[0].getAttribute("data-pane-mode")).toBe("content");

    const list = document.querySelector("[role='tablist']");
    expect([...list.querySelectorAll("[role='tab']")].map((t) => t.textContent.trim())).toEqual([
      "home",
      "tree",
    ]);
  });

  it("numbers panes in visual order, not object-key order", () => {
    // Lab weakness #4: pane numbers came from key order, so a left/right split
    // could be labelled out of order. Key order here is deliberately the reverse
    // of visual order.
    const left = createPane();
    const right = createPane();
    left.tabs = [{ id: "t1", view: "home", label: "Home", entity: null }];
    left.activeTabId = "t1";
    right.tabs = [{ id: "t2", view: "tree", label: "Subjects", entity: null }];
    right.activeTabId = "t2";
    const ctx = {
      ...createContext({ name: "Two" }),
      panes: { [right.id]: right, [left.id]: left },
      layout: {
        kind: "split",
        id: "s1",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", paneId: left.id },
          { kind: "pane", paneId: right.id },
        ],
      },
      focusedPaneId: left.id,
    };

    render(PaneGrid, { props: { ctx } });
    expect([...document.querySelectorAll(".pane-num")].map((n) => n.textContent.trim())).toEqual([
      "1",
      "2",
    ]);
    expect(
      [...document.querySelectorAll(".pane")].map((p) => p.getAttribute("data-pane-id")),
    ).toEqual([left.id, right.id]);
    expect(document.querySelectorAll(".handle").length).toBe(1);
    // The focused pane carries the hairline mark; the other does not.
    expect(document.querySelectorAll(".pane.focused").length).toBe(1);
  });

  it("says what an empty pane is instead of listing unrelated destinations", () => {
    // Lab weakness #7: context-blind empty panes offering a hardcoded menu.
    const ctx = createContext({ name: "Empty" });
    render(PaneGrid, { props: { ctx } });
    expect(screen.getByText("Nothing open in this pane")).toBeInTheDocument();
    expect(screen.getByText(/Pick a destination from the rail/)).toBeInTheDocument();
  });

  it("routes pane interactions to the shell", async () => {
    const ctx = ctxWith("home", "tree");
    const pane = focusedPane(ctx);
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    const onSplit = vi.fn();
    const onSetMode = vi.fn();
    const onFocusPane = vi.fn();
    const onNewPage = vi.fn();
    render(PaneGrid, {
      props: { ctx, onActivateTab, onCloseTab, onSplit, onSetMode, onFocusPane, onNewPage },
    });

    await fireEvent.click([...document.querySelectorAll("[role='tab']")][0]);
    expect(onActivateTab).toHaveBeenCalledWith(pane.id, pane.tabs[0].id);

    await fireEvent.click([...document.querySelectorAll(".tab-close")][1]);
    expect(onCloseTab).toHaveBeenCalledWith(pane.id, pane.tabs[1].id);

    await fireEvent.click(screen.getByLabelText("Split pane vertically"));
    expect(onSplit).toHaveBeenCalledWith("row");

    await fireEvent.change(screen.getByLabelText("Pane mode"), { target: { value: "ledge" } });
    expect(onSetMode).toHaveBeenCalledWith(pane.id, "ledge");

    await fireEvent.click(screen.getByLabelText("New tab"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "New web page" }));
    expect(onNewPage).toHaveBeenCalledWith(pane.id);
  });

  it("wires the pane trail chevrons to the shell and disables them at the ends", async () => {
    // ctxWith opens its tabs through openInPane, so the pane has one entry to go
    // back to and nothing ahead: both endpoints are exercised here.
    const ctx = ctxWith("home", "tree");
    const pane = focusedPane(ctx);
    const onTrailStep = vi.fn();
    render(PaneGrid, { props: { ctx, onTrailStep } });

    const back = screen.getByLabelText("Back");
    const forward = screen.getByLabelText("Forward");
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);

    await fireEvent.click(back);
    expect(onTrailStep).toHaveBeenCalledWith(pane.id, -1);
  });

  /** A context whose first pane holds the Home tab WITH a record (a page id). */
  function ctxWithRecord(entity) {
    const ctx = ctxWith("home");
    const pane = focusedPane(ctx);
    const tab = { ...pane.tabs[0], entity };
    return { ...ctx, panes: { ...ctx.panes, [pane.id]: { ...pane, tabs: [tab] } } };
  }

  it("shows a state dot on a tab whose record has live state (Phase 2)", () => {
    const ctx = ctxWithRecord("bp-1");
    render(PaneGrid, { props: { ctx, tabDots: { "bp-1": "loading" } } });

    const dot = document.querySelector(".tab-dot");
    expect(dot).toBeTruthy();
    expect(dot.getAttribute("data-tab-dot")).toBe("loading");
    // The dot is a readout, so it says what it means to a screen reader too.
    expect(dot.getAttribute("title")).toBe("Loading");
    expect(dot.getAttribute("aria-label")).toBe("Loading");
  });

  it("shows a crashed page's dot, and no dot for a record with no state", () => {
    render(PaneGrid, { props: { ctx: ctxWithRecord("bp-1"), tabDots: { "bp-2": "crashed" } } });
    expect(document.querySelector(".tab-dot")).toBeNull();

    cleanup();
    render(PaneGrid, { props: { ctx: ctxWithRecord("bp-2"), tabDots: { "bp-2": "crashed" } } });
    expect(document.querySelector(".tab-dot").getAttribute("data-tab-dot")).toBe("crashed");
  });

  it("moves the active tab to the next pane through the header control", async () => {
    const ctx = splitPane(ctxWith("home"), "row", { view: "tree" });
    const order = leafOrder(ctx.layout, ctx.panes);
    const onMoveTab = vi.fn();
    render(PaneGrid, { props: { ctx, onMoveTab } });

    const controls = screen.getAllByLabelText("Move active tab to the next pane");
    expect(controls.length, "one control per pane").toBe(2);
    expect(controls[0].disabled).toBe(false);

    await fireEvent.click(controls[0]);
    expect(onMoveTab).toHaveBeenCalledWith(order[0], ctx.panes[order[0]].activeTabId, order[1]);
  });

  it("disables the move control on a lone pane, like the trail chevrons", () => {
    render(PaneGrid, { props: { ctx: ctxWith("home") } });
    expect(screen.getByLabelText("Move active tab to the next pane").disabled).toBe(true);
  });

  it("moves a dragged tab onto another pane, and ignores a drop on its own pane", async () => {
    const ctx = splitPane(ctxWith("home"), "row", { view: "tree" });
    const order = leafOrder(ctx.layout, ctx.panes);
    const onMoveTab = vi.fn();
    render(PaneGrid, { props: { ctx, onMoveTab } });

    const store = new Map();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type, value) => store.set(type, value),
      getData: (type) => store.get(type) ?? "",
    };
    const dragged = ctx.panes[order[0]].tabs[0].id;
    const tab = document.querySelector(`[data-pane-tab="${dragged}"]`);
    const panes = [...document.querySelectorAll("[data-pane-id]")];

    await fireEvent.dragStart(tab, { dataTransfer });
    await fireEvent.dragOver(panes[1], { dataTransfer });
    expect(panes[1].classList.contains("dropping"), "the target pane says it will take it").toBe(
      true,
    );
    await fireEvent.drop(panes[1], { dataTransfer });
    expect(onMoveTab).toHaveBeenCalledWith(order[0], dragged, order[1]);

    // Dropping a tab back into the pane it came from is not a move.
    await fireEvent.dragStart(tab, { dataTransfer });
    await fireEvent.dragOver(panes[0], { dataTransfer });
    await fireEvent.drop(panes[0], { dataTransfer });
    expect(onMoveTab).toHaveBeenCalledTimes(1);
  });

  it("shows a non-content mode as a badge, and no close control for a lone pane", () => {
    const ctx = ctxWith("home");
    const base = focusedPane(ctx);
    const ledge = { ...ctx, panes: { ...ctx.panes, [base.id]: { ...base, mode: "ledge" } } };
    render(PaneGrid, { props: { ctx: ledge } });

    const badge = document.querySelector(".pane-mode");
    expect(badge).toBeTruthy();
    expect(badge.textContent.trim()).toBe("ledge");
    expect(document.querySelector(".pane-close")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("pane view resolver", () => {
  it("renders the real feature component for a view id", async () => {
    render(PaneView, { props: { view: "settings", profiles: [], activeProfile: null } });
    expect(await screen.findByText("Data and vault")).toBeInTheDocument();
  });

  it("renders nothing for an unknown view rather than throwing", () => {
    const { container } = render(PaneView, { props: { view: "does-not-exist" } });
    expect(container.querySelector(".view-container")).toBeNull();
  });

  it("renders the wide container for a multi-column view", () => {
    render(PaneView, { props: { view: "tree", profileId: 1 } });
    expect(document.querySelector(".view-container.wide")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("spine — the obligation readout", () => {
  it("renders every signal, including honest zeros", async () => {
    render(Spine, { props: { profileId: 1 } });
    await waitFor(() => {
      expect(document.querySelectorAll(".signal").length).toBe(4);
    });
    const labels = [...document.querySelectorAll(".caption")].map((c) => c.textContent.trim());
    expect(labels).toEqual(["Blocked on you", "Operator live", "Overdue", "Due today"]);
    // Zeros are shown, not hidden: an instrument that hides its zeroes is a
    // notification.
    await waitFor(() => {
      expect(document.querySelectorAll(".signal.zero, .signal.unknown").length).toBe(4);
    });
  });

  it("counts real deadlines from the existing deadlines channel", async () => {
    window.careerflow.deadlines.list = async () => [
      { id: 1, title: "Late", deadlineDate: isoDay(-2), category: "assignment" },
      { id: 2, title: "Now", deadlineDate: isoDay(0), category: "exam" },
      { id: 3, title: "Later", deadlineDate: isoDay(30), category: "exam" },
      { id: 4, title: "Done", deadlineDate: isoDay(-5), category: "exam", completedAt: isoDay(-1) },
    ];

    render(Spine, { props: { profileId: 1 } });
    await waitFor(() => {
      expect(screen.getByTitle("Overdue: 1")).toBeInTheDocument();
    });
    expect(screen.getByTitle("Due today: 1")).toBeInTheDocument();
    expect(screen.getByTitle("Blocked on you: 0")).toBeInTheDocument();
  });

  it("counts approvals and live runs from the operator store", async () => {
    const onOpen = vi.fn();
    render(Spine, { props: { profileId: 1, onOpen } });

    applyOperatorEvent({ type: "agent.started", agentId: 1, projectId: 9 });
    applyOperatorEvent({ type: "agent.approval.required", agentId: 1, tool: "fs_write" });

    await waitFor(() => {
      expect(screen.getByTitle("Blocked on you: 1")).toBeInTheDocument();
    });
    expect(screen.getByTitle("Operator live: 1")).toBeInTheDocument();

    // Every door leads to the surface that owns the count.
    await fireEvent.click(screen.getByTitle("Blocked on you: 1"));
    expect(onOpen).toHaveBeenCalledWith("project");
  });

  it("shows an unreadable deadline count as unknown, not as zero", async () => {
    window.careerflow.deadlines.list = async () => {
      throw new Error("core offline");
    };
    render(Spine, { props: { profileId: 1 } });
    await waitFor(() => {
      expect(screen.getByTitle("Overdue — not loaded")).toBeInTheDocument();
    });
    expect(document.querySelectorAll(".signal.unknown").length).toBe(2);
  });

  it("fetches nothing without a profile", async () => {
    const list = vi.fn(async () => []);
    window.careerflow.deadlines.list = list;
    render(Spine, { props: { profileId: null } });
    expect(await screen.findByTitle("Due today — not loaded")).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("nav rail", () => {
  it("keeps `button.nav-item` meaning exactly one thing (a destination)", () => {
    render(NavRail, { props: { currentView: "home", profileReady: true } });
    // Destinations only: a hidden surface (`page`) is not a nav item.
    expect(document.querySelectorAll("button.nav-item").length).toBe(railViews().length);
  });
});

// ---------------------------------------------------------------------------

describe("shell composition", () => {
  it("wires the workspace, the readout and the strip into the real App", async () => {
    render(App);
    await screen.findByText(PING);

    // The spine lives inside the rail's nav, and it does not add destinations.
    await waitFor(() => {
      expect(document.querySelectorAll(".rail .spine .signal").length).toBe(4);
    });
    expect(document.querySelectorAll("button.nav-item").length).toBe(railViews().length);

    // The context strip is present with the seeded contexts.
    expect(document.querySelectorAll(".ctx-strip .ctx-chip").length).toBeGreaterThan(0);

    // The launch destination is unchanged: the profile chooser, in a real pane.
    expect(document.querySelector("[data-pane-id]")).toBeTruthy();
    expect(document.querySelector("main")).toBeTruthy();

    // The subject contract is published on the work surface.
    await waitFor(() => {
      expect(document.querySelector("main").getAttribute("data-subject")).toBe("profiles");
    });
  });

  it("moves the whole shell when the rail routes", async () => {
    render(App);
    await screen.findByText(PING);

    const settings = [...document.querySelectorAll("button.nav-item")].find(
      (b) => b.textContent.trim() === "Settings",
    );
    await fireEvent.click(settings);

    await waitFor(() => {
      expect(screen.getByText("Backup Active Profile")).toBeInTheDocument();
    });
    // The destination opened in the context that owns it, on a real tab.
    expect(document.querySelector("[data-pane-tab]")).toBeTruthy();
    expect(document.querySelector("main").getAttribute("data-subject")).toBe("settings");
  });

  it("exposes every existing destination as a rail label, unchanged", () => {
    render(App);
    const items = [...document.querySelectorAll("button.nav-item")];
    for (const view of railViews()) {
      expect(
        items.find((b) => b.textContent.trim() === view.label),
        `${view.label} rail item`,
      ).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// D2-D6 Phase 2 at the App level: the two effects that couple main's browser
// pushes to the workspace. Both are read+write effects, so both are places
// where a tracked read of what the effect writes turns into a runaway.

describe("embedded browser pages in the workspace (Phase 2)", () => {
  it("names a page tab after the title main reports for its page", async () => {
    const { container } = render(App);
    await screen.findByText(PING);

    ws.navigate("tree", "Subjects");
    const pane = ws.focusedPane();
    ws.openIn(pane.id, "page", "Web page", "bp-1");
    applyBrowserEvent({ kind: "created", page: { id: "bp-1", url: "http://x/", title: "" } });
    applyBrowserEvent({ kind: "title", pageId: "bp-1", title: "CF Browser Probe" });

    await waitFor(() => {
      const labels = [...container.querySelectorAll(".tab-label")].map((t) => t.textContent);
      expect(labels).toContain("CF Browser Probe");
    });
  });

  it("focuses the pane holding a page when main reports focus from inside it", async () => {
    // A click inside the OS-painted view cannot reach the DOM, so main reports
    // the focus and the shell answers. Answering WRITES the workspace while the
    // effect also reads it, which is why this test exists: a tracked read there
    // makes Svelte abort the whole effect graph
    // (`effect_update_depth_exceeded`), taking the pane UI and the page-tab
    // titles down with it.
    const { container } = render(App);
    await screen.findByText(PING);

    ws.navigate("tree", "Subjects");
    ws.splitFocused("row", { view: "deadlines", label: "Deadlines" });
    const [left, right] = Object.keys(ws.activeContext().panes);
    ws.openIn(left, "page", "Web page", "bp-1");
    ws.focusPane(right);
    applyBrowserEvent({ kind: "created", page: { id: "bp-1", url: "http://x/", title: "" } });

    applyBrowserEvent({ kind: "focus", pageId: "bp-1" });
    await waitFor(() => expect(ws.focusedPane().id).toBe(left));

    // A SECOND push for the same page must still re-run the effect (that is
    // what `focusTick` is for) and must not loop. "Must not loop" is stricter
    // than "the focus did not move": a redundant focus must leave the
    // workspace ALONE, because replacing the context it already depends on
    // would dirty the effect and Svelte would abort the graph. Identity is the
    // assertion -- the context object must survive a no-op focus.
    const settled = ws.activeContext();
    applyBrowserEvent({ kind: "focus", pageId: "bp-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.focusedPane().id).toBe(left);
    expect(ws.activeContext()).toBe(settled);
    expect(container.querySelector("[data-pane-id][aria-label='Pane focused']")).toBeTruthy();
  });
});
