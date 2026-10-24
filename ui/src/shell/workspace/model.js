/**
 * Workspace model — contexts → panes → tabs.
 *
 * The shell used to hold ONE global route at a time (`currentView`) plus a flat
 * tab strip, so every navigation threw away the column you were reading and
 * there was nowhere to put a second body of work. This module is the real
 * model, adapted from the proven Space Bunny v2 shell
 * (Progress Ledger-Frontend-Lab/src/shell/workspace.ts) onto Progress Ledger's own
 * destinations:
 *
 *   Context   a body of simultaneous work (Desk, Study, Library, Operator,
 *             System). Each context owns its whole layout and remembers it.
 *   Layout    a tree of panes. A split is a node; a pane is a leaf.
 *   Pane      a column of tabs, exactly like an editor pane.
 *   Tab       one destination (a view from view-registry) in a pane.
 *
 * Deliberate design decisions, each grounded in the Lab's own post-mortem:
 *
 *  - PURE. Every function takes state and returns new state; nothing mutates and
 *    nothing here imports Svelte. That is what makes the whole model testable in
 *    plain Node (`ui/tests/workspace-model.test.js`) instead of only through a
 *    rendered component. `store.svelte.js` is the thin reactive wrapper.
 *  - TABS DEDUPE BY VIEW. Main's existing strip treats a destination as a
 *    singleton (`openTab` skipped a view already open), and the E2E suite drives
 *    destinations by rail label. Keeping that rule means W1 changes the shell's
 *    structure without changing what a click does.
 *  - MODES CAN BE UNDONE. The Lab's `LAB-CRITIQUE.md` weakness #2 was that a
 *    pane could become a margin or a ledge and never return to content, because
 *    the model had no `content` transition. `setPaneMode(ctx, paneId, "content")`
 *    exists here from the start, and `applyArrangement` carries a surviving
 *    pane's mode forward instead of silently dropping it (weakness #6).
 *  - TRAIL IS ROUTE-LEVEL. The Lab recorded tab *activations* and then presented
 *    the result with browser back/forward arrows (weakness #9). Here the trail
 *    records the views a pane has actually shown and moves a pointer, so
 *    back/forward means what its iconography claims.
 */

/** Fixed-size id counters. `__resetIdSeq()` keeps tests deterministic. */
let SEQ = 0;
export function uid(prefix) {
  SEQ += 1;
  return `${prefix}-${SEQ}`;
}
export function __resetIdSeq() {
  SEQ = 0;
}

/** Process-pane modes. `content` is the normal one and is always reclaimable. */
export const PANE_MODES = ["content", "margin", "ledge"];

/** Arrangements, in the order the Lab offered them. */
export const ARRANGEMENTS = ["single", "split", "margin", "trio", "ledge"];

export const ARRANGEMENT_LABELS = {
  single: "Single",
  split: "Split",
  margin: "Margin",
  trio: "Trio",
  ledge: "Ledge",
};

/* ------------------------------------------------------------------ *
 * Constructors
 * ------------------------------------------------------------------ */

/**
 * @param {{id?: string, view: string, label?: string, entity?: string|null}} spec
 */
export function createTab(spec) {
  return {
    id: spec.id ?? uid("tab"),
    view: spec.view,
    label: spec.label ?? spec.view,
    entity: spec.entity ?? null,
  };
}

/** @param {"content"|"margin"|"ledge"} [mode] */
export function createPane(mode = "content") {
  return {
    id: uid("pane"),
    tabs: [],
    activeTabId: null,
    mode,
    /** margin panes follow the pane they are bound to */
    boundTo: null,
    /** where THIS pane has been, and where the pointer is (route-level) */
    trail: [],
    trailAt: -1,
  };
}

/**
 * A context with exactly one (possibly empty) content pane.
 *
 * `seed` records which working domain this context was built from
 * (`contexts.js` seeds). A context can be RENAMED without losing the answer to
 * "which context does `deadlines` belong in", because the domain is carried by
 * this field rather than by the display name.
 *
 * @param {{id?: string, name: string, seed?: string, icon?: string, hue?: string,
 *          views?: Array<{view: string, label?: string}>, activeView?: string}} spec
 */
