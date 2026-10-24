<script>
  // SubAgentActivity — read-only panel over the sub-agent telemetry
  // table (`subagent_runs`, migration 019). Reads exclusively through
  // the read-side IPC channel `agent:list-subagent-runs` exposed by
  // `projectModeService.listSubagentRuns`. The write side (start/end)
  // lives in the agent loop; this panel never mutates anything.
  //
  // Columns: started | duration | role | parent | child | outcome |
  // tokens in | tokens out | error. Rows are camelCase SubagentRun
  // objects (NAPI `#[napi(object)]`), newest-first.
  //
  // Design (ponytail: smallest correct):
  //   * No caching. The main process owns the SQLite table; re-reading
  //     on demand is a single cheap query.
  //   * Non-array responses (`{ ok: false, reason }` from callPm when
  //     core is not wired) render as an empty table, never a crash.

  import { projectModeService } from "../services/projectMode.service.js";

  let { profileId = null, parentAgentId = null } = $props();

  const LIMIT_OPTIONS = [20, 50, 100, 200];

  let runs = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let limit = $state(50);
  // "all" = every parent in the profile; "scoped" = only `parentAgentId`.
  let scope = $state("scoped");
  let expandedId = $state(null);

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
      const scopedId = scope === "scoped" ? parentAgentId : null;
      const res = await projectModeService.listSubagentRuns(profileId, scopedId, limit);
      runs = Array.isArray(res) ? res : [];
      if (!Array.isArray(res) && res && res.ok === false) {
        error = res.reason || "core-error";
      }
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

  function onScopeChange(next) {
    scope = next;
    expandedId = null;
  }

  function refresh() {
    expandedId = null;
    load();
  }

  function toggle(id) {
    expandedId = expandedId === id ? null : id;
  }

  function outcomeClass(outcome) {
    if (outcome === "completed") return "pill-green";
    if (outcome === "failed" || outcome === "cancelled") return "pill-red";
    return "pill-yellow"; // in flight (no outcome yet)
  }

  function fmtTokens(n) {
    if (n == null || Number(n) === 0) return "0";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function timeAgo(iso) {
    const ts = Date.parse(iso);
    if (!ts || isNaN(ts)) return "—";
    const delta = Math.floor((Date.now() - ts) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function duration(run) {
    const start = Date.parse(run.startedAt);
    if (!start || isNaN(start)) return "—";
    if (run.endedAt) {
      const end = Date.parse(run.endedAt);
      if (end && !isNaN(end)) return fmtMs(Math.max(0, end - start));
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
</script>

<div class="activity" data-testid="subagent-activity">
  <header class="activity-header">
    <h3>Sub-agent activity</h3>
    <div class="controls">
      {#if parentAgentId != null}
        <label>
          <span class="sr-only">Scope</span>
          <select
            data-testid="activity-scope"
            value={scope}
            onchange={(e) => onScopeChange(e.currentTarget.value)}
          >
            <option value="scoped">Parent #{parentAgentId}</option>
            <option value="all">All parents</option>
          </select>
        </label>
      {/if}
      <label>
        <span class="sr-only">Limit</span>
        <select
          data-testid="activity-limit"
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
        data-testid="activity-refresh"
        onclick={refresh}
        disabled={loading || profileId == null}
        title="Refresh"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="activity-error">{error}</p>
  {/if}

  {#if loading && runs.length === 0}
    <p class="loading" data-testid="activity-loading">Loading sub-agent runs…</p>
  {:else if runs.length === 0}
    <p class="empty" data-testid="activity-empty">
      {profileId == null
        ? "Select a project to see sub-agent runs."
        : "No sub-agent runs yet."}
    </p>
  {:else}
    <table class="runs-table" data-testid="activity-table">
      <thead>
        <tr>
          <th>Started</th>
          <th>Duration</th>
          <th>Role</th>
          <th>Parent</th>
          <th>Child</th>
          <th>Outcome</th>
          <th>Tokens in</th>
          <th>Tokens out</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          <tr
            class="run-row"
            data-testid={`activity-row-${run.id}`}
            data-outcome={run.outcome || "running"}
            onclick={() => toggle(run.id)}
          >
            <td class="mono" data-testid={`activity-started-${run.id}`}>{run.startedAt ? timeAgo(run.startedAt) : "—"}</td>
            <td data-testid={`activity-duration-${run.id}`}>{duration(run)}</td>
            <td data-testid={`activity-role-${run.id}`}>{run.role || "—"}</td>
            <td data-testid={`activity-parent-${run.id}`}>#<span>{run.parentAgentId}</span></td>
            <td data-testid={`activity-child-${run.id}`}>{run.childAgentId != null ? `#${run.childAgentId}` : "—"}</td>
            <td>
              <span
                class="outcome-pill {outcomeClass(run.outcome)}"
                data-testid="outcome-{run.outcome || 'running'}"
              >{run.outcome || "running"}</span>
            </td>
            <td data-testid={`activity-tokens-in-${run.id}`}>{fmtTokens(run.tokensIn)}</td>
            <td data-testid={`activity-tokens-out-${run.id}`}>{fmtTokens(run.tokensOut)}</td>
          </tr>
          {#if expandedId === run.id}
            <tr class="detail-row" data-testid="activity-detail-{run.id}">
              <td colspan="8">
                <div class="detail">
                  <div><strong>Run id:</strong> {run.runId || "—"}</div>
                  <div><strong>Started:</strong> {run.startedAt || "—"}</div>
                  {#if run.endedAt}
                    <div><strong>Ended:</strong> {run.endedAt}</div>
                  {/if}
                  <div><strong>Parent agent:</strong> #{run.parentAgentId}</div>
                  <div><strong>Child agent:</strong> {run.childAgentId != null ? `#${run.childAgentId}` : "—"}</div>
                  {#if run.error}
                    <div class="detail-error"><strong>Error:</strong> {run.error}</div>
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
  .activity {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .activity-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .activity-header h3 {
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
  .runs-table tbody tr.run-row {
    cursor: pointer;
  }
  .runs-table tbody tr.run-row:hover {
    background: var(--bg-main, var(--atlas-void));
  }
  .outcome-pill {
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
  .detail-error {
    color: var(--atlas-bad);
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
