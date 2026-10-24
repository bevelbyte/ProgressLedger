/**
 * Workspace store — the thin reactive wrapper around `model.js`.
 *
 * Split deliberately in two:
 *   model.js      pure state transitions, testable in plain Node
 *   store.svelte.js  $state + the actions the shell calls
 *
 * The important contract is `currentView()`. The shell used to hold a single
 * global `currentView`; it is now DERIVED from the focused pane's active tab.
 * That one indirection is what lets W1 introduce contexts and panes without
 * changing what a rail click, a deep link, Ctrl+1..9 or a palette hit does: they
 * all still funnel through `navigate()`, which now writes to a pane instead of a
 * global.
 *
 * Workspace state is persisted locally per profile to preserve the user's
 * open tabs, pane splits, arrangements, and active contexts across application
 * launches and reloads, while falling back gracefully to defaultWorkspace() on
 * invalid or missing state.
 */

import * as M from "./model.js";
import { defaultWorkspace, CONTEXT_OWNER } from "./contexts.js";

export const WORKSPACE_STORAGE_KEY_PREFIX = "cf.workspace.state.v1";

let activeWorkspaceProfileId = null;
let persistTimer = null;

export function setWorkspaceProfileId(profileId) {
  if (persistTimer && activeWorkspaceProfileId !== profileId) {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (activeWorkspaceProfileId != null) {
      saveWorkspace(activeWorkspaceProfileId);
    }
  }
  activeWorkspaceProfileId = profileId ?? null;
}

export function getWorkspaceProfileId() {
  return activeWorkspaceProfileId;
}

export function resolveStorageKey(profileId = activeWorkspaceProfileId) {
  if (profileId != null && profileId !== "") {
    return `${WORKSPACE_STORAGE_KEY_PREFIX}.profile_${profileId}`;
  }
  return WORKSPACE_STORAGE_KEY_PREFIX;
}

export function serializeWorkspace(ws) {
  if (!ws || !Array.isArray(ws.contexts)) return null;
  return {
    version: 1,
    activeContextId: ws.activeContextId,
    immerse: ws.immerse === true,
    contexts: ws.contexts.map((c) => ({
      id: c.id,
      name: c.name,
      seed: c.seed ?? null,
      icon: c.icon,
      hue: c.hue,
      layout: c.layout,
      panes: c.panes,
      focusedPaneId: c.focusedPaneId,
      createdAt: c.createdAt,
    })),
  };
}

export function validateWorkspaceSnapshot(data) {
  if (!data || typeof data !== "object") return null;
  if (data.version !== 1) return null;
  if (typeof data.activeContextId !== "string" || !data.activeContextId) return null;
  if (!Array.isArray(data.contexts) || data.contexts.length === 0) return null;

  const validContexts = [];
  for (const c of data.contexts) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id) return null;
    if (typeof c.name !== "string" || !c.name) return null;
    if (!c.layout || typeof c.layout !== "object") return null;
    if (!c.panes || typeof c.panes !== "object") return null;
    if (typeof c.focusedPaneId !== "string" || !c.panes[c.focusedPaneId]) return null;

    for (const pId of Object.keys(c.panes)) {
      const p = c.panes[pId];
      if (!p || typeof p !== "object" || p.id !== pId) return null;
      if (!Array.isArray(p.tabs)) return null;
      for (const t of p.tabs) {
        if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.view !== "string") {
          return null;
        }
      }
    }
    validContexts.push(c);
  }

  if (!validContexts.some((c) => c.id === data.activeContextId)) return null;

  return {
    contexts: validContexts,
    activeContextId: data.activeContextId,
    lastClosed: null,
    immerse: data.immerse === true,
  };
}

export function saveWorkspace(profileId = activeWorkspaceProfileId) {
  if (typeof localStorage === "undefined") return false;
  try {
    const snapshot = serializeWorkspace(workspace);
    if (!snapshot) return false;
    const key = resolveStorageKey(profileId);
    localStorage.setItem(key, JSON.stringify(snapshot));
    return true;
  } catch (e) {
    return false;
  }
}

export function schedulePersist(profileId = activeWorkspaceProfileId, delayMs = 150) {
  if (typeof localStorage === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveWorkspace(profileId);
  }, delayMs);
}

export function restoreWorkspace(profileId = activeWorkspaceProfileId) {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (typeof localStorage === "undefined") {
    __resetWorkspace();
    return false;
  }
  try {
    const key = resolveStorageKey(profileId);
    const raw = localStorage.getItem(key);
    if (!raw) {
      __resetWorkspace();
      return false;
    }
    const parsed = JSON.parse(raw);
    const validated = validateWorkspaceSnapshot(parsed);
    if (!validated) {
      __resetWorkspace();
      return false;
    }

    workspace.contexts = validated.contexts;
    workspace.activeContextId = validated.activeContextId;
    workspace.lastClosed = validated.lastClosed;
    workspace.immerse = validated.immerse;
    return true;
  } catch (e) {
    __resetWorkspace();
    return false;
  }
}