export function createContext(spec) {
  const pane = createPane();
  const ctx = {
    id: spec.id ?? uid("ctx"),
    name: spec.name,
    seed: spec.seed ?? null,
    icon: spec.icon ?? "square",
    hue: spec.hue ?? "you",
    layout: { kind: "pane", paneId: pane.id },
    panes: { [pane.id]: pane },
    focusedPaneId: pane.id,
    createdAt: Date.now(),
  };
  for (const v of spec.views ?? []) {
    const withTab = openInPane(ctx, pane.id, v.view, v.label);
    ctx.layout = withTab.layout;
    ctx.panes = withTab.panes;
  }
  if (spec.activeView) {
    const tab = ctx.panes[pane.id].tabs.find((t) => t.view === spec.activeView);
    if (tab) ctx.panes = { ...ctx.panes, [pane.id]: { ...ctx.panes[pane.id], activeTabId: tab.id } };
  }
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

/** Pane ids of a subtree in visual (left→right / top→bottom) order. */
export function leafOrder(node, panes) {
  if (!node) return [];
  if (node.kind === "pane") return panes[node.paneId] ? [node.paneId] : [];
  return node.children.flatMap((child) => leafOrder(child, panes));
}

/** Every pane id in this context, visual order first. */
export function paneIds(ctx) {
  return leafOrder(ctx.layout, ctx.panes);
}

export function focusedPane(ctx) {
  return ctx.panes[ctx.focusedPaneId] ?? ctx.panes[paneIds(ctx)[0]] ?? null;
}

export function activeTabOf(pane) {
  if (!pane) return null;
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
}

/** The view the focused pane is showing, or null when that pane is empty. */
export function focusedView(ctx) {
  return activeTabOf(focusedPane(ctx))?.view ?? null;
}

/** Tab count and pane count for a context — the context strip's live readout. */
export function contextCounts(ctx) {
  const ids = paneIds(ctx);
  return {
    panes: ids.length,
    tabs: ids.reduce((n, id) => n + (ctx.panes[id]?.tabs.length ?? 0), 0),
  };
}

/**
 * The subject contract — the single answer to "what is on screen?".
 *
 * The Lab's `subject.ts` is credited with killing a whole bug class
 * (contextual surfaces dead-ending on a route they did not know). Main's
 * equivalent is this: one function that turns a tab into an identity other
 * surfaces can reason about. The Margin, the context header and the future
 * browser surface all read THIS rather than each re-deriving the answer.
 *
 * `entity` is the id of the REAL record the tab is showing (`academic.tree`
 * gives every subject one), carried on the tab itself. That is what makes the
 * identity survive a tab switch: the pane reads it from the tab, not from a
 * shell-wide "last opened" variable that every pane would have to share.
 * A tab with no record is a plain surface, exactly as before.
 */
export function subjectOf(view, label = view, entity = null) {
  return {
    key: entity ? `${view}:${entity}` : view,
    view,
    kind: entity ? "entity" : "surface",
    label: entity ?? label,
  };
}

/* ------------------------------------------------------------------ *
 * Trails (route-level back/forward inside one pane)
 * ------------------------------------------------------------------ */

const TRAIL_CAP = 40;

/**
 * Record that a pane is now showing the tab `tabId`. Truncates any forward
 * entries.
 *
 * ENTRIES ARE TAB IDS, NOT VIEW NAMES (D2-D6 Phase 2, design 2.3.1; the Lab's
 * `ws.removeTabEverywhere` keeps tab ids for the same reason). A view name
 * cannot tell two records of one destination apart: with two web pages open in
 * one pane the trail would read ["page", "page"] and a Back step had to guess
 * which one it meant — it landed on whichever `page` tab the strip listed
 * first, i.e. the wrong page. The tab id IS the identity the workspace already
 * keys tabs by (`tabKey`), so an entry names the exact tab; and because
 * `setTabEntity` re-points a tab without changing its id, an entry cannot be
 * stranded by a page tab adopting a new page.
 */
export function pushTrail(pane, tabId) {
  if (!tabId) return pane;
  const at = pane.trailAt ?? -1;
  const back = (pane.trail ?? []).slice(0, at + 1);
  if (back[back.length - 1] === tabId) return pane;
  const trail = [...back, tabId].slice(-TRAIL_CAP);
  return { ...pane, trail, trailAt: trail.length - 1 };
}

/** Move the pointer by `delta` (-1 back, +1 forward). Returns a new pane. */
export function stepTrail(pane, delta) {
  const at = pane.trailAt ?? -1;
  const next = at + delta;
  if (next < 0 || next > (pane.trail?.length ?? 0) - 1) return pane;
  return { ...pane, trailAt: next };
}

export function trailState(pane) {
  const len = pane?.trail?.length ?? 0;
  const at = pane?.trailAt ?? -1;
  return { canBack: at > 0, canFwd: at >= 0 && at < len - 1 };
}

/** The tab the trail pointer currently sits on, if any. */
export function trailTabId(pane) {
  const at = pane?.trailAt ?? -1;
  return at >= 0 ? (pane.trail?.[at] ?? null) : null;
}

/**
 * Drop every trail entry for `tabId`, moving the pointer onto the entry that
 * survives at or before its old position.
 *
 * Closing or moving a tab must take its history with it: an entry left behind
 * points at a tab the pane no longer holds, and a step would silently skip it
 * (or, before the entries were tab ids, land on a different record of the same
 * view). Both `closeTab` and `moveTab` route through here, so the two cannot
 * drift apart.
 */
export function withoutTrailEntry(pane, tabId) {
  const before = pane.trail ?? [];
  if (!before.includes(tabId)) return pane;
  const at = pane.trailAt ?? -1;
  const removedBefore = before.slice(0, at).filter((x) => x === tabId).length;
  const trail = before.filter((x) => x !== tabId);
  const trailAt =
    trail.length === 0 ? -1 : Math.min(Math.max(0, at - removedBefore), trail.length - 1);
  return { ...pane, trail, trailAt };
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

function withPane(ctx, paneId, next) {
  return { ...ctx, panes: { ...ctx.panes, [paneId]: next } };
}

function withLayout(ctx, layout) {
  return { ...ctx, layout };
}

/**
 * Replace a pane leaf in the layout tree. `replace` receives the pane id and
 * returns the node that takes its place (or null to drop the leaf entirely).
 */
function mapLayout(node, paneId, fn) {
  if (node.kind === "pane") {
    return node.paneId === paneId ? fn(node) : node;
  }
  const children = node.children.map((c) => mapLayout(c, paneId, fn));
  return collapse({ ...node, children });
}

/** Splits with fewer than two children are not splits. */
function collapse(node) {
  if (node.kind === "pane") return node;
  const children = node.children.filter(Boolean);
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/* ------------------------------------------------------------------ *
 * Tab operations
 * ------------------------------------------------------------------ */

/**
 * The fold/dedupe key of a tab (approved D2-5): a destination is one tab per
 * `view` PER ENTITY, not per view alone. A bare tab has no entity, so its key
 * is the view itself; a tab showing a record is distinct from the bare tab.
 * This is ONE rule for every view, not an exception for page tabs — a record
 * (`tree` → CS301 vs CS410) folds exactly like a browser page does.
 */
export function tabKey(tab) {
  return tab.entity == null ? `view:${tab.view}` : `view:${tab.view}|entity:${String(tab.entity)}`;
}

/**
 * Open (or focus) a destination in a pane, keyed by the tab's
 * `(view, entity)` pair.
 *
 *   - Opening the same destination WITH the same entity focuses it instead of
 *     duplicating it.
 *   - Opening an entity-bearing destination whose exact pair does not exist
 *     but the view's bare tab does — the "Web page" placeholder from
 *     `openNewPage` — ADOPTS that bare tab: it becomes the record-bearing tab
 *     (its label follows too). This keeps the page flow working with no
 *     special case for page views, and preserves the rail click contract:
 *     adopting must not be able to hide a SECOND tab behind itself.
 *   - Opening an entity-bearing destination with NEITHER a matching pair nor a
 *     bare tab creates a new tab (two records can sit side by side).
 *   - Opening with NO entity prefers the bare tab of the view, else focuses
 *     the view's existing entity tab WITHOUT changing its identity — resting
 *     on the rail's "Subjects" must not erase the subject you were reading —
 *     and only creates a bare tab when the view is open nowhere.
 */
export function openInPane(ctx, paneId, view, label = view, entity = null) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  let tabs = pane.tabs;
  let tab = null;
  if (entity != null) {
    tab =
      tabs.find((t) => t.view === view && String(t.entity) === String(entity)) ??
      tabs.find((t) => t.view === view && t.entity == null) ??
      null;
    if (tab && tab.entity == null) {
      tab = { ...tab, entity, label };
      tabs = tabs.map((t) => (t.id === tab.id ? tab : t));
    }
  } else {
    tab =
      tabs.find((t) => t.view === view && t.entity == null) ??
      tabs.find((t) => t.view === view) ??
      null;
  }
  if (!tab) {
    tab = createTab({ view, label, entity: entity ?? null });
    tabs = [...tabs, tab];
  }
  const next = pushTrail({ ...pane, tabs, activeTabId: tab.id }, tab.id);
  return { ...withPane(ctx, paneId, next), focusedPaneId: paneId };
}

/** Open in the focused pane. */
export function openInFocused(ctx, view, label = view, entity = null) {
  return openInPane(ctx, focusedPane(ctx).id, view, label, entity);
}

/**
 * Open a NEW bare page tab in a pane — the pane header's "New web page".
 *
 * Deliberately NOT `openInPane(ctx, paneId, "page", "Web page")`. That is the
 * RAIL rule: it prefers a tab of the view that is already there, so a second
 * click would focus the page the pane is showing instead of giving the pane
 * another page slot — and one pane could never hold two pages. A page tab's
 * identity is its `(view, entity)` pair (approved D2-5), so "new" has to mean
 * new: the tab starts bare and ADOPTS the page it navigates to, which is
 * exactly what `openInPane`'s adopt rule does for a bare tab.
 */
export function openPageTab(ctx, paneId, label = "Web page", entity = null, { activate = true } = {}) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  const tab = createTab({ view: "page", label, entity });
  const withTab = { ...pane, tabs: [...pane.tabs, tab] };
  // A "new" control activates the tab it just made, because the user asked for
  // it. A popup main approved (approved decision D3-3) does NOT: it is appended
  // to the strip and stays in the background, so a page cannot steal the pane
  // the user is reading. The trail is likewise pushed only for an activated
  // open, so Back/Forward describe what the user actually visited rather than
  // what a page opened behind them.
  const next = activate
    ? pushTrail({ ...withTab, activeTabId: tab.id }, tab.id)
    : withTab;
  return { ...withPane(ctx, paneId, next), focusedPaneId: activate ? paneId : ctx.focusedPaneId };
}

/** The pane in this context that already holds `view`, in visual order, or null. */
export function paneWithView(ctx, view) {
  return paneIds(ctx).find((id) => ctx.panes[id].tabs.some((t) => t.view === view)) ?? null;
}

/**
 * Show `view` somewhere in this context: activate the tab that already holds it
 * (wherever it is in the tree) rather than duplicating it, otherwise open it in
 * the focused pane. This is the seam `store.navigate` uses for a plain
 * destination switch. Routing the "already open" case through `openInPane` is
 * what lets an entity-bearing open re-point that same tab.
 */
export function openView(ctx, view, label = view, entity = null) {
  const paneId = paneWithView(ctx, view);
  if (!paneId) return openInFocused(ctx, view, label, entity);
  return openInPane(ctx, paneId, view, label, entity);
}

/**
 * Re-point (or clear) the record a tab is showing. `null` returns the tab to
 * its bare surface — the same answer `subjectOf` gives a fresh tab. Assigning
 * what is already there is a no-op, so callers can be naive.
 */
export function setTabEntity(ctx, paneId, tabId, entity) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab || String(tab.entity ?? "") === String(entity ?? "")) return ctx;
  const next = { ...tab, entity: entity ?? null };
  return withPane(ctx, paneId, { ...pane, tabs: pane.tabs.map((t) => (t.id === tabId ? next : t)) });
}

