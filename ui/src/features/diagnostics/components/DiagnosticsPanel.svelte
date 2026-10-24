<script>
  // Diagnostics — self-checks, sync health, and the support-report escape hatch.
  //
  // Migrated to the Atlas instrument language: hairline tiles instead of nested
  // dark cards, mono micro-labels instead of uppercase sans, the shared button
  // and badge primitives instead of a private orange button family, and no
  // gradient. The internal phase marker ("Phase 7") is gone — that was release
  // bookkeeping, not product language.
  //
  // Data reads are optional-chained on purpose. A partial report used to throw
  // while rendering the summary tiles, which blanked the entire pane; a check
  // that is missing should read as "not reported", never take the surface down.

  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { diagnosticsService } from "../services/diagnostics.service.js";
  import { formatTimestamp } from "../../../shared/utils/local-date.js";
  import DiagnosticCard from "./DiagnosticCard.svelte";

  let loading = $state(true);
  let working = $state(false);
  let includeNetwork = $state(false);
  let report = $state(null);

  const checks = $derived(report?.checks ?? []);
  const failed = $derived(checks.filter((c) => c.status === "fail").length);
  const warnings = $derived(checks.filter((c) => c.status === "warn").length);

  async function refresh() {
    loading = true;
    try {
      report = await diagnosticsService.getReport({ includeNetwork });
    } catch (e) {
      reportError(e, "Diagnostics failed");
    } finally {
      loading = false;
    }
  }
  refresh();

  async function exportReport() {
    working = true;
    try {
      const res = await diagnosticsService.exportReport({ includeNetwork });
      if (res?.exported) {
        report = res.report;
        toast.success(`Saved diagnostics to ${res.path}`, "Diagnostics exported");
      }
    } catch (e) {
      reportError(e, "Export failed");
    } finally {
      working = false;
    }
  }

  async function openLogs() {
    try {
      await diagnosticsService.openLogs();
    } catch (e) {
      reportError(e, "Could not open logs");
    }
  }

  let clickLogging = $state(localStorage.getItem("careerflow_click_logging") === "true");

  function toggleClickLogging() {
    clickLogging = !clickLogging;
    localStorage.setItem("careerflow_click_logging", String(clickLogging));
    toast.info(clickLogging ? "Click logging enabled. Button clicks will log to the console." : "Click logging disabled.");
  }

  let debugMode = $state(localStorage.getItem("careerflow_debug_mode") === "true");

  function toggleDebugMode() {
    debugMode = !debugMode;
    localStorage.setItem("careerflow_debug_mode", String(debugMode));
    toast.info(debugMode ? "Debug Mode enabled. Persistent logging activated." : "Debug Mode disabled.");
  }

  async function copyDebugLog() {
    try {
      const logs = await diagnosticsService.readLog();
      await navigator.clipboard.writeText(logs);
      toast.success("Debug log copied to clipboard!");
    } catch (e) {
      reportError(e, "Failed to copy logs");
    }
  }

  // Tolerant by design: a report with a missing or unparseable timestamp must
  // still render, so the reader can see the checks that did run.
  function formatDate(value) {
    return formatTimestamp(value, { fallback: "Never" });
  }

  // Status is tri-state and always carries a word — colour never stands alone.
  const statusTone = $derived(
    report?.status === "pass" ? "success" : report?.status === "warn" ? "warning" : "danger",
  );
  const statusWord = $derived(
    loading
      ? "Checking"
      : report?.status === "pass"
        ? "Healthy"
        : report?.status === "warn"
          ? "Review"
          : "Action needed",
  );
</script>

