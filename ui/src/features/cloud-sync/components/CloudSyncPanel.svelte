<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { cloudSyncService } from "../services/cloud-sync.service.js";
  import CloudStatus from "./CloudStatus.svelte";

  let { profiles = [], activeProfile = null, onRestored = async () => {} } = $props();

  let loading = $state(true);
  let working = $state(false);
  let configured = $state(false);
  let url = $state("");
  let username = $state("");
  let password = $state("");
  let lastSyncAt = $state(null);
  let remoteBackups = $state([]);
  let cloudError = $state("");
  let editing = $state(false);

  const canUpload = $derived(configured && profiles.length > 0 && !working);

  function applyCloud(state) {
    configured = Boolean(state?.configured);
    url = state?.url ?? url;
    username = state?.username ?? username;
    lastSyncAt = state?.lastSyncAt ?? null;
    remoteBackups = state?.backups ?? [];
    cloudError = state?.error ?? "";
    editing = !configured;
  }

  async function refresh() {
    loading = true;
    try {
      applyCloud(await cloudSyncService.get());
    } catch (e) {
      reportError(e, "Could not load cloud sync");
    } finally {
      loading = false;
    }
  }
  refresh();

  async function connect() {
    if (!url.trim()) {
      toast.warning("Enter a WebDAV folder URL.", "Missing cloud URL");
      return;
    }
    working = true;
    try {
      const state = await cloudSyncService.configure({
        url: url.trim(),
        username: username.trim(),
        password,
      });
      password = "";
      applyCloud(state);
      toast.success("Cloud vault connected.", "Cloud sync ready");
    } catch (e) {
      reportError(e, "Cloud connection failed");
    } finally {
      working = false;
    }
  }

  async function disconnect() {
    const ok = await confirmDialog({
      title: "Disconnect cloud sync",
      message: "CareerFlow will forget this remote vault and stored credentials. Remote backups stay on the server.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    working = true;
    try {
      applyCloud(await cloudSyncService.disconnect());
      password = "";
      toast.info("Cloud vault disconnected.", "Cloud sync");
    } catch (e) {
      reportError(e, "Could not disconnect cloud");
    } finally {
      working = false;
    }
  }

  async function uploadActive() {
    if (!activeProfile) return;
    working = true;
    try {
      const state = await cloudSyncService.upload(activeProfile.id, activeProfile.slug);
      applyCloud(state);
      toast.success(`Uploaded ${activeProfile.name}.`, "Cloud sync complete");
    } catch (e) {
      reportError(e, "Cloud upload failed");
    } finally {
      working = false;
    }
  }

  async function uploadAll() {
    working = true;
    try {
      const state = await cloudSyncService.uploadAll(profiles.map(({ id, slug }) => ({ id, slug })));
      applyCloud(state);
      toast.success(`Uploaded ${state.uploaded ?? profiles.length} profile${profiles.length === 1 ? "" : "s"}.`, "Cloud sync complete");
    } catch (e) {
      reportError(e, "Cloud upload failed");
    } finally {
      working = false;
    }
  }

  async function restoreRemote(name) {
    let detail = null;
    try {
      detail = await cloudSyncService.inspect(name);
    } catch (e) {
      reportError(e, "Could not inspect cloud backup");
      return;
    }
    const conflictNote = detail?.conflicts?.sameSlug || detail?.conflicts?.sameName
      ? ` Conflict detected: ${detail.resolution}`
      : " No local conflicts detected.";
    const ok = await confirmDialog({
      title: "Restore cloud backup",
      message: `Download and import ${detail.name} (${detail.resourceCount} resources) from ${name}?${conflictNote}`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    working = true;
    try {
      const res = await cloudSyncService.restore(name);
      if (res?.restored) {
        await onRestored(res.profile);
        toast.success(`Restored "${res.profile.name}"`, "Cloud backup restored");
      }
    } catch (e) {
      reportError(e, "Cloud restore failed");
    } finally {
      working = false;
    }
  }

  function formatDate(value) {
    if (!value) return "Never";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<section class="cloud-sync">
  <CloudStatus 
    {configured} 
    {url} 
    remoteBackupsCount={remoteBackups.length} 
    {lastSyncAt} 
  />

  {#if loading}
    <p class="empty">Loading cloud sync...</p>
  {:else if editing}
    <form class="cloud-form" onsubmit={(e) => { e.preventDefault(); connect(); }}>
      <label>
        <span>WebDAV Folder URL</span>
        <input bind:value={url} placeholder="https://cloud.example.com/remote.php/dav/files/me/CareerFlow/" />
      </label>
      <label>
        <span>Username</span>
        <input bind:value={username} autocomplete="username" />
      </label>
      <label>
        <span>Password or App Token</span>
        <input bind:value={password} type="password" autocomplete="current-password" />
      </label>
      <div class="actions">
        {#if configured}
          <button type="button" class="ghost" onclick={() => { editing = false; password = ""; }}>Cancel</button>
        {/if}
          <button type="submit" class="primary" disabled={working}>{working ? "Connecting..." : "Connect WebDAV"}</button>
      </div>
    </form>
  {:else}
    <div class="toolbar">
      <button type="button" class="ghost" onclick={refresh} disabled={working}>Refresh</button>
      <button type="button" class="ghost" onclick={() => { editing = true; }} disabled={working}>Edit</button>
      <button type="button" class="ghost subtle" onclick={disconnect} disabled={working}>Disconnect</button>
      <button type="button" class="primary" onclick={uploadActive} disabled={!canUpload || !activeProfile}>
        {working ? "Syncing..." : "Upload Active"}
      </button>
      <button type="button" class="primary secondary" onclick={uploadAll} disabled={!canUpload}>Upload All</button>
    </div>

    {#if cloudError}
      <p class="error">{cloudError}</p>
    {:else if remoteBackups.length === 0}
      <p class="empty">No remote backups yet. Upload a profile to seed this cloud vault.</p>
    {:else}
      <div class="remote-list">
        {#each remoteBackups.slice(0, 6) as backup (backup.name)}
          <article class="remote-row">
            <div>
              <strong>{backup.name}</strong>
              <span>{formatDate(backup.modifiedAt)} · {formatBytes(backup.byteSize)}</span>
            </div>
            <button type="button" class="restore" onclick={() => restoreRemote(backup.name)} disabled={working}>
              Restore
            </button>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .cloud-sync {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid var(--atlas-raise);
    background:
      linear-gradient(135deg, var(--atlas-scrim), var(--atlas-scrim)),
      repeating-linear-gradient(90deg, var(--atlas-signal-soft) 0 1px, transparent 1px 18px);
    border-radius: var(--radius-lg);
  }
  .cloud-form {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  label span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    margin-bottom: 5px;
  }
  input {
    width: 100%;
    background: var(--atlas-void);
    color: var(--atlas-ink);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    padding: 9px 10px;
  }
  input:focus { outline: 2px solid var(--atlas-signal); outline-offset: 1px; }
  .toolbar,
  .actions {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    border-radius: var(--radius-md);
    padding: 8px 12px;
    cursor: pointer;
    font-size: var(--text-md);
    min-height: 34px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: var(--atlas-signal); color: var(--atlas-signal-ink); border: 1px solid var(--atlas-signal); }
  .primary:hover:not(:disabled) { background: var(--atlas-signal); }
  .primary.secondary { background: var(--atlas-signal); border-color: var(--atlas-signal); }
  .primary.secondary:hover:not(:disabled) { background: var(--atlas-signal); }
  .ghost,
  .restore {
    background: var(--atlas-base);
    color: var(--atlas-ink-2);
    border: 1px solid var(--atlas-line);
  }
  .ghost:hover:not(:disabled),
  .restore:hover:not(:disabled) { border-color: var(--atlas-signal); color: var(--atlas-ink); }
  .ghost.subtle { color: var(--atlas-ink-3); }
  
  .empty,
  .error {
    margin: 14px 0 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.45;
  }
  .error { color: var(--atlas-bad); }
  .remote-list {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }
  .remote-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--atlas-raise);
    background: var(--atlas-void);
    border-radius: var(--radius-md);
    padding: 10px;
  }
  .remote-row div { min-width: 0; }
  .remote-row strong {
    display: block;
    color: var(--atlas-ink);
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-row span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    margin-top: 2px;
  }
  .restore { flex: none; }
  @media (max-width: 720px) {
    .remote-row { flex-direction: column; align-items: stretch; }
  }
</style>
