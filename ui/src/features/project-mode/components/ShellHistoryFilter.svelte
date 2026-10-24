<script>
  // ShellHistoryFilter — browse past shell command executions from the
  // audit log. Reads `shell:exec` events (logged by exec_run) via the
  // `audit:list-events` IPC channel.
  //
  // Columns: timestamp | command | exit_code | duration
  // Filters: date range (since/until, server-side) + command substring
  // (client-side, applied on top of the server-side date range to keep
  // the result set small while the user types).
  //
  // IPC namespace (shell/src/preload.cjs -> window.careerflow.audit):
  //   listEvents({ eventName, profileId, since, until, limit })
  //     -> { ok: true, events: [...] }

  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null } = $props();

  // ---- reactive state --------------------------------------------------------

  let events = $state([]);
  let loading = $state(false);
  let error = $state("");

  // Filter controls
  let since = $state("");
  let until = $state("");
  let commandFilter = $state("");
  let limit = $state(200);

  // ---- audit API -------------------------------------------------------------

  function auditApi() {
    const w = typeof window !== "undefined" ? window : undefined;
    const ns = w && w.careerflow && w.careerflow.audit;
    return ns && typeof ns.listEvents === "function" ? ns : null;
  }

  // ---- data fetch ------------------------------------------------------------

  async function load() {
    const api = auditApi();
    if (!api) {
      error = "Shell history is not available in this build.";
      return;
    }
    loading = true;
    error = "";
    try {
      const opts = {
        eventName: "shell:exec",
        limit: Math.min(limit, 200),
      };
      if (profileId != null) opts.profileId = profileId;
      if (since) opts.since = new Date(since + "T00:00:00").getTime();
      if (until) opts.until = new Date(until + "T23:59:59").getTime();
      const res = await api.listEvents(opts);
      if (res && res.ok) {
        events = Array.isArray(res.events) ? res.events : [];
      } else {
        error = res && res.reason
          ? `Could not load shell history (${res.reason}).`
          : "Could not load shell history.";
      }
    } catch (e) {
      reportError(e, "Could not load shell history");
      error = "Could not load shell history.";
    } finally {
      loading = false;
    }
  }

  // ---- derived: client-side command substring filter -------------------------
  // Plain function called in the template — reactive because it reads
  // $state vars (commandFilter + events).

  function filteredEvents() {
    const q = commandFilter.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => {
      const cmd = typeof e.input_summary === "string" ? e.input_summary : "";
      return cmd.toLowerCase().includes(q);
    });
  }

  // ---- formatters ------------------------------------------------------------

  function fmtDate(ts) {
    if (typeof ts !== "number" || !ts) return "";
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtDuration(ms) {
    if (typeof ms !== "number") return "";
    if (ms < 1000) return `${ms}ms`;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function exitCodeClass(code) {
    if (code === "0" || code === "ok") return "";
    if (code === "timeout") return "timeout";
    return "err";
  }

  // ---- mount -----------------------------------------------------------------

  $effect(() => {
    load();
  });
</script>

<div class="panel" data-testid="shell-history-filter">
  <div class="panel-head">
    <h3 class="title">Shell command history</h3>
    <span class="hint" data-testid="shell-history-count">
      {#if events.length}{events.length} event{#if events.length !== 1}s{/if}{/if}
    </span>
  </div>

  <div class="filters">
    <label class="field">
      <span>From</span>
      <input type="date" bind:value={since} data-testid="shell-history-since" />
    </label>
    <label class="field">
      <span>To</span>
      <input type="date" bind:value={until} data-testid="shell-history-until" />
    </label>
    <label class="field command-field">
      <span>Command</span>
      <input
        type="text"
        placeholder="filter by command…"
        bind:value={commandFilter}
        data-testid="shell-history-command"
      />
    </label>
    <label class="field">
      <span>Limit</span>
      <input
        type="number"
        min="10"
        max="200"
        step="10"
        bind:value={limit}
        data-testid="shell-history-limit"
      />
    </label>
  </div>

  <div class="toolbar">
    <button
      type="button"
      class="btn btn-primary"
      onclick={load}
      disabled={loading}
      data-testid="shell-history-refresh"
    >
      {loading ? "Loading…" : "Refresh"}
    </button>
  </div>

  {#if error}
    <p class="note err" data-testid="shell-history-error">{error}</p>
  {/if}

  <div class="table-wrap" data-testid="shell-history-table-wrap">
    {#if loading && events.length === 0}
      <p class="empty">Loading…</p>
    {:else if filteredEvents().length === 0}
      <p class="empty" data-testid="shell-history-empty">No shell commands recorded.</p>
    {:else}
      <table class="history-table" data-testid="shell-history-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Command</th>
            <th>Exit code</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredEvents() as ev (ev.ts)}
            <tr data-testid="shell-history-row">
              <td class="ts" data-testid="shell-history-row-ts">{fmtDate(ev.ts)}</td>
              <td class="cmd" data-testid="shell-history-row-cmd" title={ev.input_summary || ""}>
                {ev.input_summary || ""}
              </td>
              <td class="code {exitCodeClass(ev.result)}" data-testid="shell-history-row-code">{ev.result ?? "-"}</td>
              <td class="dur" data-testid="shell-history-row-duration">{fmtDuration(ev.durationMs)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .title {
    margin: 0;
    font-size: var(--text-md);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  @media (min-width: 560px) {
    .filters { grid-template-columns: repeat(4, 1fr); }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--text-md);
  }
  .field > span:first-child {
    color: var(--text-secondary);
  }
  .field input {
    background: var(--bg-main);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
  }
  .command-field {
    grid-column: 1 / -1;
  }
  @media (min-width: 560px) {
    .command-field { grid-column: auto; }
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: var(--text-md);
    white-space: nowrap;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--bg-main);
    border-color: var(--accent);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .note.err {
    font-size: var(--text-sm);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    background: var(--color-danger-bg);
    border: 1px solid var(--border);
  }
  .table-wrap {
    overflow-x: auto;
  }
  .history-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-md);
  }
  .history-table th,
  .history-table td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: middle;
  }
  .history-table th {
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .history-table tbody tr:hover {
    background: var(--bg-hover);
  }
  .ts {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .cmd {
    font-family: ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace;
    word-break: break-all;
    color: var(--text-main);
  }
  .code {
    font-variant-numeric: tabular-nums;
  }
  .code.err {
    color: var(--color-danger);
  }
  .code.timeout {
    color: var(--color-warning);
  }
  .dur {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .empty {
    color: var(--text-muted);
    font-size: var(--text-md);
    padding: 12px 0;
    text-align: center;
  }
</style>