export function clearPersistedWorkspace(profileId = activeWorkspaceProfileId) {
  if (typeof localStorage === "undefined") return;
  try {
    const key = resolveStorageKey(profileId);
    localStorage.removeItem(key);
  } catch {}
}

/** The live workspace. */
export const workspace = $state(defaultWorkspace());

/* ---- selectors (safe to call from a template; they read $state) ---- */

export function activeContext() {
  return M.activeContext(workspace);
}

export function focusedPane() {
  const ctx = activeContext();
  return ctx ? M.focusedPane(ctx) : null;
}

export function focusedView() {
  const ctx = activeContext();
  return ctx ? M.focusedView(ctx) : null;
}

/**
 * The compatibility seam. Everything that used to read the shell's global
 * `currentView` reads this instead.
 */
export function currentView() {
  return focusedView() ?? "home";
}

export function focusedTabs() {
  return focusedPane()?.tabs ?? [];
}

export function focusedPaneId() {
  return focusedPane()?.id ?? null;
}

export function focusedActiveTabId() {
  return focusedPane()?.activeTabId ?? null;
}

export function contextSummary(ctx) {
  return M.contextCounts(ctx);
}

/**
 * The subject contract, resolved for the focused pane: what is on screen right
 * now (`workspace/model.js` → `subjectOf`). Later waves (the Margin, the native
 * browser) read THIS instead of each re-deriving the answer from the view id.
 */
export function currentSubject() {
  const ctx = activeContext();
  if (!ctx) return null;
  const tab = M.activeTabOf(M.focusedPane(ctx));
  return tab ? M.subjectOf(tab.view, tab.label, tab.entity) : null;
}

/**
 * The record the active tab of the FOCUSED pane is showing, or null. This is
 * what the pane that renders that tab reads, so two panes can hold two
 * different records with no shared "last opened" state to collide in.
 */
export function currentEntity() {
  const ctx = activeContext();
  if (!ctx) return null;
  return M.activeTabOf(M.focusedPane(ctx))?.entity ?? null;
}

/**
 * Resolve the page currently carrying workspace focus, regardless of which
 * context owns its tab. Used by Research surfaces that are routed to Operator
 * while the live browser tab may remain in System after profile selection.
 */

export function isImmerse() {
  return workspace.immerse === true;
}

/* ---- writes ---- */

function replaceContext(next) {
  const i = workspace.contexts.findIndex((c) => c.id === next.id);
  if (i === -1) return;
  workspace.contexts[i] = next;
  schedulePersist();
}

/** Apply a pure context transition to the active context. */
function mutateActive(fn) {
  const ctx = activeContext();
  if (!ctx) return;
  replaceContext(fn(ctx));
}

/** The seeded context whose domain owns `view`, or null for an unowned view. */
function contextOwningView(view) {
  const seed = CONTEXT_OWNER[view];
  if (!seed) return null;
  return workspace.contexts.find((c) => c.seed === seed) ?? null;
}

/**
 * THE routing entry point. Mirrors the old `navigate(view)`.
 *
 * `entity` is the id of a real record (`academic.tree` → subject). A plain
 * destination switch activates the tab this domain already holds, wherever it
 * sits in the tree. A record-bearing navigation is an action taken IN a pane
 * ("open the subject this deadline belongs to"), so it lands in that domain's
 * FOCUSED pane — the one the user was working in — and never in a sibling pane
 * that merely happens to hold the same destination.
 */
export function navigate(view, label = view, entity = null) {
  const ctx = activeContext();
  if (!ctx) return;
  // A destination belongs to a working domain, so navigating to it lands in that
  // domain's context — it does not drop Deadlines into whatever context the user
  // happened to be in. Unowned views (and views whose domain context has been
  // dissolved) open in the context that is already active.
  const target = contextOwningView(view) ?? ctx;
  if (target.id !== workspace.activeContextId) workspace.activeContextId = target.id;
  replaceContext(
    entity == null
      ? M.openView(target, view, label, null)
      : M.openInFocused(target, view, label, entity),
  );
}

/** Open a destination in a specific pane (used by a pane's "+"). */
export function openIn(paneId, view, label = view, entity = null) {
  mutateActive((c) => M.openInPane(c, paneId, view, label, entity));
}

/**
 * The pane header's "New web page": ALWAYS a new page tab (see
 * `model.openPageTab`). `openIn(…, "page", …)` cannot be reused here — it is
 * the rail rule and would focus the page the pane is already showing.
 *
 * `entity` is optional and is what a MAIN-approved popup (approved decision
 * D3-3) supplies: the page already exists in main, so the tab must be born
 * carrying its id instead of starting bare and adopting it later. `activate:
 * false` keeps the new tab in the background.
 */
