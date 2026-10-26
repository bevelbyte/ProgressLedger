<script>
  import { onMount } from "svelte";
  /**
   * The embedded browser's pane surface — Phase 1 of the approved D2-D6 plan.
   *
   * HOW THIS WORKS. A `WebContentsView` is a NATIVE child of the window, painted
   * above this DOM. So this component renders Chrome — the address row and the
   * states — plus a placeholder rectangle, measures that rectangle, and tells the
   * main process where to put the real page. Main clamps what it receives, so the
   * page can only ever appear where the shell said it should, and never drawn
   * over UI main did not intend.
   *
   * It renders only the ACTIVE tab of a pane (PaneView renders one view at a
   * time), which is why becoming visible and being mounted are the same event
   * here. Leaving is `setVisible(false)` — the page itself is NOT closed: a
   * browser tab must survive being backgrounded, so closing is an explicit act
   * (the tab's close button tears the page down in App.svelte).
   *
   * The page stays a workspace surface, not a nested browser tab system. The
   * compact chrome exposes the current page and honest state while the native
   * WebContentsView remains owned and positioned by main.
   */
  import { Globe, Loader2, RotateCw, AlertTriangle, ShieldOff, Square, Bookmark, BookmarkCheck, Telescope, Plus, Trash2, ChevronLeft, ChevronRight, Camera, Highlighter } from "lucide-svelte";
  import {
    browser,
    pageFor,
    openPage,
    listTabs,
    loadProfiles,
    currentProfile,
    setCurrentProfile,
    createTempProfile,
    navigate as navigatePage,
    reload as reloadPage,
    goBack as goBackPage,
    goForward as goForwardPage,
    navigation as navigationState,
    setBounds,
    setVisible,
  } from "../../../shared/stores/browser.svelte.js";

  // Phase 2 (workspace integration): closing a page tab in ONE pane releases
  // the page in main and destroys the native view, but a SECOND pane can still
  // hold a tab pointing at the same `bp-N` — and a renderer reload mirror can
  // also re-sync to a table without the page. Leaving a tab pointed at a dead
  // id would paint an empty rectangle over a live address bar, so the surface
  // says so honestly and offers re-opening instead.
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import BrowserProfileDialog from "./BrowserProfileDialog.svelte";

  let {
    /** The opaque browser page id this tab carries (`bp-N`), or null. */
    pageId = null,
    /** The browser_tabs row id this tab restores from (null = none). */
    browserTabId = null,
    profileId = null,
    /** True while the shell has an overlay open (a native view cannot be
     *  z-covered, so it must be hidden instead). */
    occluded = false,
    /** Phase 4 (V2-43): report this surface's own dialog state up to
     *  App's one occluded flag, so a fixed-position dialog is never
     *  painted over by the native view it sits on top of. */
    onBrowserOverlayChange = () => {},
    /** Reports a newly created page id back to the workspace, so the TAB carries
     *  the identity (the approved `(view, entity)` contract). */
    onPageChange = () => {},
  } = $props();

  const page = $derived(pageFor(pageId));
  // Phase 3B: the workspace's profiles (for the switcher) and the open
  // page's own profile (for the address-bar dot). They differ on
  // purpose: the switcher picks the profile NEW tabs open in; an open
  // page keeps the profile it was created in, even after a switch.
  const profiles = $derived(browser.profiles);
  const current = $derived(currentProfile());
  const pageProfile = $derived(page?.browserProfile ?? null);
  let profileMenuOpen = $state(false);
  let showNewProfile = $state(false);
  // The new-profile dialog is a fixed full-window backdrop: while it
  // is open, main must hide every native view (via App's flag), or
  // the view in this very pane paints over the dialog.
  $effect(() => {
    onBrowserOverlayChange(showNewProfile === true);
  });
  $effect(() => {
    if (profileId) loadProfiles(profileId);
  });
  const insecure = $derived(page?.url?.startsWith("http://") === true);

  let address = $state("");
  let host = $state(null);
  let busy = $state(false);
  let notice = $state(null);
  let lastSent = null;
  // The row this dead tab restores from, looked up once per dead tab.
  // The key reruns the lookup when a different dead tab is selected;
  // a live page clears the need, never the row (it cannot go stale
  // while the tab is dead, because a dead tab cannot navigate).
  let restoreKey = $state(null);
  let restoreRow = $state(null);
  let sources = $state([]);
  let captures = $state([]);
  let passageText = $state("");
  let ledgerOpen = $state(false);
  let researchBusy = $state(false);
  let researchNotice = $state("");
  let researchNoticeKind = $state("");
  let researchLoadRequest = 0;
  const researchApi = () => (typeof window === "undefined" ? null : window.progressLedger?.research ?? null);
  function normalizeResearchUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/token|auth|key|code|password|session|secret/i.test(key)) url.searchParams.delete(key);
      }
      return url.toString();
    } catch { return ""; }
  }
  const canonicalPageUrl = $derived(normalizeResearchUrl(page?.url ?? ""));
  const savedSource = $derived(sources.find((source) => source.canonicalUrl === canonicalPageUrl || source.url === canonicalPageUrl) ?? null);
  let keptCount = $state(0);

  async function loadResearch(requestedProfileId = profileId, requestedPageId = pageId, requestedUrl = canonicalPageUrl) {
    const requestId = ++researchLoadRequest;
    const api = researchApi();
    if (!api || !Number.isInteger(Number(requestedProfileId))) {
      if (requestId === researchLoadRequest) {
        keptCount = 0;
        researchNotice = "Research storage is unavailable. Retry when the database connection returns.";
        researchNoticeKind = "error";
      }
      return false;
    }
    try {
      const [nextSources, nextCaptures] = await Promise.all([
        api.listSources(Number(requestedProfileId)),
        api.listCaptures(Number(requestedProfileId)),
      ]);
      if (requestId !== researchLoadRequest) return false;
      sources = Array.isArray(nextSources) ? nextSources : [];
      captures = Array.isArray(nextCaptures) ? nextCaptures : [];
      if (requestedPageId && requestedUrl) {
        const count = await api.keptCount(Number(requestedProfileId), requestedPageId);
        if (requestId !== researchLoadRequest) return false;
        if (count?.ok === true && Number.isInteger(count.count) && count.count >= 0) {
          keptCount = count.count;
          researchNotice = "";
          researchNoticeKind = "";
        } else {
          researchNotice = "Kept-passage count is temporarily unavailable. Retry in a moment.";
          researchNoticeKind = "warning";
        }
      } else {
        keptCount = 0;
        researchNotice = "";
        researchNoticeKind = "";
      }
      return !researchNotice;
    } catch (error) {
      if (requestId !== researchLoadRequest) return false;
      if (!researchNotice) {
        researchNotice = "Research ledger could not be loaded. Retry in a moment.";
        researchNoticeKind = "error";
      }
      reportError(error, "Could not load Research ledger");
      return false;
    }
  }

  async function saveCurrentSource() {
    const api = researchApi();
    if (!api || !pageId || researchBusy) return;
    researchBusy = true;
    researchNotice = "";
    researchNoticeKind = "";
    try {
      const saved = await api.saveSource(Number(profileId), pageId);
      if (saved?.ok === false) throw new Error(saved.reason ?? "source-save-failed");
      const refreshed = await loadResearch();
      if (!refreshed) throw new Error("research-refresh-failed-after-source-save");
      toast.success("Source saved to Research", "Research");
      ledgerOpen = true;
    } catch (error) {
      ledgerOpen = true;
      researchNotice = error?.message === "research-refresh-failed-after-source-save"
        ? "Source may be saved, but Research could not be refreshed. Retry before assuming the latest state."
        : "Source was not saved. Check the page and try again.";
      researchNoticeKind = "error";
      reportError(error, "Could not save browser source");
    } finally {
      researchBusy = false;
    }
  }

  async function captureCurrentPage() {
    const api = researchApi();
    if (!api || !pageId || researchBusy) return;
    researchBusy = true;
    researchNotice = "";
    researchNoticeKind = "";
    try {
      const saved = await api.capturePage(Number(profileId), pageId);
      if (saved?.ok === false) throw new Error(saved.reason ?? "capture-page-failed");
      const refreshed = await loadResearch();
      if (!refreshed) throw new Error("research-refresh-failed-after-capture");
      toast.success("Page saved to Research", "Research");
      ledgerOpen = true;
    } catch (error) {
      ledgerOpen = true;
      researchNotice = error?.message?.includes(" ")
        ? error.message
        : "Page was not saved. Check the page and try again.";
      researchNoticeKind = "error";
      reportError(error, "Could not capture browser page");
    } finally {
      researchBusy = false;
    }
  }

  async function captureCurrentSelection() {
    const api = researchApi();
    if (!api || !pageId || researchBusy) return;
    researchBusy = true;
    researchNotice = "";
    researchNoticeKind = "";
    try {
      const saved = await api.captureSelection(Number(profileId), pageId);
      if (saved?.ok === false) throw new Error(saved.reason ?? "capture-selection-failed");
      const refreshed = await loadResearch();
      if (!refreshed) throw new Error("research-refresh-failed-after-capture");
      toast.success("Selection kept", "Research");
      ledgerOpen = true;
    } catch (error) {
      ledgerOpen = true;
      researchNotice = error?.message?.includes(" ")
        ? error.message
        : "Selection was not saved. Select text on the page and try again.";
      researchNoticeKind = "error";
      reportError(error, "Could not capture browser selection");
    } finally {
      researchBusy = false;
    }
  }

  async function keepPassage(kind = "clip") {
    const api = researchApi();
    if (!api || !pageId || !passageText.trim() || researchBusy) return;
    researchBusy = true;
    researchNotice = "";
    researchNoticeKind = "";
    try {
      const saved = await api.capture(Number(profileId), pageId, kind, passageText.trim());
      if (saved?.ok === false) throw new Error(saved.reason ?? "capture-failed");
      const refreshed = await loadResearch();
      if (!refreshed) throw new Error("research-refresh-failed-after-capture");
      passageText = "";
      toast.success(kind === "extraction" ? "Passage sent to Research ledger" : "Passage kept", "Research");
      ledgerOpen = true;
    } catch (error) {
      ledgerOpen = true;
      researchNotice = error?.message === "research-refresh-failed-after-capture"
        ? "Passage may be saved, but Research could not be refreshed. Your text is preserved; retry before assuming the latest state."
        : "Passage was not saved. Your text is preserved; retry when storage is available.";
      researchNoticeKind = "error";
      reportError(error, "Could not save Research passage");
    } finally {
      researchBusy = false;
    }
  }

  $effect(() => {
    const key = pageId && !page && browserTabId ? `${pageId}:${browserTabId}` : null;
    if (!key || key === restoreKey) return;
    restoreKey = key;
    restoreRow = null;
    void (async () => {
      try {
        const rows = await listTabs(Number(profileId));
        const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === browserTabId);
        if (row && typeof row.url === "string" && row.url) restoreRow = { url: row.url, title: row.title ?? "" };
      } catch { /* no restore row: the tab falls back to a blank re-open */ }
    })();
  });

  onMount(() => { void loadResearch(profileId, pageId, canonicalPageUrl); });

  // A pane can keep this component instance mounted while its active workspace
  // tab changes. Re-run the persisted lookup whenever this surface's own profile,
  // page identity, or canonical URL changes; reject late replies from the page we
  // just left so its count cannot overwrite the current page's count.
  $effect(() => {
    const currentProfileId = profileId;
    const currentPageId = pageId;
    const currentUrl = canonicalPageUrl;
    void loadResearch(currentProfileId, currentPageId, currentUrl);
  });

  let lastSyncedPageId = $state(null);
  let lastSyncedUrl = $state(null);

  /** Back/forward availability, refreshed whenever the page changes. */
  let canGoBack = $state(false);
  let canGoForward = $state(false);

  async function refreshNav() {
    if (!pageId) {
      canGoBack = false;
      canGoForward = false;
      return;
    }
    try {
      const res = await navigationState(pageId);
      if (res?.ok) {
        canGoBack = res.canGoBack === true;
        canGoForward = res.canGoForward === true;
      }
    } catch {
      /* a nav query that fails leaves the buttons disabled, which is safe */
    }
  }

  /** Synchronize address bar when switching tabs or when the underlying page navigates. */
  $effect(() => {
    const currentId = pageId;
    const url = page?.url ?? "";
    if (currentId !== lastSyncedPageId) {
      lastSyncedPageId = currentId;
      lastSyncedUrl = url;
      address = url;
    } else if (url && url !== lastSyncedUrl) {
      lastSyncedUrl = url;
      address = url;
    }
    void refreshNav();
  });

  /* ---- the layout declaration: measure, then tell main ---- */
  let frame = 0;
  let fallback = 0;

  function sendBounds() {
    if (!host || !pageId) return;
    const box = host.getBoundingClientRect();
    const rect = {
      x: Math.round(box.left),
      y: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    // A degenerate rectangle (the pane is mid-layout) is not worth sending; main
    // would refuse it and the next observation will carry the real one.
    if (rect.width < 2 || rect.height < 2) return;
    const signature = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (signature === lastSent) return;
    lastSent = signature;
    void setBounds(pageId, rect);
  }

  /**
   * Coalesce layout observations into one declaration.
   *
   * rAF is the right coalescer while the window is visible, but Chromium stops
   * firing it for an occluded or background window (which is exactly what the
   * off-screen E2E window is) and a stale rectangle is a VISIBLE defect, not a
   * cosmetic one: the page would sit at the size the pane had two layouts ago.
   * So a timer is armed alongside it and whichever fires first wins. The timer
   * is clamped to ~1s in a throttled renderer, which is late but correct.
   */
  function flushBounds() {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (fallback) {
      clearTimeout(fallback);
      fallback = 0;
    }
    sendBounds();
  }

  function scheduleBounds() {
    if (frame || fallback) return;
    frame = requestAnimationFrame(flushBounds);
    fallback = setTimeout(flushBounds, 32);
  }

  $effect(() => {
    if (!host || !pageId) return;
    const observer = new ResizeObserver(() => scheduleBounds());
    observer.observe(host);
    window.addEventListener("resize", scheduleBounds);
    const onScroll = () => scheduleBounds();
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      window.removeEventListener("scroll", onScroll, true);
      if (frame) cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      frame = 0;
      fallback = 0;
    };
  });

  /* Re-measure whenever the page id changes or main reports a new URL/layout
   * state: a stale rectangle is a visible defect, not a cosmetic one. */
  $effect(() => {
    pageId;
    page?.url;
    scheduleBounds();
  });

  /* ---- visibility: mounted + not occluded ---- */
  $effect(() => {
    if (!pageId) return;
    void setVisible(pageId, !occluded);
  });

  // Leaving the tab is leaving the screen. The page keeps running.
  //
  // The id is CAPTURED, not read when the cleanup runs: when a pane switches
  // from one page tab to another the component instance stays (only the prop
  // changes), and Svelte updates that prop BEFORE running the effect cleanup.
  // Reading `pageId` in the cleanup would therefore hide the page being
  // ENTERED and leave the one being LEFT on screen — two native pages painted
  // over each other in the same pane.
  $effect(() => {
    const id = pageId;
    if (!id) return;
    return () => {
      void setVisible(id, false);
    };
  });

  /* ---- actions ---- */
  /** Re-create a page for a tab whose page was destroyed (tab close elsewhere). */
  // Report a new page id to the workspace tab, plus its restore row
  // id when main returned one. A create without a row id reports exactly
  // the page id, as before.
  function reportPage(id, tabId) {
    if (typeof tabId === "number") onPageChange(id, tabId);
    else onPageChange(id);
  }

  async function reopenPage() {
    notice = null;
    const target = restoreRow?.url ?? "about:blank";
    const res = await openPage({ profileId, url: target, restoreBrowserTabId: restoreRow ? browserTabId : undefined });
    if (res?.ok && res.page?.id) {
      reportPage(res.page.id, res.browserTabId);
      lastSent = null;
      address = "";
      toast.info("Page re-opened in this tab", "Browser");
    } else {
      notice = res?.reason ?? "open-failed";
    }
  }

  async function submit(event) {
    event?.preventDefault?.();
    const target = address.trim();
    if (!target || busy) return;
    busy = true;
    notice = null;
    try {
      if (pageId) {
        const res = await navigatePage(pageId, target);
        if (!res?.ok) notice = res?.detail ?? res?.reason ?? "navigate-failed";
      } else {
        const res = await openPage({ profileId, url: target });
        if (res?.ok) {
          reportPage(res.page?.id ?? null, res.browserTabId);
          lastSent = null;
        } else {
          notice = res?.detail ?? res?.reason ?? "open-failed";
        }
      }
    } finally {
      busy = false;
    }
  }

  const stateLabel = $derived.by(() => {
    if (!page) return null;
    if (page.crashed || page.state === "crashed") return "This page crashed";
    if (page.hibernated) return "Sleeping";
    if (page.lastError?.reason === "navigation-timeout") return "Navigation timed out";
    if (page.state === "failed") return "This page could not be loaded";
    if (page.loading) return "Loading";
    return null;
  });
