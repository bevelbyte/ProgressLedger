<script>
  // Quick Actions: a fast-access surface for the active CareerFlow profile.
  //
  // Two layers:
  //   1. A small action toolbar (5 high-level commands) — every action calls
  //      only safe, high-level IPC. The renderer never picks a CDP endpoint,
  //      PID, port, or token. The renderer never has a filesystem path.
  //   2. The pinned-shortcuts list (existing behaviour preserved).
  //
  // The toolbar actions are: Open Browser Manager, Add Browser Profile,
  // Launch selected Browser Profile, Open selected Browser Shortcut,
  // Refresh Browser Status. "Selected" means first in the canonical order
  // (the BM sorts by position, pinned shortcuts sort by created_at then id).

  import { X } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { profileStore } from "../../profiles/stores/profile.svelte.js";

  let pinned = $state([]); // BrowserShortcutRecord[]
  let profiles = $state([]); // BrowserProfileRecord[] (for "Launch selected")
  let loading = $state(false);
  let busyAction = $state(null); // 'launch' | 'openShortcut' | 'refresh' | ...
  let busyShortcutId = $state(null);

  const cfId = $derived(
    profileStore.activeProfile ? Number(profileStore.activeProfile.id) : null
  );

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  // Reason map reused across both the toolbar and the pinned list so the
  // error copy is consistent.
  const REASONS = {
    "backend-unavailable": "Donut is unavailable. Opened in your system browser instead.",
    busy: "Donut is finishing another action. Try again in a moment.",
    "unknown-cf-profile": "The owning profile no longer exists.",
    "not-owned": "This shortcut belongs to a different CareerFlow profile.",
    disabled: "This browser profile is disabled.",
    "open-failed": "Couldn't open the link.",
    "unknown-browser-profile": "The browser profile no longer exists.",
    "binding-unavailable": "Donut did not accept the profile request.",
    "run-failed": "Donut refused to launch this profile.",
    "anti-burst-budget-exceeded":
      "Donut could not create the isolated profile right now (creation guard). Try again later.",
  };
  const explain = (res) =>
    res && res.ok === false && REASONS[res.reason]
      ? REASONS[res.reason]
      : "Operation failed.";

  async function load() {
    if (cfId == null) {
      pinned = [];
      profiles = [];
      return;
    }
    loading = true;
    try {
      const [p, bps] = await Promise.all([
        window.careerflow.browserManager.listPinned(cfId),
        window.careerflow.browserManager.list(cfId),
      ]);
      pinned = p;
      profiles = bps;
    } catch (e) {
      reportError(e, "Couldn't load quick actions");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void cfId;
    load();
  });

  // Subscribe to data-changed so the BM's pin/unpin/add/remove updates
  // this panel without a profile switch.
  $effect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener('cf:data-changed', onChanged);
    return () => window.removeEventListener('cf:data-changed', onChanged);
  });

  // -------------------------------------------------------------- toolbar

  function openBrowserManager() {
    window.dispatchEvent(new CustomEvent('cf:navigate', { detail: { view: 'browser' } }));
  }

  function addBrowserProfile() {
    // Navigate to the browser view and tell the panel to open the add form.
    window.dispatchEvent(new CustomEvent('cf:navigate', { detail: { view: 'browser' } }));
    // The BM panel listens for cf:bm-add-request and shows the new-name
    // form. We give the navigate event a tick to take effect.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cf:bm-add-request'));
    }, 0);
  }

  async function launchSelectedProfile() {
    if (busyAction) return;
    // "Selected" = first enabled profile in the canonical order. The BM
    // keeps the order, and disabled rows cannot launch.
    const target = profiles.find((p) => p && p.enabled) || null;
    if (!target) {
      toast.info("No enabled browser profiles. Add one in Browser Manager.");
      return;
    }
    busyAction = 'launch';
    try {
      const res = await window.careerflow.browserManager.openBrowserProfile(target.localId, cfId);
      if (res && res.ok) toast.info(`Launching "${target.displayName}"…`);
      else toast.error(explain(res));
    } catch (e) {
      reportError(e, "Launch failed");
    } finally {
      busyAction = null;
    }
  }

  async function openSelectedShortcut() {
    if (busyAction || busyShortcutId !== null) return;
    if (pinned.length === 0) {
      toast.info("No pinned shortcuts. Pin one in Browser Manager.");
      return;
    }
    const target = pinned[0];
    busyAction = 'openShortcut';
    busyShortcutId = target.id;
    try {
      const res = await window.careerflow.browserManager.openShortcutUrl(target.id, cfId);
      if (!(res && res.opened)) toast.error(explain(res));
    } catch (e) {
      reportError(e, "Couldn't open the shortcut");
    } finally {
      busyAction = null;
      busyShortcutId = null;
    }
  }

  async function refreshStatus() {
    if (busyAction) return;
    busyAction = 'refresh';
    try {
      await load();
    } finally {
      busyAction = null;
    }
  }

  // -------------------------------------------------------------- pinned list

  async function openShortcut(sc) {
    if (busyShortcutId !== null) return;
    busyShortcutId = sc.id;
    try {
      const res = await window.careerflow.browserManager.openShortcutUrl(sc.id, cfId);
      if (!(res && res.opened)) toast.error(explain(res));
    } catch (e) {
      reportError(e, "Couldn't open the shortcut");
    } finally {
      busyShortcutId = null;
    }
  }

  async function unpin(sc) {
    try {
      await window.careerflow.browserManager.togglePin(cfId, sc.id, false);
      await load();
    } catch (e) {
      reportError(e, "Couldn't unpin");
    }
  }
