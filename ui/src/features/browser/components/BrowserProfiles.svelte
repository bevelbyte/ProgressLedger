<script>
  // Browser profiles manager (Phase 3B) — an Operator workspace view.
  // Rows: Play (primary), name + color identity, type, proxy summary,
  // last used. Secondary actions live in a profile-specific menu
  // (row ⋯ button, or right-click on the row): information, use for
  // new tabs, edit, duplicate settings (not data), clear data, delete
  // (with a confirm stating cookies and data will be deleted, plus an
  // opt-in checkbox for ledger entries captured from that profile,
  // off by default).
  //
  // Play opens a REAL embedded page in exactly the profile clicked:
  // it creates the page through the browser store with an explicit
  // browserProfileId (never the global current profile), then opens a
  // workspace tab carrying the returned page id in the pane that was
  // focused when Play was clicked. A failed create opens no tab; a
  // page created but orphaned by a vanished pane or a deleted profile
  // is closed again — only the page Play itself made, never others.
  import { onDestroy, onMount, tick } from "svelte";
  import { Play, MoreHorizontal } from "lucide-svelte";
  import {
    browser,
    loadProfiles,
    openPage,
    closePage,
    setCurrentProfile,
    duplicateBrowserProfile,
    clearBrowserProfileData,
    deleteBrowserProfile,
    setBrowserLiveCap,
    getBrowserLiveCap,
    ledgerCountForBrowserProfile,
  } from "../../../shared/stores/browser.svelte.js";
  import BrowserProfileDialog from "./BrowserProfileDialog.svelte";
  import BrowserProfileInfo from "./BrowserProfileInfo.svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import {
    workspace,
    focusedPane,
    focusedPaneId,
    focusedActiveTabId,
    openPageTab,
    setTabEntity,
    focusPane,
    switchContext,
  } from "../../../shell/workspace/store.svelte.js";

  let { profileId = null, onBrowserOverlayChange = () => {} } = $props();

  const profiles = $derived(browser.profiles);
  let dialog = $state(null); // null | { mode: "new" } | { mode: "edit", profile }
  let deleteTarget = $state(null); // { profile, ledgerCount, deleteLedger }
  let clearTarget = $state(null); // profile awaiting clear confirmation
  let infoProfile = $state(null); // profile shown read-only, or null
  let menu = $state(null); // { profile, x, y, triggerEl } or null
  let menuEl = $state(null);
  let playBusy = $state({}); // localId -> true while that row's Play is running
  let alive = true;
  onMount(() => {
    alive = true;
  });
  onDestroy(() => {
    alive = false;
  });
  // Phase 4 (V2-43): dialogs are fixed full-window backdrops, so while
  // one is open main must hide every native view (via App's flag), or
  // a view in another pane paints over it. The row menu is also fixed
  // positioned, so it occludes while open for the same reason.
  $effect(() => {
    // Single line on purpose: shell/tests/overlay-guard.test.js
    // source-matches `onBrowserOverlayChange(dialog` here.
    onBrowserOverlayChange(dialog !== null || deleteTarget !== null || clearTarget !== null || infoProfile !== null || menu !== null);
  });
  let liveCap = $state(5);
  let liveCapBusy = $state(false);
  let notice = $state("");

  $effect(() => {
    if (profileId) {
      loadProfiles(profileId);
      getBrowserLiveCap(profileId).then((res) => {
        if (res?.ok && Number.isInteger(res.cap)) liveCap = res.cap;
      });
    }
  });

  function proxySummary(profile) {
    if (!profile || !profile.proxyMode || profile.proxyMode === "none") return "No proxy";
    const host = profile.proxyHost ?? "";
    const port = profile.proxyPort ?? "";
    const label = profile.proxyMode === "socks5" ? "SOCKS5" : profile.proxyMode.toUpperCase();
    return `${label} ${host}:${port}`;
  }

  function lastUsedLabel(profile) {
    if (!profile?.lastUsedAt) return "Never";
    try {
      return new Date(profile.lastUsedAt).toLocaleString();
    } catch {
      return profile.lastUsedAt;
    }
  }

  async function playProfile(profile) {
    const localId = profile?.localId;
    if (!localId || playBusy[localId]) return;
    // Capture the destination BEFORE awaiting main (the App
    // research-reopen pattern): native focus can still change the
    // active context while the create-page IPC is pending.
    const contextId = workspace?.activeContextId ?? null;
    const paneId = focusedPaneId();
    const context = (workspace?.contexts ?? []).find((c) => c.id === contextId) ?? null;
    if (!context || !paneId || !context.panes?.[paneId]) {
      notice = "No workspace pane is available to open the page in.";
      return;
    }
    playBusy[localId] = true;
    notice = "";
    let pageId = null;
    try {
      const res = await openPage({ profileId, url: "about:blank", browserProfileId: localId });
      if (!alive) {
        // The manager went away mid-flight: tear down only the page
        // this Play made, and open nothing.
        if (res?.ok && res.page?.id) {
          try {
            await closePage(res.page.id);
          } catch {}
        }
        return;
      }
      if (!res?.ok || !res.page?.id) {
        notice = res?.detail ?? res?.reason ?? "open-failed";
        return;
      }
      pageId = res.page.id;
      // The profile may have been deleted while the page was opening.
      if (!browser.profiles.some((p) => p && p.localId === localId)) {
        try {
          await closePage(pageId);
        } catch {}
        notice = "That profile was deleted while the page was opening.";
        pageId = null;
        return;
      }
      // The captured pane may have closed while main was working.
      const live = (workspace?.contexts ?? []).find((c) => c.id === contextId);
      if (!live || !live.panes?.[paneId]) {
        try {
          await closePage(pageId);
        } catch {}
        notice = "The workspace pane closed while the page was opening.";
        pageId = null;
        return;
      }
      if (workspace.activeContextId !== contextId) switchContext(contextId);
      focusPane(paneId);
      openPageTab(paneId, res.page.title || "Web page", pageId, { activate: true });
      const tabId = focusedActiveTabId();
      const pane = focusedPane();
      const tab = pane?.tabs?.find((t) => t.id === tabId);
      // The tab was just born carrying this page id; record its
      // restore row id too (temp profiles have no row, so skip).
      if (tab && tab.entity === pageId && typeof res.browserTabId === "number") {
        setTabEntity(paneId, tabId, pageId, res.browserTabId);
      }
      // Refresh so the row's Last used reflects the touch main just
      // recorded for this profile. A refresh failure never undoes
      // the opened page.
      try {
        await loadProfiles(profileId);
      } catch {}
    } catch (e) {
      if (pageId) {
        try {
          await closePage(pageId);
        } catch {}
      }
      notice = String(e?.message ?? e).slice(0, 200);
    } finally {
      playBusy[localId] = false;
    }
  }

  // --- Row menu (cursor-anchored; Menu.svelte is click-anchored, so
  // this follows its contract instead of reusing it: role=menu /
  // menuitem, arrows + Home/End, Escape returns focus to the trigger,
  // pointerdown outside closes). Items capture the profile at open
  // time, so a current-profile change mid-menu cannot retarget them.
  function openMenu(profile, x, y, triggerEl) {
    menu = {
      profile,
      x: Math.max(8, Math.min(x, window.innerWidth - 230)),
      y: Math.max(8, Math.min(y, window.innerHeight - 300)),
      triggerEl: triggerEl ?? null,
    };
    tick().then(() => {
      menuEl?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
    });
  }

  function closeMenu(refocus = false) {
    const triggerEl = menu?.triggerEl;
    menu = null;
    if (refocus) triggerEl?.focus?.();
  }

  $effect(() => {
    if (!menu) return;
    const onDown = (e) => {
      // The trigger's own pointerdown precedes its click: let the
      // click toggle instead of closing here and reopening.
      if (menu.triggerEl?.contains?.(e.target)) return;
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu(true);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  function menuMove(from, delta) {
    const nodes = [...(menuEl?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [])];
    if (nodes.length === 0) return;
    const i = nodes.indexOf(from);
    nodes[(i + delta + nodes.length) % nodes.length]?.focus();
  }

  function menuKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuMove(e.currentTarget, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      menuMove(e.currentTarget, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      menuEl?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const nodes = menuEl?.querySelectorAll('[role="menuitem"]:not([disabled])');
      nodes?.[nodes.length - 1]?.focus();
    }
  }

  async function openDelete(profile) {
    let count = 0;
    try {
      const res = await ledgerCountForBrowserProfile(profileId, profile.localId);
      if (res?.ok && Number.isInteger(res.count)) count = res.count;
    } catch {}
    deleteTarget = { profile, ledgerCount: count, deleteLedger: false };
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { profile, deleteLedger } = deleteTarget;
    const res = await deleteBrowserProfile(profileId, profile.localId, deleteLedger);
    if (res?.ok) {
      toast.success(`Profile "${profile.displayName}" deleted${deleteLedger && res.deletedLedger ? ` (${res.deletedLedger} ledger entries also deleted)` : ""}.`);
      deleteTarget = null;
    } else {
      notice = res?.detail ?? res?.reason ?? "delete-failed";
    }
  }

  async function confirmClear() {
    if (!clearTarget) return;
    const profile = clearTarget;
    const res = await clearBrowserProfileData(profileId, profile.localId);
    if (res?.ok) {
      toast.success(`Data cleared for "${profile.displayName}".`);
      clearTarget = null;
    } else {
      notice = res?.reason ?? "clear-failed";
    }
  }

  async function saveLiveCap() {
    if (liveCapBusy) return;
    liveCapBusy = true;
    notice = "";
    try {
      const res = await setBrowserLiveCap(profileId, Number(liveCap));
      if (res?.ok) toast.success(`Live pages limit set to ${res.cap}.`);
      else notice = res?.reason ?? "invalid-cap";
    } finally {
      liveCapBusy = false;
    }
  }
</script>

<div class="browser-profiles" data-testid="browser-profiles">
  <div class="profiles-head">
    <div>
      <h2>Browser profiles</h2>
      <p class="profiles-sub">Each profile keeps its own cookies, logins and browsing data, separate from the others.</p>
    </div>
    <button type="button" class="cf-btn" data-testid="browser-profiles-new" onclick={() => (dialog = { mode: "new" })}>
      New browser profile
    </button>
  </div>

  <div class="live-cap-row">
    <label>
      Live pages (shared across all profiles in this workspace)
      <input type="number" data-testid="browser-live-cap" bind:value={liveCap} min="1" max="20" />
    </label>
    <button type="button" class="cf-btn ghost sm" data-testid="browser-live-cap-save" disabled={liveCapBusy} onclick={saveLiveCap}>
      Save limit
    </button>
  </div>

  {#if notice}
    <p class="profiles-notice" data-testid="browser-profiles-notice" role="alert">{notice}</p>
  {/if}

  {#if profiles.length === 0}
    <p class="profiles-empty" data-testid="browser-profiles-empty">
      No browser profiles yet. Create one to browse with a separate identity.
    </p>
  {:else}
    <table class="profiles-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Proxy</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each profiles as profile (profile.localId)}
          <!-- svelte-ignore a11y_no_static_element_interactions: right-click opens the row menu -->
          <tr
            data-testid="browser-profile-row-{profile.localId}"
            oncontextmenu={(e) => {
              e.preventDefault();
              const btn = e.currentTarget.querySelector(`[data-testid="browser-profile-menu-${profile.localId}"]`);
              openMenu(profile, e.clientX, e.clientY, btn);
            }}
          >
            <td>
              <span class="profile-dot" style="--profile-color: {profile.color ?? "#888888"}" title={profile.color ?? ""} aria-hidden="true"></span>
              {profile.displayName}
              {#if profile.isDefault} <span class="profile-badge">Default</span>{/if}
              {#if profile.temporary} <span class="profile-badge">Temporary</span>{/if}
            </td>
            <td>{profile.temporary ? "Temporary" : "Persistent"}</td>
            <td>{proxySummary(profile)}</td>
            <td>{lastUsedLabel(profile)}</td>
            <td class="row-actions">
              <button
                type="button"
                class="cf-btn primary sm play-btn"
                data-testid="browser-profile-play-{profile.localId}"
                aria-label="Open {profile.displayName}"
                title="Open {profile.displayName}"
                disabled={!!playBusy[profile.localId]}
                onclick={() => playProfile(profile)}
              >
                {#if playBusy[profile.localId]}
                  Opening…
                {:else}
                  <Play size={13} aria-hidden="true" /> Play
                {/if}
              </button>
              <button
                type="button"
                class="cf-btn ghost sm icon-btn"
                data-testid="browser-profile-menu-{profile.localId}"
                aria-label="More actions for {profile.displayName}"
                aria-haspopup="menu"
                aria-expanded={menu?.profile?.localId === profile.localId}
                title="More actions"
                onclick={(e) => {
                  if (menu?.profile?.localId === profile.localId) closeMenu();
                  else {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(profile, r.right - 210, r.bottom + 4, e.currentTarget);
                  }
                }}
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="profiles-help">Profiles keep your data separate. They do not hide that you use this browser. Right-click a row for more actions.</p>

  {#if menu}
    <div
      class="row-menu"
      role="menu"
      aria-label="Profile actions"
      bind:this={menuEl}
      style="left: {menu.x}px; top: {menu.y}px;"
      data-testid="browser-profile-menu"
    >
      <button type="button" role="menuitem" data-testid="browser-profile-info-{menu.profile.localId}" onkeydown={menuKey} onclick={() => { const p = menu.profile; closeMenu(); infoProfile = p; }}>
        Profile information
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="browser-profile-use-{menu.profile.localId}"
        onkeydown={menuKey}
        onclick={() => {
          const p = menu.profile;
          closeMenu();
          setCurrentProfile(p.localId);
        }}
      >
        Use for new tabs
      </button>
      {#if !menu.profile.temporary}
        <button
          type="button"
          role="menuitem"
          data-testid="browser-profile-edit-{menu.profile.localId}"
          onkeydown={menuKey}
          onclick={() => {
            const p = menu.profile;
            closeMenu();
            dialog = { mode: "edit", profile: p };
          }}
        >
          Edit settings
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="browser-profile-duplicate-{menu.profile.localId}"
          onkeydown={menuKey}
          onclick={async () => {
            const p = menu.profile;
            closeMenu();
            const res = await duplicateBrowserProfile(profileId, p.localId);
            if (res?.ok) toast.success(`Profile "${p.displayName}" duplicated (settings only, no data).`);
            else notice = res?.detail ?? res?.reason ?? "duplicate-failed";
          }}
        >
          Duplicate settings
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="browser-profile-clear-{menu.profile.localId}"
          onkeydown={menuKey}
          onclick={() => {
            const p = menu.profile;
            closeMenu();
            clearTarget = p;
          }}
        >
          Clear browsing data
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          data-testid="browser-profile-delete-{menu.profile.localId}"
          onkeydown={menuKey}
          onclick={() => {
            const p = menu.profile;
            closeMenu();
            openDelete(p);
          }}
        >
          Delete profile
        </button>
      {/if}
    </div>
  {/if}

  {#if dialog}
    <BrowserProfileDialog
      profileId={profileId}
      profile={dialog.mode === "edit" ? dialog.profile : null}
      onClose={() => (dialog = null)}
      onSaved={(saved) => {
        const wasNew = dialog?.mode === "new";
        dialog = null;
        // A profile just created stays in the manager: its Play button
        // is the way to open it. The old flow switched the current
        // profile and opened a bare tab that showed nothing until the
        // user navigated — a misleading empty tab for a profile the
        // user never asked to make default.
        if (wasNew && saved?.localId) {
          toast.success(`Profile "${saved.displayName}" created. Press Play to open it.`);
        }
      }}
    />
  {/if}

  {#if infoProfile}
    <BrowserProfileInfo profile={infoProfile} onClose={() => (infoProfile = null)} />
  {/if}

  {#if clearTarget}
    <div class="dialog-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) clearTarget = null; }}>
      <form
        class="dialog"
        aria-label="Clear browsing data"
        onsubmit={(e) => {
          e.preventDefault();
          confirmClear();
        }}
      >
        <h2>Clear browsing data for “{clearTarget.displayName}”?</h2>
        <p>This deletes its cookies and browsing data. Pages open in this profile will be closed.</p>
        <p>Ledger entries captured from this profile are not deleted.</p>
        <div class="dialog-actions">
          <button type="button" class="cf-btn ghost" onclick={() => (clearTarget = null)}>Cancel</button>
          <button type="submit" class="cf-btn danger" data-testid="browser-profile-clear-confirm">Clear data</button>
        </div>
      </form>
    </div>
  {/if}

  {#if deleteTarget}
    <div class="dialog-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) deleteTarget = null; }}>
      <form
        class="dialog"
        aria-label="Delete browser profile"
        onsubmit={(e) => {
          e.preventDefault();
          confirmDelete();
        }}
      >
        <h2>Delete “{deleteTarget.profile.displayName}”?</h2>
        <p>This deletes its cookies and browsing data. Pages open in this profile will be closed.</p>
        <p>Its data is cleared now. Leftover files are removed the next time Progress Ledger starts.</p>
        {#if deleteTarget.ledgerCount > 0}
          <label class="checkbox">
            <input type="checkbox" data-testid="browser-profile-delete-ledger" bind:checked={deleteTarget.deleteLedger} />
            Also delete {deleteTarget.ledgerCount} ledger {deleteTarget.ledgerCount === 1 ? "entry" : "entries"} captured from this profile
          </label>
        {:else}
          <p>No ledger entries were captured from this profile.</p>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="cf-btn ghost" onclick={() => (deleteTarget = null)}>Cancel</button>
          <button type="submit" class="cf-btn danger" data-testid="browser-profile-delete-confirm">Delete profile</button>
        </div>
      </form>
    </div>
  {/if}
</div>

<style>
  .browser-profiles {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .profiles-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .profiles-head h2 {
    margin: 0;
    font-size: 18px;
  }

  .profiles-sub {
    margin: 4px 0 0;
    opacity: 0.75;
    font-size: 13px;
  }

  .live-cap-row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }

  .live-cap-row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .live-cap-row input {
    width: 80px;
    padding: 6px 8px;
    border: 1px solid var(--hairline, #333);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }

  .profiles-notice {
    color: #e0655a;
    font-size: 13px;
    margin: 0;
  }

  .profiles-empty {
    border: 1px dashed var(--hairline, #333);
    border-radius: 8px;
    padding: 24px;
    text-align: center;
    opacity: 0.8;
  }

  .profiles-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .profiles-table th,
  .profiles-table td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--hairline, #333);
    vertical-align: middle;
  }

  .profile-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--profile-color, #888888);
    display: inline-block;
    margin-right: 6px;
  }

  .profile-badge {
    font-size: 11px;
    border: 1px solid var(--hairline, #333);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 6px;
  }

  .row-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }

  .play-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .icon-btn {
    padding-left: 6px;
    padding-right: 6px;
  }

  .row-menu {
    position: fixed;
    min-width: 210px;
    z-index: 100;
    padding: 4px;
    background: var(--surface-2, #1a1a1a);
    border: 1px solid var(--hairline, #333);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
  }

  .row-menu button[role="menuitem"] {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    white-space: nowrap;
  }

  .row-menu button[role="menuitem"]:hover,
  .row-menu button[role="menuitem"]:focus-visible {
    background: rgba(255, 255, 255, 0.06);
  }

  .row-menu button[role="menuitem"].danger {
    color: #e0655a;
  }

  .profiles-help {
    opacity: 0.7;
    font-size: 12px;
    margin: 0;
  }

  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 40px 16px;
    z-index: 100;
  }

  .dialog {
    width: min(480px, 100%);
    background: var(--surface-2, #1a1a1a);
    border: 1px solid var(--hairline, #333);
    border-radius: 12px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dialog h2 {
    margin: 0;
    font-size: 16px;
  }

  .dialog p {
    margin: 0;
    font-size: 13px;
  }

  .dialog label.checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