export function activateTab(ctx, paneId, tabId) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab) return ctx;
  const next = pushTrail({ ...pane, activeTabId: tabId }, tabId);
  return { ...withPane(ctx, paneId, next), focusedPaneId: paneId };
}

/**
 * Activate a tab as a TRAIL STEP: move the trail pointer onto the entry being
 * shown instead of recording a new one.
 *
 * `activateTab` IS a navigation — it appends to the trail — so a back step that
 * went through it appended a duplicate of the target at the end and left the
 * entries ahead of the user behind the pointer: Forward then had nowhere to go,
 * which makes the chevrons an undo button rather than back/forward. This is the
 * one transition that moves the pointer without touching the trail, so only
 * `store.trailStep` should use it; a normal activation keeps using
 * `activateTab`.
 */
export function activateTrailEntry(ctx, paneId, tabId, trailAt) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  if (!pane.tabs.some((t) => t.id === tabId)) return ctx;
  return {
    ...withPane(ctx, paneId, { ...pane, activeTabId: tabId, trailAt }),
    focusedPaneId: paneId,
  };
}

/**
 * Close a tab. Focus falls to the neighbour that took its place, else the one
 * before it — the behaviour the existing strip already had. An empty pane in a
 * split is removed and its split collapses; the last pane in a context is kept
 * (empty) so a context always has somewhere to put the next destination.
 */