</script>

<div class="browser-surface" data-testid="browser-surface">
  <form class="browser-bar" role="search" aria-label="Browser address bar" onsubmit={submit}>
    <span class="browser-mark" class:insecure title={insecure ? "Not a secure connection" : "Secure"}>
      {#if page?.loading}
        <!-- The spin lives on a wrapper, not on the icon: a class handed to a
             component as a prop is invisible to Svelte's CSS analysis, which
             reported `.spin` as unused. -->
        <span class="spin" aria-hidden="true"><Loader2 size={13} /></span>
      {:else if insecure}
        <ShieldOff size={13} aria-hidden="true" />
      {:else}
        <Globe size={13} aria-hidden="true" />
      {/if}
    </span>

    {#if pageProfile}
      <span
        class="profile-dot page-profile-dot"
        style="--profile-color: {pageProfile.color ?? "#888888"}"
        title={pageProfile.displayName}
        aria-label="Profile: {pageProfile.displayName}"
      ></span>
    {/if}

    {#if page}
      <span class="browser-title truncate" data-testid="browser-title" title={page.title || page.url}>
        {page.title || page.url || "Untitled page"}
      </span>
    {/if}

    <input
      class="browser-address"
      data-testid="browser-address"
      aria-label="Address"
      placeholder="Search or enter an address"
      bind:value={address}
      spellcheck="false"
      autocomplete="off"
    />

    <button
      type="submit"
      class="browser-go"
      data-testid="browser-go"
      title={pageId ? "Go" : "Open in this pane"}
      aria-label={pageId ? "Go" : "Open in this pane"}
      aria-busy={busy ? "true" : undefined}
      disabled={busy}
    >
      {#if busy}
        <Square size={12} aria-hidden="true" />
      {:else if pageId}
        <RotateCw size={12} aria-hidden="true" />
      {/if}
      <span class="browser-go-label">{pageId ? "Go" : "Open"}</span>
    </button>

    {#if pageId}
      <button
        type="button"
        class="browser-back"
        data-testid="browser-back"
        title="Back"
        aria-label="Back"
        disabled={!canGoBack}
        onclick={async () => {
          await goBackPage(pageId);
          await refreshNav();
        }}
      >
        <ChevronLeft size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="browser-forward"
        data-testid="browser-forward"
        title="Forward"
        aria-label="Forward"
        disabled={!canGoForward}
        onclick={async () => {
          await goForwardPage(pageId);
          await refreshNav();
        }}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="browser-reload"
        data-testid="browser-reload"
        title="Reload"
        aria-label="Reload"
        onclick={() => reloadPage(pageId)}
      >
        <RotateCw size={12} aria-hidden="true" />
      </button>
      <div class="profile-switcher">
        <button
          type="button"
          class="profile-switcher-btn"
          data-testid="browser-profile-switcher"
          aria-label="Browser profile"
          aria-expanded={profileMenuOpen ? "true" : "false"}
          title={current ? `New tabs open in ${current.displayName}` : "Browser profile"}
          onclick={() => (profileMenuOpen = !profileMenuOpen)}
        >
          <span class="profile-dot" style="--profile-color: {current?.color ?? "#888888"}" aria-hidden="true"></span>
          <span class="truncate">{current?.displayName ?? "Default"}{current?.temporary ? " (Temporary)" : ""}</span>
        </button>
        {#if profileMenuOpen}
          <div class="profile-menu" data-testid="browser-profile-menu" role="menu">
            {#each profiles as profile (profile.localId)}
              <div class="profile-menu-row">
                <button
                  type="button"
                  class="profile-menu-option"
                  data-testid="browser-profile-option-{profile.localId}"
                  role="menuitem"
                  onclick={() => {
                    setCurrentProfile(profile.localId);
                    profileMenuOpen = false;
                  }}
                >
                  <span class="profile-dot" style="--profile-color: {profile.color ?? "#888888"}" aria-hidden="true"></span>
                  <span class="truncate">{profile.displayName}{profile.temporary ? " (Temporary)" : ""}{profile.isDefault ? " (Default)" : ""}</span>
                </button>
                <button
                  type="button"
                  class="profile-menu-open"
                  data-testid="browser-profile-open-{profile.localId}"
                  aria-label="Open a new tab in {profile.displayName}"
                  title="Open a new tab in this profile"
                  onclick={async () => {
                    profileMenuOpen = false;
                    const res = await openPage({ profileId, url: "about:blank", browserProfileId: profile.localId });
                    if (res?.ok) reportPage(res.page?.id ?? null, res.browserTabId);
                    else notice = res?.detail ?? res?.reason ?? "open-failed";
                  }}
                >
                  <Plus size={12} aria-hidden="true" />
                </button>
              </div>
            {/each}
            <button
              type="button"
              class="profile-menu-action"
              data-testid="browser-profile-temp"
              onclick={async () => {
                profileMenuOpen = false;
                const res = await createTempProfile(profileId, "Temporary", null);
                if (res?.ok && res.profile) setCurrentProfile(res.profile.localId);
              }}
            >
              Temporary profile
            </button>
            <button
              type="button"
              class="profile-menu-action"
              data-testid="browser-profile-new"
              onclick={() => {
                profileMenuOpen = false;
                showNewProfile = true;
              }}
            >
              New browser profile…
            </button>
            <button
              type="button"
              class="profile-menu-action"
              data-testid="browser-profile-manage"
              onclick={() => {
                profileMenuOpen = false;
                window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } }));
              }}
            >
              Manage profiles…
            </button>
            <p class="profile-menu-note">New tabs open in the current profile. Open pages keep their profile.</p>
          </div>
        {/if}
      </div>
      <button type="button" class="research-action" data-testid="research-save-source" aria-label="Save as a source" title={savedSource ? "Already in the Research ledger" : "Save as a source"} disabled={researchBusy || !!savedSource || !page || !/^https?:\/\//i.test(page.url)} onclick={saveCurrentSource}>
        {#if savedSource}<BookmarkCheck size={12} aria-hidden="true" />{:else}<Bookmark size={12} aria-hidden="true" />{/if}
      </button>
      <button type="button" class="research-action" data-testid="browser-capture-page" aria-label="Capture page" title="Capture page" disabled={researchBusy || !page || !/^https?:\/\//i.test(page.url)} onclick={captureCurrentPage}>
        <Camera size={12} aria-hidden="true" />
      </button>
      <button type="button" class="research-action" data-testid="browser-capture-selection" aria-label="Capture selection" title="Capture selection" disabled={researchBusy || !page || !/^https?:\/\//i.test(page.url)} onclick={captureCurrentSelection}>
        <Highlighter size={12} aria-hidden="true" />
      </button>
      <button type="button" class="research-action" data-testid="research-return" aria-label="Open in Research browser strip" title="Open in Research browser strip" onclick={() => setTimeout(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "research-ledger" } })), 0)}>
        <Telescope size={12} aria-hidden="true" />
      </button>
      <span class="kept-count" data-testid="research-kept-count" aria-label={`${keptCount} kept passages`}>{keptCount > 0 ? `${keptCount} kept` : ""}</span>
    {/if}

    {#if stateLabel}
      <span
        class="browser-state"
        class:failed={page?.state === "failed" || page?.state === "crashed" || page?.crashed}
        data-testid="browser-state"
        data-state={page?.state}
        role="status"
        aria-live="polite"
      >
        {stateLabel}
      </span>
    {/if}
  </form>

  {#if showNewProfile}
    <BrowserProfileDialog
      profileId={profileId}
      profile={null}
      onClose={() => (showNewProfile = false)}
      onSaved={async (created) => {
        showNewProfile = false;
        if (!created?.localId) return;
        setCurrentProfile(created.localId);
        // A profile just created is for use right away: open a fresh
        // page in it in this pane tab (the same pattern as the
        // switcher's "Open a new tab in this profile" button) and
        // report it, so the tab shows the new profile's color dot
        // at once. A failed open only shows the notice; the new
        // profile stays current, so the user can open in it manually.
        const res = await openPage({ profileId, url: "about:blank", browserProfileId: created.localId });
        if (res?.ok) reportPage(res.page?.id ?? null, res.browserTabId);
        else notice = res?.detail ?? res?.reason ?? "open-failed";
      }}
    />
  {/if}

  {#if page}
    <span class="browser-page-id" data-testid="browser-page-id" data-page-id={page.id} aria-hidden="true">
      {page.id}
    </span>
  {/if}

  {#if notice}
    <p class="browser-notice" data-testid="browser-notice" role="alert">
      <AlertTriangle size={12} aria-hidden="true" />
      <span>Refused: {notice}</span>
    </p>
  {/if}

  <!-- The page itself is NATIVE and lives at this rectangle. -->
  <div class="browser-host" bind:this={host} data-testid="browser-placeholder" role="region" aria-label="Browser web content">
    {#if !pageId}
      <div class="browser-empty">
        <p class="browser-empty-title">No page in this tab</p>
        <p class="browser-empty-help">
          Enter an address above. The page opens here, in this pane, in Progress Ledger's own browser.
        </p>
      </div>
    {:else if !page}
      <!-- The tab points at a page id main no longer serves: it was released by
           the tab that owned it (a page tab closed in another pane) or never
           re-synced after a reload. Main clamps what a tab can do; this state is
           honest about a page the shell cannot paint, with a way back. -->
      <div class="browser-empty" data-testid="browser-missing-page">
        <p class="browser-empty-title">This page is no longer open</p>
        <p class="browser-empty-help">
          The page this tab pointed at was closed. Re-open it here — the tab follows the page it
          lands on.
        </p>
        {#if restoreRow}
          <p class="browser-empty-help">Last open: {restoreRow.title ? `${restoreRow.title} — ` : ""}{restoreRow.url}</p>
        {/if}
        <button
          type="button"
          class="cf-btn ghost sm"
          data-testid="browser-reopen-page"
          onclick={reopenPage}
        >
          Re-open page
        </button>
      </div>
    {/if}
  </div>
  {#if pageId && ledgerOpen}
    <section class="research-ledger" data-testid="research-ledger" aria-label="Research ledger">
      <div class="ledger-head"><strong>Research ledger</strong><span>{sources.length} sources · {captures.length} passages</span><button type="button" class="research-action" aria-label="Refresh Research ledger" onclick={() => loadResearch()}><RotateCw size={12} /></button></div>
      <form class="passage-form" onsubmit={(event) => { event.preventDefault(); void keepPassage("clip"); }}>
        <textarea aria-label="Passage to keep" data-testid="research-passage-text" bind:value={passageText} maxlength="20000" rows="2" placeholder="Paste a passage you selected on the page…"></textarea>
        <button type="submit" class="cf-btn ghost sm" data-testid="research-keep-passage" disabled={researchBusy || !passageText.trim()}>Keep passage</button>
        <button type="button" class="cf-btn ghost sm" data-testid="research-extract-passage" disabled={researchBusy || !passageText.trim()} onclick={() => keepPassage("extraction")}>Send to operator</button>
      </form>
      {#if researchNotice}<p class="research-notice" class:warning={researchNoticeKind === "warning"} role="status">{researchNotice}</p>{/if}
      <div class="ledger-rows">
        {#each sources as source (source.id)}
          <div class="ledger-row" data-source-id={source.id}><Globe size={12} /><span class="ledger-copy"><strong>{source.title}</strong><small>{source.domain} · {source.keptCount} kept</small></span></div>
        {/each}
        {#each captures as capture (capture.id)}
          <div class="ledger-row" data-capture-id={capture.id}><Bookmark size={12} /><span class="ledger-copy"><strong>{capture.kind === "extraction" ? "Operator extraction" : "Kept passage"}</strong><small>{capture.text}</small></span></div>
        {/each}
        {#if !sources.length && !captures.length}<p class="ledger-empty">Save this page as a source or keep a passage to begin the ledger.</p>{/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .browser-surface {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--atlas-base);
  }

  .browser-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 34px;
    flex: 0 0 34px;
    padding: 0 10px;
    border-bottom: 1px solid var(--atlas-line);
    background: var(--atlas-panel);
  }

  .browser-mark {
    display: inline-flex;
    align-items: center;
    color: var(--atlas-ink-3);
  }

  .browser-mark.insecure {
    color: var(--atlas-warn, #d08b2c);
  }

  .browser-address {
    flex: 1 1 0;
    min-width: 0;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-sm);
    background: var(--atlas-base);
    color: var(--atlas-ink);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
  }

  .browser-address:focus {
    outline: none;
    border-color: var(--atlas-signal);
  }

  .browser-address:focus-visible {
    outline: 1px solid var(--atlas-signal);
    outline-offset: 1px;
  }

  .browser-go,
  .browser-reload {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-2);
  }

  .browser-go:hover,
  .browser-reload:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .browser-go:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .browser-go-label {
    font-size: var(--text-micro);
    font-family: var(--font-mono);
  }

  .browser-title {
    flex: 0 1 28%;
    min-width: 0;
    max-width: 28%;
    color: var(--atlas-ink-2);
    font-size: var(--text-micro);
  }

  .browser-notice {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 4px 10px;
    color: var(--atlas-bad);
    font-size: var(--text-micro);
    font-family: var(--font-mono);
  }

  .browser-state {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    max-width: 42%;
    padding: 1px 6px;
    border: 1px solid var(--atlas-warn-line);
    border-radius: var(--radius-xs);
    background: var(--atlas-warn-bg);
    color: var(--atlas-warn-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .browser-state.failed {
    border-color: var(--atlas-bad);
    background: transparent;
    color: var(--atlas-bad);
  }

  .browser-page-id {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .browser-host {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--atlas-base);
  }

  .research-action { display:inline-flex; align-items:center; justify-content:center; flex:0 0 22px; width:22px; height:22px; border-radius:var(--radius-sm); color:var(--atlas-ink-3); }
  .research-action:hover { background:var(--atlas-wash); color:var(--atlas-ink); }
  .research-action:disabled { opacity:.4; cursor:default; }
  .kept-count { color:var(--atlas-ink-3); font:var(--text-micro) var(--font-mono); white-space:nowrap; }
  .research-ledger { flex:0 0 auto; max-height:32%; min-height:105px; display:flex; flex-direction:column; border-top:1px solid var(--atlas-line); background:var(--atlas-panel); padding:7px 10px; gap:6px; overflow:auto; }
  .ledger-head { display:flex; align-items:center; gap:8px; font-size:var(--text-micro); color:var(--atlas-ink-2); }
  .ledger-head span { margin-left:auto; color:var(--atlas-ink-4); font-family:var(--font-mono); }
  .passage-form { display:flex; align-items:stretch; gap:5px; }
  .passage-form textarea { flex:1; min-width:0; resize:vertical; border:1px solid var(--atlas-line); border-radius:var(--radius-sm); padding:5px 7px; background:var(--atlas-base); color:var(--atlas-ink); font:var(--text-micro) var(--font-sans); }
  .passage-form .cf-btn { align-self:center; white-space:nowrap; }
  .ledger-rows { display:flex; flex-direction:column; gap:4px; overflow:auto; }
  .ledger-row { display:flex; align-items:flex-start; gap:7px; padding:4px 5px; color:var(--atlas-ink-3); border-radius:var(--radius-xs); background:var(--atlas-base); }
  .ledger-copy { display:flex; flex-direction:column; min-width:0; gap:2px; }
  .ledger-copy strong { font-size:var(--text-micro); font-weight:500; color:var(--atlas-ink-2); }
  .ledger-copy small { font-size:11px; color:var(--atlas-ink-4); overflow-wrap:anywhere; }
  .ledger-empty,.research-notice { margin:0; font-size:var(--text-micro); color:var(--atlas-ink-4); }
  .research-notice { color:var(--atlas-bad); }
  .research-notice.warning { color:var(--atlas-warn-ink); }

  .browser-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 24px;
    text-align: center;
  }

  .browser-empty-title {
    margin: 0;
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
  }

  .browser-empty-help {
    margin: 0;
    max-width: 46ch;
    color: var(--atlas-ink-4);
    font-size: var(--text-micro);
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .spin {
    display: inline-flex;
    animation: spin 900ms linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  @container pane (max-width: 560px) {
    .browser-bar {
      gap: 4px;
      padding: 0 6px;
    }

    .browser-address {
      padding: 0 6px;
      font-size: 11px;
    }

    .browser-title {
      flex-basis: 24%;
      max-width: 24%;
    }

    .browser-go,
    .browser-reload {
      padding: 0 5px;
    }

    .browser-state {
      max-width: 32%;
    }
  }

  @container pane (max-width: 360px) {
    .browser-go-label {
      display: none;
    }

    .browser-title {
      flex-basis: 20%;
      max-width: 20%;
    }

    .browser-state {
      max-width: 35%;
    }
  }
  .profile-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--profile-color, #888888);
    flex-shrink: 0;
    display: inline-block;
  }

  .page-profile-dot {
    margin-left: 2px;
  }

  .profile-switcher {
    position: relative;
    flex-shrink: 0;
  }

  .profile-switcher-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 140px;
    padding: 4px 8px;
    border: 1px solid var(--hairline, #333);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .profile-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 220px;
    max-width: 300px;
    background: var(--surface-2, #1a1a1a);
    border: 1px solid var(--hairline, #333);
    border-radius: 8px;
    padding: 4px;
    z-index: 50;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .profile-menu-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .profile-menu-option,
  .profile-menu-action {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .profile-menu-option:hover,
  .profile-menu-action:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .profile-menu-open {
    flex-shrink: 0;
    padding: 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .profile-menu-note {
    margin: 6px 8px 4px;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
