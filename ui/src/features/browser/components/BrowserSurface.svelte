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
  import { Globe, Loader2, RotateCw, AlertTriangle, ShieldOff, Square, Bookmark, BookmarkCheck, Telescope, Plus, Trash2 } from "lucide-svelte";
  import {
    pageFor,
    openPage,
    navigate as navigatePage,
    reload as reloadPage,
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

  let {
    /** The opaque browser page id this tab carries (`bp-N`), or null. */
    pageId = null,
    profileId = null,
    /** True while the shell has an overlay open (a native view cannot be
     *  z-covered, so it must be hidden instead). */
    occluded = false,
    /** Reports a newly created page id back to the workspace, so the TAB carries
     *  the identity (the approved `(view, entity)` contract). */
    onPageChange = () => {},
  } = $props();

  const page = $derived(pageFor(pageId));
  const insecure = $derived(page?.url?.startsWith("http://") === true);

  let address = $state("");
  let host = $state(null);
  let busy = $state(false);
  let notice = $state(null);
  let lastSent = null;
  let sources = $state([]);
  let captures = $state([]);
  let passageText = $state("");
  let ledgerOpen = $state(false);
  let researchBusy = $state(false);
  let researchNotice = $state("");
  let researchNoticeKind = $state("");
  let researchLoadRequest = 0;
  const researchApi = () => (typeof window === "undefined" ? null : window.careerflow?.research ?? null);
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
  async function reopenPage() {
    notice = null;
    const res = await openPage({ profileId, url: "about:blank" });
    if (res?.ok && res.page?.id) {
      onPageChange(res.page.id);
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
          onPageChange(res.page?.id ?? null);
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
        class="browser-reload"
        data-testid="browser-reload"
        title="Reload"
        aria-label="Reload"
        onclick={() => reloadPage(pageId)}
      >
        <RotateCw size={12} aria-hidden="true" />
      </button>
      <button type="button" class="research-action" data-testid="research-save-source" aria-label="Save as a source" title={savedSource ? "Already in the Research ledger" : "Save as a source"} disabled={researchBusy || !!savedSource || !page || !/^https?:\/\//i.test(page.url)} onclick={saveCurrentSource}>
        {#if savedSource}<BookmarkCheck size={12} aria-hidden="true" />{:else}<Bookmark size={12} aria-hidden="true" />{/if}
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
          Enter an address above. The page opens here, in this pane, in CareerFlow's own browser —
          Donut is not involved and does not need to be installed.
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
        <textarea aria-label="Passage to keep" data-testid="research-passage-text" bind:value={passageText} maxlength="8000" rows="2" placeholder="Paste a passage you selected on the page…"></textarea>
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
  .ledger-copy small { font-size:10px; color:var(--atlas-ink-4); overflow-wrap:anywhere; }
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
      font-size: 10px;
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
</style>