export function closeTab(ctx, paneId, tabId) {
  const pane = ctx.panes[paneId];
  if (!pane) return ctx;
  const index = pane.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return ctx;

  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  let activeTabId = pane.activeTabId;
  if (activeTabId === tabId) {
    const next = tabs[index] ?? tabs[index - 1] ?? null;
    activeTabId = next ? next.id : null;
  }
  // The closed tab's own history leaves with it (see `withoutTrailEntry`): a
  // Back step must never land the pane on a tab that is open nowhere.
  const updated = withoutTrailEntry({ ...pane, tabs, activeTabId }, tabId);

  if (tabs.length === 0 && paneIds(ctx).length > 1) {
    const without = { ...ctx.panes };
    delete without[paneId];
    const layout = mapLayout(ctx.layout, paneId, () => null);
    const order = leafOrder(layout, without);
    return {
      ...ctx,
      layout,
      panes: without,
      focusedPaneId: order.includes(ctx.focusedPaneId) ? ctx.focusedPaneId : (order[0] ?? null),
    };
  }
  return withPane(ctx, paneId, updated);
}

export function closeFocusedTab(ctx) {
  const pane = focusedPane(ctx);
  if (!pane?.activeTabId) return ctx;
  return closeTab(ctx, pane.id, pane.activeTabId);
}