<section class="diagnostics">
  <header class="diag-head">
    <span class="cf-badge {report ? statusTone : 'neutral'}">{statusWord}</span>
    <span class="atl-label">Generated {formatDate(report?.generatedAt)}</span>
  </header>

  <div class="actions">
    <label class="network">
      <input type="checkbox" bind:checked={includeNetwork} onchange={refresh} />
      <span>Check cloud reachability</span>
    </label>
    <button type="button" class="cf-btn sm secondary" onclick={refresh} disabled={loading || working}>
      Run checks
    </button>
    <button type="button" class="cf-btn sm secondary" onclick={exportReport} disabled={loading || working}>
      Export report
    </button>
    <button type="button" class="cf-btn sm ghost" onclick={openLogs} disabled={working}>
      Open logs
    </button>
    <button
      type="button"
      class="cf-btn sm ghost toggle"
      class:on={debugMode}
      onclick={toggleDebugMode}
      aria-pressed={debugMode}
    >
      Debug mode {debugMode ? "on" : "off"}
    </button>
    <button type="button" class="cf-btn sm secondary" onclick={copyDebugLog} disabled={working}>
      Copy debug log
    </button>
    <button
      type="button"
      class="cf-btn sm ghost toggle"
      class:on={clickLogging}
      onclick={toggleClickLogging}
      aria-pressed={clickLogging}
    >
      Click logging {clickLogging ? "on" : "off"}
    </button>
  </div>

  {#if loading}
    <p class="empty">Running checks…</p>
  {:else if report}
    <div class="summary">
      <div class="tile">
        <span class="atl-label">Profiles</span>
        <strong class="tabular">{report.data?.profileCount ?? "—"}</strong>
      </div>
      <div class="tile">
        <span class="atl-label">Warnings</span>
        <strong class="tabular" data-tone={warnings > 0 ? "warn" : undefined}>{warnings}</strong>
      </div>
      <div class="tile">
        <span class="atl-label">Failures</span>
        <strong class="tabular" data-tone={failed > 0 ? "bad" : undefined}>{failed}</strong>
      </div>
      <div class="tile">
        <span class="atl-label">Generated</span>
        <strong class="tabular">{formatDate(report.generatedAt)}</strong>
      </div>
    </div>

    <div class="check-list">
      {#each checks as check (check.id)}
        <DiagnosticCard {check} />
      {/each}
    </div>

    <div class="sync-health">
      <article class="tile">
        <span class="atl-label">Local vault</span>
        <strong>
          {report.sync?.local?.configured ? `${report.sync.local.bundleCount} bundles` : "Not configured"}
        </strong>
      </article>
      <article class="tile">
        <span class="atl-label">Cloud vault</span>
        <strong>
          {report.sync?.cloud?.configured ? `${report.sync.cloud.bundleCount} bundles` : "Not configured"}
        </strong>
      </article>
      <article class="tile">
        <span class="atl-label">Automation</span>
        <strong>
          {report.sync?.automation?.enabled
            ? `${report.sync.automation.target}, every ${report.sync.automation.intervalMinutes}m`
            : "Off"}
        </strong>
      </article>
    </div>
  {/if}
</section>

<style>
  .diagnostics {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .diag-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .network {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-right: var(--space-1);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
  }

  .network input {
    accent-color: var(--atlas-signal);
  }

  /* An engaged toggle reads as signal, not as a second green brand colour. */
  .toggle.on {
    color: var(--atlas-signal-2);
    background: var(--atlas-signal-softer);
  }

  .summary,
  .sync-health {
    display: grid;
    gap: var(--space-2);
  }

  .summary {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .sync-health {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  /* Hairline tiles, not nested cards: these are readouts, not objects. */
  .tile {
    border: 1px solid var(--atlas-line);
    background: var(--atlas-panel);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    min-width: 0;
  }

  .tile strong {
    display: block;
    margin-top: 3px;
    color: var(--atlas-ink);
    font-size: var(--text-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .tile strong[data-tone="warn"] {
    color: var(--atlas-warn);
  }

  .tile strong[data-tone="bad"] {
    color: var(--atlas-bad);
  }

  .check-list {
    display: grid;
    gap: var(--space-2);
  }

  .empty {
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
  }

  @media (max-width: 900px) {
    .summary,
    .sync-health {
      grid-template-columns: 1fr;
    }
  }
</style>