</script>

<section class="quick-actions" aria-label="Quick actions">
  {#if cfId == null}
    <p class="sidebar-empty-state">Select a profile to use its quick actions.</p>
  {:else}
    <div class="qa-toolbar" role="toolbar" aria-label="Browser quick actions">
      <button
        type="button"
        class="qa-tool"
        title="Open Browser Manager"
        onclick={openBrowserManager}
        data-testid="qa-open-bm"
      >Browser</button>
      <button
        type="button"
        class="qa-tool"
        title="Add a new browser profile"
        onclick={addBrowserProfile}
        data-testid="qa-add-bp"
      >+ Profile</button>
      <button
        type="button"
        class="qa-tool"
        title="Launch the first enabled browser profile"
        onclick={launchSelectedProfile}
        disabled={busyAction === 'launch' || profiles.length === 0}
        data-testid="qa-launch-bp"
      >Launch</button>
      <button
        type="button"
        class="qa-tool"
        title="Open the first pinned shortcut"
        onclick={openSelectedShortcut}
        disabled={busyAction === 'openShortcut' || pinned.length === 0}
        data-testid="qa-open-shortcut"
      >Open</button>
      <button
        type="button"
        class="qa-tool"
        title="Refresh browser status"
        onclick={refreshStatus}
        disabled={busyAction === 'refresh' || loading}
        data-testid="qa-refresh"
      >Refresh</button>
    </div>

    {#if loading && pinned.length === 0}
      <p class="sidebar-empty-state">Loading…</p>
    {:else if pinned.length === 0}
      <p class="sidebar-empty-state">No pinned browser shortcuts.</p>
      <p class="sidebar-empty-hint">Pin shortcuts from Browser Manager to access them here.</p>
    {:else}
      <ul class="qa-list">
        {#each pinned as sc (sc.id)}
          <li class="qa-item" class:busy={busyShortcutId === sc.id}>
            <button
              class="qa-btn"
              type="button"
              disabled={busyShortcutId !== null}
              onclick={() => openShortcut(sc)}
              title={sc.url}
            >
              <span class="qa-label">{sc.label}</span>
              <span class="qa-domain">{domainOf(sc.url) ?? sc.url}</span>
            </button>
            <button
              class="qa-unpin"
              type="button"
              aria-label="Unpin from Quick Actions"
              title="Unpin from Quick Actions"
              onclick={() => unpin(sc)}
            ><X size={12} strokeWidth={2} aria-hidden="true" /></button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 0;
  }
  .qa-toolbar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
  .qa-tool {
    background: var(--surface, var(--atlas-panel));
    color: inherit;
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-md);
    padding: 6px 8px;
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: center;
  }
  .qa-tool:hover:not(:disabled) {
    background: var(--surface-hover, var(--atlas-hover));
    border-color: var(--accent, var(--atlas-signal));
  }
  .qa-tool:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .qa-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qa-item {
    display: flex;
    align-items: stretch;
    gap: 4px;
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .qa-item.busy {
    opacity: 0.6;
  }
  .qa-btn {
    flex: 1;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 8px 10px;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .qa-btn:hover:not(:disabled) {
    background: var(--atlas-wash);
  }
  .qa-btn:disabled {
    cursor: progress;
  }
  .qa-label {
    font-weight: 600;
    font-size: var(--text-md);
  }
  .qa-domain {
    font-size: var(--text-xs);
    opacity: 0.6;
  }
  .qa-unpin {
    background: transparent;
    border: 0;
    color: inherit;
    opacity: 0.45;
    padding: 0 8px;
    cursor: pointer;
    font-size: var(--text-xl);
    line-height: 1;
  }
  .qa-unpin:hover {
    opacity: 1;
  }
</style>