/**
 * Move a tab from one pane to another (Space Bunny: the Lab's `ws.moveTab`, wired
 * to a drag in `PaneGrid` and to the pane header's move control).
 *
 * The tab keeps its IDENTITY — id, label and entity travel with it — because
 * that identity is what a browser page tab carries (approved D2-5). For the
 * embedded browser the move is nothing more than a bounds change plus a
 * re-attach of the SAME native view to the same single window: no webContents
 * migration, no reload, history intact. `services/browser/host.js` never hears
 * about it, which is why a move cannot disturb a page.
 *
 * The tab is removed by identity from EVERY pane (a tab lives in exactly one
 * pane, but enforcing that here makes the invariant a fact rather than an
 * assumption), its history is dropped from the pane it left, and it becomes the
 * target pane's active tab — landing in a pane is a navigation into it, so the
 * target pane's trail records it. A source pane left empty in a split collapses
 * exactly as it does on close; the last pane in a context is kept (empty) so a
 * context always has somewhere to put the next destination.
 */
export function moveTab(ctx, paneId, tabId, toPaneId) {
  const from = ctx.panes[paneId];
  const to = ctx.panes[toPaneId];
  if (!from || !to || paneId === toPaneId) return ctx;
  const moved = from.tabs.find((t) => t.id === tabId);
  if (!moved) return ctx;
  if (to.tabs.some((t) => t.id === tabId)) return ctx;

  const panes = {};
  for (const [id, p] of Object.entries(ctx.panes)) {
    if (id === toPaneId) continue;
    const index = p.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) {
      panes[id] = p;
      continue;
    }
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    const activeTabId =
      p.activeTabId === tabId
        ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
        : p.activeTabId;
    panes[id] = withoutTrailEntry({ ...p, tabs, activeTabId }, tabId);
  }
  panes[toPaneId] = pushTrail(
    { ...to, tabs: [...to.tabs, moved], activeTabId: tabId },
    tabId,
  );

  if (panes[paneId].tabs.length === 0 && Object.keys(panes).length > 1) {
    delete panes[paneId];
    const layout = mapLayout(ctx.layout, paneId, () => null);
    return { ...ctx, layout, panes, focusedPaneId: toPaneId };
  }
  return { ...ctx, panes, focusedPaneId: toPaneId };
}

