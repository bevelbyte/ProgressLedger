<script>
  let { configured, url, remoteBackupsCount, lastSyncAt } = $props();

  function formatDate(value) {
    if (!value) return "Never";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }
</script>

<div class="cloud-head">
  <div>
    <p class="eyebrow">Phase 5</p>
    <h2>Cloud Sync</h2>
    <p class="sub">
      {configured
        ? url
        : "Connect a WebDAV folder from Nextcloud, ownCloud, a NAS, or another compatible provider."}
    </p>
  </div>
  <div class="status {configured ? 'ok' : 'idle'}">{configured ? "Connected" : "Not Connected"}</div>
</div>

{#if configured}
  <div class="cloud-stats">
    <div>
      <span>Remote Bundles</span>
      <strong>{remoteBackupsCount}</strong>
    </div>
    <div>
      <span>Last Upload</span>
      <strong>{formatDate(lastSyncAt)}</strong>
    </div>
  </div>
{/if}

<style>
  .cloud-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--atlas-signal-2);
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0;
    font-weight: 700;
  }
  h2 { margin: 0; font-size: var(--text-xl); color: var(--atlas-ink); }
  .sub {
    margin: 6px 0 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .status {
    flex: none;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-full);
    padding: 4px 9px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    background: var(--atlas-void);
  }
  .status.ok { color: var(--atlas-ok); border-color: var(--atlas-ok); }
  
  .cloud-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 16px;
  }
  .cloud-stats div {
    border: 1px solid var(--atlas-raise);
    background: var(--atlas-void);
    border-radius: var(--radius-md);
    padding: 10px;
  }
  .cloud-stats span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-xs);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .cloud-stats strong { color: var(--atlas-ink); font-size: var(--text-lg); }

  @media (max-width: 720px) {
    .cloud-head { flex-direction: column; align-items: stretch; }
    .cloud-stats { grid-template-columns: 1fr; }
  }
</style>
