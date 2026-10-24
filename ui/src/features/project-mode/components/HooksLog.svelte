<script>
  // HooksLog — recent hook execution history.
  // Columns: timestamp | hook name | event | status | duration.
  // Status pills: green (ok), red (failed). Clicking a failed row
  // expands the error detail. Filter by hook name and event name.
  //
  // Read-only telemetry. Does NOT touch the hooks module or agent loop.

  let { profileId = null } = $props();

  let executions = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let filterHook = $state("");
  let filterEvent = $state("");
  let expandedId = $state(null);
  // Derived dormant-state report from the main process. `null` means "not
  // reported yet" (older shell, or the call failed) — in that case we fall back
  // to the plain empty message rather than making a claim we cannot support.
  let emitter = $state(null);
  let dormant = $derived(
    emitter != null && emitter.dormant === true && executions.length === 0,
  );

  // (Re)load when the profile changes.
  $effect(() => {
    if (profileId != null) load();
  });

  async function load() {
    if (profileId == null) {
      executions = [];
      emitter = null;
      return;
    }
    loading = true;
    error = null;
    try {
      const filters = {};
      if (filterHook) filters.hookId = filterHook;
      if (filterEvent) filters.eventName = filterEvent;
      const res = await window.progressLedger.hooks.listExecutions(filters);
      executions = Array.isArray(res.executions) ? res.executions : [];
      emitter = res.emitter ?? null;
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      executions = [];
      emitter = null;
    } finally {
      loading = false;
    }
  }

  function refresh() {
    expandedId = null;
    load();
  }

  function onFilterHook(e) {
    filterHook = e.currentTarget.value;
    expandedId = null;
    load();
  }

  function onFilterEvent(e) {
    filterEvent = e.currentTarget.value;
    expandedId = null;
    load();
  }

  function toggle(id) {
    expandedId = expandedId === id ? null : id;
  }

  function statusClass(status) {
    return status === "ok" ? "pill-green" : "pill-red";
  }

  function fmtDuration(ms) {
    if (ms == null || ms === 0) return "0ms";
    if (ms < 1000) return `${ms}ms`;
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

  // Distinct hook ids and event names for the filter dropdowns.
  function uniqueHooks() {
    const set = new Set(executions.map((e) => e.hookId));
    return [...set].sort();
  }

  function uniqueEvents() {
    const set = new Set(executions.map((e) => e.event));
    return [...set].sort();
  }
</script>

<div class="hooks-log" data-testid="hooks-log">
  <header class="log-header">
    <h3>Hook executions</h3>
    <div class="controls">
      <label class="filter-label">
        <span class="sr-only">Filter by hook</span>
        <select
          data-testid="hooks-filter-hook"
          value={filterHook}
          onchange={onFilterHook}
        >
          <option value="">All hooks</option>
          {#each uniqueHooks() as hook}
            <option value={hook}>{hook}</option>
          {/each}
        </select>
      </label>
      <label class="filter-label">
        <span class="sr-only">Filter by event</span>
        <select
          data-testid="hooks-filter-event"
          value={filterEvent}
          onchange={onFilterEvent}
        >
          <option value="">All events</option>
          {#each uniqueEvents() as event}
            <option value={event}>{event}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="refresh-btn"
        data-testid="hooks-refresh"
        onclick={refresh}
        disabled={loading || profileId == null}
        title="Refresh"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="error-msg" role="alert" data-testid="hooks-error">{error}</p>
  {/if}

  {#if loading && executions.length === 0}
    <p class="loading-msg" data-testid="hooks-loading">Loading hook executions…</p>
  {:else if executions.length === 0 && profileId != null && dormant}
    <!--
      Dormant-state notice. An empty log here is EXPECTED and is not a fault:
      nothing in the production app has ever called Hooks.emit(), so no hook can
      have run. Say that plainly instead of showing the ordinary
      "No hook executions yet." message, which reads as "working, just no data
      yet" and lets unbuilt infrastructure look like a working feature.

      `dormant` is DERIVED in the main process by counting real emit() calls, so
      this notice disappears on its own the moment an emitter is wired — there is
      no flag here to keep in sync.
    -->
    <div class="dormant-msg" data-testid="hooks-dormant-notice" role="status">
      <p class="dormant-headline">
        Hooks are not wired up yet — nothing has ever triggered a hook.
      </p>
      <p class="dormant-detail">
        The hooks extension surface is implemented and its events are defined,
        but no production code path emits them yet, so an empty log is expected
        rather than an error. A hook you register for
        <code>tool.invoked</code>, <code>task.completed</code> and the other
        events below will not fire until the agent loop is connected.
      </p>
      <p class="dormant-detail">
        This is reported, not hidden, so a registered hook that never runs is a
        visible gap rather than a silent one.
      </p>
    </div>
  {:else if executions.length === 0 && profileId != null}
    <p class="empty-msg" data-testid="hooks-empty">No hook executions yet.</p>
  {:else}
    <table class="exec-table" data-testid="hooks-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Hook</th>
          <th>Event</th>
          <th>Status</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {#each executions as exec (exec.id)}
          <tr
            class="exec-row"
            data-testid={`hooks-row-${exec.id}`}
            data-status={exec.status}
            onclick={() => toggle(exec.id)}
          >
            <td class="mono" data-testid={`hooks-time-${exec.id}`}>
              {exec.createdAt ? timeAgo(exec.createdAt) : "—"}
            </td>
            <td class="mono" data-testid={`hooks-hook-${exec.id}`}>{exec.hookName || "—"}</td>
            <td class="mono" data-testid={`hooks-event-${exec.id}`}>{exec.event || "—"}</td>
            <td>
              <span
                class={`status-pill ${statusClass(exec.status)}`}
                data-testid={`hooks-status-${exec.status}`}
                >{exec.status}</span
              >
            </td>
            <td class="mono" data-testid={`hooks-duration-${exec.id}`}>
              {fmtDuration(exec.durationMs)}
            </td>
          </tr>
          {#if expandedId === exec.id && exec.error}
            <tr class="detail-row" data-testid={`hooks-detail-${exec.id}`}>
              <td colspan="5">
                <div class="detail">
                  <div><strong>Error:</strong> {exec.error}</div>
                  <div><strong>Hook:</strong> {exec.hookName}</div>
                  <div><strong>Event:</strong> {exec.event}</div>
                  <div><strong>Time:</strong> {exec.createdAt}</div>
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
  .hooks-log {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .log-header h3 {
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
  .filter-label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .filter-label select {
    background: var(--bg-main, var(--atlas-void));
    color: var(--text-main, var(--atlas-ink));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    font-size: var(--text-sm);
    max-width: 160px;
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
  .loading-msg,
  .empty-msg,
  .error-msg {
    font-size: var(--text-md);
    padding: 4px 4px 4px 8px;
  }
  .error-msg {
    color: var(--atlas-bad);
  }
  .empty-msg {
    color: var(--text-muted, var(--atlas-ink-2));
    font-style: italic;
  }
  /* Dormant-state notice. Deliberately NOT styled as an error and NOT styled
     like the ordinary empty state: it is neither a fault nor "just no data
     yet", it is a build-status fact the user needs to see. */
  .dormant-msg {
    font-size: var(--text-md);
    padding: 8px 8px 8px 10px;
    border-left: 3px solid var(--atlas-warn, #b8860b);
    background: color-mix(in srgb, var(--atlas-warn, #b8860b) 8%, transparent);
    max-width: 72ch;
  }
  .dormant-headline {
    font-weight: 600;
    margin: 0 0 4px 0;
  }
  .dormant-detail {
    margin: 0 0 4px 0;
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-sm);
    line-height: 1.45;
  }
  .dormant-detail:last-child {
    margin-bottom: 0;
  }
  .dormant-msg code {
    font-family: var(--font-mono, monospace);
    font-size: 0.92em;
  }
  .exec-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .exec-table th,
  .exec-table td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border, var(--atlas-line));
    vertical-align: top;
  }
  .exec-table th {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .exec-table tbody tr {
    cursor: pointer;
  }
  .exec-table tbody tr:hover {
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