/* ------------------------------------------------------------------ *
 * Panes, splits and focus
 * ------------------------------------------------------------------ */

export function focusPane(ctx, paneId) {
  if (!ctx.panes[paneId]) return ctx;
  // A redundant focus is a no-op that returns the SAME context. Callers include
  // the shell's focus-from-native effect, which both reads and writes the
  // workspace: minting a new context on a focus that changes nothing would make
  // that effect dirty the value it depends on and loop
  // (`effect_update_depth_exceeded`). No change, no new object.
  if (ctx.focusedPaneId === paneId) return ctx;
  return { ...ctx, focusedPaneId: paneId };
}

/**
 * Split the focused pane (or a named one) in `dir`, seeding the new pane with
 * the given destination. The new pane takes half the parent's space.
 *
 * The seed carries the tab's ENTITY too, so splitting "Subjects — CS301" gives
 * you the same subject on both sides rather than a bare Subjects index.
 */
export function splitPane(ctx, dir, { targetPaneId = null, view = null, label = null, entity = null } = {}) {
  const target = targetPaneId ?? focusedPane(ctx).id;
  if (!ctx.panes[target]) return ctx;

  const fresh = createPane();
  let next = {
    ...ctx,
    panes: { ...ctx.panes, [fresh.id]: fresh },
    focusedPaneId: fresh.id,
  };
  next = withLayout(
    next,
    mapLayout(next.layout, target, (node) => ({
      kind: "split",
      id: uid("split"),
      dir,
      sizes: [0.5, 0.5],
      children: [node, { kind: "pane", paneId: fresh.id }],
    })),
  );
  if (view) next = openInPane(next, fresh.id, view, label ?? view, entity);
  return next;
}

export function closePane(ctx, paneId) {
  const order = paneIds(ctx);
  if (order.length <= 1 || !ctx.panes[paneId]) return ctx;
  const without = { ...ctx.panes };
  delete without[paneId];
  const layout = mapLayout(ctx.layout, paneId, () => null);
  const rest = leafOrder(layout, without);
  return {
    ...ctx,
    layout,
    panes: without,
    focusedPaneId: rest.includes(ctx.focusedPaneId) ? ctx.focusedPaneId : (rest[0] ?? null),
  };
}

/** Resize a split. `sizes` are fractions summing to ~1, one per child. */
export function setSplitSizes(ctx, splitId, sizes) {
  const walk = (node) => {
    if (node.kind === "pane") return node;
    const children = node.children.map(walk);
    if (node.id === splitId) return { ...node, sizes, children };
    return { ...node, children };
  };
  return withLayout(ctx, walk(ctx.layout));
}

/**
 * Change a pane's mode. `content` is a first-class destination, not an absence
 * — the Lab had no way back and a user who tried Margin was stuck with it.
 */
export function setPaneMode(ctx, paneId, mode) {
  const pane = ctx.panes[paneId];
  if (!pane || !PANE_MODES.includes(mode)) return ctx;
  if (mode === "margin") {
    // A margin always follows a content pane; if this IS the only pane there is
    // nothing to follow, so it stays content rather than becoming a margin of
    // nothing.
    const content = paneIds(ctx).find((id) => id !== paneId && ctx.panes[id].mode !== "margin");
    if (!content) return ctx;
    return withPane(ctx, paneId, { ...pane, mode, boundTo: content });
  }
  return withPane(ctx, paneId, { ...pane, mode, boundTo: mode === "content" ? null : pane.boundTo });
}

/**
 * Geometric focus movement inside the layout tree (Ctrl+Alt+arrows).
 * Climbs out of the current split when the direction exits it, like a tiling
 * window manager, and does nothing at the edge rather than wrapping.
 */
