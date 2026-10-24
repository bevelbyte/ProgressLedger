<script>
  // MemoryViewer -- browse the agent's persistent + transient memory.
  //
  // Read-only panel. On mount calls window.careerflow.memory.list() which
  // hits the main-process `memory:list` IPC handler. The handler returns
  // a flat combined list across three scopes:
  //
  //   scope="project"  → project_memory  (the source of contextPacket)
  //   scope="session"  → session_memory  (per-agent transient notes)
  //   scope="task"     → task_history    (append-only run summaries)
  //
  // The renderer never sees the sidecar DB path; rows are normalised by
  // the IPC layer into `{ id, scope, kind, key, value, createdAt, ... }`.
  //
  // Rows are searchable by key/value/kind (case-insensitive substring).
  // Clicking a row expands it to reveal the full value.

  import { onMount as svelteOnMount } from "svelte";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, projectId = null } = $props();

  let entries = $state([]);
  let loading = $state(false);
  let search = $state("");
  let scopeFilter = $state("all"); // all | project | session | task
  let expanded = $state({}); // id -> bool

  function truncate(s, n) {
    if (s == null) return "";
    const str = String(s);
    return str.length > n ? str.slice(0, n - 1) + "..." : str;
  }

  function fmtTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
    } catch {
      return String(ts);
    }
  }

  function computeFiltered(list, q, sf) {
    const needle = q.trim().toLowerCase();
    return list.filter((e) => {
      if (sf !== "all" && e.scope !== sf) return false;
      if (!needle) return true;
      const hay = `${e.key || ""} ${e.value || ""} ${e.kind || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  let filtered = $derived(computeFiltered(entries, search, scopeFilter));

  async function refresh() {
    if (profileId == null || projectId == null) {
      entries = [];
      return;
    }
    loading = true;
    try {
      const res = await window.careerflow.memory.list(profileId, projectId, {});
      if (res && res.ok && Array.isArray(res.result)) {
        entries = res.result;
      } else {
        entries = [];
      }
    } catch (e) {
      reportError(e, "Could not load memory entries");
      entries = [];
    } finally {
      loading = false;
    }
  }

  svelteOnMount(() => {
    refresh();
  });

  // Refresh when the profile or active project changes (signalled by the
  // store from ProjectWorkspace). Cheap and safe.
  $effect(() => {
    if (profileId != null && projectId != null) {
      refresh();
    }
  });

  function toggle(id) {
    expanded = { ...expanded, [id]: !expanded[id] };
  }
</script>

<section class="memory-viewer" data-testid="memory-viewer">
  <header class="panel-header">
    <h3>Memory viewer</h3>
    <button
      type="button"
      class="refresh-btn"
      data-testid="memory-viewer-refresh"
      onclick={refresh}
      disabled={loading}
    >
      {loading ? "Loading..." : "Refresh"}
    </button>
  </header>

  <div class="filters">
    <input
      type="search"
      class="search"
      data-testid="memory-viewer-search"
      placeholder="Search by key, value, or kind..."
      bind:value={search}
      spellcheck="false"
    />
    <select
      class="scope-filter"
      data-testid="memory-viewer-scope"
      bind:value={scopeFilter}
      title="Filter by memory scope"
    >
      <option value="all">all</option>
      <option value="project">project</option>
      <option value="session">session</option>
      <option value="task">task</option>
    </select>
    <span class="count" data-testid="memory-viewer-count">
      {filtered.length}/{entries.length}
    </span>
  </div>

  <div class="memory-list" data-testid="memory-viewer-list">
    {#if loading && entries.length === 0}
      <div class="empty" data-testid="memory-viewer-loading">Loading memory…</div>
    {:else if entries.length === 0}
      <div class="empty" data-testid="memory-viewer-empty">
        No memory entries yet. The agent will populate this as it runs.
      </div>
    {:else if filtered.length === 0}
      <div class="empty" data-testid="memory-viewer-no-match">
        No entries match the current filter.
      </div>
    {:else}
      <table class="memory-table" data-testid="memory-viewer-table">
        <thead>
          <tr>
            <th class="col-scope">scope</th>
            <th class="col-kind">kind</th>
            <th class="col-key">key</th>
            <th class="col-value">value</th>
            <th class="col-time">created</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as e (e.id)}
            <tr
              class="memory-row"
              class:expanded={expanded[e.id]}
              data-testid="memory-row"
              data-memory-id={e.id}
              data-memory-scope={e.scope}
              onclick={() => toggle(e.id)}
            >
              <td class="col-scope">
                <span class={`scope-pill scope-${e.scope}`} data-testid="memory-scope-pill">{e.scope}</span>
              </td>
              <td class="col-kind">{e.kind || ""}</td>
              <td class="col-key" title={e.key}>{e.key || ""}</td>
              <td class="col-value">
                {#if expanded[e.id]}
                  <pre class="full-value" data-testid="memory-full-value">{e.value}</pre>
                {:else}
                  <span class="preview" data-testid="memory-value-preview">{truncate(e.value, 80)}</span>
                {/if}
              </td>
              <td class="col-time" title={e.createdAt}>{fmtTime(e.createdAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<style>
  .memory-viewer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .panel-header h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
  }
  .refresh-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--text-md);
  }
  .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .filters {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 6px;
    align-items: center;
  }
  .search, .scope-filter {
    background: var(--bg-main);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    font-family: inherit;
    font-size: var(--text-md);
    min-width: 0;
  }
  .search:focus, .scope-filter:focus { outline: 1px solid var(--accent); }
  .count {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .memory-list {
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-main);
  }
  .empty {
    padding: 14px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-md);
  }
  .memory-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .memory-table thead th {
    position: sticky;
    top: 0;
    background: var(--bg-card);
    color: var(--text-muted);
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--text-xs);
  }
  .memory-row { cursor: pointer; }
  .memory-row:hover { background: var(--atlas-wash); }
  .memory-row.expanded { background: var(--atlas-wash-2); }
  .memory-row td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .col-key, .col-value {
    font-family: var(--mono, monospace);
    word-break: break-word;
  }
  .col-time {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .preview { color: var(--text-muted); }
  .full-value {
    margin: 0;
    padding: 6px 8px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-main);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .scope-pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .scope-project { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .scope-session { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .scope-task    { color: var(--atlas-signal); border-color: var(--atlas-signal); }
</style>
