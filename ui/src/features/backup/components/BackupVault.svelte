<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { backupService } from "../services/backup.service.js";
  import { formatTimestamp } from "../../../shared/utils/local-date.js";
  import BackupList from "./BackupList.svelte";

  let { profiles = [], activeProfile = null, onRestored = async () => {} } = $props();

  let loading = $state(true);
  let working = $state(false);
  let backupDir = $state(null);
  let backups = $state([]);
  let lastBackups = $state({});

  const hasProfiles = $derived(profiles.length > 0);
  const lastForActive = $derived(activeProfile ? lastBackups[String(activeProfile.id)] : null);

  function applyState(state) {
    backupDir = state?.backupDir ?? null;
    backups = state?.backups ?? [];
    lastBackups = state?.lastBackups ?? {};
  }

  async function refresh() {
    loading = true;
    try {
      applyState(await backupService.get());
    } catch (e) {
      reportError(e, "Could not load backups");
    } finally {
      loading = false;
    }
  }
  refresh();

  async function chooseFolder() {
    working = true;
    try {
      const state = await backupService.chooseFolder();
      if (state?.selected) {
        applyState(state);
        toast.success("Backup vault connected.", "Backup folder ready");
      }
    } catch (e) {
      reportError(e, "Could not choose folder");
    } finally {
      working = false;
    }
  }

  async function clearFolder() {
    const ok = await confirmDialog({
      title: "Disconnect backup folder",
      message: "Progress Ledger will forget this backup location. Existing .cfprofile files stay on disk.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    working = true;
    try {
      applyState(await backupService.clearFolder());
      toast.info("Backup folder disconnected.", "Backup vault");
    } catch (e) {
      reportError(e, "Could not disconnect folder");
    } finally {
      working = false;
    }
  }

  async function backupNow() {
    if (!activeProfile) return;
    working = true;
    try {
      const state = await backupService.run(activeProfile.id, activeProfile.slug);
      applyState(state);
      toast.success(`Saved ${activeProfile.name} to ${state.path}`, "Backup complete");
    } catch (e) {
      reportError(e, "Backup failed");
    } finally {
      working = false;
    }
  }

  async function backupAll() {
    if (!profiles.length) return;
    working = true;
    try {
      let latest = null;
      for (const profile of profiles) {
        latest = await backupService.run(profile.id, profile.slug);
      }
      if (latest) applyState(latest);
      toast.success(`Saved ${profiles.length} profile${profiles.length === 1 ? "" : "s"}.`, "Backup complete");
    } catch (e) {
      reportError(e, "Backup failed");
    } finally {
      working = false;
    }
  }

  async function restoreBackup(path, name) {
    let detail = null;
    try {
      detail = await backupService.inspect(path);
    } catch (e) {
      reportError(e, "Could not inspect backup");
      return;
    }
    const conflictNote = detail?.conflicts?.sameSlug || detail?.conflicts?.sameName
      ? ` Conflict detected: ${detail.resolution}`
      : " No local conflicts detected.";
    const ok = await confirmDialog({
      title: "Restore backup",
      message: `Import ${detail.name} (${detail.resourceCount} resources) from ${name}?${conflictNote}`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    working = true;
    try {
      const res = await backupService.restore(path);
      if (res?.restored) {
        await onRestored(res.profile);
        toast.success(`Restored "${res.profile.name}"`, "Backup restored");
      }
    } catch (e) {
      reportError(e, "Restore failed");
    } finally {
      working = false;
    }
  }

  async function openFolder() {
    try {
      await backupService.openFolder();
    } catch (e) {
      reportError(e, "Could not open folder");
    }
  }

  // Vault metadata is plain JSON on the user's own disk: a truncated or
  // hand-edited value must degrade to "Unknown", never throw mid-render and
  // take the Settings pane down with it.
  function formatDate(value) {
    return formatTimestamp(value, { fallback: "Never" });
  }
</script>

<section class="backup-vault">
  <div class="vault-copy">
    <p class="eyebrow">Local Sync</p>
    <h2>Backup Vault</h2>
    <p class="sub">
      {backupDir
        ? backupDir
        : "Choose a local or cloud-synced folder for portable profile backups."}
    </p>
  </div>

  <div class="vault-actions">
    <button type="button" class="ghost-btn" onclick={chooseFolder} disabled={working}>
      {backupDir ? "Change Folder" : "Choose Folder"}
    </button>
    {#if backupDir}
      <button type="button" class="ghost-btn" onclick={openFolder} disabled={working}>Open Folder</button>
      <button type="button" class="ghost-btn subtle" onclick={clearFolder} disabled={working}>Disconnect</button>
    {/if}
    <button
      type="button"
      class="primary"
      onclick={backupNow}
      disabled={!backupDir || !activeProfile || working}
    >
      {working ? "Working..." : "Backup Active Profile"}
    </button>
    <button
      type="button"
      class="primary secondary"
      onclick={backupAll}
      disabled={!backupDir || !hasProfiles || working}
    >
      Backup All
    </button>
  </div>

  <div class="vault-stats">
    <div>
      <span class="stat-label">Profiles</span>
      <strong>{profiles.length}</strong>
    </div>
    <div>
      <span class="stat-label">Bundles</span>
      <strong>{backups.length}</strong>
    </div>
    <div>
      <span class="stat-label">Last Active Backup</span>
      <strong>{formatDate(lastForActive?.at)}</strong>
    </div>
  </div>

  {#if loading}
    <p class="empty">Loading backup vault...</p>
  {:else if !backupDir}
    <p class="empty">A synced folder such as OneDrive or Dropbox works well here.</p>
  {:else if backups.length === 0}
    <p class="empty">
      {hasProfiles
        ? "No backups yet. Back up the active profile to create the first bundle."
        : "No profiles yet. Restore an existing backup or create a profile to get started."}
    </p>
  {:else}
    <BackupList {backups} {working} onRestore={restoreBackup} />
  {/if}
</section>

<style>
  .backup-vault {
    margin-top: 30px;
    padding: 18px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    border-radius: var(--radius-lg);
  }
  .vault-copy { min-width: 0; }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  h2 { margin: 0; font-size: var(--text-lg); color: var(--fg); }
  .sub {
    margin: 6px 0 0;
    color: var(--fg-secondary);
    font-size: var(--text-md);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .vault-actions {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    cursor: pointer;
    font-size: var(--text-md);
    min-height: 34px;
    transition: var(--trans-fast);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: var(--accent); color: var(--accent-ink); border: 1px solid transparent; font-weight: 600; }
  .primary:hover:not(:disabled) { background: var(--accent-strong); }
  .primary.secondary { background: var(--surface-2); border-color: var(--border); color: var(--fg); }
  .primary.secondary:hover:not(:disabled) { background: var(--surface-3); border-color: var(--border-strong); }
  .ghost-btn {
    background: var(--surface-2);
    color: var(--fg-secondary);
    border: 1px solid var(--border);
  }
  .ghost-btn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--fg); background: var(--surface-3); }
  .ghost-btn.subtle { color: var(--fg-muted); }
  .vault-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 16px;
  }
  .vault-stats div {
    border: 1px solid var(--border);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 10px;
    min-width: 0;
  }
  .stat-label {
    display: block;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .vault-stats strong {
    display: block;
    color: var(--fg);
    font-size: var(--text-lg);
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    color: var(--fg-muted);
    font-size: var(--text-md);
    margin: 14px 0 0;
  }
  @media (max-width: 720px) {
    .vault-stats { grid-template-columns: 1fr; }
  }
</style>
