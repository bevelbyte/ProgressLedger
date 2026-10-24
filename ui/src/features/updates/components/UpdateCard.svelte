<script>
  import {
    CircleCheck,
    CircleX,
    Download,
    Package,
    PartyPopper,
    RefreshCw,
    Sparkles,
    Wrench,
  } from "lucide-svelte";

  let { status, checking, downloading, onCheck, onDownload, onInstall } = $props();

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  }
</script>

<div class="status-card">
  {#if status.status === "idle"}
    <div class="status-idle">
      <div class="icon"><Package size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Ready to check for updates</h3>
        <p>Click the button below to see if a new version is available</p>
      </div>
    </div>
    <button class="primary" onclick={onCheck} disabled={checking}>
      {checking ? "Checking..." : "Check for Updates"}
    </button>

  {:else if status.status === "checking"}
    <div class="status-checking">
      <div class="icon spinning"><RefreshCw size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Checking for updates...</h3>
        <p>Connecting to update server</p>
      </div>
    </div>

  {:else if status.status === "up-to-date"}
    <div class="status-success">
      <div class="icon"><CircleCheck size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>You're up to date!</h3>
        <p>Version {status.version} is the latest version</p>
      </div>
    </div>
    <button class="secondary" onclick={onCheck} disabled={checking}>
      Check Again
    </button>

  {:else if status.status === "available"}
    <div class="status-available">
      <div class="icon"><PartyPopper size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Update available: v{status.version}</h3>
        <p>Released on {formatDate(status.releaseDate)}</p>
      </div>
    </div>
    <button class="primary" onclick={onDownload} disabled={downloading}>
      {downloading ? "Downloading..." : "Download Update"}
    </button>

  {:else if status.status === "downloading"}
    <div class="status-downloading">
      <div class="icon"><Download size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Downloading update...</h3>
        <p>{status.percent?.toFixed(1) ?? 0}% complete</p>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {status.percent ?? 0}%"></div>
    </div>
    <div class="progress-details">
      <span>{formatBytes(status.transferred ?? 0)} / {formatBytes(status.total ?? 0)}</span>
      <span>{formatBytes(status.bytesPerSecond ?? 0)}/s</span>
    </div>

  {:else if status.status === "downloaded"}
    <div class="status-downloaded">
      <div class="icon"><Sparkles size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Update ready to install</h3>
        <p>Version {status.version} has been downloaded</p>
      </div>
    </div>
    <div class="actions">
      <button class="secondary" onclick={onCheck}>
        Check Again
      </button>
      <button class="primary" onclick={onInstall}>
        Restart & Install
      </button>
    </div>

  {:else if status.status === "error"}
    <div class="status-error">
      <div class="icon"><CircleX size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Update error</h3>
        <p>{status.message}</p>
      </div>
    </div>
    <button class="secondary" onclick={onCheck} disabled={checking}>
      Try Again
    </button>

  {:else if status.status === "disabled"}
    <div class="status-disabled">
      <div class="icon"><Wrench size={18} strokeWidth={1.75} aria-hidden="true" /></div>
      <div class="info">
        <h3>Auto-updater disabled</h3>
        <p>{status.message}</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .status-card {
    background: var(--bg-secondary, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-xl);
    padding: 24px;
    margin-bottom: 20px;
  }

  .status-idle,
  .status-checking,
  .status-success,
  .status-available,
  .status-downloading,
  .status-downloaded,
  .status-error,
  .status-disabled {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 20px;
  }

  .icon {
    font-size: var(--text-metric);
    flex-shrink: 0;
  }

  .icon.spinning {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .info h3 {
    margin: 0 0 4px 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    color: var(--text-primary, var(--atlas-ink));
  }

  .info p {
    margin: 0;
    color: var(--text-secondary, var(--atlas-ink-3));
    font-size: var(--text-lg);
  }

  .status-success .icon { color: var(--atlas-ok); }
  .status-available .icon { color: var(--atlas-signal); }
  .status-downloaded .icon { color: var(--atlas-ok); }
  .status-error .icon { color: var(--atlas-bad); }
  .status-disabled .icon { color: var(--atlas-warn); }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: var(--bg-tertiary, var(--atlas-raise));
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--atlas-signal), var(--atlas-signal));
    transition: width 0.3s ease;
  }

  .progress-details {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-md);
    color: var(--text-secondary, var(--atlas-ink-3));
  }

  .actions {
    display: flex;
    gap: 12px;
  }

  button {
    padding: 10px 20px;
    border-radius: var(--radius-md);
    font-size: var(--text-lg);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.primary {
    background: var(--atlas-signal);
    color: var(--atlas-on-fill);
  }

  button.primary:hover:not(:disabled) {
    background: var(--atlas-signal);
  }

  button.secondary {
    background: var(--bg-tertiary, var(--atlas-raise));
    color: var(--text-primary, var(--atlas-ink));
    border: 1px solid var(--border, var(--atlas-line));
  }

  button.secondary:hover:not(:disabled) {
    background: var(--bg-secondary, var(--atlas-panel));
  }
</style>
