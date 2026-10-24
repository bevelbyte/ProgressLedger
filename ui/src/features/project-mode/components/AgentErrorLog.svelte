<script>
  // AgentErrorLog — profile-wide list of failed agent runs (pm_agents
  // state='failed') with the last role='status' message attached.
  //
  // Columns: timestamp | goal | error message | duration.
  // Clicking a row expands the full error payload (the structured
  // verification / budget-exceeded / fix-retry trace). A "Retry"
  // button per row re-creates the same objective as a new agent in the
  // same project (the loop refuses to restart a failed agent, so we
  // must create a fresh one).
  //
  // Read-only telemetry + one write (the retry). Does NOT touch the
  // agent loop.

  import { projectModeService } from "../services/projectMode.service.js";
  import { createAndStartAgent, projectModeStore } from "../stores/projectMode.svelte.js";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null } = $props();

  const LIMIT_OPTIONS = [20, 50, 100, 200];

  let errors = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let limit = $state(50);
  let expandedId = $state(null); // id of the expanded row (accordion)
  let retryingId = $state(null); // id of the row whose Retry is in-flight

  // (Re)load when the profile or the limit changes.
  $effect(() => {
    if (profileId != null) load();
  });

  async function load() {
    if (profileId == null) {
      errors = [];
      return;
    }
    loading = true;
    error = null;
    try {
      const res = await projectModeService.listAgentErrors(profileId, null, limit);
      errors = Array.isArray(res) ? res : [];
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      errors = [];
    } finally {
      loading = false;
    }
  }

  function onLimitChange(next) {
    limit = Number(next);
    expandedId = null;
  }

  function refresh() {
    expandedId = null;
    load();
  }

  function toggle(id) {
    expandedId = expandedId === id ? null : id;
  }

  /**
   * Re-create the failed agent's objective as a NEW agent in the same
   * project and start it. The loop refuses to restart a failed agent
   * (`agent-already-failed`), so we must create a fresh row.
   *
   * `projectId` is read from the row (the FailedAgentRun carries it);
   * if the row is somehow missing it we fall back to the active project
   * (a best-effort UX rather than a hard failure).
   */
  async function retry(row) {
    if (retryingId != null) return;
    const projectId = row && typeof row.project_id === "number"
      ? row.project_id
      : (typeof row.projectId === "number" ? row.projectId : projectModeStore.activeProjectId);
    if (!projectId) {
      toast.warning("No project available for retry", "Retry failed");
      return;
    }
    if (!row || typeof row.objective !== "string" || row.objective.trim().length === 0) {
      toast.warning("This run has no objective to retry", "Retry failed");
      return;
    }
    retryingId = row.id;
    try {
      const res = await createAndStartAgent(profileId, projectId, row.objective);
      if (res && res.ok) {
        toast.success("Retry started", `agent #${res.agentId}`);
      } else {
        toast.warning("Retry could not be started", "Retry failed");
      }
    } catch (e) {
      reportError(e, "Could not start retry");
    } finally {
      retryingId = null;
    }
  }

  function fmtTokens(n) {
    if (n == null || Number(n) === 0) return "0";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  // Duration for finished runs; elapsed-so-far for in-flight (should
  // not happen for failed runs, but we keep the fallback for safety).
  function duration(row) {
    const start = Date.parse(row.created_at || row.createdAt);
    if (!start || isNaN(start)) return "—";
    const end = Date.parse(row.finished_at || row.finishedAt || "");
    if (end && !isNaN(end)) return fmtMs(end - start);
    return fmtMs(Date.now() - start);
  }

  function fmtMs(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function timeAgo(iso) {
    const ts = Date.parse(iso);
    if (!ts || isNaN(ts)) return "";
    const delta = Math.floor((Date.now() - ts) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function truncate(text, n = 90) {
    if (!text) return "";
    if (text.length <= n) return text;
    return text.slice(0, n) + "…";
  }

  // The error message is the `content` of the last status message
  // (which is the status `name`, e.g. "verify-failed"). Fall back to
  // the row's `error_name` when the content is empty.
  function errorMessage(row) {
    return row.error_message || row.errorName || row.errorMessage || "";
  }

  // Pretty-print the structured payload for the expanded detail row.
  // The payload is a JSON string; on parse failure we show the raw
  // text so the user can still see what the loop recorded.
  function prettyPayload(row) {
    const raw = row.error_payload || row.errorPayload || "";
    if (!raw) return "(no detail recorded)";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (_e) {
      return String(raw);
    }
  }
</script>

<div class="errlog" data-testid="agent-error-log">
  <header class="errlog-header">
    <h3>Recent agent errors</h3>
    <div class="controls">
      <label>
        <span class="sr-only">Limit</span>
        <select
          data-testid="errlog-limit"
          value={limit}
          onchange={(e) => onLimitChange(e.currentTarget.value)}
        >
          {#each LIMIT_OPTIONS as n}
            <option value={n}>{n} runs</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="refresh-btn"
        data-testid="errlog-refresh"
        onclick={refresh}
        disabled={loading || profileId == null}
        title="Refresh"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="errlog-error">{error}</p>
  {/if}

  {#if loading && errors.length === 0}
    <p class="loading" data-testid="errlog-loading">Loading agent errors…</p>
  {:else if errors.length === 0 && profileId != null}
    <p class="empty" data-testid="errlog-empty">No failed agent runs.</p>
  {:else}
    <table class="err-table" data-testid="errlog-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Goal</th>
          <th>Error</th>
          <th>Duration</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each errors as row (row.id)}
          <tr
            class="err-row"
            data-testid={`errlog-row-${row.id}`}
            onclick={() => toggle(row.id)}
          >
            <td class="mono" data-testid={`errlog-when-${row.id}`}>
              {row.finished_at || row.finishedAt
                ? timeAgo(row.finished_at || row.finishedAt)
                : "—"}
            </td>
            <td class="goal-cell">
              <div class="goal truncated" data-testid={`errlog-goal-${row.id}`}>
                {truncate(row.objective)}
              </div>
            </td>
            <td class="err-cell">
              <div class="err-msg" data-testid={`errlog-error-msg-${row.id}`}>
                {errorMessage(row) ? truncate(errorMessage(row)) : "(no detail)"}
              </div>
            </td>
            <td data-testid={`errlog-duration-${row.id}`}>{duration(row)}</td>
            <td class="retry-cell">
              <button
                type="button"
                class="retry-btn"
                data-testid={`errlog-retry-${row.id}`}
                onclick={(e) => {
                  e.stopPropagation();
                  retry(row);
                }}
                disabled={retryingId === row.id || retryingId != null}
                title="Retry this goal as a new agent"
              >
                {retryingId === row.id ? "…" : "Retry"}
              </button>
            </td>
          </tr>
          {#if expandedId === row.id}
            <tr class="detail-row" data-testid={`errlog-detail-${row.id}`}>
              <td colspan="5">
                <div class="detail">
                  <div><strong>Objective:</strong> {row.objective || ""}</div>
                  <div><strong>Project:</strong> #{row.project_id || row.projectId || "?"}</div>
                  <div><strong>Created:</strong> {row.created_at || row.createdAt || ""}</div>
                  {#if row.finished_at || row.finishedAt}
                    <div><strong>Finished:</strong> {row.finished_at || row.finishedAt}</div>
                  {/if}
                  <div><strong>Tokens:</strong> {fmtTokens(row.tokens_in || row.tokensIn)} in / {fmtTokens(row.tokens_out || row.tokensOut)} out</div>
                  {#if row.error_name || row.errorName}
                    <div><strong>Status:</strong> {row.error_name || row.errorName}</div>
                  {/if}
                  <div>
                    <strong>Error payload:</strong>
                    <pre class="payload" data-testid={`errlog-payload-${row.id}`}>
{prettyPayload(row)}                    </pre>
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .errlog {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .errlog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .errlog-header h3 {
    margin: 0;
    font-size: var(--text-lg);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .controls select {
    background: var(--bg-main, var(--atlas-void));
    color: var(--text-main, var(--atlas-ink));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    font-size: var(--text-sm);
  }
  .controls label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .refresh-btn {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .refresh-btn:hover:not(:disabled) {
    opacity: 0.85;
  }
  .loading,
  .empty,
  .error {
    font-size: var(--text-md);
    padding: 4px 4px 4px 8px;
  }
  .error {
    color: var(--atlas-bad);
  }
  .empty {
    color: var(--text-muted, var(--atlas-ink-2));
    font-style: italic;
  }
  .err-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .err-table th,
  .err-table td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border, var(--atlas-line));
    vertical-align: top;
  }
  .err-table th {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .err-table tbody tr {
    cursor: pointer;
  }
  .err-table tbody tr:hover {
    background: var(--bg-main, var(--atlas-void));
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .goal-cell {
    max-width: 220px;
    word-break: break-word;
  }
  .goal {
    font-size: var(--text-sm);
    line-height: 1.4;
  }
  .err-cell {
    max-width: 220px;
    word-break: break-word;
  }
  .err-msg {
    font-size: var(--text-sm);
    line-height: 1.4;
    color: var(--atlas-bad);
  }
  .retry-cell {
    text-align: right;
    white-space: nowrap;
  }
  .retry-btn {
    background: transparent;
    color: var(--accent, var(--atlas-signal));
    border: 1px solid var(--accent, var(--atlas-signal));
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .retry-btn:hover:not(:disabled) {
    background: var(--accent-soft, var(--atlas-signal-soft));
  }
  .retry-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .detail-row td {
    padding: 6px 6px 8px 6px;
    cursor: default;
  }
  .detail {
    background: var(--bg-main, var(--atlas-void));
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .detail div {
    margin-bottom: 2px;
  }
  .payload {
    margin: 4px 0 0 0;
    padding: 6px 8px;
    background: var(--atlas-void);
    color: var(--atlas-bad);
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-sm);
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
