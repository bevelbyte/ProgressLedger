<script>
  // Browser profiles manager (Phase 3B) — an Operator workspace view
  // replacing the removed legacy manager. Rows: name, color, type,
  // proxy summary, last used. Row menu: Edit, Duplicate settings
  // (not data), Clear data, Delete (with a confirm stating cookies
  // and data will be deleted, plus an opt-in checkbox for ledger
  // entries captured from that profile, off by default).
  import {
    browser,
    loadProfiles,
    setCurrentProfile,
    duplicateBrowserProfile,
    clearBrowserProfileData,
    deleteBrowserProfile,
    setBrowserLiveCap,
    getBrowserLiveCap,
    ledgerCountForBrowserProfile,
  } from "../../../shared/stores/browser.svelte.js";
  import BrowserProfileDialog from "./BrowserProfileDialog.svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { focusedPaneId, openPageTab } from "../../../shell/workspace/store.svelte.js";

  let { profileId = null } = $props();

  const profiles = $derived(browser.profiles);
  let dialog = $state(null); // null | { mode: "new" } | { mode: "edit", profile }
  let deleteTarget = $state(null); // { profile, ledgerCount, deleteLedger }
  let confirmClear = $state(null); // profile awaiting its second click
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
      toast(`Profile "${profile.displayName}" deleted${deleteLedger && res.deletedLedger ? ` (${res.deletedLedger} ledger entries also deleted)` : ""}.`);
      deleteTarget = null;
    } else {
      notice = res?.detail ?? res?.reason ?? "delete-failed";
    }
  }

  async function saveLiveCap() {
    if (liveCapBusy) return;
    liveCapBusy = true;
    notice = "";
    try {
      const res = await setBrowserLiveCap(profileId, Number(liveCap));
      if (res?.ok) toast(`Live pages limit set to ${res.cap}.`);
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
          <th>Color</th>
          <th>Type</th>
          <th>Proxy</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each profiles as profile (profile.localId)}
          <tr data-testid="browser-profile-row-{profile.localId}">
            <td>
              <span class="profile-dot" style="--profile-color: {profile.color ?? "#888888"}" aria-hidden="true"></span>
              {profile.displayName}
              {#if profile.isDefault} <span class="profile-badge">Default</span>{/if}
              {#if profile.temporary} <span class="profile-badge">Temporary</span>{/if}
            </td>
            <td>
              <span class="profile-swatch" style="--profile-color: {profile.color ?? "#888888"}" title={profile.color ?? ""}></span>
              {profile.color ?? "—"}
            </td>
            <td>{profile.temporary ? "Temporary" : "Persistent"}</td>
            <td>{proxySummary(profile)}</td>
            <td>{lastUsedLabel(profile)}</td>
            <td class="row-actions">
              <button type="button" class="cf-btn ghost sm" data-testid="browser-profile-use-{profile.localId}" onclick={() => setCurrentProfile(profile.localId)}>
                Use for new tabs
              </button>
              {#if !profile.temporary}
                <button type="button" class="cf-btn ghost sm" data-testid="browser-profile-edit-{profile.localId}" onclick={() => (dialog = { mode: "edit", profile })}>
                  Edit
                </button>
                <button
                  type="button"
                  class="cf-btn ghost sm"
                  data-testid="browser-profile-duplicate-{profile.localId}"
                  onclick={async () => {
                    const res = await duplicateBrowserProfile(profileId, profile.localId);
                    if (res?.ok) toast(`Profile "${profile.displayName}" duplicated (settings only, no data).`);
                    else notice = res?.detail ?? res?.reason ?? "duplicate-failed";
                  }}
                >
                  Duplicate settings
                </button>
                <button
                  type="button"
                  class="cf-btn ghost sm"
                  data-testid="browser-profile-clear-{profile.localId}"
                  onclick={async () => {
                    if (confirmClear?.localId !== profile.localId) {
                      confirmClear = profile;
                      return;
                    }
                    confirmClear = null;
                    const res = await clearBrowserProfileData(profileId, profile.localId);
                    if (res?.ok) toast(`Data cleared for "${profile.displayName}".`);
                    else notice = res?.reason ?? "clear-failed";
                  }}
                >
                  {confirmClear?.localId === profile.localId ? "Confirm clear?" : "Clear data"}
                </button>
                <button type="button" class="cf-btn ghost sm danger" data-testid="browser-profile-delete-{profile.localId}" onclick={() => openDelete(profile)}>
                  Delete
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="profiles-help">Profiles keep your data separate. They do not hide that you use this browser.</p>

  {#if dialog}
    <BrowserProfileDialog
      profileId={profileId}
      profile={dialog.mode === "edit" ? dialog.profile : null}
      onClose={() => (dialog = null)}
      onSaved={(saved) => {
        const wasNew = dialog?.mode === "new";
        dialog = null;
        if (wasNew && saved?.localId) {
          setCurrentProfile(saved.localId);
          // A profile just created is for use right away: open a
          // fresh Web page tab in the focused pane and activate it.
          // The tab is bare until the user navigates, and that
          // navigation opens in the new profile because new tabs
          // open in the current profile. (The surface dialog, where
          // a browser page already exists, opens a real page in the
          // new profile at once instead.)
          openPageTab(focusedPaneId(), "Web page", null, { activate: true });
        }
      }}
    />
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

  .profile-swatch {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: var(--profile-color, #888888);
    display: inline-block;
    vertical-align: middle;
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
