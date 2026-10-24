<script>
  // Progress Ledger — shell composition.
  //
  // Composition (docs/DESIGN-ATLAS.md §4, updated for the W1 workspace):
  //
  //   TitleBar        brand · command bar · profile context · operator state
  //   ┌ NavRail  ────┬ stage ────────────────────────────────────────────┐
  //   │  Spine       │ ContextStrip  (contexts · arrange · split)        │
  //   │  planes      │ ContextHeader (title · subtitle · view actions)   │
  //   │              │ work surface  (pane grid | browser dock | quick)  │
  //   │              │ OperatorConsole  (approvals · runs · activity)     │
  //   └──────────────┴──────────────────────────────────────────────────┘
  //   StatusBar       workspace · storage · core · operator · clock
  //
  // What this file owns: composition, the profile context, global overlays
  // (notes, quick note, focus) and global keyboard. It no longer owns routing
  // *state*: the workspace store does (contexts → panes → tabs), and
  // `currentView` below is DERIVED from the focused pane's active tab. Every
  // existing navigation entry point still funnels through `navigate()`, so a
  // rail click, a deep link, Ctrl+1..9 and a palette hit all behave as before.
  //
  // The per-view `{#if view === …}` chain moved to shell/PaneView.svelte, because
  // a workspace can show several destinations at once and the mapping must be
  // callable per pane rather than once per app.

  import { onMount, untrack } from "svelte";

  import { CommandPalette } from "./features/command-palette";
  import { NoteEditor, QuickNote } from "./features/notes";
  import { FocusSession } from "./features/focus";
  import Toaster from "./shared/components/Toaster.svelte";
  import { Onboarding } from "./features/onboarding";
  import { toast } from "./shared/stores/toasts.svelte.js";
  import { reportError } from "./shared/utils/errors.js";
  import {
    onboarding,
    shouldShowOnboarding,
    startOnboarding,
  } from "./shared/stores/onboarding.svelte.js";
  import {
    profileStore,
    loadProfiles,
    selectProfile as selectProfileInStore,
  } from "./features/profiles";
  import { initDebugLogger, logViewLifecycle } from "./shared/utils/debug-logger.js";

  // Atlas shell surfaces
  import TitleBar from "./shell/TitleBar.svelte";
  import NavRail from "./shell/NavRail.svelte";
  import ContextHeader from "./shell/ContextHeader.svelte";
  import ContextStrip from "./shell/ContextStrip.svelte";
  import PaneGrid from "./shell/PaneGrid.svelte";
  import Spine from "./shell/Spine.svelte";
  import OperatorConsole from "./shell/OperatorConsole.svelte";
  import StatusBar from "./shell/StatusBar.svelte";
  import KeyboardHelp from "./shell/KeyboardHelp.svelte";
  import { viewFor, orderedViews, isProfileGated } from "./shell/view-registry.js";
  import { operator, startOperator } from "./shell/operator.svelte.js";
  // Workspace model (contexts → panes → tabs), transferred from the Space Bunny
  // v2 shell. The store owns the shell's navigation state; `currentView` below is
  // DERIVED from it, which is what lets every existing entry point keep working.
  import * as ws from "./shell/workspace/store.svelte.js";
  import {
    browser as browserStore,
    subscribe as subscribeBrowser,
    refresh as refreshBrowser,
    closePage as closeBrowserPage,
    openPage as createBrowserPage,
    setOccluded as setBrowserOccluded,
  } from "./shared/stores/browser.svelte.js";

  // ---- Core status ----
  let coreStatus = $state("checking…");
  let online = $state(false);

  async function checkCore() {
    try {
      coreStatus = await window.progressLedger.ping();
      online = true;
    } catch (e) {
      coreStatus = "Rust core unreachable: " + (e?.message ?? e);
      online = false;
    }
  }
  checkCore();

  // ---- Onboarding ----
  $effect(() => {
    if (shouldShowOnboarding()) {
      setTimeout(() => startOnboarding(), 500);
    }
  });

  function handleOnboardingComplete() {
    toast.success("Welcome to Progress Ledger!", "Tutorial Complete");
  }

  // ---- Routing & layout state ----
  // The initial view stays `profiles` on purpose: with no profile selected
  // there is nothing to put on the Desk, and profile creation is the only
  // meaningful first action. Selecting a profile is what moves the user into
  // their work (see selectProfile).
  //
  // `currentView` is DERIVED from the focused pane's active tab rather than
  // assigned. The boot workspace's active context is the one that owns
  // `profiles`, so the launch destination is unchanged — see
  // shell/workspace/contexts.js for why that contract matters.
  const currentView = $derived(ws.currentView());
  let profileLandingRequest = 0;
  let profileLandingTimer = null;
  // Explicit source selection for the follow-on Research capture workflow. This
  // is not a global "first active page" fallback: it is set only when a user
  // chooses a saved source, and Main revalidates page/profile ownership on use.
  let researchCapturePageId = $state(null);
  let researchCaptureProfileId = $state(null);

  // Rails have three modes. `wide` is the labelled list (what the E2E suite
  // drives and the most explicit), `slim` is the Space Bunny numeric readout,
  // `collapsed` is icon-only for very narrow windows. Ctrl+B cycles wide<->slim;
  // the auto-collapse below 900px is a separate, width-driven concern so it
  // never fights the user's explicit choice.
  let railMode = $state("wide");
  let railCollapsed = $state(false);

  function cycleRail() {
    if (railMode === "wide") railMode = "slim";
    else if (railMode === "slim") railMode = "wide";
    else railCollapsed = !railCollapsed;
  }

  // ---- Workspace: contexts → panes → tabs ----
  const wsContexts = $derived(ws.workspace.contexts);
  const activeCtx = $derived(ws.activeContext());
  const immersed = $derived(ws.isImmerse());

  /** Live pane/tab count for a context chip. */
  function contextCounts(ctx) {
    return ws.contextSummary(ctx);
  }

  /** A new context starts empty; naming it after its position is honest. */
  function createContext() {
    ws.createContext(`Scratch ${wsContexts.length + 1}`);
  }

  // Every actual navigation opens (or focuses) a tab in a pane. `navigate` is the
  // single entry point used by the rail, the palette, deep links and the Ctrl+n
  // jumps, so the panes can never drift out of sync with the rail's active state.
  function navigateWithTab(view) {
    navigate(view);
  }

  let newTabMenuOpen = $state(false);
  let pendingAgentId = $state(null);
  let pendingProjectId = $state(null);

  // Header copy and the subject identity both derive from the focused pane.
  const viewMeta = $derived(viewFor(currentView));
  // THE subject contract (`workspace/model.js` → `subjectOf`). One answer to
  // "what is on screen", so the Margin, the context header and (later) the
  // browser surface read it instead of each re-deriving it. Surfaced here as a
  // machine-readable attribute for probes and for the waves that consume it.
  const subject = $derived(ws.currentSubject());

  // ---- Per-pane view dependencies ----
  // One object, passed to every pane. `$derived` so a pane re-renders when the
  // profile or a pending deep-link changes, exactly as the single-view chain did.

  const viewDeps = $derived({
    occluded,
    profileId: profileStore.activeProfileId,
    profiles: profileStore.profiles,
    activeProfile: profileStore.activeProfile,
    onSelectProfile: selectProfile,
    onOpenSubject: openSubject,
    onNavigate: navigate,
    onStartFocus: startFocus,
    onOpenNote: openNote,
    pendingAgentId,
    pendingProjectId,
    onBackupRestored: handleBackupRestored,
    onOpenResearchSource: openResearchSource,
    researchPageId: researchCaptureProfileId === profileStore.activeProfileId ? researchCapturePageId : null,
  });

  // Initialize profiles, restore workspace, and reconcile browser pages sequentially after mount.
  onMount(() => {
    const unsubscribeBrowser = subscribeBrowser();
    void (async () => {
      try {
        await loadProfiles();
        if (profileStore.activeProfileId != null) {
          ws.setWorkspaceProfileId(profileStore.activeProfileId);
          ws.restoreWorkspace(profileStore.activeProfileId);
        }
      } catch (err) {
        console.error("Failed to load profiles / restore workspace during startup:", err);
      }

      // Browser views are owned by main, but workspace tabs are intentionally
      // memory-only. After a renderer reload, re-sync first and destroy any native
      // pages that no surviving workspace tab owns; otherwise they remain attached
      // but unreachable and consume the bounded live-page budget indefinitely.
      // NOTE: This MUST run strictly after workspace restoration, so valid
      // restored page tabs are not mistakenly considered unowned and closed.
      try {
        const state = await refreshBrowser();
        if (!state?.ok) return;
        const ownedPageIds = new Set();
        for (const context of ws.workspace.contexts ?? []) {
          for (const pane of Object.values(context.panes ?? {})) {
            for (const tab of pane.tabs ?? []) {
              if (tab.view === "page" && typeof tab.entity === "string") ownedPageIds.add(tab.entity);
            }
          }
        }
        for (const page of state.pages ?? []) {
          if (!ownedPageIds.has(page.id)) await closeBrowserPage(page.id);
        }
      } catch (err) {
        console.error("Failed to reconcile browser pages during startup:", err);
      }
    })();
    return () => unsubscribeBrowser();
  });

  // Mirror the agent event stream into the shell-wide operator store.
  $effect(() => startOperator());

  function selectProfile(id) {
    if (id !== profileStore.activeProfileId) {
      researchCapturePageId = null;
      researchCaptureProfileId = null;
    }
    selectProfileInStore(id);
    ws.setWorkspaceProfileId(id);
    const restored = id != null ? ws.restoreWorkspace(id) : false;
    const landingRequest = ++profileLandingRequest;
    if (profileLandingTimer !== null) clearTimeout(profileLandingTimer);
    profileLandingTimer = null;
    if (id != null) {
      profileLandingTimer = setTimeout(() => {
        profileLandingTimer = null;
        // The delayed default landing is only for a user who remains on the
        // profile chooser without a restored destination.
        if (landingRequest === profileLandingRequest &&
            profileStore.activeProfileId === id &&
            ws.currentView() === "profiles") {
          navigate("tree");
        }
      }, 500);
    }
  }

  // Test/capture hook: lets an automated probe switch profiles through the
  // application's own action, rather than trying to click a card that a
  // profile created via raw IPC is not yet rendered into.
  //
  // Gated on the preload bridge's own existing E2E marker
  // (`runtime.isE2E`, shell/src/preload.cjs:7), which is driven by the
  // --progressledger-v2-e2e argv flag rather than an env var -- so a probe must pass
  // that flag, and an ordinary packaged run leaves this inert. It adds no
  // capability: it is the same `selectProfile` the profile card dispatches.
  $effect(() => {
    if (window?.progressLedger?.runtime?.isE2E === true) {
      window.__cfSelectProfile = (id) => selectProfile(id);
    }
  });

  async function handleBackupRestored(profile) {
    await loadProfiles();
    profileStore.activeProfileId = profile.profileId;
  }

  // A subject is a REAL record (`academic.tree` gives each one an id), so it is
  // the tab that carries it: `subjectOf` can then answer with an entity, the
  // identity survives a tab switch, and the pane that renders the tab is the
  // only one that sees it. There is no shell-wide "last opened subject" left to
  // collide in when two panes both show Subjects.
  function openSubject(subjectId) {
    if (subjectId == null) return;
    navigate("tree", subjectId);
  }

  const ALLOWED_VIEWS = new Set([
    "home",
    "cgpa",
    "tree",
    "labs",
    "projects",
    "flashcards",
    "mistakes",
    "formulas",
    "research-ledger",
    "deadlines",
    "sessions",
    "profiles",
    "project",
    "goals",
    "career",
    "settings",
  ]);

  // THE single routing entry point. Every view switch in the app -- rail click,
  // command palette, Ctrl+1..9, deep link, deep-link event, in-view button --
  // goes through here, which is what keeps the pane tabs from drifting out of
  // sync with what is actually showing. Assigning a view directly is now a bug;
  // `navigate` is the only writer.
  function navigate(view, entity = null) {
    if (typeof view !== "string" || !ALLOWED_VIEWS.has(view)) return;
    if (profileLandingTimer !== null) {
      clearTimeout(profileLandingTimer);
      profileLandingTimer = null;
      profileLandingRequest += 1;
    }
    ws.navigate(view, viewFor(view)?.label ?? view, entity ?? null);
  }

  function goHome() {
    navigate("home");
  }

  /**
   * Open a Progress Ledger browser page tab in a specific pane (D2-D6 plan, Phase 1).
   * A page is not a rail destination, so it is created here, in the pane the user
   * asked for; the identity travels on the TAB once a real page exists. Each
   * press gives the pane ANOTHER page slot (`ws.openPageTab`), never a re-focus
   * of the page already there — one pane must be able to hold two pages.
   */
  function openNewPage(paneId) {
    ws.openPageTab(paneId, "Web page");
  }

  function researchCanonicalUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (/token|auth|key|code|password|session|secret/i.test(key)) url.searchParams.delete(key);
      return url.toString();
    } catch { return ""; }
  }

  async function openResearchSource(url) {
    const target = researchCanonicalUrl(url);
    if (!target || profileStore.activeProfileId == null) return;
    // Route to the context that owns browser pages before resolving pane/tab
    // identity. The caller may be a ResearchLedger in another context or margin
    // pane, so its surrounding view must not compete with this destination.
    const pageContext = ws.workspace.contexts.find((context) => context.seed === "Operator");
    if (!pageContext) return;
    ws.switchContext(pageContext.id);
    // The renderer mirror is disposable and can lag Main's registry when a page
    // changes URL or a source is reopened from a different workspace context.
    // Refresh before deciding that no existing page can be reused.
    await refreshBrowser();
    for (const context of ws.workspace.contexts) {
      for (const pane of Object.values(context.panes ?? {})) {
        const existing = pane.tabs.find((tab) =>
          tab.view === "page" &&
          tab.entity != null &&
          researchCanonicalUrl(browserStore.pages[tab.entity]?.url ?? "") === target,
        );
        if (existing) {
          researchCapturePageId = existing.entity;
          researchCaptureProfileId = Number(profileStore.activeProfileId);
          ws.switchContext(context.id);
          ws.focusPane(pane.id);
          ws.activateTab(pane.id, existing.id);
          return;
        }
      }
    }
    // Capture the destination before awaiting Main; native focus can still
    // change the active context while the create-page IPC is pending.
    const paneId = pageContext.focusedPaneId ?? Object.keys(pageContext.panes ?? {})[0];
    if (!paneId || !pageContext.panes?.[paneId]) return;
    const opened = await createBrowserPage({ profileId: Number(profileStore.activeProfileId), url: target });
    if (!opened?.ok || !opened.page?.id) {
      toast.error("Could not reopen this source", "Research");
      return;
    }
    if (!ws.workspace.contexts.some((context) => context.id === pageContext.id && context.panes?.[paneId])) {
      toast.error("The browser workspace changed before the source could be opened", "Research");
      return;
    }
    ws.switchContext(pageContext.id);
    ws.focusPane(paneId);
    ws.openPageTab(paneId, opened.page.title || "Web page", opened.page.id);
    researchCapturePageId = opened.page.id;
    researchCaptureProfileId = Number(profileStore.activeProfileId);
  }

  /** Look a tab up across the workspace — used to release its page on close. */
  function findTab(paneId, tabId) {
    for (const ctx of ws.workspace.contexts) {
      const tab = ctx.panes?.[paneId]?.tabs?.find((t) => t.id === tabId);
      if (tab) return tab;
    }
    return null;
  }

  /**
   * The state dot each pane tab shows, keyed by the tab's `entity` (Phase 2).
   * Only a live browser page has a state to report, and main is the authority
   * for it: the mirror carries `loading`/`failed`/`crashed`. A page with none
   * of those (a loaded page) shows no dot — a dot that is always on says
   * nothing.
   */
  const pageDots = $derived.by(() => {
    const out = {};
    for (const [pageId, page] of Object.entries(browserStore.pages ?? {})) {
      if (!page) continue;
      const dot =
        page.crashed || page.state === "crashed"
          ? "crashed"
          : page.state === "failed"
            ? "failed"
            : page.loading
              ? "loading"
              : null;
      if (dot) out[pageId] = dot;
    }
    return out;
  });

  /** The label of the first workspace tab carrying browser page `pageId`. */
  function pageTabLabel(pageId) {
    for (const ctx of ws.workspace.contexts) {
      for (const pane of Object.values(ctx.panes)) {
        const tab = pane.tabs.find(
          (t) => t.view === "page" && t.entity != null && String(t.entity) === String(pageId),
        );
        if (tab) return tab.label;
      }
    }
    return null;
  }

  /**
   * Closing a page tab releases its browser page. The native view belongs to the
   * main process, so nothing in the DOM would otherwise free it: an orphaned
   * page would keep a renderer process alive with no way back to it.
   */
  function closeWorkspaceTab(paneId, tabId) {
    const tab = findTab(paneId, tabId);
    if (tab?.view === "page" && tab.entity) void closeBrowserPage(tab.entity);
    ws.closeTab(paneId, tabId);
  }

  // ---- Notes & quick capture ----
  let noteEditor = $state({ open: false, resourceId: null, subjectId: null, defaultTitle: "" });
  let quickNoteOpen = $state(false);
  let quickNoteTree = $state([]);

  // ---- Focus session (global overlay) ----
  let focusOpen = $state(false);
  let focusSubjectId = $state(null);
  let focusTree = $state([]);

  async function loadQuickNoteTree() {
    if (profileStore.activeProfileId == null) {
      quickNoteTree = [];
      return;
    }
    try {
      quickNoteTree = await window.progressLedger.academic.tree(profileStore.activeProfileId);
    } catch (e) {
      console.error("loadQuickNoteTree failed:", e);
      quickNoteTree = [];
    }
  }

  async function startFocus(subjectId = null) {
    if (focusOpen) return;
    if (profileStore.activeProfileId == null) return;
    try {
      focusTree = await window.progressLedger.academic.tree(profileStore.activeProfileId);
    } catch (e) {
      reportError(e, "Could not load subjects for focus");
      return;
    }
    focusSubjectId = subjectId;
    focusOpen = true;
  }

  function closeFocus() {
    focusOpen = false;
    focusSubjectId = null;
    focusTree = [];
  }

  // ---- Overlay occlusion of the native browser views ----
  // A WebContentsView is painted by the OS above ALL renderer DOM, so an
  // overlay cannot simply cover a page: the shell must hide it instead (DESIGN
  // 2.3.4). Every layer that can own the screen joins the one flag — Phase 1
  // wired the operator console; Phase 2 closes the gap for the rest (the
  // command palette, the keyboard reference, onboarding, the Arrange menu and
  // the window modals), so a wayward overlay is a missing line HERE, never a
  // forgotten wire inside a component.
  let commandPaletteOpen = $state(false);
  let keyboardHelpOpen = $state(false);
  let arrangeMenuOpen = $state(false);
  const occluded = $derived(
    operator.consoleOpen === true ||
      newTabMenuOpen === true ||
      keyboardHelpOpen === true ||
      onboarding.active === true ||
      commandPaletteOpen === true ||
      arrangeMenuOpen === true ||
      noteEditor.open === true ||
      quickNoteOpen === true ||
      focusOpen === true,
  );

  // Tell main once per change, not once per pane: the flag is global.
  $effect(() => {
    void setBrowserOccluded(occluded);
  });

  // Page tabs carry their page on the tab (`page`, entity = bp-N). When main
  // reports a page's real <title>, every workspace tab holding it adopts the
  // title as its label — two "Web page" tabs become tellable apart.
  $effect(() => {
    for (const page of Object.values(browserStore.pages)) {
      const title = (page?.title ?? "").trim();
      if (!title) continue;
      if (pageTabLabel(page.id) !== title) ws.renamePageTab(page.id, title);
    }
  });

  // The other half of focus-from-native (host.js reports `kind:"focus"`): a
  // click inside a native page cannot reach this DOM, so main tells the shell,
  // which then focuses the pane holding that page. `focusTick` exists so
  // repeated focus on the SAME page still re-runs this effect.
  //
  // Two invariants keep this read+write effect from looping (the failure mode
  // was `effect_update_depth_exceeded`, which aborts the whole effect graph and
  // took the page-tab titles and the pane UI down with it):
  //
  //   1. the read is UNTRACKED. `focusPaneOfPage` reads the workspace to find
  //      the pane and writes it to focus it; tracking that read would make this
  //      effect depend on a value it commands. `untrack` makes the independence
  //      structural rather than incidental.
  //   2. a redundant focus WRITES NOTHING. `focusPaneOfPage` returns early when
  //      that context is already active and that pane already focused, and
  //      `focusPane` returns the same context when the focus changes nothing —
  //      so main re-reporting focus on every click cannot churn context
  //      identity, tracked or not.
  $effect(() => {
    if (!browserStore.focusTick) return;
    const pageId = browserStore.lastFocusedPage;
    if (pageId) untrack(() => ws.focusPaneOfPage(pageId));
  });

  // A popup main approved (R3, approved decision D3-3) arrives as a page MAIN
  // created, not one this shell asked for. Main has already spent the budget,
  // already refused the OS window, and already re-validated the URL against the
  // R2 allowlist; all this does is give the new page a workspace tab.
  //
  // The tab is UNFOCUSED on purpose: `activate: false` leaves the pane's active
  // tab and the context's focused pane exactly as they were, so a page cannot
  // steal the pane the user is reading. The read is UNTRACKED for the same
  // reason the focus effect below is — `openPageTab` writes workspace state, and
  // an effect that tracks what it writes never converges (the failure mode was
  // `effect_update_depth_exceeded`, ledger D15).
  //
  // `popupTick` exists so two popups in a row both get a tab; the id is re-read
  // inside the untrack so the consumer never depends on the value it commands.
  $effect(() => {
    if (!browserStore.popupTick) return;
    const pageId = browserStore.lastPopupPage;
    if (typeof pageId !== "string" || !pageId) return;
    untrack(() => {
      // If the page already has a tab — the popup target was a page this shell
      // is already showing — do not add a second one. That is the `(view,
      // entity)` identity contract, not a duplicate guard.
      if (pageTabLabel(pageId) !== null) return;
      const paneId = ws.focusedPaneId();
      if (!paneId) return;
      ws.openPageTab(paneId, "Web page", pageId, { activate: false });
    });
  });

  function openNote(resourceId, subjectId, defaultTitle = "") {
    noteEditor = { open: true, resourceId, subjectId, defaultTitle };
  }

  async function openSearchHit(hit) {
    if (hit.kind === "note") {
      openNote(hit.id, hit.subjectId);
    } else {
      try {
        await window.progressLedger.resources.openFile({
          profileId: profileStore.activeProfileId,
          resourceId: hit.id,
        });
      } catch (e) {
        reportError(e, "Could not open file");
      }
    }
  }

  // ---- Global events ----

  // Alt+N quick note, owned by the Electron main process.
  $effect(() => {
    const off = window.progressLedger?.notes?.onQuickNoteShortcut?.(() => {
      loadQuickNoteTree();
      quickNoteOpen = true;
    });
    return () => off?.();
  });

  // cf:navigate — any component can request a view switch.
  $effect(() => {
    const onNavigate = (e) => {
      navigate(e?.detail?.view, e?.detail?.entity ?? null);
    };
    window.addEventListener("cf:navigate", onNavigate);
    return () => window.removeEventListener("cf:navigate", onNavigate);
  });

  // cf:open-page — any component can request opening a URL in Progress Ledger's embedded browser.
  $effect(() => {
    const onOpenPage = (e) => {
      const url = e?.detail?.url;
      if (url) void openResearchSource(url);
    };
    window.addEventListener("cf:open-page", onOpenPage);
    return () => window.removeEventListener("cf:open-page", onOpenPage);
  });

  // cf:open-project — Career Plan deep link into a project.
  $effect(() => {
    const onOpenProject = (e) => {
      const projectId = e && e.detail && e.detail.projectId;
      if (typeof projectId === "number") {
        pendingProjectId = projectId;
        navigate("project");
      }
    };
    window.addEventListener("cf:open-project", onOpenProject);
    return () => window.removeEventListener("cf:open-project", onOpenProject);
  });

  // cf:open-agent — Goals deep link into a run.
  $effect(() => {
    const onOpenAgent = (e) => {
      const agentId = e && e.detail && e.detail.agentId;
      if (typeof agentId === "number") {
        pendingAgentId = agentId;
        navigate("project");
      }
    };
    window.addEventListener("cf:open-agent", onOpenAgent);
    return () => window.removeEventListener("cf:open-agent", onOpenAgent);
  });

  // ---- Debug & lifecycle logger ----
  $effect(() => initDebugLogger());

  $effect(() => {
    logViewLifecycle("mount", currentView);
    return () => logViewLifecycle("unmount", currentView);
  });

  // ---- Global keyboard ----
  // Ctrl+K is owned by the command palette itself (it listens on window); the
  // command bar simply re-emits the same synthetic event so the palette stays
  // the single owner of its own open state.
  function openCommandPalette() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  }

  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable === true;
  }

  $effect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key;

      // Ctrl+Shift+A — operator console, reachable from anywhere.
      if (e.shiftKey && key.toLowerCase() === "a") {
        e.preventDefault();
        operator.consoleOpen = !operator.consoleOpen;
        return;
      }

      // Ctrl+Shift+E — immerse: hide the workspace chrome so the work fills the
      // window. Escape (below) is the way back, and the exit affordance is
      // always on screen while immersed, so this is never a one-way door.
      if (e.shiftKey && key.toLowerCase() === "e") {
        e.preventDefault();
        ws.toggleImmerse();
        return;
      }

      // Ctrl+Shift+T — reopen the most recently closed tab.
      if (e.shiftKey && key.toLowerCase() === "t") {
        e.preventDefault();
        ws.reopenClosed();
        return;
      }

      if (e.shiftKey) return;

      // Ctrl+\ — split the focused pane side by side (Ctrl+Alt+\ stacks it).
      if (key === "\\") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        ws.splitFocused("row");
        return;
      }

      // Ctrl+B — cycle the rail: wide labels -> numeric readout -> icon-only.
      if (key.toLowerCase() === "b") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        cycleRail();
        return;
      }

      // Ctrl+1..9 — positional jump through the rail.
      //
      // Route through `navigateWithTab()` rather than assigning a view
      // directly. The rail disables profile-gated destinations (browser,
      // project, goals, career) and a positional jump must not be a way around
      // that: `Ctrl+8` used to land on Goals with no profile, where it waits on
      // a profile that can never arrive.
      if (/^[1-9]$/.test(key)) {
        const dest = orderedViews()[Number(key) - 1];
        if (!dest) return;
        e.preventDefault();
        if (isProfileGated(dest.id, profileReady)) return;
        navigateWithTab(dest.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Ctrl+Alt+←/→ switch context; Ctrl+Alt+↑/↓ move focus between panes;
  // Ctrl+Alt+\ stacks the focused pane. Kept separate from the handler above
  // because that one deliberately bails on any Alt chord (Alt+N belongs to the
  // main process).
  $effect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          ws.cycleContext(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          ws.cycleContext(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          ws.focusDirection("up");
          break;
        case "ArrowDown":
          e.preventDefault();
          ws.focusDirection("down");
          break;
        case "\\":
          e.preventDefault();
          ws.splitFocused("col");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Escape leaves immerse. It runs on the bubble phase on purpose: the keyboard
  // reference (when open) handles Escape in a capture listener and stops
  // propagation, so the topmost layer still closes first.
  $effect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (!immersed) return;
      if (isTypingTarget(e.target)) return;
      ws.setImmerse(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // `?` opens the keyboard reference, unless the user is typing.
  $effect(() => {
    const onKey = (e) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      keyboardHelpOpen = true;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Operator console → Runs console hand-off ----
  function openRunInConsole(run) {
    if (run && Number.isInteger(run.agentId)) {
      pendingAgentId = run.agentId;
      if (Number.isInteger(run.projectId)) pendingProjectId = run.projectId;
      navigate("project");
    }
  }

  const profileReady = $derived(!!profileStore.activeProfile);
</script>

<div class="os-shell" class:immersed>
  {#if !immersed}
    <TitleBar
      profiles={profileStore.profiles}
      activeProfile={profileStore.activeProfile}
      onSelectProfile={selectProfile}
      onOpenProfiles={() => navigateWithTab("profiles")}
      {railCollapsed}
      onToggleRail={cycleRail}
      onOpenPalette={openCommandPalette}
      onOpenConsole={() => (operator.consoleOpen = !operator.consoleOpen)}
      onShowTutorial={() => (onboarding.active = true)}
    />
  {/if}

  <div class="workspace-area">
    {#if !immersed}
      <NavRail
        {currentView}
        {profileReady}
        slim={railMode === "slim"}
        collapsed={railCollapsed}
        onNavigate={navigateWithTab}
        operatorWaiting={operator.approvals.length > 0}
        badges={{ project: operator.approvals.length || undefined }}
      >
        <!-- The obligation readout rides at the top of the rail. It is a snippet
             so the rail stays the only owner of destination buttons. -->
        {#snippet signals({ slim, collapsed: railIsCollapsed })}
          <Spine
            profileId={profileStore.activeProfileId}
            {slim}
            collapsed={railIsCollapsed}
            onOpen={navigateWithTab}
          />
        {/snippet}
      </NavRail>
    {/if}

    <div class="stage">
      {#if !immersed}
        <ContextStrip
          contexts={wsContexts}
          activeId={ws.workspace.activeContextId}
          counts={contextCounts}
          {immersed}
          onSelect={ws.switchContext}
          onCreate={createContext}
          onDissolve={ws.dissolveContext}
          onArrange={ws.arrange}
          onArrangeOpenChange={(open) => (arrangeMenuOpen = open)}
          onSplit={(dir) => ws.splitFocused(dir)}
          onToggleImmerse={ws.toggleImmerse}
        />

        <ContextHeader
          title={viewMeta?.title ?? ""}
          subtitle={viewMeta?.subtitle ?? ""}
          icon={viewMeta?.icon ?? null}
        >
          {#snippet actions()}
            {#if currentView !== "home" && profileReady}
              <button type="button" class="cf-btn ghost sm" onclick={goHome} title="Back to the Desk">
                Desk
              </button>
            {/if}
          {/snippet}
        </ContextHeader>
      {/if}

      <div class="work-surface">
        <main class="active-view" data-subject={subject?.key}>
          <Toaster />
          <Onboarding onComplete={handleOnboardingComplete} />
          <CommandPalette
            profileId={profileStore.activeProfileId}
            onOpen={openSearchHit}
            onOpenChange={(open) => (commandPaletteOpen = open)}
          />

          {#if activeCtx}
            <PaneGrid
              ctx={activeCtx}
              {viewDeps}
              onSetTabEntity={ws.setTabEntity}
              onFocusPane={ws.focusPane}
              onActivateTab={ws.activateTab}
              onTrailStep={ws.trailStep}
              onCloseTab={closeWorkspaceTab}
              onSplit={(dir) => ws.splitFocused(dir)}
              onClosePane={ws.closePane}
              onSetSizes={ws.setPaneSizes}
              onSetMode={ws.setPaneMode}
              onNewPage={openNewPage}
              onNewTabMenuOpenChange={(open) => (newTabMenuOpen = open)}
              onMoveTab={ws.moveTab}
              tabDots={pageDots}
            />
          {/if}
        </main>

      </div>

      <OperatorConsole
        bind:open={operator.consoleOpen}
        bind:tab={operator.consoleTab}
        onOpenRuns={openRunInConsole}
      />
    </div>
  </div>

  <StatusBar
    activeProfile={profileStore.activeProfile}
    {coreStatus}
    {online}
    onOpenConsole={() => (operator.consoleOpen = !operator.consoleOpen)}
  />

  {#if immersed}
    <!-- The way out of immerse is always on screen: a keyboard-only escape
         hatch is a trap for anyone who does not know the chord. -->
    <button
      type="button"
      class="immerse-exit cf-btn ghost sm"
      onclick={() => ws.setImmerse(false)}
      title="Show the workspace chrome (Esc)"
    >
      Exit immerse
    </button>
  {/if}

  <NoteEditor
    open={noteEditor.open}
    profileId={profileStore.activeProfileId}
    resourceId={noteEditor.resourceId}
    subjectId={noteEditor.subjectId}
    defaultTitle={noteEditor.defaultTitle}
    onClose={() =>
      (noteEditor = { open: false, resourceId: null, subjectId: null, defaultTitle: "" })}
  />

  <QuickNote
    open={quickNoteOpen}
    profileId={profileStore.activeProfileId}
    academicTree={quickNoteTree}
    onClose={() => (quickNoteOpen = false)}
  />

  <FocusSession
    open={focusOpen}
    profileId={profileStore.activeProfileId}
    academicTree={focusTree}
    initialSubjectId={focusSubjectId}
    onClose={closeFocus}
  />

  <KeyboardHelp open={keyboardHelpOpen} onClose={() => (keyboardHelpOpen = false)} />
</div>

<style>
  .os-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--atlas-base);
    color: var(--atlas-ink);
    overflow: hidden;
  }

  .workspace-area {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* The stage is everything right of the rail: context strip, context header,
     work surface, and the operator console. The console is scoped to the stage
     so it never spans under the navigation. */
  .stage {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .work-surface {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  /* A flex column, not a scrolling box: the pane grid below it owns its own
     per-pane scrolling, and two nested scroll containers make the work surface
     scroll twice. `main` stays in the DOM because it is the shell's landmark
     and the contract the shell tests assert. */
  .active-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--atlas-base);
    position: relative;
  }

  /* ---- Immerse ----
     Anchored above the status bar rather than at the top edge: the top-right of
     the window belongs to the focused pane's own controls, and an exit hatch
     that sits on top of the thing it is revealing is a worse affordance than a
     slightly less obvious one. */
  .immerse-exit {
    position: fixed;
    bottom: calc(var(--shell-status-h) + 10px);
    right: 14px;
    z-index: var(--z-overlay);
    background: var(--atlas-overlay);
    border: 1px solid var(--atlas-line);
    opacity: 0.8;
  }

  .immerse-exit:hover {
    opacity: 1;
  }

</style>