export function openPageTab(paneId, label = "Web page", entity = null, opts = {}) {
  mutateActive((c) => M.openPageTab(c, paneId, label, entity, opts));
}

export function activateTab(paneId, tabId) {
  mutateActive((c) => M.activateTab(c, paneId, tabId));
}

/**
 * The pane header's back/forward chevrons (Space Bunny v1 shows them between
 * the pane number and the tab strip; the Lab's `ws.trailBack`/`ws.trailForward`).
 *
 * A trail step MOVES the pane's pointer to the nearest LIVE entry and shows the
 * tab that entry NAMES. Three things make it back/forward rather than an undo:
 *   - the trail is not rewritten. Going through `activateTab` (a navigation)
 *     appended a duplicate at the end and stranded the entries ahead of the
 *     user, so Forward could never move; the pointer moves via
 *     `model.activateTrailEntry` instead, leaving the forward history intact
 *     until the user navigates somewhere new.
 *   - an entry is a TAB ID (design 2.3.1), so two records of one destination in
 *     one pane — two web pages — step to the exact tab the user was on. While
 *     entries were view names, Back guessed "some tab of that view" and could
 *     land on the other page.
 *   - entries whose tab was since closed are skipped, so a back step can never
 *     land the pane on a destination that is open nowhere (the Lab's v2.13 fix).
 */
export function trailStep(paneId, delta) {
  mutateActive((c) => {
    let pane = c.panes[paneId];
    if (!pane) return c;
    const guard = (pane.trail?.length ?? 0) + 1;
    for (let i = 0; i < guard; i += 1) {
      const stepped = M.stepTrail(pane, delta);
      const at = stepped.trailAt ?? -1;
      if (at === (pane.trailAt ?? -1)) return c; // nothing further in this direction
      const tabId = M.trailTabId(stepped);
      if (tabId && pane.tabs.some((t) => t.id === tabId)) {
        return M.activateTrailEntry(c, paneId, tabId, at);
      }
      pane = stepped; // dead entry: skip it and keep stepping
    }
    return c;
  });
}

/**
 * Move a tab to another pane in the same context (Space Bunny: the Lab's
 * `ws.moveTab`). The tab keeps its identity, so a moved browser page tab is
 * still the same page — see `model.moveTab` for why nothing in main changes.
 */
export function moveTab(paneId, tabId, toPaneId) {
  mutateActive((c) => M.moveTab(c, paneId, tabId, toPaneId));
}


/** Re-point (or clear) which record a tab shows — see `model.setTabEntity`. */
export function setTabEntity(paneId, tabId, entity, browserTabId) {
  mutateActive((c) => {
    let next = M.setTabEntity(c, paneId, tabId, entity);
    if (typeof browserTabId === "number") next = M.setTabBrowserTabId(next, paneId, tabId, browserTabId);
    return next;
  });
}
export function closeTab(paneId, tabId) {
  const ctx = activeContext();
  const tab = ctx?.panes?.[paneId]?.tabs.find((t) => t.id === tabId);
  if (tab) workspace.lastClosed = { tab: { ...tab }, ctxId: ctx.id, paneId };
  mutateActive((c) => M.closeTab(c, paneId, tabId));
  // The closed tab's own trail entries are dropped by the model, so a reopened
  // tab (Ctrl+Shift+T) starts a fresh history rather than inheriting a pointer
  // into entries that no longer name anything in the pane.
}

export function closeFocusedTab() {
  const pane = focusedPane();
  const tab = M.activeTabOf(pane);
  if (!pane || !tab) return;
  closeTab(pane.id, tab.id);
}

export function reopenClosed() {
  const next = M.reopenClosed(workspace);
  if (next === workspace) return;
  workspace.contexts = next.contexts;
  workspace.activeContextId = next.activeContextId;
  workspace.lastClosed = next.lastClosed;
}

export function focusPane(paneId) {
  mutateActive((c) => M.focusPane(c, paneId));
}

/**
 * Rename every workspace tab that carries browser page `pageId` (Phase 2 of
 * the D2-D6 plan). The page tab's label follows the page's real title, so the
 * tab strip shows which of two "Web page" tabs is showing what — the visibility
 * a `(view, entity)` workspace owes its identity-bearing tabs. Main trusts its
 * own title string; all the renderer does is mirror it onto the label.
 */
