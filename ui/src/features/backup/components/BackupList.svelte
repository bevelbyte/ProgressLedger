<script>
  import { formatTimestamp } from "../../../shared/utils/local-date.js";

  let { backups = [], working, onRestore } = $props();

  function formatDate(value) {
    return formatTimestamp(value, { fallback: "Never" });
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="backup-list">
  {#each backups.slice(0, 5) as backup (backup.path)}
    <article class="backup-row">
      <div>
        <strong>{backup.name}</strong>
        <span>{formatDate(backup.modifiedAt)} · {formatBytes(backup.byteSize)}</span>
      </div>
      <button
        type="button"
        class="restore-btn"
        onclick={() => onRestore(backup.path, backup.name)}
        disabled={working}
      >
        Restore
      </button>
    </article>
  {/each}
</div>

<style>
  .backup-list {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }
  .backup-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 10px;
  }
  .backup-row div { min-width: 0; }
  .backup-row strong {
    display: block;
    font-size: var(--text-md);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .backup-row span {
    display: block;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .restore-btn {
    flex: none;
    background: transparent;
    color: var(--fg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    cursor: pointer;
    font-size: var(--text-md);
    min-height: 34px;
    transition: var(--trans-fast);
  }
  .restore-btn:disabled { opacity: 0.5; cursor: default; }
  .restore-btn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--fg); background: var(--bg-hover); }

  @media (max-width: 720px) {
    .backup-row { align-items: stretch; flex-direction: column; }
  }
</style>