export function focusDirection(ctx, dir) {
  const wantRow = dir === "left" || dir === "right";
  const forward = dir === "right" || dir === "down";

  // The chain of splits from the root down to the focused pane, outermost first.
  const path = pathToFocused(ctx.layout, ctx.focusedPaneId);
  if (!path) return ctx;

  // Walk outward from the deepest split that runs on the requested axis. The
  // first one with a neighbour in that direction wins; when the focused pane sits
  // at the edge of the deepest such split, focus climbs to a shallower one —
  // which is how a pane inside a nested split moves out to its sibling column.
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const { node, index } = path[i];
    if (node.dir !== (wantRow ? "row" : "col")) continue;
    const neighbour = node.children[forward ? index + 1 : index - 1];
    if (!neighbour) continue;
    const ids = leafOrder(neighbour, ctx.panes);
    if (!ids.length) continue;
    // Land on the neighbour's NEAREST edge: right/down enters at its first leaf,
    // left/up at its last, so focus moves the way the eye reads it.
    return focusPane(ctx, forward ? ids[0] : ids[ids.length - 1]);
  }
  // No neighbour on that axis: stay put rather than wrapping.
  return ctx;
}

/**
 * Splits from the root to the pane, outermost first, as `{node, index}` pairs
 * (`index` being which child of `node` the path continues through). Null when
 * the pane is not in this tree.
 */