export function renamePageTab(pageId, title) {
  if (typeof pageId !== "string") return;
  if (typeof title !== "string" || !title.trim()) return;
  const label = title.trim();
  const hit = (t) => t.view === "page" && t.entity != null && String(t.entity) === String(pageId);
  for (const ctx of workspace.contexts) {
    let touched = false;
    const panes = { ...ctx.panes };
    for (const id of Object.keys(panes)) {
      const pane = panes[id];
      if (!pane?.tabs.some(hit)) continue;
      panes[id] = { ...pane, tabs: pane.tabs.map((t) => (hit(t) ? { ...t, label } : t)) };
      touched = true;
    }
    if (touched) replaceContext({ ...ctx, panes });
  }
}

/**
 * Give focus to the pane (in whatever context) whose tab carries browser page
 * `pageId` — the shell half of focus-from-native. Clicking INSIDE a native
 * page cannot reach the DOM (the view is painted above it), so main reports
 * the focus and the shell answers here: activate that pane's context, focus
 * the pane, and the chrome (title bar, status bar, pane highlight) follows.
 */
export function focusPaneOfPage(pageId) {
  if (typeof pageId !== "string") return;
  for (const ctx of workspace.contexts) {
    const paneId = M.paneIds(ctx).find((id) =>
      ctx.panes[id]?.tabs.some(
        (t) => t.view === "page" && t.entity != null && String(t.entity) === String(pageId),
      ),
    );
    if (!paneId) continue;
    // Already showing that context, already focused on that pane: the writes
    // below would reproduce the state we are in. Skipping them keeps a
    // redundant report (main re-reports focus on every click into the page)
    // from churning the context's identity -- see `model.focusPane`.
    if (workspace.activeContextId === ctx.id && ctx.focusedPaneId === paneId) return;
    workspace.activeContextId = ctx.id;
    replaceContext(M.focusPane(ctx, paneId));
    return;
  }
}

export function focusDirection(dir) {
  mutateActive((c) => M.focusDirection(c, dir));
}

export function splitFocused(dir, spec = {}) {
  const ctx = activeContext();
  if (!ctx) return;
  const focused = M.focusedPane(ctx);
  const active = M.activeTabOf(focused);
  // A split opens the destination you are already looking at in the new pane by
  // default — the Space Bunny behaviour: you split to keep what you have, then
  // change one side. The seed carries the record too, so splitting a subject's
  // workspace gives the same subject on both sides.
  const seed = spec.view ?? active?.view ?? null;
  if (!seed) return;
  const explicit = spec.view != null;
  mutateActive((c) =>
    M.splitPane(c, dir, {
      view: seed,
      label: explicit ? (spec.label ?? seed) : (active?.label ?? seed),
      entity: explicit ? (spec.entity ?? null) : (active?.entity ?? null),
    }),
  );
}

export function closePane(paneId) {
  mutateActive((c) => M.closePane(c, paneId));
}

export function setPaneSizes(splitId, sizes) {
  mutateActive((c) => M.setSplitSizes(c, splitId, sizes));
}

export function setPaneMode(paneId, mode) {
  mutateActive((c) => M.setPaneMode(c, paneId, mode));
}

export function arrange(arrangement) {
  const ctx = activeContext();
  if (!ctx) return;
  const next = M.applyArrangement(ctx, arrangement);
  workspace.contexts = workspace.contexts.map((c) => (c.id === next.id ? next : c));
  schedulePersist();
}

export function switchContext(ctxId) {
  const next = M.openContext(workspace, ctxId);
  workspace.activeContextId = next.activeContextId;
  schedulePersist();
}

export function cycleContext(delta) {
  const next = M.cycleContext(workspace, delta);
  workspace.activeContextId = next.activeContextId;
  schedulePersist();
}

export function createContext(name) {
  const before = new Set(workspace.contexts.map((c) => c.id));
  const contexts = [...workspace.contexts, M.createContext({ name })];
  const created = contexts.find((c) => !before.has(c.id));
  workspace.contexts = contexts;
  workspace.activeContextId = created.id;
  schedulePersist();
}

export function dissolveContext(ctxId) {
  const next = M.dissolveContext(workspace, ctxId);
  if (next === workspace) return;
  workspace.contexts = next.contexts;
  workspace.activeContextId = next.activeContextId;
  schedulePersist();
}

export function renameContext(ctxId, name) {
  const next = M.renameContext(workspace, ctxId, name);
  workspace.contexts = next.contexts;
  schedulePersist();
}

export function toggleImmerse() {
  workspace.immerse = !workspace.immerse;
  schedulePersist();
}

export function setImmerse(on) {
  workspace.immerse = on === true;
  schedulePersist();
}

/**
 * Test hook: rebuild the boot workspace in place. Fields are assigned rather
 * than the object replaced so anything already holding `workspace` keeps
 * working — the same shape as `__resetOperator`. */
export function __resetWorkspace() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const fresh = defaultWorkspace();
  workspace.contexts = fresh.contexts;
  workspace.activeContextId = fresh.activeContextId;
  workspace.lastClosed = fresh.lastClosed;
  workspace.immerse = fresh.immerse;
}
