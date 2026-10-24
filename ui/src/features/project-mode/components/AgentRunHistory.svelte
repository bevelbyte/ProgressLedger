<script>
  // AgentRunHistory — profile-wide timeline of recent agent runs (pm_agents).
  // Columns: started | duration | status | tokens in | tokens out | goal.
  // Status pills are green (completed), red (failed/cancelled), yellow (in
  // progress). Clicking a row expands the full objective ("goal"). A refresh
  // button and a limit dropdown control how many rows are fetched.
  //
  // Read-only telemetry history. Does NOT touch the agent loop.

  import { projectModeService } from "../services/projectMode.service.js";

  let { profileId = null } = $props();

  const LIMIT_OPTIONS = [20, 50, 100, 200];

  let runs = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let limit = $state(50);
  let expandedId = $state(null); // id of the expanded row (accordion)

  // (Re)load when the profile or the limit changes.
  $effect(() => {
    if (profileId != null) load();
  });

  async function load() {
    if (profileId == null) {
      runs = [];
      return;
    }
    loading = true;
    error = null;
    try {
      const res = await projectModeService.listRecentAgentRuns(profileId, limit);
      runs = Array.isArray(res) ? res : [];
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      runs = [];
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

  function statusClass(state) {
    if (state === "completed") return "pill-green";
    if (state === "failed" || state === "cancelled") return "pill-red";
    return "pill-yellow";
  }

  function fmtTokens(n) {
    if (n == null || Number(n) === 0) return "0";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  // `agent:list-recent` returns RAW native rows, which are camelCase
  // (`createdAt`, `tokensIn`); fixtures and older surfaces use the Rust names.
  // Reading only the snake names made every start time, duration and token
  // count render blank/zero against a real run (D13). Read camelCase first.
  const createdAtOf = (run) => run.createdAt ?? run.created_at;
  const finishedAtOf = (run) => run.finishedAt ?? run.finished_at;

  // Duration for finished runs; elapsed-so-far for in-flight runs.
  function duration(run) {
    const start = Date.parse(createdAtOf(run));
    if (!start || isNaN(start)) return "—";
    if (finishedAtOf(run)) {
      const end = Date.parse(finishedAtOf(run));
      if (end && !isNaN(end)) return fmtMs(end - start);
    }
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

  function truncate(text, n = 100) {
    if (!text) return "";
    if (text.length <= n) return text;
    return text.slice(0, n) + "…";
  }
</script>

<div class="history" data-testid="agent-run-history">
  <header class="history-header">
    <h3>Agent run history</h3>
    <div class="controls">
      <label>
        <span class="sr-only">Limit</span>
        <select
          data-testid="history-limit"
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
        data-testid="history-refresh"
        onclick={refresh}
        disabled={loading || profileId == null}
        title="Refresh"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="history-error">{error}</p>
  {/if}

  {#if loading && runs.length === 0}
    <p class="loading" data-testid="history-loading">Loading run history…</p>
  {:else if runs.length === 0 && profileId != null}
    <p class="empty" data-testid="history-empty">No agent runs yet.</p>
  {:else}
    <table class="runs-table" data-testid="history-table">
      <thead>
        <tr>
          <th>Started</th>
          <th>Duration</th>
          <th>Status</th>
          <th>Tokens in</th>
          <th>Tokens out</th>
          <th>Goal</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          <tr
            class="run-row"
            data-testid={`history-row-${run.id}`}
            data-state={run.state}
            onclick={() => toggle(run.id)}
          >
            <td class="mono" data-testid={`history-started-${run.id}`}>
              {createdAtOf(run) ? timeAgo(createdAtOf(run)) : "—"}
            </td>
            <td data-testid={`history-duration-${run.id}`}>{duration(run)}</td>
            <td>
              <span
                class={`status-pill ${statusClass(run.state)}`}
                data-testid={`status-${run.state}`}
                >{run.state || "—"}</span
              >
            </td>
            <td data-testid={`history-tokens-in-${run.id}`}>{fmtTokens(run.tokensIn ?? run.tokens_in)}</td>
            <td data-testid={`history-tokens-out-${run.id}`}>{fmtTokens(run.tokensOut ?? run.tokens_out)}</td>
            <td class="goal-cell">
              <div class="goal truncated" data-testid={`history-goal-${run.id}`}>
                {truncate(run.objective)}
              </div>
            </td>
          </tr>
          {#if expandedId === run.id}
            <tr class="detail-row" data-testid={`history-detail-${run.id}`}>
              <td colspan="6">
                <div class="detail">
                  <div><strong>Objective:</strong> {run.objective || ""}</div>
                  <div><strong>Project:</strong> #{run.projectId ?? run.project_id}</div>
                  <div><strong>Created:</strong> {createdAtOf(run) ?? ""}</div>
                  {#if finishedAtOf(run)}
                    <div><strong>Finished:</strong> {finishedAtOf(run)}</div>
                  {/if}
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
  .history {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .history-header h3 {
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
  .runs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .runs-table th,
  .runs-table td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border, var(--atlas-line));
    vertical-align: top;
  }
  .runs-table th {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .runs-table tbody tr {
    cursor: pointer;
  }
  .runs-table tbody tr:hover {
    background: var(--bg-main, var(--atlas-void));
  }
  .status-pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .pill-green {
    color: var(--atlas-void);
    background: var(--atlas-ok);
  }
  .pill-red {
    color: var(--atlas-on-fill);
    background: var(--atlas-bad);
  }
  .pill-yellow {
    color: var(--atlas-void);
    background: var(--atlas-warn);
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .goal-cell {
    max-width: 320px;
    word-break: break-word;
  }
  .goal {
    font-size: var(--text-sm);
    line-height: 1.4;
  }
  .detail-row td {
    padding: 6px 6px 8px 6px;
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