function pathToFocused(node, focusedId) {
  if (node.kind === "pane") return node.paneId === focusedId ? [] : null;
  for (let i = 0; i < node.children.length; i += 1) {
    const rest = pathToFocused(node.children[i], focusedId);
    if (rest) return [{ node, index: i }, ...rest];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Arrangements — reshape from the tabs that are already open
 * ------------------------------------------------------------------ */

/**
 * Reshape a context's pane tree from its existing tabs. Nothing is closed: the
 * tabs are re-distributed, and a margin/ledge that survives the new shape keeps
 * its mode and its binding.
 */
export function applyArrangement(ctx, arrangement) {
  const ids = paneIds(ctx);
  const all = ids.flatMap((id) => ctx.panes[id].tabs);
  if (!ARRANGEMENTS.includes(arrangement)) return ctx;

  // Distinct tabs (by tabKey) in visual order — two tabs are ONE destination
  // only when both their view AND their entity agree (approved D2-5): a
  // reshape with Subjects-CS301 beside Subjects-CS410 keeps BOTH records,
  // instead of silently dropping the one the user was not focused on.
  // (Lab weakness #6, for identity rather than for mode.)
  const seen = new Map();
  for (const t of all) if (!seen.has(tabKey(t))) seen.set(tabKey(t), t);
  // The focused pane's own active tab wins its key, so the reshape never
  // touches the record the user is actually looking at, whichever copy of it
  // the fold picked up first in traversal order.
  const focusedTab = activeTabOf(focusedPane(ctx));
  if (focusedTab) seen.set(tabKey(focusedTab), focusedTab);
  const tabs = [...seen.values()];

  const build = (groups, { dir = "row", modes = [], bind = null } = {}) => {
    // The panes that exist before the reshape, so a group that is exactly a pane
    // the user already had can keep that pane's process mode (Lab weakness #6:
    // arrangements silently dropped modes).
    const previous = ids.map((id) => ctx.panes[id]);
    const panes = {};
    const children = groups.map((group, i) => {
      const views = new Set(group.map((t) => t.view));
      const prior = modes[i]
        ? null
        : previous.find(
            (p) =>
              p.mode !== "content" &&
              p.tabs.length === group.length &&
              p.tabs.every((t) => views.has(t.view)),
          );
      const p = createPane(modes[i] ?? prior?.mode ?? "content");
      p.tabs = group;
      // Keep the user where they were: the pane holding the previously active
      // DESTINATION opens on THAT tab (matched by identity, not by a view that
      // now exists twice), not on whichever tab happens to be last.
      p.activeTabId =
        (focusedTab && group.includes(focusedTab) ? focusedTab.id : null) ??
        group[group.length - 1]?.id ??
        null;
      panes[p.id] = p;
      return { kind: "pane", paneId: p.id };
    });
    const contentId = children.find((c) => panes[c.paneId].mode === "content")?.paneId ?? children[0].paneId;
    // A margin always follows a content pane, whether the arrangement asked for
    // it (`bind`) or the mode survived the reshape.
    const marginIndex = bind ? bind.index : null;
    const boundChild = marginIndex == null ? null : children[marginIndex];
    if (boundChild) {
      panes[boundChild.paneId] = { ...panes[boundChild.paneId], boundTo: contentId };
    }
    for (const child of children) {
      const pane = panes[child.paneId];
      if (pane.mode === "margin" && !pane.boundTo) {
        panes[child.paneId] = { ...pane, boundTo: contentId };
      }
    }
    // Keep the user where they were: focus the pane that holds the old active
    // viewport (the exact tab, not merely "some tab of that view").
    const focused =
      children.find((c) => focusedTab && panes[c.paneId].tabs.includes(focusedTab))?.paneId ??
      contentId;
    return {
      ...ctx,
      panes,
      focusedPaneId: focused,
      layout:
        children.length === 1
          ? children[0]
          : { kind: "split", id: uid("split"), dir, sizes: children.map(() => 1 / children.length), children },
    };
  };

  switch (arrangement) {
    case "single":
      return build([tabs]);

    case "split": {
      if (tabs.length < 2) return build([tabs]);
      const half = Math.ceil(tabs.length / 2);
      return build([tabs.slice(0, half), tabs.slice(half)]);
    }

    case "trio": {
      if (tabs.length < 3) return build([tabs]);
      const size = Math.ceil(tabs.length / 3);
      return build([tabs.slice(0, size), tabs.slice(size, size * 2), tabs.slice(size * 2)]);
    }

    case "margin": {
      if (tabs.length < 2) return build([tabs]);
      const [first, ...rest] = tabs;
      return build([[first], rest], { modes: ["content", "margin"], bind: { index: 1 } });
    }

    case "ledge": {
      if (tabs.length < 2) return build([tabs]);
      // Content on top, the reference band below it — a col, not a row.
      return build([tabs.slice(0, 1), tabs.slice(1)], { dir: "col", modes: ["content", "ledge"] });
    }

    default:
      return ctx;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace (contexts)
 * ------------------------------------------------------------------ */

export function activeContext(ws) {
  return ws.contexts.find((c) => c.id === ws.activeContextId) ?? ws.contexts[0] ?? null;
}

export function updateContext(ws, ctxId, fn) {
  return { ...ws, contexts: ws.contexts.map((c) => (c.id === ctxId ? fn(c) : c)) };
}

export function openContext(ws, ctxId) {
  return ws.contexts.some((c) => c.id === ctxId) ? { ...ws, activeContextId: ctxId } : ws;
}

export function cycleContext(ws, delta) {
  if (ws.contexts.length < 2) return ws;
  const i = ws.contexts.findIndex((c) => c.id === ws.activeContextId);
  if (i === -1) return ws;
  const next = (i + delta + ws.contexts.length) % ws.contexts.length;
  return { ...ws, activeContextId: ws.contexts[next].id };
}

/** Drop a context. The last one is never removed — the shell needs a stage. */
export function dissolveContext(ws, ctxId) {
  if (ws.contexts.length <= 1) return ws;
  const contexts = ws.contexts.filter((c) => c.id !== ctxId);
  const activeContextId = ws.activeContextId === ctxId ? contexts[0].id : ws.activeContextId;
  return { ...ws, contexts, activeContextId };
}

export function renameContext(ws, ctxId, name) {
  return updateContext(ws, ctxId, (c) => ({ ...c, name }));
}

/**
 * Reopen the last closed tab (Ctrl+Shift+T). The store writes `lastClosed`
 * when a tab closes; this is the single implementation of the restore — it
 * opens the tab (entity included) in the pane it came from and makes that
 * context active again, so a reopen brings you back to where the tab lived.
 * If the context has since been dissolved there is nothing to restore into.
 */
export function reopenClosed(ws) {
  const last = ws.lastClosed;
  if (!last?.tab) return ws;
  if (!ws.contexts.some((c) => c.id === last.ctxId)) return ws;
  const next = updateContext(ws, last.ctxId, (c) =>
    openInFocused(c, last.tab.view, last.tab.label, last.tab.entity),
  );
  return { ...next, activeContextId: last.ctxId, lastClosed: null };
}
