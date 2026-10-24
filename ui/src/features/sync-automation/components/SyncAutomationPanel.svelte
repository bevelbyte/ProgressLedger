<script>
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { syncAutomationService } from "../services/sync-automation.service.js";
  import AutomationConfig from "./AutomationConfig.svelte";

  let loading = $state(true);
  let working = $state(false);
  let automation = $state({
    enabled: false,
    intervalMinutes: 60,
    target: "local",
    retentionKeep: 5,
    lastRunAt: null,
    lastResult: null,
  });
  let capabilities = $state({ localReady: false, cloudReady: false });

  const targetReady = $derived(
    automation.target === "local"
      ? capabilities.localReady
      : automation.target === "cloud"
        ? capabilities.cloudReady
        : capabilities.localReady || capabilities.cloudReady
  );

  function applyState(state) {
    automation = state?.automation ?? automation;
    capabilities = state?.capabilities ?? capabilities;
  }

  async function refresh() {
    loading = true;
    try {
      applyState(await syncAutomationService.getAutomation());
    } catch (e) {
      reportError(e, "Could not load sync automation");
    } finally {
      loading = false;
    }
  }
  refresh();

  $effect(() => {
    const off = syncAutomationService.onAutomationResult((result) => {
      applyResult(result);
      if (result.errors?.length) {
        toast.warning(result.errors[0], "Scheduled sync finished with issues");
      } else {
        toast.success("Scheduled sync completed.", "Sync automation");
      }
    });
    return () => off?.();
  });

  function applyResult(result) {
    automation = {
      ...automation,
      lastRunAt: result.finishedAt,
      lastResult: result,
    };
  }

  async function save(patch) {
    working = true;
    try {
      applyState(await syncAutomationService.updateAutomation(patch));
    } catch (e) {
      reportError(e, "Could not update automation");
    } finally {
      working = false;
    }
  }

  async function runNow() {
    working = true;
    try {
      const result = await syncAutomationService.runNow();
      applyResult(result);
      if (result.errors?.length) {
        toast.warning(result.errors[0], "Sync completed with issues");
      } else {
        toast.success("Manual sync completed.", "Sync automation");
      }
    } catch (e) {
      reportError(e, "Sync failed");
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
</script>

<section class="sync-automation">
  <div class="head">
    <div>
      <p class="eyebrow">Phase 6</p>
      <h2>Sync Automation</h2>
      <p class="sub">Schedule repeat backups, keep recent generations, and surface restore conflicts before import.</p>
    </div>
    <label class="switch">
      <input
        type="checkbox"
        checked={automation.enabled}
        disabled={working || loading}
        onchange={(e) => save({ enabled: e.currentTarget.checked })}
      />
      <span>{automation.enabled ? "On" : "Off"}</span>
    </label>
  </div>

  {#if loading}
    <p class="empty">Loading automation settings...</p>
  {:else}
    <AutomationConfig bind:automation {working} onSave={save} />

    <div class="status-row">
      <div class="{capabilities.localReady ? 'ready' : ''}">
        <span>Local</span>
        <strong>{capabilities.localReady ? "Ready" : "Needs folder"}</strong>
      </div>
      <div class="{capabilities.cloudReady ? 'ready' : ''}">
        <span>Cloud</span>
        <strong>{capabilities.cloudReady ? "Ready" : "Needs connection"}</strong>
      </div>
      <div>
        <span>Last Run</span>
        <strong>{formatDate(automation.lastRunAt)}</strong>
      </div>
    </div>

    {#if !targetReady}
      <p class="warn">Selected target is not fully configured yet. Manual run will skip unavailable destinations.</p>
    {/if}

    {#if automation.lastResult}
      <p class="result">
        Local {automation.lastResult.localUploaded ?? 0} uploaded, cloud {automation.lastResult.cloudUploaded ?? 0} uploaded,
        pruned {(automation.lastResult.localPruned ?? 0) + (automation.lastResult.cloudPruned ?? 0)} old bundles.
      </p>
    {/if}

    <div class="actions">
      <button type="button" class="primary" onclick={runNow} disabled={working}>
        {working ? "Running..." : "Run Sync Now"}
      </button>
      <button type="button" class="ghost" onclick={refresh} disabled={working}>Refresh</button>
    </div>
  {/if}
</section>

<style>
  .sync-automation {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid var(--atlas-warn-bg);
    background:
      linear-gradient(135deg, var(--atlas-panel), var(--atlas-scrim)),
      repeating-linear-gradient(0deg, var(--atlas-warn-bg) 0 1px, transparent 1px 16px);
    border-radius: var(--radius-lg);
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--atlas-warn);
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0;
    font-weight: 700;
  }
  h2 { margin: 0; font-size: var(--text-xl); color: var(--atlas-ink); }
  .sub,
  .empty,
  .warn,
  .result {
    margin: 6px 0 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.45;
  }
  .warn { color: var(--atlas-warn); margin-top: 14px; }
  .result { color: var(--atlas-ink-2); margin-top: 14px; }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
  }
  .switch input { width: 18px; height: 18px; }
  
  .status-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 14px;
  }
  .status-row div {
    border: 1px solid var(--atlas-raise);
    background: var(--atlas-void);
    border-radius: var(--radius-md);
    padding: 10px;
  }
  .status-row div.ready { border-color: var(--atlas-ok); }
  .status-row span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-xs);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .status-row strong {
    color: var(--atlas-ink);
    font-size: var(--text-lg);
  }
  .actions {
    margin-top: 14px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    border-radius: var(--radius-md);
    padding: 8px 12px;
    cursor: pointer;
    font-size: var(--text-md);
    min-height: 34px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: var(--atlas-warn); color: var(--atlas-on-fill); border: 1px solid var(--atlas-warn); }
  .primary:hover:not(:disabled) { background: var(--atlas-warn); }
  .ghost {
    background: var(--atlas-base);
    color: var(--atlas-ink-2);
    border: 1px solid var(--atlas-line);
  }
  .ghost:hover:not(:disabled) { border-color: var(--atlas-warn); color: var(--atlas-ink); }
  @media (max-width: 860px) {
    .status-row { grid-template-columns: 1fr; }
    .head { flex-direction: column; }
  }
</style>
